# Integration tests — webmail ⇆ Stalwart

End-to-end tests that run the **Bulwark webmail against a real Stalwart mail
server** in Docker and drive it with Playwright. The focus is the mail/folder
**synchronisation** behaviour that multi-account webmail clients get wrong:
unread/total counters, folder-list sync, and the account-scoped Unified Mailbox.

Everything here is self-contained and separate from the app's root
`playwright.config.ts` (which only smoke-tests the UI against `npm run dev`).

## What's in the stack

| Service   | Image                                   | Ports (host)                       | Purpose                                                   |
| --------- | --------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| `stalwart`| built from [`stalwart/`](stalwart/)     | `8025` JMAP+admin, `1025` SMTP, `1143` IMAP | Real MTA, declaratively bootstrapped with test mailboxes |
| `webmail` | built from [`webmail.Dockerfile`](webmail.Dockerfile) | `3000`                | The app under test (Next.js, **dev mode** — see below)   |

Provisioned mailboxes (domain `example.org`, shared password `test-pass-123`):
`alice`, `bob`, `carol`. Admin: `admin` / `bootstrap-secret`.

### Two things worth knowing

- **The webmail runs in Next.js dev mode.** The browser talks JMAP *directly*
  to Stalwart at `http://localhost:8025` (cross-origin, plain HTTP). The app's
  production CSP pins `connect-src` to `'self' https:` and would block that;
  dev mode widens it to allow `http:`. Dev mode also ships the test hooks from
  source without a production rebuild. See the header of `webmail.Dockerfile`.
- **CORS.** Stalwart doesn't emit CORS headers by default. The bootstrap enables
  `usePermissiveCors` (see `stalwart/plan-accounts.ndjson.tpl`) so the browser
  origin (`:3000`) may call the JMAP origin (`:8025`).

## Running

```bash
# One-shot: brings the stack up and runs the whole suite in the Playwright
# container (browsers preinstalled, host networking to reach the stack).
integration/run-tests.sh

# A single spec:
integration/run-tests.sh 01-login
```

`run-tests.sh` is the recommended entry point because Playwright's browser
bundles can't always be downloaded/installed on the host; the official
`mcr.microsoft.com/playwright` image sidesteps that.

### Running against a host browser instead

If you *can* install Playwright browsers on your machine:

```bash
cd integration && cp .env.example .env
bash stalwart/prepare-stalwart-cli.sh
docker compose up -d --build --wait
npx playwright test -c playwright.integration.config.ts   # from the repo root
```

The Playwright `globalSetup` brings the stack up for you (unless `IT_NO_DOCKER=1`).

## Layout

```
integration/
├── docker-compose.yml            # stalwart + webmail
├── webmail.Dockerfile            # dev-mode webmail image (built from repo source)
├── webmail-config/policy.json    # enables the cross-account Unified Mailbox feature gate
├── run-tests.sh                  # bring up stack + run suite in the Playwright container
├── stalwart/                     # bootstrap image (adapted from examples/docker/stalwart)
│   ├── Dockerfile
│   ├── entrypoint.sh             # two-phase declarative bootstrap
│   ├── plan-bootstrap.ndjson     # domain + datastore
│   ├── plan-accounts.ndjson.tpl  # alice/bob/carol + listeners + CORS
│   └── prepare-stalwart-cli.sh   # host-side fetch of stalwart-cli (offline-friendly build)
└── tests/
    ├── global-setup.ts / global-teardown.ts
    ├── helpers/
    │   ├── config.ts             # accounts, URLs, ports (env-overridable)
    │   ├── smtp.ts               # dependency-free SMTP submission client
    │   ├── jmap.ts               # JMAP client for seeding/inspecting server state
    │   └── app.ts                # login, add/switch account, folder-counter reads
    ├── 01-login.spec.ts
    ├── 02-mail-sync.spec.ts      # single-account: receive/read/move/delete/folder-create
    └── 03-multi-account.spec.ts  # isolation + cross-account Unified Inbox aggregation
```

## How the tests work

- **Mutations** are made out-of-band — mail is injected over SMTP
  (`helpers/smtp.ts`) and server-side reads/moves/deletes/folder-creates are
  driven over JMAP (`helpers/jmap.ts`). Assertions are on the **rendered UI**,
  so a test tells you whether the webmail *synced* the change.
- **Counters** are read from `data-unread` / `data-total` on the
  `[data-testid="folder-counts"]` element, which makes assertions locale-
  independent. These and the other `data-testid` hooks (`folder-row`,
  `email-list-item`, `account-switcher`, `account-option`, `add-account`,
  `email-composer`, …) were added to the app for these tests.
- **`forceSync(page)`** dispatches a `visibilitychange` to trigger the client's
  `checkForStateChanges()` — the same reconcile a real user gets when tabbing
  back. It makes external-mutation assertions deterministic instead of racing
  the SSE push channel right after login.

## Environment knobs

| Var             | Default            | Effect                                                     |
| --------------- | ------------------ | ---------------------------------------------------------- |
| `IT_NO_DOCKER`  | unset              | `1` = don't manage docker in global-setup (stack already up) |
| `IT_TEARDOWN`   | unset              | `1` = `docker compose down -v` after the suite             |
| `IT_WEBMAIL_URL`| `http://localhost:3000` | Webmail origin                                        |
| `IT_JMAP_URL`   | `http://localhost:8025` | Stalwart JMAP/admin base URL                          |
| `IT_SMTP_PORT`  | `1025`             | Stalwart submission port                                   |

By default the stack is **left running** after the suite so re-runs are fast and
you can poke around (webmail on :3000, Stalwart admin on :8025). Tear it down
with `IT_TEARDOWN=1` or `docker compose -f integration/docker-compose.yml down -v`.

## Resetting

The Stalwart data lives in the `bulwark-it-stalwart-data` volume. To re-run the
bootstrap from scratch:

```bash
docker compose -f integration/docker-compose.yml down -v
```
