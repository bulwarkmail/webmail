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

No production authentication, sanitized message rendering, synchronization protocol or license text has been changed. Built-in application icons now use Heroicons; earlier icon migrations below are retained as patch history. Memail identity is supplied through upstream configuration; its demo launcher uses synthetic mail and an absolute configured loopback endpoint for server-side session verification.

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


## Composer typography controls

- `.memail/compose-formatting.ts`, `components/email/rich-text-editor.tsx`: paragraph/heading line-height choices with removal of conflicting imported span line heights. Existing font, color and paragraph spacing are retained.
- Clear formatting now strips pasted typography on selected blocks as well as marks, maps preserved spacing through heading/list normalization, and starts a separate undo group. Quoted/signature atom content is not traversed.


## Navigation and workspace controls

- `app/globals.css`: explicitly include `.memail` in Tailwind source discovery; dot-directories are skipped by automatic discovery. This generates custom spacing, sizing and container-query utilities used by downstream controls.
- `.memail/workspace-toolbar.tsx`, `saved-search-menu.tsx`: pane-width-responsive labels, quieter heading, and grouped native reading-layout and density controls. Focus/Side/Below map to existing settings without replacing native readers or resize behavior. Customize header stays visible during panel scrolling.
- `.memail/rail-navigation.ts`, `components/layout/navigation-rail.tsx`: arrow/Home/End focus navigation, horizontal RTL support and disabled/hidden-item skipping. Normal Tab and link activation retain upstream semantics and leave guards. Collapsed custom-app buttons expose names and pressed state.
- `components/layout/sidebar.tsx`, `.memail/theme/skin.mjs`: stable chrome selectors and scoped navigation insets/active treatment, preserving folder row density and virtual message geometry. No ReUI source or dependency added.


## Native Memail workspace identity

- `components/layout/navigation-rail.tsx`: opt-in workspace variant with visible app labels and larger dock targets; compact rails remain available. The standard app containers opt into an 80px dock. Nested /mail routes now correctly mark Mail active. Phone labels and quota text are more readable.
- `components/mail/mail-app.tsx`: the workspace toolbar now spans list and reader, with search/results kept together in the list. The native regions remain mounted; their resize and mobile overlay logic is retained. AppMain carries a stable downstream styling marker.
- `app/globals.css`: original native dock/workspace layout; dark/light dock foreground/background tokens, active and keyboard-focus states, and an inset desktop mail surface. No ReUI source is used.
- `components/icons/memail-glyphs.tsx`: 52 primary Phosphor glyph adapters with direct SSR imports; explicit unfilled state remains visible, heavy numeric stroke selects bold, and SVG/ref props are forwarded. The popular named-icon table shares these glyphs. Remaining specialized Lucide and custom Tabler names remain compatible. MIT notice: `.memail/licenses/PHOSPHOR-MIT.txt`.
- `.memail/theme/manifest.json`: 0.4 forest/neutral theme with light/dark contrast checks; user accent settings still take precedence.
- `.memail/DESIGN-ROADMAP.md`: researched overhaul sequence. AI supports multiple providers conceptually and is explicitly deferred until UI/core acceptance; no AI provider is enabled.


## Sidebar hierarchy and saved views

- Native sidebar rows now use rounded selection, restrained glyph tiles, clearer section headings and separate unread badges/total counts. Density settings and mobile target sizing remain native. Seven more primary icons use the Phosphor adapter (59 total); Drafts uses the writing glyph.
- Folder options are available on desktop hover/focus as well as touch. Enter, Space and ArrowDown open the existing menu without selecting a folder; the menu slot stays reserved to avoid row shifts.
- `.memail/saved-search-sidebar.tsx` adds account-scoped saved views using the existing search model. Missing-folder views are disabled with a reason; longer collections can expand beyond five entries. The header and sidebar share native filter application.
- `Sidebar.workspaceNavigation` is a memoized React node slot. Stable event callbacks preserve the existing sidebar optimization. No ReUI or AI integration is introduced.


## Inbox row hierarchy and display controls

- `.memail/workspace-toolbar.tsx`: all four native densities (Dense, Compact, Regular, Relaxed) and a separate native preview preference are available in Customize. Reading-layout and triage controls retain their behavior.
- `components/email/thread-list-item.tsx`, `app/globals.css`: scoped native row markers, deliberate sender/subject/preview typography, inline preview separators, restrained conversation counts, inset current-message marker and visible keyboard focus. User/plugin account tints are excluded from background overrides. Rows and the column header share 16px insets; explicit row action buttons retain their reserved end gutter.
- Native regular stacked rows use one preview line; Relaxed retains two. `email-list.tsx` estimates the new regular height while continuing to measure real rows, attachments and expanded conversations. Dense rows have a 28px floor matching the wide-list estimate.
- `email-hover-actions.tsx`: interface quick actions have a bordered tray and consistent targets, reduced for Dense rows. Existing callbacks, archive gate, spam semantics, plugin actions and lazy mounting remain native.
- `.memail/message-timestamp.tsx`: compact date text retains the upstream display-date selection, with a semantic machine-readable time and an explicit full UTC tooltip respecting 12/24-hour clock preference. Scheduled labels are unchanged.


## Reader/composer attachment workflow

- Reader attachment collections over six files expose a local filename/MIME finder. It searches beyond collapsed tiles, announces matches, offers no-results recovery and clears with Escape. Download all continues to bundle the complete collection; device download restrictions remain in force. State resets when the reader changes messages, and a collection below the finder threshold cannot retain an invisible filter.
- Attachment grids use container-safe minimums, with wrapped summary actions and explicit expand/collapse state. Existing preview, download, save-to-Files, drag-out and plugin callbacks are retained.
- `attachment-filename.tsx` shares short-extension splitting with the reader (its old helper export is retained). Composer chips truncate the stem while preserving the extension, bound their width and keep native progress/error/cancel behavior. Tests now locate complete filenames by their labeled span rather than assuming a single text node.
- Reader subjects wrap long text; composer fields have consistent targets and quieter labels. Attachment surfaces and borders use native semantic tokens. These styles do not reach received HTML or rich-editor content.
- Corrected color references in the preceding inbox polish from undefined shorthand variables to the native `--color-*` tokens, including quick-action borders and keyboard focus.


## Reader details and recipient disclosure

- Recipient overflow now opens details consistently: phone To overflow is visible, desktop BCC overflow is actionable, and clicking an overflow count while details are open keeps them open. Existing localized labels and contact popovers are reused.
- Full details is a named region with an explicit close control, connected disclosure state and Escape handling inside the panel. Closing returns focus to the opening control, or the corresponding visible disclosure after a breakpoint change.
- Native detail cards use a named container query instead of desktop viewport breakpoints: one column in a narrow reader, two above 44rem of pane width. Full-width mailing-list/plugin slots remain full-width when appropriate; definition-list column rules only target host-owned lists.
- Phone dates now use compact labels with semantic timestamps and precise UTC tooltips; complete local dates remain in details. Truncated sender addresses expose their full text in a title. Native actions, message bodies and quick reply are unchanged.


## Composer formatting hierarchy and pasted-font feedback

- Native composers opt into a streamlined formatting toolbar: common actions stay in the first strip; fonts, paragraph/line spacing, source import, clear formatting, heading styles, colors, tables, code and alignment remain in an expandable More row. The existing commands are moved, not replaced. The standalone editor defaults to the full toolbar, and Mountain View compose windows retain the full variant.
- The disclosure participates in the existing single-Tab-stop toolbar. Expansion mounts the secondary actions into arrow navigation. Escape closes a nested menu first, then the secondary row, returning focus to More. Closing resets open secondary menus. Uniform native button alignment removes unnecessary text line-box height.
- Font-family feedback now reads inline marks and inherited styles on pasted paragraphs/headings/table cells, with default compose-style fallback. It updates on caret changes without rewriting content and shows fonts outside the built-in palette by name.
- Existing paste/import, font commands, paragraph spacing, undo, images and table commands remain in place. The native Formatting on/off control is unchanged; its older outside-window test now checks the explicit toggle instead of assuming an initially visible strip.


## Search, settings finder and Heroicons navigation

- `components/icons/sidebar-icons.tsx`: direct imports from the official `@heroicons/react` 24px outline package. Legacy AppIcon names, refs, size, stroke and SVG props are adapted for mail folders, the app rail, saved views and settings categories. Custom/plugin icon selections and specialized accessibility/keyboard controls retain their existing icons. Native folder glyphs are 18px without the tinted tile background. MIT notice: `.memail/licenses/HEROICONS-MIT.txt`; source: https://github.com/tailwindlabs/heroicons.
- Settings search can expand all matching rows within a section instead of silently stopping at six. A new query resets expansion. Search Down enters results; Up/Down/Home/End move focus without activation; Escape returns to the finder, then clears its query. No-results recovery clears and focuses the finder. The search field stays visible while scrolling navigation. Native setting links, advanced-row reveal rules and managed-account/plugin visibility remain in use.
- Mail filter chips expose complete criterion names on remove controls, full-value titles, clear keyboard focus and narrow-layout truncation. Removing a criterion focuses the next remaining control; clearing the final one returns to the message-list focus target. SearchChips stays mounted with empty output so the final-removal focus effect can complete. Query execution still uses native callbacks and explicit false filters retain their semantics.


## Shared menu layout and command focus

- Shared context menus use rounded panels and rows with consistent insets, retaining native touch target sizes and destructive/disabled states. Existing viewport placement and submenu fitting remain authoritative.
- Typing while a menu item has focus now finds command prefixes at the current menu level. Repeated letters cycle matches; disabled entries are skipped; diacritics are normalized. The prefix resets after 650ms or navigation/level changes. It moves focus only and does not invoke actions. Search fields, composition and modified shortcuts retain their existing handling.
- Menu focus now scrolls its item into view inside long menus. Focus restoration outside menus retains preventScroll behavior.
- Composer toolbar menus expose their existing label as the menu name and open from Down as well as normal button activation. They reuse the existing placement and close/focus logic.


## Files navigation and pane-responsive header

- Files separates account context from the folder path and wraps tools below it when the pane is at most 40rem wide. The root remains readable, long folder names retain full titles, and compact paths show root/current with every intermediate parent in the existing path menu.
- List/grid uses a single radio Tab stop with arrow, Home/End and RTL navigation through the native view callback. Sort and path menus expose localized names and path disclosure state.
- Clearing or escaping compact search restores focus after its trigger remounts; desktop search retains focus. Native file actions, selection tools, plugin actions and account navigation callbacks remain in place. No file storage or mail API changes.


## Contacts search, filters and list hierarchy

- Contacts has a compact heading/actions row and a separate full-width search row, keeping search readable when phone account/menu controls are present. Clearing search and empty-search recovery retain input focus; Escape clears the query without invoking row actions.
- Presence filters use native All/Yes/No selects instead of implicit three-state cycling. Existing matching semantics, including false/exclusion and combinations, are retained. Labels reuse the existing locale catalogs. Sort chips now expose pressed state.
- Advanced filters are a named, linked disclosure region with a scrollable pane, sticky Clear/Close controls and pane-width field grids. Height caps preserve results space (58% generally, 50% in narrow panes). Close/Escape returns to the filter trigger without resetting criteria; composition Escape is ignored. Empty filtered-result recovery clears criteria and focuses search.
- Contact rows have quieter hover/separator treatment and full-name/email/organization titles for truncated values. Native density, selection, sorting, drag, context-menu and plugin callbacks remain in place. No contact storage, import/export or account APIs changed.


## Calendar navigation and application-wide Heroicons

- All 261 existing application icon exports now resolve to Heroicons through `components/icons/heroicons.tsx`. Direct per-icon imports preserve tree shaking; the central, sidebar and older Memail glyph entry points share the same components. Size, refs, numeric/string strokes, fill, SVG props and decorative/named behavior remain supported. Explicit filled stars and the solid shield remain distinct. Symbols without exact Heroicons equivalents use related official glyphs; action labels remain authoritative. MIT notice remains in `.memail/licenses/HEROICONS-MIT.txt`.
- Workspace named defaults (including Focus, News and alerts) use Heroicons. Stored custom/plugin names, brand choices and the lazy Tabler picker remain compatible. Default application surfaces no longer use the previous Phosphor/Lucide glyph adapters.
- Calendar's phone header separates date/account context, navigation/actions and full-width view choices. The view group uses one Tab stop and supports arrows, Home/End and RTL. The Tasks gate and native date/view callbacks remain unchanged.
- Phone calendar visibility now uses the shared viewport-fitted menu with named checkbox items, checked state, shared-account headings, keyboard navigation and Escape focus return. Toggling retains the open menu for additional choices. Desktop search/tools wrap by pane width below 48rem, preserving date space. Desktop view/action menus expose localized names.
- Calendar time-slot tests now select `[role="button"][data-slot]`, excluding Heroicons' vendor `data-slot="icon"` attribute. No production event editor or time-slot behavior changed.
