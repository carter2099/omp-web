/**
 * Temp-home round-trip for models + models.yml (Todo 6).
 *
 * Run: bun test lib/models-service.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	getModelsYmlPath,
	loadModelsData,
	readModelsConfig,
	redactSecrets,
	testModelFromConfig,
	writeModelsConfig,
} from "./models-service.ts";
import {
	disposeOmpRuntime,
	getOmpRuntime,
	resetOmpRuntimeForTests,
} from "./omp-runtime.ts";
import { invalidateModelsCache } from "./models-cache.ts";

function makeTempHome(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-models-${label}-`));
	const agentDir = join(root, ".omp", "agent");
	const cwd = join(root, "proj");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
	return { root, agentDir, cwd };
}

const SAMPLE_CONFIG = {
	providers: {
		"temp-provider": {
			baseUrl: "http://127.0.0.1:9/v1",
			apiKey: "sk-temp-roundtrip",
			api: "openai-completions",
			models: [
				{
					id: "temp-model",
					name: "Temp Model",
					reasoning: true,
					input: ["text"],
					contextWindow: 8192,
					maxTokens: 1024,
					thinking: {
						mode: "effort",
						efforts: ["low", "high"],
					},
				},
			],
		},
	},
};

test.afterEach(async () => {
	await resetOmpRuntimeForTests();
	invalidateModelsCache();
});

test("temp-home round-trip: write models.yml → reload → list → set default", async () => {
	// Given
	const { root, agentDir, cwd } = makeTempHome("roundtrip");
	try {
		const modelsPath = getModelsYmlPath(agentDir);
		assert.equal(modelsPath, join(agentDir, "models.yml"));

		// When — write config
		writeModelsConfig(agentDir, SAMPLE_CONFIG);
		assert.equal(existsSync(modelsPath), true);
		const onDisk = readFileSync(modelsPath, "utf8");
		assert.match(onDisk, /temp-provider/);
		assert.match(onDisk, /temp-model/);

		// Then — reload via ModelsConfigFile path
		const reloaded = readModelsConfig(agentDir);
		assert.ok(reloaded.providers?.["temp-provider"]);
		assert.equal(
			reloaded.providers["temp-provider"].models[0].id,
			"temp-model",
		);

		// When — list models via factory registry + settings
		const runtime = await getOmpRuntime(agentDir);
		await runtime.invalidateModels();
		const listed = await loadModelsData(cwd, runtime);

		// Then — response shape + custom model present
		assert.ok(listed.models);
		assert.ok(Array.isArray(listed.modelList));
		assert.ok(listed.thinkingLevels);
		assert.ok(listed.thinkingLevelMaps);
		const entry = listed.modelList.find(
			(m) => m.provider === "temp-provider" && m.id === "temp-model",
		);
		assert.ok(entry, "custom model should appear in modelList");
		assert.equal(entry.name, "Temp Model");
		assert.equal(listed.models["temp-provider:temp-model"], "Temp Model");
		assert.deepEqual(listed.thinkingLevels["temp-provider:temp-model"], [
			"low",
			"high",
		]);

		// When — set default model role
		const settings = await runtime.getSettingsForCwd(cwd);
		settings.setModelRole("default", "temp-provider/temp-model");
		invalidateModelsCache();
		const listedAfterDefault = await loadModelsData(cwd, runtime);

		// Then
		assert.deepEqual(listedAfterDefault.defaultModel, {
			provider: "temp-provider",
			modelId: "temp-model",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("writeModelsConfig rejects invalid non-object payload", () => {
	const { root, agentDir } = makeTempHome("bad-write");
	try {
		assert.throws(
			() => writeModelsConfig(agentDir, ["not", "an", "object"]),
			/must be a JSON object/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("readModelsConfig returns empty providers when file is absent", () => {
	const { root, agentDir } = makeTempHome("absent");
	try {
		assert.deepEqual(readModelsConfig(agentDir), { providers: {} });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("redactSecrets strips credential-shaped provider errors", () => {
	// Given / When / Then
	assert.equal(
		redactSecrets("Unauthorized: invalid key sk-abc1234567890xyz"),
		"Unauthorized: invalid key sk-***",
	);
	assert.match(
		redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"),
		/Bearer \*\*\*/,
	);
	assert.doesNotMatch(
		redactSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"),
		/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/,
	);
	assert.match(redactSecrets("api_key=sk-live-supersecrettokenvalue"), /api_key=\*\*\*/);
	assert.match(redactSecrets("apiKey: supersecrettokenvaluehere"), /apiKey=\*\*\*/);
	assert.match(
		redactSecrets(`provider rejected ${"A".repeat(48)}`),
		/\*\*\*/,
	);
	// UUID remains readable
	assert.match(
		redactSecrets("request id 550e8400-e29b-41d4-a716-446655440000 failed"),
		/550e8400-e29b-41d4-a716-446655440000/,
	);
});

test("success-shaped model-test responseText applies redactSecrets for sk-* and Bearer", () => {
	// Given — assistant text that could echo provider secrets on a success path
	const assistantText =
		"OK sk-abc1234567890xyz Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
	// When — same assembly as testModelFromConfig success branch
	const responseText = redactSecrets(assistantText.slice(0, 300));
	// Then
	assert.doesNotMatch(responseText, /\bsk-[A-Za-z0-9_-]{8,}\b/i);
	assert.doesNotMatch(responseText, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/);
	assert.match(responseText, /sk-\*\*\*/);
	assert.match(responseText, /Bearer \*\*\*/);
});

test("testModelFromConfig success path wires redactSecrets into responseText", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("./models-service.ts", import.meta.url), "utf8");
	assert.match(
		source,
		/responseText:\s*redactSecrets\(\s*getAssistantText\(message\)\.slice\(0,\s*300\)\s*\)/,
	);
});

test("testModelFromConfig disposes temp runtime so agentDir can be removed cleanly", async () => {
	// Given — auth:none fails before any network call
	const { root, agentDir } = makeTempHome("model-test-dispose");
	try {
		// When
		const result = await testModelFromConfig(agentDir, {
			providerName: "temp-provider",
			provider: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				auth: "none",
			},
			model: {
				id: "temp-model",
				name: "Temp Model",
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 16,
			},
		});

		// Then — failed probe still returns a structured error
		assert.equal(result.ok, false);
		assert.equal("error" in result && typeof result.error === "string", true);
		assert.doesNotMatch(result.error, /\bsk-[A-Za-z0-9_-]{8,}\b/i);

		// Slot was disposed: a new open is a fresh handle (no dual-open / leaked slot)
		const opened = await getOmpRuntime(agentDir);
		assert.equal(typeof opened.authStorage.getGeneration, "function");
		assert.equal(typeof opened.authStorage.getGeneration(), "number");

		// Dispose again is safe; then rmdir of the temp tree succeeds (no open SQLite)
		await disposeOmpRuntime(agentDir);
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
});

test("testModelFromConfig error path never returns sk-* material from provider name", async () => {
	// Given — auth:none fails locally; providerName carries a credential-shaped token
	const { root, agentDir } = makeTempHome("model-test-redact");
	const leakyName = "sk-providerleak1234567890abcd";
	try {
		const result = await testModelFromConfig(agentDir, {
			providerName: leakyName,
			provider: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				auth: "none",
			},
			model: {
				id: "temp-model",
				name: "Temp Model",
				input: ["text"],
				contextWindow: 8192,
				maxTokens: 16,
			},
		});

		// Then
		assert.equal(result.ok, false);
		assert.doesNotMatch(result.error, new RegExp(leakyName));
		assert.doesNotMatch(result.error, /\bsk-[A-Za-z0-9_-]{8,}\b/i);
		assert.match(result.error, /sk-\*\*\*|No API key|not found|error/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
