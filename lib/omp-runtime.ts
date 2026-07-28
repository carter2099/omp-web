/**
 * Shared OMP runtime factory — one AuthStorage + ModelRegistry per agentDir.
 *
 * Ownership rules (pi-web ↔ oh-my-pi hard cut):
 * - Canonical key: resolved agentDir string
 * - Settings keyed by (agentDir, path.resolve(cwd))
 * - Per-agentDir serial queue for init + invalidation (never dual SQLite)
 * - SessionManager is NOT owned here (session-local only)
 * - All routes must use getOmpRuntime(); no independent discoverAuthStorage()
 */

import path from "node:path";

import {
	discoverAuthStorage,
	getAgentDir,
	ModelRegistry,
	Settings,
	type AuthStorage,
} from "@oh-my-pi/pi-coding-agent";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/discovery";

export type OmpRuntime = {
	readonly agentDir: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	getSettingsForCwd(cwd: string): Promise<Settings>;
	invalidateAuth(): Promise<void>;
	invalidateModels(): Promise<void>;
	invalidatePlugins(cwd?: string): Promise<void>;
	/** Clear all per-cwd Settings caches for this agentDir (after settings disk writes). */
	invalidateSettings(): Promise<void>;
};

/** Apply Settings.disabledProviders to OMP's process-global discovery denylist. */
export function applyDiscoverySettings(settings: Settings): void {
	initializeWithSettings(settings);
}

type ExclusiveRunner = {
	runExclusive<T>(fn: () => Promise<T>): Promise<T>;
};

type AgentRuntimeSlot = {
	readonly agentDir: string;
	readonly exclusive: ExclusiveRunner;
	/** Mutable so invalidation can swap handles without changing identity of OmpRuntime. */
	runtime: OmpRuntimeHandle | null;
	/** Settings promises keyed by path.resolve(cwd). */
	readonly settingsByCwd: Map<string, Promise<Settings>>;
	/** Plugin resource-view cache (populated by later plugin routes). */
	readonly pluginsByKey: Map<string, unknown>;
};

/**
 * Process-wide registry. Survives Next hot-reload only if callers re-import;
 * keyed purely by resolved agentDir (not globalThis) — intentional for tests.
 */
const slots = new Map<string, AgentRuntimeSlot>();

function createExclusiveRunner(): ExclusiveRunner {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		runExclusive<T>(fn: () => Promise<T>): Promise<T> {
			const run = tail.then(fn, fn);
			// Keep the chain alive after rejection so later work still serializes.
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}

function resolveAgentDir(agentDir?: string): string {
	return path.resolve(agentDir ?? getAgentDir());
}

function modelsYmlPath(agentDir: string): string {
	return path.join(agentDir, "models.yml");
}

function getSlot(agentDir: string): AgentRuntimeSlot {
	const existing = slots.get(agentDir);
	if (existing) return existing;
	const created: AgentRuntimeSlot = {
		agentDir,
		exclusive: createExclusiveRunner(),
		runtime: null,
		settingsByCwd: new Map(),
		pluginsByKey: new Map(),
	};
	slots.set(agentDir, created);
	return created;
}

function pluginCacheKey(cwd: string | undefined): string {
	return cwd === undefined ? "*" : path.resolve(cwd);
}

class OmpRuntimeHandle implements OmpRuntime {
	readonly agentDir: string;
	#authStorage: AuthStorage;
	#modelRegistry: ModelRegistry;
	readonly #slot: AgentRuntimeSlot;

	constructor(slot: AgentRuntimeSlot, authStorage: AuthStorage, modelRegistry: ModelRegistry) {
		this.agentDir = slot.agentDir;
		this.#slot = slot;
		this.#authStorage = authStorage;
		this.#modelRegistry = modelRegistry;
	}

	get authStorage(): AuthStorage {
		return this.#authStorage;
	}

	get modelRegistry(): ModelRegistry {
		return this.#modelRegistry;
	}

	getSettingsForCwd(cwd: string): Promise<Settings> {
		const resolvedCwd = path.resolve(cwd);
		const cached = this.#slot.settingsByCwd.get(resolvedCwd);
		if (cached) return cached;

		const load = Settings.loadIsolated({
			cwd: resolvedCwd,
			agentDir: this.agentDir,
		}).catch((error: unknown) => {
			// Reject clears so a later call can retry.
			this.#slot.settingsByCwd.delete(resolvedCwd);
			throw error;
		});
		this.#slot.settingsByCwd.set(resolvedCwd, load);
		return load;
	}

	invalidateAuth(): Promise<void> {
		return this.#slot.exclusive.runExclusive(async () => {
			const previous = this.#authStorage;
			// Dispose old SQLite handle before opening a new one (serial queue guarantees no dual open).
			previous.close();
			this.#slot.settingsByCwd.clear();
			this.#slot.pluginsByKey.clear();

			try {
				const nextAuth = await discoverAuthStorage(this.agentDir);
				try {
					const nextRegistry = new ModelRegistry(nextAuth, modelsYmlPath(this.agentDir));
					this.#authStorage = nextAuth;
					this.#modelRegistry = nextRegistry;
				} catch (inner) {
					try {
						nextAuth.close();
					} catch {
						// ignore close errors for idempotency
					}
					throw inner;
				}
			} catch (error) {
				// Slot empty → next getOmpRuntime retries a full open.
				this.#slot.runtime = null;
				throw error;
			}
		});
	}

	invalidateModels(): Promise<void> {
		return this.#slot.exclusive.runExclusive(async () => {
			await this.#modelRegistry.refresh();
		});
	}

	invalidatePlugins(cwd?: string): Promise<void> {
		return this.#slot.exclusive.runExclusive(async () => {
			if (cwd === undefined) {
				this.#slot.pluginsByKey.clear();
				return;
			}
			const key = pluginCacheKey(cwd);
			this.#slot.pluginsByKey.delete(key);
			// Also drop the global "*" view when a project-scoped mutation happens.
			this.#slot.pluginsByKey.delete("*");
		});
	}

	invalidateSettings(): Promise<void> {
		return this.#slot.exclusive.runExclusive(async () => {
			// Clear ALL cwd entries — settings are agentDir-scoped on disk; any
			// cached Settings may hold stale disabledExtensions after MCP enable scrub.
			this.#slot.settingsByCwd.clear();
		});
	}
}

/**
 * Return the shared OMP runtime for the given agent directory.
 * Concurrent callers for the same agentDir share one init Promise (via the serial queue).
 * On init failure the slot stays empty so the next call can retry.
 */
export async function getOmpRuntime(agentDir?: string): Promise<OmpRuntime> {
	const resolved = resolveAgentDir(agentDir);
	const slot = getSlot(resolved);

	return slot.exclusive.runExclusive(async () => {
		if (slot.runtime) return slot.runtime;

		const authStorage = await discoverAuthStorage(resolved);
		try {
			const modelRegistry = new ModelRegistry(authStorage, modelsYmlPath(resolved));
			const runtime = new OmpRuntimeHandle(slot, authStorage, modelRegistry);
			slot.runtime = runtime;
			return runtime;
		} catch (err) {
			try {
				authStorage.close();
			} catch {
				/* ignore */
			}
			throw err;
		}
	});
}

/**
 * Close AuthStorage, drop caches, and evict the process slot for one agentDir.
 * Serialized with init/invalidation for that agentDir. Idempotent if already disposed.
 * Callers that create a temporary agentDir (e.g. model-test) must dispose before rmdir.
 */
export async function disposeOmpRuntime(agentDir: string): Promise<void> {
	const resolved = resolveAgentDir(agentDir);
	const slot = slots.get(resolved);
	if (!slot) return;

	await slot.exclusive.runExclusive(async () => {
		// Another dispose may have already evicted this agentDir.
		const current = slots.get(resolved);
		if (!current || current !== slot) return;

		const runtime = slot.runtime;
		if (runtime) {
			try {
				runtime.authStorage.close();
			} catch {
				// Idempotent: close may throw if already closed.
			}
			slot.runtime = null;
		}
		slot.settingsByCwd.clear();
		slot.pluginsByKey.clear();
		slots.delete(resolved);
	});
}

/**
 * Test helper: close all open AuthStorage handles and clear the process registry.
 * Not for production routes.
 */
export async function resetOmpRuntimeForTests(): Promise<void> {
	const open = [...slots.values()];
	slots.clear();
	for (const slot of open) {
		try {
			slot.runtime?.authStorage.close();
		} catch {
			// best-effort teardown for tests
		}
	}
}
