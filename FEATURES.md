# Features

## Mail

- Read, compose, reply, reply-all, and forward with a Tiptap rich text editor (inline images, drag-and-drop embedding, tables)
- Gmail-style threading with inline expansion and an optional conversation toggle
- Unified mailbox view across all connected accounts – combined Inbox, Sent, Drafts, Junk, Archive, and Trash, with group/shared accounts optionally merged in
- Cross-account "All accounts" views – All unread, All starred, and All mail spanning every account (including shared/group folders); each aggregate list labels the source folder of every message
- "All Mail" view that merges an account's folders (with a configurable folder selection) into a single list
- Three selectable mail layouts: split (three-pane), focused list, and reading pane at bottom
- Draft auto-save with identity preservation, persisted HTML body, and proper `In-Reply-To` / `References` headers on replies
- Attachment upload, download, drag-out to local file system, and inline preview – images, inline PDF on desktop and mobile, composer attachments (click to open), and `.eml` (`message/rfc822`) attachments rendered like an email; image thumbnails and forgotten-attachment warning
- Scheduled send and configurable send delay
- Read receipts (MDN, RFC 8098)
- Editable, layout-preserving quote island when replying
- Full-text search with JMAP filter panel, search chips, wildcards, OR conditions, and cross-mailbox queries
- Batch operations – multi-select, archive, delete, move, tag
- Archive modes – direct, by year, or by month
- Multi-tag support with color labels, reordering, and drag-and-drop assignment
- Star/unstar with configurable mark-as-read delay
- Virtual scrolling for large mailboxes plus prefetching of initial email data on login
- Quick reply, hover actions, sender avatars (favicon-based), and recipient popovers
- Plain-text composer mode and Reply-To support
- Configurable signature position (above or below quoted text) per identity
- From-header override in the composer with optional catch-all auto-reply: replies to an alias on a domain you own auto-fill the alias as the sender even when it isn't a configured identity
- `.eml` file import via folder right-click menu
- TNEF (`winmail.dat`) extraction and `message/rfc822` unwrapping
- Folder management with icon picker, subfolders, and sidebar counts
- Print directly from the viewer
- Browser history sync for back/forward navigation

## Calendar

- Month, week, day, and agenda views with a mini-calendar sidebar and task list
- Drag-to-reschedule, click-drag creation, and edge-resize with 15-minute snap
- Recurring events with scoped edit/delete (this / this and following / all)
- iMIP invitations on create and update (RFC 5545 / 6047), organizer/attendee UI, and RSVP with trust assessment
- Inline calendar invitations in the email viewer – auto-detect `.ics`, RSVP, import
- iCalendar import with preview, bulk create, and UID deduplication
- iCal / webcal subscriptions with editing and batch import
- Auto-generated birthday calendar from contacts
- Virtual locations (video conference URLs) as first-class event fields
- Task management with due dates, priority, and completion status
- Shared calendars with CalDAV discovery, multi-account home resolution, and per-viewer colors
- Week numbers, event hover preview, notifications with sound picker
- Real-time sync via JMAP push

## Contacts

- JMAP sync (RFC 9553 / 9610) with local fallback
- Multiple address books with drag-and-drop between books
- Contact groups with member management
- vCard import/export (RFC 6350) with duplicate detection
- Trusted senders stored in a dedicated JMAP address book
- Autocomplete in the composer (To / Cc / Bcc)

## Filters & Templates

- Server-side filters via JMAP Sieve Scripts (RFC 9661)
- Visual rule builder with expanded view; conditions (From, To, Subject, Size, Body, Attachment…) with multi-value matching and actions (Move, Forward, Star, Discard…)
- Preserves rules authored in other clients
- Raw Sieve editor with syntax validation
- Vacation responder with date range scheduling
- Reusable email templates with placeholder auto-fill (`{{recipientName}}`, `{{date}}`, …)

## Files

- JMAP FileNode browser (Stalwart native cloud storage) with a real folder hierarchy; legacy flat-named files are migrated into nested `FileNode` folders automatically on load
- Streamed WebDAV PUT upload and folder upload with progress tracking
- Dynamic upload limits based on server configuration
- Grid and list views with sorting by name, size, or date
- Previews for images, text, audio, and video
- Clipboard operations (cut, copy, paste, duplicate), favorites, and recent files
- JMAP sharing (RFC 9670) for files and folders – share with users or groups at read, read/write, or manager levels via a principal picker, with share indicators and a "Shared with me" sidebar section for folders other principals have shared with you

## Security & Privacy

- External content blocked by default, with a trusted senders list
- HTML sanitization via DOMPurify
- S/MIME – manage certificates, sign, encrypt, decrypt, and verify; legacy 3DES / PBE support; per-account key isolation
- SPF / DKIM / DMARC status indicators – surfaces the most severe SPF result and hides the "via" badge on spoofed mail
- OAuth2 / OIDC with PKCE (Keycloak, Authentik, or built-in), OAuth-only mode, OAuth app passwords, and non-interactive SSO for embedded deployments
- TOTP two-factor authentication
- Account security panel for password and 2FA management via the Stalwart admin API
- Optional "Remember me" via AES-256-GCM encrypted httpOnly cookie
- Enforced CSP with per-request nonce, SSRF redirect validation, PDF iframe sandbox, and IP spoofing prevention
- Plugin hardening with dangerous-pattern detection and admin approval
- Newsletter unsubscribe (RFC 2369)

## Interface

- Selectable mail layouts (split three-pane, focused list, reading pane at bottom) with resizable columns
- Dark and light themes with intelligent email color transformation
- Bundled color themes including Aurora Glass and Elastic; theme cards render as a mini mailbox mockup built from the theme's own colors, with light/dark variant chips
- Responsive desktop, tablet, and mobile layouts
- Full keyboard navigation
- Drag-and-drop email organization and tag assignment
- Interactive guided tour for new users
- Right-click context menus, toast notifications with undo
- Customizable toolbar position, favicon, and login branding
- Pinnable sidebar apps with drag-and-drop reordering
- Encrypted settings sync across devices
- Storage quota display
- WCAG AA contrast, reduced-motion support, focus trap, and screen reader live regions

## Internationalization

19 languages: Česky · Dansk · Deutsch · English · Español · Français · Italiano · Latviešu · Magyar · Nederlands · Polski · Português · Română · Türkçe · Русский · Українська · 한국어 · 日本語 · 简体中文

Automatic browser detection with persistent preference. Configurable locale URL prefix via `NEXT_PUBLIC_LOCALE_PREFIX`.

## Identity & Multi-Account

- Multiple simultaneous accounts with instant switching and per-account session persistence; the 5-account cap is lifted on HTTP/2 servers (limited by browser connection pooling on HTTP/1.1)
- Account switcher with connection status and default account selection
- Multiple sender identities with per-identity signatures, automatic sync, and badges in viewer/list
- Configurable signature position (above or below quoted text)
- Sub-addressing (`user+tag@domain.com`) with configurable delimiter and contextual tag suggestions
- Shared folders across accounts
- Shared / group (delegated) accounts: their folders appear alongside your own and can be merged into the unified and "All accounts" views ("Include group inboxes"); their messages are fully actionable there – open, mark read, spam / not-spam, move, delete, and archive – with folder unread counts kept in sync
- Multiple JMAP servers per deployment with optional auto-pick by email domain
- Optional custom JMAP endpoints on the login form (`ALLOW_CUSTOM_JMAP_ENDPOINT`)

## Admin & Extensibility

- Web setup wizard for first launch – guides through JMAP server(s), OAuth/OIDC, session secret, logging, branding (with file upload), and admin password; persists to the admin config dir, no `.env.local` editing required
- Stalwart admin dashboard with dedicated policy sections, collapsed into a single tabbed page
- Admin policy gates for the aggregate mail views – enable or disable the "All Mail" and the cross-account "All unread / starred / all" entries org-wide; each gated view still respects the user's own toggle
- Split admin storage: `ADMIN_CONFIG_DIR` (operator-authored, mountable read-only after setup) and `ADMIN_STATE_DIR` (runtime audit log and login timestamps)
- File-based secrets for JSON config: `passwordHashFile` (admin password), `sessionSecretFile`, and `oauthClientSecretFile` for Docker/Kubernetes secret mounts
- Admin toggle for search-engine indexing (`robots.txt` / `noindex`)
- Plugin system – schema-driven config UI, render and intercept hooks, `onAvatarResolve`, `onBeforeEmailSend`, composer-sidebar and email-banner slots, calendar event slots, i18n APIs (localizable sandboxed plugins via manifest locales and `api.i18n.t`), an `/api/translate` proxy, email-body access, and managed policy enforcement
- Plugin hot-reload and dev-folder loading, on-demand `src/` bundling via esbuild, and `http:fetch` permission with `httpOrigins`
- Themes – upload, enforce, and manage admin-controlled themes as ZIP bundles
- Extension marketplace – browse and install plugins and themes from a configurable directory (`EXTENSION_DIRECTORY_URL`); install/uninstall restricted to the admin dashboard
- Bundled plugins including Jitsi Meet calendar integration

## Operations

- Progressive Web App with service worker, install prompt, web push notifications for inbox mail, dynamic manifest, and configurable (per-domain) install screenshots
- Automatic update check with server-side logging of new releases and a non-dismissible update notice
- Structured logging (`text` or `json`) with category-based levels
- Anonymous instance telemetry (opt-in via admin UI, the installer, or `BULWARK_TELEMETRY=on`; off by default) – version, platform, bucketed account counts, feature toggles only
- Release (`main`) and development (`dev`) Docker images on GHCR
- Subpath deployment via `NEXT_PUBLIC_BASE_PATH` for mounting behind a reverse proxy
- Demo mode with fixture data – no mail server required
