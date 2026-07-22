import { NextResponse } from "next/server";

import {
	listPlugins,
	mutatePlugins,
	PluginServiceError,
	type PluginAction,
} from "@/lib/plugins-service";
import { getOmpRuntime } from "@/lib/omp-runtime";
import type { PluginScope } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function isPluginAction(value: unknown): value is PluginAction {
	return (
		value === "install" ||
		value === "remove" ||
		value === "update" ||
		value === "enable" ||
		value === "disable"
	);
}

function readScope(scope: unknown): PluginScope {
	return scope === "project" ? "project" : "global";
}

export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const cwd = searchParams.get("cwd");
	if (!cwd) return NextResponse.json({ error: "cwd required" }, { status: 400 });

	try {
		await getOmpRuntime();
		return NextResponse.json(await listPlugins(cwd));
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}
}

// POST /api/plugins body: { action, source?, scope?, cwd }
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action?: unknown;
			source?: unknown;
			scope?: unknown;
			cwd?: unknown;
		};

		if (typeof body.cwd !== "string" || !body.cwd) {
			return NextResponse.json({ error: "cwd required" }, { status: 400 });
		}
		if (!isPluginAction(body.action)) {
			return NextResponse.json(
				{ error: body.action ? `Unsupported action: ${String(body.action)}` : "action required" },
				{ status: 400 },
			);
		}

		const runtime = await getOmpRuntime();
		const result = await mutatePlugins(
			{
				action: body.action,
				cwd: body.cwd,
				source: typeof body.source === "string" ? body.source : undefined,
				scope: readScope(body.scope),
			},
			runtime,
		);
		await runtime.invalidatePlugins(body.cwd);
		return NextResponse.json(result);
	} catch (error) {
		if (error instanceof PluginServiceError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : String(error) },
			{ status: 500 },
		);
	}
}
