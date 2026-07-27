import { NextResponse } from "next/server";

import type {
	McpAction,
	McpServerConfigInput,
	McpWritableScope,
} from "@/lib/api-types";
import {
	addMcpServer,
	listMcpServers,
	McpServiceError,
	probeMcpServerList,
	removeMcpServer,
	setMcpEnabled,
	updateMcpServer,
} from "@/lib/mcp-service";

export const dynamic = "force-dynamic";

function isMcpAction(value: unknown): value is McpAction {
	return (
		value === "add" ||
		value === "update" ||
		value === "remove" ||
		value === "enable" ||
		value === "disable" ||
		value === "probe"
	);
}

function readWritableScope(scope: unknown): McpWritableScope | null {
	if (scope === "user" || scope === "project") return scope;
	return null;
}

function asConfigInput(value: unknown): McpServerConfigInput | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as McpServerConfigInput;
}

function errorResponse(error: unknown): NextResponse {
	if (error instanceof McpServiceError) {
		return NextResponse.json({ error: error.message }, { status: error.status });
	}
	// Never log request bodies (may contain secrets); return message only.
	const message =
		error instanceof Error ? error.message : "Internal server error";
	return NextResponse.json({ error: message }, { status: 500 });
}

/** GET /api/mcp?cwd= → redacted { servers, diagnostics } */
export async function GET(req: Request) {
	const { searchParams } = new URL(req.url);
	const cwd = searchParams.get("cwd");
	if (!cwd) {
		return NextResponse.json({ error: "cwd required" }, { status: 400 });
	}

	try {
		return NextResponse.json(await listMcpServers(cwd));
	} catch (error) {
		return errorResponse(error);
	}
}

/**
 * POST /api/mcp body: { action, cwd, name, ... }
 * actions: add|update|remove|enable|disable|probe
 * Client never sends writable filesystem paths — only scope + name
 * (+ optional sourcePath as opaque identity for disambiguation).
 */
export async function POST(req: Request) {
	try {
		const body = (await req.json()) as {
			action?: unknown;
			cwd?: unknown;
			name?: unknown;
			scope?: unknown;
			sourcePath?: unknown;
			config?: unknown;
		};

		if (typeof body.cwd !== "string" || !body.cwd) {
			return NextResponse.json({ error: "cwd required" }, { status: 400 });
		}
		if (!isMcpAction(body.action)) {
			return NextResponse.json(
				{
					error: body.action
						? `Unsupported action: ${String(body.action)}`
						: "action required",
				},
				{ status: 400 },
			);
		}
		if (typeof body.name !== "string" || !body.name) {
			return NextResponse.json({ error: "name required" }, { status: 400 });
		}

		const cwd = body.cwd;
		const name = body.name;
		const sourcePath =
			typeof body.sourcePath === "string" ? body.sourcePath : undefined;
		const action = body.action;

		switch (action) {
			case "add": {
				const scope = readWritableScope(body.scope);
				if (!scope) {
					return NextResponse.json(
						{ error: "scope must be user or project" },
						{ status: 400 },
					);
				}
				const config = asConfigInput(body.config);
				if (!config) {
					return NextResponse.json({ error: "config required" }, { status: 400 });
				}
				return NextResponse.json(
					await addMcpServer({ cwd, scope, name, config }),
				);
			}
			case "update": {
				const scope = readWritableScope(body.scope);
				if (!scope) {
					return NextResponse.json(
						{ error: "scope must be user or project" },
						{ status: 400 },
					);
				}
				const config = asConfigInput(body.config);
				if (!config) {
					return NextResponse.json({ error: "config required" }, { status: 400 });
				}
				return NextResponse.json(
					await updateMcpServer({ cwd, scope, name, config, sourcePath }),
				);
			}
			case "remove": {
				const scope = readWritableScope(body.scope);
				if (!scope) {
					return NextResponse.json(
						{ error: "scope must be user or project" },
						{ status: 400 },
					);
				}
				return NextResponse.json(await removeMcpServer({ cwd, scope, name }));
			}
			case "enable":
				return NextResponse.json(
					await setMcpEnabled({ cwd, name, enabled: true, sourcePath }),
				);
			case "disable":
				return NextResponse.json(
					await setMcpEnabled({ cwd, name, enabled: false, sourcePath }),
				);
			case "probe":
				return NextResponse.json(
					await probeMcpServerList({ cwd, name, sourcePath }),
				);
			default: {
				const _never: never = action;
				return NextResponse.json(
					{ error: `Unsupported action: ${String(_never)}` },
					{ status: 400 },
				);
			}
		}
	} catch (error) {
		return errorResponse(error);
	}
}
