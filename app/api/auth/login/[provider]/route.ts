import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import {
	afterAuthMutation,
	getAuthRuntime,
	isOauthLoginProvider,
	redactErrorMessage,
} from "../../_lib";

export const dynamic = "force-dynamic";

declare global {
	// eslint-disable-next-line no-var
	var __piLoginCallbacks:
		| Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>
		| undefined;
}

function getCallbackRegistry() {
	if (!globalThis.__piLoginCallbacks) globalThis.__piLoginCallbacks = new Map();
	return globalThis.__piLoginCallbacks;
}

export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { provider } = await params;
	const body = (await req.json()) as { token?: string; code?: string };
	const { token, code } = body;

	if (!token || !code) {
		return Response.json({ error: "token and code required" }, { status: 400 });
	}

	const registry = getCallbackRegistry();
	const callbacks = registry.get(token);
	if (!callbacks) {
		return Response.json({ error: "No pending login for token" }, { status: 404 });
	}
	if (!token.startsWith(`${provider}-`)) {
		return Response.json({ error: "Token does not match provider" }, { status: 400 });
	}

	callbacks.resolve(code);
	registry.delete(token);
	return Response.json({ ok: true, provider });
}

export async function GET(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { provider } = await params;

	if (!isOauthLoginProvider(provider)) {
		return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
	}

	const encoder = new TextEncoder();
	const send = (controller: ReadableStreamDefaultController, data: unknown) => {
		controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
	};

	const abort = new AbortController();
	req.signal.addEventListener("abort", () => abort.abort());

	const stream = new ReadableStream({
		async start(controller) {
			const runtime = await getAuthRuntime();
			const registry = getCallbackRegistry();
			const activeTokens = new Set<string>();
			let pendingManualRequest: { token: string; promise: Promise<string> } | undefined;

			const createClientInputRequest = () => {
				const token = `${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
				activeTokens.add(token);

				const promise = new Promise<string>((resolve, reject) => {
					registry.set(token, {
						resolve: (value) => {
							activeTokens.delete(token);
							registry.delete(token);
							resolve(value);
						},
						reject: (error) => {
							activeTokens.delete(token);
							registry.delete(token);
							reject(error);
						},
					});
				});

				return { token, promise };
			};

			const getManualInputRequest = () => {
				if (!pendingManualRequest) {
					pendingManualRequest = createClientInputRequest();
					pendingManualRequest.promise
						.finally(() => {
							pendingManualRequest = undefined;
						})
						.catch(() => {}); // no-excuse-ok: catch — late cancel after stream closed
				}
				return pendingManualRequest;
			};

			const cleanup = () => {
				for (const token of activeTokens) {
					registry.get(token)?.reject(new Error("Login cancelled"));
					registry.delete(token);
				}
				activeTokens.clear();
			};

			abort.signal.addEventListener("abort", cleanup);

			// no-excuse-ok: catch — SSE boundary maps errors to client events
			try {
				await runtime.authStorage.login(provider, {
					signal: abort.signal,
					onAuth: (info) => {
						const request = getManualInputRequest();
						send(controller, {
							type: "auth",
							url: info.url,
							instructions: info.instructions ?? null,
							token: request.token,
						});
					},
					onPrompt: async (prompt) => {
						const request = createClientInputRequest();
						send(controller, {
							type: "prompt_request",
							message: prompt.message,
							placeholder: prompt.placeholder ?? null,
							token: request.token,
						});
						return request.promise;
					},
					onProgress: (message) => {
						send(controller, { type: "progress", message });
					},
				});

				await afterAuthMutation(runtime, provider);
				send(controller, { type: "success" });
			} catch (err) {
				if (err instanceof LoginCancelledError || abort.signal.aborted) {
					send(controller, { type: "cancelled" });
				} else {
					const msg = err instanceof Error ? err.message : String(err);
					if (msg === "Login cancelled") {
						send(controller, { type: "cancelled" });
					} else {
						send(controller, { type: "error", message: redactErrorMessage(msg) });
					}
				}
			} finally {
				cleanup();
				controller.close();
			}
		},
		cancel() {
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}
