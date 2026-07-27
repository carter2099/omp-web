/**
 * Stream-scan a session .jsonl for the first non-empty user message text.
 *
 * OMP listAll only reads SESSION_LIST_PREFIX_BYTES (4 KiB). Large early
 * custom_message entries can push the first user message past that window,
 * so list titles fall back to "(no messages)". This module reads further in
 * bounded chunks without loading the whole file.
 */

import { closeSync, openSync, readSync } from "node:fs";

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_BYTES = 1_048_576;

export type ScanFirstUserMessageOptions = {
  readonly maxBytes?: number;
  readonly chunkSize?: number;
};

export type ScanFirstUserMessageResult = {
  readonly firstMessage: string;
  readonly bytesRead: number;
};

function isTextBlock(block: unknown): block is { readonly type: "text"; readonly text: string } {
  if (typeof block !== "object" || block === null) return false;
  if (!("type" in block) || !("text" in block)) return false;
  return block.type === "text" && typeof block.text === "string";
}

/**
 * Match OMP session-listing extractTextFromContent:
 * string content as-is; array of blocks joins text blocks with space.
 */
export function extractTextFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) parts.push(block.text);
  }
  return parts.join(" ");
}

function tryUserTextFromLine(line: string): string | null {
  const trimmedLine = line.trim();
  if (!trimmedLine) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedLine);
  } catch {
    // Unparseable / partial JSONL line — skip (expected for corrupt fragments).
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("type" in parsed) || parsed.type !== "message") return null;
  if (!("message" in parsed)) return null;
  const message = parsed.message;
  if (typeof message !== "object" || message === null) return null;
  if (!("role" in message) || message.role !== "user") return null;
  const content = "content" in message ? message.content : undefined;
  const text = extractTextFromMessageContent(content).trim();
  return text.length > 0 ? text : null;
}

/**
 * Stream-read a session file until the first non-empty user message text is found.
 * Returns null when maxBytes is exhausted or the file has no such message.
 */
export async function scanSessionFileForFirstUserMessage(
  filePath: string,
  options: ScanFirstUserMessageOptions = {},
): Promise<ScanFirstUserMessageResult | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (maxBytes <= 0 || chunkSize <= 0) return null;

  // Async surface so callers can pool; body is sync fs (matches readSessionHeader).
  return Promise.resolve().then(() => {
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === "ENOENT") return null;
      throw err;
    }

    try {
      let position = 0;
      let carry = "";
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, maxBytes));

      while (position < maxBytes) {
        const toRead = Math.min(buffer.length, maxBytes - position);
        const bytesRead = readSync(fd, buffer, 0, toRead, position);
        if (bytesRead === 0) {
          // EOF — flush trailing line without newline.
          if (carry.length > 0) {
            const text = tryUserTextFromLine(carry);
            if (text !== null) {
              return { firstMessage: text, bytesRead: position };
            }
          }
          return null;
        }

        position += bytesRead;
        const chunk = carry + buffer.subarray(0, bytesRead).toString("utf8");
        carry = "";

        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk.charCodeAt(i) !== 0x0a) continue;
          const line = chunk.slice(start, i);
          start = i + 1;
          const text = tryUserTextFromLine(line);
          if (text !== null) {
            return { firstMessage: text, bytesRead: position };
          }
        }
        carry = chunk.slice(start);
      }

      // maxBytes reached without a user message (do not parse partial carry past cap).
      return null;
    } finally {
      closeSync(fd);
    }
  });
}

/** Run async work over items with a fixed concurrency cap. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

export function needsFirstMessageEnrichment(
  firstMessage: string | undefined,
  messageCount: number,
): boolean {
  if (firstMessage === undefined || firstMessage === "" || firstMessage === "(no messages)") {
    return true;
  }
  // Prefer re-scan when OMP reported zero messages (prefix may have missed content).
  return messageCount === 0;
}
