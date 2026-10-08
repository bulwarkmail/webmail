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

### In CI

The "Integration tests" workflow (`.github/workflows/integration.yml`) runs
`run-tests.sh` every night on main, on pull requests that carry the
`integration` label, and on demand:

```bash
gh workflow run integration.yml
```

A failed run uploads the Playwright report, traces and failure videos as the
`integration-report` artifact and prints the container logs.

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
    ├── 03-multi-account.spec.ts  # isolation + cross-account Unified Inbox aggregation
    ├── 04-all-mail.spec.ts       # All Mail view: single-account merge + cross-account
    ├── 04-shared-identity.spec.ts# composer From offers shared/group send-as identities (issue #569)
    ├── 05-actions.spec.ts        # context-menu read/unread, delete, spam (inbox)
    ├── 06-shared-folders.spec.ts # delegated folder: appears + read/unread/delete/spam
    ├── 07-drafts.spec.ts         # multiple recipients, changed sender, continue-draft button
    ├── 08-shared-moves.spec.ts   # moving mail across own/shared and shared/shared
    ├── 09-live-counters.spec.ts  # live unified/All-Mail counters (login + shared)
    └── 10-attachments.spec.ts    # cross-account attachment download from All Mail
```

## Findings surfaced by the suite

Some tests assert server-side truth (or use `test.fail` to pin a known gap)
because the UI behaviour is currently incomplete. Worth a look:

- **Shared-account counters now reconcile on focus/interval** (`09-live-counters`).
  Stalwart's SSE only pushes StateChange for the *primary* account, so a
  background change in a shared/delegated account is never pushed. The client
  now also polls the session's secondary accounts, so their folder badges and
  the unified/All-Mail counter refresh on the visibility reconcile and on a slow
  background poll. (A *login* account already updates live via its own SSE.)
  Note: these shared counters still don't update the instant a local action
  runs — they follow the reconcile, not the optimistic path.
- **`mark-as-spam` doesn't optimistically decrement the source counter** the
  way `delete` does; it settles after a reconcile.
- **Reopening a draft restores the chosen sender (fixed).** It used to reset
  the From selector to the default identity (`08-drafts`).
- **Cross-account moves (fixed).** Moves between the own account and shared
  folders, and across owners, deliver the message, keep its read state and
  remove the source (`09-shared-moves`). The client destroys the source itself
  instead of using Stalwart's `onSuccessDestroyOriginal` (support.stalw.art
  #1150).
- **Cross-account attachments & inline images (fixed).** Blobs are account-
  scoped, so viewing/downloading/previewing an attachment, rendering an inline
  `cid:` image, dragging out, and the bundle/S-MIME/TNEF/embedded-message
  fetches on an All-Mail message from another account 404'd against the active
  account. Every viewer blob fetch now routes to the message's owning client +
  accountId (`10-attachments` covers download + inline image).

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
| `IT_VIDEO`      | `retain-on-failure`| Video capture: `on` records a `.webm` for **every** test; also `off` / `on-first-retry`. Videos land at `integration/test-results/<test>/video.webm` |

Record videos for a whole run (passing tests included):

```bash
IT_VIDEO=on integration/run-tests.sh          # or a single spec: IT_VIDEO=on integration/run-tests.sh 01-login
```

By default the stack is **left running** after the suite so re-runs are fast and
you can poke around (webmail on :3000, Stalwart admin on :8025). Tear it down
with `IT_TEARDOWN=1` or `docker compose -f integration/docker-compose.yml down -v`.

## Resetting

The Stalwart data lives in the `bulwark-it-stalwart-data` volume. To re-run the
bootstrap from scratch:

```bash
docker compose -f integration/docker-compose.yml down -v
```
