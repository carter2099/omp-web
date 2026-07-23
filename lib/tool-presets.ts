/**
 * Tool presets for the web UI.
 * Names align with OMP `@oh-my-pi/pi-coding-agent` built-ins (see builtin-names.ts):
 * - `find` legacy → `glob`
 * - `ls` is not a built-in; listing is via `bash` / `glob`
 */

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

export const PRESET_NONE: string[] = [];
export const PRESET_DEFAULT: string[] = ["read", "bash", "edit", "write", "task"];
/** Full built-in coding set commonly exposed in the UI (essential + search + subagent task). */
export const PRESET_FULL: string[] = ["bash", "read", "edit", "write", "grep", "glob", "task"];

const BUILTIN_TOOL_NAMES = new Set(PRESET_FULL);

/** Map legacy pi tool ids to OMP canonical names for preset matching. */
const LEGACY_TOOL_ALIASES: ReadonlyMap<string, string> = new Map([
  ["find", "glob"],
  ["search", "grep"],
  ["ls", "glob"],
]);

export function normalizePresetToolName(name: string): string {
  const lower = name.toLowerCase();
  return LEGACY_TOOL_ALIASES.get(lower) ?? lower;
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";

  const active = activeTools
    .map((t) => normalizePresetToolName(t.name))
    .filter((name) => BUILTIN_TOOL_NAMES.has(name))
    .sort()
    .join(",");

  if (active === [...PRESET_DEFAULT].sort().join(",")) return "default";
  if (active === [...PRESET_FULL].sort().join(",")) return "full";
  return "default";
}

export function getToolNamesForPreset(preset: ToolPreset): string[] {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return [...PRESET_DEFAULT];
}
