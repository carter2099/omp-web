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
/** Cap parent-session task metadata scan (agent type recovery). */
const PARENT_TASK_SCAN_MAX_BYTES = 4 * 1024 * 1024;
/** Match ROLE headers injected into child system prompts: `You are **Oracle**`. */
const ROLE_HEADER_RE = /You are \*\*([A-Za-z][A-Za-z0-9_-]{0,63})\*\*/;

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

type ChildMeta = {
	leafId: string | null;
	status: SubagentHistoryStatus;
	agent: string | null;
	model: string | null;
};

type ParentTaskMeta = {
	agent?: string;
	agentSource?: string;
	task?: string;
	description?: string;
};

function extractMetadata(filePath: string): ChildMeta {
	let status: SubagentHistoryStatus = "unknown";
	let leafId: string | null = null;
	let agent: string | null = null;
	let model: string | null = null;

	let size = 0;
	try {
		size = statSync(filePath).size;
	} catch {
		return { leafId, status, agent, model };
	}

	if (size <= 0) {
		return { leafId, status, agent, model };
	}

	const headLen = Math.min(size, HEADER_SCAN_BYTES);
	const headText = readFileSlice(filePath, 0, headLen);
	const headObjects = parseJsonlObjects(headText);

	for (const obj of headObjects) {
		const rec = asRecord(obj);
		if (!rec) continue;
		const type = readStringField(rec, "type");
		if (type === "session_init") {
			const systemPrompt = readStringField(rec, "systemPrompt");
			if (systemPrompt) {
				const match = ROLE_HEADER_RE.exec(systemPrompt);
				if (match?.[1]) {
					agent = match[1].toLowerCase();
				}
			}
			continue;
		}
		if (type === "model_change") {
			const modelField = readStringField(rec, "model");
			if (modelField) model = modelField;
			continue;
		}
		if (type === "session_info") {
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

	return { leafId, status, agent, model };
}

function rememberParentMeta(
	map: Map<string, ParentTaskMeta>,
	id: string,
	patch: ParentTaskMeta,
): void {
	const existing = map.get(id) ?? {};
	map.set(id, {
		agent: patch.agent ?? existing.agent,
		agentSource: patch.agentSource ?? existing.agentSource,
		task: patch.task ?? existing.task,
		description: patch.description ?? existing.description,
	});
}

function ingestProgressLikeRow(
	map: Map<string, ParentTaskMeta>,
	row: Record<string, unknown>,
): void {
	const id = readStringField(row, "id");
	if (!id) return;
	rememberParentMeta(map, id, {
		agent: readStringField(row, "agent") ?? undefined,
		agentSource: readStringField(row, "agentSource") ?? undefined,
		task: readStringField(row, "task") ?? readStringField(row, "assignment") ?? undefined,
		description: readStringField(row, "description") ?? undefined,
	});
}

function scanParentTaskMetadata(parentSessionFile: string): Map<string, ParentTaskMeta> {
	const map = new Map<string, ParentTaskMeta>();
	let size = 0;
	try {
		size = statSync(parentSessionFile).size;
	} catch {
		return map;
	}
	if (size <= 0) return map;

	const scanLen = Math.min(size, PARENT_TASK_SCAN_MAX_BYTES);
	const text = readFileSlice(parentSessionFile, 0, scanLen);
	const body =
		scanLen < size && text.includes("\n")
			? text.slice(0, text.lastIndexOf("\n") + 1)
			: text;

	for (const obj of parseJsonlObjects(body)) {
		const rec = asRecord(obj);
		if (!rec) continue;
		if (readStringField(rec, "type") !== "message") continue;
		const message = asRecord(rec.message);
		if (!message) continue;
		const role = readStringField(message, "role");

		if (role === "assistant") {
			const content = message.content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				const b = asRecord(block);
				if (!b) continue;
				const blockType = readStringField(b, "type");
				const toolName = readStringField(b, "name") ?? readStringField(b, "toolName");
				if (blockType !== "toolCall" && blockType !== "tool_use") continue;
				if (toolName !== "task") continue;
				const args = asRecord(b.arguments) ?? asRecord(b.input);
				if (!args) continue;
				const singleName = readStringField(args, "name");
				const singleAgent = readStringField(args, "agent");
				if (singleName && singleAgent) {
					rememberParentMeta(map, singleName, {
						agent: singleAgent,
						task: readStringField(args, "task") ?? undefined,
						description: readStringField(args, "description") ?? singleName,
					});
				}
				const tasks = args.tasks;
				if (Array.isArray(tasks)) {
					for (const item of tasks) {
						const t = asRecord(item);
						if (!t) continue;
						const name = readStringField(t, "name");
						const agent = readStringField(t, "agent");
						if (!name) continue;
						rememberParentMeta(map, name, {
							agent: agent ?? undefined,
							task: readStringField(t, "task") ?? undefined,
							description: readStringField(t, "description") ?? name,
						});
					}
				}
			}
			continue;
		}

		if (role === "toolResult" || role === "tool") {
			const toolName = readStringField(message, "toolName") ?? readStringField(message, "name");
			if (toolName !== "task") continue;
			const details = asRecord(message.details);
			if (!details) continue;
			if (Array.isArray(details.progress)) {
				for (const row of details.progress) {
					const r = asRecord(row);
					if (r) ingestProgressLikeRow(map, r);
				}
			}
			if (Array.isArray(details.results)) {
				for (const row of details.results) {
					const r = asRecord(row);
					if (r) ingestProgressLikeRow(map, r);
				}
			}
			const asyncBag = asRecord(details.async);
			if (asyncBag && Array.isArray(asyncBag.progress)) {
				for (const row of asyncBag.progress) {
					const r = asRecord(row);
					if (r) ingestProgressLikeRow(map, r);
				}
			}
		}
	}

	return map;
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

		const { leafId, status, agent, model } = extractMetadata(allowedPath);
		out.push({
			agentId,
			parent: parentKey,
			sessionFile: allowedPath,
			leafId,
			status,
			...(agent ? { agent } : {}),
			...(model ? { model } : {}),
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

function applyParentTaskMetadata(
	rows: SubagentHistoryRow[],
	parentMeta: Map<string, ParentTaskMeta>,
): void {
	if (parentMeta.size === 0 || rows.length === 0) return;
	for (const row of rows) {
		const meta = parentMeta.get(row.agentId);
		if (!meta) continue;
		if (meta.agent) row.agent = meta.agent;
		if (meta.agentSource) row.agentSource = meta.agentSource;
		if (meta.task) row.task = meta.task;
		if (meta.description) row.description = meta.description;
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
	applyParentTaskMetadata(out, scanParentTaskMetadata(parentSessionFile));
	return out;
}
