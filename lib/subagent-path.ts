/**
 * Path allow-list for SubAgent session files.
 *
 * Artifacts root = realpath(parentSessionFile) with `.jsonl` stripped + path.sep.
 * Every candidate must realpath-resolve under that root before open/read.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { SubagentCommandError } from "./subagent-types";

export class SubagentPathError extends SubagentCommandError {
	constructor(message: string, statusCode = 400) {
		super(message, statusCode);
		this.name = "SubagentPathError";
	}
}

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

/**
 * Resolve the artifacts directory prefix for a parent session file.
 * Returns a path that always ends with `path.sep`.
 */
export function resolveSubagentArtifactsRoot(parentSessionFile: string): string {
	if (typeof parentSessionFile !== "string" || parentSessionFile.length === 0) {
		throw new SubagentPathError("Parent session file path is required", 400);
	}

	let realParent: string;
	try {
		realParent = realpathSync(parentSessionFile);
	} catch (error) {
		if (isEnoent(error)) {
			throw new SubagentPathError("Parent session file not found", 404);
		}
		throw new SubagentPathError("Failed to resolve parent session file", 500);
	}

	if (!realParent.endsWith(".jsonl")) {
		throw new SubagentPathError("Parent session file must end with .jsonl", 400);
	}

	return realParent.slice(0, -6) + path.sep;
}

/**
 * True when `absolutePath` is strictly under `rootWithSep` (root must end with sep).
 */
export function isPathInsideArtifactsRoot(absolutePath: string, rootWithSep: string): boolean {
	if (!rootWithSep.endsWith(path.sep)) {
		return false;
	}
	// Containment: candidate must be a file *under* the artifacts root, not equal to the root string.
	return absolutePath.startsWith(rootWithSep);
}

/**
 * Assert `candidate` is a realpath under the parent session's artifacts tree.
 * Returns the realpath of the allowed candidate.
 *
 * @throws SubagentPathError 400 path escape / bad shape
 * @throws SubagentPathError 404 candidate missing (after containment check on resolved path)
 * @throws SubagentPathError 500 unexpected resolve failure
 */
export function assertSubagentSessionFileAllowed(
	parentSessionFile: string,
	candidate: string,
): string {
	if (typeof candidate !== "string" || candidate.length === 0) {
		throw new SubagentPathError("Subagent session path is required", 400);
	}
	if (candidate.includes("\0")) {
		throw new SubagentPathError("Invalid subagent session path", 400);
	}

	const rootWithSep = resolveSubagentArtifactsRoot(parentSessionFile);

	let realCandidate: string;
	try {
		realCandidate = realpathSync(candidate);
	} catch (error) {
		if (isEnoent(error)) {
			// File missing: still reject obvious escapes via resolved (non-realpath) path.
			const resolved = path.resolve(candidate);
			if (!isPathInsideArtifactsRoot(resolved, rootWithSep)) {
				throw new SubagentPathError(
					"Subagent session path is outside parent artifacts",
					400,
				);
			}
			throw new SubagentPathError("Subagent transcript not found", 404);
		}
		throw new SubagentPathError("Failed to resolve subagent session path", 500);
	}

	if (!realCandidate.endsWith(".jsonl")) {
		throw new SubagentPathError("Subagent session path must be a .jsonl file", 400);
	}

	if (!isPathInsideArtifactsRoot(realCandidate, rootWithSep)) {
		throw new SubagentPathError(
			"Subagent session path is outside parent artifacts",
			400,
		);
	}

	return realCandidate;
}
