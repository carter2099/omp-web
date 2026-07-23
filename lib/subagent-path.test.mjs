/**
 * Todo 1 — path allow-list unit tests.
 * Run: bun test lib/subagent-path.test.mjs
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
const {
	assertSubagentSessionFileAllowed,
	resolveSubagentArtifactsRoot,
	SubagentPathError,
} = await jiti.import("./subagent-path.ts");

function makeTree(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-subpath-${label}-`));
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const parentSessionFile = join(sessionsDir, "parent.jsonl");
	writeFileSync(
		parentSessionFile,
		'{"type":"session","id":"p1","timestamp":"t","cwd":"/tmp"}\n',
		"utf8",
	);
	const artifactsDir = join(sessionsDir, "parent");
	mkdirSync(artifactsDir, { recursive: true });
	const nestedDir = join(artifactsDir, "ChildA");
	mkdirSync(nestedDir, { recursive: true });
	const childFile = join(artifactsDir, "ChildA.jsonl");
	const nestedFile = join(nestedDir, "Helper.jsonl");
	writeFileSync(childFile, '{"type":"session","id":"c1","timestamp":"t","cwd":"/tmp"}\n', "utf8");
	writeFileSync(nestedFile, '{"type":"session","id":"h1","timestamp":"t","cwd":"/tmp"}\n', "utf8");
	const siblingFile = join(sessionsDir, "sibling.jsonl");
	writeFileSync(siblingFile, '{"type":"session","id":"s1","timestamp":"t","cwd":"/tmp"}\n', "utf8");
	const outsideDir = join(root, "outside");
	mkdirSync(outsideDir, { recursive: true });
	const outsideFile = join(outsideDir, "escape.jsonl");
	writeFileSync(outsideFile, '{"type":"session","id":"e1","timestamp":"t","cwd":"/tmp"}\n', "utf8");
	return {
		root,
		parentSessionFile,
		artifactsDir,
		childFile,
		nestedFile,
		siblingFile,
		outsideFile,
	};
}

test("resolveSubagentArtifactsRoot strips .jsonl and appends sep", () => {
	const tree = makeTree("root");
	try {
		const root = resolveSubagentArtifactsRoot(tree.parentSessionFile);
		assert.ok(root.endsWith("parent/") || root.endsWith("parent\\"));
		assert.ok(root.includes("sessions"));
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("allows nested candidate under parent artifacts", () => {
	const tree = makeTree("allow-nested");
	try {
		const allowed = assertSubagentSessionFileAllowed(
			tree.parentSessionFile,
			tree.childFile,
		);
		assert.equal(allowed, tree.childFile);

		const nested = assertSubagentSessionFileAllowed(
			tree.parentSessionFile,
			tree.nestedFile,
		);
		assert.equal(nested, tree.nestedFile);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("rejects sibling session file outside artifacts root", () => {
	const tree = makeTree("sibling");
	try {
		assert.throws(
			() =>
				assertSubagentSessionFileAllowed(
					tree.parentSessionFile,
					tree.siblingFile,
				),
			(err) =>
				err instanceof SubagentPathError &&
				err.statusCode === 400 &&
				/outside parent artifacts/i.test(err.message),
		);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("rejects path traversal with .. segments", () => {
	const tree = makeTree("dotdot");
	try {
		const escapeViaDotDot = join(
			tree.artifactsDir,
			"..",
			"sibling.jsonl",
		);
		assert.throws(
			() =>
				assertSubagentSessionFileAllowed(
					tree.parentSessionFile,
					escapeViaDotDot,
				),
			(err) => err instanceof SubagentPathError && err.statusCode === 400,
		);

		const escapeOutside = join(
			tree.artifactsDir,
			"..",
			"..",
			"outside",
			"escape.jsonl",
		);
		assert.throws(
			() =>
				assertSubagentSessionFileAllowed(
					tree.parentSessionFile,
					escapeOutside,
				),
			(err) => err instanceof SubagentPathError && err.statusCode === 400,
		);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("rejects symlink that escapes artifacts root", () => {
	const tree = makeTree("symlink");
	try {
		const linkPath = join(tree.artifactsDir, "linked.jsonl");
		symlinkSync(tree.outsideFile, linkPath);
		assert.throws(
			() =>
				assertSubagentSessionFileAllowed(
					tree.parentSessionFile,
					linkPath,
				),
			(err) => err instanceof SubagentPathError && err.statusCode === 400,
		);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});

test("missing contained path yields 404", () => {
	const tree = makeTree("missing");
	try {
		const missing = join(tree.artifactsDir, "NoSuch.jsonl");
		assert.throws(
			() =>
				assertSubagentSessionFileAllowed(
					tree.parentSessionFile,
					missing,
				),
			(err) =>
				err instanceof SubagentPathError &&
				err.statusCode === 404 &&
				/not found/i.test(err.message),
		);
	} finally {
		rmSync(tree.root, { recursive: true, force: true });
	}
});
