import { NextResponse } from "next/server";

import {
	ModelsConfigWriteError,
	redactSecrets,
	syncAiWayProvider,
} from "@/lib/models-service";
import { getOmpRuntime } from "@/lib/omp-runtime";

export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(req: Request) {
	try {
		const body: unknown = await req.json();
		if (!isRecord(body)) {
			return NextResponse.json({ error: "JSON body is required" }, { status: 400 });
		}

		const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
		if (!baseUrl) {
			return NextResponse.json({ error: "baseUrl is required" }, { status: 400 });
		}

		const providerName =
			typeof body.providerName === "string" ? body.providerName.trim() : undefined;
		const apiKey = typeof body.apiKey === "string" ? body.apiKey : undefined;

		const runtime = await getOmpRuntime();
		const result = await syncAiWayProvider(runtime, {
			providerName: providerName || undefined,
			baseUrl,
			apiKey,
		});

		return NextResponse.json({
			success: true,
			providerName: result.providerName,
			modelCount: result.modelCount,
			byApi: result.byApi,
			skipped: result.skipped,
		});
	} catch (error) {
		// no-excuse-ok: catch — HTTP boundary
		if (error instanceof ModelsConfigWriteError) {
			return NextResponse.json(
				{ error: redactSecrets(error.message) },
				{ status: 400 },
			);
		}
		const raw = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ error: redactSecrets(raw) }, { status: 500 });
	}
}
