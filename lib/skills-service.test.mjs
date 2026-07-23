/**
 * Unit tests for lib/skills-service.ts (OMP discoverSkills).
 * Run: bun test lib/skills-service.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetOmpRuntimeForTests } from "./omp-runtime.ts";
import { loadSkillsWithInstallInfo } from "./skills-service.ts";

function makeIsolatedHome(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-skills-${label}-`));
	const home = join(root, "home");
	const agentDir = join(home, ".omp", "agent");
	const cwd = join(root, "proj");
	mkdirSync(join(agentDir, "skills"), { recursive: true });
	mkdirSync(join(cwd, ".omp", "skills"), { recursive: true });
	mkdirSync(join(cwd, ".agents", "skills"), { recursive: true });
	return { root, home, agentDir, cwd };
}

function writeSkill(dir, name, { description = `${name} desc`, disable = false } = {}) {
	mkdirSync(dir, { recursive: true });
	const front = [
		"---",
		`name: ${name}`,
		`description: ${description}`,
		disable ? "disable-model-invocation: true" : null,
		"---",
		`# ${name}`,
		"",
	]
		.filter(Boolean)
		.join("\n");
	const filePath = join(dir, "SKILL.md");
	writeFileSync(filePath, front, "utf8");
	return filePath;
}

test.afterEach(async () => {
	await resetOmpRuntimeForTests();
});

test("loadSkillsWithInstallInfo lists native project and agent skills under isolated HOME", async () => {
	// Given
	const { root, home, agentDir, cwd } = makeIsolatedHome("list");
	const prevHome = process.env.HOME;
	const prevAgent = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeSkill(join(agentDir, "skills", "hello-global"), "hello-global");
		writeSkill(join(cwd, ".omp", "skills", "hello-proj"), "hello-proj");
		writeSkill(join(cwd, ".agents", "skills", "hello-agents"), "hello-agents", {
			disable: true,
		});

		// When
		const { skills, diagnostics } = await loadSkillsWithInstallInfo(cwd);

		// Then
		assert.ok(Array.isArray(skills));
		assert.ok(Array.isArray(diagnostics));
		const byName = new Map(skills.map((s) => [s.name, s]));
		assert.ok(byName.has("hello-proj"), "native project skill missing");
		assert.ok(byName.has("hello-agents"), "agents project skill missing");
		assert.equal(byName.get("hello-agents")?.disableModelInvocation, true);
		assert.equal(byName.get("hello-proj")?.disableModelInvocation, false);
		assert.equal(typeof byName.get("hello-proj")?.filePath, "string");
		assert.equal(typeof byName.get("hello-proj")?.baseDir, "string");
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadSkillsWithInstallInfo honors disabledProviders for claude-plugins fallthrough", async () => {
	// Given — enablePiUser opens third-party fallthrough; denylist must still win
	const { root, home, agentDir, cwd } = makeIsolatedHome("denylist");
	const prevHome = process.env.HOME;
	const prevAgent = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		writeFileSync(
			join(agentDir, "config.yml"),
			[
				"disabledProviders:",
				"  - claude",
				"  - claude-plugins",
				"  - opencode",
				"skills:",
				"  enablePiUser: true",
				"  enablePiProject: true",
				"  enableAgentsUser: true",
				"  enableAgentsProject: true",
				"  enableClaudeUser: false",
				"  enableClaudeProject: false",
				"",
			].join("\n"),
			"utf8",
		);
		// Claude Code plugin skill layout under isolated HOME
		const claudeSkillDir = join(
			home,
			".claude",
			"plugins",
			"cache",
			"fake-plugin",
			"1.0.0",
			"skills",
			"claude-only-skill",
		);
		writeSkill(claudeSkillDir, "claude-only-skill");
		writeSkill(join(cwd, ".omp", "skills", "keep-native"), "keep-native");

		// When
		const { skills } = await loadSkillsWithInstallInfo(cwd);

		// Then
		const byName = new Map(skills.map((s) => [s.name, s]));
		assert.ok(byName.has("keep-native"), "native skill should remain");
		assert.equal(
			byName.has("claude-only-skill"),
			false,
			"claude-plugins skill must be filtered by disabledProviders",
		);
		for (const s of skills) {
			const src = s.sourceInfo?.source ?? "";
			assert.equal(
				src.includes("claude"),
				false,
				`unexpected claude source: ${src} (${s.name})`,
			);
			assert.equal(
				(s.filePath ?? "").includes(".claude"),
				false,
				`unexpected .claude path: ${s.filePath}`,
			);
		}
	} finally {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgent;
		rmSync(root, { recursive: true, force: true });
	}
});

test("PATCH-equivalent surgical frontmatter toggle preserves other YAML fields", async () => {
	// Given — same surgical edit rules as app/api/skills/route.ts
	const root = mkdtempSync(join(tmpdir(), "pi-web-skill-patch-"));
	try {
		const filePath = join(root, "SKILL.md");
		writeFileSync(
			filePath,
			"---\nname: toggle-me\ndescription: Keep me\n---\n# body\n",
			"utf8",
		);
		const { parseFrontmatter } = await import("@oh-my-pi/pi-utils");
		const key = "disable-model-invocation";

		// When — enable
		let content = readFileSync(filePath, "utf8");
		let { frontmatter } = parseFrontmatter(content);
		assert.equal(Boolean(frontmatter.disableModelInvocation), false);
		let updated = content.replace(/^---\r?\n/, `---\n${key}: true\n`);
		writeFileSync(filePath, updated, "utf8");

		// Then
		content = readFileSync(filePath, "utf8");
		({ frontmatter } = parseFrontmatter(content));
		assert.equal(Boolean(frontmatter.disableModelInvocation), true);
		assert.equal(frontmatter.name, "toggle-me");
		assert.equal(frontmatter.description, "Keep me");
		assert.match(content, new RegExp(`^${key}: true$`, "m"));

		// When — disable
		updated = content.replace(new RegExp(`^${key}\\s*:.*\\r?\\n`, "m"), "");
		writeFileSync(filePath, updated, "utf8");
		content = readFileSync(filePath, "utf8");
		({ frontmatter } = parseFrontmatter(content));
		assert.equal(Boolean(frontmatter.disableModelInvocation), false);
		assert.equal(frontmatter.name, "toggle-me");
		assert.equal(frontmatter.description, "Keep me");
		assert.doesNotMatch(content, new RegExp(`^${key}\\s*:`, "m"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
