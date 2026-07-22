import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  PRESET_DEFAULT,
  PRESET_FULL,
  getPresetFromTools,
  getToolNamesForPreset,
  normalizePresetToolName,
} = await jiti.import("./tool-presets.ts");

test("OMP presets use glob not find/ls", () => {
  assert.deepEqual(PRESET_DEFAULT, ["read", "bash", "edit", "write"]);
  assert.ok(PRESET_FULL.includes("glob"));
  assert.ok(!PRESET_FULL.includes("find"));
  assert.ok(!PRESET_FULL.includes("ls"));
  assert.ok(PRESET_FULL.includes("grep"));
});

test("legacy find/search/ls aliases normalize for preset matching", () => {
  assert.equal(normalizePresetToolName("find"), "glob");
  assert.equal(normalizePresetToolName("search"), "grep");
  assert.equal(normalizePresetToolName("ls"), "glob");
  assert.equal(normalizePresetToolName("read"), "read");
});

test("getPresetFromTools recognizes full set with legacy find", () => {
  const tools = [
    ...PRESET_FULL.map((name) => ({ name, description: name, active: true })),
  ];
  // replace glob with legacy find still matches full
  const withLegacy = tools.map((t) => (t.name === "glob" ? { ...t, name: "find" } : t));
  assert.equal(getPresetFromTools(withLegacy), "full");
  assert.equal(getPresetFromTools(tools), "full");
  assert.equal(getPresetFromTools(PRESET_DEFAULT.map((name) => ({ name, description: name, active: true }))), "default");
  assert.equal(getPresetFromTools([]), "none");
});

test("getToolNamesForPreset returns copies", () => {
  const full = getToolNamesForPreset("full");
  full.push("x");
  assert.ok(!PRESET_FULL.includes("x"));
});
