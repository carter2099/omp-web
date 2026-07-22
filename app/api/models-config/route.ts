import { NextResponse } from "next/server";

import {
	ModelsConfigWriteError,
	readModelsConfig,
	saveModelsConfig,
} from "@/lib/models-service";
import { getOmpRuntime } from "@/lib/omp-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		const runtime = await getOmpRuntime();
		return NextResponse.json(readModelsConfig(runtime.agentDir));
	} catch (error) {
		// no-excuse-ok: catch — HTTP boundary
		return NextResponse.json({ error: String(error) }, { status: 500 });
	}
}

export async function PUT(req: Request) {
	try {
		const body: unknown = await req.json();
		const runtime = await getOmpRuntime();
		await saveModelsConfig(runtime, body);
		return NextResponse.json({ success: true });
	} catch (error) {
		// no-excuse-ok: catch — HTTP boundary
		if (error instanceof ModelsConfigWriteError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		return NextResponse.json({ error: String(error) }, { status: 500 });
	}
}
