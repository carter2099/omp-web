/**
 * Strip credential-shaped substrings from text before returning to clients.
 * Covers sk-* keys, Bearer tokens, api_key/token assignments, and long secret-like tokens.
 */
export function redactSecrets(text: string): string {
	return text
		.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, "sk-***")
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer ***")
		.replace(/\b(api[_-]?key|token|secret|bearer)\s*[:=]\s*\S+/gi, "$1=***")
		.replace(/\b[A-Za-z0-9+/_-]{40,}\b/g, (match) => {
			// Keep UUID-shaped ids readable; redact long base64/token blobs.
			if (/^[a-f0-9-]{36}$/i.test(match)) return match;
			return "***";
		});
}
