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
  // No `X-Powered-By: Next.js` on every response.
  poweredByHeader: false,
  // Directory-style pages (out/en/mail/index.html) are what static hosts and
  // the shipped SPA-fallback rules expect; next/image has no optimizer here.
  ...(isLite ? { trailingSlash: true, images: { unoptimized: true } } : {}),
  allowedDevOrigins: ["192.168.1.51"],
  agentRules: false,
  basePath: basePath || undefined,
  // esbuild ships native binaries + a README the bundler can't parse; load
  // it from node_modules at runtime instead of trying to bundle it. Used by
  // PLUGIN_DEV_DIR's on-the-fly bundler.
  serverExternalPackages: ["esbuild"],
  // No proxyClientMaxBodySize: Next copies every body proxy.ts runs for up to
  // that size before routing, so it stays at the 10 MB default. The routes
  // that take bigger uploads (WOPI saves, WebDAV, /api/plugin-proxy) are left
  // out of the proxy's matcher instead.
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
            {
              // The plugin sandbox document's script and stylesheet
              // (scripts/build-plugin-sandbox.mjs): module scripts, so the
              // opaque-origin frames fetch them in CORS mode. Content-hashed.
              source: "/plugin-sandbox-assets/:path*",
              headers: [
                { key: "Access-Control-Allow-Origin", value: "*" },
                { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
              ],
            },
            // The upload routes proxy.ts's matcher leaves out, with the
            // headers it sets on every other API response.
            ...["/api/webdav", "/api/plugin-proxy", "/api/wopi/files/:fileId/contents"].map((source) => ({
              source,
              headers: [
                { key: "X-Content-Type-Options", value: "nosniff" },
                { key: "X-Frame-Options", value: "DENY" },
              ],
            })),
          ];
        },
      }),
  // Sibling repos checked out under ./repos/ are unrelated source trees that
  // Turbopack's NFT can otherwise rope into the trace when dynamic fs calls
  // confuse it. Keeps the build from ballooning memory tracing dead code.
  // The trace follows fs reads, and the runtime reads its state directories,
  // so a build from a checkout that has been run would copy the admin
  // password hash, the plugin signing key, the audit log and .env secrets
  // into .next/standalone - and from there into the image.
  // Only "./repos" goes under "*": that key also feeds the next-server trace,
  // where Next matches each glob anywhere in the path, so "./data/**/*" would
  // drop node_modules/next/dist/lib/metadata/* and the server would not start.
  // "!(next-server)" matches every route but not that trace, and per route
  // Next anchors the globs to the project root.
  outputFileTracingExcludes: {
    "*": ["./repos/**/*"],
    "!(next-server)": ["./data/**/*", "./local-data/**/*", "./.env*"],
  },
  turbopack: {
    root: process.env.NEXT_TURBOPACK_ROOT || import.meta.dirname,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    // A dev server may announce another version, e.g. to try a plugin that needs the next release.
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION || appVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_DEV_MOCK_JMAP: process.env.DEV_MOCK_JMAP ?? "",
    NEXT_PUBLIC_BULWARK_LITE: isLite ? "1" : "",
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
