import { getSessionEntries, resolveSessionPath } from "./session-reader";
export { isFilePathReferencedByEntries } from "./session-file-references-core";
import {
  isBashOutputPathReferencedByEntries,
  isFilePathReferencedByEntries,
  isValidSessionId,
} from "./session-file-references-core";

export async function isFilePathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    const entries = await getSessionEntries(sessionPath);
    return isFilePathReferencedByEntries(filePath, entries);
  } catch {
    return false;
  }
}

export async function isBashOutputPathReferencedBySession(filePath: string, sessionId: string | null): Promise<boolean> {
  if (!isValidSessionId(sessionId)) return false;
  try {
    const sessionPath = await resolveSessionPath(sessionId);
    if (!sessionPath) return false;
    const entries = await getSessionEntries(sessionPath);
    return isBashOutputPathReferencedByEntries(filePath, entries);
  } catch {
    return false;
  }
}
