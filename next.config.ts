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

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.1.51"],
  basePath: basePath || undefined,
  turbopack: {
    root: import.meta.dirname,
  },
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
