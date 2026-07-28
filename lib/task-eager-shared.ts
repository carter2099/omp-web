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
			return "倾向";
		case "always":
			return "总是";
		default:
			return "默认";
	}
}

export function taskEagerTitle(value: TaskEager): string {
	switch (value) {
		case "preferred":
			return "倾向委派";
		case "always":
			return "总是委派";
		default:
			return "默认";
	}
}

export function taskEagerDescription(value: TaskEager): string {
	switch (value) {
		case "preferred":
			return "系统提示加强委派引导";
		case "always":
			return "强制委派引导（eager-task）";
		default:
			return "模型自行决定是否委派";
	}
}
