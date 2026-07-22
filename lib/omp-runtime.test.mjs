/**
 * Unit tests for lib/omp-runtime.ts (Wave 1a factory).
 *
 * Run: bun test lib/omp-runtime.test.mjs
 *   or: bun --test lib/omp-runtime.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	disposeOmpRuntime,
	getOmpRuntime,
	resetOmpRuntimeForTests,
} from "./omp-runtime.ts";

function makeAgentDir(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-omp-rt-${label}-`));
	const agentDir = join(root, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	return { root, agentDir };
}

test.afterEach(async () => {
	await resetOmpRuntimeForTests();
});

test("getOmpRuntime returns the same instance for the same agentDir", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("singleton");
	try {
		// When
		const a = await getOmpRuntime(agentDir);
		const b = await getOmpRuntime(agentDir);
		// Then
		assert.equal(a, b);
		assert.equal(a.agentDir, agentDir);
		assert.equal(a.authStorage, b.authStorage);
		assert.equal(a.modelRegistry, b.modelRegistry);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSettingsForCwd yields distinct Settings instances for two cwds", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("settings");
	const cwdA = join(root, "proj-a");
	const cwdB = join(root, "proj-b");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	try {
		const runtime = await getOmpRuntime(agentDir);
		// When
		const settingsA = await runtime.getSettingsForCwd(cwdA);
		const settingsB = await runtime.getSettingsForCwd(cwdB);
		const settingsA2 = await runtime.getSettingsForCwd(cwdA);
		// Then
		assert.notEqual(settingsA, settingsB);
		assert.equal(settingsA, settingsA2);
		assert.equal(settingsA.getAgentDir(), agentDir);
		assert.equal(settingsB.getAgentDir(), agentDir);
		assert.equal(settingsA.getCwd(), cwdA);
		assert.equal(settingsB.getCwd(), cwdB);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent invalidateAuth + getOmpRuntime shares the serial queue and a single handle", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("concurrent");
	try {
		const first = await getOmpRuntime(agentDir);
		const authBefore = first.authStorage;

		// When — invalidate and re-get race on the same agentDir
		const [invalidateResult, second] = await Promise.all([
			first.invalidateAuth(),
			getOmpRuntime(agentDir),
		]);

		// Then
		assert.equal(invalidateResult, undefined);
		assert.equal(second, first, "runtime object identity is stable across invalidate");
		assert.notEqual(second.authStorage, authBefore, "auth handle was replaced");
		// Usable after concurrent work (would throw if dual-open corrupted SQLite)
		assert.equal(typeof second.authStorage.getGeneration, "function");
		assert.equal(typeof second.authStorage.getGeneration(), "number");
		// Another get still returns the same singleton
		const third = await getOmpRuntime(agentDir);
		assert.equal(third, first);
		assert.equal(third.authStorage, second.authStorage);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("concurrent getOmpRuntime calls share one init (single AuthStorage)", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("init-race");
	try {
		// When
		const [a, b, c] = await Promise.all([
			getOmpRuntime(agentDir),
			getOmpRuntime(agentDir),
			getOmpRuntime(agentDir),
		]);
		// Then
		assert.equal(a, b);
		assert.equal(b, c);
		assert.equal(a.authStorage, b.authStorage);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two agentDirs keep independent AuthStorage handles", async () => {
	// Given
	const a = makeAgentDir("dir-a");
	const b = makeAgentDir("dir-b");
	try {
		// When
		const rtA = await getOmpRuntime(a.agentDir);
		const rtB = await getOmpRuntime(b.agentDir);
		// Then
		assert.notEqual(rtA, rtB);
		assert.notEqual(rtA.authStorage, rtB.authStorage);
		assert.equal(rtA.agentDir, a.agentDir);
		assert.equal(rtB.agentDir, b.agentDir);
	} finally {
		rmSync(a.root, { recursive: true, force: true });
		rmSync(b.root, { recursive: true, force: true });
	}
});

test("invalidateModels refreshes without replacing AuthStorage", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("models");
	try {
		const runtime = await getOmpRuntime(agentDir);
		const auth = runtime.authStorage;
		// When
		await runtime.invalidateModels();
		// Then
		assert.equal(runtime.authStorage, auth);
		assert.equal(typeof runtime.modelRegistry.getAll, "function");
		assert.ok(Array.isArray(runtime.modelRegistry.getAll()));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getOmpRuntime partial-init path closes AuthStorage if ModelRegistry fails", async () => {
	// Source-contract: if discoverAuthStorage succeeds and ModelRegistry throws,
	// AuthStorage must be closed (no orphan SQLite handle without a slot).
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("./omp-runtime.ts", import.meta.url), "utf8");
	const initSource = source.slice(
		source.indexOf("export async function getOmpRuntime"),
		source.indexOf("export async function disposeOmpRuntime"),
	);

	assert.match(initSource, /discoverAuthStorage\(/);
	assert.match(initSource, /new ModelRegistry\(/);
	assert.match(initSource, /authStorage\.close\(\)/);
	assert.match(initSource, /catch\s*\(/);
	// close is inside the catch of the ModelRegistry/handle path, not only dispose
	const closeInCatch =
		/try\s*\{[\s\S]*?new ModelRegistry[\s\S]*?\}\s*catch[\s\S]*?authStorage\.close\(\)/.test(
			initSource,
		);
	assert.equal(closeInCatch, true, "AuthStorage.close must run in the ModelRegistry failure catch");
});

test("invalidateAuth closes next AuthStorage if ModelRegistry fails", async () => {
	// Source-contract: a newly discovered AuthStorage must not be orphaned when
	// constructing its replacement ModelRegistry throws.
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("./omp-runtime.ts", import.meta.url), "utf8");
		const start = source.indexOf("invalidateAuth(): Promise<void> {");
		const end = source.indexOf("invalidateModels(): Promise<void> {");
		assert.ok(start >= 0 && end > start);
		const invalidateSource = source.slice(start, end);

	assert.match(invalidateSource, /const nextAuth = await discoverAuthStorage\(/);
	assert.match(invalidateSource, /new ModelRegistry\(/);
	assert.match(invalidateSource, /nextAuth\.close\(\)/);
	assert.match(invalidateSource, /catch\s*\([^)]+\)\s*\{[\s\S]*?nextAuth\.close\(\)/);
});

test("disposeOmpRuntime closes auth, evicts slot, and allows a fresh open", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("dispose");
	try {
		const first = await getOmpRuntime(agentDir);
		const authBefore = first.authStorage;
		assert.equal(typeof authBefore.getGeneration, "function");

		// When
		await disposeOmpRuntime(agentDir);
		// Idempotent second dispose must not throw
		await disposeOmpRuntime(agentDir);

		// Then — fresh open (new handle identity, no dual-open crash)
		const second = await getOmpRuntime(agentDir);
		assert.notEqual(second, first);
		assert.notEqual(second.authStorage, authBefore);
		assert.equal(typeof second.authStorage.getGeneration, "function");
		assert.equal(typeof second.authStorage.getGeneration(), "number");

		await disposeOmpRuntime(agentDir);
		const third = await getOmpRuntime(agentDir);
		assert.notEqual(third, second);
		assert.equal(typeof third.authStorage.getGeneration(), "number");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
