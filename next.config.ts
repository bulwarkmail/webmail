import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

// Prefer an explicit build arg (passed in by CI / Docker, where .git is
// excluded from the build context) and fall back to `git rev-parse` for
// local builds.
let gitCommitHash = process.env.GIT_COMMIT?.trim() || "";
if (!gitCommitHash) {
  try {
    gitCommitHash = execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    gitCommitHash = "unknown";
  }
}
// Normalise full 40-char SHAs (e.g. ${{ github.sha }}) to the short form.
if (/^[0-9a-f]{40}$/i.test(gitCommitHash)) {
  gitCommitHash = gitCommitHash.slice(0, 7);
}

// Unique per build (even for the same commit): lets an open tab notice that a
// newer build has been deployed and refresh itself. See components/build-refresh.tsx.
const buildStamp = `${gitCommitHash}-${Date.now().toString(36)}`;

let appVersion = "0.0.0";
try {
  appVersion = readFileSync(join(import.meta.dirname, "VERSION"), "utf-8").trim();
} catch {
  // VERSION file not found
}

// Subpath deployment, e.g. NEXT_PUBLIC_BASE_PATH=/webmail. Read at build time
// because Next.js bakes basePath into emitted asset URLs and route metadata.
// Trailing slash is stripped; an empty/missing value disables the feature.
const rawBasePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";
const basePath = rawBasePath.replace(/\/+$/, "");
if (basePath && !basePath.startsWith("/")) {
  throw new Error(
    `NEXT_PUBLIC_BASE_PATH must start with "/" (got: ${JSON.stringify(rawBasePath)})`
  );
}

// Bulwark Lite (see lib/lite.ts and scripts/lite/): the same tree exported as
// static files. `npm run build:lite` sets the flag; a plain `next build` never
// sees it, so the standalone/Docker build is unaffected.
const isLite = process.env.NEXT_PUBLIC_BULWARK_LITE === "1";
if (isLite && (process.env.NEXT_PUBLIC_LOCALE_PREFIX ?? "never") !== "always") {
  // Without the proxy nothing rewrites /mail to /<locale>/mail.
  throw new Error("Bulwark Lite requires NEXT_PUBLIC_LOCALE_PREFIX=always (use `npm run build:lite`)");
}

const nextConfig: NextConfig = {
  output: isLite ? "export" : "standalone",
  // Directory-style pages (out/en/mail/index.html) are what static hosts and
  // the shipped SPA-fallback rules expect; next/image has no optimizer here.
  ...(isLite ? { trailingSlash: true, images: { unoptimized: true } } : {}),
  allowedDevOrigins: ["192.168.1.51"],
  basePath: basePath || undefined,
  // esbuild ships native binaries + a README the bundler can't parse; load
  // it from node_modules at runtime instead of trying to bundle it. Used by
  // PLUGIN_DEV_DIR's on-the-fly bundler.
  serverExternalPackages: ["esbuild"],
  // Response headers are the host's job in a static export (see out/_headers).
  ...(isLite
    ? {}
    : {
        async headers() {
          return [
            {
              // Untrusted plugin iframes have opaque origins and load these public,
              // immutable chunks in CORS mode. Next prefixes this source with basePath.
              source: "/_next/static/:path*",
              headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
            },
          ];
        },
      }),
  // Sibling repos checked out under ./repos/ are unrelated source trees that
  // Turbopack's NFT can otherwise rope into the trace when dynamic fs calls
  // confuse it. Keeps the build from ballooning memory tracing dead code.
  outputFileTracingExcludes: {
    "*": ["./repos/**/*"],
  },
  turbopack: {
    root: import.meta.dirname,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    NEXT_PUBLIC_BUILD_STAMP: buildStamp,
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_DEV_MOCK_JMAP: process.env.DEV_MOCK_JMAP ?? "",
    NEXT_PUBLIC_BULWARK_LITE: isLite ? "1" : "",
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
