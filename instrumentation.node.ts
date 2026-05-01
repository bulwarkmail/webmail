import { readFileSync } from "fs";
import { configManager } from "./lib/admin/config-manager";
import { initAdminPassword } from "./lib/admin/password";

const pkg = JSON.parse(
  readFileSync(`${process.cwd()}/package.json`, "utf-8")
);
const current: string = pkg.version ?? "0.0.0";
console.info(`Bulwark Webmail v${current}`);

// Initialize admin config and password bootstrap
configManager.load()
  .then(() => initAdminPassword())
  .then(() => {
    console.info("Admin dashboard initialized");
  })
  .then(async () => {
    // Anonymous telemetry - on by default. Admins can disable via the
    // admin UI, the BULWARK_TELEMETRY env var, or by clearing the endpoint.
    // See https://bulwarkmail.org/docs/legal/privacy/telemetry
    const { startScheduler, markProcessStart } = await import("./lib/telemetry");
    markProcessStart();
    await startScheduler();
  })
  .then(async () => {
    // Hourly check against version.telemetry.bulwarkmail.org. Disable with
    // BULWARK_UPDATE_CHECK=off or override the endpoint with
    // BULWARK_UPDATE_CHECK_URL.
    const { startScheduler } = await import("./lib/version-check");
    await startScheduler();
  })
  .catch((err) => {
    console.warn("Admin dashboard init skipped:", err instanceof Error ? err.message : err);
  });
