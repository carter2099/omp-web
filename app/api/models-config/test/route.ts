import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NextResponse } from "next/server";

import { parseModelTestBody, redactSecrets, testModelFromConfig } from "@/lib/models-service";

export const dynamic = "force-dynamic";

/**
 * Isolated model probe. Order is mandatory:
 * 1. testModelFromConfig (opens runtime, always disposeOmpRuntime in its finally)
 * 2. return JSON
 * 3. rmdir temp tree (only after dispose has closed AuthStorage/SQLite)
 */
export async function POST(req: Request) {
	let tempRoot: string | undefined;

	try {
		const body: unknown = await req.json();
		const parsed = parseModelTestBody(body);
		if ("error" in parsed) {
			return NextResponse.json(
				{ ok: false, error: redactSecrets(parsed.error) },
				{ status: parsed.status },
			);
		}

		tempRoot = mkdtempSync(join(tmpdir(), "pi-web-model-test-"));
		const agentDir = join(tempRoot, ".omp", "agent");
		mkdirSync(agentDir, { recursive: true });

		// Service owns dispose; do not rmdir until this settles.
		const result = await testModelFromConfig(agentDir, parsed);
		return NextResponse.json(result);
	} catch (error) {
		// no-excuse-ok: catch — HTTP boundary
		const raw = error instanceof Error ? error.message : String(error);
		return NextResponse.json({ ok: false, error: redactSecrets(raw) }, { status: 500 });
	} finally {
		if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
	}
}
