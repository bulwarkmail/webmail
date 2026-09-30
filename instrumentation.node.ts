import { readFileSync } from "fs";
import { configManager } from "./lib/admin/config-manager";
import { initAdminPassword } from "./lib/admin/password";
import { migrateLegacyAdminLayout, migratePolicyUnifiedMailbox } from "./lib/admin/migrate";
import { detectSetupState } from "./lib/setup/state";
import { ensureSetupToken } from "./lib/setup/token";

const pkg = JSON.parse(
  readFileSync(`${process.cwd()}/package.json`, "utf-8")
);
const current: string = pkg.version ?? "0.0.0";
console.info(`Bulwark Webmail v${current}`);

// Initialize admin config and password bootstrap. Migration runs first so
// existing v1 layouts are split before anything reads admin.json.
migrateLegacyAdminLayout()
  .then(() => migratePolicyUnifiedMailbox())
  .then(() => configManager.load())
  .then(() => initAdminPassword())
  .then(async () => {
    console.info("Admin dashboard initialized");
    // If we're in bootstrap state (no JMAP_SERVER_URL env and no
    // setupComplete in config.json), generate/refresh the setup token and
    // print it to the logs so the operator can complete the web wizard
    // without execing into the container.
    if (detectSetupState() === "bootstrap") {
      try {
        const token = await ensureSetupToken();
        const port = process.env.PORT || "3000";
        console.info("");
        console.info("==============================================================");
        console.info("  SETUP REQUIRED");
        console.info(`  Token: ${token}`);
        // In the fragment, so the token stays out of access logs and Referer.
        console.info(`  Open:  http://<host>:${port}/setup#token=${token}`);
        console.info("  Token expires in 1 hour. Restart the container to reissue.");
        console.info("==============================================================");
        console.info("");
      } catch (err) {
        console.warn(
          "Failed to issue setup token:",
          err instanceof Error ? err.message : err,
        );
      }
    }
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
