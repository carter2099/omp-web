import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseSubagentTranscriptDisplay,
	displayRoleLabel,
} from "./subagent-transcript-display.ts";

test("parseSubagentTranscriptDisplay skips session metadata and system init", () => {
	const jsonl = [
		JSON.stringify({ type: "title", title: "SysInfo" }),
		JSON.stringify({ type: "session", id: "abc", cwd: "/tmp" }),
		JSON.stringify({ type: "model_change", provider: "x", modelId: "y" }),
		JSON.stringify({
			type: "session_init",
			systemPrompt: "HUGE PROMPT SHOULD NOT APPEAR",
		}),
		JSON.stringify({
			type: "message",
			id: "m1",
			message: {
				role: "user",
				content: [{ type: "text", text: "列出系统信息" }],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m2",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "我来收集信息" },
					{
						type: "toolCall",
						name: "bash",
						arguments: { command: "uname -a" },
					},
				],
			},
		}),
		JSON.stringify({
			type: "message",
			id: "m3",
			message: {
				role: "toolResult",
				toolName: "bash",
				content: [{ type: "text", text: "Linux host 6.x" }],
			},
		}),
		JSON.stringify({ type: "custom", customType: "tree-sitter", data: {} }),
	].join("\n");

	const turns = parseSubagentTranscriptDisplay(jsonl);
	assert.equal(turns.length, 3);
	assert.equal(turns[0].role, "user");
	assert.equal(turns[0].text, "列出系统信息");
	assert.equal(turns[1].role, "assistant");
	assert.equal(turns[1].text, "我来收集信息");
	assert.equal(turns[1].toolCalls?.length, 1);
	assert.equal(turns[1].toolCalls?.[0].name, "bash");
	assert.equal(turns[2].role, "tool");
	assert.equal(turns[2].toolName, "bash");
	assert.match(turns[2].text, /Linux host/);
	assert.ok(!JSON.stringify(turns).includes("HUGE PROMPT"));
});

test("parseSubagentTranscriptDisplay truncates long tool output", () => {
	const long = "x".repeat(3000);
	const jsonl = JSON.stringify({
		type: "message",
		id: "t1",
		message: {
			role: "toolResult",
			toolName: "read",
			content: [{ type: "text", text: long }],
		},
	});
	const turns = parseSubagentTranscriptDisplay(jsonl);
	assert.equal(turns.length, 1);
	assert.ok(turns[0].text.length < long.length);
	assert.match(turns[0].text, /已截断/);
});

test("parseSubagentTranscriptDisplay ignores corrupt and incomplete lines", () => {
	const jsonl = [
		"{not json",
		JSON.stringify({
			type: "message",
			id: "ok",
			message: { role: "user", content: [{ type: "text", text: "hi" }] },
		}),
		'{"type":"message","message":{"role":"user"', // incomplete
	].join("\n");
	const turns = parseSubagentTranscriptDisplay(jsonl);
	assert.equal(turns.length, 1);
	assert.equal(turns[0].text, "hi");
});

test("displayRoleLabel uses Chinese labels", () => {
	assert.equal(displayRoleLabel("user"), "用户");
	assert.equal(displayRoleLabel("assistant"), "助手");
	assert.equal(displayRoleLabel("tool"), "工具");
});
