import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import {
	getAuthRuntime,
	isOauthLoginProvider,
	redactErrorMessage,
	afterAuthMutation,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(
	_req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { provider } = await params;
	if (!isOauthLoginProvider(provider)) {
		return Response.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
	}

	// no-excuse-ok: catch — HTTP boundary
	try {
		const runtime = await getAuthRuntime();
		await runtime.authStorage.logout(provider);
		await afterAuthMutation(runtime, provider);
		return Response.json({ ok: true });
	} catch (error) {
		if (error instanceof LoginCancelledError) {
			return Response.json({ error: "cancelled" }, { status: 400 });
		}
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: redactErrorMessage(message) }, { status: 500 });
	}
}
