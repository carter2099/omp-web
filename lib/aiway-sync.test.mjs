/**
 * Pure unit tests for AI Way → models.yml mapping (no network).
 *
 * Run: bun test lib/aiway-sync.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAiWayProviderConfig,
	fetchAiWayModels,
	mapAiWayItemToModelEntry,
	mapNativeEndpointToApi,
	mergeAiWayIntoConfig,
	shouldSkipModelId,
} from "./aiway-sync.ts";

const FIXTURE = {
	data: [
		{
			id: "claude-sonnet-5",
			display_name: "Claude Sonnet 5",
			native_endpoint_types: ["messages"],
			supported_endpoint_types: ["anthropic", "openai"],
			capabilities: {
				effort_levels: ["low", "medium", "high", "xhigh", "max"],
				default_effort: "high",
				default_thinking_type: "adaptive",
				context_window: 1000000,
				max_output: 128000,
				input_modalities: ["text", "image", "pdf"],
			},
			pricing: {
				input: 2,
				output: 10,
				cache_read: 0.2,
				cache_write: 2.5,
			},
		},
		{
			id: "claude-haiku-4-5",
			display_name: "Claude Haiku 4.5",
			native_endpoint_types: ["messages"],
			capabilities: {
				effort_levels: ["low", "medium", "high"],
				default_effort: "medium",
				default_thinking_type: "enabled",
				context_window: 200000,
				max_output: 64000,
				input_modalities: ["text", "image", "pdf"],
			},
			pricing: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
		},
		{
			id: "gpt-5.4",
			display_name: "GPT-5.4",
			native_endpoint_types: ["responses"],
			capabilities: {
				effort_levels: ["low", "medium", "high", "xhigh"],
				default_effort: "high",
				default_thinking_type: "none",
				context_window: 1050000,
				max_output: 128000,
				input_modalities: ["text", "image", "pdf"],
			},
			pricing: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 2.5 },
		},
		{
			id: "gemini-3.5-flash",
			display_name: "Gemini 3.5 Flash",
			native_endpoint_types: ["completions"],
			capabilities: {
				effort_levels: ["low", "medium", "high"],
				default_effort: "high",
				default_thinking_type: "enabled",
				context_window: 1048576,
				max_output: 65536,
				input_modalities: ["text", "image", "video", "audio", "pdf"],
			},
			pricing: {
				input: 1.5,
				output: 9,
				cache_read: 0.15000000000000002,
				cache_write: 0.083334,
			},
		},
		{
			id: "composer-2.5",
			display_name: "Composer 2.5",
			native_endpoint_types: ["completions"],
			capabilities: {
				context_window: 262144,
				max_output: 32768,
				input_modalities: ["text", "image"],
			},
			pricing: { input: 0.5, output: 2.5, cache_read: 0, cache_write: 0 },
		},
		{
			id: "text-embedding-3-small",
			display_name: "Text Embedding 3 Small",
			native_endpoint_types: ["embeddings"],
			capabilities: { context_window: 8192 },
			pricing: { input: 0.02, output: 0 },
		},
		{
			id: "rerank-4-fast",
			display_name: "Rerank 4 Fast",
			native_endpoint_types: ["completions"],
			capabilities: { context_window: 8192, max_output: 1024 },
			pricing: { input: 0.01, output: 0 },
		},
		{
			id: "deepseek-v4-flash-fim",
			display_name: "DeepSeek FIM",
			native_endpoint_types: ["completions"],
			capabilities: {
				effort_levels: ["high"],
				context_window: 100000,
				max_output: 8000,
				input_modalities: ["text"],
			},
			pricing: { input: 0.1, output: 0.2 },
		},
		{
			id: "unknown-effort-model",
			display_name: "Unknown Effort",
			native_endpoint_types: ["completions"],
			capabilities: {
				effort_levels: ["turbo", "insane"],
				default_effort: "turbo",
				context_window: 8000,
				max_output: 1000,
				input_modalities: ["text"],
			},
			pricing: { input: 1, output: 2 },
		},
	],
};

test("mapNativeEndpointToApi: messages/responses/completions/embeddings", () => {
	assert.equal(mapNativeEndpointToApi(["messages"]), "anthropic-messages");
	assert.equal(mapNativeEndpointToApi(["responses"]), "openai-responses");
	assert.equal(mapNativeEndpointToApi(["completions"]), "openai-completions");
	assert.equal(mapNativeEndpointToApi(["embeddings"]), null);
	assert.equal(mapNativeEndpointToApi(["messages", "completions"]), "anthropic-messages");
	assert.equal(mapNativeEndpointToApi([]), null);
});

test("shouldSkipModelId: embedding / rerank / fim", () => {
	assert.equal(shouldSkipModelId("text-embedding-3-small"), true);
	assert.equal(shouldSkipModelId("rerank-4-fast"), true);
	assert.equal(shouldSkipModelId("deepseek-v4-flash-fim"), true);
	assert.equal(shouldSkipModelId("claude-sonnet-5"), false);
	assert.equal(shouldSkipModelId("gpt-5.4"), false);
});

test("mapAiWayItemToModelEntry: adaptive thinking for claude-like messages", () => {
	const claude = mapAiWayItemToModelEntry(FIXTURE.data[0]);
	assert.ok(claude);
	assert.equal(claude.api, "anthropic-messages");
	assert.equal(claude.reasoning, true);
	assert.deepEqual(claude.input, ["text", "image"]);
	assert.equal(claude.thinking?.mode, "anthropic-adaptive");
	assert.deepEqual(claude.thinking?.efforts, ["low", "medium", "high", "xhigh", "max"]);
	assert.equal(claude.thinking?.defaultLevel, "high");
	assert.equal(claude.cost.input, 2);
	assert.equal(claude.cost.cacheRead, 0.2);
});

test("mapAiWayItemToModelEntry: haiku uses effort mode (not adaptive)", () => {
	const haiku = mapAiWayItemToModelEntry(FIXTURE.data[1]);
	assert.ok(haiku);
	assert.equal(haiku.thinking?.mode, "effort");
	assert.equal(haiku.thinking?.defaultLevel, "medium");
});

test("mapAiWayItemToModelEntry: gpt responses + gemini completions", () => {
	const gpt = mapAiWayItemToModelEntry(FIXTURE.data[2]);
	assert.ok(gpt);
	assert.equal(gpt.api, "openai-responses");
	assert.equal(gpt.thinking?.mode, "effort");
	assert.deepEqual(gpt.thinking?.efforts, ["low", "medium", "high", "xhigh"]);

	const gemini = mapAiWayItemToModelEntry(FIXTURE.data[3]);
	assert.ok(gemini);
	assert.equal(gemini.api, "openai-completions");
	assert.equal(gemini.thinking?.mode, "effort");
	assert.deepEqual(gemini.input, ["text", "image"]);
	assert.equal(gemini.contextWindow, 1048576);
});

test("mapAiWayItemToModelEntry: no thinking → reasoning false", () => {
	const composer = mapAiWayItemToModelEntry(FIXTURE.data[4]);
	assert.ok(composer);
	assert.equal(composer.reasoning, false);
	assert.equal(composer.thinking, undefined);
});

test("mapAiWayItemToModelEntry: skips embedding/rerank/fim and embeddings-only api", () => {
	assert.equal(mapAiWayItemToModelEntry(FIXTURE.data[5]), null);
	assert.equal(mapAiWayItemToModelEntry(FIXTURE.data[6]), null);
	assert.equal(mapAiWayItemToModelEntry(FIXTURE.data[7]), null);
});

test("mapAiWayItemToModelEntry: unknown effort levels drop thinking", () => {
	const entry = mapAiWayItemToModelEntry(FIXTURE.data[8]);
	assert.ok(entry);
	assert.equal(entry.reasoning, false);
	assert.equal(entry.thinking, undefined);
});

test("fetchAiWayModels: fixture fetchImpl, byApi counts", async () => {
	const fetchImpl = async (url, init) => {
		assert.match(url, /\/v1\/models$/);
		assert.equal(init?.headers?.Authorization, "Bearer sk-test");
		return {
			ok: true,
			status: 200,
			async text() {
				return JSON.stringify(FIXTURE);
			},
		};
	};
	const result = await fetchAiWayModels("http://example.test/v1/", "sk-test", fetchImpl);
	// 9 fixture items: embed, rerank, fim, unknown-effort kept as model without thinking
	// skipped: embedding id, embeddings-only already covered by id, rerank id, fim id = 3 skip by id
	// text-embedding also embeddings-only; count of null maps:
	// embed, rerank, fim = 3 skipped; rest 6 mapped (including unknown-effort)
	assert.equal(result.models.length, 6);
	assert.equal(result.skipped, 3);
	assert.equal(result.byApi["anthropic-messages"], 2);
	assert.equal(result.byApi["openai-responses"], 1);
	assert.equal(result.byApi["openai-completions"], 3);
});

test("mergeAiWayIntoConfig: replaces target provider, preserves others + apiKey", () => {
	const existing = {
		providers: {
			other: {
				baseUrl: "http://other",
				apiKey: "sk-other",
				models: [{ id: "keep-me" }],
			},
			aiway: {
				baseUrl: "http://old",
				apiKey: "sk-existing",
				api: "openai-completions",
				models: [{ id: "old-model" }],
			},
		},
	};
	const models = [
		mapAiWayItemToModelEntry(FIXTURE.data[0]),
		mapAiWayItemToModelEntry(FIXTURE.data[2]),
	].filter(Boolean);

	const merged = mergeAiWayIntoConfig(existing, "aiway", "http://192.168.77.88/v1", "", models);
	assert.ok(merged.providers.other);
	assert.equal(merged.providers.other.models[0].id, "keep-me");
	assert.equal(merged.providers.aiway.apiKey, "sk-existing");
	assert.equal(merged.providers.aiway.baseUrl, "http://192.168.77.88/v1");
	assert.equal(merged.providers.aiway.api, "openai-completions");
	assert.equal(merged.providers.aiway.auth, "apiKey");
	assert.equal(merged.providers.aiway.models.length, 2);
	assert.equal(merged.providers.aiway.models[0].id, "claude-sonnet-5");
});

test("buildAiWayProviderConfig: provider-level openai-completions fallback", () => {
	const cfg = buildAiWayProviderConfig({
		baseUrl: "http://x/v1/",
		apiKey: "sk-x",
		models: [],
	});
	assert.equal(cfg.api, "openai-completions");
	assert.equal(cfg.baseUrl, "http://x/v1");
	assert.equal(cfg.auth, "apiKey");
});
