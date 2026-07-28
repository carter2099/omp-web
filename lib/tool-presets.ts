/**
 * Tool presets for the web UI — aligned with OhMyPi (`@oh-my-pi/pi-coding-agent`).
 *
 * Runtime facts (OMP 17):
 * - CLI without `--tools` / `--no-tools` → `createTools()` with no filter = all
 *   built-ins that pass settings gates (`isToolAllowed`). That is the true default.
 * - `DEFAULT_SYSTEM_PROMPT_TOOL_NAMES` (`read/bash/edit/write`) is only a prompt
 *   fallback, not the active tool set.
 * - Built-in names: `tools/builtin-names.ts`.
 *
 * UI mapping:
 * - none   → `--no-tools` (empty allow-list)
 * - default → OMP natural default (do not restrict; `getToolNamesForPreset` → undefined)
 * - full   → all OMP built-in names (activate whatever is already in the registry)
 */

export interface ToolEntry {
  name: string;
  description: string;
  active: boolean;
}

export type ToolPreset = "none" | "default" | "full";

/** Canonical OMP built-in tool ids (order matches OMP `BUILTIN_TOOL_NAMES`). */
export const OMP_BUILTIN_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "inspect_image",
  "browser",
  "checkpoint",
  "rewind",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
];

/**
 * Stock OMP settings: tools that are typically on without special backends.
 * Used for UI/docs and for recognizing a “default-like” active set.
 * (True default still means unrestricted — see `getToolNamesForPreset`.)
 */
export const PRESET_DEFAULT: string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "glob",
  "grep",
  "task",
  "todo",
  "web_search",
  "ask",
  "debug",
  "browser",
  "lsp",
  "ast_edit",
];

/** Full built-in name list (force-activate names present in the session registry). */
export const PRESET_FULL: string[] = [...OMP_BUILTIN_TOOL_NAMES];

export const PRESET_NONE: string[] = [];

const OMP_BUILTIN_SET = new Set(OMP_BUILTIN_TOOL_NAMES);

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

function sortedJoin(names: string[]): string {
  return [...names].sort().join(",");
}

export function getPresetFromTools(tools: ToolEntry[]): ToolPreset {
  const activeTools = tools.filter((t) => t.active);
  if (activeTools.length === 0) return "none";

  const activeBuiltins = activeTools
    .map((t) => normalizePresetToolName(t.name))
    .filter((name) => OMP_BUILTIN_SET.has(name));

  const activeKey = sortedJoin(activeBuiltins);
  if (activeKey === sortedJoin(PRESET_FULL)) return "full";
  if (activeKey === sortedJoin(PRESET_DEFAULT)) return "default";

  // Unrestricted OMP sessions usually have ≥ stock default builtins active
  // (plus MCP/extension tools filtered out above). Treat as default.
  if (activeBuiltins.length >= PRESET_DEFAULT.length) return "default";
  return "default";
}

/**
 * Resolve tool names for a preset.
 * - `none` → `[]` (disable all)
 * - `default` → `undefined` (do not restrict; OMP natural default)
 * - `full` → all OMP built-in names
 */
export function getToolNamesForPreset(preset: ToolPreset): string[] | undefined {
  if (preset === "none") return [...PRESET_NONE];
  if (preset === "full") return [...PRESET_FULL];
  return undefined;
}
