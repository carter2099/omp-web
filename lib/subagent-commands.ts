/**
 * Agent command handlers for SubAgent registry / transcript / history.
 * Path auth always goes through assertSubagentSessionFileAllowed — never
 * collectSubSessions, never resolveSessionFile alone.
 */

import type { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { listSubagentHistory } from "./subagent-history";
import { assertSubagentSessionFileAllowed } from "./subagent-path";
import { readSubagentTranscriptPage } from "./subagent-transcript";
import {
	isRpcSubagentSubscriptionLevel,
	SubagentCommandError,
	type SubagentHistoryRow,
	type SubagentMessagesPage,
	type RpcSubagentSubscriptionLevel,
} from "./subagent-types";

export type SubagentRegistryLike = Pick<
	RpcSubagentRegistry,
	| "setSubscriptionLevel"
	| "getSubscriptionLevel"
	| "getSubagents"
	| "resolveSessionFile"
	| "dispose"
>;

export function setSubagentSubscription(
	registry: SubagentRegistryLike,
	level: unknown,
): { level: RpcSubagentSubscriptionLevel } {
	if (!isRpcSubagentSubscriptionLevel(level)) {
		throw new SubagentCommandError(
			`Invalid subagent subscription level: ${String(level)}`,
			400,
		);
	}
	registry.setSubscriptionLevel(level);
	return { level: registry.getSubscriptionLevel() };
}

export function getSubagents(
	registry: SubagentRegistryLike,
): { subagents: RpcSubagentSnapshot[] } {
	return { subagents: registry.getSubagents() };
}

/**
 * Resolve a transcript path for get_subagent_messages.
 * Prefer registry resolution when the subagent is known/live; always assert
 * containment under the parent artifacts root before any read.
 */
export function resolveAndAssertSubagentSessionFile(
	registry: SubagentRegistryLike,
	parentSessionFile: string,
	selector: { subagentId?: unknown; sessionFile?: unknown },
): string {
	const subagentId =
		typeof selector.subagentId === "string" && selector.subagentId.length > 0
			? selector.subagentId
			: undefined;
	const sessionFile =
		typeof selector.sessionFile === "string" && selector.sessionFile.length > 0
			? selector.sessionFile
			: undefined;

	if (!subagentId && !sessionFile) {
		throw new SubagentCommandError(
			"get_subagent_messages requires subagentId or sessionFile",
			400,
		);
	}

	let candidate: string;
	try {
		if (subagentId) {
			candidate = registry.resolveSessionFile({ subagentId });
		} else {
			// Prefer registry when live; fall back to path-assert for cold history.
			try {
				candidate = registry.resolveSessionFile({ sessionFile });
			} catch {
				candidate = sessionFile as string;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (
			message.includes("Unknown subagent") ||
			message.includes("session file unavailable") ||
			message.includes("Unknown subagent session file")
		) {
			throw new SubagentCommandError(message, 404);
		}
		if (message.includes("requires subagentId or sessionFile")) {
			throw new SubagentCommandError(message, 400);
		}
		throw new SubagentCommandError(message, 500);
	}

	return assertSubagentSessionFileAllowed(parentSessionFile, candidate);
}

export function getSubagentMessages(
	registry: SubagentRegistryLike,
	parentSessionFile: string,
	command: Record<string, unknown>,
): SubagentMessagesPage {
	const allowed = resolveAndAssertSubagentSessionFile(registry, parentSessionFile, {
		subagentId: command.subagentId,
		sessionFile: command.sessionFile,
	});
	return readSubagentTranscriptPage(allowed, command.fromByte);
}

export function listSubagentHistoryCommand(
	parentSessionFile: string,
): { subagents: SubagentHistoryRow[] } {
	if (typeof parentSessionFile !== "string" || parentSessionFile.length === 0) {
		throw new SubagentCommandError("Parent session file is unavailable", 404);
	}
	return { subagents: listSubagentHistory(parentSessionFile) };
}
