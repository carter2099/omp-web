import type {
	McpServerInfo,
	McpTransportType,
} from "@/lib/api-types";
import { redactSecrets } from "@/lib/redact-secrets";

export type McpSourceLike = {
	name: string;
	enabled?: boolean;
	timeout?: number;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: unknown;
	oauth?: unknown;
	transport?: McpTransportType;
	_source: {
		provider: string;
		path: string;
		level: string;
	};
	_shadowed?: boolean;
};

const CREDENTIAL_QUERY_KEYS = new Set([
	"apikey",
	"api_key",
	"token",
	"access_token",
	"secret",
	"password",
	"key",
	"exaapikey",
	"authorization",
	"auth",
	"bearer",
	"client_secret",
	"clientsecret",
]);

export function scopeFromSource(
	providerId: string,
	level: string,
): McpServerInfo["scope"] {
	if (providerId === "native" || providerId === "mcp-json") {
		if (level === "project") return "project";
		if (level === "user" || level === "native") return "user";
	}
	return "external";
}

export function transportOf(server: {
	transport?: McpTransportType;
	url?: string;
}): McpTransportType {
	if (server.transport === "http" || server.transport === "sse") {
		return server.transport;
	}
	if (server.transport === "stdio") return "stdio";
	if (server.url) return "http";
	return "stdio";
}

export function redactUrl(raw: string | undefined): {
	url?: string;
	urlRedacted: boolean;
} {
	if (!raw) return { urlRedacted: false };
	try {
		const u = new URL(raw);
		let redacted = false;
		if (u.username || u.password) {
			u.username = "";
			u.password = "";
			redacted = true;
		}
		for (const k of [...u.searchParams.keys()]) {
			const lower = k.toLowerCase();
			if (
				CREDENTIAL_QUERY_KEYS.has(lower) ||
				lower.includes("key") ||
				lower.includes("token") ||
				lower.includes("secret")
			) {
				u.searchParams.delete(k);
				redacted = true;
			}
		}
		if (u.hash) {
			u.hash = "";
			redacted = true;
		}
		return {
			url: `${u.origin}${u.pathname}${u.search}`,
			urlRedacted: redacted,
		};
	} catch {
		const stripped = redactSecrets(raw);
		return { url: stripped, urlRedacted: stripped !== raw };
	}
}

export function redactArgs(args: string[] | undefined): {
	args?: string[];
	argsRedacted: boolean;
} {
	if (!args?.length) return { argsRedacted: false };
	let argsRedacted = false;
	const out = args.map((a) => {
		const r = redactSecrets(a);
		if (r !== a) argsRedacted = true;
		return r;
	});
	return { args: out, argsRedacted };
}

export function mapMcpRow(
	server: McpSourceLike,
	opts: {
		disabledServers: Set<string>;
		forcedEnabled: Set<string>;
		settingsDisabled: Set<string>;
		activeNames: Set<string>;
	},
): McpServerInfo {
	const providerId = server._source.provider;
	const scope = scopeFromSource(providerId, server._source.level);
	const shadowed = server._shadowed === true;
	const extId = `mcp:${server.name}`;
	const denylisted = opts.disabledServers.has(server.name);
	const settingsOff = opts.settingsDisabled.has(extId);
	const serverOff =
		server.enabled === false && !opts.forcedEnabled.has(server.name);
	const configuredEnabled = !denylisted && !settingsOff && !serverOff;
	const effectiveForRuntime =
		!shadowed && configuredEnabled && opts.activeNames.has(server.name);

	const { url, urlRedacted } = redactUrl(server.url);
	const { args, argsRedacted } = redactArgs(server.args);
	const envKeys = server.env ? Object.keys(server.env) : [];
	const headerKeys = server.headers ? Object.keys(server.headers) : [];

	return {
		name: server.name,
		scope,
		sourcePath: server._source.path,
		providerId,
		shadowed,
		transport: transportOf(server),
		command: server.command ? redactSecrets(server.command) : undefined,
		args,
		argsRedacted,
		cwd: server.cwd,
		url,
		urlRedacted,
		envKeys,
		hasEnv: envKeys.length > 0,
		headerKeys,
		hasHeaders: headerKeys.length > 0,
		hasAuth: Boolean(server.auth),
		hasOauth: Boolean(server.oauth),
		timeout: server.timeout,
		configuredEnabled,
		effectiveForRuntime,
	};
}
