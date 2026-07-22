import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import { loadModelsWithCache, type ModelsData } from "@/lib/models-cache";
import { loadModelsData } from "@/lib/models-service";
import { getOmpRuntime } from "@/lib/omp-runtime";

export const dynamic = "force-dynamic";

const EMPTY_MODELS: ModelsData = {
	models: {},
	modelList: [],
	defaultModel: null,
	thinkingLevels: {},
	thinkingLevelMaps: {},
};

export async function GET(req: Request) {
	const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
	const cwd = resolve(requestedCwd);

	let cwdStat;
	try {
		cwdStat = await stat(cwd);
	} catch {
		return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
	}
	if (!cwdStat.isDirectory()) {
		return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
	}

	try {
		const runtime = await getOmpRuntime();
		return Response.json(
			await loadModelsWithCache(cwd, () => loadModelsData(cwd, runtime)),
		);
	} catch {
		// no-excuse-ok: catch — HTTP boundary; empty catalog is a safe degraded response
		return Response.json(EMPTY_MODELS);
	}
}
