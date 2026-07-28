import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent";
import { clearPluginRootsAndCaches } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	parsePluginId,
	PluginManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import type {
	PathExtensionInfo,
	PluginDiagnostic,
	PluginScope,
	PluginsResponse,
} from "@/lib/api-types";
import { getOmpRuntime, type OmpRuntime } from "@/lib/omp-runtime";
import {
	createMarketplaceManager,
	mutateMarketplace,
	mutatePackage,
	normalizeSpec,
	type PluginAction,
} from "@/lib/plugins-actions";
import { emptyCounts, mapMarketplacePlugin, mapPackagePlugin } from "@/lib/plugins-map";

export type { PluginAction } from "@/lib/plugins-actions";

export type PluginMutationRequest = {
	readonly action: PluginAction;
	readonly cwd: string;
	readonly source?: string;
	readonly scope?: PluginScope;
};

export class PluginServiceError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "PluginServiceError";
		this.status = status;
	}
}

function expandHome(p: string): string {
	if (p === "~") return process.env.HOME ?? p;
	if (p.startsWith("~/")) {
		const home = process.env.HOME;
		return home ? path.join(home, p.slice(2)) : p;
	}
	return p;
}

function readPackageMeta(dir: string): {
	packageName?: string;
	version?: string;
	entrypoints: string[];
} {
	const pkgJsonPath = path.join(dir, "package.json");
	if (!existsSync(pkgJsonPath)) return { entrypoints: [] };
	try {
		const raw = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
			name?: string;
			version?: string;
			omp?: { extensions?: string[] };
			pi?: { extensions?: string[] };
		};
		const entrypoints = [
			...(Array.isArray(raw.omp?.extensions) ? raw.omp.extensions : []),
			...(Array.isArray(raw.pi?.extensions) ? raw.pi.extensions : []),
		].filter((e): e is string => typeof e === "string" && e.length > 0);
		return {
			packageName: typeof raw.name === "string" ? raw.name : undefined,
			version: typeof raw.version === "string" ? raw.version : undefined,
			entrypoints: [...new Set(entrypoints)],
		};
	} catch {
		return { entrypoints: [] };
	}
}

function mapPathExtension(configuredPath: string, cwd: string): PathExtensionInfo {
	const expanded = expandHome(configuredPath.trim());
	const resolved = path.isAbsolute(expanded)
		? path.normalize(expanded)
		: path.resolve(cwd, expanded);

	if (!existsSync(resolved)) {
		return {
			path: resolved,
			configuredPath,
			entrypoints: [],
			exists: false,
			status: "missing",
		};
	}

	try {
		const st = statSync(resolved);
		if (st.isFile()) {
			const dir = path.dirname(resolved);
			const meta = readPackageMeta(dir);
			return {
				path: resolved,
				configuredPath,
				packageName: meta.packageName,
				version: meta.version,
				entrypoints: [path.basename(resolved)],
				exists: true,
				status: "loaded",
			};
		}
		if (st.isDirectory()) {
			const meta = readPackageMeta(resolved);
			const status: PathExtensionInfo["status"] =
				meta.entrypoints.length > 0 || meta.packageName ? "loaded" : "invalid";
			return {
				path: resolved,
				configuredPath,
				packageName: meta.packageName,
				version: meta.version,
				entrypoints: meta.entrypoints,
				exists: true,
				status,
			};
		}
		return {
			path: resolved,
			configuredPath,
			entrypoints: [],
			exists: true,
			status: "invalid",
		};
	} catch {
		return {
			path: resolved,
			configuredPath,
			entrypoints: [],
			exists: true,
			status: "invalid",
		};
	}
}

async function listPathExtensions(cwd: string): Promise<{
	pathExtensions: PathExtensionInfo[];
	diagnostics: PluginDiagnostic[];
}> {
	const diagnostics: PluginDiagnostic[] = [];
	try {
		const runtime = await getOmpRuntime();
		const settings = await runtime.getSettingsForCwd(cwd);
		const raw = settings.get("extensions");
		const paths = Array.isArray(raw)
			? raw.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
			: [];
		return {
			pathExtensions: paths.map((p) => mapPathExtension(p, cwd)),
			diagnostics,
		};
	} catch (error) {
		diagnostics.push({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			source: "settings.extensions",
		});
		return { pathExtensions: [], diagnostics };
	}
}

export async function listPlugins(cwd: string): Promise<PluginsResponse> {
	const diagnostics: PluginDiagnostic[] = [];
	const packages: PluginsResponse["packages"] = [];

	const pm = new PluginManager(cwd);
	try {
		const npmPlugins = await pm.list();
		for (const plugin of npmPlugins) {
			packages.push(mapPackagePlugin(plugin));
		}
	} catch (error) {
		diagnostics.push({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			source: "PluginManager.list",
		});
	}

	try {
		const mm = await createMarketplaceManager(cwd);
		const marketplacePlugins = await mm.listInstalledPlugins();
		for (const summary of marketplacePlugins) {
			packages.push(mapMarketplacePlugin(summary));
		}
	} catch (error) {
		diagnostics.push({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
			source: "MarketplaceManager.listInstalledPlugins",
		});
	}

	const pathResult = await listPathExtensions(cwd);
	diagnostics.push(...pathResult.diagnostics);
	const pathExtensions = pathResult.pathExtensions;

	const totals = emptyCounts();
	for (const pkg of packages) {
		totals.extensions += pkg.counts.extensions;
		totals.skills += pkg.counts.skills;
		totals.prompts += pkg.counts.prompts;
		totals.themes += pkg.counts.themes;
	}
	for (const ext of pathExtensions) {
		if (ext.status === "loaded") {
			totals.extensions += Math.max(1, ext.entrypoints.length || 1);
		}
	}

	return { packages, pathExtensions, totals, diagnostics };
}

function pathsEqual(a: string, b: string): boolean {
	return path.resolve(expandHome(a)) === path.resolve(expandHome(b));
}

function entryMatchesTarget(
	configuredEntry: string,
	target: string,
	cwd: string,
): boolean {
	const entryTrim = configuredEntry.trim();
	const targetTrim = target.trim();
	if (entryTrim === targetTrim) return true;
	if (pathsEqual(entryTrim, targetTrim)) return true;
	const entryResolved = mapPathExtension(entryTrim, cwd).path;
	const targetResolved = mapPathExtension(targetTrim, cwd).path;
	return entryResolved === targetResolved;
}

export async function removePathExtension(
	cwd: string,
	targetPath: string,
	runtime: OmpRuntime,
): Promise<PluginsResponse> {
	const target = targetPath.trim();
	if (!target) {
		throw new PluginServiceError("path required", 400);
	}

	const loadOpts = { cwd, agentDir: runtime.agentDir };
	const writer = await Settings.loadIsolated(loadOpts);
	const raw = writer.get("extensions");
	const current = Array.isArray(raw)
		? raw.filter((p): p is string => typeof p === "string")
		: [];
	const next = current.filter((entry) => !entryMatchesTarget(entry, target, cwd));

	if (next.length === current.length) {
		throw new PluginServiceError(`path extension not found: ${target}`, 404);
	}

	writer.set("extensions", next);
	await writer.flush();

	const verify = await Settings.loadIsolated(loadOpts);
	const afterRaw = verify.get("extensions");
	const after = Array.isArray(afterRaw)
		? afterRaw.filter((p): p is string => typeof p === "string")
		: [];
	if (after.some((entry) => entryMatchesTarget(entry, target, cwd))) {
		throw new PluginServiceError(
			`settings readback failed: path still in extensions: ${target}`,
			500,
		);
	}

	await runtime.invalidateSettings();
	await runtime.invalidatePlugins(cwd);
	clearPluginRootsAndCaches();
	return listPlugins(cwd);
}

export async function mutatePlugins(
	request: PluginMutationRequest,
	_runtime: OmpRuntime,
): Promise<PluginsResponse> {
	const { action, cwd } = request;
	const source = request.source?.trim();
	const scope: PluginScope = request.scope === "project" ? "project" : "global";

	if (!source) {
		throw new PluginServiceError("source required", 400);
	}

	const normalized = normalizeSpec(source);
	const marketplaceParts = parsePluginId(normalized);

	if (marketplaceParts) {
		await mutateMarketplace(
			cwd,
			action,
			normalized,
			scope,
			marketplaceParts.name,
			marketplaceParts.marketplace,
		);
	} else {
		await mutatePackage(cwd, action, normalized, scope);
	}

	clearPluginRootsAndCaches();
	return listPlugins(cwd);
}
