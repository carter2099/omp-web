import { parseAiWayListPayload } from "@/lib/aiway-sync-parse";

export type AiWayModelApi = "anthropic-messages" | "openai-responses" | "openai-completions";
export type ModelsConfigLike = { readonly providers?: Readonly<Record<string, unknown>> };
export type OmpEffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelInputModality = "text" | "image";

export type AiWayCapabilities = {
	readonly effort_levels?: readonly string[];
	readonly default_effort?: string;
	readonly default_thinking_type?: string;
	readonly context_window?: number;
	readonly max_output?: number;
	readonly input_modalities?: readonly string[];
};

export type AiWayPricing = {
	readonly input?: number;
	readonly output?: number;
	readonly cache_read?: number;
	readonly cache_write?: number;
};

export type AiWayModelItem = {
	readonly id: string;
	readonly display_name?: string;
	readonly native_endpoint_types?: readonly string[];
	readonly supported_endpoint_types?: readonly string[];
	readonly capabilities?: AiWayCapabilities;
	readonly pricing?: AiWayPricing;
};

export type ModelThinkingConfig = {
	readonly mode: "effort" | "anthropic-adaptive";
	readonly efforts: readonly OmpEffortLevel[];
	readonly defaultLevel?: OmpEffortLevel;
};

export type ModelCost = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
};

export type ModelEntry = {
	readonly id: string;
	readonly name: string;
	readonly api: AiWayModelApi;
	readonly reasoning: boolean;
	readonly input: readonly ModelInputModality[];
	readonly contextWindow: number;
	readonly maxTokens: number;
	readonly cost: ModelCost;
	readonly thinking?: ModelThinkingConfig;
};

export type AiWayProviderConfig = {
	readonly baseUrl: string;
	readonly api: "openai-completions";
	readonly apiKey: string;
	readonly auth: "apiKey";
	readonly models: readonly ModelEntry[];
};

export type FetchAiWayModelsResult = {
	readonly models: ModelEntry[];
	readonly skipped: number;
	readonly byApi: Record<string, number>;
};

export type FetchImpl = (
	input: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const OMP_EFFORTS = new Set<string>(["minimal", "low", "medium", "high", "xhigh", "max"]);
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function isOmpEffort(value: string): value is OmpEffortLevel {
	return OMP_EFFORTS.has(value);
}

function asFiniteNumber(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapNativeEndpointToApi(native: readonly string[]): AiWayModelApi | null {
	const set = new Set(native.map((s) => s.toLowerCase()));
	if (set.has("messages")) return "anthropic-messages";
	if (set.has("responses")) return "openai-responses";
	if (set.has("completions")) return "openai-completions";
	return null;
}

export function shouldSkipModelId(id: string): boolean {
	const lower = id.toLowerCase();
	return (
		lower.includes("embedding") ||
		lower.includes("rerank") ||
		lower.endsWith("-fim") ||
		lower.includes("-fim-") ||
		lower.includes(".fim")
	);
}

function filterEfforts(levels: readonly string[] | undefined): OmpEffortLevel[] {
	if (!levels?.length) return [];
	const out: OmpEffortLevel[] = [];
	for (const level of levels) {
		if (isOmpEffort(level) && !out.includes(level)) out.push(level);
	}
	return out;
}

function mapInputModalities(modalities: readonly string[] | undefined): ModelInputModality[] {
	const out: ModelInputModality[] = [];
	for (const m of modalities ?? ["text"]) {
		if ((m === "text" || m === "image") && !out.includes(m)) out.push(m);
	}
	return out.length > 0 ? out : ["text"];
}

function mapCost(pricing: AiWayPricing | undefined): ModelCost {
	return {
		input: asFiniteNumber(pricing?.input, 0),
		output: asFiniteNumber(pricing?.output, 0),
		cacheRead: asFiniteNumber(pricing?.cache_read, 0),
		cacheWrite: asFiniteNumber(pricing?.cache_write, 0),
	};
}

function mapThinking(
	api: AiWayModelApi,
	caps: AiWayCapabilities | undefined,
): ModelThinkingConfig | undefined {
	const efforts = filterEfforts(caps?.effort_levels);
	if (efforts.length === 0) return undefined;
	const mode: ModelThinkingConfig["mode"] =
		api === "anthropic-messages" && caps?.default_thinking_type === "adaptive"
			? "anthropic-adaptive"
			: "effort";
	const defaultRaw = caps?.default_effort;
	const defaultLevel =
		typeof defaultRaw === "string" && isOmpEffort(defaultRaw) && efforts.includes(defaultRaw)
			? defaultRaw
			: undefined;
	return defaultLevel !== undefined ? { mode, efforts, defaultLevel } : { mode, efforts };
}

export function mapAiWayItemToModelEntry(item: AiWayModelItem): ModelEntry | null {
	const id = typeof item.id === "string" ? item.id.trim() : "";
	if (!id || shouldSkipModelId(id)) return null;
	const api = mapNativeEndpointToApi(item.native_endpoint_types ?? []);
	if (api === null) return null;

	const caps = item.capabilities;
	const thinking = mapThinking(api, caps);
	const name =
		typeof item.display_name === "string" && item.display_name.trim() !== ""
			? item.display_name.trim()
			: id;
	const contextWindow = asFiniteNumber(caps?.context_window, DEFAULT_CONTEXT_WINDOW);
	const maxTokens = asFiniteNumber(caps?.max_output, DEFAULT_MAX_TOKENS);

	return {
		id,
		name,
		api,
		reasoning: thinking !== undefined,
		input: mapInputModalities(caps?.input_modalities),
		contextWindow: contextWindow > 0 ? contextWindow : DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS,
		cost: mapCost(item.pricing),
		...(thinking !== undefined ? { thinking } : {}),
	};
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

export function buildAiWayProviderConfig(opts: {
	readonly baseUrl: string;
	readonly apiKey: string;
	readonly models: readonly ModelEntry[];
}): AiWayProviderConfig {
	return {
		baseUrl: normalizeBaseUrl(opts.baseUrl),
		api: "openai-completions",
		apiKey: opts.apiKey,
		auth: "apiKey",
		models: opts.models,
	};
}

const defaultFetch: FetchImpl = async (input, init) => {
	const res = await globalThis.fetch(input, init);
	return { ok: res.ok, status: res.status, text: () => res.text() };
};

export async function fetchAiWayModels(
	baseUrl: string,
	apiKey: string,
	fetchImpl: FetchImpl = defaultFetch,
): Promise<FetchAiWayModelsResult> {
	const url = `${normalizeBaseUrl(baseUrl)}/models`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
			signal: controller.signal,
		});
		const bodyText = await res.text();
		if (!res.ok) throw new Error(`AI Way /models failed: HTTP ${res.status}`);
		let payload: unknown;
		try {
			payload = JSON.parse(bodyText);
		} catch {
			throw new Error("AI Way /models returned invalid JSON");
		}
		const models: ModelEntry[] = [];
		let skipped = 0;
		const byApi: Record<string, number> = {};
		for (const item of parseAiWayListPayload(payload)) {
			const entry = mapAiWayItemToModelEntry(item);
			if (entry === null) {
				skipped += 1;
				continue;
			}
			models.push(entry);
			byApi[entry.api] = (byApi[entry.api] ?? 0) + 1;
		}
		return { models, skipped, byApi };
	} finally {
		clearTimeout(timer);
	}
}

function readExistingApiKey(provider: unknown): string {
	if (!isRecord(provider)) return "";
	return typeof provider.apiKey === "string" ? provider.apiKey : "";
}

export function mergeAiWayIntoConfig(
	existing: ModelsConfigLike,
	providerName: string,
	baseUrl: string,
	apiKey: string,
	modelEntries: readonly ModelEntry[],
): ModelsConfigLike {
	const providers: Record<string, unknown> = { ...(existing.providers ?? {}) };
	const resolvedKey = apiKey.trim() !== "" ? apiKey : readExistingApiKey(providers[providerName]);
	providers[providerName] = buildAiWayProviderConfig({
		baseUrl,
		apiKey: resolvedKey,
		models: modelEntries,
	});
	return { providers };
}
