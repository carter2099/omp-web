import path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getOmpRuntime } from "@/lib/omp-runtime";
import {
	isTaskEager,
	normalizeTaskEager,
	type TaskEager,
} from "@/lib/task-eager-shared";

export type { TaskEager } from "@/lib/task-eager-shared";
export {
	isTaskEager,
	normalizeTaskEager,
	taskEagerDescription,
	taskEagerShortLabel,
	taskEagerTitle,
	TASK_EAGER_VALUES,
} from "@/lib/task-eager-shared";

export async function getTaskEager(cwd?: string): Promise<TaskEager> {
	const runtime = await getOmpRuntime();
	const settings = await runtime.getSettingsForCwd(cwd ? path.resolve(cwd) : process.cwd());
	return normalizeTaskEager(settings.get("task.eager"));
}

export async function setTaskEager(value: TaskEager, cwd?: string): Promise<TaskEager> {
	if (!isTaskEager(value)) {
		throw new TaskEagerError(`invalid task.eager: ${String(value)}`, 400);
	}
	const runtime = await getOmpRuntime();
	const agentDir = runtime.agentDir;
	const resolvedCwd = cwd ? path.resolve(cwd) : process.cwd();
	const loadOpts = { cwd: resolvedCwd, agentDir };

	const writer = await Settings.loadIsolated(loadOpts);
	writer.set("task.eager", value);
	await writer.flush();
	await runtime.invalidateSettings();

	const verify = await Settings.loadIsolated(loadOpts);
	const next = normalizeTaskEager(verify.get("task.eager"));
	if (next !== value) {
		throw new TaskEagerError(`task.eager readback mismatch: want ${value}, got ${next}`, 500);
	}
	return next;
}

export class TaskEagerError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "TaskEagerError";
		this.status = status;
	}
}
