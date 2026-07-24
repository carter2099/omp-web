import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  OMP_BUILTIN_TOOL_NAMES,
  PRESET_DEFAULT,
  PRESET_FULL,
  getPresetFromTools,
  getToolNamesForPreset,
  normalizePresetToolName,
} = await jiti.import("./tool-presets.ts");

test("OMP presets: full is full builtin list; default is stock-enabled subset", () => {
  assert.ok(PRESET_DEFAULT.includes("read"));
  assert.ok(PRESET_DEFAULT.includes("bash"));
  assert.ok(PRESET_DEFAULT.includes("edit"));
  assert.ok(PRESET_DEFAULT.includes("write"));
  assert.ok(PRESET_DEFAULT.includes("task"));
  assert.ok(PRESET_DEFAULT.includes("glob"));
  assert.ok(PRESET_DEFAULT.includes("grep"));
  assert.ok(PRESET_DEFAULT.includes("todo"));
  assert.ok(PRESET_DEFAULT.includes("web_search"));
  assert.ok(!PRESET_DEFAULT.includes("find"));
  assert.ok(!PRESET_DEFAULT.includes("ls"));

  assert.deepEqual(PRESET_FULL, [...OMP_BUILTIN_TOOL_NAMES]);
  assert.ok(PRESET_FULL.includes("github"));
  assert.ok(PRESET_FULL.includes("checkpoint"));
  assert.ok(PRESET_FULL.length >= PRESET_DEFAULT.length);
});

test("getToolNamesForPreset: none=[], default=undefined (OMP unrestricted), full=all builtins", () => {
  assert.deepEqual(getToolNamesForPreset("none"), []);
  assert.equal(getToolNamesForPreset("default"), undefined);
  assert.deepEqual(
    [...getToolNamesForPreset("full")].sort(),
    [...PRESET_FULL].sort(),
  );
  assert.ok(getToolNamesForPreset("full").includes("task"));
});

test("legacy find/search/ls aliases normalize for preset matching", () => {
  assert.equal(normalizePresetToolName("find"), "glob");
  assert.equal(normalizePresetToolName("search"), "grep");
  assert.equal(normalizePresetToolName("ls"), "glob");
  assert.equal(normalizePresetToolName("read"), "read");
});

test("getPresetFromTools recognizes none / default / full", () => {
  assert.equal(getPresetFromTools([]), "none");

  assert.equal(
    getPresetFromTools(
      PRESET_DEFAULT.map((name) => ({ name, description: name, active: true })),
    ),
    "default",
  );

  const fullTools = PRESET_FULL.map((name) => ({
    name,
    description: name,
    active: true,
  }));
  assert.equal(getPresetFromTools(fullTools), "full");

  // legacy find in place of glob still counts toward full when rest matches
  const withLegacy = fullTools.map((t) =>
    t.name === "glob" ? { ...t, name: "find" } : t,
  );
  assert.equal(getPresetFromTools(withLegacy), "full");

  // Extension tools co-active with stock default builtins → still default
  const defaultPlusExt = [
    ...PRESET_DEFAULT.map((name) => ({ name, description: name, active: true })),
    { name: "mcp__demo_tool", description: "ext", active: true },
  ];
  assert.equal(getPresetFromTools(defaultPlusExt), "default");
});

test("getToolNamesForPreset full returns a copy", () => {
  const full = getToolNamesForPreset("full");
  assert.ok(Array.isArray(full));
  full.push("x");
  assert.ok(!PRESET_FULL.includes("x"));
});
