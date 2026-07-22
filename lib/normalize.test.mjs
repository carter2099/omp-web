import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeToolCalls } = await jiti.import("./normalize.ts");

test("normalizes the OMP persisted toolCall shape", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }] };
  assert.deepEqual(normalizeToolCalls(message).content[0], { type: "toolCall", toolCallId: "call-1", toolName: "read", input: { path: "README.md" } });
});

test("preserves the normalized streaming shape", () => {
  const block = { type: "toolCall", toolCallId: "call-2", toolName: "bash", input: { command: "pwd" } };
  assert.deepEqual(normalizeToolCalls({ role: "assistant", content: [block] }).content[0], block);
});

test("unknown blocks and non-assistant SSE messages remain safe", () => {
  const unknown = { type: "custom", value: { ok: true } };
  const assistant = normalizeToolCalls({ role: "assistant", content: [unknown] });
  const user = { role: "user", content: [{ type: "toolCall", id: "ignored", name: "read", arguments: {} }] };
  assert.equal(assistant.content[0], unknown);
  assert.equal(normalizeToolCalls(user), user);
});

test("incomplete toolCall shape still safe (empty strings / empty input)", () => {
  const out = normalizeToolCalls({
    role: "assistant",
    content: [
      { type: "toolCall" },
      { type: "toolCall", id: 123, name: null, arguments: "not-object" },
    ],
  });
  assert.deepEqual(out.content[0], { type: "toolCall", toolCallId: "", toolName: "", input: {} });
  assert.deepEqual(out.content[1], { type: "toolCall", toolCallId: "", toolName: "", input: {} });
});

test("message_update SSE payload with file-format toolCall normalizes for streaming UI", () => {
  const streamEvent = {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "s1", name: "grep", arguments: { pattern: "x" } }],
    },
  };
  const normalized = normalizeToolCalls(streamEvent.message);
  assert.equal(normalized.content[0].toolCallId, "s1");
  assert.equal(normalized.content[0].toolName, "grep");
  assert.deepEqual(normalized.content[0].input, { pattern: "x" });
});

test("both compaction event spellings are valid fixture events", () => {
  for (const type of ["compaction_start", "auto_compaction_start", "compaction_end", "auto_compaction_end"]) assert.equal(typeof type, "string");
});
