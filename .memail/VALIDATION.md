# Validation status

## Phase 1 focus-inbox preview

- Packaged ZIP: out/memail-focus-inbox.zip (generated, not tracked).
- 47 targeted Vitest tests passed, covering plugin behavior, upstream tab/refresh contracts and Memail theme checks.
- The actual compiled ZIP passed the upstream plugin package validator without warnings.
- Typecheck passed; downstream ESLint passed.
- The application production build passed during branding validation. No application source or runtime dependency changed in the plugin preview.
- The inherited full-suite local run begun on 2 November 2026 did not produce a summary within more than 25 minutes and was stopped. It is inconclusive, not a pass or a confirmed test failure. Baseline investigation remains open.
- Browser plugin installation, live Stalwart integration, cross-device preferences, accessibility acceptance and performance budgets remain unverified.

The preview is in draft PR #3. Phase 0 and full phase 1 acceptance are not complete. The next milestone is an installed-plugin smoke on a disposable full-edition Stalwart deployment, followed by account-scoped custom rules.

## Focus rules polish (0.2.0)

- Focus mode presets, optional sign-in-name account targeting, dynamic labels, stale-account protection and visible settings errors are implemented.
- 56 targeted tests passed across the plugin, host tab/refresh contracts and theme. Typecheck and downstream lint passed.
- The updated package adds account:read permission for optional identity matching; it adds no mail-body, send, mutation or network access.
- Real Stalwart and browser installation acceptance remain outstanding; the Docker engine is not running in this environment.

## Demo filter compatibility

- The demo client now evaluates header presence/value and minimum/maximum size query conditions instead of ignoring them. This fixes misleading newsletter/focus membership in synthetic demos.
- This is an isolated demo-only core patch, documented for future upstream merges.
- Live Stalwart remains unverified because Docker's engine is unavailable; synthetic integration checks are reported separately.

## Visual system 0.2

- Memail is available in the native theme picker through a single additive built-in registry entry; the manifest and skin are shared with its installable ZIP.
- 77 targeted theme/compiler/sanitizer/store tests passed; TypeScript and downstream ESLint passed. Production build passed. The final selection-marker CSS adjustment passed the theme package/contrast checks again.
- Browser confirmed theme activation, Geist as the computed body font, and the light desktop inbox, reader and composer. Screenshots are local review artifacts in the research workspace.
- Fixed demo sign-in verification by using an absolute, configured loopback JMAP URL; browser sign-in and reload now retain the disposable session, with successful server session/context responses. No production authentication code changed.
- The upstream synthetic server does not implement CalendarEventNotification/query; calendar notification integration remains unverified.
- Browser smoke also confirmed dark mode at 1440px and 390px, with no horizontal page overflow; the viewport override was reset after review. This is a smoke check, not full device/accessibility acceptance.
- Real Stalwart, broad accessibility acceptance and cross-device persistence remain open.

## Integrated workspace checkpoint

- Persistent sidebar Compose, workspace layout controls, and native configurable inbox splits implemented.
- 20 targeted tests passed for registration lifecycle/provider precedence, live preference updates, demo filter membership, host tab keyboard behavior and sidebar regressions. TypeScript and scoped ESLint passed.
- Browser verification blocked by the connected browser reporting that its user surface is unavailable. No new screenshots or full visual/triage acceptance claimed. No production build was run for this checkpoint.
- English labels and device-local preferences are explicit limitations. Remaining design gates are in PRODUCT-STRATEGY.md.

## Workspace visual and interaction pass (0.3)

- Browser connection recovered. Reviewed desktop inbox, focused reader and reply composer. Reply opens with the intended recipient/subject; no message was sent. Newsletter view visibly contains two fixtures, one unread.
- 24 icon/theme/registry/reader tests passed, plus 82 existing selection/thread tests. Added avatar-free selection/expansion regression; the updated 67-test thread suite passes. TypeScript passes. Scoped ESLint passes; mail-app retains one unrelated existing effect-ref warning.
- Production build passed, including TypeScript. Final compose-only CSS passed package validation and contrast checks; no claim of exhaustive device or accessibility acceptance.
- Native split tabs pass four tests, including the new count-refresh regression after marking mail read.
- HTTP smoke assertions pass for case-insensitive headers, NOT partitioning, size boundaries and query totals.
- Mobile reader checked at 390px: document width equals viewport width. Temporary viewport override reset. Desktop screenshot: research workspace `memail-workspace-redesign.jpg`.
- Real Stalwart, full suite, localization of downstream labels, cross-device workspace preferences and comprehensive keyboard/mobile acceptance remain outstanding. Custom Tabler picker icons intentionally remain supported.

## Reader queue and focused composition

- 16 targeted composer/reader tests pass (14 initial plus two new desktop/phone navigation regressions). TypeScript passes. Scoped lint has zero errors and the previously recorded mail-app effect-ref warning.
- Browser verified 1-of-23 to 2-of-23 navigation and return, with previous disabled on the first message. Formatting toggles without losing typed text. A synthetic reply was saved, found in Drafts, reopened and its recipient/subject/body retained; nothing was sent.
- This validation uses the HTTP demo, not a real Stalwart server. Durable reminders/follow-up remain a separate unimplemented backend phase.
- Browser draft editing exposed discarded body parts in the HTTP mock. Fixed the create/get round trip; new HTTP checks pass for plain text, HTML, UTF-8 byte lengths, Bcc and reply headers. Previously created malformed demo drafts cannot recover text the mock discarded.
- Repeated browser check after the fix: saved the synthetic recovery draft, reloaded Drafts, opened it and selected Edit; the exact typed text remained in the editor. Screenshot: `memail-focused-compose.jpg` in the research workspace. No outgoing send was attempted.


## Rich composition and saved searches

- 61 targeted tests pass across seven suites: Markdown conversion/paste/undo, explicit plain-text paste, document typography/table serialization, nested Word lists, unsafe HTML removal, font selection, saved-search isolation/limits/missing folders, and existing editor accessibility, blank-line, image-paste and font-size regressions.
- TypeScript passed; scoped lint has zero errors and the existing mail-app effect-ref warning. Production build and TypeScript passed again after the final table-header CSS and nested-Word-list refinements.
- Browser: pasted a synthetic document with Georgia text, emphasis, links, a colored table and lists; inserted Markdown through the dialog. Saved, reloaded, reopened and edited the draft. Verified retained Georgia and table-header RGB(232,227,250) via rendered DOM. Screenshot: research workspace `memail-rich-composer.jpg`. Nothing was sent.
- Browser: saved a GitHub query, cleared it, restored it and verified the same three results. Filter and account isolation are covered in unit tests; multi-account browser acceptance is still open.
- This is representative fixture coverage, not a claim of exhaustive live ChatGPT/Google Docs/Word clipboard compatibility. Complex CSS, embedded applications, page layouts, math/footnote extensions and recipient font availability remain limitations. Real Stalwart and cross-client received-email rendering are unverified.


## Composition review and spacing repair

- 68 tests pass across seven suites covering import/preview/plain text, malformed or oversized files, stale reads, caret-sensitive headings, paragraph repair, real editor paste/save/reopen spacing, source margins/indentation, inherited line-height, and existing loaded/typed spacing, blank lines, accessibility and composer mentions. The real-composer Escape regression passes.
- Scoped lint has zero errors. Production build passed; the final margin-edge refinement was tested afterward and typechecked separately.
- Browser verified a Markdown source preview at phone width and inserted editable headings/table/list content. Selecting Heading 4 updates the actual node. Browser discovered the capture-phase Escape defect, which is now covered by the integration test; a second browser check was interrupted by changing UI state, so keyboard closure is not claimed as browser-verified after the fix.
- For the user's spacing report, a temporary isolated page rendered the production RichTextEditor without touching mailbox drafts. Pasting representative synthetic LLM email HTML produced 14px paragraph gaps and 22.5px heading top margins, instead of 4px. Screenshot: research workspace `memail-paste-spacing-fixed.jpg`. The temporary route was removed and clipboard contents restored. No user draft body was changed.
- Existing drafts cannot recover original spacing that was already discarded automatically. Select affected paragraphs and use Formatting > Spacing > Comfortable, or paste the original source again. Preview and file import do not guarantee exact Word page layout or every recipient's rendering.


## Saved-search management

- Nine saved-search tests pass, including account isolation for updates, criteria preservation on rename, explicit criteria replacement, negative-filter summaries, exact active-state matching, quick-search scope, undo removal and focus return after editing. Scoped lint passes.
- Production build and TypeScript passed; final focus-return refinement passed the targeted suite afterward.
- Browser verified attachment quick search (10 synthetic results), creation/rename, current-search indication, removal/undo, and Escape returning focus to the disclosure. Removed only the temporary review search; the pre-existing saved search was retained. No draft text or message content was changed.
- Screenshot: research workspace `memail-saved-search-management.jpg`. Phone viewport acceptance and translation of these controls remain open; the panel has bounded scrolling and viewport-constrained width but no new mobile acceptance claim.


## Mobile search context

- 16 targeted tests pass across toolbar, saved-search and category-tab suites. New regression covers filter-only searches, including explicit false filters, and restoration of the accessible tab panel after clearing. Production build and TypeScript passed; scoped lint has zero errors (mail-app retains its previously recorded effect-ref warning).
- Browser at 390×844: attachment quick search showed Search results / All folders and Filtered mail in the mobile search bar. Category tabs disappeared during the search, and Clear restored Inbox and its tabs. Document width equalled viewport width. Screenshot: research workspace `memail-mobile-search.jpg`.
- Browser at 320×568: found and fixed below-screen panels. Saved searches occupied y=47..496; workspace preferences occupied y=24..496. Both fit above navigation and close controls returned focus. Temporary viewport override was reset. No draft edits or outgoing mail.
- This is a responsive smoke check, not full mobile-device or assistive-technology acceptance. New downstream labels remain English.


## Saved-search finder and keyboard ownership

- 35 targeted tests pass across saved searches, workspace toolbar and global shortcut guards. New coverage checks criteria/folder matching, no-results recovery without store mutations, and Delete/Archive suppression while a marked disclosure is open, with shortcuts restored after closing.
- TypeScript, scoped lint and production build passed. Final focus-return refinements passed the targeted suite afterward.
- Browser verified saved-search matching, no-results recovery and Escape returning focus to the disclosure. No saved entries, messages or draft bodies changed. Screenshot: research workspace `memail-search-finder.jpg`.


## Composer typography controls

- 46 tests pass across content fidelity, toolbar accessibility and real-composer keyboard integration. New coverage checks line-height serialization/reopen, removal of conflicting span height, retained fonts/spacing, selected-block formatting reset, untouched neighboring text, and one-step undo of heading/list normalization. Scoped lint passes.
- Browser used a temporary isolated production-editor route: double spacing computed to 28px at a 14px font while paragraph margins stayed 14px; unselected paragraph remained 20px line height. Clear formatting removed font/color/bold while keeping text and 1em margins; Undo restored Georgia and bold. Screenshot: research workspace `memail-line-height.jpg`. Temporary route removed; no user drafts edited.
- Production build includes TypeScript validation. Broad mobile toolbar and recipient-client rendering acceptance remain open.


## Navigation and workspace controls

- 28 targeted tests pass across rail keyboard behavior, workspace reading-layout selection, saved searches and native navigation leave guards/badge names. Theme-package tests pass separately. Scoped lint and the final production build including TypeScript pass; existing Turbopack filesystem-tracing warnings remain.
- Browser confirmed Down moves focus from Mail to Calendar without navigating; bottom reader is positioned below the 320px list when a demo conversation is loaded. Native Side layout restored after review.
- Narrow panels were checked at 390px and 320px; the 320px preferences panel stays at x12..308 and y24..496, with internal scrolling and a visible close control. After adding the explicit Tailwind source, confirmed header container-type is inline-size and labels appear on a wide pane.
- Screenshot: research workspace `memail-navigation-polish.jpg`. No draft edited and no mail sent. Production was not redeployed in this pass. Full dark/RTL/zoom visual matrix remains outstanding; RTL focus direction has unit coverage.


## Native workspace identity

- 59 targeted tests pass across glyph compatibility, theme package/contrast, layout controls, rail focus, native leave guards, nested mail route highlighting, unread accessible names, plugin navigation and native return-to-list behavior. Scoped ESLint has no errors; the existing mail-app ref-cleanup warning remains.
- Production build including TypeScript passes; existing Turbopack filesystem-tracing warnings remain.
- Browser verified the 80px labeled dock, actual split mail reading/attachments, active Mail state on nested routes, and the shared workspace header. Phone page width equals the 390px viewport. Light and dark appearance were inspected; a stale development hot-reload rule was cleared with a reload, confirming dark dock background rgb(16,24,19) and foreground rgb(230,240,230). Original Light preference restored afterward.
- Screenshots: research workspace `memail-native-workspace.jpg` and `memail-native-workspace-dark.jpg`. No draft was edited and no email sent. Full RTL/zoom and the remaining app-specific redesign acceptance remain open. Production is unchanged.
