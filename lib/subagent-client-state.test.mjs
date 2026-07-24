/**
 * Todo 4 — client SubAgent SSE state pure helpers.
 * Run: bun test lib/subagent-client-state.test.mjs
 *
 * QA (a) merge keeps terminal when server omits
 *     (b) sessionId change clears map
 *     (c) stale generation discarded
 *     (d) connected sequence: set_subagent_subscription then get_subagents
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
			SUBAGENT_CONNECTED_COMMAND_SEQUENCE,
			applySubagentFrame,
			applySubagentLifecycle,
			bumpSubagentGeneration,
			clearSubagentStateForSessionChange,
			coldHistoryRowId,
			createSubagentClientState,
			extractTaskResultFocusIds,
			isCurrentSubagentGeneration,
			listSubagentSnapshots,
			mergeColdHistory,
			mergeGetSubagents,
			resolveSubagentFocusId,
			selectSubagent,
			shouldAcceptSubagentUpdate,
		} = await jiti.import("./subagent-client-state.ts");

function snapshot(overrides = {}) {
	return {
		id: "sub-1",
		index: 0,
		agent: "explore",
		agentSource: "builtin",
		status: "running",
		task: "probe",
		sessionFile: "/tmp/parent/sub-1.jsonl",
		parentToolCallId: "tc-1",
		lastUpdate: 1000,
		...overrides,
	};
}

test("(a) merge get_subagents keeps terminal row when server omits it", () => {
	const terminal = snapshot({
		id: "done-1",
		status: "completed",
		lastUpdate: 50,
	});
	const live = snapshot({
		id: "live-1",
		status: "running",
		index: 1,
		lastUpdate: 60,
	});
	const current = {
		[terminal.id]: terminal,
		[live.id]: live,
		"orphan-live": snapshot({ id: "orphan-live", status: "running", index: 2 }),
	};

	const serverOnly = [
		snapshot({
			id: "live-1",
			status: "running",
			index: 1,
			task: "updated",
			lastUpdate: 200,
		}),
		snapshot({
			id: "new-1",
			status: "running",
			index: 3,
			lastUpdate: 201,
		}),
	];

	const merged = mergeGetSubagents(current, serverOnly);

	// Terminal retained even though server omitted it
	assert.equal(merged["done-1"]?.status, "completed");
	assert.equal(merged["done-1"]?.lastUpdate, 50);

	// Server live overwrites
	assert.equal(merged["live-1"]?.task, "updated");
	assert.equal(merged["live-1"]?.lastUpdate, 200);

	// New server row present
	assert.ok(merged["new-1"]);

	// Non-terminal client-only row dropped (not on server)
	assert.equal(merged["orphan-live"], undefined);

	const listed = listSubagentSnapshots(merged);
	assert.deepEqual(
		listed.map((s) => s.id),
		["done-1", "live-1", "new-1"],
	);
});

test("(b) sessionId change clears map and selection", () => {
	const withRows = {
		...createSubagentClientState("session-a"),
		generation: 3,
		subagents: {
			"sub-1": snapshot({ status: "completed" }),
			"sub-2": snapshot({ id: "sub-2", status: "running", index: 1 }),
		},
		selectedSubagentId: "sub-1",
	};

	const cleared = clearSubagentStateForSessionChange(withRows, "session-b");
	assert.equal(cleared.sessionId, "session-b");
	assert.equal(cleared.generation, 4);
	assert.deepEqual(cleared.subagents, {});
	assert.equal(cleared.selectedSubagentId, null);

	// Same session id is a no-op
	const same = clearSubagentStateForSessionChange(withRows, "session-a");
	assert.equal(same, withRows);

	// Selection helper clears unknown ids
	const selected = selectSubagent(withRows, "missing");
	assert.equal(selected.selectedSubagentId, null);
});

test("(c) stale generation is discarded", () => {
	const state = bumpSubagentGeneration(
		createSubagentClientState("session-a"),
	);
	// generation is now 1
	assert.equal(state.generation, 1);
	assert.equal(isCurrentSubagentGeneration(state, 1), true);
	assert.equal(isCurrentSubagentGeneration(state, 0), false);

	assert.equal(
		shouldAcceptSubagentUpdate({
			scope: state,
			generation: 1,
			sessionId: "session-a",
		}),
		true,
	);
	assert.equal(
		shouldAcceptSubagentUpdate({
			scope: state,
			generation: 0,
			sessionId: "session-a",
		}),
		false,
	);
	assert.equal(
		shouldAcceptSubagentUpdate({
			scope: state,
			generation: 1,
			sessionId: "session-other",
		}),
		false,
	);

	// Lifecycle under stale gen would still produce a map if applied — callers
	// must gate with shouldAcceptSubagentUpdate first.
	const applied = applySubagentLifecycle(
		{},
		{
			id: "sub-1",
			index: 0,
			agent: "explore",
			agentSource: "builtin",
			status: "started",
			description: "probe",
			sessionFile: "/tmp/parent/sub-1.jsonl",
			parentToolCallId: "tc-1",
		},
		999,
	);
	assert.equal(applied["sub-1"]?.status, "running");
	assert.equal(applied["sub-1"]?.lastUpdate, 999);

	// Terminal lifecycle keeps the row (client retention — unlike server registry)
	const afterDone = applySubagentFrame(applied, {
		type: "subagent_lifecycle",
		payload: {
			id: "sub-1",
			index: 0,
			agent: "explore",
			agentSource: "builtin",
			status: "completed",
			sessionFile: "/tmp/parent/sub-1.jsonl",
			parentToolCallId: "tc-1",
		},
	}, 1000);
	assert.equal(afterDone["sub-1"]?.status, "completed");

	// Event frames do not mutate the map (and are not agent_end)
	const afterEvent = applySubagentFrame(afterDone, {
		type: "subagent_event",
		payload: { id: "sub-1", event: { type: "agent_end" } },
	});
	assert.equal(afterEvent, afterDone);
});

test("(d) connected handler sequence is set_subagent_subscription then get_subagents", () => {
	assert.equal(SUBAGENT_CONNECTED_COMMAND_SEQUENCE.length, 2);
	assert.equal(SUBAGENT_CONNECTED_COMMAND_SEQUENCE[0].type, "set_subagent_subscription");
	assert.equal(SUBAGENT_CONNECTED_COMMAND_SEQUENCE[0].level, "progress");
	assert.equal(SUBAGENT_CONNECTED_COMMAND_SEQUENCE[1].type, "get_subagents");

	// Documented order: subscribe before snapshot so frames after merge are not dropped
	const types = SUBAGENT_CONNECTED_COMMAND_SEQUENCE.map((c) => c.type);
	assert.deepEqual(types, ["set_subagent_subscription", "get_subagents"]);
});

test("(e) mergeColdHistory adds cold-only rows and keeps live authoritative", () => {
	const live = snapshot({
		id: "live-1",
		status: "running",
		sessionFile: "/tmp/parent/live-1.jsonl",
		lastUpdate: 500,
	});
	const liveNoPath = snapshot({
		id: "path-fill",
		status: "completed",
		sessionFile: undefined,
		lastUpdate: 400,
	});
	const current = {
		[live.id]: live,
		[liveNoPath.id]: liveNoPath,
	};

	const coldRows = [
		{
			agentId: "live-1",
			parent: null,
			sessionFile: "/tmp/parent/live-1.jsonl",
			leafId: "leaf-a",
			status: "completed",
		},
		{
			agentId: "path-fill",
			parent: null,
			sessionFile: "/tmp/parent/path-fill.jsonl",
			leafId: "leaf-b",
			status: "failed",
		},
		{
			agentId: "Helper",
			parent: "ParentA",
			sessionFile: "/tmp/parent/ParentA/Helper.jsonl",
			leafId: "leaf-c",
			status: "unknown",
		},
		{
			agentId: "parked",
			parent: null,
			sessionFile: "/tmp/parent/parked.jsonl",
			leafId: null,
			status: "completed",
		},
	];

	const merged = mergeColdHistory(current, coldRows);

	// Live running not overwritten by cold completed
	assert.equal(merged["live-1"]?.status, "running");
	assert.equal(merged["live-1"]?.lastUpdate, 500);

	// Missing sessionFile filled from cold match by agentId
	assert.equal(merged["path-fill"]?.sessionFile, "/tmp/parent/path-fill.jsonl");
	assert.equal(merged["path-fill"]?.status, "completed");

	// Nested cold-only id uses parent/agentId
	const nestedId = coldHistoryRowId(coldRows[2]);
	assert.equal(nestedId, "ParentA/Helper");
	assert.equal(merged[nestedId]?.status, "completed");
	assert.equal(merged[nestedId]?.sessionFile, "/tmp/parent/ParentA/Helper.jsonl");
	assert.equal(merged[nestedId]?.agent, "Helper");

	// Top-level cold-only parked row
	assert.equal(merged["parked"]?.status, "completed");
	assert.equal(merged["parked"]?.sessionFile, "/tmp/parent/parked.jsonl");
	assert.equal(merged["parked"]?.description, "历史");

	// Empty cold is identity
	assert.equal(mergeColdHistory(current, []), current);
});

test("mergeColdHistory prefers recovered agent type over spawn label agentId", () => {
	const coldRows = [
		{
			agentId: "spawn-smoke-oracle",
			parent: null,
			sessionFile: "/tmp/parent/spawn-smoke-oracle.jsonl",
			leafId: "leaf-o",
			status: "completed",
			agent: "oracle",
			agentSource: "user",
			task: "Reply with pong",
		},
		{
			agentId: "job-rev",
			parent: null,
			sessionFile: "/tmp/parent/job-rev.jsonl",
			leafId: "leaf-r",
			status: "completed",
			agent: "reviewer",
			agentSource: "bundled",
		},
	];

	const merged = mergeColdHistory({}, coldRows);
	assert.equal(merged["spawn-smoke-oracle"]?.agent, "oracle");
	assert.equal(merged["spawn-smoke-oracle"]?.agentSource, "user");
	assert.equal(merged["spawn-smoke-oracle"]?.task, "Reply with pong");
	assert.ok(
		String(merged["spawn-smoke-oracle"]?.description ?? "").includes("spawn-smoke-oracle")
			|| String(merged["spawn-smoke-oracle"]?.description ?? "").includes("pong"),
	);
	assert.equal(merged["job-rev"]?.agent, "reviewer");
});

test("resolveSubagentFocusId: live parentToolCallId then sessionFile/agentId then first", () => {
	const live = snapshot({
		id: "live-a",
		parentToolCallId: "tc-live",
		sessionFile: "/tmp/parent/live-a.jsonl",
	});
	const cold = snapshot({
		id: "cold-b",
		parentToolCallId: undefined,
		sessionFile: "/tmp/parent/cold-b.jsonl",
		agent: "explore",
		status: "completed",
	});
	const other = snapshot({
		id: "other-c",
		parentToolCallId: "tc-other",
		sessionFile: "/tmp/parent/other-c.jsonl",
		status: "completed",
	});
	const list = [other, live, cold];

	assert.equal(
		resolveSubagentFocusId(list, { toolCallId: "tc-live" }),
		"live-a",
	);
	assert.equal(
		resolveSubagentFocusId(list, {
			toolCallId: "tc-missing",
			sessionFiles: ["/tmp/parent/cold-b.jsonl"],
		}),
		"cold-b",
	);
	assert.equal(
		resolveSubagentFocusId(list, {
			toolCallId: "tc-missing",
			agentIds: ["cold-b"],
		}),
		"cold-b",
	);
	assert.equal(
		resolveSubagentFocusId(list, { toolCallId: "tc-missing" }),
		"other-c",
	);
	assert.equal(resolveSubagentFocusId([], { toolCallId: "tc-x" }), null);

	const extracted = extractTaskResultFocusIds({
		results: [
			{ id: "agent-1", sessionFile: "/tmp/parent/agent-1.jsonl" },
			{ id: "agent-2" },
		],
		progress: [{ id: "agent-3", sessionFile: "/tmp/parent/agent-3.jsonl" }],
	});
	assert.deepEqual(extracted.agentIds, ["agent-1", "agent-2", "agent-3"]);
	assert.deepEqual(extracted.sessionFiles, [
		"/tmp/parent/agent-1.jsonl",
		"/tmp/parent/agent-3.jsonl",
	]);
});
