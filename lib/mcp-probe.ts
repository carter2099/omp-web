/**
 * Isolated MCP probe: worker spawn + multi-layer reaping (Linux /proc token scan).
 * // allow: SIZE_OK — mandatory probe reaper + worker lifecycle cannot shrink without splitting plan surface
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	getMCPServer,
	readMCPConfigFile,
	type MCPServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp";
import type { McpProbeResult, McpServerConfigInput } from "@/lib/api-types";
import { transportOf } from "@/lib/mcp-redact";
import { resolveMcpProbeWorkerPath } from "@/lib/package-root";
import { redactSecrets } from "@/lib/redact-secrets";

export const PROBE_DEADLINE_MS = 20_000;
export const CLEANUP_DEADLINE_MS = 3_000;
export const PROBE_TOKEN_ENV = "PI_WEB_MCP_PROBE_TOKEN";

type ExclusiveRunner = {
	runExclusive<T>(fn: () => Promise<T>): Promise<T>;
};

function createExclusiveRunner(): ExclusiveRunner {
	let tail: Promise<unknown> = Promise.resolve();
	return {
		runExclusive<T>(fn: () => Promise<T>): Promise<T> {
			const run = tail.then(fn, fn);
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}

const probeMutexByKey = new Map<string, ExclusiveRunner>();

function probeMutex(name: string): ExclusiveRunner {
	let m = probeMutexByKey.get(name);
	if (!m) {
		m = createExclusiveRunner();
		probeMutexByKey.set(name, m);
	}
	return m;
}

export function resetMcpProbeMutexesForTests(): void {
	probeMutexByKey.clear();
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function killPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// already dead
	}
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// ignore
	}
}

export function findPidsByProbeToken(token: string): number[] {
	if (process.platform !== "linux") return [];
	const needle = `${PROBE_TOKEN_ENV}=${token}`;
	const pids: number[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync("/proc");
	} catch {
		return [];
	}
	const self = process.pid;
	for (const ent of entries) {
		if (!/^\d+$/.test(ent)) continue;
		const pid = Number(ent);
		if (pid === self) continue;
		try {
			const env = fs.readFileSync(`/proc/${pid}/environ`);
			if (env.includes(needle)) pids.push(pid);
		} catch {
			// process exited
		}
	}
	return pids;
}

export async function reapProbeProcesses(params: {
	workerPid?: number;
	workerPgid?: number;
	token: string;
	cleanupDeadlineMs?: number;
}): Promise<void> {
	const deadline =
		Date.now() + (params.cleanupDeadlineMs ?? CLEANUP_DEADLINE_MS);

	if (params.workerPid !== undefined) {
		killPid(params.workerPid, "SIGKILL");
	}
	if (params.workerPgid !== undefined && process.platform !== "win32") {
		killProcessGroup(params.workerPgid, "SIGKILL");
	}

	while (Date.now() < deadline) {
		const pids = findPidsByProbeToken(params.token);
		if (pids.length === 0) break;
		for (const pid of pids) killPid(pid, "SIGKILL");
		await sleep(50);
	}
}

function toServerConfig(input: McpServerConfigInput): MCPServerConfig {
	const type = input.type ?? (input.url ? "http" : "stdio");
	if (type === "http" || type === "sse") {
		return {
			type,
			url: input.url ?? "",
			enabled: input.enabled,
			timeout: input.timeout,
			headers: input.headers,
			auth: input.auth,
			oauth: input.oauth,
		};
	}
	return {
		type: "stdio",
		command: input.command ?? "",
		args: input.args,
		env: input.env,
		cwd: input.cwd,
		enabled: input.enabled,
		timeout: input.timeout,
		auth: input.auth,
		oauth: input.oauth,
	};
}

async function readRawConfigForProbe(
	cwd: string,
	name: string,
	sourcePath?: string,
): Promise<MCPServerConfig> {
	if (sourcePath && fs.existsSync(sourcePath)) {
		const file = await readMCPConfigFile(sourcePath);
		const entry = file.mcpServers?.[name];
		if (entry) return entry;
	}
	for (const scope of ["project", "user"] as const) {
		const p = getMCPConfigPath(scope, cwd);
		const entry = await getMCPServer(p, name);
		if (entry) return entry;
	}
	const cap = await loadCapability<MCPServer>("mcps", {
		cwd,
		includeDisabled: true,
	});
	const row = cap.all.find((s) => s.name === name);
	if (!row) {
		throw new Error(`Server "${name}" not found for probe`);
	}
	return toServerConfig({
		type: transportOf(row),
		command: row.command,
		args: row.args,
		env: row.env,
		cwd: row.cwd,
		url: row.url,
		headers: row.headers,
		auth: row.auth,
		oauth: row.oauth,
		enabled: row.enabled,
		timeout: row.timeout,
	});
}

function needsInteractiveOauth(config: MCPServerConfig): boolean {
	if (config.auth?.type === "oauth" && !config.auth.credentialId) {
		return true;
	}
	if (config.oauth && !config.auth?.credentialId) {
		return Boolean(config.oauth.redirectUri || config.oauth.callbackPort);
	}
	return false;
}

function resolveBunForWorker(): string {
	const execPath = process.execPath || "";
	const base = path.basename(execPath).toLowerCase();
	if (base === "bun" || base === "bun.exe") return execPath;
	return "bun";
}

type WorkerResult = {
	ok: boolean;
	toolCount?: number;
	tools?: string[];
	error?: string;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function parseWorkerResult(line: string): WorkerResult {
	try {
		const parsed: unknown = JSON.parse(line);
		if (!isRecord(parsed) || typeof parsed.ok !== "boolean") {
			return { ok: false, error: line || "worker produced no JSON result" };
		}
		const result: WorkerResult = { ok: parsed.ok };
		if (typeof parsed.toolCount === "number") {
			result.toolCount = parsed.toolCount;
		}
		if (Array.isArray(parsed.tools)) {
			result.tools = parsed.tools.filter(
				(t): t is string => typeof t === "string",
			);
		}
		if (typeof parsed.error === "string") result.error = parsed.error;
		return result;
	} catch {
		return { ok: false, error: line || "worker produced no JSON result" };
	}
}

export type ProbeMcpOptions = {
	cwd: string;
	name: string;
	sourcePath?: string;
	deadlineMs?: number;
	workerTimeoutMs?: number;
	ompMcpTimeoutMs?: string;
};

export async function probeMcpServer(
	options: ProbeMcpOptions,
): Promise<McpProbeResult> {
	return probeMutex(options.name).runExclusive(async () => {
		const started = Date.now();
		const deadlineMs = options.deadlineMs ?? PROBE_DEADLINE_MS;
		const token = randomUUID();
		let tempPath: string | undefined;
		let child: ChildProcess | undefined;
		let workerPid: number | undefined;
		let workerPgid: number | undefined;

		const cleanupTemp = () => {
			if (!tempPath) return;
			try {
				fs.unlinkSync(tempPath);
			} catch {
				// ignore
			}
		};
		process.once("exit", cleanupTemp);

		try {
			const raw = await readRawConfigForProbe(
				options.cwd,
				options.name,
				options.sourcePath,
			);
			if (needsInteractiveOauth(raw)) {
				return {
					status: "fail",
					error: redactSecrets(
						"OAuth interactive login is not supported in the web UI",
					),
					durationMs: Date.now() - started,
				};
			}

			// Force token last so user config.env cannot override it.
			const envBase =
				"env" in raw && raw.env ? { ...raw.env } : {};
			const probePayload = {
				...raw,
				env: { ...envBase, [PROBE_TOKEN_ENV]: token },
			};

			tempPath = path.join(os.tmpdir(), `pi-web-mcp-probe-${token}.json`);
			await fsp.writeFile(tempPath, JSON.stringify(probePayload), {
				encoding: "utf8",
				mode: 0o600,
			});

			const workerPath = resolveMcpProbeWorkerPath();
			const workerTimeout =
				options.workerTimeoutMs !== undefined
					? options.workerTimeoutMs
					: deadlineMs;
			const bunBin = resolveBunForWorker();
			const workerArgs = [
				workerPath,
				"--name",
				options.name,
				"--config-path",
				tempPath,
				"--deadline-ms",
				String(workerTimeout),
			];

			const workerEnv: NodeJS.ProcessEnv = {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				TMPDIR: process.env.TMPDIR,
				TMP: process.env.TMP,
				TEMP: process.env.TEMP,
				NODE_ENV: process.env.NODE_ENV,
				BUN_INSTALL: process.env.BUN_INSTALL,
				[PROBE_TOKEN_ENV]: token,
				OMP_MCP_TIMEOUT_MS:
					options.ompMcpTimeoutMs ?? String(deadlineMs),
				PI_WEB_PKG_DIR: process.env.PI_WEB_PKG_DIR,
			};

			const resultPromise = new Promise<WorkerResult>((resolve) => {
				const chunks: Buffer[] = [];
				const proc = spawn(bunBin, workerArgs, {
					stdio: ["ignore", "pipe", "pipe"],
					env: workerEnv,
					detached: process.platform !== "win32",
				});
				child = proc;
				workerPid = proc.pid;
				workerPgid = proc.pid;
				proc.stdout?.on("data", (d: Buffer) => chunks.push(d));
				proc.stderr?.on("data", () => {
					// swallow — never log secrets
				});
				proc.on("error", (err) => {
					resolve({ ok: false, error: err.message });
				});
				proc.on("close", () => {
					const text = Buffer.concat(chunks).toString("utf8").trim();
					const line = text.split("\n").filter(Boolean).pop() ?? "";
					resolve(parseWorkerResult(line));
				});
			});

			const timeoutPromise = sleep(deadlineMs).then(
				(): WorkerResult => ({
					ok: false,
					error: `probe deadline exceeded after ${deadlineMs}ms`,
				}),
			);

			const workerResult = await Promise.race([
				resultPromise,
				timeoutPromise,
			]);

			await reapProbeProcesses({ workerPid, workerPgid, token });

			const durationMs = Date.now() - started;
			if (workerResult.ok) {
				return {
					status: "ok",
					toolCount: workerResult.toolCount,
					tools: workerResult.tools,
					durationMs,
				};
			}
			const err = redactSecrets(workerResult.error ?? "probe failed");
			const isTimeout = /timeout|deadline|aborted/i.test(err);
			return {
				status: isTimeout ? "timeout" : "fail_clean",
				error: err,
				durationMs,
			};
		} catch (error) {
			await reapProbeProcesses({ workerPid, workerPgid, token });
			return {
				status: "fail",
				error: redactSecrets(
					error instanceof Error ? error.message : String(error),
				),
				durationMs: Date.now() - started,
			};
		} finally {
			cleanupTemp();
			process.off("exit", cleanupTemp);
		}
	});
}
