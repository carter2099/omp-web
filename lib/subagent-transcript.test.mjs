import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	getSubagentMessages,
	resolveAndAssertSubagentSessionFile,
	setSubagentSubscription,
} from "./subagent-commands.ts";
import { assertSubagentSessionFileAllowed } from "./subagent-path.ts";
import {
	parseTranscriptFromByte,
	readSubagentTranscriptPage,
} from "./subagent-transcript.ts";
import {
	SUBAGENT_TRANSCRIPT_MAX_BYTES,
	SubagentCommandError,
} from "./subagent-types.ts";

test("parseTranscriptFromByte rejects NaN negative non-number", () => {
	assert.equal(parseTranscriptFromByte(undefined), 0);
	assert.equal(parseTranscriptFromByte(10), 10);
	assert.throws(
		() => parseTranscriptFromByte(-1),
		(err) => err instanceof SubagentCommandError && err.statusCode === 400,
	);
	assert.throws(
		() => parseTranscriptFromByte(Number.NaN),
		(err) => err instanceof SubagentCommandError && err.statusCode === 400,
	);
	assert.throws(
		() => parseTranscriptFromByte("3"),
		(err) => err instanceof SubagentCommandError && err.statusCode === 400,
	);
});

	test("single JSONL line larger than 1 MiB advances nextByte without stall", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "pi-web-sub-tx-long-"));
		const parent = path.join(dir, "parent.jsonl");
		writeFileSync(parent, '{"type":"session"}\n');
		const artifacts = parent.slice(0, -6);
		mkdirSync(artifacts, { recursive: true });
		const child = path.join(artifacts, "agent-long.jsonl");

		// One complete JSONL line larger than the 1 MiB page cap.
		const hugePayload = "x".repeat(SUBAGENT_TRANSCRIPT_MAX_BYTES + 200_000);
		const line = `${JSON.stringify({
			type: "message",
			id: "m-huge",
			message: { role: "user", content: hugePayload },
		})}\n`;
		writeFileSync(child, line);
		const totalSize = Buffer.byteLength(line, "utf8");
		assert.ok(totalSize > SUBAGENT_TRANSCRIPT_MAX_BYTES);

		try {
			const allowed = assertSubagentSessionFileAllowed(parent, child);
			const page1 = readSubagentTranscriptPage(allowed, 0);
			assert.equal(page1.eof, false);
			assert.ok(page1.nextByte > 0, "nextByte must advance on hard-cut page");
			assert.ok(page1.nextByte <= SUBAGENT_TRANSCRIPT_MAX_BYTES);
			// Mid-line hard cut has no complete newline → empty content is ok.
			assert.equal(page1.content.includes("\n") || page1.content === "", true);

			const page2 = readSubagentTranscriptPage(allowed, page1.nextByte);
			assert.ok(page2.nextByte > page1.nextByte);
			assert.notEqual(page2.nextByte, page1.nextByte);

			let cursor = page2.nextByte;
			let last = page2;
			let guard = 0;
			while (!last.eof && guard < 20) {
				const prev = cursor;
				last = readSubagentTranscriptPage(allowed, cursor);
				assert.ok(
					last.nextByte > prev || last.eof,
					"cursor must advance each non-eof page",
				);
				cursor = last.nextByte;
				guard += 1;
			}
			assert.equal(last.eof, true);
			assert.equal(last.nextByte, totalSize);
			assert.ok(guard < 20, "must not infinite-loop on long line");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("readSubagentTranscriptPage caps at 1 MiB and advances nextByte", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-web-sub-tx-"));
	const parent = path.join(dir, "parent.jsonl");
	writeFileSync(parent, '{"type":"session"}\n');
	const artifacts = parent.slice(0, -6);
	mkdirSync(artifacts, { recursive: true });
	const child = path.join(artifacts, "agent-a.jsonl");

	const line = `${JSON.stringify({
		type: "message",
		id: "m1",
		message: { role: "user", content: "x".repeat(64) },
	})}\n`;
	const target = SUBAGENT_TRANSCRIPT_MAX_BYTES + 50_000;
	let body = "";
	while (Buffer.byteLength(body, "utf8") < target) {
		body += line;
	}
	writeFileSync(child, body);

	try {
		const allowed = assertSubagentSessionFileAllowed(parent, child);
		const page = readSubagentTranscriptPage(allowed, 0);
		assert.equal(page.eof, false);
		assert.ok(page.nextByte > 0);
		assert.ok(Buffer.byteLength(page.content, "utf8") <= SUBAGENT_TRANSCRIPT_MAX_BYTES);
		assert.ok(page.content.endsWith("\n"));

		let cursor = page.nextByte;
		let last = page;
		let guard = 0;
		while (!last.eof && guard < 50) {
			last = readSubagentTranscriptPage(allowed, cursor);
			cursor = last.nextByte;
			guard += 1;
		}
		assert.equal(last.eof, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setSubagentSubscription rejects invalid level with 400", () => {
	const registry = {
		setSubscriptionLevel() {},
		getSubscriptionLevel() {
			return "progress";
		},
		getSubagents() {
			return [];
		},
		resolveSessionFile() {
			return "/x";
		},
		dispose() {},
	};
	assert.throws(
		() => setSubagentSubscription(registry, "nope"),
		(err) => err instanceof SubagentCommandError && err.statusCode === 400,
	);
	assert.deepEqual(setSubagentSubscription(registry, "progress"), {
		level: "progress",
	});
});

test("get_subagent_messages path escape is 400 after resolve", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-web-sub-cmd-"));
	const parent = path.join(dir, "parent.jsonl");
	writeFileSync(parent, "{}\n");
	const outside = path.join(dir, "escape.jsonl");
	writeFileSync(outside, "{}\n");

	const registry = {
		setSubscriptionLevel() {},
		getSubscriptionLevel() {
			return "progress";
		},
		getSubagents() {
			return [];
		},
		resolveSessionFile() {
			return outside;
		},
		dispose() {},
	};

	try {
		assert.throws(
			() =>
				getSubagentMessages(registry, parent, {
					subagentId: "evil",
					fromByte: 0,
				}),
			(err) => err instanceof SubagentCommandError && err.statusCode === 400,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("resolveAndAssert prefers registry then always asserts", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-web-sub-res-"));
	const parent = path.join(dir, "parent.jsonl");
	writeFileSync(parent, "{}\n");
	const artifacts = parent.slice(0, -6);
	mkdirSync(artifacts, { recursive: true });
	const child = path.join(artifacts, "ok.jsonl");
	writeFileSync(child, '{"type":"session"}\n');

	const registry = {
		setSubscriptionLevel() {},
		getSubscriptionLevel() {
			return "progress";
		},
		getSubagents() {
			return [];
		},
		resolveSessionFile(sel) {
			if (sel.subagentId === "ok") return child;
			throw new Error(`Unknown subagent or session file unavailable: ${sel.subagentId}`);
		},
		dispose() {},
	};

	try {
		const resolved = resolveAndAssertSubagentSessionFile(registry, parent, {
			subagentId: "ok",
		});
		assert.ok(resolved.endsWith("ok.jsonl"));

		assert.throws(
			() =>
				resolveAndAssertSubagentSessionFile(registry, parent, {
					subagentId: "missing",
				}),
			(err) => err instanceof SubagentCommandError && err.statusCode === 404,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
