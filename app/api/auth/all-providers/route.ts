import {
	assertNoSecrets,
	getAuthRuntime,
	listApiKeyProviders,
} from "../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
	const runtime = await getAuthRuntime();
	const providers = listApiKeyProviders(runtime);
	const body = { providers };
	assertNoSecrets(body);
	return Response.json(body);
}
