#!/usr/bin/env bun
"use strict";

// Host strategy A (Wave 0): Bun-hosted production launcher.
// @oh-my-pi/* ships TypeScript package entries; Node cannot strip types under
// node_modules. This CLI must run under Bun and spawn `next start` with Bun.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn, spawnSync } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseLaunchOptions } = require("./pi-web-options");

const pkgDir = path.join(__dirname, "..");
const nextDir = path.join(pkgDir, ".next");

/**
 * Resolve a Bun executable. Prefer the current process when already launched
 * via `#!/usr/bin/env bun`; otherwise search PATH / common install roots.
 */
function resolveBunExecutable() {
  const execPath = process.execPath || "";
  const base = path.basename(execPath).toLowerCase();
  if (base === "bun" || base === "bun.exe" || execPath.includes(`${path.sep}bun`)) {
    return execPath;
  }

  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (which.status === 0) {
    const found = which.stdout.trim().split("\n")[0];
    if (found) return found;
  }

  const candidates = [
    process.env.BUN_INSTALL && path.join(process.env.BUN_INSTALL, "bin", "bun"),
    path.join(process.env.HOME || "", ".bun", "bin", "bun"),
    "/root/.bun/bin/bun",
    "/usr/local/bin/bun",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  console.error(
    "pi-web requires Bun (host strategy A). Install Bun and ensure `bun` is on PATH.\n" +
      "See https://bun.sh — @oh-my-pi packages load as TypeScript and need Bun at runtime."
  );
  process.exit(1);
}

// Resolve next's CLI entry directly to avoid relying on .bin symlinks (which
// may not exist when installed via npx).
let nextBin;
try {
  nextBin = require.resolve("next/dist/bin/next", { paths: [pkgDir] });
} catch {
  // Fallback: locate next package root and derive the bin path manually.
  try {
    const nextPkg = require.resolve("next/package.json", { paths: [pkgDir] });
    nextBin = path.join(path.dirname(nextPkg), "dist", "bin", "next");
  } catch {
    nextBin = path.join(pkgDir, "node_modules", "next", "dist", "bin", "next");
  }
}

const { port, hostname, openBrowser } = parseLaunchOptions();

if (!fs.existsSync(nextDir)) {
  console.error("Build artifacts not found. Please report this issue.");
  process.exit(1);
}

const bunBin = resolveBunExecutable();
const nextArgs = ["start", "-p", port];
if (hostname) nextArgs.push("-H", hostname);

// Always run next's JS entry with Bun — required for host A (OMP TS packages).
const child = spawn(bunBin, [nextBin, ...nextArgs], {
  cwd: pkgDir,
  stdio: ["inherit", "pipe", "inherit"],
  env: { ...process.env },
});

let browserOpened = false;
const url = `http://${hostname ?? "localhost"}:${port}`;

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (openBrowser && !browserOpened && text.includes("Ready")) {
    browserOpened = true;
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    const openCmd = isWindows ? "start" : isMac ? "open" : "xdg-open";
    const opener = spawn(openCmd, [url], {
      shell: isWindows,
      stdio: "ignore",
      detached: true,
    });

    opener.on("error", (error) => {
      console.warn(`Could not open browser automatically: ${error.message}`);
    });

    opener.unref();
  }
});

child.on("exit", (code) => process.exit(code ?? 0));
