/**
 * Stream first-user-message scan tests.
 *
 * Run: bun test lib/session-first-message.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  extractTextFromMessageContent,
  needsFirstMessageEnrichment,
  scanSessionFileForFirstUserMessage,
} from "./session-first-message.ts";

function writeTempJsonl(lines) {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-first-msg-"));
  const filePath = join(dir, "session.jsonl");
  writeFileSync(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
  return { dir, filePath };
}

test("extractTextFromMessageContent: string as-is", () => {
  // Given / When / Then
  assert.equal(extractTextFromMessageContent("hello"), "hello");
});

test("extractTextFromMessageContent: array of text blocks joined with space", () => {
  // Given: multi-block user content like OMP message content arrays
  const content = [
    { type: "text", text: "hello" },
    { type: "image", data: "xxx" },
    { type: "text", text: "world" },
  ];
  // When
  const text = extractTextFromMessageContent(content);
  // Then
  assert.equal(text, "hello world");
});

test("extractTextFromMessageContent: non-array non-string returns empty", () => {
  assert.equal(extractTextFromMessageContent(null), "");
  assert.equal(extractTextFromMessageContent(42), "");
  assert.equal(extractTextFromMessageContent({}), "");
});

test("scan finds user message past large custom_message (beyond 4KB)", async () => {
  // Given: title + session + huge custom_message (~8KB pad) then user "hello world"
  const pad = "x".repeat(8 * 1024);
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "", pad: " ".repeat(100) }),
    JSON.stringify({
      type: "session",
      version: 3,
      id: "test-id",
      timestamp: "2026-07-25T00:00:00.000Z",
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "custom_message",
      id: "cm1",
      parentId: null,
      timestamp: "2026-07-25T00:00:01.000Z",
      customType: "xdev-mount-notice",
      content: pad,
      display: true,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: "cm1",
      timestamp: "2026-07-25T00:00:02.000Z",
      message: { role: "user", content: "hello world" },
    }),
  ];
  const { dir, filePath } = writeTempJsonl(lines);
  try {
    // When
    const result = await scanSessionFileForFirstUserMessage(filePath);
    // Then
    assert.ok(result, "expected a first user message");
    assert.equal(result.firstMessage, "hello world");
    assert.ok(result.bytesRead > 4096, "must read past OMP 4KB prefix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan returns null for empty / header-only file", async () => {
  // Given
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "empty",
      timestamp: "2026-07-25T00:00:00.000Z",
      cwd: "/tmp",
    }),
  ];
  const { dir, filePath } = writeTempJsonl(lines);
  try {
    // When / Then
    assert.equal(await scanSessionFileForFirstUserMessage(filePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan joins array text blocks for user content", async () => {
  // Given
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "blocks",
      timestamp: "2026-07-25T00:00:00.000Z",
      cwd: "/tmp",
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-07-25T00:00:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "alpha" },
          { type: "text", text: "beta" },
        ],
      },
    }),
  ];
  const { dir, filePath } = writeTempJsonl(lines);
  try {
    // When
    const result = await scanSessionFileForFirstUserMessage(filePath);
    // Then
    assert.ok(result);
    assert.equal(result.firstMessage, "alpha beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan returns null when maxBytes too small to reach user", async () => {
  // Given: pad so user message sits after ~2KB
  const pad = "y".repeat(2048);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "cap", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({
      type: "custom_message",
      id: "cm",
      parentId: null,
      timestamp: "2026-07-25T00:00:01.000Z",
      customType: "pad",
      content: pad,
      display: false,
    }),
    JSON.stringify({
      type: "message",
      id: "u1",
      parentId: "cm",
      timestamp: "2026-07-25T00:00:02.000Z",
      message: { role: "user", content: "unreachable" },
    }),
  ];
  const { dir, filePath } = writeTempJsonl(lines);
  try {
    // When: maxBytes stops before user line
    const result = await scanSessionFileForFirstUserMessage(filePath, {
      maxBytes: 512,
      chunkSize: 128,
    });
    // Then
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("needsFirstMessageEnrichment gates empty and zero-count sessions", () => {
  assert.equal(needsFirstMessageEnrichment("(no messages)", 3), true);
  assert.equal(needsFirstMessageEnrichment("", 1), true);
  assert.equal(needsFirstMessageEnrichment(undefined, 1), true);
  assert.equal(needsFirstMessageEnrichment("real title", 0), true);
  assert.equal(needsFirstMessageEnrichment("real title", 2), false);
});
