/**
 * OMP plugin matrix: PluginManager (npm/git/link) + MarketplaceManager (user|project).
 */

import { clearPluginRootsAndCaches } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	parsePluginId,
	PluginManager,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import type { PluginDiagnostic, PluginScope, PluginsResponse } from "@/lib/api-types";
import type { OmpRuntime } from "@/lib/omp-runtime";
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

	const totals = emptyCounts();
	for (const pkg of packages) {
		totals.extensions += pkg.counts.extensions;
		totals.skills += pkg.counts.skills;
		totals.prompts += pkg.counts.prompts;
		totals.themes += pkg.counts.themes;
	}

	return { packages, totals, diagnostics };
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
