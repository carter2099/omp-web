/**
 * Bounded SubAgent transcript page reader (1 MiB cap per response).
 * Prefer complete JSONL lines so clients can parse partial pages safely.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import {
	SUBAGENT_TRANSCRIPT_MAX_BYTES,
	SubagentCommandError,
	type SubagentMessagesPage,
} from "./subagent-types";

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}

/**
 * Parse and validate `fromByte` from a command body.
 * @throws SubagentCommandError 400 for invalid values
 */
export function parseTranscriptFromByte(fromByte: unknown): number {
	if (fromByte === undefined || fromByte === null) {
		return 0;
	}
	if (typeof fromByte !== "number" || !Number.isFinite(fromByte) || fromByte < 0) {
		throw new SubagentCommandError(
			"fromByte must be a finite non-negative number",
			400,
		);
	}
	return Math.trunc(fromByte);
}

/**
 * Read at most `maxBytes` of UTF-8 transcript starting at `fromByte`.
 * Returns complete lines only (trailing partial line held for the next page).
 */
export function readSubagentTranscriptPage(
	sessionFile: string,
	fromByteInput: unknown,
	maxBytes: number = SUBAGENT_TRANSCRIPT_MAX_BYTES,
): SubagentMessagesPage {
	const requestedFrom = parseTranscriptFromByte(fromByteInput);

	let size: number;
	try {
		size = statSync(sessionFile).size;
	} catch (error) {
		if (isEnoent(error)) {
			throw new SubagentCommandError("Subagent transcript not found", 404);
		}
		throw new SubagentCommandError("Failed to read subagent transcript", 500);
	}

	let fromByte = requestedFrom;
	let reset = false;
	if (fromByte > size) {
		fromByte = 0;
		reset = true;
	}

	if (fromByte >= size) {
		return {
			nextByte: size,
			eof: true,
			content: "",
			sessionFile,
			fromByte,
			reset,
		};
	}

	const toRead = Math.min(maxBytes, size - fromByte);
	const buffer = Buffer.alloc(toRead);
	const fd = openSync(sessionFile, "r");
	let bytesRead: number;
	try {
		bytesRead = readSync(fd, buffer, 0, toRead, fromByte);
	} catch {
		throw new SubagentCommandError("Failed to read subagent transcript", 500);
	} finally {
		closeSync(fd);
	}

		const raw = buffer.subarray(0, bytesRead).toString("utf8");
		const lastNewline = raw.lastIndexOf("\n");
		// Prefer complete lines when more content remains after this chunk.
		const endOfFile = fromByte + bytesRead >= size;
		const completeText =
			lastNewline >= 0
				? raw.slice(0, lastNewline + 1)
				: endOfFile
					? raw
					: "";

		// Hard-cut mid-line when a non-final window has zero complete lines so
		// nextByte always advances (single JSONL line > 1 MiB cannot stall).
		let nextByte: number;
		if (completeText.length > 0) {
			nextByte = fromByte + Buffer.byteLength(completeText, "utf8");
		} else if (bytesRead > 0 && !endOfFile) {
			nextByte = fromByte + bytesRead;
		} else {
			nextByte = fromByte;
		}
		const eof = nextByte >= size;

		return {
			nextByte,
			eof,
			content: completeText,
			sessionFile,
			fromByte,
			reset,
		};
}
