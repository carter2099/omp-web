import { NextRequest, NextResponse } from "next/server";

import {
	isTaskEager,
	getTaskEager,
	setTaskEager,
	TaskEagerError,
} from "@/lib/task-eager";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
	try {
		const cwd = req.nextUrl.searchParams.get("cwd") ?? undefined;
		const eager = await getTaskEager(cwd || undefined);
		return NextResponse.json({ eager });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}

export async function PUT(req: NextRequest) {
	try {
		const body = (await req.json()) as { eager?: unknown; cwd?: unknown };
		if (!isTaskEager(body.eager)) {
			return NextResponse.json(
				{ error: "eager must be default | preferred | always" },
				{ status: 400 },
			);
		}
		const cwd = typeof body.cwd === "string" && body.cwd.length > 0 ? body.cwd : undefined;
		const eager = await setTaskEager(body.eager, cwd);
		return NextResponse.json({ eager });
	} catch (err) {
		if (err instanceof TaskEagerError) {
			return NextResponse.json({ error: err.message }, { status: err.status });
		}
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
