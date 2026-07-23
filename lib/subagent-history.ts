/**
 * Containment-aware SubAgent history walker.
 *
 * Scans ONLY under the parent session artifacts root. For each candidate `.jsonl`,
 * realpath + `assertSubagentSessionFileAllowed` BEFORE open. Reads minimal
 * header/metadata for list DTO only — never full entry dumps, never `collectSubSessions`.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readSync,
	readdirSync,
	statSync,
} from "node:fs";
import path from "node:path";
import {
	assertSubagentSessionFileAllowed,
	resolveSubagentArtifactsRoot,
	SubagentPathError,
} from "./subagent-path";
import type {
	SubagentHistoryRow,
	SubagentHistoryStatus,
} from "./subagent-types";

const HEADER_SCAN_BYTES = 64 * 1024;
const TAIL_SCAN_BYTES = 8 * 1024;

export type SubagentHistoryWalkerHooks = {
	/** Invoked with the absolute path immediately before a candidate is opened. */
	onOpen?: (absolutePath: string) => void;
};

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

function readFileSlice(filePath: string, start: number, length: number): string {
	const fd = openSync(filePath, "r");
	try {
		const buf = Buffer.alloc(length);
		const bytesRead = readSync(fd, buf, 0, length, start);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

function parseJsonlObjects(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			out.push(JSON.parse(trimmed) as unknown);
		} catch {
			// Skip corrupt lines; best-effort metadata only.
		}
	}
	return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function readStringField(obj: Record<string, unknown>, key: string): string | null {
	const value = obj[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Best-effort status + leafId from a light head/tail scan of a jsonl session file.
 */
function extractMetadata(filePath: string): {
	leafId: string | null;
	status: SubagentHistoryStatus;
} {
	let status: SubagentHistoryStatus = "unknown";
	let leafId: string | null = null;

	let size = 0;
	try {
		size = statSync(filePath).size;
	} catch {
		return { leafId, status };
	}

	if (size <= 0) {
		return { leafId, status };
	}

	const headLen = Math.min(size, HEADER_SCAN_BYTES);
	const headText = readFileSlice(filePath, 0, headLen);
	const headObjects = parseJsonlObjects(headText);

	for (const obj of headObjects) {
		const rec = asRecord(obj);
		if (!rec) continue;
		const type = readStringField(rec, "type");
		// Session header has no terminal status; keep scanning early lines.
		if (type === "session_info") {
			// no status field typically
			continue;
		}
		if (type === "message") {
			const message = asRecord(rec.message);
			if (!message) continue;
			const role = readStringField(message, "role");
			const stopReason = readStringField(message, "stopReason");
			if (role === "assistant" && stopReason === "error") {
				status = "failed";
			}
		}
	}

	// Tail scan for leaf entry id and a coarse completed signal.
	const tailStart = Math.max(0, size - TAIL_SCAN_BYTES);
	const tailText =
		tailStart === 0 && headLen === size
			? headText
			: readFileSlice(filePath, tailStart, size - tailStart);
	// If we started mid-line, drop the first partial line.
	const tailBody =
		tailStart > 0 ? tailText.slice(tailText.indexOf("\n") + 1) : tailText;
	const tailObjects = parseJsonlObjects(tailBody);

	for (const obj of tailObjects) {
		const rec = asRecord(obj);
		if (!rec) continue;
		const id = readStringField(rec, "id");
		const type = readStringField(rec, "type");
		if (id && type && type !== "session") {
			leafId = id;
		}
		if (type === "message") {
			const message = asRecord(rec.message);
			if (!message) continue;
			const role = readStringField(message, "role");
			const stopReason = readStringField(message, "stopReason");
			if (role === "assistant") {
				if (stopReason === "error") {
					status = "failed";
				} else if (status === "unknown") {
					// Cold transcripts with a final assistant turn are typically done.
					status = "completed";
				}
			}
		}
	}

	// Any non-empty cold file without stronger signal → completed (historical).
	if (status === "unknown" && leafId !== null) {
		status = "completed";
	}

	return { leafId, status };
}

function walkDir(
	dir: string,
	parentKey: string | null,
	parentSessionFile: string,
	out: SubagentHistoryRow[],
	hooks: SubagentHistoryWalkerHooks | undefined,
): void {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (error) {
		if (isEnoent(error)) return;
		throw error;
	}

	for (const name of names) {
		if (!name.endsWith(".jsonl") || name.includes(".bak")) continue;

		const agentId = name.slice(0, -6);
		const key = parentKey ? `${parentKey}/${agentId}` : agentId;
		const candidate = path.join(dir, name);

		let allowedPath: string;
		try {
			allowedPath = assertSubagentSessionFileAllowed(parentSessionFile, candidate);
		} catch (error) {
			// Skip escapes / missing / bad shape — never open them.
			if (error instanceof SubagentPathError) continue;
			throw error;
		}

		hooks?.onOpen?.(allowedPath);

		const { leafId, status } = extractMetadata(allowedPath);
		out.push({
			agentId,
			parent: parentKey,
			sessionFile: allowedPath,
			leafId,
			status,
		});

		// Nested children live under `<dir>/<agentId>/` (same layout as OMP artifacts).
		const nestedDir = path.join(dir, agentId);
		if (existsSync(nestedDir)) {
			try {
				if (statSync(nestedDir).isDirectory()) {
					walkDir(nestedDir, key, parentSessionFile, out, hooks);
				}
			} catch {
				// Ignore unreadable nested dirs.
			}
		}
	}
}

/**
 * List cold SubAgent transcripts under the parent session artifacts root.
 * Returns `[]` when the artifacts directory does not exist.
 */
export function listSubagentHistory(
	parentSessionFile: string,
	hooks?: SubagentHistoryWalkerHooks,
): SubagentHistoryRow[] {
	let rootWithSep: string;
	try {
		rootWithSep = resolveSubagentArtifactsRoot(parentSessionFile);
	} catch (error) {
		if (error instanceof SubagentPathError && error.statusCode === 404) {
			return [];
		}
		throw error;
	}

	// Root path without trailing sep for exists/readdir.
	const rootDir = rootWithSep.endsWith(path.sep)
		? rootWithSep.slice(0, -path.sep.length)
		: rootWithSep;

	if (!existsSync(rootDir)) {
		return [];
	}

	try {
		if (!statSync(rootDir).isDirectory()) {
			return [];
		}
	} catch {
		return [];
	}

	const out: SubagentHistoryRow[] = [];
	walkDir(rootDir, null, parentSessionFile, out, hooks);
	return out;
}
