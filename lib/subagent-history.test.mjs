/**
 * Todo 1 — containment-aware history walker unit tests.
 * Run: bun test lib/subagent-history.test.mjs
 */
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { listSubagentHistory } = await jiti.import("./subagent-history.ts");
const { SUBAGENT_TRANSCRIPT_MAX_BYTES, isRpcSubagentSubscriptionLevel } =
	await jiti.import("./subagent-types.ts");

function sessionLine(id) {
	return `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\n`;
}

function messageLine(id, parentId, role = "user") {
	return `{"type":"message","id":"${id}","parentId":${parentId === null ? "null" : `"${parentId}"`},"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"${role}","content":"hi","stopReason":"end"}}\n`;
}

function makeTree(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-subhist-${label}-`));
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const parentSessionFile = join(sessionsDir, "parent.jsonl");
	writeFileSync(parentSessionFile, sessionLine("parent-id"), "utf8");
	return { root, sessionsDir, parentSessionFile };
}

test("SUBAGENT_TRANSCRIPT_MAX_BYTES is 1 MiB", () => {
	assert.equal(SUBAGENT_TRANSCRIPT_MAX_BYTES, 1_048_576);
});

test("isRpcSubagentSubscriptionLevel validates enum", () => {
	assert.equal(isRpcSubagentSubscriptionLevel("off"), true);
	assert.equal(isRpcSubagentSubscriptionLevel("progress"), true);
	assert.equal(isRpcSubagentSubscriptionLevel("events"), true);
	assert.equal(isRpcSubagentSubscriptionLevel("debug"), false);
	assert.equal(isRpcSubagentSubscriptionLevel(null), false);
});

test("missing artifacts root returns empty array", () => {
	const tree = makeTree("no-root");
	try {
		// parent.jsonl exists but parent/ dir does not
		const rows = listSubagentHistory(tree.parentSessionFile);
		assert.deepEqual(rows, []);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("lists nested candidates under artifacts root with metadata", () => {
	const tree = makeTree("nested");
	try {
		const artifactsDir = join(tree.sessionsDir, "parent");
		mkdirSync(join(artifactsDir, "ChildA"), { recursive: true });
		const childFile = join(artifactsDir, "ChildA.jsonl");
		const nestedFile = join(artifactsDir, "ChildA", "Helper.jsonl");
		writeFileSync(
			childFile,
			sessionLine("child-a") + messageLine("m1", null, "user") + messageLine("m2", "m1", "assistant"),
			"utf8",
		);
		writeFileSync(
			nestedFile,
			sessionLine("helper") + messageLine("h1", null, "assistant"),
			"utf8",
		);

		const opened = [];
		const rows = listSubagentHistory(tree.parentSessionFile, {
			onOpen: (p) => opened.push(p),
		});

		assert.equal(rows.length, 2);
		const byAgent = Object.fromEntries(rows.map((r) => [r.agentId, r]));
		assert.ok(byAgent.ChildA);
		assert.ok(byAgent.Helper);
		assert.equal(byAgent.ChildA.parent, null);
		assert.equal(byAgent.Helper.parent, "ChildA");
		assert.equal(byAgent.ChildA.sessionFile, childFile);
		assert.equal(byAgent.Helper.sessionFile, nestedFile);
		assert.equal(byAgent.ChildA.leafId, "m2");
		assert.equal(byAgent.Helper.leafId, "h1");
		assert.ok(
			byAgent.ChildA.status === "completed" ||
				byAgent.ChildA.status === "unknown",
		);
		assert.equal(opened.length, 2);
		assert.ok(opened.every((p) => p.startsWith(artifactsDir)));
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("never opens files outside artifacts root (sibling + symlink escape)", () => {
	const tree = makeTree("no-escape");
	try {
		const artifactsDir = join(tree.sessionsDir, "parent");
		mkdirSync(artifactsDir, { recursive: true });

		const allowed = join(artifactsDir, "Ok.jsonl");
		writeFileSync(allowed, sessionLine("ok") + messageLine("a1", null), "utf8");

		// Sibling next to parent session — must not be walked/opened
		const sibling = join(tree.sessionsDir, "sibling.jsonl");
		writeFileSync(sibling, sessionLine("sibling-secret") + '{"poison":true}\n', "utf8");

		// Outside file + symlink under artifacts that points outside
		const outsideDir = join(tree.root, "outside");
		mkdirSync(outsideDir, { recursive: true });
		const outsideFile = join(outsideDir, "escape.jsonl");
		writeFileSync(outsideFile, sessionLine("escape-secret") + '{"poison":true}\n', "utf8");
		const badLink = join(artifactsDir, "Linked.jsonl");
		symlinkSync(outsideFile, badLink);

		const opened = [];
		const rows = listSubagentHistory(tree.parentSessionFile, {
			onOpen: (p) => opened.push(p),
		});

		assert.equal(rows.length, 1);
		assert.equal(rows[0].agentId, "Ok");
		assert.deepEqual(opened, [allowed]);
		assert.ok(!opened.includes(sibling));
		assert.ok(!opened.includes(outsideFile));
		assert.ok(!opened.includes(badLink));
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("skips .bak jsonl files", () => {
	const tree = makeTree("bak");
	try {
		const artifactsDir = join(tree.sessionsDir, "parent");
		mkdirSync(artifactsDir, { recursive: true });
		writeFileSync(
			join(artifactsDir, "Good.jsonl"),
			sessionLine("good") + messageLine("g1", null),
			"utf8",
		);
		writeFileSync(
			join(artifactsDir, "Good.jsonl.bak"),
			sessionLine("bak") + messageLine("b1", null),
			"utf8",
		);
		const rows = listSubagentHistory(tree.parentSessionFile);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].agentId, "Good");
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("recovers built-in agent type from parent task toolResult progress", () => {
	// Given — spawn label basename ≠ agent type; type lives in parent task details
	const tree = makeTree("agent-type");
	try {
		const artifactsDir = join(tree.sessionsDir, "parent");
		mkdirSync(artifactsDir, { recursive: true });
		const childFile = join(artifactsDir, "spawn-smoke-oracle.jsonl");
		writeFileSync(
			childFile,
			sessionLine("child-oracle")
				+ messageLine("m1", null, "user")
				+ messageLine("m2", "m1", "assistant"),
			"utf8",
		);
		const parentBody =
			sessionLine("parent-id")
			+ JSON.stringify({
				type: "message",
				id: "tr1",
				parentId: null,
				timestamp: "2026-01-01T00:00:02.000Z",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "task",
					content: [{ type: "text", text: "spawned" }],
					details: {
						progress: [
							{
								index: 0,
								id: "spawn-smoke-oracle",
								agent: "oracle",
								agentSource: "user",
								status: "completed",
								task: "Reply with pong",
								assignment: "Reply with pong",
							},
						],
						results: [],
					},
					isError: false,
				},
			})
			+ "\n";
		writeFileSync(tree.parentSessionFile, parentBody, "utf8");

		// When
		const rows = listSubagentHistory(tree.parentSessionFile);

		// Then
		assert.equal(rows.length, 1);
		assert.equal(rows[0].agentId, "spawn-smoke-oracle");
		assert.equal(rows[0].agent, "oracle");
		assert.equal(rows[0].agentSource, "user");
		assert.equal(rows[0].task, "Reply with pong");
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("recovers agent type from child session_init ROLE header when parent lacks task meta", () => {
	const tree = makeTree("role-header");
	try {
		const artifactsDir = join(tree.sessionsDir, "parent");
		mkdirSync(artifactsDir, { recursive: true });
		const childFile = join(artifactsDir, "job-abc.jsonl");
		const init = {
			type: "session_init",
			id: "si1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			systemPrompt: "ROLE\nYou are **Reviewer** — code review only.\n",
			task: "Review the diff",
			tools: ["read"],
		};
		writeFileSync(
			childFile,
			sessionLine("child-rev")
				+ JSON.stringify(init)
				+ "\n"
				+ messageLine("m1", "si1", "assistant"),
			"utf8",
		);

		const rows = listSubagentHistory(tree.parentSessionFile);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].agentId, "job-abc");
		assert.equal(rows[0].agent, "reviewer");
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});
