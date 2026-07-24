import { NextResponse } from "next/server";

import {
	listPlugins,
	mutatePlugins,
	removePathExtension,
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

function isPathExtensionAction(value: unknown): value is "remove-path" {
	return value === "remove-path";
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

// POST /api/plugins body: { action, source?, path?, scope?, cwd }
// path actions: remove-path (Settings extensions)
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action?: unknown;
			source?: unknown;
			path?: unknown;
			scope?: unknown;
			cwd?: unknown;
		};

		if (typeof body.cwd !== "string" || !body.cwd) {
			return NextResponse.json({ error: "cwd required" }, { status: 400 });
		}

		const runtime = await getOmpRuntime();

		if (isPathExtensionAction(body.action)) {
			const pathValue =
				typeof body.path === "string"
					? body.path
					: typeof body.source === "string"
						? body.source
						: "";
			const result = await removePathExtension(body.cwd, pathValue, runtime);
			return NextResponse.json(result);
		}

		if (!isPluginAction(body.action)) {
			return NextResponse.json(
				{ error: body.action ? `Unsupported action: ${String(body.action)}` : "action required" },
				{ status: 400 },
			);
		}

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
