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


## Sidebar hierarchy and saved views

- The broader layout run passed 199 tests across 43 files, including shared folders, nesting, counts, plugin navigation and touch menus. After the final memoization and ArrowDown changes, 14 focused tests passed across saved views, folder icons and menu access.
- Browser reviewed the production Sidebar in a temporary isolated route with fixture mailboxes and local search callbacks. Saved-view selection updated its current state. The 288px sidebar fits at 320px and 390px; the temporary fixture's adjacent explanatory text overflowed at 320px, so this is not a full mail-screen mobile acceptance claim. The fixture was removed and viewport reset.
- Screenshot: research workspace `memail-sidebar-polish.jpg`. The live app restored the user's open draft during review; further checks used the isolated route. No draft content or saved entries were changed and no mail was sent.
- Full RTL/zoom/dark and real-account search acceptance remain open. Production is unchanged.

- Final production build including TypeScript passed after fixture removal; existing Turbopack filesystem-tracing warnings remain. Scoped lint has no errors; the existing mail-app effect-ref warning remains.


## Inbox row hierarchy and display controls

- 148 tests passed across 14 files: row rendering, column alignment contracts, pagination, range rows, batch actions, treegrid keyboard behavior, tabs, quick-action labels/placement, memoization/store rendering and scroll resets. Added coverage checks all four native densities, independent preview toggling, semantic dates, clock preference and invalid timestamp handling. An existing batch-test act warning remains.
- Scoped ESLint passed with no warnings or errors. Production build and TypeScript passed; existing Turbopack filesystem-tracing warnings remain.
- Browser reviewed the current local demo inbox without opening messages or invoking mail actions. Regular wide rows measured about 57px; native regular stacked rows decreased from about 121px to 97px with one preview line. Keyboard focus inside a row exposes its 36px quick-action tray. Precise timestamp tooltip confirmed.
- Document width equalled viewport at 390px and 320px. At 320x568, Customize fits x12..308/y24..496, scrolls internally, and retains its close control. Original Regular density and preview setting were restored; temporary viewport override reset. Screenshots: research workspace `memail-inbox-polish.jpg` and `memail-inbox-phone.jpg`.
- No email or draft content was changed and no mail was sent. Real-account large-mailbox, dark/RTL/zoom and recipient-client acceptance remain open. AI remains deferred; production unchanged.


## Reader/composer attachment workflow

- 185 unique targeted checks passed across 19 files over the final broader run and its upload-focused rerun. Coverage includes attachment finder/clear/no-results, filtering hidden files and MIME types, restricted downloads, shrinking collections, bar/cards positioning, Files/download callbacks, draft attachment recovery, pending-save uploads, upload timeout, discard, plugin edits, recipient validation, short panes, inline CID images, composer accessibility and rich content/import. Existing asynchronous React act warnings remain.
- Production build including TypeScript passed after removing the temporary preview route. Scoped ESLint passed without warnings or errors. Existing Turbopack filesystem-tracing warnings remain.
- Browser used an isolated route rendering production ReaderAttachments, AttachmentFilename and RichTextEditor with fixture files and local-only body state. This was component review, not full authenticated composer acceptance. Searching found the last collapsed file; clearing restored the list. At 320px the tiles measured 280px and remained inside the page. Viewport reset and temporary route removed. No user draft, mail, or stored attachment was modified.
- Visual inspection caught undefined shorthand color tokens; they now use native palette variables. Computed attachment border matched native #e4e8e1 at 80% opacity. The sample editor retained Georgia and its 14px paragraph margin. Screenshots: research workspace `memail-reader-composer-components.jpg` and `memail-attachments-phone.jpg`.
- New attachment-finder labels are English. Full dark/RTL/zoom, real-account upload/download, recipient-client formatting and full reader/composer layout acceptance remain open. AI is deferred and production is unchanged.


## Reader details and recipient disclosure

- 86 tests passed across 13 files, including metadata close/Escape/focus, mobile To overflow, BCC overflow, repeat overflow activation, phone timestamp semantics, attachment layout, read hooks, quick-reply return, toolbar layout, plugin remounts, link gates and open-render behavior. Scoped lint and production build including TypeScript passed. Existing asynchronous React act and Turbopack filesystem-tracing warnings remain.
- Browser checked the already-open local demo message. Details showed two columns in an approximately 882px reader; at 320px viewport its 312px panel used one 280px content column and document width stayed 320px. Closing at the phone breakpoint returned focus to the visible Show details button even though details were first opened on desktop.
- Phone date is compact (Mon 20:32 in the sample) and its measured right edge was 366px within the 390px viewport. Screenshots: research workspace `memail-reader-details-polish.jpg` and `memail-reader-phone-polish.jpg`. The normal viewport and collapsed-details state were restored. No draft or mail content was changed and no mail was sent.
- This uses the local demo account, not a real-account acceptance run. Full dark/RTL/zoom, long international recipient sets, plugin-specific details forms and full reader/composer acceptance remain open. Production unchanged; AI deferred.


## Composer formatting hierarchy and pasted-font feedback

- The final broader run passed 111 checks across 14 files. A subsequent editor-focused run passed 17 checks, adding complete action-set parity between the full toolbar and expanded compact toolbar (112 unique targeted checks overall). Coverage includes retained selection/font application, custom and inherited font feedback, nested Escape and focus return, roving keyboard access, formatting visibility, HTML/plain text, short panes, Mountain View windows, pending attachment saves, paragraph/blank-line fidelity, links, drops and source import.
- Production build including TypeScript and scoped ESLint passed. Existing asynchronous React act warnings, TipTap duplicate textDirection warnings and Turbopack filesystem-tracing warnings remain; this pass does not claim to resolve them.
- Browser used an isolated production RichTextEditor with local sample content. At 320px, collapsed formatting measured about 83px, compared with 137px in the initial implementation; expanded controls measured about 202px and produced no horizontal page overflow. Clicking the sample pasted paragraph correctly displayed Georgia after inherited-font handling was added.
- Screenshots: research workspace `memail-formatting-polish.jpg` and `memail-formatting-phone.jpg`. Temporary route removed, review tabs closed and viewport reset. No user draft was modified and no mail was sent. This is component visual review, not full real-account composer acceptance.
- More formatting and its group name are currently English. Full short-height device, dark/RTL/zoom, real-account send/recovery and recipient-client formatting acceptance remain open. AI deferred; production unchanged.


## Search, settings finder and Heroicons navigation

- 289 tests passed across 58 files: layout/shared-folder/count/rail/plugin coverage, all search component suites, settings anchors/advanced/phone deep links/plugin pages/palette commands, saved views, batch actions and pagination. New checks cover all-match expansion/reset without toggling Advanced, no-result focus recovery, keyboard navigation, negative filter labels, removal focus and Heroicons adapter compatibility.
- Production build including TypeScript passed after the temporary chip-review route was removed. Scoped lint passed with no warnings or errors. Existing Vite config-loader and Turbopack filesystem-tracing warnings remain.
- Browser verified Heroicons in the current local demo workspace. Settings search showed expandable groups of 27 and 11 matches for the sample query; expansion and input/result focus were verified without opening a setting or changing preferences. At 320px, settings page width stayed 320px and clearing no matches returned focus to Search settings.
- An isolated production SearchChips fixture verified next-criterion focus, final-clear focus to Results preview, and 320px page width. No mailbox query was issued by the fixture. Review tabs closed, temporary route removed and viewport reset. No draft or mail content was modified and no mail was sent.
- Screenshots: research workspace `memail-heroicons-sidebar.jpg`, `memail-settings-search.jpg`, `memail-settings-search-phone.jpg`, and `memail-search-chips-phone.jpg`. Full dark/RTL/zoom and real-account search/large-settings acceptance remain open. Expansion labels are currently English; filter labels reuse translations. AI deferred; production unchanged.


## Shared menu layout and command focus

- 104 checks passed across 14 files: menu keyboard/fit/submenu/touch/hover behavior, composer menus/a11y/short panes, reader flyouts/panel layering, plugin list surfaces, batch actions, folder menus and rail leave guards. Added checks cover typed prefixes, repeat-letter cycling, diacritics, disabled skipping, current submenu scope, search-field ownership, scroll requests and named composer-menu opening/focus return.
- Production build including TypeScript and scoped ESLint passed after removing the temporary review route. Existing Vite config-loader and Turbopack filesystem-tracing warnings remain.
- Browser verified the live local demo reader's More actions menu: p moved focus to Pin then Print, and Escape closed it without invoking either action. No mail or draft content was changed.
- An isolated production menu with local no-op actions was checked at 320x568. The long root panel stayed approximately x68..310/y10..558; type-to-focus scrolled its inner container about 146px to show Print at y477..509. The submenu stayed within x130..310/y484..558. Escape returned to Message actions. Viewport reset, review tab closed and temporary route removed.
- Screenshots: research workspace `memail-menu-polish.jpg` (native reader) and `memail-menu-phone.jpg` (isolated long menu). Full dark/RTL/zoom/device and plugin-specific interactive-form acceptance remain open. AI deferred; production unchanged.


## Files navigation and pane-responsive header

- 83 checks passed across 8 files covering header navigation, shared-folder browsing, sidebar semantics, file picker, plugin surfaces, overlay focus and shared menu keyboard/fit behavior. The five new header checks also passed after the final account-context/layout adjustment. Scoped ESLint and production build including TypeScript passed; existing Vite config-loader, asynchronous React act and Turbopack tracing warnings remain.
- Isolated browser route rendered the production FilesHeader with local fixture state and no-op file actions. At a 512px desktop pane, header client/scroll widths both measured 510px. At 320px viewport, page client/scroll widths both measured 320px and toolbar widths both measured 294px. Compact path overflow exposed all three intermediate parents. ArrowRight selected Grid and focused its radio; Escape cleared compact search and returned focus to its remounted trigger.
- Account context was moved above the path after visual review exposed crowding. Root text remains untruncated in the reviewed phone layout. Screenshots: research workspace `memail-files-navigation.jpg` and `memail-files-navigation-phone.jpg`. This is component-level review; real-account WebDAV, full dark/RTL/zoom/device and complete connected-app acceptance remain open.
- Temporary review route removed, viewport reset and review tab closed. No user draft, email, stored file or account was changed. AI deferred; production unchanged.


## Contacts search, filters and list hierarchy

- 71 checks passed across 8 files: list/item, sidebar, app, menus, named buttons, shared shortcuts and plugin surfaces. Five new checks cover linked/named filter disclosure, close/Escape focus return with criteria retained, composition Escape, explicit presence exclusions/combinations, empty-filter recovery and search clear focus. Existing Stalwart photo-filter tests now choose the explicit Yes option.
- Scoped ESLint and production build including TypeScript passed. Existing Vite config-loader, test navigation/act and Turbopack tracing warnings remain.
- Isolated browser review rendered the production ContactList with local contact fixtures and no-op mutation/export callbacks. The 320x568 review had page client/scroll widths of 320px, search width about 270px, a 241px filter panel and 148px results pane. Keyboard focus scrolled lower presence controls into view while the sticky Clear/Close row stayed visible. Choosing Has email = No left only the fixture without email; Escape returned to Filters and retained that criterion. Desktop pane review used 576px width.
- Screenshots: research workspace `memail-contacts-workflow.jpg` and `memail-contacts-workflow-phone.jpg`. Temporary route removed, review tab closed and viewport reset. No stored contacts, emails, drafts or accounts were changed. Real-account address-book task walkthroughs, full dark/RTL/zoom/device acceptance and remaining connected-app work are open. AI deferred; production unchanged.


## Calendar navigation and application-wide Heroicons

- 204 unique checks passed across 21 files across the Calendar/icon run and final cross-app smoke run. Coverage includes all built-in glyph exports, icon refs/strokes/fill/accessible naming, stored/lazy icon compatibility, phone view navigation and Tasks gating, calendar checkbox state/shared context/focus return, app unsaved-editor guards, time-grid keyboard/range/tab order, Calendar plugin/print/phone surfaces, shared menus, composer accessibility/menus, Contacts filters, Files header and settings search.
- An initial Calendar editor-guard test exposed a test selector collision with Heroicons' vendor `data-slot="icon"`. Narrowing four time-grid test helpers to `[role="button"][data-slot]` resolved it. The full Calendar run then passed 141 checks; the final smoke run passed 71, including eight Calendar toolbar checks repeated after the phone-row refinement. Scoped ESLint and production build including TypeScript passed. Existing Vite config-loader and Turbopack filesystem-tracing warnings remain.
- Browser review used production CalendarToolbar, CalendarMonthView and CalendarSearchField with local fixture date/view/visibility state, no-op event/mutation callbacks and editing disabled. At 672px pane width the desktop toolbar client/scroll widths were both 670px. At 320x568 the page client/scroll widths were both 320px; all five view labels fit. ArrowRight focused/selected Week, Home returned to Month. Calendar visibility opened at approximately x99/y219, 200x170px; toggling the shared fixture reported checked=true and Escape restored Calendars focus.
- Screenshots: research workspace `memail-calendar-heroicons.jpg` and `memail-calendar-heroicons-phone.jpg`. Temporary review route removed, viewport reset and review tab closed. The fixture rendered the month grid only; live week/day/agenda acceptance was not claimed. No stored event, contact, email, draft or account changed.
- Existing custom/plugin/brand icon choices remain compatible; aliases without exact Heroicons equivalents use related official symbols. Real-account calendar task walkthroughs and full dark/RTL/zoom/device acceptance remain open. AI deferred; production unchanged.


## Calendar search layout and pane-local navigation

- 102 unique checks passed across 7 files across the broader Calendar run and final search/toolbar rerun. Coverage includes simultaneous pane focus boundaries, unique result heading IDs, Home/End/Escape, modified/composition keys, clear/no-result recovery, forwarded refs, event/context callbacks, semantic display-wall timestamps, refresh busy state, phone search trigger restoration, search-hook matching/loading, unsaved-editor guards, print, plugin surfaces and Heroicons compatibility. Scoped ESLint and production build including TypeScript passed; existing Vite config-loader and Turbopack tracing warnings remain.
- Browser used an isolated client-only fixture with production CalendarToolbar, CalendarSearchField and CalendarSearchResults, local queries/results and no-op event/account mutations. The warm development server initially served old SSR component markup against current client code; the review fixture was changed to client-only rendering. This review does not establish SSR integration acceptance.
- Desktop dark-theme review used an 896px pane. At 320x568 the page client/scroll widths were both 320px and the result pane client/scroll widths were both 286px. Long titles used two lines; date/time, wrapped calendar/location names and recurrence metadata stayed readable. Down entered the first result, End scrolled to the last, and Escape restored the same field without clearing the query. Subsequent field Escapes cleared then dismissed search and returned focus to the remounted Search trigger. The final phone search variant omits the redundant actions row.
- Screenshots: research workspace `memail-calendar-search.jpg` and `memail-calendar-search-phone.jpg`. Fixture routes removed, review tabs closed and viewport reset. No stored event, email, draft, contact or account changed. Real-account search/reconnect, complete breakpoint/RTL/zoom/device and SSR walkthroughs remain open. AI deferred; production unchanged.


## Files details actions and narrow preview headers

- 72 unique checks passed across 9 files across the broader Files run and final details/preview/browser rerun. Coverage includes overlay Tab containment and Escape return, desktop focus behavior, nested preview close order, action callbacks, device/symlink restrictions, edit precedence/favorite state, selection preservation, plugin surfaces, preview content/sanitization, existing overlay restoration and Heroicons compatibility. The metadata region's Tab stop and select/composition/modified-arrow guards are checked. Scoped ESLint and production build including TypeScript passed; existing Vite config-loader and Turbopack tracing warnings remain.
- Isolated client-only browser review rendered production FileDetailsPanel and PreviewShell with a local shared-file fixture and no-op file mutation/download callbacks. Desktop details retained opener focus. At 320x568 the page client/scroll widths were both 320px; metadata client/scroll widths were both 256px. Page Down scrolled metadata while the footer stayed approximately y447..555. The preview header measured 320px client/scroll width and 85px height with previous/next, extra action, Download and Close visible.
- Escape closed the nested preview first, kept Details open and returned focus to Preview. Another Escape closed Details and returned to Show file details. All reviewed host glyphs reported the Heroicons family. Screenshots: research workspace `memail-files-details.jpg`, `memail-files-details-phone.jpg`, and `memail-files-preview-phone.jpg`.
- Fixture routes removed, review tab closed and viewport reset. No real file, event, contact, email, draft or account changed. Real-account WebDAV/share/download walkthroughs and full breakpoint/RTL/zoom/device/plugin-widget acceptance remain open. AI deferred; production unchanged.


## Contact profile layout and section navigation

- 65 checks passed across 8 files covering contact details, plugin surfaces, app/menu/button naming, print and Heroicons compatibility. New checks cover pane-local section activation, unique named headings, boundary/RTL/composition/modifier navigation, persistent action placement, focusable property scrolling, copied-value descriptions and omission of unavailable sections. Scoped ESLint and production build including TypeScript passed; existing Vite config-loader, test navigation and Turbopack tracing warnings remain.
- An isolated client-only ContactDetail fixture was checked through browser DOM/accessibility controls. At 1024x768, the page client/scroll widths were both 1024px and properties had two approximately 447px columns. At 320x568, the page widths were both 320px, the property region widths were both 286px, it retained 211px height, and cards used one approximately 254px column. Header actions measured 262px client/scroll width in a 70px wrapped row.
- Choosing Notes scrolled the property region about 750px and focused that profile's named Notes section. Home returned section-navigation focus to Contact details without invoking an action. Host glyphs reported the Heroicons family. Native mutation/call/compose actions were not invoked during browser review.
- Screenshot capture repeatedly reported unavailable on the original and a fresh review tab, including an explicit desktop viewport; DOM/accessibility review succeeded. No screenshot or visual acceptance is claimed for this increment. Fixture routes removed, both review tabs closed and viewport reset. No stored contact, account, email, draft, event or file was changed. Real-account, complete visual, breakpoint/RTL/zoom/device acceptance remain open. AI deferred; production unchanged.
