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

## Reader queue and focused composition

- `components/email/email-viewer.tsx`, `components/mail/mail-app.tsx`: standard desktop reader now exposes native previous/next handlers with loaded-queue position. It does not claim pagination totals are navigable; unavailable directions are disabled. Pager sits outside measured action overflow, and phones retain their existing bottom navigation.
- `components/email/email-composer.tsx`: rich-text formatting starts folded on desktop as well as phone, with a visible Formatting toggle in the action bar. The editor stays mounted so draft content, undo history and keyboard formatting remain intact. Mountain View retains its existing bottom toolbar behavior.
- `app/api/dev-jmap/[...path]/route.ts`: HTTP demo now retains created draft body parts/values, Bcc and reply headers. `.memail/demo-draft-smoke.mjs` creates and removes its own disposable drafts to check round trips. Multipart bodyStructure/inline-image round trips remain outside this smoke test.


## Rich composition and saved searches

- `.memail/compose-content.ts`: Marked GFM conversion and inert clipboard normalization, followed by the existing email sanitizer. Simple Word class styles and nested list paragraphs become editable email content. Typography is carried through flattened wrappers; host CSS classes are removed. No sanitizer permissions were broadened.
- `components/email/rich-text-editor.tsx`: font-family and line-height extensions, headings 1–6, styled table cells, HTML-first paste, recognizable Markdown paste, explicit plain-text paste and source insertion. New controls use existing toolbar keyboard navigation. `paste-images.ts` prefers rich document HTML over accompanying clipboard images.
- `.memail/compose-import-dialog.tsx`: editable insertion of Markdown or sanitized HTML source. `app/globals.css`: heading levels and table-header colors follow pasted formatting instead of an overriding theme rule.
- `.memail/saved-search*`, `workspace-toolbar.tsx`, `components/mail/mail-app.tsx`: account-scoped device-local saved queries, filters and folder scope. Missing folders disable restoration. Unified, scheduled and plugin searches are excluded. Recheck search store wiring and account switching when merging upstream.
- Recheck real editor paste, toolbar accessibility, undo, sanitization, plain text, quoted originals, table styling and draft serialization after TipTap upgrades. New labels remain English; embedded fonts, arbitrary document page layout and complex stylesheet rules are not supported.


## Composition review and paragraph spacing

- `.memail/compose-content.ts`: preserve vertical margin declarations and inherited line height; supply document paragraph/heading spacing when clipboard HTML has no spacing. Keep list/table paragraphs compact and preserve indentation. This fixes LLM copy/paste being flattened to the editor's 4px typed-line defaults.
- `.memail/paragraph-spacing.ts`, `rich-text-editor.tsx`: selectable Compact/Comfortable/Spacious paragraph spacing and all six heading levels. Spacing changes preserve paragraph text, marks and existing alignment/styles; they do not edit drafts automatically.
- `.memail/compose-import-dialog.tsx`, `compose-preview.ts`: Markdown/HTML/plain-text source and local file import, isolated desktop/phone-width preview, stale file-read protection and a 1 MB import bound. Preview is approximate, sandboxed and blocks remote resources/navigation; insertions still use the existing sanitizer.
- `components/email/email-composer.tsx`: capture-phase composer shortcuts yield to nested menus, dialogs and listboxes, fixing Escape opening the save/discard prompt while a formatting menu is focused. Recheck with the composer-mention integration suite after upstream changes.


## Saved-search management

- `.memail/saved-searches.ts`: scoped updates and duplicate-ID prevention; readable criteria summaries include negative boolean filters. Exact criteria and folder comparison drive the current-search indicator.
- `.memail/saved-search-menu.tsx`: rename and opt-in replacement from current criteria, undo last removal, readable criteria cards, account limit count and quick unread/starred/attachment searches. Keyboard focus returns to the edited control or disclosure. The panel scrolls within a bounded height and sits above floating Compose. Preferences remain device-local.


## Mobile search context

- `components/mail/mail-app.tsx`, `.memail/workspace-toolbar.tsx`: active searches show a Search results heading, folder/unified scope and a visible Clear action using the existing clear-search handler. Mobile filter-only search is marked active. Narrow screens put the toolbar controls on a separate row to avoid truncating the heading.
- `.memail/saved-search-menu.tsx`, `workspace-toolbar.tsx`: visible close controls restore disclosure focus; phone panels are viewport-bounded above the bottom navigation with internal scrolling.
- `components/email/message-list-tabs.tsx`: category visibility now checks advanced filters as well as query text. The shared panel hook removes tabpanel ARIA references while categories are hidden and restores them on clear.


## Saved-search finder and keyboard ownership

- `.memail/saved-search-menu.tsx`: local case-insensitive finder matches saved names, criteria and folders; no-results recovery returns focus to the finder. It never changes stored entries.
- `lib/keyboard.ts`: marked open native disclosures are keyboard-owning layers, alongside existing dialogs and menus. The two workspace panels carry `data-keyboard-layer`, close when focus leaves, and consume Escape before global mailbox shortcuts. Closed disclosures do not block shortcuts.
