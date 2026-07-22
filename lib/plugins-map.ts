import path from "node:path";

import {
	resolvePluginCommandPaths,
	resolvePluginExtensionPaths,
	resolvePluginHookPaths,
	resolvePluginToolPaths,
	type InstalledPlugin,
	type InstalledPluginSummary,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

import type {
	PluginPackageInfo,
	PluginResourceCounts,
	PluginResourceInfo,
	PluginScope,
} from "@/lib/api-types";

export function emptyCounts(): PluginResourceCounts {
	return { extensions: 0, skills: 0, prompts: 0, themes: 0 };
}

export function toUiScope(scope: "user" | "project"): PluginScope {
	return scope === "project" ? "project" : "global";
}

export function toMarketplaceScope(scope: PluginScope): "user" | "project" {
	return scope === "project" ? "project" : "user";
}

function resourceFromPath(
	filePath: string,
	kind: PluginResourceInfo["kind"],
	baseDir: string,
): PluginResourceInfo {
	const rel = path.relative(baseDir, filePath);
	return {
		kind,
		name: path.basename(filePath, path.extname(filePath)) || path.basename(filePath),
		path: filePath,
		relativePath: rel && !rel.startsWith("..") ? rel : filePath,
	};
}

function packageResources(plugin: InstalledPlugin): {
	readonly counts: PluginResourceCounts;
	readonly resources: PluginResourceInfo[];
} {
	const resources: PluginResourceInfo[] = [];
	const counts = emptyCounts();
	const base = plugin.path;

	for (const p of resolvePluginExtensionPaths(plugin)) {
		counts.extensions += 1;
		resources.push(resourceFromPath(p, "extension", base));
	}
	for (const p of resolvePluginToolPaths(plugin)) {
		counts.skills += 1;
		resources.push(resourceFromPath(p, "skill", base));
	}
	for (const p of resolvePluginCommandPaths(plugin)) {
		counts.prompts += 1;
		resources.push(resourceFromPath(p, "prompt", base));
	}
	for (const p of resolvePluginHookPaths(plugin)) {
		counts.extensions += 1;
		resources.push(resourceFromPath(p, "extension", base));
	}

	return { counts, resources };
}

export function mapPackagePlugin(plugin: InstalledPlugin): PluginPackageInfo {
	const { counts, resources } = packageResources(plugin);
	const resourceCount =
		counts.extensions + counts.skills + counts.prompts + counts.themes;
	const disabled = !plugin.enabled;
	return {
		source: plugin.name,
		scope: "global",
		filtered: false,
		disabled,
		installedPath: plugin.path,
		packageName: plugin.name,
		version: plugin.version,
		counts,
		resources,
		status: disabled ? "disabled" : resourceCount > 0 ? "loaded" : "installed",
	};
}

export function mapMarketplacePlugin(summary: InstalledPluginSummary): PluginPackageInfo {
	const entry = summary.entries[0];
	const disabled = entry?.enabled === false;
	const installPath = entry?.installPath;
	return {
		source: summary.id,
		scope: toUiScope(summary.scope),
		filtered: summary.shadowedBy === "project",
		disabled,
		installedPath: installPath,
		packageName: summary.id,
		version: entry?.version,
		counts: emptyCounts(),
		resources: [],
		status: disabled ? "disabled" : installPath ? "installed" : "missing",
	};
}
