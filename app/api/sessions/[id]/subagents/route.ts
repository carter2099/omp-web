import { NextResponse } from "next/server";
import { listSubagentHistory } from "@/lib/subagent-history";
import { redactSecrets } from "@/lib/redact-secrets";
import { isSubagentCommandError } from "@/lib/subagent-types";
import { resolveSessionPath } from "@/lib/session-reader";

/**
 * GET /api/sessions/[id]/subagents
 *
 * Cold SubAgent history for a parent session. Walks only under the parent
 * artifacts root (path containment via listSubagentHistory — never
 * collectSubSessions). Returns metadata rows only; no full transcripts.
 *
 * - 404 if parent session id is unknown
 * - 200 [] if artifacts dir missing / empty
 * - 400/500 when path helpers surface SubagentCommandError
 */
export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	try {
		const filePath = await resolveSessionPath(id);
		if (!filePath) {
			return NextResponse.json({ error: "Session not found" }, { status: 404 });
		}

		// Containment-aware metadata walker; asserts each candidate before open.
		const subagents = listSubagentHistory(filePath);
		return NextResponse.json(subagents);
	} catch (error) {
		// no-excuse-ok: catch — HTTP boundary maps typed errors to status codes
		if (isSubagentCommandError(error)) {
			const status = error.statusCode;
			const message =
				status >= 500 ? redactSecrets(error.message) : error.message;
			return NextResponse.json({ error: message }, { status });
		}
		const raw = error instanceof Error ? error.message : String(error);
		return NextResponse.json(
			{ error: redactSecrets(raw) },
			{ status: 500 },
		);
	}
}
