/**
 * Session-reader unit + fixture tests (OMP SessionManager).
 *
 * Run: bun test lib/session-reader.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import { setAgentDir } from "@oh-my-pi/pi-utils";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";

import {
  buildSessionContext,
  cacheSessionPath,
  dropSessionFile,
  getSessionEntries,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  listAllSessions,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
  withSessionManager,
} from "./session-reader.ts";

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

// ---------------------------------------------------------------------------
// buildSessionContext (pure — no agentDir)
// ---------------------------------------------------------------------------

test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "kept user request"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].customType, "compaction");
  assert.equal(context.messages[0].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "pi-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(normalize(filePath)), false);
});

// ---------------------------------------------------------------------------
// Fixture-backed OMP SessionManager integration (temp agentDir)
// ---------------------------------------------------------------------------

function makeIsolatedAgentDir(label) {
  const root = mkdtempSync(join(tmpdir(), `pi-web-sess-${label}-`));
  const agentDir = join(root, ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  setAgentDir(agentDir);
  invalidateSessionListCache();
  return { root, agentDir, cwd };
}

async function createFixtureSession(cwd, { name, userText } = {}) {
  const sm = SessionManager.create(cwd);
  await sm.ensureOnDisk();
  if (userText) {
    sm.appendMessage({ role: "user", content: userText, timestamp: Date.now() });
  }
  if (name) {
    await sm.setSessionName(name, "user");
  }
  await sm.flush();
  const filePath = sm.getSessionFile();
  const id = sm.getSessionId();
  await sm.close();
  if (!filePath) throw new Error("SessionManager did not persist a file");
  return { id, filePath };
}

test("listAllSessions lists fixture sessions under temp agentDir (not ~/.pi)", async () => {
  // Given
  const { root, agentDir, cwd } = makeIsolatedAgentDir("list");
  try {
    const { id, filePath } = await createFixtureSession(cwd, {
      name: "Fixture List",
      userText: "hello from fixture",
    });

    // When
    invalidateSessionListCache();
    const sessions = await listAllSessions();

    // Then
    assert.ok(Array.isArray(sessions));
    const found = sessions.find((s) => s.id === id);
    assert.ok(found, `expected session ${id} in list`);
    assert.equal(found.name, "Fixture List");
    assert.equal(found.path, filePath);
    assert.ok(found.path.startsWith(agentDir), `path must be under agentDir: ${found.path}`);
    assert.ok(!found.path.includes("/.pi/"), "must not scan ~/.pi");
    assert.match(found.firstMessage, /hello from fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detail open + context + rename via setSessionName", async () => {
  // Given
  const { root, cwd } = makeIsolatedAgentDir("detail");
  try {
    const { id, filePath } = await createFixtureSession(cwd, {
      userText: "detail prompt",
    });
    cacheSessionPath(id, filePath);
    invalidateSessionListCache();

    // When — detail/context
    const detail = await withSessionManager(filePath, (sm) => {
      const entries = sm.getEntries();
      const leafId = sm.getLeafId();
      const context = buildSessionContext(entries, leafId);
      return {
        leafId,
        name: sm.getSessionName(),
        entryCount: entries.length,
        context,
      };
    });

    // Then
    assert.ok(detail.leafId);
    assert.ok(detail.context.messages.length >= 1);
    assert.equal(detail.context.messages.length, detail.context.entryIds.length);
    assert.equal(detail.context.messages[0].role, "user");

    // When — rename
    await withSessionManager(filePath, async (sm) => {
      const ok = await sm.setSessionName("Renamed Fixture", "user");
      assert.equal(ok, true);
    });

    const renamed = await withSessionManager(filePath, (sm) => sm.getSessionName());
    assert.equal(renamed, "Renamed Fixture");

    // resolveSessionPath after cache
    assert.equal(await resolveSessionPath(id), normalize(filePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("getSessionEntries loads messages after await SessionManager.open", async () => {
  // Given
  const { root, cwd } = makeIsolatedAgentDir("entries");
  try {
    const { filePath } = await createFixtureSession(cwd, { userText: "entries check" });

    // When
    const entries = await getSessionEntries(filePath);

    // Then
    assert.ok(entries.some((e) => e.type === "message" && e.message?.role === "user"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportFromFile produces HTML for a fixture session", async () => {
  // Given
  const { root, cwd } = makeIsolatedAgentDir("export");
  try {
    const { filePath } = await createFixtureSession(cwd, { userText: "export me" });
    const outPath = join(root, "export-out.html");

    // When
    const { exportFromFile } = await import("@oh-my-pi/pi-coding-agent/export/html/index");
    await exportFromFile(filePath, { outputPath: outPath });

    // Then
    const html = readFileSync(outPath, "utf8");
    assert.match(html, /<html/i);
    assert.ok(html.length > 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dropSessionFile deletes the session without cascade reparent", async () => {
  // Given
  const { root, cwd } = makeIsolatedAgentDir("delete");
  try {
    const parent = await createFixtureSession(cwd, { name: "Parent", userText: "parent msg" });
    // Child with parentSession = parent id (OMP fork semantics)
    const childSm = SessionManager.create(cwd);
    await childSm.ensureOnDisk();
    childSm.appendMessage({ role: "user", content: "child msg", timestamp: Date.now() });
    await childSm.flush();
    const childPath = childSm.getSessionFile();
    const childId = childSm.getSessionId();
    await childSm.close();
    // Manually set parentSession on child header to parent path (path form)
    const childRaw = readFileSync(childPath, "utf8");
    const childLines = childRaw.split("\n");
    const headerIdx = childLines.findIndex((l) => {
      try { return JSON.parse(l).type === "session"; } catch { return false; }
    });
    assert.ok(headerIdx >= 0);
    const header = JSON.parse(childLines[headerIdx]);
    header.parentSession = parent.filePath;
    childLines[headerIdx] = JSON.stringify(header);
    writeFileSync(childPath, childLines.join("\n"));

    // When
    await dropSessionFile(parent.filePath);

    // Then — parent gone, child still on disk (no cascade)
    assert.throws(() => readFileSync(parent.filePath));
    const stillThere = readFileSync(childPath, "utf8");
    assert.ok(stillThere.includes(childId) || stillThere.includes("child msg"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing session id resolves to null (404 path)", async () => {
  // Given
  const { root } = makeIsolatedAgentDir("missing");
  try {
    invalidateSessionListCache();
    // When / Then
    assert.equal(await resolveSessionPath("does-not-exist-id"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
