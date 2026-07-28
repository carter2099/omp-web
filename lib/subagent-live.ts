/**
 * Live vs terminal SubAgent status helpers for idle / running badges.
 * Non-terminal statuses count as live (Oracle lock).
 */

const TERMINAL_SUBAGENT_STATUSES = new Set([
	"completed",
	"failed",
	"aborted",
]);

export function isLiveSubagentStatus(status: string): boolean {
	return !TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function hasLiveSubagents(
	snapshots: readonly { readonly status: string }[],
): boolean {
	return snapshots.some((snapshot) => isLiveSubagentStatus(snapshot.status));
}
