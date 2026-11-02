import { readFileSync } from "fs";
import { configManager } from "./lib/admin/config-manager";
import { initAdminPassword } from "./lib/admin/password";
import { migrateLegacyAdminLayout, migratePolicyUnifiedMailbox } from "./lib/admin/migrate";
import { detectSetupState } from "./lib/setup/state";
import { ensureSetupToken } from "./lib/setup/token";
import { ensureSessionSecret } from "./lib/auth/session-secret";
import { bootState, getStore, sharedStoreUrl } from "./lib/shared-store";
import { bootSharedMode } from "./lib/shared-store/boot";
import { importLocalData } from "./lib/shared-store/import";
import { exportSharedData } from "./lib/shared-store/export";
import { logger, isJsonLogFormat } from "./lib/logger";

const pkg = JSON.parse(
  readFileSync(`${process.cwd()}/package.json`, "utf-8")
);
const current: string = pkg.version ?? "0.0.0";
logger.info(`Bulwark Webmail v${current}`, { version: current });

// Prometheus metrics, only with METRICS_TOKEN(_FILE): count every request
// from the first one on. https://bulwarkmail.org/docs/deployment/monitoring#metrics
if (process.env.METRICS_TOKEN?.trim() || process.env.METRICS_TOKEN_FILE?.trim()) {
  void import("./lib/metrics/http").then(({ installHttpMetrics }) => {
    if (installHttpMetrics()) logger.info("Metrics endpoint on at /api/metrics");
  });
}

// With REDIS_URL every replica shares one store (#1066). Without it,
// everything below runs exactly as it always has.
const shared = sharedStoreUrl() !== null;

async function loadAdmin(): Promise<void> {
  await configManager.load();
  await initAdminPassword();
}

// SHARED_STORE_EXPORT=1 with REDIS_URL: write the store back into the data
// dirs (the way back to one instance), then exit instead of serving.
const exportOnly = shared && process.env.SHARED_STORE_EXPORT === "1";

async function exportAndExit(): Promise<never> {
  const store = getStore();
  for (;;) {
    try {
      await store.ping(2000);
      break;
    } catch {
      logger.warn("Export: waiting for the shared store");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  const written = await exportSharedData();
  logger.info("Export from the shared store done; start without REDIS_URL on this volume now.", { written });
  process.exit(0);
}

async function bootShared(): Promise<void> {
  await bootSharedMode({ version: current, importLocal: importLocalData, load: loadAdmin });
  if (bootState() !== "ready") throw new Error(`shared store boot ended in state ${bootState()}`);
}

// Initialize admin config and password bootstrap. Migration runs first so
// existing v1 layouts are split before anything reads admin.json (with a
// shared store: before they are imported).
migrateLegacyAdminLayout()
  .then(() => migratePolicyUnifiedMailbox())
  .then(() => (exportOnly ? exportAndExit() : shared ? bootShared() : loadAdmin()))
  .then(async () => {
    logger.info("Admin dashboard initialized");
    // Errors routes catch and log, and errors Next reports (instrumentation.ts),
    // go to the error tracker when one is configured. Off otherwise.
    // https://bulwarkmail.org/docs/deployment/monitoring
    const { installServerErrorReporting } = await import("./lib/error-reporting/server");
    await installServerErrorReporting();
    // With a shared store, boot already made or loaded the secret.
    if (!shared) {
      try {
        if (await ensureSessionSecret()) {
          logger.info(
            "Generated a session secret in the admin state dir. Keep that dir on a " +
            "persistent volume, or set SESSION_SECRET, so restarts don't sign everyone out.",
          );
        }
      } catch (err) {
        logger.warn("Failed to generate a session secret", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    // If we're in bootstrap state (no JMAP_SERVER_URL env and no
    // setupComplete in config.json), generate/refresh the setup token and
    // print it to the logs so the operator can complete the web wizard
    // without execing into the container.
    if (detectSetupState() === "bootstrap") {
      try {
        const token = await ensureSetupToken();
        const port = process.env.PORT || "3000";
        // In the fragment, so the token stays out of access logs and Referer.
        const open = `http://<host>:${port}/setup#token=${token}`;
        if (isJsonLogFormat()) {
          logger.info("Setup required", { token, open, expiresIn: "1h" });
        } else {
          for (const line of [
            "==============================================================",
            "  SETUP REQUIRED",
            `  Token: ${token}`,
            `  Open:  ${open}`,
            "  Token expires in 1 hour. Restart the container to reissue.",
            "==============================================================",
          ]) logger.info(line);
        }
      } catch (err) {
        logger.warn("Failed to issue setup token", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  })
  .then(async () => {
    // Anonymous telemetry, off by default. Admins turn it on in the admin UI
    // or with BULWARK_TELEMETRY=on; BULWARK_TELEMETRY=off or an empty
    // collector URL keeps it from sending.
    // See https://bulwarkmail.org/docs/legal/privacy/telemetry
    const { startScheduler, stopScheduler, markProcessStart } = await import("./lib/telemetry");
    markProcessStart();
    // Instant error counts: a one-minute tick that sends only while the
    // error-count consent is "instant".
    const instantErrors = await import("./lib/telemetry/instant-errors");
    // Hourly check against version.telemetry.bulwarkmail.org. Disable with
    // BULWARK_UPDATE_CHECK=off or override the endpoint with
    // BULWARK_UPDATE_CHECK_URL.
    const versionCheck = await import("./lib/version-check");
    // All run on one replica of the deployment, the scheduler leader
    // (#1066); a single instance always leads.
    const { startSchedulerLeader } = await import("./lib/scheduler-leader");
    await startSchedulerLeader([
      { name: "telemetry", start: startScheduler, stop: stopScheduler },
      { name: "telemetry-errors", start: instantErrors.startInstantErrors, stop: instantErrors.stopInstantErrors },
      { name: "version-check", start: versionCheck.startScheduler, stop: versionCheck.stopScheduler },
    ]);
  })
  .catch((err) => {
    logger.warn("Admin dashboard init skipped", { error: err instanceof Error ? err.message : String(err) });
  });
