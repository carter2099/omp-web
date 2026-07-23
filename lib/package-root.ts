/**
 * Resolve the installed @agegr/pi-web package root (for probe worker path).
 * Locked order: PI_WEB_PKG_DIR → require.resolve → walk cwd parents.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const WORKER_REL = path.join("scripts", "mcp-probe-worker.mjs");
const PACKAGE_NAME = "@agegr/pi-web";

function workerExists(pkgRoot: string): boolean {
	return fs.existsSync(path.join(pkgRoot, WORKER_REL));
}

/**
 * Resolve pi-web package directory that ships `scripts/mcp-probe-worker.mjs`.
 * @throws if none of the locked resolution steps succeed
 */
export function resolvePiWebPackageRoot(): string {
	const envDir = process.env.PI_WEB_PKG_DIR?.trim();
	if (envDir) {
		const resolved = path.resolve(envDir);
		if (workerExists(resolved)) return resolved;
	}

	try {
		const require = createRequire(import.meta.url);
		const pkgJson = require.resolve(`${PACKAGE_NAME}/package.json`);
		const root = path.dirname(pkgJson);
		if (workerExists(root)) return root;
	} catch {
		// not installed as a resolvable package from this module graph
	}

	let dir = path.resolve(process.cwd());
	for (;;) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const raw = fs.readFileSync(pkgPath, "utf8");
				const parsed = JSON.parse(raw) as { name?: string };
				if (parsed.name === PACKAGE_NAME && workerExists(dir)) {
					return dir;
				}
			} catch {
				// ignore unreadable package.json
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	throw new Error(
		`Cannot resolve ${PACKAGE_NAME} package root (need ${WORKER_REL}). ` +
			`Set PI_WEB_PKG_DIR or run from the package tree.`,
	);
}

/** Absolute path to the MCP probe worker script. */
export function resolveMcpProbeWorkerPath(): string {
	return path.join(resolvePiWebPackageRoot(), WORKER_REL);
}
