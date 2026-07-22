import type { CredentialOrigin } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { getProviderDefinition, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai/registry";
import type { OmpRuntime } from "@/lib/omp-runtime";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { invalidateModelsCache } from "@/lib/models-cache";
import { redactSecrets } from "@/lib/redact-secrets";

export type OAuthProviderDto = {
	readonly id: string;
	readonly name: string;
	readonly usesCallbackServer: boolean;
	readonly loggedIn: boolean;
};

export type ApiKeyProviderDto = {
	readonly id: string;
	readonly displayName: string;
	readonly configured: boolean;
	readonly source?: string;
	readonly modelCount: number;
};

export type AuthStatusDto = {
	readonly provider: string;
	readonly displayName: string;
	readonly configured: boolean;
	readonly source?: string;
	readonly models: number;
};

const CONFIG_ORIGIN: CredentialOrigin["kind"] = "config";

const SECRET_RESPONSE_KEYS = new Set([
	"key",
	"apiKey",
	"api_key",
	"access",
	"refresh",
	"accessToken",
	"refreshToken",
	"secret",
	"password",
]);

export async function getAuthRuntime(): Promise<OmpRuntime> {
	return getOmpRuntime();
}

export function isOauthLoginProvider(providerId: string): boolean {
	const def = getProviderDefinition(providerId);
	return Boolean(def?.login && def.refreshToken);
}

export function hasLoginFlow(providerId: string): boolean {
	return Boolean(getProviderDefinition(providerId)?.login);
}

export function providerDisplayName(providerId: string): string {
	const def = getProviderDefinition(providerId);
	if (def?.name) return def.name;
	const oauth = getOAuthProviders().find((p) => p.id === providerId);
	return oauth?.name ?? providerId;
}

export function sourceFromOrigin(origin: CredentialOrigin | undefined): string | undefined {
	if (!origin) return undefined;
	switch (origin.kind) {
		case "runtime":
			return "runtime";
		case "config":
			return "models_json_key";
		case "oauth":
			return "oauth";
		case "api_key":
			return "login";
		case "env":
			return origin.envVar ? `env:${origin.envVar}` : "env";
		case "fallback":
			return "fallback";
		default: {
			const _exhaustive: never = origin.kind;
			return _exhaustive;
		}
	}
}

export function modelCountForProvider(runtime: OmpRuntime, providerId: string): number {
	const def = getProviderDefinition(providerId);
	const storeAs = def?.storeCredentialsAs ?? providerId;
	let count = 0;
	for (const model of runtime.modelRegistry.getAll()) {
		if (model.provider === providerId || model.provider === storeAs) count += 1;
	}
	return count;
}

/** Status DTO only — never calls getApiKey / get() credential payloads. */
export function buildAuthStatus(runtime: OmpRuntime, providerId: string): AuthStatusDto {
	const origin = runtime.authStorage.getCredentialOrigin(providerId);
	return {
		provider: providerId,
		displayName: providerDisplayName(providerId),
		configured: runtime.authStorage.hasAuth(providerId),
		source: sourceFromOrigin(origin),
		models: modelCountForProvider(runtime, providerId),
	};
}

export function listOauthProviders(runtime: OmpRuntime): readonly OAuthProviderDto[] {
	const byId = new Map(PROVIDER_REGISTRY.map((p) => [p.id, p]));
	return getOAuthProviders()
		.filter((p) => {
			const def = byId.get(p.id);
			return Boolean(def?.login && def.refreshToken);
		})
		.map((p) => {
			const def = byId.get(p.id);
			const storeId = def?.storeCredentialsAs ?? p.id;
			return {
				id: p.id,
				name: p.name,
				usesCallbackServer: typeof def?.callbackPort === "number",
				loggedIn: runtime.authStorage.hasOAuth(storeId) || runtime.authStorage.hasOAuth(p.id),
			};
		});
}

export function listApiKeyProviders(runtime: OmpRuntime): readonly ApiKeyProviderDto[] {
	const result: ApiKeyProviderDto[] = [];
	const seen = new Set<string>();

	for (const def of PROVIDER_REGISTRY) {
		if (!def.login || def.refreshToken) continue;
		if (def.showInLoginList === false) continue;
		if (seen.has(def.id)) continue;
		seen.add(def.id);

		const origin = runtime.authStorage.getCredentialOrigin(def.id);
		if (origin?.kind === CONFIG_ORIGIN) continue;

		result.push({
			id: def.id,
			displayName: def.name,
			configured: runtime.authStorage.hasAuth(def.id),
			source: sourceFromOrigin(origin),
			modelCount: modelCountForProvider(runtime, def.id),
		});
	}

	return result;
}

export async function afterAuthMutation(runtime: OmpRuntime, providerId: string): Promise<void> {
	invalidateModelsCache();
	const def = getProviderDefinition(providerId);
	const refreshId = def?.storeCredentialsAs ?? providerId;
	// no-excuse-ok: catch — discovery refresh is best-effort after credential write
	try {
		await runtime.modelRegistry.refreshProvider(refreshId, "online");
	} catch {
		await runtime.invalidateModels();
	}
}

/** Strip credential-shaped substrings from error strings before returning to clients. */
export function redactErrorMessage(message: string): string {
	return redactSecrets(message);
}

/** Fail closed if a response object contains credential field names. */
export function assertNoSecrets(payload: unknown): void {
	const walk = (value: unknown, path: string): void => {
		if (value === null || value === undefined) return;
		if (typeof value !== "object") return;
		if (Array.isArray(value)) {
			value.forEach((item, i) => walk(item, `${path}[${i}]`));
			return;
		}
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const next = path ? `${path}.${k}` : k;
			if (SECRET_RESPONSE_KEYS.has(k)) {
				throw new Error(`Secret field leaked in response: ${next}`);
			}
			walk(v, next);
		}
	};
	walk(payload, "");
}
