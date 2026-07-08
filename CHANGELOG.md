# Changelog

## 1.7.6 (2026-06-28)

### Breaking Changes

- **S/MIME**: The built-in S/MIME implementation has been removed from core and re-delivered through the new generic crypto plugin hooks (privileged same-origin plugin tier). S/MIME signing, encryption, decryption, certificate management, and the related settings UI now live in a plugin rather than the main app. Deployments that relied on built-in S/MIME must install the S/MIME crypto plugin to retain those features.

### Features

- **Plugins**: Privileged same-origin plugin tier with a crypto API surface
- **Plugins**: Plugin hooks for email details, headers, and source
- **Mail**: Option to hide the total message count on folders (#498)

### Fixes

- **Mail**: Hide the server scheduled folder when the virtual one is shown (#495)
- **Mail**: Stop the unified mailbox from mutating client-returned email objects
- **Composer**: HTML-escape sender and subject in the reply/forward quote header (#482)
- **Calendar**: Send calendar invites by setting `organizerCalendarAddress`
- **Identity**: Sync the default identity (`preferredPrimaryId`) to server settings (#507)
- **Auth**: Support MFA login via the structured auth endpoint
- **Admin**: Show all built-in themes in the admin theme controls (#496)
- **i18n**: Add missing translation keys across 19 locales

## 1.7.5 (2026-06-24)

### Features

- **Mail**: Cross-account "All accounts" views with full group/shared-account support
- **Mail**: Per-account "All Mail" folder selection
- **Mail**: "Download all" button to bundle attachments into a zip (#466)
- **Mail**: Return to the list after deleting or marking the open message unread — configurable (default on)
- **Mail**: Collapse-all-threads action in thread-list selection
- **Calendar**: Option to disable the calendar
- **Composer**: Send-now button on scheduled/delayed messages
- **Composer**: Email a contact or group via the in-app composer
- **Composer**: Split a pasted address list into recipient chips
- **Contacts**: "New address book" creation UI (#415)
- **OAuth**: `OAUTH_AUTHORIZE_URL` to override the authorize endpoint
- **i18n**: Farsi (fa) locale — complete (2654 strings)
- **i18n**: Romanian (ro) locale

### Fixes

- **Composer**: Keep HTML signature styling in the editor and on send
- **Composer**: Guard Send against double-submit
- **Composer**: Strip display names from the `EmailSubmission` envelope addresses
- **Calendar**: Disable iMIP scheduling on calendar import (#411)
- **Mail**: Localize special-folder names by JMAP role (#404)
- **Mail**: Block remaining email tracking vectors (#457)
- **Mail**: Route counter and unread updates to the email's own account in aggregate views
- **Mail**: Fix blank space in plain-text emails
- **Mail**: Fix toolbar re-render when opening emails
- **Mail**: Truncate long subjects so they don't overlap the timestamp
- **Mail**: Strip reply/forward prefixes followed by a full-width colon
- **Mail**: Add breathing room between the unread dot and the avatar
- **Mail**: Isolate per-account state snapshots from leakage and mutation
- **Mail**: Cap filename tokens at the full 200-char limit
- **Spam**: Fetch mailboxes with `accountId` in `markAsSpam`
- **Filters**: Load mailboxes when opened directly (#485)
- **Settings**: Surface server errors on password change and TOTP toggle
- **Send now**: Gate the toolbar label and translate `send_now` across locales
- **Directory**: Fix fetching display names
- **Push**: Reap only relay-confirmed-dead leftover subscriptions
- **i18n**: Add the missing fa locale to the client `IntlProvider` messages map
- **i18n**: Add missing translation keys across 19 locales

## 1.7.4 (2026-06-15)

### Features

- **Mail**: New "All Mail" view across folders and accounts
- **Mail**: Edit contact directly from the email viewer contact sidebar
- **Calendar**: Recurrence editor, set-default calendar, and timezone-aware calendar queries
- **Calendar**: Agenda plugin sidecar
- **Composer**: Email display name support
- **Composer**: Drag-and-drop recipient chips between To/CC/BCC fields, with the address shown in the drag preview
- **Composer**: Avatars in recipient autocomplete suggestions, including directory users
- **Files**: JMAP file/folder sharing in the Files app (#408)
- **Auth**: QR-code SSO login and device pairing between webmail and the mobile app
- **Auth**: Require re-authentication for device pairing and SSO
- **Accounts**: Manage shared/group account settings from the Accounts page
- **Setup**: Opt-in telemetry in the web setup wizard
- **Mail**: Persist the email detail sidebar state

### Fixes

- **Mail**: Preserve line breaks in the generated `text/plain` alternative (#421)
- **Mail**: Fix inconsistent threading of email messages in the inbox and folders
- **Mail**: Stop draft emails from being marked as unread
- **Mail**: Prevent wide email tables from rendering with rotated headers (#409)
- **Mail**: Preserve the folder list when a mailbox refetch hits the concurrent-request limit
- **Mail**: Correct dark-mode background-image inversion and height clipping in the email viewer
- **Calendar**: Dedupe scheduling emails and use Stalwart-compatible calendar filters
- **Calendar**: Redesign the custom recurrence editor to match the modal UI
- **Files**: Don't send the connected-account key as the JMAP `accountId` when sharing files (#408)
- **Routing**: Strip the build-time `basePath` from `router.push` redirects after login (#390)
- **Nav**: Open recent contact emails at `/` instead of 404ing on `/mail`
- **Nav**: Hide the Add App button when `sidebarAppsEnabled` is false
- **Settings**: Move the "Plain Text Only" setting from Reading to Composing (#422)
- **Privacy**: Make telemetry opt-in
- **UI**: Fix the context menu being invisible on first right-click after page load
- **Admin**: Remove the JMAP status from the admin dashboard
- **i18n**: Add missing translation keys across 17 locales

## 1.7.3 (2026-06-04)

### Features

- **Mail**: Inline attachment preview — reliable MIME detection with inline PDF on desktop and mobile
- **Mail**: Preview composer attachments inline (click to open)
- **Mail**: Preview `.eml` (`message/rfc822`) attachments like an email
- **Mail**: Read receipts (MDN, RFC 8098)
- **Mail**: Editable, layout-preserving quote island when replying
- **Mail**: Surface the most severe SPF result and hide the "via" badge on spoofed mail
- **Calendar**: Per-viewer colors for shared calendars (#345)
- **Filters**: Extended filter rules — attachment field and multi-value conditions
- **Settings**: New built-in themes — Aurora Glass and Elastic
- **Settings**: Theme cards render as a mini mailbox mockup from theme colors, with light/dark variant chips
- **Plugins**: Localizable sandboxed plugins (manifest locales + `api.i18n.t`)
- **Plugins**: `/api/translate` proxy and email body exposed to plugins
- **Admin**: Toggle for search-engine indexing (robots)
- **Admin**: `passwordHashFile` in `admin.json`
- **Admin**: `sessionSecretFile` and `oauthClientSecretFile` for file-based secrets in JSON config
- **PWA**: Configurable install screenshots (per-domain)
- **i18n**: Hungarian locale support

### Fixes

- **Files**: Store Files as real `FileNode` hierarchy, migrate legacy flat-named files on load, and list folders via `FileNode/get` so they are visible (#379)
- **Files**: Treat a blob-less `FileNode` as the only folder signal and migrate legacy dir-markers
- **Mail**: Empty Trash for shared and group folders (#387)
- **Mail**: Move mail from a shared group inbox to a personal inbox (#375)
- **Mail**: Preserve the HTML signature when sending a quick reply
- **Mail**: Stop body clipping under the fold when the email sets `html`/`body` `height: 100%`
- **Mail**: Drop single-letter `R:`/`I:` subject prefix tokens and deduplicate localized reply/forward prefixes
- **Mail**: No more 404 console spam for missing sender favicons
- **Auth**: Discover OIDC metadata server-side to avoid CORS failures (#382)
- **Send**: Route the Sent copy to the shared-mailbox account on per-identity send
- **Routing**: Honour `basePath` in the plugin sandbox, `http.post` proxy, and branding
- **i18n**: Localize the PWA install prompt, reply/forward quote header (incl. sender address), `<html lang>`, and per-locale `<head>` description; add missing `settings.folders.role_memos` key
- **Themes**: Plugin slot iframes inherit host font and color tokens
- **Theme**: Gate preview "open in new tab" on inline-safe MIME types
- **Appearance**: Move Themes settings into the Appearance category with a distinct tab icon; clicking the active theme is a no-op
- **UI**: Fix invisible dark-mode borders (border token collided with secondary)
- **UI**: Remove the 16px empty strip beside the collapsed sidebar
- **UI**: Align top bars to a uniform `h-14` height and the account selector header to the search/reply toolbars
- **UI**: Close pane gaps by centering the resize handle on the seam
- **Settings**: Fix section gears permanently hijacking the active tab

## 1.7.2 (2026-05-28)

### Features

- **Mail**: Scheduled send and send delay (#322)
- **Mail**: Drag emails out to the file explorer as `.eml`
- **Mail**: Import emails from `.zip` archives
- **Mail**: "Move to Trash and mark as read" delete action (#323)
- **Mail**: Include group inboxes in the unified mailbox view (#328)
- **Mail**: Locale-aware date format in the email list with a preset picker (#331)
- **Mail**: Allow drag-and-drop into shared mailboxes
- **Composer**: Ctrl/Cmd+Enter sends the open draft
- **Settings**: New Downloads tab with template editor for `.eml` and attachment filenames
- **Settings**: Filename transform settings and an ASCII-only "date (from-to) subject" template
- **Settings**: Post-export action (keep / archive / trash)
- **Settings**: Template for multi-email `.zip` filenames
- **Admin**: Per-domain branding editor with overrides on `/api/config`, manifest, and PWA icon (#332)
- **Admin**: Policy-controlled push relay URL with optional user lock
- **i18n**: `NEXT_PUBLIC_DEFAULT_LOCALE` for fallback UI locale (#243)

### Fixes

- **Mail**: Editable HTML signature in new mail; clean state on every compose entry (#329)
- **Mail**: Report real upload progress with XHR progress events (#333)
- **Mail**: Restore `blob:` in `object-src` and `frame-src` CSP for PDF/HTML previews
- **Mail**: Match user-avatar treatment on quick reply
- **Email viewer**: Stop shattering table cells with `word-break: break-word`
- **Composer**: Scope Ctrl/Cmd+Enter send to the focused composer
- **Composer**: Stop closing the form when editing any field
- **Pro**: Keep the empty viewer pane visible in the split layout
- **Pro**: Prevent an empty main pane when reordering tabs across panes
- **Mobile**: Collapse focus mail layout to multi-line
- **Mobile**: Keep a gutter on bare-HTML and plain-text emails
- **Calendar**: Align continued multi-week events with the week's left edge
- **Calendar**: Show the end date in the event popover for multi-day events (#318)
- **Calendar**: Convert `recurrenceRules` to singular in batch create
- **Calendar**: Handle malformed event dates (#316)
- **Files**: Stop URL-encoding drag-out filenames and preserve Unicode letters
- **Routing**: Prefix remaining `<img>`, favicon, and WebDAV URLs with `basePath` (#319)
- **Routing**: Prefix hand-written URLs with `basePath` for subpath deployments
- **Auth**: `OAUTH_ALLOW_PRIVATE_ENDPOINTS` for split-DNS setups

### i18n

- Add missing translation keys across 16 locales

## 1.7.1 (2026-05-22)

### Features

- **Admin**: Expose PWA branding fields in the admin Branding tab
- **Pro**: Hide empty-state placeholder and collapse the viewer pane in Pro mode so the mail list fills the space

### Fixes

- **Mail**: Preserve inline images when replying (#163)
- **Filters**: Use the canonical `INBOX` mailbox in Sieve filter paths (#313)
- **Mail**: Resolve destination account id to the local namespace on cross-account mailbox drop

## 1.7.0 (2026-05-21)

> **New: Pro mode (experimental).** Opt-in tabbed multi-pane interface for power users. Open multiple mail, calendar, contacts, and file views side-by-side, drag tabs to reorder or split panes at the edges, and work across all logged-in accounts in one shell - cross-account email moves, a unified inbox with search, account-split calendar/contacts/files sidebars, and a per-account "From" dropdown in the composer. Enable from Settings → Appearance; the `proInterface` preference is per-device and not synced.

### Breaking Changes

- **Plugins**: Plugins now run inside a null-origin iframe sandbox and talk to the host over a postMessage RPC bridge. The in-process plugin runtime is gone; the bundled in-tree plugins have been migrated. Third-party plugins built against the old in-process API need to be ported to the sandboxed runtime.
- **Plugins**: Server-managed bundles must be Ed25519-signed by the host and approved by an admin before they load. The host public key is served from `/api/plugin-signing-pubkey` and each bundle response carries the signature in the `X-Bundle-Signature` header. User-uploaded bundles still load unsigned, but managed marketplace and dev-folder bundles do not.
- **Plugins**: `bundleHash` is now a full SHA-256 over the bundle. Legacy short hashes are migrated on first load; any out-of-band tooling that pinned the old hash format needs to be updated.

### Features

- **Pro**: Tabbed shell with drag-to-reorder, drag-to-edge to split, side-by-side panes, and pane-aware responsive layout with a scoped sidebar overlay
- **Pro**: Auto-redirect to the Pro shell when Pro mode is on; `proInterface` is kept per-device instead of syncing
- **Pro**: Multi-account mail sidebar with client routing and a per-account mailbox cache
- **Pro**: Unified mailbox always visible, with full-text search
- **Pro**: Cross-account email moves
- **Pro**: Multi-account calendar sidebar split into owned vs shared per account
- **Pro**: Multi-account contacts and a cross-account file picker
- **Pro**: Composer From dropdown grouped by account
- **Plugins**: Per-plugin admin approval workflow with Ed25519 bundle signing verified on load
- **Plugins**: Marketplace update flow for installed plugins and themes
- **Setup**: Allow the setup wizard over plain HTTP with a dismissable warning gate
- **Setup**: Warn when the JMAP URL points at a local-only host
- **Account**: List and reorder logged-in accounts from settings (#282)
- **Mail**: Mobile handoff page with JMAP authentication verification for cross-device OAuth
- **Mail**: Pluggable reply/forward quote header (#295)
- **Calendar**: Support multiple flexible event reminders (#170)
- **Admin**: Expose PWA, app identity, and extension directory keys in the JSON config (#312)
- **Admin**: Surface OAuth scope settings and wire up orphaned admin policy gates

### Security

- **Plugins**: Pin parent origin in the iframe bridge to block cross-frame postMessage
- **Plugins**: Ignore plugin-supplied `target` in `ui.openExternalUrl` to block host-frame hijack
- **Plugins**: Validate plugin/theme id in marketplace install to block path traversal
- **Plugins**: Prevent plugin config from leaking to non-admin users
- **Admin**: Gate admin routes against cross-origin CSRF
- **Auth**: Bind Stalwart auth context to the credential, not the cookie-claimed username
- **Auth**: Validate OAuth discovery endpoints against SSRF
- **Mail**: Tighten HTML sanitization at plain-text email, signature, and i18n render sites
- **Mail**: Block script-bearing MIME types from inline attachment preview
- **Mail**: Escape print-window fields and re-sanitize body to block XSS
- **S/MIME**: Stop persisting passphrases in `sessionStorage`
- **API**: Correct regex for valid API POST path validation

### Fixes

- **Mail**: Serialize draft autosave with send to stop replies stalling in Drafts (#303)
- **Mail**: Omit empty cc/bcc from `Email/set` so the server does not emit a bare `Cc:` header (#301)
- **Mobile**: Allow adding contacts from the mail recipient popover (#306)
- **Mobile**: Prevent dual-scroll and use full width for mail content
- **Mobile**: OAuth handoff flow
- **Calendar**: Scope iCal subscriptions per JMAP account; fix refresh and clear
- **Calendar**: iCal subscription refresh, rollback, and URL normalization
- **Calendar**: Show avatars in the calendar/address book sharing menu
- **Contacts**: Normalize malformed contact photo data URIs (#307)
- **Identity**: Clear identity signature fields when emptied
- **Identity**: Show size cap on identity signature fields
- **Identity**: Allow table-based layouts in the HTML signature sanitizer
- **Plugins**: Load `globals.css` and Geist font in the plugin sandbox iframe
- **Plugins**: Sync plugin slot iframe height with reported content height
- **Plugins**: Use plugin slot offer snapshots for `useSyncExternalStore`
- **Plugins**: Trust the directory version on marketplace install and update
- **Filters**: Prevent duplication of Bulwark rules with literal braces in values
- **Setup**: Defer setup wizard HTTP detection to avoid hydration mismatch
- **Routing**: Anchor unmatched URLs into `main` so 404 renders
- **Routing**: Respect server-resolved locale on first visit (#309)
- **Routing**: Split app into `(main)`/`(sandbox)` route groups so the plugin iframe hydrates properly
- **Files**: Stop parent directory navigation from jumping to root
- **Build**: Stop pulling `node:dns` into the client bundle via OAuth discovery
- **UI**: Toggle recipient popover when clicking the name again
- **UI**: Remove white halo around photo avatars

### i18n

- Add missing translation keys across 16 locales

## 1.6.7 (2026-05-17)

### Features

- **Contacts**: vCard 4.0 parsing and generation support
- **Admin**: Master-user impersonation route with `app-top-banner` plugin slot rendered on every authenticated page
- **Admin**: Allow admin password overwrite during setup recovery
- **Setup**: HTTPS requirement warning in the setup wizard
- **Mobile**: Show details toggle and expandable panel for sender info

### Performance

- **Calendar**: Speed up calendar invitation banner load

### Security

- **Mail**: Sandbox thread email HTML in `srcDoc` iframe with a CSP `<meta>` tag
- **Admin**: Redact sensitive config secrets from the admin API response
- **Admin**: Make impersonation cookies session-only

### Fixes

- **Auth**: Read `OAUTH_SCOPES` at runtime instead of build time
- **Auth**: Use a relative `Location` header in redirects
- **Auth**: Adopt orphan session cookie on first SPA load
- **Mail**: Per-account push subscriptions so multi-account notifications work (#298)
- **Mail**: Close attachment preview when clicking outside the content area
- **Mail**: Pin quick reply to the bottom for short emails
- **Mail**: Show "no body content" instead of an infinite skeleton for bodyless emails
- **Mail**: Show contact popup when clicking the sender name in the email header
- **Mail**: Prevent long addresses from overflowing email details columns (#297)
- **Mobile**: Align quick reply with the mobile bottom toolbar
- **Mobile**: Respect safe-area insets on mobile bottom bars
- **Mobile**: Pad `safe-area-inset-top`
- **UI**: Apply dark background to the email content wrapper in dark mode
- **UI**: Improve dark mode background colors in the email viewer
- **UI**: Add viewport export with `initialScale: 1`
- **UI**: Strip the Stalwart master-user `%` suffix from the displayed account
- **Plugins**: Warn and block install when the app version is below the plugin's `minAppVersion`
- **Plugins**: Register `app-top-banner` in plugin-store `SLOT_NAMES`
- **Plugins**: Carry `configSchema` + `settingsSchema` through marketplace install
- **Build**: Add `outputFileTracingExcludes` to reduce Turbopack memory tracing

### i18n

- Add missing translation keys across 16 locales

## 1.6.6 (2026-05-15)

### Features

- **Mail**: Sync onboarding completion state across devices so the welcome flow only runs once per account (#285)
- **Mail**: Distinct icons for Shared, Important, Memos, Scheduled, and Snoozed folders (#288)
- **Compose**: Raise HTML identity signature length cap to 50,000 characters
- **Compose**: Allow `<img>` tags in HTML identity signatures for inline logos and banners

### Fixes

- **Files**: Hide Files settings entry and sidebar nav when the `filesEnabled` policy is off (#291)
- **Admin**: Honor the `cookieSameSite` admin config override instead of always defaulting (#284)
- **UI**: Standardize punctuation in tooltips and inline comments across locales

### i18n

- Add Danish localization
- Clean up Danish locale wiring and sort the language picker alphabetically (#286)

## 1.6.5 (2026-05-13)

### Features

- **Protocol**: Register as the system handler for `mailto:` and `webcal:` links from a new protocol handler settings page
- **Protocol**: Account picker for protocol links when multiple accounts are connected
- **Protocol**: Import-or-subscribe choice for detected webcal calendars
- **Protocol**: Reuse the open PWA/session for `mailto:` links instead of always opening a new tab
- **UI**: Route account avatars through the shared `Avatar` component for consistent fallbacks (#278)

### Fixes

- **Calendar**: Support HTTP basic auth in iCal subscription URLs (#275)
- **Admin**: Honor admin-uploaded favicon in root metadata (#274)
- **Admin**: Honor `NEXT_PUBLIC_BASE_PATH` in admin sidebar nav links (#271)
- **UI**: Broaden body font stack so Thai (and other non-Latin scripts) render correctly in subjects, sender names, and other chrome (#265)

## 1.6.4 (2026-05-11)

### Web Setup Wizard

First-launch web setup wizard. New installs no longer need to hand-edit `.env.local` - point a browser at the container and the wizard probes the JMAP server(s), configures OAuth/OIDC, generates the session secret, accepts branding uploads, and provisions the initial admin password. Admin storage is now split into `ADMIN_CONFIG_DIR` (operator-authored, mountable read-only after setup) and `ADMIN_STATE_DIR` (runtime audit log and login timestamps); the legacy `ADMIN_DATA_DIR` keeps working for existing installs.

### Features

- **Setup**: Web setup wizard with multi-step flow: Server, Auth, Security, Logging, Branding, Review, Admin
- **Setup**: Admin config/state directory split with optional `ADMIN_CONFIG_READONLY` for immutable deployments (#226)
- **Setup**: File uploads on the wizard branding step
- **Setup**: Redesigned review step with grouped summary and an advanced toggle for the full config
- **Setup**: Require explicit confirmation when JMAP probe finds no session
- **Mail**: Drag attachments out of the viewer to the local file system (#267)
- **Mail**: Reading Pane at Bottom mail layout (#262)
- **Mail**: Configurable signature position - above or below quoted text (#266)
- **Mail**: Signature position is now searchable from the email behavior settings
- **Mail**: Show avatar in Focused list for compact density and above
- **Mail**: Align Focused list preview with other layout previews
- **Compose**: From-header override in the composer with catch-all auto-reply, replies to an alias on a domain you own pre-fill the alias as the sender even when it isn't a configured identity (#246)

### Performance

- **Mail**: Prefetch initial email data on login
- **Auth**: Parallelize login round-trips and drop redundant JMAP re-verify

### Fixes

- **Auth**: Skip upstream JMAP reverify for trusted URLs (#237)
- **Auth**: Show account identity in the switcher header instead of the sending alias
- **Compose**: Fall back to the primary identity signature on reply
- **Setup**: Drop redundant first-login banner about removing `ADMIN_PASSWORD` (#222)
- **UI**: Consistent notice cards for server probe results

### i18n

- Add missing translation keys across 15 locales

## 1.6.3 (2026-05-08)

### Features

- **Mail**: Lift 5-account cap on HTTP/2
- **Mail**: Import `.eml` files via folder right-click menu

### Fixes

- **Mail**: Trim leading whitespace from email list preview
- **Mail**: Fall back when only the truncation indicator remains in email preview
- **Mail**: Hide files/contacts nav items when JMAP server lacks support
- **Viewer**: Preserve emoji colors in dark mode
- **Viewer**: Prevent white-on-white in dark mode for nested `bgcolor` containers
- **Viewer**: Render plain-text-only emails as text, not HTML
- **Viewer**: Render HTML-only emails and redesign external content prompt
- **Viewer**: Pad Word/Outlook HTML email rendering
- **Compose**: Redesign quick reply to match sender/banner layout
- **Compose**: Disable StarterKit's bundled link/underline to avoid duplicate extensions
- **Sharing**: Request `shareWith` explicitly so calendar/address book shares survive a re-login (#257)
- **UI**: Strip leading punctuation when computing avatar initials
- **Mobile**: Hide email hover actions

### i18n

- Add missing translation keys across 15 locales

## 1.6.2 (2026-05-06)

### Features

- **Plugins**: Hot-reload and dev-folder loading for live plugin development
- **Plugins**: On-demand `src/` bundling via esbuild
- **Plugins**: New `http:fetch` permission and `httpOrigins` manifest field
- **Plugins**: `onBeforeEmailSend` hook with `fromEmail` exposed on `OutgoingEmail`
- **Plugins**: Project `EmailReadView` for the email-banner slot and expose auth results
- **Plugins**: Ingest icon, banner, and screenshots from the source repo
- **Plugins**: Restrict plugin and theme install/uninstall to the admin dashboard
- **Mail**: Multi-server JMAP support
- **Settings**: Fulltext search across the settings sidebar
- **Settings**: Sub-result rows with highlight in settings search
- **Settings**: Surface plugin settings as search sub-results
- **Settings**: Remove experimental tags from themes, plugins, and sender favicons
- **Viewer**: Redesigned external-mail banner above attachments
- **Calendar**: Calendar invitation banner expands on row click
- **Calendar**: Calendar invitation banner is now collapsible

### Fixes

- **Admin**: Collapse admin panel into a single tabbed page
- **Plugins**: Inline plugin configure panel to avoid dev-mode hang
- **Plugins**: Resolve `PLUGIN_DEV_DIR` plugins in admin config route
- **Plugins**: Add missing body type assertion in `createPluginAPI` fetch options
- **Plugins**: Propagate `settingsSchema`
- **Settings**: Highlight plugin and theme cards in search results
- **Settings**: Open plugin card on first click of a setting sub-result
- **Settings**: Drop ghost sub-results from account and language search
- **Settings**: Improve search highlight styling
- **Viewer**: Show notification banners above attachments
- **Viewer**: Rework S/MIME banner to match calendar invitation
- **Viewer**: Close PDF preview on Escape before email viewer
- **Viewer**: Render PDF previews via `<object>` with `blob:` in object-src CSP (#253)
- **Calendar**: Align invitation icon with sender avatar column
- **Calendar**: Fix invitation picker clipping (#250)
- **Auth**: Read `activeAccountId` from authStore in account selectors
- **UI**: Adjust toast item border radius and progress bar styles
- **UI**: Remove fly-in animation from context menu submenus
- **i18n**: Add missing Czech flag icon

### i18n

- Add missing translation keys across 15 locales

## 1.6.1 (2026-05-04)

### Features

- **Updates**: Update-available detection with non-dismissible notice and dev-reload refresh
- **Plugins**: New plugin hooks for compose, attachments, search, lifecycle, and routing
- **Sharing**: Share indicators for calendars and contacts, updated JMAP capabilities (#244)
- **Mail**: Auto-add recipients to trusted senders when replying
- **Identity**: Sanitize identity display name to prevent invalid `From` headers

### Fixes

- **Mobile**: Synchronize mobile submenu view with browser history for better navigation
- **Viewer**: Update email viewer styles to improve overflow handling
- **Auth**: Ensure `cookieSlot` consistency during account updates in auth store
- **Auth**: Thread per-account cookie slot through OAuth flows
- **Calendar**: Square the colored left marker on calendar events
- **About**: Show git commit in About instead of "unknown"

### i18n

- Update mailbox context menu translations across 12 locales

## 1.6.0 (2026-05-01)

### Features

- **Deployment**: Subpath deployment support via `NEXT_PUBLIC_BASE_PATH` environment variable
- **Mail**: Image attachment thumbnails and preview chips
- **Mobile**: Reworked mobile mail viewer toolbar
- **Mobile**: Mobile-friendly settings panel
- **Mobile**: Mobile-friendly admin panel
- **Mail**: Redesigned expanded details panel
- **Mailbox**: Show full path in mailbox context menu header with intelligent path shortening

### Fixes

- **Viewer**: Respect per-email dark mode toggle when "always show in light mode" is on
- **Navigation**: Scroll apps list in navigation rail to prevent overflow
- **Context menu**: Clamp submenu inside viewport
- **Context menu**: Prevent context menu from clipping below viewport
- **Context menu**: Prevent jump and animation on open
- **Mail**: Stop silently destroying emails when trash mailbox isn't found (#195)
- **Mail**: Preserve list scroll position when tagging an email
- **Mail**: Render below-header overflow popup outside clipped row
- **Mail**: Collapse below-header attachments to single row with overflow pill
- **Push**: Fix push preview JMAP query
- **Tour**: Navigate tour to mailbox when starting from another page
- **i18n**: Add `useTranslations` for "selected emails" and "cancel" on email list batch operations

### i18n

- Translate SPF/DKIM/DMARC tooltips
- Add missing keys across 14 locales

## 1.5.4 (2026-05-01)

### Features

- **PWA**: Web push notifications for new inbox mail (#233), with click-through to open the message
- **Composer**: Insert and edit tables in rich-text emails (#236)
- **Mail**: Configurable sub-addressing delimiter character (#239)
- **i18n**: Turkish localization
- **i18n**: Missing keys filled in across 15 locales

### Fixes

- **Mail**: Set In-Reply-To and References headers on replies (#234)
- **Mail**: Persist htmlBody in drafts to preserve rich formatting (#236)
- **Auth**: Pin JMAP auth verification to the configured server URL (#237)
- **Auth**: Evict unrecoverable basic-auth accounts on reload
- **Notifications**: Scope new-mail notifications to genuine inbox deliveries
- **Notifications**: Extend PushVerification timeout and clean up leftover subscriptions
- **Viewer**: Smooth out body load to prevent flicker on first render
- **Viewer**: Prevent iframe flash when loading images or trusting the sender
- **Viewer**: Pad bare HTML emails like plain-text mails for consistent layout
- **Viewer**: Light-mode override now only affects body content
- **Viewer**: Detect `<style>` tag when applying padding
- **Viewer**: Drop iframe border-radius
- **Calendar**: Localize event start date in detail popover and event modal
- **Dev**: Include http protocol in connect-src for development mode CSP

## 1.5.3 (2026-04-28)

> **New:** Help shape Bulwark Webmail. Each instance now sends a lightweight daily heartbeat (version, platform, bucketed account counts, feature toggles - never message data or PII) so we can see which platforms and features actually get used and prioritize fixes where they matter most. You're in control: opt out any time from **Admin → Telemetry** or by setting `BULWARK_TELEMETRY=off`. Full schema in the [privacy notice](https://bulwarkmail.org/docs/legal/privacy/telemetry).

### Features

- **Telemetry**: Anonymous instance telemetry, on by default. Reports schema version, platform, bucketed account counts, and feature toggles only - disable from the admin UI, with `BULWARK_TELEMETRY=off`, or by clearing the endpoint
- **Telemetry**: Track unique logins (HMAC'd per instance, 90-day retention) so the heartbeat can report bucketed account totals without storing usernames
- **Plugins**: Theme API v2 with token compiler and skin slot
- **Plugins**: Extension preview page and detailed extension info API
- **Calendar**: Right-click context menu on empty calendar space
- **Docker**: Persistent named volume for telemetry data so the instance id and admin's consent choice survive container upgrades

### Fixes

- **Security**: Block telemetry endpoint from pointing at internal/loopback hosts (validation + DNS-rebind re-check at fetch time)
- **Security**: Harden plugin config, TOTP token exchange, and branding file serving
- **Mail**: Batch shortcuts now act on the multi-selection when one is present (#228)

## 1.5.2 (2026-04-27)

### Features

- **Plugins**: New `composer-sidebar` slot and `ui:composer-sidebar` permission - plugins can now render a panel on either side of the New Message dialog. See `repos/subway-surfers` for an example
- **Plugins**: Manifests can declare `frameOrigins` - a strictly-validated list of `https://host` origins the plugin needs to embed. The proxy reads the union from enabled plugins and merges it into the host CSP `frame-src`, so the host CSP no longer needs to know about specific embed providers
- **Calendar/Contacts**: JMAP sharing for calendars and address books
- **i18n**: Czech language support

### Fixes

- **Security**: Validate URLs before outbound fetch
- **Calendar**: Prevent drag creation on touch events in the time grid
- **Contacts**: Emit RFC 9553 name kinds and decode QUOTED-PRINTABLE in vCard import (#224, #187)
- **Mail**: Hide preview line in compact density to match settings preview (#223)
- **Proxy**: Inline matcher for Next.js proxy and drop unnecessary Node.js runtime config
- **i18n**: Portuguese fixes for "ficheiro" and "contactos" variants

## 1.5.1 (2026-04-25)

### Features

- **Stalwart**: OAuth auto-setup with dialog and validation for origin and issuer URLs
- **Mail**: Right-click context menu on the folders sidebar
- **Mail**: Replace folder `prompt()` calls with a proper modal dialog
- **Calendar**: Add 'Today' button to the desktop calendar toolbar
- **Junk**: Setting to show avatars in the Junk folder (off by default)

### Fixes

- **Admin**: Restore admin panel after Stalwart v0.16 REST API removal
- **Viewer**: Restore broken viewer toolbar actions and improve the mobile menu (#220)
- **Folders**: Stop flicker on background folder refresh
- **Email**: Preserve search/filter on batch move and archive
- **Email**: Preserve search/filter when moving emails via drag-drop
- **i18n**: Improve Korean flag

## 1.5.0 (2026-04-22)

### Breaking Changes

- **Self-service portal now needs Stalwart 0.16+**: Stalwart dropped its self-service HTTP API in 0.16.0 and replaced it with JMAP. Bulwark Webmail only talks to the new JMAP endpoint, so the self-service portal (account settings, app passwords, API keys) requires Stalwart 0.16 or newer. `STALWART_API_URL` is deprecated, these actions go through the normal JMAP session.

### Features

- **Stalwart**: Migrate Stalwart management API to JMAP `x:` methods for Stalwart 0.16
- **Admin**: Add API Keys management and IP allowlist for App Passwords
- **Contacts**: Revamp contact detail view with filters, photo, print, and duplicate actions
- **Contacts**: Add contact activity component showing recent emails and upcoming events
- **Contacts**: Add right-click context menu
- **Contacts**: Group contacts by first letter with sticky section headers, toggleable in settings
- **Calendar**: Support resizing events from the top edge
- **Calendar**: Add timezone-aware formatting for event start times and update `utcEnd` on duration change
- **Calendar**: Optimize layout of overlapping events
- **Calendar**: Add collapsible details to calendar invitation banner
- **Email**: Implement batch archiving and bulk moving of emails
- **Email**: Show full folder path in move/drop toast
- **Settings**: Reorganize settings into 6 groups with clearer tabs
- **Navigation**: Add account-addition button to the navigation rail
- **Mobile**: Streamline email viewer header layout
- **Mobile**: Pass `isMobile` through calendar views and time-grid interactions

### Fixes

- **Mailbox**: Retry mailbox fetch on first login to handle lazy provisioning (#217)
- **Mailbox**: Use fresh state in archive handling to avoid stale mailbox data
- **Mailbox**: Improve error message on mailbox creation failure
- **Auth**: Skip `checkAuth` on route change when already authenticated
- **Auth**: Clean up unused imports and improve TOTP QR code rendering
- **UI**: Align hover styles and selection-toggle target with focused item
- **UI**: Read `matchMedia` synchronously on client to prevent layout flicker

### Refactor

- **Settings**: Remove Stalwart API URL configuration (now derived via JMAP)

### Chore

- **i18n**: Add missing translation keys
- **Deps**: Bump dependencies to latest compatible versions

## 1.4.14 (2026-04-16)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@mkorthaus-private](https://github.com/mkorthaus-private)
- [@boris22100](https://github.com/boris22100)

**Monthly**

- [@pr0ton11](https://github.com/pr0ton11)

### Features

- **Email**: Add unified mailbox across accounts and sidebar icons toggle
- **Email**: Enhance email deletion and spam handling with improved parameterization
- **Sieve**: Enhance external rule handling in parser and store (#201)
- **Plugins**: Add i18n API, render hooks, and new intercept hooks to plugin system
- **PWA**: Dynamic PWA manifest with configurable name, description, and icons
- **PWA**: Show app name and logo in install prompt
- **i18n**: Add Ukrainian language with flags and missing translation keys
- **i18n**: Configurable locale prefix via `NEXT_PUBLIC_LOCALE_PREFIX`
- **API**: Add `apiFetch` helper for mount-prefix-aware API calls

### Fixes

- **Calendar**: Send iMIP invitation emails when creating or updating calendar events (#192)
- **Calendar**: RFC 5545/6047 compliance for outgoing iMIP calendar emails
- **Calendar**: Add `calendarAddress` and `replyTo` to participants for Stalwart compatibility (#189, #192)
- **Calendar**: Improve CalDAV task detection for external clients like Thunderbird (#84)
- **Email**: Hide ICS attachments from attachment list when invitation banner is shown
- **Email**: Send before storing in Sent via `onSuccessUpdateEmail` (#188)
- **Email**: Standardize tag naming and fix unknown keyword display (#184, #185)
- **i18n**: Skip intl middleware for paths already containing a locale prefix
- **Docs**: Document PWA and branding env vars in `.env.example`
- **Docs**: Use `company` consistently in `.env.example` branding comments

## 1.4.13 (2026-04-12)

Thank you for your donations:

**One-time**

- [@boris22100](https://github.com/boris22100)
- [@mkorthaus-private](https://github.com/mkorthaus-private)

**Monthly**

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

### Features

- **Contacts**: Store trusted senders in a dedicated JMAP address book (#176)
- **Email**: Warn on send when attachment keyword found but no file attached (#172)
- **Email**: Enable keyword reordering (#174) and multi-tag support per email (#173)
- **PWA**: Add "don't remind me again" option to install prompt
- **Auth**: Add `SESSION_SECRET_FILE` and `OAUTH_CLIENT_SECRET_FILE` environment variable support
- **Plugins**: Add `onAvatarResolve` plugin hook
- **Docker**: Publish main and dev branches as separate GHCR packages

### Fixes

- **Email**: Style links in plain text emails
- **Email**: Seed list history entry when app initializes on an email view
- **Email**: Remount composer on draft edit and preserve identity (#60)
- **Contacts**: Display contact names stored in `name.full` (#179)
- **Contacts**: Fix category dropdown blocking Save button in contact form (#177)
- **Contacts**: Resolve TS error from optional `name.components` in vCard parser
- **Search**: Search all folders when filtering emails by tag (#175)
- **Auth**: Include mount prefix in SSO redirect URI when app is served under a subpath
- **PWA**: Correct PWA icons with proper sizing, transparency, and dark/light mode support

## 1.4.12 (2026-04-09)

Thank you for your donations:

**One-time**

- [@mkorthaus-private](https://github.com/mkorthaus-private)

**Monthly**

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

### Features

- **PWA**: Add PWA support with service worker and install prompt
- **Calendar**: Add birthday calendar feature with settings and localization
- **Calendar**: Clamp February 29 birthdays in non-leap years
- **Identity**: Add automatic identity synchronization (#167)
- **Plugins**: Disable plugins by default and require admin approval
- **Plugins**: Replace auth header exposure with a secure HTTP proxy API for plugins
- **Auth**: Add configurable OAuth scopes and cookie security via environment variables
- **Email**: Sync mail view to browser history for back/forward navigation
- **Contacts**: Add ability to rename address books (#152)
- **UI**: Add version badge in settings
- **i18n**: Add Latvian (lv) locale support
- **i18n**: Add Polish language support
- **i18n**: Add Korean language support
- **i18n**: Add Simplified Chinese (zh_CN) locale support

### Fixes

- **Email**: Show recipient instead of sender in Sent and Drafts folder lists
- **Email**: Embed dropped images as data URLs and prevent duplicate attachments (#163)
- **Email**: Fix logic for marking email as read in EmailViewer
- **Email**: Fix archive action passing MouseEvent as argument
- **Mailbox**: Preserve search filters on push-triggered mailbox refresh (#164)
- **Mailbox**: Align shared account folders with primary folders (#151)
- **Mailbox**: Fetch mailboxes on mount in FolderSettings when store is empty
- **Mailbox**: Improve mailbox deletion error handling
- **Calendar**: Improve calendar event retrieval by batching requests to avoid server limits (#141)
- **Calendar**: Compute per-occurrence UTC start/end in recurrence expansion (#116)
- **Calendar**: Guard against undefined trigger in calendar event alert popover (#143)
- **Files**: Stream WebDAV PUT uploads to avoid buffering in memory (#162)
- **Files**: Prune recent files against server nodes on refresh (#146)
- **Files**: Fix file deletion logic to update recent files and handle errors (#146)
- **Files**: Extend file drop zone to fill remaining viewport height
- **Files**: Fallback to application/octet-stream for long MIME types
- **Security**: Replace unguarded crypto.randomUUID() with safe generateUUID() utility
- **Security**: Validate plugin HTTP post URL against origin with regression tests
- **Security**: Allow blob images in CSP for inline drag-and-drop (#163)
- **Auth**: Resolve settings sync identity mismatch for OAuth/SSO sessions (#127)
- **Contacts**: Fix address book ID namespacing for shared contacts in create and update operations (#133)
- **UI**: Fix focused mode expanding beyond screen bounds (#156)
- **API**: Handle 403 on principal fetch without console error
- **API**: Enhance error handling in Stalwart API responses

## 1.4.11 (2026-03-31)

### Features

- **Logging**: Add logging categories for better log management

### Fixes

- **Security**: Harden security with CSP enforcement, SSRF redirect validation, reenabled S/MIME chain verify, IP spoofing prevention, and PDF iframe sandbox
- **Security**: Harden proxy authentication and SSRF defenses
- **Security**: Block plugins with dangerous JS patterns and enforce strict session secret length validation
- **S/MIME**: Add self-signed certificate detection and update status messages for S/MIME signatures
- **Email**: Auto-focus input fields in email composer for improved user experience (#126)
- **Mailbox**: Prevent orphaning of nested mailboxes by restricting deduplication to root-level folders
- **JMAP**: Strip server-immutable fields from updates before sending to JMAP (#128)
- **Files**: Update file feature disabled messages and add stability warnings
- **i18n**: Add missing translation keys to all non-English locales

## 1.4.10 (2026-03-31)

### Features

- **Plugins**: Add plugin configuration UI with schema-driven admin config page, calendar event action slot, and Jitsi Meet plugin
- **Calendar**: Implement client-side recurrence expansion for calendar events
- **Calendar**: Add iCal subscription editing and batch event import
- **Calendar**: Add hover preview settings and functionality
- **Calendar**: Add virtual location input for calendar events (#121)
- **Email**: Add reply-to addresses support in email composer
- **Email**: Add mail layout settings and update email list components
- **Email**: Add auto-select reply identity feature with settings and localization
- **Email**: Enhance compose functionality with button integration and translations
- **Filters**: Preserve activation state when updating or creating Sieve scripts to avoid deactivating server-managed vacation scripts
- **Filters**: Skip server-managed vacation script in Sieve script handling
- **Settings**: Add support for custom JMAP server endpoints in login and settings
- **Settings**: Add folder expansion state management and settings navigation
- **UI**: Add options to hide account switcher and show account avatars on navigation rail
- **i18n**: Add JMAP server endpoint labels and hints in multiple languages
- **i18n**: Add missing translation keys to all non-English locales

### Fixes

- **Security**: Patch critical auth bypass and credential leak vulnerabilities
- **Security**: Support 3DES S/MIME decryption by importing legacy RSAES-PKCS1-v1_5 keys and add diagnostic logging (#35)
- **Security**: Account isolation, auto-import signer certs, and no-key error handling (#35)
- **Calendar**: Fix JSCalendar 2.0 recurrenceRule single-object compatibility (#116)
- **Calendar**: Enhance calendar event handling to distinguish between events and tasks
- **Calendar**: Link existing events to target calendar during iCal import instead of skipping (#113)
- **Calendar**: Deduplicate UIDs during iCal import to prevent mass failures (#113)
- **Calendar**: Fix events disappearing after iCal import/subscription refresh
- **Calendar**: Enhance calendar event handling with full-day detection and layout adjustments
- **Calendar**: Use UTC timestamps for timed event rendering
- **Calendar**: Work around Stalwart not returning Task objects via CalendarEvent/query
- **Email**: Enhance email loading and deduplication logic in email store (#119)
- **Email**: Ensure draft editing function is called correctly in EmailViewer component (#60)
- **Email**: Match hover action background to selected row state
- **Email**: Align tag counts with mailbox folder counts in sidebar
- **Auth**: Handle 2FA/TOTP session expiry with basic auth (#117)
- **Mailbox**: Improve mailbox tree logic and enhance mailbox handling with logging (#118)
- **UI**: Improve dark mode handling for media elements and background images
- **UI**: Adjust account list spacing and remove push connection indicator
- **UI**: Fix nested button in theme card

## 1.4.9 (2026-03-27)

### Features

- **Admin**: Add Stalwart admin authentication, sidebar access, and a reorganized dashboard with dedicated policy sections
- **Plugins**: Add plugin/theme admin dashboard, harness tooling, forced enable or disable controls, managed policy enforcement, and a resizable detail sidebar
- **Filters**: Add vacation responder management with Sieve generation and parsing, UI integration, and improved sync preservation
- **Email**: Add plain text only composer mode, optional conversation threading disable, configurable hover action placement, and OAuth app password support
- **UI**: Add drag-and-drop customization for sidebar apps
- **Files**: Use dynamic server-configured maximum upload sizes
- **i18n**: Add Russian locale support and complete missing translation strings for recent task features

### Fixes

- **Calendar**: Improve date parsing and event normalization, prevent calendar page re-render loops, ensure unique ICal subscription IDs, and create all-day events with correct JSCalendar midnight handling
- **Email**: Respect the configured mark-as-read delay in EmailViewer and fetch full email content when needed while editing drafts (#60, #95)
- **Auth**: Improve network error handling, add JMAP rate limiting handling, and enhance settings retrieval and persistence diagnostics (#100, #104)
- **UI**: Improve mobile layout behavior on contacts and calendar pages (#103)
- **Themes**: Repair theme ZIP bundle handling and enforce admin theme locks correctly
- **Code Quality**: Resolve outstanding ESLint warnings across the codebase

## 1.4.8 (2026-03-23)

### Features

- **Email**: Add support for marking emails as answered or forwarded and display status icons in email list and thread views
- **Email**: Enhance identity selection by supporting sub-addressing (plus addressing) in email composer
- **Settings**: Add notification settings with sound picker, preview playback, and configurable alert sounds
- **Settings**: Add default mail program settings with localization support across all locales
- **Auth**: Implement path prefix handling for OAuth callbacks and login redirects, enabling reverse proxy deployments
- **Validation**: Add all multi-part TLDs for domain validation in favicon API (#81)

### Fixes

- **Calendar**: Fix bugs in duration parsing, RFC compliance, and event handling across calendar components
- **Calendar**: Detect tasks created by external CalDAV clients such as Thunderbird
- **Settings**: Enhance account settings with username and authentication method display (#90)

## 1.4.7 (2026-03-21)

### Features

- **Calendar**: Add task management features with task creation, editing, and status tracking
- **Calendar**: Add option to show week numbers in mini-calendar
- **Email**: Add resizable image component and rich text editor with image upload support
- **Files**: Support uploading folders via drag-and-drop and toolbar button
- **Filters**: Add expanded visual view for filter rules
- **Auth**: Add non-interactive SSO login flow for embedded/iframe deployments (#69)
- **DevOps**: Add separate Docker build workflow for releases and dev branch images

### Fixes

- **Calendar**: Handle updates and deletions for synthetic JMAP IDs in calendar events with fallback to destroy and recreate
- **Security**: Extend CryptoEngine to support legacy algorithms and integrate with LinerEngine for decryption
- **Auth**: Refactor logout to use synchronous flow with full page redirect
- **Email**: Update iframe sandbox attributes to allow popups to escape sandbox
- **i18n**: Add missing translation keys across all locales
- **Docker**: Update .env.example to clarify Docker volume mounting for settings data directory

## 1.4.6 (2026-03-21)

### Features

- **Demo**: Add full demo mode with fixture data for emails, calendars, contacts, files, filters, identities, mailboxes, and vacation responses
- **Demo**: Implement JMAP client interface abstraction to support demo and live backends
- **Contacts**: Add no-category filter, drag-and-drop to category, and category combo box in contact form
- **Email**: Add hover actions for emails with configurable quick-action buttons
- **Settings**: Implement keyword migration functionality for upgrading legacy email tags
- **Security**: Enhance S/MIME certificate extraction and add legacy PBE (password-based encryption) support
- **Tour**: Add interactive guided tour overlay for new user onboarding

### Fixes

- **Settings**: Add missing `showTimeInMonthView` and `showOnMobile` type definitions to settings store
- **UI**: Adjust padding and size of sidebar buttons for improved layout

## 1.4.5 (2026-03-20)

### Features

- **Calendar**: Add prev/next navigation buttons and date label to desktop calendar toolbar
- **Calendar**: Add pending event preview functionality to calendar views and event modal
- **Calendar**: Add setting to show event start time in month view
- **Contacts**: Implement pagination for fetching contacts with maxObjectsInGet capability
- **Email**: Add attachment position setting in email settings
- **Layout**: Add mobile visibility toggle for sidebar apps
- **Error**: Add NotFound component to handle 404 errors and redirect unauthenticated users

### Fixes

- **Auth**: Enhance account switching logic and clear stores on account change
- **Auth**: Improve account restoration logic and handle stale accounts
- **Auth**: Improve draft handling in email composer and enhance session cookie verification
- **Calendar**: Expand recurring events in CalendarEvent/query so individual occurrences are returned (#65)
- **Calendar**: Validate event start field when fetching calendar events
- **Calendar**: Auto-scroll agenda view to today's events and include today's date in groups
- **Calendar**: Correct JSX syntax in CalendarToolbar component
- **Dependencies**: Update flatted to 3.4.2
- **DevOps**: Use native ARM runners instead of QEMU for Docker builds
- **DevOps**: Enhance health check with detailed memory diagnostics and stable liveness probe

## 1.4.4 (2026-03-19)

### Features

- **Calendar**: Implement CalDAV discovery API with automatic calendar home resolution for multi-account setups
- **Calendar**: Enhance calendar management settings with mailbox role reassignment controls
- **Email**: Add signature rendering utilities with HTML-to-text conversion and sanitization

### Fixes

- **Auth**: Fix account session handling to update existing accounts instead of duplicating entries
- **Auth**: Fix logout redirects and unauthenticated home page rendering
- **Calendar**: Fix duplicate calendar edits and prevent double-save submissions in event modal
- **Calendar**: Remove stale calendar ID references in favor of CalDAV-discovered IDs
- **Contacts**: Improve RFC 9553 compliance for contact birthdays and address formatting
- **Email**: Fix email signature rendering for identity signatures
- **Folders**: Improve mailbox role management by clearing roles from all mailboxes before reassigning

## 1.4.3 (2026-03-19)

### Features

- **Auth**: Implement multi-account support with up to 5 simultaneous accounts and instant switching
- **Auth**: Add account switcher component with connection status, default account selection, and per-account logout
- **Auth**: Support multi-account OAuth and basic auth with per-account session persistence
- **Contacts**: Enhance contacts sidebar with collapsible sections, bulk operations, and address book grouping
- **Contacts**: Add contact import functionality and keyword filtering
- **Settings**: Add per-account encrypted settings storage with server-side sync support

### Fixes

- **UI**: Adjust popover alignment in sub-address helper component
- **Settings**: Improve error logging in settings sync functionality

## 1.4.2 (2026-03-19)

### Features

- **Calendar**: Add task list view for calendar tasks with task details and management
- **Calendar**: Add shared calendar grouping with visual separation in sidebar
- **Calendar**: Support double-click to create events and improve modal date handling
- **Contacts**: Add address book directories with drag-and-drop and editor picker
- **Email**: Add email attachment support in sendEmail functionality
- **Email**: Implement draft editing functionality across email components
- **Email**: Implement unwrapping of embedded message/rfc822 attachments with enhanced HTML body validation
- **Email**: Add email export/import localization keys for multiple languages
- **Contacts**: Update gender handling to use speakToAs structure

### Fixes

- **Email**: Resolve default sender to canonical identity on local-part login
- **Email**: Refactor overflow handling in EmailViewer to use hidden priorities and layout effects
- **Email**: Remove debugMode usage from EmailViewer component
- **Calendar**: Enhance IMIP invitation and cancellation handling for calendar events
- **Calendar**: Add time-based sorting for events in buildWeekSegments function
- **Dependencies**: Update dompurify to 3.3.3 and elliptic to 6.6.1, add undici override

## 1.4.1 (2026-03-18)

### Features

- **Security**: Add S/MIME certificate management with identity bindings, signer auto-import, unlock controls, and compose/viewer sign, encrypt, decrypt, and verification flows
- **Email**: Add TNEF (`winmail.dat`) parsing to extract message bodies and attachments from Outlook rich-text emails
- **Email**: Add archive organization modes for archiving directly or into year/month subfolders
- **Email**: Add an "Always Show Emails in Light Mode" preference to avoid dark-mode conversion issues
- **Email**: Apply the 12-hour or 24-hour time format preference consistently across calendar and email surfaces
- **Identity**: Add identity refresh behavior in the identity manager so server-side changes stay in sync after edits
- **UI**: Add configurable sidebar apps with custom icons plus inline or new-tab launch modes
- **Branding**: Add runtime branding options for custom favicon, sidebar logos, and login logos
- **Deployment**: Add configurable server listen address support via `HOSTNAME`, including IPv6 and dual-stack guidance

### Fixes

- **Calendar**: Improve all-day event handling
- **Calendar**: Validate and default persisted calendar view mode values
- **UI**: Use configured app names more consistently in metadata and login branding surfaces
- **Docker**: Correct `HOSTNAME` formatting in the Docker Compose example
- **Metadata**: Correct package author and container vendor metadata

## 1.3.0 (2026-03-16)

### Features

- **Calendar**: RSVP support for calendar invitations with trust assessment
- **Calendar**: iCal/webcal subscription support
- **Calendar**: Create, update, and delete calendar events
- **Calendar**: Enhanced EventModal with alert and recurrence labels, view/edit mode toggle
- **Email**: Iframe-based email rendering with smart dark mode support
- **Email**: Security tooltips, contact actions, and scroll improvements in email viewer
- **Email**: Improved message details and contact sidebar in email viewer
- **Email**: Move-to mailbox functionality in email viewer
- **Email**: Mobile bottom action bar with reply and email navigation
- **Email**: Auto-fetch full email content when an email is auto-selected
- **Email**: Unread filter functionality in mailbox sidebar
- **Email**: Empty folder functionality for junk and trash mailboxes with confirmation dialog
- **Files**: JMAP FileNode file storage backend and file settings
- **Files**: File preview support
- **Contacts**: Enhanced contacts management with sidebar and selection features
- **Contacts**: Import/export functionality in contacts settings
- **Contacts**: Improved contact group management with UID normalization
- **Settings**: Tab icons and grouping with improved file settings preview
- **Settings**: Extra-compact density option and font size scaling
- **Settings**: Logout button in settings
- **UI**: Sidebar resizing across calendar, contacts, and settings pages
- **UI**: Keyboard shortcuts button and show/hide toolbar labels option
- **UI**: Recursive depth calculation for mailbox tree structure
- **UI**: Mobile long-press context menu
- **i18n**: Expanded supported locales
- **API**: Enhanced configuration fetching with retry logic
- **License**: Updated to AGPL-3.0-only with NOTICE file for fork lineage

### Fixes

- **Calendar**: Correct all-day multi-day event rendering
- **Email**: Adjust text wrapping for email subject in EmailViewer and ThreadConversationView
- **Email**: Adjust email content area layout for better responsiveness
- **Email**: Sync identity stores and append signatures to outgoing emails (#15)
- **Contacts**: Handle non-string anniversary dates in contact detail
- **UI**: Fix nested button hydration error in sidebar mailbox tree
- **UI**: Update sidebar border styling for consistency across pages
- **UI**: Update avatar background color logic based on image source
- **UI**: Make density setting functional across entire UI

## 1.2.4 (2026-03-14)

### Features

- **Tags**: Show total and unread email counts next to each tag in the sidebar
- **Tags**: Instant tag count refresh after adding or removing a tag
- **Search**: Wildcard query functionality for enhanced search capabilities
- **Search**: Support OR conditions across multiple fields in email search
- **Search**: Improved search results display with pluralization and localization
- **Email**: Dropdown menus for actions in email viewer
- **Email**: Improved email list messages for clarity and localization
- **Email**: Enhanced unsubscribe banner with destructive color styling
- **Auth**: Centralized Stalwart credentials management
- **Login**: Configurable logo with light/dark mode support
- **Avatar**: Dev mode configuration for profile picture retrieval
- **DevOps**: Added `.env.dev.example` for development configuration

### Fixes

- **Email**: Prevent browser auth dialog when viewing emails with inline images
- **Login**: Optimize theme store usage with shallow comparison
- **Git**: Add local private data directory to `.gitignore`

## 1.2.3 (2026-03-13)

### Features

- **Calendar**: Hover functionality for calendar events with preview popover
- **Contacts**: Enhanced contact management and vCard support
- **Email**: Tagging system with color labels and drag-and-drop tag support
- **Email**: Multi-select with checkbox functionality and batch operations
- **Email**: Recipient popover for contact interaction
- **Email**: Inline search filters and folder icon picker
- **Email**: Sender favicon avatars with negative caching for performance
- **Email**: Print functionality for email content
- **Folders**: Folder management settings with CRUD, standard role assignment, and icon picker
- **Folders**: Subfolder creation and hierarchical navigation
- **Settings**: Settings synchronization with server (encrypted API endpoints)
- **Settings**: Toolbar position customization and mobile layout tabs
- **Settings**: Login page customization options
- **Account Security**: Stalwart account security management panel
- **OAuth2/OIDC**: OAuth-only login mode
- **UI**: Resizable columns, navigation rail overhaul, and drag-and-drop email organization
- **UI**: Toast notifications with enter/exit animations and progress bar
- **UI**: Responsive mobile layout with bottom tab bar and tablet support
- **i18n**: Added Dutch and Portuguese translations (now 8 languages)
- **Docker**: Publish only to GHCR, remove Docker Hub
- **DevOps**: Interactive setup script with dry-run option and JMAP server URL validation
- **Branding**: New Bulwark Webmail identity with logo assets and light/dark mode support

### Fixes

- **Sieve**: Use `onSuccessActivateScript` for sieve activation (#21)
- **Composer**: Fix trailing comma handling in recipient input
- **Email**: Fix print functionality for email content
- **Connection**: Connection loss handling with session recovery
- **Redirect**: Login redirect functionality with sessionStorage error handling

## 1.1.2 (2026-03-02)

### Fixes

- **Context menu**: Fix "Move to folder" submenu closing when scrolling the folder list or moving the mouse to the submenu (#19)
- **Move to folder**: Fix emails not actually moving on the server - JMAP response errors were silently ignored and shared account IDs were not resolved correctly
- **Dependencies**: Update tailwindcss, lucide-react, @tanstack/react-virtual, @typescript-eslint/\*, globals, @types/node

## 1.1.1 (2026-02-28)

### Fixes

- **Email viewer**: Show/hide details toggle now stays in place when expanded instead of jumping to the bottom of the details section (#18)
- **Email viewer**: Details toggle text is now properly translated (was hardcoded in English)
- **Instrumentation**: Resolve Edge Runtime warnings by splitting Node.js-only code into a separate module
- **Security**: Patch minimatch ReDoS vulnerability (CVE-2026-27903) - upgrade 9.0.6→9.0.9 and 3.1.3→3.1.5

## 1.1.0 (2026-02-28)

- Server-side version update check on startup (logs when a newer release is available)

## 1.0.2 (2026-02-27)

- Fix 4 CVEs in production Docker image (removed npm, upgraded Alpine packages)

## 1.0.1 (2026-02-26)

- Remove stale references, clean up README

## 1.0.0 (2026-02-25)

- Initial public release
