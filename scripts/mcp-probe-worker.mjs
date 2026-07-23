#!/usr/bin/env bun
/**
 * Isolated MCP probe worker — no Next imports, no secret logging.
 * Usage: bun scripts/mcp-probe-worker.mjs --name N --config-path P --deadline-ms MS
 */
import { readFileSync } from "node:fs";
import {
	connectToServer,
	disconnectServer,
	listTools,
} from "@oh-my-pi/pi-coding-agent/mcp";

function parseArgs(argv) {
	const out = { name: "", configPath: "", deadlineMs: 20_000 };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		const next = argv[i + 1];
		if (a === "--name" && next) {
			out.name = next;
			i++;
		} else if (a === "--config-path" && next) {
			out.configPath = next;
			i++;
		} else if (a === "--deadline-ms" && next) {
			out.deadlineMs = Number(next);
			i++;
		}
	}
	return out;
}

function emit(result) {
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function main() {
	const args = parseArgs(process.argv);
	if (!args.name || !args.configPath) {
		emit({ ok: false, error: "missing --name or --config-path" });
		process.exitCode = 1;
		return;
	}

	const deadlineMs =
		Number.isFinite(args.deadlineMs) && args.deadlineMs > 0
			? args.deadlineMs
			: 20_000;

	let config;
	try {
		const raw = readFileSync(args.configPath, "utf8");
		config = JSON.parse(raw);
	} catch (error) {
		emit({
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = 1;
		return;
	}

	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), deadlineMs);
	let connection;
	try {
		connection = await connectToServer(args.name, config, {
			signal: ac.signal,
		});
		const tools = await listTools(connection, { signal: ac.signal });
		emit({
			ok: true,
			toolCount: tools.length,
			tools: tools.map((t) => t.name).slice(0, 50),
		});
		process.exitCode = 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		emit({ ok: false, error: message });
		process.exitCode = 1;
	} finally {
		clearTimeout(timer);
		if (connection) {
			try {
				await disconnectServer(connection);
			} catch {
				// ignore disconnect errors
			}
		}
	}
}

main().catch((error) => {
	emit({
		ok: false,
		error: error instanceof Error ? error.message : String(error),
	});
	process.exitCode = 1;
});
