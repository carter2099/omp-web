import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
	clearPluginRootsAndCaches,
	resolveOrDefaultProjectRegistryPath,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
	PluginManager,
	type ProjectPluginOverrides,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import { getProjectPluginOverridesPath } from "@oh-my-pi/pi-utils";

import type { PluginScope } from "@/lib/api-types";
import { toMarketplaceScope } from "@/lib/plugins-map";

export type PluginAction = "install" | "remove" | "update" | "enable" | "disable";

function assertNever(value: never): never {
	throw new Error(`Unhandled plugin action: ${String(value)}`);
}

export function normalizeSpec(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.startsWith("npm:")) return trimmed.slice(4).trim();
	if (trimmed.startsWith("git:")) return trimmed.slice(4).trim();
	return trimmed;
}

export function isLocalPath(spec: string): boolean {
	if (spec.startsWith("file:")) return true;
	if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) return true;
	return path.isAbsolute(spec);
}

function localPathFromSpec(spec: string): string {
	if (spec.startsWith("file:")) {
		const rest = spec.slice("file:".length);
		return rest.startsWith("//") ? rest.slice(1) : rest;
	}
	return spec;
}

export async function createMarketplaceManager(cwd: string): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseProjectOverrides(raw: unknown): ProjectPluginOverrides {
	if (typeof raw !== "object" || raw === null) return {};
	const entries = Object.entries(raw);
	const out: ProjectPluginOverrides = {};
	for (const [key, value] of entries) {
		if (key === "disabled" && isStringArray(value)) {
			out.disabled = value;
			continue;
		}
		if (key === "features" && typeof value === "object" && value !== null) {
			const features: Record<string, string[]> = {};
			for (const [featKey, featVal] of Object.entries(value)) {
				if (isStringArray(featVal)) features[featKey] = featVal;
			}
			if (Object.keys(features).length > 0) out.features = features;
			continue;
		}
		if (key === "settings" && typeof value === "object" && value !== null) {
			const settings: Record<string, Record<string, unknown>> = {};
			for (const [pluginName, pluginSettings] of Object.entries(value)) {
				if (typeof pluginSettings !== "object" || pluginSettings === null) continue;
				settings[pluginName] = { ...pluginSettings };
			}
			if (Object.keys(settings).length > 0) out.settings = settings;
		}
	}
	return out;
}

function readProjectOverrides(cwd: string): ProjectPluginOverrides {
	const overridesPath = getProjectPluginOverridesPath(cwd);
	if (!existsSync(overridesPath)) return {};
	try {
		const text = readFileSync(overridesPath, "utf8");
		return parseProjectOverrides(JSON.parse(text));
	} catch {
		return {};
	}
}

function writeProjectOverrides(cwd: string, overrides: ProjectPluginOverrides): void {
	const overridesPath = getProjectPluginOverridesPath(cwd);
	mkdirSync(path.dirname(overridesPath), { recursive: true });
	writeFileSync(overridesPath, `${JSON.stringify(overrides, null, 2)}\n`, "utf8");
}

function setProjectPackageDisabled(cwd: string, name: string, disabled: boolean): void {
	const current = readProjectOverrides(cwd);
	const disabledList = new Set(current.disabled ?? []);
	if (disabled) disabledList.add(name);
	else disabledList.delete(name);
	const next: ProjectPluginOverrides = {
		...current,
		disabled: [...disabledList],
	};
	if (next.disabled?.length === 0) delete next.disabled;
	writeProjectOverrides(cwd, next);
}

export async function mutatePackage(
	cwd: string,
	action: PluginAction,
	source: string,
	scope: PluginScope,
): Promise<void> {
	const pm = new PluginManager(cwd);
	const spec = normalizeSpec(source);

	switch (action) {
		case "install": {
			if (isLocalPath(spec)) {
				await pm.link(path.resolve(cwd, localPathFromSpec(spec)));
				return;
			}
			await pm.install(spec);
			return;
		}
		case "remove": {
			await pm.uninstall(spec);
			return;
		}
		case "update": {
			if (isLocalPath(spec)) {
				await pm.link(path.resolve(cwd, localPathFromSpec(spec)));
				return;
			}
			await pm.install(spec, { force: true });
			return;
		}
		case "enable": {
			if (scope === "project") {
				setProjectPackageDisabled(cwd, spec, false);
				return;
			}
			await pm.setEnabled(spec, true);
			return;
		}
		case "disable": {
			if (scope === "project") {
				setProjectPackageDisabled(cwd, spec, true);
				return;
			}
			await pm.setEnabled(spec, false);
			return;
		}
		default:
			assertNever(action);
	}
}

export async function mutateMarketplace(
	cwd: string,
	action: PluginAction,
	pluginId: string,
	scope: PluginScope,
	name: string,
	marketplace: string,
): Promise<void> {
	const mm = await createMarketplaceManager(cwd);
	const mScope = toMarketplaceScope(scope);

	switch (action) {
		case "install": {
			await mm.installPlugin(name, marketplace, { scope: mScope });
			return;
		}
		case "remove": {
			await mm.uninstallPlugin(pluginId, mScope);
			return;
		}
		case "update": {
			await mm.upgradePlugin(pluginId, mScope);
			return;
		}
		case "enable": {
			await mm.setPluginEnabled(pluginId, true, mScope);
			return;
		}
		case "disable": {
			await mm.setPluginEnabled(pluginId, false, mScope);
			return;
		}
		default:
			assertNever(action);
	}
}
