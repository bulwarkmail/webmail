import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

let gitCommitHash = "unknown";
try {
  gitCommitHash = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // git not available
}

let appVersion = "0.0.0";
try {
  appVersion = readFileSync(join(import.meta.dirname, "VERSION"), "utf-8").trim();
} catch {
  // VERSION file not found
}

// Support serving under a sub-path (e.g. "/webmail") via NEXT_PUBLIC_BASE_PATH.
// Must be set at build time — Next.js bakes it into the output.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["192.168.1.51"],
  turbopack: {
    root: import.meta.dirname,
  },
  ...(basePath ? { basePath } : {}),
  env: {
    NEXT_PUBLIC_GIT_COMMIT: gitCommitHash,
    NEXT_PUBLIC_APP_VERSION: appVersion,
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
