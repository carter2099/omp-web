export type TaskEager = "default" | "preferred" | "always";

export const TASK_EAGER_VALUES: readonly TaskEager[] = ["default", "preferred", "always"] as const;

export function isTaskEager(value: unknown): value is TaskEager {
	return value === "default" || value === "preferred" || value === "always";
}

export function normalizeTaskEager(value: unknown): TaskEager {
	return isTaskEager(value) ? value : "default";
}

export function taskEagerShortLabel(value: TaskEager): string {
	switch (value) {
		case "preferred":
			return "Preferred";
		case "always":
			return "Always";
		default:
			return "Default";
	}
}

export function taskEagerTitle(value: TaskEager): string {
	switch (value) {
		case "preferred":
			return "Preferred";
		case "always":
			return "Always";
		default:
			return "Default";
	}
}

export function taskEagerDescription(value: TaskEager): string {
	switch (value) {
		case "preferred":
			return "System prompt encourages delegation";
		case "always":
			return "Force delegation guidance (eager-task)";
		default:
			return "Model decides delegation";
	}
}
