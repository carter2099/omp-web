import {
	assertNoSecrets,
	getAuthRuntime,
	listOauthProviders,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
	const runtime = await getAuthRuntime();
	const providers = listOauthProviders(runtime);
	const body = { providers };
	assertNoSecrets(body);
	return Response.json(body);
}
