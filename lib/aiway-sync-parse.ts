import type { AiWayCapabilities, AiWayModelItem, AiWayPricing } from "@/lib/aiway-sync";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringArray(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.filter((x): x is string => typeof x === "string");
}

function numField(obj: Record<string, unknown>, key: string): number | undefined {
	const v = obj[key];
	return typeof v === "number" ? v : undefined;
}

function strField(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

function parseCapabilities(value: unknown): AiWayCapabilities | undefined {
	if (!isRecord(value)) return undefined;
	return {
		effort_levels: optionalStringArray(value.effort_levels),
		default_effort: strField(value, "default_effort"),
		default_thinking_type: strField(value, "default_thinking_type"),
		context_window: numField(value, "context_window"),
		max_output: numField(value, "max_output"),
		input_modalities: optionalStringArray(value.input_modalities),
	};
}

function parsePricing(value: unknown): AiWayPricing | undefined {
	if (!isRecord(value)) return undefined;
	return {
		input: numField(value, "input"),
		output: numField(value, "output"),
		cache_read: numField(value, "cache_read"),
		cache_write: numField(value, "cache_write"),
	};
}

export function parseAiWayListPayload(payload: unknown): AiWayModelItem[] {
	if (!isRecord(payload)) throw new Error("AI Way /models response must be a JSON object");
	if (!Array.isArray(payload.data)) throw new Error("AI Way /models response missing data array");
	const items: AiWayModelItem[] = [];
	for (const raw of payload.data) {
		if (!isRecord(raw) || typeof raw.id !== "string") continue;
		items.push({
			id: raw.id,
			display_name: strField(raw, "display_name"),
			native_endpoint_types: optionalStringArray(raw.native_endpoint_types),
			supported_endpoint_types: optionalStringArray(raw.supported_endpoint_types),
			capabilities: parseCapabilities(raw.capabilities),
			pricing: parsePricing(raw.pricing),
		});
	}
	return items;
}
