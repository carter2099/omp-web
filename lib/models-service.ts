import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { completeSimple, type AssistantMessage, type Model } from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { isAuthenticated } from "@oh-my-pi/pi-coding-agent";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import {
	filterAvailableModelsByEnabledPatterns,
	resolveModelRoleValue,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";

import { invalidateModelsCache, type ModelsData } from "@/lib/models-cache";
import { disposeOmpRuntime, getOmpRuntime, type OmpRuntime } from "@/lib/omp-runtime";
import { redactSecrets } from "@/lib/redact-secrets";

export { redactSecrets };

const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export type ModelsConfigPayload = {
	readonly providers?: Readonly<Record<string, unknown>>;
};

export type ModelTestRequest = {
	readonly providerName: string;
	readonly provider: Readonly<Record<string, unknown>>;
	readonly model: Readonly<Record<string, unknown>>;
};

export type ModelTestResult =
	| {
			readonly ok: true;
			readonly latencyMs: number;
			readonly status: number | undefined;
			readonly responseText: string;
	  }
	| {
			readonly ok: false;
			readonly error: string;
			readonly latencyMs?: number;
			readonly status?: number;
	  };

const TEST_TIMEOUT_MS = 20_000;

export function getModelsYmlPath(agentDir: string): string {
	return path.join(path.resolve(agentDir), "models.yml");
}

function compareModelEntries(
	a: { id: string; name: string; provider: string },
	b: { id: string; name: string; provider: string },
): number {
	return (
		modelNameCollator.compare(a.name || a.id, b.name || b.id) ||
		modelNameCollator.compare(a.provider, b.provider) ||
		modelNameCollator.compare(a.id, b.id)
	);
}

function modelKey(provider: string, id: string): string {
	return `${provider}:${id}`;
}

function thinkingLevelMapFor(model: Model): Record<string, string | null> | undefined {
	const routing = model.thinking?.effortRouting;
	if (!routing) return undefined;
	const out: Record<string, string | null> = {};
	for (const [level, target] of Object.entries(routing)) {
		out[level] = target ?? null;
	}
	return out;
}

export async function loadModelsData(cwd: string, runtime: OmpRuntime): Promise<ModelsData> {
	const settings = await runtime.getSettingsForCwd(cwd);
	const available = runtime.modelRegistry.getAvailable();
	const patterns = settings.get("enabledModels");
	const visible =
		patterns && patterns.length > 0
			? filterAvailableModelsByEnabledPatterns(available, patterns, settings)
			: available;

	const nameMap = new Map<string, string>();
	const thinkingLevels: Record<string, string[]> = {};
	const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};

	const modelList = visible
		.map((m) => ({
			id: m.id,
			name: m.name,
			provider: m.provider,
		}))
		.sort(compareModelEntries);

	for (const m of visible) {
		const key = modelKey(m.provider, m.id);
		nameMap.set(key, m.name);
		thinkingLevels[key] = [...getSupportedEfforts(m)];
		const levelMap = thinkingLevelMapFor(m);
		if (levelMap) thinkingLevelMaps[key] = levelMap;
	}

	const roleValue = settings.getModelRole("default");
	const resolved = resolveModelRoleValue(roleValue, visible, { settings });
	const defaultModel =
		resolved.model !== undefined
			? { provider: resolved.model.provider, modelId: resolved.model.id }
			: null;

	return {
		models: Object.fromEntries(nameMap),
		modelList,
		defaultModel,
		thinkingLevels,
		thinkingLevelMaps,
	};
}

export function readModelsConfig(agentDir: string): ModelsConfigPayload {
	const modelsPath = getModelsYmlPath(agentDir);
	const file = ModelsConfigFile.relocate(modelsPath);
	const loaded = file.load();
	if (loaded === null) return { providers: {} };
	return { providers: loaded.providers ?? {} };
}

export class ModelsConfigWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelsConfigWriteError";
	}
}

export function writeModelsConfig(agentDir: string, data: unknown): void {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new ModelsConfigWriteError("models config must be a JSON object");
	}

	const modelsPath = getModelsYmlPath(agentDir);
	mkdirSync(path.dirname(modelsPath), { recursive: true });
	writeFileSync(modelsPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");

	const file = ModelsConfigFile.relocate(modelsPath);
	file.invalidate();
	const result = file.tryLoad();
	if (result.status === "error") {
		throw new ModelsConfigWriteError(result.error.message);
	}
}

export async function saveModelsConfig(runtime: OmpRuntime, data: unknown): Promise<void> {
	writeModelsConfig(runtime.agentDir, data);
	await runtime.invalidateModels();
	invalidateModelsCache();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function getAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/**
 * Probe a provider/model from an isolated models.yml under agentDir.
 * Opens a factory runtime for agentDir and always disposes it in finally —
 * callers that own a temp agentDir may rmdir only after this promise settles.
 */
export async function testModelFromConfig(
	agentDir: string,
	request: ModelTestRequest,
): Promise<ModelTestResult> {
	writeModelsConfig(agentDir, {
		providers: {
			[request.providerName]: {
				...request.provider,
				models: [{ ...request.model, id: request.model.id }],
			},
		},
	});

	const runtime = await getOmpRuntime(agentDir);

	try {
		await runtime.invalidateModels();

		const registry = runtime.modelRegistry;
		const modelId = String(request.model.id);
		const model = registry.find(request.providerName, modelId);
		if (!model) {
			return {
				ok: false,
				error: redactSecrets(`Model not found: ${request.providerName}/${modelId}`),
			};
		}

		const apiKey = await registry.getApiKey(model);
		if (!isAuthenticated(apiKey)) {
			return {
				ok: false,
				error: redactSecrets(`No API key found for "${request.providerName}"`),
			};
		}

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
		let status: number | undefined;
		const startedAt = Date.now();

		try {
			const message = await completeSimple(
				model,
				{
					messages: [
						{
							role: "user",
							content: "Reply with OK only.",
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: registry.resolver(model),
					maxTokens: 16,
					cacheRetention: "none",
					signal: controller.signal,
					streamFirstEventTimeoutMs: TEST_TIMEOUT_MS,
					streamIdleTimeoutMs: TEST_TIMEOUT_MS,
					onResponse: (response) => {
						status = response.status;
					},
				},
			);

			const latencyMs = Date.now() - startedAt;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const raw =
					message.errorMessage ??
					(controller.signal.aborted ? "Test timed out" : "Model returned an error");
				return {
					ok: false,
					error: redactSecrets(raw),
					latencyMs,
					status,
				};
			}

			return {
					ok: true,
					latencyMs,
					status,
					responseText: redactSecrets(getAssistantText(message).slice(0, 300)),
				};
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		// no-excuse-ok: catch — model test is a boundary that returns { ok:false }
		return { ok: false, error: redactSecrets(errorMessage(error)) };
	} finally {
		// Evict factory slot + close AuthStorage before caller may rmdir agentDir.
		await disposeOmpRuntime(agentDir);
	}
}

export function parseModelTestBody(body: unknown): ModelTestRequest | { error: string; status: 400 } {
	if (!isRecord(body)) return { error: "JSON body is required", status: 400 };

	const providerName = typeof body.providerName === "string" ? body.providerName.trim() : "";
	if (!providerName) return { error: "providerName is required", status: 400 };
	if (!isRecord(body.provider)) return { error: "provider is required", status: 400 };
	if (!isRecord(body.model)) return { error: "model is required", status: 400 };

	const modelId = typeof body.model.id === "string" ? body.model.id.trim() : "";
	if (!modelId) return { error: "Model ID is required", status: 400 };

	return {
		providerName,
		provider: body.provider,
		model: { ...body.model, id: modelId },
	};
}
