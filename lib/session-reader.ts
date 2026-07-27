/**
 * Session list/read/context helpers on OMP SessionManager.
 *
 * - list: SessionManager.listAll() under getAgentDir() (default ~/.omp/agent)
 * - open: always `await SessionManager.open(...)` (async; holds single-writer lock)
 * - rename: setSessionName
 * - delete: SessionManager.dropSession — OMP does not cascade-reparent fork children
 * - no ~/.pi scan
 */
import {
  FileSessionStorage,
  SessionManager,
  getAgentDir,
  type SessionEntry as OmpSessionEntry,
  type SessionInfo as OmpSessionInfo,
} from "@oh-my-pi/pi-coding-agent";
import { closeSync, openSync, readSync } from "fs";
import { normalize as normalizePath } from "path";
import type { AgentMessage, SessionEntry, SessionHeader, SessionInfo, SessionContext } from "./types";
import { normalizeToolCalls } from "./normalize";
import {
  mapWithConcurrency,
  needsFirstMessageEnrichment,
  scanSessionFileForFirstUserMessage,
} from "./session-first-message";
import { resolveProject, type ProjectInfo } from "./worktree";

export { getAgentDir };

// ============================================================================
// Session path caches (globalThis for Next hot-reload safety)
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;

export function invalidateSessionListCache(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const pathKey = normalizePath(filePath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousSessionId = reverseCache.get(pathKey);
  if (previousPath && previousPath !== pathKey && reverseCache.get(previousPath) === sessionId) {
    reverseCache.delete(previousPath);
  }
  if (previousSessionId && previousSessionId !== sessionId && pathCache.get(previousSessionId) === pathKey) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, pathKey);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  if (filePath && reverseCache.get(filePath) === sessionId) {
    reverseCache.delete(filePath);
  }
}

/**
 * Resolve parentSession header field → session id.
 * OMP stores either an absolute path (older forks) or a session id (current fork).
 */
function resolveParentSessionId(
  parentRef: string | undefined,
  pathToId: Map<string, string>,
  knownIds: Set<string>,
): string | undefined {
  if (!parentRef) return undefined;
  const byPath = pathToId.get(normalizePath(parentRef));
  if (byPath) return byPath;
  if (knownIds.has(parentRef)) return parentRef;
  return undefined;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const ompSessions: OmpSessionInfo[] = await SessionManager.listAll();
  const pathToId = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const s of ompSessions) {
    pathToId.set(normalizePath(s.path), s.id);
    knownIds.add(s.id);
  }

  const uniqueCwds = [...new Set(ompSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  await Promise.all(uniqueCwds.map(async (cwd) => {
    projectByCwd.set(cwd, await resolveProject(cwd));
  }));

  const sessions: SessionInfo[] = ompSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    const project = s.cwd ? projectByCwd.get(s.cwd) : undefined;
    return {
      path: s.path,
      id: s.id,
      cwd: s.cwd,
      // OMP SessionInfo uses `title`; UI DTO keeps `name`.
      name: s.title,
      created: toIso(s.created),
      modified: toIso(s.modified),
      messageCount: s.messageCount,
      firstMessage: s.firstMessage || "(no messages)",
      parentSessionId: resolveParentSessionId(s.parentSessionPath, pathToId, knownIds),
      projectRoot: project?.projectRoot ?? s.cwd,
      ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
    };
  });

  // OMP listAll only reads a 4 KiB prefix; large custom_message entries can hide
  // the first user message. Enrich empty titles with a bounded stream scan.
  // Concurrency 8 avoids opening hundreds of FDs on large session lists.
  const FIRST_MESSAGE_SCAN_CONCURRENCY = 8;
  await mapWithConcurrency(sessions, FIRST_MESSAGE_SCAN_CONCURRENCY, async (session, index) => {
    if (!needsFirstMessageEnrichment(session.firstMessage, session.messageCount)) {
      return session;
    }
    const found = await scanSessionFileForFirstUserMessage(session.path);
    if (!found) return session;
    // If OMP reported 0 messages but we found a user turn, expose a lower bound
    // of 1 so the UI does not look empty; otherwise keep OMP's count.
    const messageCount =
      session.messageCount === 0 ? Math.max(1, session.messageCount) : session.messageCount;
    const enriched: SessionInfo = {
      ...session,
      firstMessage: found.firstMessage,
      messageCount,
    };
    sessions[index] = enriched;
    return enriched;
  });

  return sessions;
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  const loadPromise = loadAllSessions().then((data) => {
    if ((globalThis.__piSessionListGeneration ?? 0) === generation) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) return cached;

  await listAllSessions();
  return getPathCache().get(sessionId) ?? null;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = normalizePath(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

/**
 * Open a session file, run `fn`, always close (releases OMP single-writer lock).
 */
export async function withSessionManager<T>(
  filePath: string,
  fn: (sm: SessionManager) => T | Promise<T>,
): Promise<T> {
  const sm = await SessionManager.open(filePath);
  try {
    return await fn(sm);
  } finally {
    await sm.close();
  }
}

/**
 * Drop a session file + artifacts via OMP FileSessionStorage.
 *
 * Cascade note: OMP only deletes the target file (and artifacts). It does NOT
 * reparent fork children. Children keep `parentSession` pointing at the deleted
 * path/id; the sidebar treats them as roots once the parent id is gone. Matches
 * OMP CLI semantics (no cascade-reparent).
 *
 * Must use FileSessionStorage — MemorySessionStorage.drop is a no-op for disk.
 */
export async function dropSessionFile(filePath: string): Promise<void> {
  const storage = new FileSessionStorage();
  try {
    await storage.deleteSessionWithArtifacts(filePath);
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err ? (err as { code?: string }).code : undefined;
    if (code !== "ENOENT") throw err;
  }
}

export async function getSessionEntries(filePath: string): Promise<SessionEntry[]> {
  return withSessionManager(filePath, (sm) => sm.getEntries() as unknown as SessionEntry[]);
}

export function readSessionHeader(filePath: string): SessionHeader | null {
  const fd = openSync(filePath, "r");
  try {
    const maxHeaderBytes = 64 * 1024;
    let position = 0;
    // OMP may prefix a title-slot JSONL line before the session header.
    // Scan lines until we find type:"session" or exhaust the bound.
    while (position < maxHeaderBytes) {
      const chunks: Buffer[] = [];
      let foundNewline = false;
      while (position < maxHeaderBytes && !foundNewline) {
        const buffer = Buffer.allocUnsafe(Math.min(4096, maxHeaderBytes - position));
        const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
        if (bytesRead === 0) {
          if (chunks.length === 0) return null;
          break;
        }
        const data = buffer.subarray(0, bytesRead);
        const newlineIndex = data.indexOf(0x0a);
        chunks.push(newlineIndex === -1 ? data : data.subarray(0, newlineIndex));
        position += newlineIndex === -1 ? bytesRead : newlineIndex + 1;
        foundNewline = newlineIndex !== -1;
      }
      if (!foundNewline && position >= maxHeaderBytes) return null;
      const line = Buffer.concat(chunks).toString("utf8").trimEnd();
      if (!line) {
        if (!foundNewline) return null;
        continue;
      }
      try {
        const parsed = JSON.parse(line) as SessionHeader & { type?: string };
        if (parsed.type === "session") return parsed;
      } catch {
        return null;
      }
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/**
 * Read the session header from a file that may have a title-slot prefix line.
 * Prefer SessionManager when the file is already open; this is a lock-free peek.
 */
export async function readSessionHeaderViaManager(filePath: string): Promise<SessionHeader | null> {
  return withSessionManager(filePath, (sm) => sm.getHeader() as SessionHeader | null);
}

function parseModelRef(raw: string | undefined): { provider: string; modelId: string } | null {
  if (!raw) return null;
  const slash = raw.indexOf("/");
  if (slash <= 0) return { provider: "", modelId: raw };
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

/**
 * Select entries that form the UI context path (compaction-aware), parallel to
 * messages produced by entryToUiMessage.
 *
 * Mirrors OMP/earendil default (non-transcript) ordering:
 * latest compaction summary → kept messages from firstKeptEntryId → post-compaction.
 */
function selectContextEntries(
  entries: SessionEntry[],
  leafId?: string | null,
): {
  contextEntries: SessionEntry[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
} {
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);

  if (leafId === null) {
    return { contextEntries: [], thinkingLevel: "off", model: null };
  }

  let leaf: SessionEntry | undefined = leafId ? byId.get(leafId) : undefined;
  if (!leaf) leaf = entries[entries.length - 1];
  if (!leaf) return { contextEntries: [], thinkingLevel: "off", model: null };

  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  let thinkingLevel = "off";
  let model: { provider: string; modelId: string } | null = null;
  let compaction: Extract<SessionEntry, { type: "compaction" }> | null = null;

  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel || "off";
    } else if (entry.type === "model_change") {
      // OMP: { model: "provider/id" }; legacy earendil: { provider, modelId }
      const ompModel = (entry as SessionEntry & { model?: string }).model;
      if (typeof ompModel === "string" && ompModel.length > 0) {
        model = parseModelRef(ompModel);
      } else if (entry.provider && entry.modelId) {
        model = { provider: entry.provider, modelId: entry.modelId };
      }
    } else if (entry.type === "message" && entry.message.role === "assistant" && !model) {
      const msg = entry.message as { provider?: string; model?: string };
      if (msg.provider && msg.model) {
        model = { provider: msg.provider, modelId: msg.model };
      }
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const contextEntries: SessionEntry[] = [];
  if (compaction) {
    contextEntries.push(compaction);
    const compactionIdx = path.findIndex((e) => e.id === compaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) contextEntries.push(entry);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) {
      contextEntries.push(path[i]);
    }
  } else {
    contextEntries.push(...path);
  }

  return { contextEntries, thinkingLevel, model };
}

export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {},
): SessionContext {
  const { contextEntries, thinkingLevel, model } = selectContextEntries(entries, leafId);

  const messages: AgentMessage[] = [];
  const entryIds: string[] = [];
  for (const entry of contextEntries) {
    const m = entryToUiMessage(entry, options);
    if (m) {
      messages.push(m);
      entryIds.push(entry.id);
    }
  }

  return {
    messages,
    entryIds,
    thinkingLevel,
    model,
  };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64ImageInfo(block: unknown): { bytes: number; mime?: string } | null {
  if (!isRecord(block) || block.type !== "image") return null;

  let data: string | undefined;
  let mime: string | undefined;
  if (typeof block.data === "string") {
    data = block.data;
    mime = typeof block.mimeType === "string" ? block.mimeType : undefined;
  } else if (isRecord(block.source) && block.source.type === "base64" && typeof block.source.data === "string") {
    data = block.source.data;
    mime = typeof block.source.media_type === "string" ? block.source.media_type : undefined;
  }
  if (!data) return null;

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return { bytes: Math.max(0, Math.floor(data.length * 3 / 4) - padding), mime };
}

function omitToolResultBase64Images(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;

  let omitted = 0;
  let bytes = 0;
  const mimes = new Set<string>();
  const content = message.content.filter((block) => {
    const image = base64ImageInfo(block);
    if (!image) return true;
    omitted += 1;
    bytes += image.bytes;
    if (image.mime) mimes.add(image.mime);
    return false;
  });
  if (omitted === 0) return message;

  const mimeText = mimes.size > 0 ? `: ${[...mimes].join(", ")}` : "";
  content.push({
    type: "text",
    text: `[${omitted} tool result image${omitted === 1 ? "" : "s"} omitted from initial history payload${mimeText}, ~${bytes} bytes]`,
  });
  return { ...message, content };
}

function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  switch (entry.type) {
    case "message": {
      const message = options.deferToolResultImages
        ? omitToolResultBase64Images(normalizeToolCalls(entry.message))
        : normalizeToolCalls(entry.message);
      if (!options.deferThinking || message.role !== "assistant") return message;
      return {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
    }
    case "compaction":
      return {
        role: "custom",
        customType: "compaction",
        content: entry.summary,
        display: true,
        details: {
          tokensBefore: entry.tokensBefore,
          firstKeptEntryId: entry.firstKeptEntryId,
        },
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      return null;
  }
}

// Re-export OMP entry type alias for callers that need SDK shape.
export type { OmpSessionEntry };
