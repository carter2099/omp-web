import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	isTaskEager,
	normalizeTaskEager,
	taskEagerDescription,
	taskEagerShortLabel,
	taskEagerTitle,
} from "./task-eager.ts";

describe("task-eager helpers", () => {
	test("normalizeTaskEager accepts known values and defaults unknown", () => {
		assert.equal(normalizeTaskEager("default"), "default");
		assert.equal(normalizeTaskEager("preferred"), "preferred");
		assert.equal(normalizeTaskEager("always"), "always");
		assert.equal(normalizeTaskEager(undefined), "default");
		assert.equal(normalizeTaskEager("nope"), "default");
		assert.equal(isTaskEager("preferred"), true);
		assert.equal(isTaskEager("x"), false);
	});

	test("Chinese labels cover all enum values", () => {
		for (const v of ["default", "preferred", "always"]) {
			assert.ok(taskEagerShortLabel(v).length > 0);
			assert.ok(taskEagerTitle(v).length > 0);
			assert.ok(taskEagerDescription(v).length > 0);
		}
		assert.equal(taskEagerShortLabel("default"), "默认");
		assert.equal(taskEagerTitle("preferred"), "倾向委派");
		assert.match(taskEagerDescription("always"), /eager-task|强制/);
	});
});
