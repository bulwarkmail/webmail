import { readFileSync } from "fs";

const VERSION_CHECK_URL =
  "https://raw.githubusercontent.com/root-fr/jmap-webmail/main/VERSION";

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function compareVersions(current: string, remote: string): number {
  const a = current.split(".").map(Number);
  const b = remote.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((b[i] ?? 0) > (a[i] ?? 0)) return 1;
    if ((b[i] ?? 0) < (a[i] ?? 0)) return -1;
  }
  return 0;
}

export async function register() {
  const pkg = JSON.parse(
    readFileSync(`${process.cwd()}/package.json`, "utf-8")
  );
  const current: string = pkg.version ?? "0.0.0";
  console.info(`JMAP Webmail v${current}`);

  if (process.env.NODE_ENV !== "production") return;

  try {
    const res = await fetch(VERSION_CHECK_URL, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return;
    const remote = (await res.text()).trim();
    if (!SEMVER_RE.test(remote)) return;
    if (compareVersions(current, remote) > 0) {
      console.info(
        `Update available: v${remote} — https://github.com/root-fr/jmap-webmail`
      );
    }
  } catch {
    // Network unavailable — not critical
  }
}
