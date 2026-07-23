/**
 * MCP config service: inventory + mutations (probe in mcp-probe.ts).
 * // allow: SIZE_OK — locked Wave-1 surface: mutex + CRUD + settings scrub/readback/invalidate
 */

import path from "node:path";
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/discovery";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	addMCPServer,
	getMCPServer,
	readDisabledServers,
	readEnabledServers,
	removeMCPServer,
	setMcpServerEnabled,
	updateMCPServer,
	type MCPServerConfig,
} from "@oh-my-pi/pi-coding-agent/mcp";
import type {
	McpListResponse,
	McpServerConfigInput,
	McpTransportType,
	McpWritableScope,
	PluginDiagnostic,
} from "@/lib/api-types";
import { mapMcpRow } from "@/lib/mcp-redact";
import {
	probeMcpServer,
	resetMcpProbeMutexesForTests,
	type ProbeMcpOptions,
} from "@/lib/mcp-probe";
import { getOmpRuntime } from "@/lib/omp-runtime";

import "@oh-my-pi/pi-coding-agent/discovery";

type IsolatedSettingsOptions = {
	readonly cwd: string;
	readonly agentDir: string;
};

type IsolatedSettingsLoader = (
	options: IsolatedSettingsOptions,
) => Promise<Settings>;

let isolatedSettingsLoader: IsolatedSettingsLoader = (options) =>
	Settings.loadIsolated(options);

/** Test-only hook for readback failure injection; pass null to restore. */
export function setMcpIsolatedSettingsLoaderForTests(
	loader: IsolatedSettingsLoader | null,
): void {
	isolatedSettingsLoader =
		loader ?? ((options) => Settings.loadIsolated(options));
}

export {
	CLEANUP_DEADLINE_MS,
	findPidsByProbeToken,
	PROBE_DEADLINE_MS,
	PROBE_TOKEN_ENV,
	probeMcpServer,
	reapProbeProcesses,
	type ProbeMcpOptions,
} from "@/lib/mcp-probe";

export class McpServiceError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "McpServiceError";
		this.status = status;
	}
}

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

const mutationMutexByAgentDir = new Map<string, ExclusiveRunner>();

function mutationMutex(agentDir: string): ExclusiveRunner {
	const key = path.resolve(agentDir);
	let m = mutationMutexByAgentDir.get(key);
	if (!m) {
		m = createExclusiveRunner();
		mutationMutexByAgentDir.set(key, m);
	}
	return m;
}

export function resetMcpServiceMutexesForTests(): void {
	mutationMutexByAgentDir.clear();
	resetMcpProbeMutexesForTests();
	setMcpIsolatedSettingsLoaderForTests(null);
}

function toServerConfig(input: McpServerConfigInput): MCPServerConfig {
	const type = input.type ?? (input.url ? "http" : "stdio");
	if (type === "http" || type === "sse") {
		if (!input.url) {
			throw new McpServiceError("url required for http/sse transport", 400);
		}
		return {
			type,
			url: input.url,
			enabled: input.enabled,
			timeout: input.timeout,
			headers: input.headers,
			auth: input.auth,
			oauth: input.oauth,
		};
	}
	if (!input.command) {
		throw new McpServiceError("command required for stdio transport", 400);
	}
	return {
		type: "stdio",
		command: input.command,
		args: input.args,
		env: input.env,
		cwd: input.cwd,
		enabled: input.enabled,
		timeout: input.timeout,
		auth: input.auth,
		oauth: input.oauth,
	};
}

function mergeSecretPreserve(
	raw: MCPServerConfig,
	patch: McpServerConfigInput,
): MCPServerConfig {
	const rawType: McpTransportType =
		"type" in raw && raw.type
			? raw.type
			: "command" in raw && raw.command
				? "stdio"
				: "http";
	const nextType: McpTransportType = patch.type ?? rawType;

	const headers =
		"headers" in patch
			? patch.headers
			: "headers" in raw
				? raw.headers
				: undefined;
	const auth =
		"auth" in patch ? patch.auth : "auth" in raw ? raw.auth : undefined;
	const oauth =
		"oauth" in patch ? patch.oauth : "oauth" in raw ? raw.oauth : undefined;
	const env =
		"env" in patch ? patch.env : "env" in raw ? raw.env : undefined;

	if (nextType === "http" || nextType === "sse") {
		return {
			type: nextType,
			url: patch.url ?? ("url" in raw ? raw.url : undefined) ?? "",
			headers,
			auth,
			oauth,
			enabled: patch.enabled ?? raw.enabled,
			timeout: patch.timeout ?? raw.timeout,
		};
	}

	return {
		type: "stdio",
		command:
			patch.command ?? ("command" in raw ? raw.command : undefined) ?? "",
		args: patch.args ?? ("args" in raw ? raw.args : undefined),
		env,
		cwd: patch.cwd ?? ("cwd" in raw ? raw.cwd : undefined),
		auth,
		oauth,
		enabled: patch.enabled ?? raw.enabled,
		timeout: patch.timeout ?? raw.timeout,
	};
}

export async function listMcpServers(cwd: string): Promise<McpListResponse> {
	const runtime = await getOmpRuntime();
	const settings = await runtime.getSettingsForCwd(cwd);
	const disabledExt = new Set(settings.get("disabledExtensions") ?? []);
	const userPath = getMCPConfigPath("user", cwd);
	const [disabledList, enabledList] = await Promise.all([
		readDisabledServers(userPath),
		readEnabledServers(userPath),
	]);
	const disabledServers = new Set(disabledList);
	const forcedEnabled = new Set(enabledList);

	const cap = await loadCapability<MCPServer>("mcps", {
		cwd,
		includeDisabled: true,
	});

	const activeNames = new Set(cap.items.map((s) => s.name));
	const diagnostics: PluginDiagnostic[] = cap.warnings.map((w) => ({
		type: "warning",
		message: w,
	}));

	const servers = cap.all.map((server) =>
		mapMcpRow(server, {
			disabledServers,
			forcedEnabled,
			settingsDisabled: disabledExt,
			activeNames,
		}),
	);

	return { servers, diagnostics };
}

async function scrubMcpDisabledExtension(params: {
	cwd: string;
	agentDir: string;
	name: string;
}): Promise<void> {
	const extId = `mcp:${params.name}`;
	const loadOpts = { cwd: params.cwd, agentDir: params.agentDir };
	const writer = await isolatedSettingsLoader(loadOpts);
	const current = [...(writer.get("disabledExtensions") ?? [])];
	const idx = current.indexOf(extId);
	if (idx !== -1) {
		current.splice(idx, 1);
		writer.set("disabledExtensions", current);
		await writer.flush();
	}

	const verify = await isolatedSettingsLoader(loadOpts);
	const after = verify.get("disabledExtensions") ?? [];
	if (after.includes(extId)) {
		throw new McpServiceError(
			`settings readback failed: ${extId} still in disabledExtensions`,
			500,
		);
	}
}

export async function addMcpServer(params: {
	cwd: string;
	scope: McpWritableScope;
	name: string;
	config: McpServerConfigInput;
}): Promise<McpListResponse> {
	const runtime = await getOmpRuntime();
	return mutationMutex(runtime.agentDir).runExclusive(async () => {
		const filePath = getMCPConfigPath(params.scope, params.cwd);
		await addMCPServer(filePath, params.name, toServerConfig(params.config));
		return listMcpServers(params.cwd);
	});
}

export async function updateMcpServer(params: {
	cwd: string;
	scope: McpWritableScope;
	name: string;
	config: McpServerConfigInput;
	sourcePath?: string;
}): Promise<McpListResponse> {
	const runtime = await getOmpRuntime();
	return mutationMutex(runtime.agentDir).runExclusive(async () => {
		const filePath = getMCPConfigPath(params.scope, params.cwd);
		if (
			params.sourcePath &&
			path.resolve(params.sourcePath) !== path.resolve(filePath)
		) {
			throw new McpServiceError(
				"sourcePath does not match writable scope path",
				400,
			);
		}
		const raw = await getMCPServer(filePath, params.name);
		if (!raw) {
			throw new McpServiceError(`Server "${params.name}" not found`, 404);
		}
		await updateMCPServer(
			filePath,
			params.name,
			mergeSecretPreserve(raw, params.config),
		);
		return listMcpServers(params.cwd);
	});
}

export async function removeMcpServer(params: {
	cwd: string;
	scope: McpWritableScope;
	name: string;
}): Promise<McpListResponse> {
	const runtime = await getOmpRuntime();
	return mutationMutex(runtime.agentDir).runExclusive(async () => {
		const filePath = getMCPConfigPath(params.scope, params.cwd);
		await removeMCPServer(filePath, params.name);
		return listMcpServers(params.cwd);
	});
}

export async function setMcpEnabled(params: {
	cwd: string;
	name: string;
	enabled: boolean;
	sourcePath?: string;
}): Promise<McpListResponse> {
	const runtime = await getOmpRuntime();
	return mutationMutex(runtime.agentDir).runExclusive(async () => {
		const userPath = getMCPConfigPath("user", params.cwd);
		const projectPath = getMCPConfigPath("project", params.cwd);
		let sourcePath = params.sourcePath;
		if (sourcePath) {
			const nativeUser = path.resolve(userPath);
			const nativeProject = path.resolve(projectPath);
			const resolved = path.resolve(sourcePath);
			if (resolved !== nativeUser && resolved !== nativeProject) {
				sourcePath = undefined;
			}
		}
		await setMcpServerEnabled({
			userPath,
			projectPath,
			sourcePath,
			name: params.name,
			enabled: params.enabled,
		});
		if (params.enabled) {
			await scrubMcpDisabledExtension({
				cwd: params.cwd,
				agentDir: runtime.agentDir,
				name: params.name,
			});
			await runtime.invalidateSettings();
		}
		return listMcpServers(params.cwd);
	});
}
