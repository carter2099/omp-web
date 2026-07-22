import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("RPC session startup uses createAgentSession + getOmpRuntime", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSession\(/);
  assert.match(startupSource, /getOmpRuntime\(/);
  assert.match(startupSource, /SessionManager\.(open|create)/);
  assert.doesNotMatch(startupSource, /createAgentSessionServices\(/);
  assert.doesNotMatch(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /@earendil-works/);
});

test("fork path destroys wrapper after creating new session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(forkSource, /createBranchedSession\(/);
  assert.match(forkSource, /this\.destroy\(\)/);
  assert.match(forkSource, /newSessionId/);
  // Must not leave forked state under the old registry key
  assert.match(forkSource, /FORK THEN DESTROY|destroy this wrapper/i);
});

test("fork rejects while prompt, stream, or compaction is active", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(forkSource, /this\.promptRunning/);
  assert.match(forkSource, /this\.inner\.isStreaming/);
  assert.match(forkSource, /this\.inner\.isCompacting/);
  assert.match(forkSource, /Cannot fork while a prompt is running/);
  assert.match(forkSource, /Cannot fork while a shell command is running/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("dual compaction event names are re-emitted for client contract", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /compaction_start/);
  assert.match(source, /compaction_end/);
  assert.match(source, /auto_compaction_start/);
});
