import { NextResponse } from "next/server";
import { resolveSessionPath, readSessionHeader } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { redactSecrets } from "@/lib/redact-secrets";
import { isSubagentCommandError } from "@/lib/subagent-types";

function errorStatusCode(error: unknown): number {
  if (isSubagentCommandError(error)) {
    return error.statusCode;
  }
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const code = (error as { statusCode: unknown }).statusCode;
    if (code === 400 || code === 404 || code === 500) {
      return code;
    }
  }
  // Untyped Error for unsupported/unknown command shapes → 400
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      msg.includes("unsupported command")
      || msg.includes("unknown command")
      || msg.startsWith("unsupported ")
      || msg.startsWith("unknown ")
    ) {
      return 400;
    }
  }
  return 500;
}

function errorMessage(error: unknown, status: number): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 500 bodies must never leak secrets; redact all client-facing error text.
  if (status >= 500) {
    return redactSecrets(raw);
  }
  return redactSecrets(raw);
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let body: { type: string; [key: string]: unknown };
  try {
    body = await req.json() as { type: string; [key: string]: unknown };
  } catch {
    // no-excuse-ok: catch — malformed JSON body is a client error
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      return NextResponse.json({ success: true, data: result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const cwd = readSessionHeader(filePath)?.cwd ?? process.cwd();

    const { session } = await startRpcSession(id, filePath, cwd);
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    // no-excuse-ok: catch — HTTP boundary maps typed statusCode to 400/404/500
    const status = errorStatusCode(error);
    return NextResponse.json({ error: errorMessage(error, status) }, { status });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    // no-excuse-ok: catch — HTTP boundary maps typed statusCode to 400/404/500
    const status = errorStatusCode(error);
    return NextResponse.json({ error: errorMessage(error, status) }, { status });
  }
}
