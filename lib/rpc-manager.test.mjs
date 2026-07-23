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

test("withExtensionTools always merges task for non-empty allow-lists", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const fnSource = source.slice(
    source.indexOf("function withExtensionTools"),
    source.indexOf("function systemPromptText"),
  );

  assert.match(fnSource, /if \(toolNames\.length === 0\) return \[\];/);
  assert.match(fnSource, /"task"/);
  assert.match(fnSource, /new Set\(\[\.\.\.toolNames,\s*"task"/);
});

test("startRpcSession captures eventBus and attaches RpcSubagentRegistry", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /eventBus/);
  assert.match(source, /RpcSubagentRegistry/);
  assert.match(source, /setSubscriptionLevel\("progress"\)/);
  assert.match(source, /attachSubagentRegistry/);
});

test("destroy disposes subagent registry before inner.dispose", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const destroySource = source.slice(
    source.indexOf("destroy(): void"),
    source.indexOf("private resolveExtensionUiResponse"),
  );

  const regDispose = destroySource.indexOf("subagentRegistry.dispose()");
  const innerDispose = destroySource.indexOf("this.inner.dispose()");
  assert.ok(regDispose >= 0, "registry.dispose must be called");
  assert.ok(innerDispose >= 0, "inner.dispose must be called");
  assert.ok(regDispose < innerDispose, "registry.dispose before inner.dispose");
});

test("isRunning includes live subagents and idle resets on subagent frames", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /hasLiveSubagents/);
  assert.match(source, /handleSubagentFrame/);
  assert.match(source, /resetIdleTimer\(\)/);

  const isRunningSource = source.slice(
    source.indexOf("isRunning(): boolean"),
    source.indexOf("start(): void"),
  );
  assert.match(isRunningSource, /hasLiveSubagents/);
});

test("subagent SSE level can be off while registry stays at progress for notify", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /subagentSseLevel/);
  assert.match(source, /applySubagentSseSubscription/);
  assert.match(source, /level === "off" \? "progress" : level/);
  // handleSubagentFrame must notify before SSE gate
  const handleSource = source.slice(
    source.indexOf("private handleSubagentFrame"),
    source.indexOf("private applySubagentSseSubscription"),
  );
  const notifyIdx = handleSource.indexOf("notifyRunningChange()");
  const offGateIdx = handleSource.indexOf('subagentSseLevel === "off"');
  assert.ok(notifyIdx >= 0 && offGateIdx >= 0, "notify and off gate both present");
  assert.ok(notifyIdx < offGateIdx, "live notify must run before SSE off gate");
});

test("unsupported command throws SubagentCommandError with statusCode 400", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const defaultSource = source.slice(
    source.indexOf("default:"),
    source.indexOf("destroy(): void"),
  );
  assert.match(defaultSource, /SubagentCommandError/);
  assert.match(defaultSource, /Unsupported command/);
  assert.match(defaultSource, /400/);
});

test("reload keeps existing registry (no recreate on inner.reload only)", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );
  assert.match(reloadSource, /this\.inner\.reload\(\)/);
  assert.doesNotMatch(reloadSource, /new RpcSubagentRegistry|attachSubagentRegistry|subagentRegistry\.dispose/);
});

test("subagent commands are routed in send switch", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /case "set_subagent_subscription"/);
  assert.match(source, /case "get_subagents"/);
  assert.match(source, /case "get_subagent_messages"/);
  assert.match(source, /case "list_subagent_history"/);
  assert.match(source, /assertSubagentSessionFileAllowed|getSubagentMessages|resolveAndAssert/);
});
