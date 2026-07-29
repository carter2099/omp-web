/**
 * Parse SubAgent session JSONL into chat-like display turns.
 * Skips session metadata / system prompts so the panel stays readable.
 */

export type SubagentDisplayRole = "user" | "assistant" | "tool" | "system";

export type SubagentDisplayTurn = {
	id: string;
	role: SubagentDisplayRole;
	/** Primary text shown in the bubble */
	text: string;
	/** Optional tool name (tool results / tool calls summary) */
	toolName?: string;
	/** Tool calls invoked by an assistant turn */
	toolCalls?: Array<{ name: string; summary?: string }>;
};

const SKIP_ENTRY_TYPES = new Set([
	"title",
	"session",
	"model_change",
	"thinking_level_change",
	"session_init",
	"compaction",
	"session_info",
	"custom",
]);

const TOOL_TEXT_MAX = 2_000;
const USER_ASSISTANT_MAX = 50_000;

function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n…...(truncated ${text.length - max} chars)`;
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const rec = asRecord(block);
		if (!rec) continue;
		if (rec.type === "text" && typeof rec.text === "string") {
			parts.push(rec.text);
		} else if (typeof rec.text === "string" && !rec.type) {
			parts.push(rec.text);
		}
	}
	return parts.join("\n").trim();
}

function extractToolCalls(
	content: unknown,
): Array<{ name: string; summary?: string }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ name: string; summary?: string }> = [];
	for (const block of content) {
		const rec = asRecord(block);
		if (!rec) continue;
		if (rec.type !== "toolCall" && rec.type !== "tool_use") continue;
		const name =
			(typeof rec.name === "string" && rec.name) ||
			(typeof rec.toolName === "string" && rec.toolName) ||
			"tool";
		let summary: string | undefined;
		const args = rec.arguments ?? rec.input ?? rec.args;
		if (typeof args === "string") {
			summary = args.slice(0, 120);
		} else if (args && typeof args === "object") {
			try {
				summary = JSON.stringify(args).slice(0, 120);
			} catch {
				summary = undefined;
			}
		}
		calls.push({ name, summary });
	}
	return calls;
}

function roleLabel(role: string): SubagentDisplayRole {
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	if (role === "toolResult" || role === "tool" || role === "function") return "tool";
	return "system";
}

/**
 * Convert raw JSONL transcript text into ordered display turns.
 * Incomplete trailing lines (no newline) are ignored until the next page arrives.
 */
export function parseSubagentTranscriptDisplay(jsonl: string): SubagentDisplayTurn[] {
	if (!jsonl) return [];
	const turns: SubagentDisplayTurn[] = [];
	const lines = jsonl.split("\n");
	let index = 0;

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			// Incomplete or corrupt line — skip
			continue;
		}
		const rec = asRecord(entry);
		if (!rec) continue;

		const type = typeof rec.type === "string" ? rec.type : "";
		if (SKIP_ENTRY_TYPES.has(type)) continue;

		// Prefer nested message envelope: { type:"message", message:{ role, content } }
		const nested = asRecord(rec.message);
		const msg = nested ?? (typeof rec.role === "string" ? rec : null);
		if (!msg) continue;

		const roleRaw = typeof msg.role === "string" ? msg.role : "";
		if (!roleRaw) continue;

		const role = roleLabel(roleRaw);
		if (role === "system") continue;

		const entryId =
			(typeof rec.id === "string" && rec.id) ||
			(typeof msg.id === "string" && msg.id) ||
			`turn-${index}`;
		index += 1;

		if (role === "tool") {
			const toolName =
				(typeof msg.toolName === "string" && msg.toolName) ||
				(typeof msg.name === "string" && msg.name) ||
				"tool";
			const text = truncate(extractTextFromContent(msg.content), TOOL_TEXT_MAX);
			turns.push({
				id: entryId,
				role: "tool",
				toolName,
				text: text || "(no output)",
			});
			continue;
		}

		const text = truncate(extractTextFromContent(msg.content), USER_ASSISTANT_MAX);
		const toolCalls = role === "assistant" ? extractToolCalls(msg.content) : undefined;

		// Skip empty assistant turns that only have toolCalls with no text — still show toolCalls
		if (!text && (!toolCalls || toolCalls.length === 0)) continue;

		turns.push({
			id: entryId,
			role,
			text: text || (toolCalls && toolCalls.length > 0 ? "" : "(empty)"),
			toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
		});
	}

	return turns;
}

export function displayRoleLabel(role: SubagentDisplayRole): string {
	switch (role) {
		case "user":
			return "User";
		case "assistant":
			return "Assistant";
		case "tool":
			return "Tool";
		default:
			return "System";
	}
}
