/**
 * Real OMP EventBus + RpcSubagentRegistry bridge tests (Todo 3 mandatory).
 * Asserts SSE-shaped frames, subscription filtering, dispose clears handlers.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { RpcSubagentRegistry } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { hasLiveSubagents, isLiveSubagentStatus } from "./subagent-live.ts";
import { createIdleTimer } from "./session-idle-timer.ts";

function baseLifecycle(overrides = {}) {
	return {
		id: "sub-1",
		index: 0,
		agent: "explore",
		agentSource: "builtin",
		status: "started",
		description: "probe",
		sessionFile: "/tmp/parent/sub-1.jsonl",
		parentToolCallId: "tc-1",
		...overrides,
	};
}

function baseProgress(overrides = {}) {
	return {
		id: "sub-1",
		index: 0,
		agent: "explore",
		agentSource: "builtin",
		task: "do work",
		sessionFile: "/tmp/parent/sub-1.jsonl",
		parentToolCallId: "tc-1",
		progress: {
			id: "sub-1",
			agent: "explore",
			agentSource: "builtin",
			description: "probe",
			status: "running",
			...overrides.progress,
		},
		...overrides,
	};
}

test("EventBus lifecycle/progress emit SSE-shaped frames at progress level", () => {
	const bus = new EventBus();
	const frames = [];
	const registry = new RpcSubagentRegistry(bus, (frame) => frames.push(frame));
	registry.setSubscriptionLevel("progress");

	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle());
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, baseProgress());
	// events level only
	bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
		id: "sub-1",
		event: { type: "message_update" },
	});

	assert.equal(frames.length, 2);
	assert.equal(frames[0].type, "subagent_lifecycle");
	assert.equal(frames[0].payload.id, "sub-1");
	assert.equal(frames[0].payload.parentToolCallId, "tc-1");
	assert.equal(frames[1].type, "subagent_progress");
	assert.equal(frames[1].payload.progress.status, "running");

	const snaps = registry.getSubagents();
	assert.equal(snaps.length, 1);
	assert.equal(snaps[0].status, "running");
	assert.equal(true, hasLiveSubagents(snaps));

	registry.dispose();
});

test("subscription off filters all frames; events level includes raw events", () => {
	const bus = new EventBus();
	const frames = [];
	const registry = new RpcSubagentRegistry(bus, (frame) => frames.push(frame));

	registry.setSubscriptionLevel("off");
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle());
	assert.equal(frames.length, 0);
	// snapshot still tracked while live
	assert.equal(registry.getSubagents().length, 1);

	registry.setSubscriptionLevel("events");
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, baseProgress());
	bus.emit(TASK_SUBAGENT_EVENT_CHANNEL, {
		id: "sub-1",
		event: { type: "agent_end" },
	});

	assert.equal(frames.some((f) => f.type === "subagent_progress"), true);
	assert.equal(frames.some((f) => f.type === "subagent_event"), true);

	registry.dispose();
});

test("registry at progress with SSE-off pattern: snapshots update without client frames", () => {
	// Simulates pi-web dual-level: registry always progress, client SSE gated off.
	const bus = new EventBus();
	const frames = [];
	let sseLevel = "off";
	const registry = new RpcSubagentRegistry(bus, (frame) => {
		// Server-side always receives registry frames at progress.
		if (sseLevel !== "off") frames.push(frame);
	});
	registry.setSubscriptionLevel("progress");

	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle());
	assert.equal(registry.getSubagents().length, 1);
	assert.equal(hasLiveSubagents(registry.getSubagents()), true);
	assert.equal(frames.length, 0, "SSE off suppresses client frames");

	sseLevel = "progress";
	bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, baseProgress());
	assert.equal(frames.some((f) => f.type === "subagent_progress"), true);

	registry.dispose();
});

test("dispose removes bus handlers so later emits produce no frames", () => {
	const bus = new EventBus();
	const frames = [];
	const registry = new RpcSubagentRegistry(bus, (frame) => frames.push(frame));
	registry.setSubscriptionLevel("progress");

	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle());
	assert.equal(frames.length, 1);

	registry.dispose();
	frames.length = 0;
	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle({ id: "sub-2" }));
	assert.equal(frames.length, 0);
	assert.equal(registry.getSubagents().length, 0);
});

test("terminal lifecycle removes snapshot from live set", () => {
	const bus = new EventBus();
	const registry = new RpcSubagentRegistry(bus, () => {});
	registry.setSubscriptionLevel("progress");

	bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, baseLifecycle());
	assert.equal(hasLiveSubagents(registry.getSubagents()), true);

	bus.emit(
		TASK_SUBAGENT_LIFECYCLE_CHANNEL,
		baseLifecycle({ status: "completed" }),
	);
	assert.equal(registry.getSubagents().length, 0);
	assert.equal(hasLiveSubagents(registry.getSubagents()), false);

	registry.dispose();
});

test("isLiveSubagentStatus treats non-terminal as live", () => {
	assert.equal(isLiveSubagentStatus("running"), true);
	assert.equal(isLiveSubagentStatus("pending"), true);
	assert.equal(isLiveSubagentStatus("completed"), false);
	assert.equal(isLiveSubagentStatus("failed"), false);
	assert.equal(isLiveSubagentStatus("aborted"), false);
});

test("idle timer does not destroy while live subagent keeps isRunning true", async () => {
	// Given: fake timers + parent idle + live child
	const timers = [];
	const setTimeoutFn = (fn, ms) => {
		const id = { fn, ms, cleared: false };
		timers.push(id);
		return id;
	};
	const clearTimeoutFn = (id) => {
		id.cleared = true;
	};

	let live = true;
	let destroyed = false;
	const timer = createIdleTimer({
		idleMs: 1000,
		isRunning: () => live,
		onIdle: () => {
			destroyed = true;
		},
		setTimeoutFn,
		clearTimeoutFn,
	});

	timer.reset();
	assert.equal(timers.length, 1);

	// When: idle fires while child is live → reschedule, do not destroy
	timers[0].fn();
	assert.equal(destroyed, false);
	assert.equal(timers.length, 2);

	// When: child becomes terminal and idle fires again → destroy
	live = false;
	timers[timers.length - 1].fn();
	assert.equal(destroyed, true);
});
