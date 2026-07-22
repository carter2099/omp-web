import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import {
	afterAuthMutation,
	assertNoSecrets,
	buildAuthStatus,
	getAuthRuntime,
	hasLoginFlow,
	redactErrorMessage,
} from "../../_lib";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ provider: string }> };

export async function GET(_req: Request, { params }: Params) {
	const { provider } = await params;
	const runtime = await getAuthRuntime();
	const body = buildAuthStatus(runtime, provider);
	assertNoSecrets(body);
	return Response.json(body);
}

export async function POST(req: Request, { params }: Params) {
	const { provider } = await params;
	// no-excuse-ok: catch — HTTP boundary
	try {
		const body = (await req.json()) as { apiKey?: unknown };
		const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
		if (!apiKey) {
			return Response.json({ error: "apiKey is required" }, { status: 400 });
		}

		const runtime = await getAuthRuntime();

		if (hasLoginFlow(provider)) {
			let prompts = 0;
			await runtime.authStorage.login(provider, {
				onAuth: () => {},
				onPrompt: async () => {
					prompts += 1;
					if (prompts === 1) return apiKey;
					throw new Error(`${provider} requires additional authentication settings`);
				},
				onProgress: () => {},
			});
		} else {
			await runtime.authStorage.set(provider, {
				type: "api_key",
				key: apiKey,
				source: "login",
			});
		}

		await afterAuthMutation(runtime, provider);
		return Response.json({ success: true });
	} catch (error) {
		if (error instanceof LoginCancelledError) {
			return Response.json({ error: "cancelled" }, { status: 400 });
		}
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: redactErrorMessage(message) }, { status: 500 });
	}
}

export async function DELETE(_req: Request, { params }: Params) {
	const { provider } = await params;
	// no-excuse-ok: catch — HTTP boundary
	try {
		const runtime = await getAuthRuntime();
		await runtime.authStorage.logout(provider);
		await afterAuthMutation(runtime, provider);
		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: redactErrorMessage(message) }, { status: 500 });
	}
}
