import { NextResponse } from "next/server";
import { homedir } from "os";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Returns the user home directory as the default project cwd.
// Does NOT create ~/pi-cwd-YYYYMMDD (removed — use home or pick a project).
export async function POST() {
  try {
    const dir = homedir();
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
