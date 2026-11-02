# Downstream patch inventory

Base: Bulwark Webmail, https://github.com/bulwarkmail/webmail.

| Change | Location | Upstream impact | Verification |
| --- | --- | --- | --- |
| Fork maintenance guide and update helper | `.memail/` | Additive; no application or upstream workflow edits | Node syntax check; local Git merge/guard regression test |
| Memail branding and mock-mail development launcher | `.memail/demo.mjs`, `.memail/production.env.example`, `public/branding/memail/` | Existing branding environment hooks only; no application patch | Launcher syntax check, upstream config/identity tests, typecheck, lint, production build |
| Memail visual system and built-in picker entry | `.memail/theme/`, `.memail/package-theme.mjs`, `lib/builtin-themes.ts` | Native Theme API v2; one additive built-in registry entry, no theme-loader or component layout patch | Package validator and light/dark contrast tests in `.memail/theme.test.ts` |
| Read-only focus inbox plugin | `.memail/plugins/focus-inbox/`, `.memail/package-focus-plugin.mjs` | Native tabs/commands plugin APIs; no core application patch | Built ZIP validation, membership/lifecycle tests, native tab/store regressions |
| Focus presets and account targeting | `.memail/plugins/focus-inbox/` | Plugin settings/lifecycle hooks and account identity lookup only | Preset membership, account switch races, stale-state cleanup and package tests |
| Demo header and size query compatibility | `lib/demo/demo-client.ts` | Small isolated fix: mock queries previously ignored newsletter header/size conditions | Header/value/size boundary tests, pagination/counts, and real demo Focus queries |
| Fork discovery banner | `README.md` | Three additive lines above the upstream README | Diff review |

No production authentication, sanitized message rendering, synchronization protocol or license text has been changed. The workspace adds Lucide as its interface icon dependency. Memail identity is supplied through upstream configuration; its demo launcher uses synthetic mail and an absolute configured loopback endpoint for server-side session verification.

Add each customization here. Include the relevant upstream files, the reason it cannot use configuration/theme/plugin hooks, and the checks required after upstream updates. Remove entries when upstream absorbs the change.

## Workspace redesign in progress

- `components/layout/sidebar.tsx`: persistent Compose using the existing guarded compose callback.
- `components/mail/mail-app.tsx`: native workspace header with compact/focused/split controls; existing Mountain View keeps its own layout controls.
- `.memail/workspace-*`: native All/Focus/Newsletters registration shared across mounted panes and yielding to explicitly installed category providers. Filters reuse the tested Focus query definitions and existing host counts/pagination.
- New workspace labels currently use English. Visual acceptance, localization and the complete triage walkthrough remain outstanding; this checkpoint is not the accepted redesign.

## Workspace visual and interaction pass (0.3)

- `components/icons/index.ts`, `adapt.tsx`, `named.tsx`: replace 260 interface exports with Lucide, preserving upstream export names, numeric stroke arguments, filled shield and stored/custom Tabler names. `package.json` and lockfile add Lucide. Recheck the adapter when either icon package changes.
- `components/email/thread-list-item.tsx`: optional avatar-free wide rows with persistent selection controls and explicit thread expansion. Phones retain avatars; Mountain View keeps its native lead controls. Recheck virtualization, selection and thread expansion after upstream updates.
- `components/email/email-viewer.tsx`: centered focused reader, larger subject and primary Reply action. Existing sanitization and callbacks retained.
- `components/email/message-list-tabs.tsx`: refresh category counts when mailbox unread/total counts change, including after reading mail.
- `.memail/workspace-toolbar.tsx`: Triage preset, comfortable reading width, avatar preference and native keyboard shortcut help.
- `.memail/theme/`: graphite/iris light and dark tokens, capsule split tabs, rounded folder navigation and bounded compose canvas.
- `app/api/dev-jmap/[...path]/route.ts`: HTTP mock header/NOT/size filters and newsletter fixtures; verify separately from the in-memory DemoJMAPClient using `.memail/demo-http-smoke.mjs`.
