import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { join } from "path";

const { version } = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")) as { version: string };
let piVersion = "unknown";
try {
  const piPkgPath = join(__dirname, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
  piVersion = (JSON.parse(readFileSync(piPkgPath, "utf8")) as { version: string }).version;
} catch { /* package not found, use default */ }

const OMP_SERVER_EXTERNALS = [
  "@oh-my-pi/pi-coding-agent",
  "@oh-my-pi/pi-agent-core",
  "@oh-my-pi/pi-ai",
  "@oh-my-pi/pi-tui",
  "@oh-my-pi/pi-catalog",
  "@oh-my-pi/pi-utils",
  "@oh-my-pi/pi-wire",
  "@oh-my-pi/pi-natives",
  "@oh-my-pi/pi-mnemopi",
  "@oh-my-pi/hashline",
  "@oh-my-pi/omp-stats",
  "@oh-my-pi/snapcompact",
] as const;

function isOmpPackageRequest(request: string | undefined): boolean {
  if (!request) return false;
  if (request.startsWith("@oh-my-pi/")) return true;
  return OMP_SERVER_EXTERNALS.some(
    (pkg) => request === pkg || request.startsWith(`${pkg}/`)
  );
}

const nextConfig: NextConfig = {
  // Host A (Bun-hosted): keep the full OMP graph external so Bun loads TS entries
  // (`package.json` "main"/"exports.import" → ./src/*.ts). Webpack cannot parse those
  // TypeScript package roots; transitive packages must also be externalized.
  // Next's default externalizer only matches node_modules *.[mc]?js — OMP ships .ts,
  // so we also force webpack externals below.
  serverExternalPackages: [...OMP_SERVER_EXTERNALS],
  webpack: (config, { isServer }) => {
    if (!isServer) return config;

    const ompExternal = (
      data: { request?: string },
      callback: (err?: Error | null, result?: string) => void
    ) => {
      if (isOmpPackageRequest(data.request)) {
        // OMP package.json exports only define "import" (TS ESM) — not "require".
        callback(null, `module ${data.request}`);
        return;
      }
      callback();
    };

    const existing = config.externals;
    if (Array.isArray(existing)) {
      config.externals = [...existing, ompExternal];
    } else if (existing) {
      config.externals = [existing, ompExternal];
    } else {
      config.externals = [ompExternal];
    }
    return config;
  },
  allowedDevOrigins: ['192.168.*.*'],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_PI_VERSION: piVersion,
  },
};

export default nextConfig;
