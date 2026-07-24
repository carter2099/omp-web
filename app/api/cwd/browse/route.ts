import { NextRequest, NextResponse } from "next/server";
import { readdirSync, statSync, type Stats } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve } from "path";

const IGNORED_NAMES = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  ".pytest_cache",
  ".mypy_cache",
  "target",
  "vendor",
  ".DS_Store",
  "proc",
  "sys",
  "dev",
]);

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

function parentPath(dir: string): string | null {
  const parent = dirname(dir);
  if (!parent || parent === dir) return null;
  return parent;
}

// GET /api/cwd/browse?path=
// Lists immediate child directories for project-path picking.
// Any readable directory may be listed (same freedom as POST /api/cwd/validate).
export async function GET(req: NextRequest) {
  try {
    const home = homedir();
    const raw = req.nextUrl.searchParams.get("path")?.trim() || home;
    const path = normalizeCwd(raw);

    let stat: Stats;
    try {
      stat = statSync(path);
    } catch {
      return NextResponse.json(
        { error: `目录不存在：${raw}` },
        { status: 404 },
      );
    }
    if (!stat.isDirectory()) {
      return NextResponse.json(
        { error: `路径不是目录：${raw}` },
        { status: 400 },
      );
    }

    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return NextResponse.json(
        { error: `无法读取目录：${path}` },
        { status: 403 },
      );
    }

    const entries: { name: string; path: string }[] = [];
    for (const name of names) {
      if (!name || name === "." || name === "..") continue;
      if (IGNORED_NAMES.has(name)) continue;
      // Hide most dotfiles in picker for cleaner UX; keep .omp / .config etc. useful
      if (name.startsWith(".") && name !== ".omp" && name !== ".config" && name !== ".local") {
        continue;
      }
      const child = join(path, name);
      try {
        if (statSync(child).isDirectory()) {
          entries.push({ name, path: child });
        }
      } catch {
        // unreadable entry — skip
      }
    }
    entries.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );

    return NextResponse.json({
      path,
      parent: parentPath(path),
      home,
      entries,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
