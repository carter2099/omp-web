/**
 * SubAgent DTO / SSE frame types for pi-web.
 * Snapshot and frame field names stay aligned with OMP `modes/rpc/rpc-types`.
 */

import type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

/** Max bytes returned by one `get_subagent_messages` page (1 MiB). */
export const SUBAGENT_TRANSCRIPT_MAX_BYTES = 1_048_576;

export type {
	RpcSubagentEventFrame,
	RpcSubagentFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
};

export const RPC_SUBAGENT_SUBSCRIPTION_LEVELS = ["off", "progress", "events"] as const;

export function isRpcSubagentSubscriptionLevel(
	value: unknown,
): value is RpcSubagentSubscriptionLevel {
	return (
		value === "off" ||
		value === "progress" ||
		value === "events"
	);
}

/** Cold-history list row (minimal metadata only — never full entries). */
export type SubagentHistoryStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "aborted"
	| "unknown";

export interface SubagentHistoryRow {
	/** Agent id segment from the `.jsonl` basename (no extension). */
	agentId: string;
	/** Slash-joined parent key relative to the parent session, or null for top-level. */
	parent: string | null;
	/** Absolute realpath of the subagent session file. */
	sessionFile: string;
	/** Last entry id if discoverable from a light scan; null when unknown. */
	leafId: string | null;
	/** Best-effort status from header / early lines. */
	status: SubagentHistoryStatus;
	/** Agent type (oracle/reviewer/scout/…), not spawn label (`agentId`). */
	agent?: string;
	agentSource?: string;
	task?: string;
	description?: string;
	model?: string;
}

export interface SubagentHistoryListResponse {
	subagents: SubagentHistoryRow[];
}

/**
 * Bounded transcript page for `get_subagent_messages`.
 * Clients page with `fromByte = nextByte` until `eof === true`.
 */
export interface SubagentMessagesPage {
	nextByte: number;
	eof: boolean;
	/** UTF-8 transcript slice (complete lines preferred by the reader). */
	content: string;
	sessionFile?: string;
	fromByte?: number;
	reset?: boolean;
}

/** Typed command / path / transcript errors mapped to HTTP status by the route layer. */
export class SubagentCommandError extends Error {
	readonly statusCode: number;

	constructor(message: string, statusCode: number) {
		super(message);
		this.name = "SubagentCommandError";
		this.statusCode = statusCode;
	}
}

export function isSubagentCommandError(error: unknown): error is SubagentCommandError {
	return error instanceof SubagentCommandError;
}
