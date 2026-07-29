/**
 * Pure client-side SubAgent snapshot map helpers (session-scoped SSE state).
 * Unit-testable without React. Server registry drops terminal rows; the client
 * keeps them for the current parent session lifetime.
 */

import type {
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type {
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import { isLiveSubagentStatus } from "./subagent-live";
import type { SubagentHistoryRow, SubagentHistoryStatus } from "./subagent-types";

/** Snapshot map keyed by subagent id. Immutable updates only. */
export type SubagentSnapshotMap = Readonly<Record<string, RpcSubagentSnapshot>>;

/**
 * Ordered commands issued on every SSE `connected` (initial + reconnect).
 * Wire must run them in this order: subscribe first, then snapshot merge.
 */
export const SUBAGENT_CONNECTED_COMMAND_SEQUENCE = [
	{ type: "set_subagent_subscription", level: "progress" as const satisfies RpcSubagentSubscriptionLevel },
	{ type: "get_subagents" },
] as const;

export type SubagentClientScope = {
	readonly sessionId: string | null;
	readonly generation: number;
};

export type SubagentClientState = SubagentClientScope & {
	readonly subagents: SubagentSnapshotMap;
	readonly selectedSubagentId: string | null;
};

export function emptySubagentMap(): SubagentSnapshotMap {
	return {};
}

export function createSubagentClientState(
	sessionId: string | null = null,
): SubagentClientState {
	return {
		sessionId,
		generation: 0,
		subagents: emptySubagentMap(),
		selectedSubagentId: null,
	};
}

/** True when a frame/response generation matches the current client scope. */
export function isCurrentSubagentGeneration(
	scope: SubagentClientScope,
	generation: number,
): boolean {
	return scope.generation === generation;
}

/**
 * Bump generation for a new SSE connection under the same parent session.
 * Does not clear the snapshot map (reconnect must keep terminal rows).
 */
export function bumpSubagentGeneration(
	state: SubagentClientState,
): SubagentClientState {
	return {
		...state,
		generation: state.generation + 1,
	};
}

/**
 * When the parent chat session id changes, clear map + selection and bump
 * generation so in-flight reconnect merges cannot resurrect stale rows.
 */
export function clearSubagentStateForSessionChange(
	state: SubagentClientState,
	nextSessionId: string | null,
): SubagentClientState {
	if (state.sessionId === nextSessionId) {
		return state;
	}
	return {
		sessionId: nextSessionId,
		generation: state.generation + 1,
		subagents: emptySubagentMap(),
		selectedSubagentId: null,
	};
}

/**
 * Merge `get_subagents` server list into the client map.
 * - Server snapshots overwrite by id (live truth).
 * - Terminal client rows omitted by the server are retained.
 * - Non-terminal client rows omitted by the server are dropped (gone from registry).
 */
export function mergeGetSubagents(
	current: SubagentSnapshotMap,
	serverSubagents: readonly RpcSubagentSnapshot[],
): SubagentSnapshotMap {
	const next: Record<string, RpcSubagentSnapshot> = {};

	for (const [id, snapshot] of Object.entries(current)) {
		if (!isLiveSubagentStatus(snapshot.status)) {
			next[id] = snapshot;
		}
	}

	for (const snapshot of serverSubagents) {
		next[snapshot.id] = snapshot;
	}

	return next;
}

function statusFromLifecycle(
	status: SubagentLifecyclePayload["status"],
): RpcSubagentSnapshot["status"] {
	return status === "started" ? "running" : status;
}

/**
 * Apply a lifecycle frame. Terminal statuses stay in the map (client retention).
 */
export function applySubagentLifecycle(
	current: SubagentSnapshotMap,
	payload: SubagentLifecyclePayload,
	nowMs: number = Date.now(),
): SubagentSnapshotMap {
	const existing = current[payload.id];
	if (existing && !hasSameOwner(payload, existing)) {
		return current;
	}
	// Mirror server: ignore terminal lifecycle for unknown ids (no prior start).
	if (!existing && payload.status !== "started") {
		return current;
	}

	const sessionFile = payload.sessionFile ?? existing?.sessionFile;
	const snapshot: RpcSubagentSnapshot = {
		id: payload.id,
		index: payload.index,
		agent: payload.agent,
		agentSource: payload.agentSource,
		description: payload.description ?? existing?.description,
		status: statusFromLifecycle(payload.status),
		task: existing?.task,
		assignment: existing?.assignment,
		sessionFile,
		parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
		lastUpdate: nowMs,
		progress: existing?.progress,
	};

	return { ...current, [payload.id]: snapshot };
}

/**
 * Apply a progress frame. Unknown / ownership-mismatched ids are ignored.
 */
export function applySubagentProgress(
	current: SubagentSnapshotMap,
	payload: SubagentProgressPayload,
	nowMs: number = Date.now(),
): SubagentSnapshotMap {
	const progress = payload.progress;
	const existing = current[progress.id];
	if (!existing) {
		return current;
	}
	if (!hasSameOwner(payload, existing)) {
		return current;
	}

	const sessionFile = payload.sessionFile ?? existing.sessionFile;
	const snapshot: RpcSubagentSnapshot = {
		id: progress.id,
		index: payload.index,
		agent: payload.agent,
		agentSource: payload.agentSource,
		description: progress.description ?? existing.description,
		status: progress.status,
		task: payload.task,
		assignment: payload.assignment,
		sessionFile,
		lastUpdate: nowMs,
		parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
		progress,
	};

	return { ...current, [progress.id]: snapshot };
}

/**
 * Event frames are for optional live transcript streaming — they must not
 * mutate the snapshot map and must never be treated as parent agent_end.
 */
export function applySubagentEvent(
	current: SubagentSnapshotMap,
	_payload: SubagentEventPayload,
): SubagentSnapshotMap {
	return current;
}

export type SubagentClientFrame =
	| { readonly type: "subagent_lifecycle"; readonly payload: SubagentLifecyclePayload }
	| { readonly type: "subagent_progress"; readonly payload: SubagentProgressPayload }
	| { readonly type: "subagent_event"; readonly payload: SubagentEventPayload };

/**
 * Apply a subagent SSE frame to the snapshot map.
 * Returns the same reference when nothing changes.
 */
export function applySubagentFrame(
	current: SubagentSnapshotMap,
	frame: SubagentClientFrame,
	nowMs: number = Date.now(),
): SubagentSnapshotMap {
	switch (frame.type) {
		case "subagent_lifecycle":
			return applySubagentLifecycle(current, frame.payload, nowMs);
		case "subagent_progress":
			return applySubagentProgress(current, frame.payload, nowMs);
		case "subagent_event":
			return applySubagentEvent(current, frame.payload);
		default: {
			const _exhaustive: never = frame;
			return _exhaustive;
		}
	}
}

/**
 * Guard for applying a frame under a session-scoped generation.
 * Stale reconnect responses and cross-session frames are discarded.
 */
export function shouldAcceptSubagentUpdate(input: {
	readonly scope: SubagentClientScope;
	readonly generation: number;
	readonly sessionId?: string | null;
}): boolean {
	if (!isCurrentSubagentGeneration(input.scope, input.generation)) {
		return false;
	}
	if (input.sessionId === undefined) {
		return true;
	}
	return input.scope.sessionId === input.sessionId;
}

export function selectSubagent(
	state: SubagentClientState,
	subagentId: string | null,
): SubagentClientState {
	if (subagentId !== null && state.subagents[subagentId] === undefined) {
		return { ...state, selectedSubagentId: null };
	}
	return { ...state, selectedSubagentId: subagentId };
}

/** Sorted list for panel rendering (index then id). */
export function listSubagentSnapshots(
	map: SubagentSnapshotMap,
): RpcSubagentSnapshot[] {
	return Object.values(map).sort(
		(a, b) => a.index - b.index || a.id.localeCompare(b.id),
	);
}

/**
 * Stable client id for a cold-history row.
 * Nested agents use `parent/agentId` so siblings with the same basename do not collide.
 */
export function coldHistoryRowId(row: SubagentHistoryRow): string {
	return row.parent ? `${row.parent}/${row.agentId}` : row.agentId;
}

function historyStatusToSnapshot(
	status: SubagentHistoryStatus,
): RpcSubagentSnapshot["status"] {
	switch (status) {
		case "pending":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
			return status;
		case "unknown":
			return "completed";
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

/**
 * Merge cold history rows into the live client map.
 * Match by sessionFile, then agentId/cold id. Live rows win; cold-only fill gaps.
 */
export function mergeColdHistory(
	current: SubagentSnapshotMap,
	coldRows: readonly SubagentHistoryRow[],
): SubagentSnapshotMap {
	if (coldRows.length === 0) {
		return current;
	}

	const next: Record<string, RpcSubagentSnapshot> = { ...current };
	const idBySessionFile = new Map<string, string>();
	for (const [id, snapshot] of Object.entries(next)) {
		if (snapshot.sessionFile) {
			idBySessionFile.set(snapshot.sessionFile, id);
		}
	}

	let coldIndex = 10_000;
	for (const row of coldRows) {
		const coldId = coldHistoryRowId(row);
		const existingId =
			idBySessionFile.get(row.sessionFile)
			?? (next[row.agentId] !== undefined ? row.agentId : undefined)
			?? (next[coldId] !== undefined ? coldId : undefined);

		if (existingId !== undefined) {
			const existing = next[existingId];
			if (existing && !existing.sessionFile && row.sessionFile) {
				next[existingId] = { ...existing, sessionFile: row.sessionFile };
				idBySessionFile.set(row.sessionFile, existingId);
			}
			continue;
		}

		const agentType = row.agent?.trim() || row.agentId;
		let description =
			row.description?.trim()
			|| row.task?.trim()
			|| (row.parent ? `History · ${row.parent}` : "History");
		if (row.agent && row.agent !== row.agentId && !row.description) {
			description = row.task?.trim()
				? `${row.agentId} · ${row.task.trim()}`
				: row.agentId;
		}
		next[coldId] = {
			id: coldId,
			index: coldIndex,
			agent: agentType,
			agentSource: (row.agentSource as RpcSubagentSnapshot["agentSource"]) ?? "bundled",
			description,
			task: row.task,
			status: historyStatusToSnapshot(row.status),
			sessionFile: row.sessionFile,
			lastUpdate: 0,
		};
		idBySessionFile.set(row.sessionFile, coldId);
		coldIndex += 1;
	}

	return next;
}

function hasSameOwner(
	payload: Pick<
		SubagentLifecyclePayload | SubagentProgressPayload,
		"parentToolCallId" | "sessionFile"
	>,
	snapshot: RpcSubagentSnapshot,
): boolean {
	if (
		payload.parentToolCallId !== undefined
		&& snapshot.parentToolCallId !== undefined
	) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (
		payload.sessionFile !== undefined
		&& snapshot.sessionFile !== undefined
	) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

/** Hint from a task tool card when focusing the SubAgent panel. */
export type SubagentFocusHint = {
	readonly toolCallId: string;
	readonly sessionFiles?: readonly string[];
	readonly agentIds?: readonly string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extract correlation ids from Task tool result details (TaskToolDetails shape).
 * Uses results[].id / progress[].id and any sessionFile fields present.
 */
export function extractTaskResultFocusIds(details: unknown): {
	sessionFiles: string[];
	agentIds: string[];
} {
	const sessionFiles: string[] = [];
	const agentIds: string[] = [];
	if (!isRecord(details)) {
		return { sessionFiles, agentIds };
	}

	const pushSession = (value: unknown) => {
		if (typeof value === "string" && value.length > 0) {
			sessionFiles.push(value);
		}
	};
	const pushAgent = (value: unknown) => {
		if (typeof value === "string" && value.length > 0) {
			agentIds.push(value);
		}
	};

	pushSession(details.sessionFile);

	const collectRow = (row: unknown) => {
		if (!isRecord(row)) return;
		pushSession(row.sessionFile);
		pushAgent(row.id);
	};

	if (Array.isArray(details.results)) {
		for (const row of details.results) collectRow(row);
	}
	if (Array.isArray(details.progress)) {
		for (const row of details.progress) collectRow(row);
	}

	return { sessionFiles, agentIds };
}

/**
 * Resolve which subagent id to select for a task card open action.
 * Order: live parentToolCallId → sessionFile → agentId → first row.
 */
export function resolveSubagentFocusId(
	subagents: readonly Pick<
		RpcSubagentSnapshot,
		"id" | "parentToolCallId" | "sessionFile" | "agent"
	>[],
	hint: SubagentFocusHint,
): string | null {
	const byParent = subagents.find(
		(s) => s.parentToolCallId === hint.toolCallId,
	);
	if (byParent) return byParent.id;

	for (const sessionFile of hint.sessionFiles ?? []) {
		const match = subagents.find((s) => s.sessionFile === sessionFile);
		if (match) return match.id;
	}

	for (const agentId of hint.agentIds ?? []) {
		const match = subagents.find(
			(s) =>
				s.id === agentId
				|| s.agent === agentId
				|| s.id.endsWith(`/${agentId}`),
		);
		if (match) return match.id;
	}

	return subagents[0]?.id ?? null;
}
