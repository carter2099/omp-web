/**
 * Wave 1 Todo 1 — MCP service layer tests.
 * Run: bun test lib/mcp-service.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setAgentDir, getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getMCPServer } from "@oh-my-pi/pi-coding-agent/mcp";

import {
	addMcpServer,
	attachLastProbe,
	findPidsByProbeToken,
	listMcpServers,
	McpServiceError,
	probeMcpServer,
	probeMcpServerList,
	removeMcpServer,
	resetMcpServiceMutexesForTests,
	setMcpEnabled,
	setMcpIsolatedSettingsLoaderForTests,
	updateMcpServer,
	PROBE_TOKEN_ENV,
} from "./mcp-service.ts";
import {
	getOmpRuntime,
	resetOmpRuntimeForTests,
} from "./omp-runtime.ts";
import {
	resolveMcpProbeWorkerPath,
	resolvePiWebPackageRoot,
} from "./package-root.ts";
import { redactUrl } from "./mcp-redact.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..");

function makeHome(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-mcp-${label}-`));
	const agentDir = join(root, ".omp", "agent");
	const cwd = join(root, "proj");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	setAgentDir(agentDir);
	return { root, agentDir, cwd };
}

test.beforeEach(async () => {
	await resetOmpRuntimeForTests();
	resetMcpServiceMutexesForTests();
});

test.afterEach(async () => {
	await resetOmpRuntimeForTests();
	resetMcpServiceMutexesForTests();
});

test("inventory includes disabled servers", async () => {
	const { root, agentDir, cwd } = makeHome("inv-disabled");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "user",
			name: "off-server",
			config: {
				type: "stdio",
				command: "true",
				args: [],
				enabled: false,
			},
		});
		const { servers } = await listMcpServers(cwd);
		const row = servers.find((s) => s.name === "off-server");
		assert.ok(row, "disabled server must appear in inventory");
		assert.equal(row.configuredEnabled, false);
		assert.equal(row.effectiveForRuntime, false);
		assert.equal(row.hasEnv, false);
		assert.ok(!("env" in row) || row.env === undefined);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listMcpServers applies disabledProviders from config.yml", async () => {
	const { root, agentDir, cwd } = makeHome("disabled-providers");
	try {
		writeFileSync(
			join(agentDir, "config.yml"),
			"disabledProviders:\n  - claude\n  - claude-plugins\n  - codex\n  - opencode\n  - github\n",
		);
		await getOmpRuntime(agentDir);
		const { servers } = await listMcpServers(cwd);
		const blocked = new Set([
			"claude",
			"claude-plugins",
			"codex",
			"opencode",
			"github",
		]);
		for (const row of servers) {
			assert.equal(
				blocked.has(row.providerId),
				false,
				`provider ${row.providerId} must not appear when disabledProviders lists it (${row.name})`,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("settings scrub + flush + readback on enable", async () => {
	const { root, agentDir, cwd } = makeHome("scrub");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "user",
			name: "scrub-me",
			config: { type: "stdio", command: "true", args: [] },
		});

		const writer = await Settings.loadIsolated({ cwd, agentDir });
		writer.set("disabledExtensions", ["mcp:scrub-me", "other:keep"]);
		await writer.flush();

		const runtime = await getOmpRuntime(agentDir);
		await runtime.invalidateSettings();

		const before = await Settings.loadIsolated({ cwd, agentDir });
		assert.ok(
			(before.get("disabledExtensions") ?? []).includes("mcp:scrub-me"),
		);

		const list = await listMcpServers(cwd);
		const beforeRow = list.servers.find((s) => s.name === "scrub-me");
		assert.equal(beforeRow?.configuredEnabled, false);

		await setMcpEnabled({ cwd, name: "scrub-me", enabled: true });

		const after = await Settings.loadIsolated({ cwd, agentDir });
		const ext = after.get("disabledExtensions") ?? [];
		assert.equal(ext.includes("mcp:scrub-me"), false, "mcp: scrubbed");
		assert.ok(ext.includes("other:keep"), "unrelated entries kept");

		const afterList = await listMcpServers(cwd);
		const afterRow = afterList.servers.find((s) => s.name === "scrub-me");
		assert.equal(afterRow?.configuredEnabled, true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("two-cwd concurrent enable with prewarmed settings caches", async () => {
	const { root, agentDir, cwd } = makeHome("two-cwd");
	const cwdA = join(root, "proj-a");
	const cwdB = join(root, "proj-b");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	try {
		const runtime = await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd: cwdA,
			scope: "user",
			name: "shared-enable",
			config: { type: "stdio", command: "true", args: [] },
		});

		for (const c of [cwdA, cwdB]) {
			const w = await Settings.loadIsolated({ cwd: c, agentDir });
			w.set("disabledExtensions", ["mcp:shared-enable"]);
			await w.flush();
		}

		// Prewarm getSettingsForCwd for both cwds (stale cache must be invalidated).
		await runtime.getSettingsForCwd(cwdA);
		await runtime.getSettingsForCwd(cwdB);

		await Promise.all([
			setMcpEnabled({ cwd: cwdA, name: "shared-enable", enabled: true }),
			setMcpEnabled({ cwd: cwdB, name: "shared-enable", enabled: true }),
		]);

		for (const c of [cwdA, cwdB]) {
			const s = await runtime.getSettingsForCwd(c);
			const ext = s.get("disabledExtensions") ?? [];
			assert.equal(
				ext.includes("mcp:shared-enable"),
				false,
				`cwd ${c} settings cache reflects scrub`,
			);
			const disk = await Settings.loadIsolated({ cwd: c, agentDir });
			assert.equal(
				(disk.get("disabledExtensions") ?? []).includes("mcp:shared-enable"),
				false,
			);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("update secret-preserve keeps env when omitted", async () => {
	const { root, agentDir, cwd } = makeHome("secret-preserve");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "user",
			name: "secret-srv",
			config: {
				type: "stdio",
				command: "echo",
				args: ["a"],
				env: { API_KEY: "super-secret-value", OTHER: "x" },
			},
		});

		await updateMcpServer({
			cwd,
			scope: "user",
			name: "secret-srv",
			config: {
				type: "stdio",
				command: "echo",
				args: ["b"],
				// env omitted → preserve
			},
		});

		const userPath = getMCPConfigPath("user", cwd);
		const raw = await getMCPServer(userPath, "secret-srv");
		assert.ok(raw);
		assert.equal(raw.env?.API_KEY, "super-secret-value");
		assert.equal(raw.env?.OTHER, "x");
		assert.deepEqual(raw.args, ["b"]);

		const list = await listMcpServers(cwd);
		const row = list.servers.find((s) => s.name === "secret-srv");
		assert.equal(row?.hasEnv, true);
		assert.ok(row?.envKeys.includes("API_KEY"));
		assert.ok(!JSON.stringify(row).includes("super-secret-value"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("URL query credentials redacted", () => {
	const { url, urlRedacted } = redactUrl(
		"https://user:pass@mcp.exa.ai/v1?exaApiKey=sk-secret-key&q=ok",
	);
	assert.equal(urlRedacted, true);
	assert.ok(url);
	assert.equal(url.includes("sk-secret-key"), false);
	assert.equal(url.includes("user:pass"), false);
	assert.equal(url.includes("exaApiKey"), false);
	assert.ok(url.startsWith("https://mcp.exa.ai"));
});

test("settings enable rejects when readback still has mcp:name", async () => {
	const { root, agentDir, cwd } = makeHome("readback-fail");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "user",
			name: "rb-fail",
			config: { type: "stdio", command: "true", args: [] },
		});

		const seed = await Settings.loadIsolated({ cwd, agentDir });
		seed.set("disabledExtensions", ["mcp:rb-fail"]);
		await seed.flush();
		await (await getOmpRuntime(agentDir)).invalidateSettings();

		// Writer: real isolated settings. Verify: always still contains mcp:rb-fail
		// (simulates flush reporting success while disk still has the entry).
		let loadN = 0;
		setMcpIsolatedSettingsLoaderForTests(async (opts) => {
			loadN += 1;
			if (loadN === 1) {
				return Settings.loadIsolated(opts);
			}
			return Settings.isolated({
				disabledExtensions: ["mcp:rb-fail"],
			});
		});

		await assert.rejects(
			() => setMcpEnabled({ cwd, name: "rb-fail", enabled: true }),
			(err) => {
				assert.ok(err instanceof McpServiceError);
				assert.equal(err.status, 500);
				assert.match(err.message, /readback failed/);
				return true;
			},
		);

		// Must not report success: settings still list mcp:rb-fail on disk
		// (writer may have scrubbed, but enable path aborted before success return).
		assert.ok(loadN >= 2, "verify loader must run");
	} finally {
		setMcpIsolatedSettingsLoaderForTests(null);
		rmSync(root, { recursive: true, force: true });
	}
});

/**
 * Plan-locked: npm pack → install prefix → PI_WEB_PKG_DIR → worker exists +
 * probe spawn starts (connect may fail; must not fail with worker-not-found).
 * Uses a slim pack staging tree with the real package name/files entry + worker
 * (full repo pack includes 485MB .next — staging proves the files-array ship path).
 */
test(
	"npm pack install PI_WEB_PKG_DIR worker exists and probe spawn starts",
	{ timeout: 120_000 },
	async () => {
		const prevPkg = process.env.PI_WEB_PKG_DIR;
		const work = mkdtempSync(join(tmpdir(), "pi-web-mcp-pack-"));
		const stage = join(work, "stage");
		const prefix = join(work, "prefix");
		const packDir = join(work, "pack-out");
		mkdirSync(stage, { recursive: true });
		mkdirSync(join(stage, "scripts"), { recursive: true });
		mkdirSync(packDir, { recursive: true });
		mkdirSync(prefix, { recursive: true });

		try {
			const realPkg = JSON.parse(
				readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
			);
			assert.ok(
				Array.isArray(realPkg.files) &&
					realPkg.files.includes("scripts/mcp-probe-worker.mjs"),
				"package.json files must list scripts/mcp-probe-worker.mjs",
			);

			// Dry-run of the real package must include the worker in the pack list.
			const dry = spawnSync("npm", ["pack", "--dry-run"], {
				cwd: PKG_ROOT,
				encoding: "utf8",
				timeout: 60_000,
			});
			assert.equal(dry.status, 0, dry.stderr || dry.stdout);
			assert.match(
				`${dry.stdout}\n${dry.stderr}`,
				/scripts\/mcp-probe-worker\.mjs/,
			);

			// Slim packable package: same name + files entry, real worker binary.
			writeFileSync(
				join(stage, "package.json"),
				JSON.stringify(
					{
						name: realPkg.name,
						version: realPkg.version,
						files: ["scripts/mcp-probe-worker.mjs", "package.json"],
					},
					null,
					2,
				),
			);
			copyFileSync(
				join(PKG_ROOT, "scripts/mcp-probe-worker.mjs"),
				join(stage, "scripts/mcp-probe-worker.mjs"),
			);

			const packed = spawnSync("npm", ["pack", "--pack-destination", packDir], {
				cwd: stage,
				encoding: "utf8",
				timeout: 60_000,
			});
			assert.equal(packed.status, 0, packed.stderr || packed.stdout);
			const tgzName = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
			assert.ok(tgzName, "npm pack must produce a .tgz");
			const tgzPath = join(packDir, tgzName);

			const installed = spawnSync(
				"npm",
				["install", "--prefix", prefix, tgzPath],
				{ encoding: "utf8", timeout: 60_000 },
			);
			assert.equal(installed.status, 0, installed.stderr || installed.stdout);

			const installRoot = join(prefix, "node_modules", "@agegr", "pi-web");
			assert.equal(
				existsSync(join(installRoot, "scripts/mcp-probe-worker.mjs")),
				true,
				"installed package must contain worker",
			);

			process.env.PI_WEB_PKG_DIR = installRoot;
			const resolved = resolvePiWebPackageRoot();
			assert.equal(resolved, installRoot);
			const worker = resolveMcpProbeWorkerPath();
			assert.equal(existsSync(worker), true);

			// One probe spawn via the service (connect may fail; worker path must work).
			const { root, agentDir, cwd } = makeHome("pack-probe");
			try {
				await getOmpRuntime(agentDir);
				await addMcpServer({
					cwd,
					scope: "user",
					name: "pack-probe-srv",
					config: {
						type: "stdio",
						command: "true",
						args: [],
						timeout: 2000,
					},
				});
				const result = await probeMcpServer({
					cwd,
					name: "pack-probe-srv",
					deadlineMs: 8_000,
				});
				const err = result.error ?? "";
				assert.equal(
					/worker not found|Cannot resolve @agegr\/pi-web|mcp-probe-worker\.mjs.*ENOENT|ENOENT.*mcp-probe-worker/i.test(
						err,
					),
					false,
					`probe must not fail with worker-not-found; got: ${err || result.status}`,
				);
				assert.ok(
					result.status === "ok" ||
						result.status === "fail" ||
						result.status === "fail_clean" ||
						result.status === "timeout",
					`unexpected status ${result.status}`,
				);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		} finally {
			if (prevPkg === undefined) delete process.env.PI_WEB_PKG_DIR;
			else process.env.PI_WEB_PKG_DIR = prevPkg;
			rmSync(work, { recursive: true, force: true });
		}
	},
);

test("no MCPManager connect path in service modules", () => {
	const files = [
		join(PKG_ROOT, "lib/mcp-service.ts"),
		join(PKG_ROOT, "lib/mcp-probe.ts"),
		join(PKG_ROOT, "scripts/mcp-probe-worker.mjs"),
	];
	const forbidden = [
		"connectServers",
		"waitForConnection",
		"disconnectAll",
		"discoverAndConnect",
		"MCPManager",
	];
	for (const file of files) {
		const src = readFileSync(file, "utf8");
		for (const bad of forbidden) {
			assert.equal(
				src.includes(bad),
				false,
				`${file} must not reference ${bad}`,
			);
		}
	}
	const worker = readFileSync(join(PKG_ROOT, "scripts/mcp-probe-worker.mjs"), "utf8");
	assert.ok(worker.includes("connectToServer"));
	assert.ok(worker.includes("listTools"));
	assert.ok(worker.includes("disconnectServer"));
});

test(
	"hang stdio probe reaps token-tagged children (Linux)",
	{ timeout: 30_000 },
	async () => {
		if (process.platform !== "linux") {
			return;
		}
		const { root, agentDir, cwd } = makeHome("hang-stdio");
		const hangScript = join(root, "hang.sh");
		writeFileSync(
			hangScript,
			`#!/bin/sh\nexport ${PROBE_TOKEN_ENV}\nsleep 600\n`,
			{ mode: 0o755 },
		);
		try {
			process.env.PI_WEB_PKG_DIR = PKG_ROOT;
			await getOmpRuntime(agentDir);
			await addMcpServer({
				cwd,
				scope: "user",
				name: "hang-stdio",
				config: {
					type: "stdio",
					command: "sh",
					args: [hangScript],
					timeout: 0,
				},
			});

			const t0 = Date.now();
			const result = await probeMcpServer({
				cwd,
				name: "hang-stdio",
				deadlineMs: 3_000,
				workerTimeoutMs: 0,
				ompMcpTimeoutMs: "0",
			});
			const elapsed = Date.now() - t0;
			assert.ok(elapsed <= 25_000, `elapsed ${elapsed}ms`);
			assert.ok(
				result.status === "timeout" ||
					result.status === "fail_clean" ||
					result.status === "fail",
			);
			// Allow brief settle then assert no token orphans.
			await new Promise((r) => setTimeout(r, 200));
			const orphans = findPidsByProbeToken(
				// token is random per probe; scan any process with env key is enough via empty?
				// We need the actual token — reap already ran. Assert no processes with our hang script parent.
				// Use a known pattern: after reap, no PI_WEB_MCP_PROBE_TOKEN processes from this test's hang.
				// findPidsByProbeToken needs exact token. Re-check by scanning hang.sh cmdline.
			);
			// Empty token won't match; scan /proc for hang.sh + sleep 600 leftover
			const { readdirSync, readFileSync: rf } = await import("node:fs");
			let hangLeft = 0;
			for (const ent of readdirSync("/proc")) {
				if (!/^\d+$/.test(ent)) continue;
				try {
					const cmd = rf(`/proc/${ent}/cmdline`, "utf8");
					if (cmd.includes(hangScript) || cmd.includes("sleep\u0000600")) {
						// also require our token env if present
						const env = rf(`/proc/${ent}/environ`);
						if (env.includes(`${PROBE_TOKEN_ENV}=`)) hangLeft++;
					}
				} catch {
					// gone
				}
			}
			assert.equal(hangLeft, 0, "no token-tagged hang orphans");
			void orphans;
			void result;
		} finally {
			delete process.env.PI_WEB_PKG_DIR;
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"hang HTTP probe finishes within 25s",
	{ timeout: 30_000 },
	async () => {
		const { root, agentDir, cwd } = makeHome("hang-http");
		// Never-responding TCP server (accepts then hangs)
		const server = createServer((_req, _res) => {
			// intentional hang — no response
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address();
		try {
			process.env.PI_WEB_PKG_DIR = PKG_ROOT;
			await getOmpRuntime(agentDir);
			await addMcpServer({
				cwd,
				scope: "user",
				name: "hang-http",
				config: {
					type: "http",
					url: `http://127.0.0.1:${port}/mcp`,
					timeout: 0,
				},
			});
			const t0 = Date.now();
			const result = await probeMcpServer({
				cwd,
				name: "hang-http",
				deadlineMs: 3_000,
				workerTimeoutMs: 0,
				ompMcpTimeoutMs: "0",
			});
			const elapsed = Date.now() - t0;
			assert.ok(elapsed <= 25_000, `elapsed ${elapsed}ms`);
			assert.ok(
				result.status === "timeout" ||
					result.status === "fail_clean" ||
					result.status === "fail",
			);
		} finally {
			server.close();
			delete process.env.PI_WEB_PKG_DIR;
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test(
	"fork-canary stdio reaping kills both processes (Linux)",
	{ timeout: 30_000 },
	async () => {
		if (process.platform !== "linux") {
			return;
		}
		const { root, agentDir, cwd } = makeHome("fork-canary");
		const canary = join(root, "canary.sh");
		// Parent forks a long-lived child inheriting env, then hangs.
		writeFileSync(
			canary,
			`#!/bin/sh
sleep 600 &
sleep 600
`,
			{ mode: 0o755 },
		);
		try {
			process.env.PI_WEB_PKG_DIR = PKG_ROOT;
			await getOmpRuntime(agentDir);
			await addMcpServer({
				cwd,
				scope: "user",
				name: "fork-canary",
				config: {
					type: "stdio",
					command: "sh",
					args: [canary],
					timeout: 0,
				},
			});
			const t0 = Date.now();
			await probeMcpServer({
				cwd,
				name: "fork-canary",
				deadlineMs: 3_000,
				workerTimeoutMs: 0,
				ompMcpTimeoutMs: "0",
			});
			assert.ok(Date.now() - t0 <= 25_000);
			await new Promise((r) => setTimeout(r, 300));
			const { readdirSync, readFileSync: rf } = await import("node:fs");
			let left = 0;
			for (const ent of readdirSync("/proc")) {
				if (!/^\d+$/.test(ent)) continue;
				try {
					const env = rf(`/proc/${ent}/environ`);
					if (env.includes(`${PROBE_TOKEN_ENV}=`)) {
						const cmd = rf(`/proc/${ent}/cmdline`, "utf8");
						if (cmd.includes("sleep") || cmd.includes(canary)) left++;
					}
				} catch {
					// gone
				}
			}
			assert.equal(left, 0, "fork canary + child reaped");
		} finally {
			delete process.env.PI_WEB_PKG_DIR;
			rmSync(root, { recursive: true, force: true });
		}
	},
);

test("remove server after add", async () => {
	const { root, agentDir, cwd } = makeHome("remove");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "project",
			name: "tmp-rm",
			config: { type: "stdio", command: "true", args: [] },
		});
		let list = await listMcpServers(cwd);
		assert.ok(list.servers.some((s) => s.name === "tmp-rm"));
		await removeMcpServer({ cwd, scope: "project", name: "tmp-rm" });
		list = await listMcpServers(cwd);
		assert.equal(
			list.servers.some((s) => s.name === "tmp-rm"),
			false,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("attachLastProbe keeps servers array for UI setData", () => {
	const list = {
		servers: [
			{
				name: "a",
				scope: "user",
				sourcePath: "/u/mcp.json",
				providerId: "native",
				shadowed: false,
				transport: "stdio",
				envKeys: [],
				hasEnv: false,
				headerKeys: [],
				hasHeaders: false,
				hasAuth: false,
				hasOauth: false,
				configuredEnabled: true,
				effectiveForRuntime: true,
			},
		],
		diagnostics: [],
	};
	const next = attachLastProbe(list, {
		name: "a",
		sourcePath: "/u/mcp.json",
		lastProbe: { status: "ok", toolCount: 1, tools: ["t"], durationMs: 10 },
	});
	assert.ok(Array.isArray(next.servers));
	assert.equal(next.servers[0].lastProbe?.status, "ok");
	assert.equal(next.servers[0].lastProbe?.toolCount, 1);
});

test("probeMcpServerList returns inventory with lastProbe", async () => {
	const { root, agentDir, cwd } = makeHome("probe-list");
	try {
		await getOmpRuntime(agentDir);
		await addMcpServer({
			cwd,
			scope: "user",
			name: "probe-list-srv",
			config: { type: "stdio", command: "true", args: [], timeout: 5000 },
		});
		const next = await probeMcpServerList({
			cwd,
			name: "probe-list-srv",
		});
		assert.ok(Array.isArray(next.servers), "must return servers[] for UI");
		const row = next.servers.find((s) => s.name === "probe-list-srv");
		assert.ok(row, "probed server still listed");
		assert.ok(row.lastProbe, "lastProbe attached");
		assert.ok(
			["ok", "fail", "timeout", "fail_clean"].includes(row.lastProbe.status),
		);
		assert.equal(typeof row.lastProbe.durationMs, "number");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
