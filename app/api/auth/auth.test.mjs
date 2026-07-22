/**
 * Auth route helpers — factory AuthStorage, secret redaction.
 * Run: bun test app/api/auth/auth.test.mjs
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getOmpRuntime, resetOmpRuntimeForTests } from "../../../lib/omp-runtime.ts";
import {
	assertNoSecrets,
	buildAuthStatus,
	listApiKeyProviders,
	listOauthProviders,
	redactErrorMessage,
	sourceFromOrigin,
} from "./_lib.ts";

function makeAgentDir(label) {
	const root = mkdtempSync(join(tmpdir(), `pi-web-auth-${label}-`));
	const agentDir = join(root, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	return { root, agentDir };
}

test.afterEach(async () => {
	await resetOmpRuntimeForTests();
});

test("listOauthProviders returns { providers shape fields } without secrets", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("oauth-list");
	try {
		const runtime = await getOmpRuntime(agentDir);
		// When
		const providers = listOauthProviders(runtime);
		// Then
		assert.ok(Array.isArray(providers));
		assert.ok(providers.length > 0);
		for (const p of providers) {
			assert.equal(typeof p.id, "string");
			assert.equal(typeof p.name, "string");
			assert.equal(typeof p.usesCallbackServer, "boolean");
			assert.equal(typeof p.loggedIn, "boolean");
		}
		assertNoSecrets({ providers });
		assert.ok(providers.some((p) => p.id === "github-copilot" || p.id === "openai-codex"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("listApiKeyProviders returns configured/source/modelCount without raw keys", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("api-list");
	try {
		const runtime = await getOmpRuntime(agentDir);
		// When
		const providers = listApiKeyProviders(runtime);
		// Then
		assert.ok(Array.isArray(providers));
		assert.ok(providers.length > 0);
		for (const p of providers) {
			assert.equal(typeof p.id, "string");
			assert.equal(typeof p.displayName, "string");
			assert.equal(typeof p.configured, "boolean");
			assert.equal(typeof p.modelCount, "number");
		}
		assertNoSecrets({ providers });
		assert.ok(providers.some((p) => p.id === "together" || p.id === "openrouter"));
		assert.ok(!providers.some((p) => p.id === "github-copilot"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("buildAuthStatus never includes credential key after set", async () => {
	// Given
	const { root, agentDir } = makeAgentDir("status");
	try {
		const runtime = await getOmpRuntime(agentDir);
		const secret = "sk-test-secret-key-value-do-not-leak-1234567890";
		await runtime.authStorage.set("openai", {
			type: "api_key",
			key: secret,
			source: "login",
		});
		// When
		const status = buildAuthStatus(runtime, "openai");
		// Then
		assert.equal(status.configured, true);
		assert.equal(status.provider, "openai");
		const json = JSON.stringify(status);
		assert.equal(json.includes(secret), false);
		assert.equal(json.includes("sk-test"), false);
		assertNoSecrets(status);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("assertNoSecrets rejects payloads with key fields", () => {
	// Given / When / Then
	assert.throws(() => assertNoSecrets({ key: "sk-abc" }), /Secret field leaked/);
	assert.throws(() => assertNoSecrets({ nested: { apiKey: "x" } }), /Secret field leaked/);
	assert.doesNotThrow(() =>
		assertNoSecrets({ providers: [{ id: "x", configured: true, source: "login" }] }),
	);
});

test("redactErrorMessage strips sk- tokens, Bearer headers, and labeled secrets", () => {
	// Given
	const withSk = "upstream rejected sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
	const labeled = "Invalid api_key=sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and bearer: supersecrettokenvalue1234567890abcd";
	const withBearer = "Authorization failed Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
	// When
	const redactedSk = redactErrorMessage(withSk);
	const redactedLabeled = redactErrorMessage(labeled);
	const redactedBearer = redactErrorMessage(withBearer);
	// Then
	assert.equal(redactedSk.includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
	assert.match(redactedSk, /sk-\*\*\*/);
	assert.equal(redactedLabeled.includes("sk-live-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345"), false);
	assert.equal(redactedLabeled.includes("supersecrettokenvalue1234567890abcd"), false);
	assert.equal(redactedBearer.includes("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"), false);
	assert.match(redactedBearer, /Bearer \*\*\*/);
});

test("sourceFromOrigin maps kinds without secrets", () => {
	assert.equal(sourceFromOrigin(undefined), undefined);
	assert.equal(sourceFromOrigin({ kind: "api_key" }), "login");
	assert.equal(sourceFromOrigin({ kind: "oauth" }), "oauth");
	assert.equal(sourceFromOrigin({ kind: "config" }), "models_json_key");
	assert.equal(sourceFromOrigin({ kind: "env", envVar: "OPENAI_API_KEY" }), "env:OPENAI_API_KEY");
});
