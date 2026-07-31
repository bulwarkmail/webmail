# Features

## Mail

- Read, compose, reply, reply-all, and forward in a Tiptap rich-text editor that handles inline images, drag-and-drop embedding, and tables
- Gmail-style threading, expanded inline, with a conversation toggle you can switch off
- The Unified Mailbox combines Inbox, Sent, Drafts, Junk, Archive, and Trash. By default it stays inside the active account and its shared/group folders; an admin can unlock a cross-account mode that spans every connected account.
- All mail, Unread, and Starred obey that same account boundary and can be narrowed to a per-account folder selection. Every row names the folder its message came from.
- Search runs across all unified views; the per-role mailboxes add the full filter panel on top
- Three mail layouts: split three-pane, focused list, or reading pane at the bottom
- Drafts auto-save, keeping the chosen identity, the HTML body, and correct `In-Reply-To` / `References` headers on replies
- Attachments upload, download, drag out to the file system, and preview inline. Images and PDFs render on desktop and mobile, composer attachments open on click, and `.eml` (`message/rfc822`) parts display as a nested email. There are list thumbnails, and a warning when you mention an attachment and forget it.
- Scheduled send, plus a configurable delay before anything leaves the outbox
- Read receipts (MDN, RFC 8098)
- Quoted text lands in an editable island that keeps the original layout
- Full-text search with a JMAP filter panel, search chips, wildcards, OR conditions, and cross-mailbox queries
- Multi-select for batch archive, delete, move, and tag
- Archive directly, by year, or by month
- Tags carry color labels, reorder by drag, and can be assigned by dropping a message onto them
- Tags optionally nest: pick a parent when you create one and the sidebar turns them into a tree
- Each tag can be configured to show always, only when there are unread mails or always be hidden
- Star or unstar, with a configurable mark-as-read delay
- Large mailboxes scroll virtually, and the first page of mail prefetches at login
- Quick reply, hover actions, favicon-based sender avatars, recipient popovers
- Plain-text composer mode and Reply-To
- The signature sits above or below the quoted text, per identity
- Override the From header in the composer. Reply to an alias on a domain you own and it auto-fills as the sender, even when no identity exists for it.
- Import `.eml` files from the folder right-click menu
- TNEF (`winmail.dat`) extraction and `message/rfc822` unwrapping
- Folders take an icon, nest, and show counts in the sidebar
- Print from the viewer
- Browser back and forward move through mail history

## Calendar

- Month, week, day, and agenda views, with a mini-calendar and task list in the sidebar
- Drag an event to reschedule it, click-drag to create one, pull an edge to resize. Everything snaps to 15 minutes.
- Recurring events edit and delete by scope: this occurrence, this and following, or all
- iMIP invitations on create and update (RFC 5545 / 6047), an organizer/attendee panel, and RSVP with trust assessment
- `.ics` attachments are detected in the email viewer, so you can RSVP or import without leaving the message
- iCalendar import previews first, then bulk-creates, deduplicating on UID
- iCal / webcal subscriptions, editable, with batch import
- A birthday calendar generated from your contacts
- Virtual locations (video-conference URLs) are first-class event fields
- Tasks with due dates, priority, and completion status
- Shared calendars through CalDAV discovery, resolving homes across accounts, colored per viewer
- Week numbers, hover preview, notifications with a sound picker
- JMAP push keeps everything in sync

## Contacts

- JMAP sync (RFC 9553 / 9610), falling back to local storage
- Several address books, with drag-and-drop between them
- Groups with member management
- vCard import/export (RFC 6350) that flags duplicates
- Trusted senders live in their own JMAP address book
- Autocomplete on To, Cc, and Bcc

## Filters & templates

- Server-side filters as JMAP Sieve Scripts (RFC 9661)
- A visual rule builder: conditions on From, To, Subject, Size, Body, Attachment and more, each matching multiple values, with actions to move, forward, star, or discard
- Rules written in other clients survive the round-trip
- Raw Sieve editor with syntax validation
- A vacation responder you can schedule to a date range
- Templates with placeholder auto-fill (`{{recipientName}}`, `{{date}}`, …)

## Files

- Browse Stalwart's native JMAP FileNode storage as a real folder tree. Legacy flat-named files migrate into nested `FileNode` folders on first load.
- Streamed WebDAV PUT upload, whole folders included, with progress
- Upload limits follow the server's own configuration
- Grid or list, sorted by name, size, or date
- Preview images, text, audio, and video
- Cut, copy, paste, duplicate; favorites; recent files
- JMAP sharing (RFC 9670) for files and folders. Pick a user or group from the principal picker and grant read, read/write, or manager. Shared items get an indicator, and anything other principals share with you appears under "Shared with me".

## Security & privacy

- External content stays blocked until you say otherwise, and trusted senders are remembered
- HTML sanitized through DOMPurify
- S/MIME: manage certificates, then sign, encrypt, decrypt, and verify. Legacy 3DES / PBE is supported, and keys stay isolated per account.
- SPF / DKIM / DMARC indicators surface the most severe SPF result and drop the "via" badge on spoofed mail
- OAuth2 / OIDC with PKCE against Keycloak, Authentik, or the built-in provider, plus OAuth-only mode, OAuth app passwords, and non-interactive SSO for embedded deployments
- TOTP two-factor authentication
- Password and 2FA management through the Stalwart admin API
- "Remember me" is optional and rides an AES-256-GCM encrypted httpOnly cookie
- CSP is enforced with a per-request nonce, alongside SSRF redirect validation, a sandboxed PDF iframe, and IP spoofing prevention
- Plugins are scanned for dangerous patterns and need admin approval
- Newsletter unsubscribe (RFC 2369)

## Interface

- Split three-pane, focused list, or bottom reading pane, columns resizable
- Dark and light themes. Email colors are remapped by luminance, so a mail hard-coded to dark-on-white stays readable on a dark background.
- Bundled themes such as Aurora Glass and Elastic. Each theme card renders as a miniature mailbox built from that theme's own colors, with chips for the light and dark variants.
- Layouts for desktop, tablet, and mobile
- Full keyboard navigation
- Drag and drop to organize mail and assign tags
- A guided tour for first-time users
- Right-click menus, and toasts that offer an undo
- Toolbar position, favicon, and login branding are configurable
- Sidebar apps pin and reorder by drag
- Settings sync between devices, encrypted
- Storage quota display
- WCAG AA contrast, reduced-motion support, focus traps, and screen-reader live regions

## Internationalization

24 languages: Català · Česky · Dansk · Deutsch · English · Español · Français · Italiano · Latviešu · Magyar · Nederlands · Polski · Português · Română · Slovenčina · Türkçe · Русский · Українська · עברית · العربية · فارسی · 한국어 · 日本語 · 简体中文

- Arabic, Hebrew, and Persian render right-to-left; document direction and logical layout flip automatically
- The browser's `Accept-Language` picks the first language, and the choice persists per user
- `NEXT_PUBLIC_DEFAULT_LOCALE` sets the fallback, `NEXT_PUBLIC_LOCALE_PREFIX` the URL prefix

## Identity & multi-account

- Run several accounts at once and switch instantly, each keeping its own session. The 5-account cap lifts on HTTP/2 servers; on HTTP/1.1, browser connection pooling still sets the limit.
- An account switcher showing connection status, and a default account
- Multiple sender identities, each with its own signature, synced automatically and badged in the viewer and list
- Signature above or below the quoted text
- Sub-addressing (`user+tag@domain.com`), delimiter configurable, with tag suggestions drawn from context
- Shared folders across accounts
- Shared and group (delegated) accounts put their folders next to your own, and "Include group inboxes" merges them into the Unified Mailbox. You can open, mark read, flag as spam or not-spam, move, delete, and archive their messages from there, and folder unread counts stay in step.
- Several JMAP servers per deployment, optionally auto-picked by email domain
- Custom JMAP endpoints on the login form, when `ALLOW_CUSTOM_JMAP_ENDPOINT` permits it

## Admin & extensibility

- A setup wizard runs on first launch and walks through JMAP servers, OAuth/OIDC, the session secret, logging, branding (uploads included), and the admin password. It writes to the admin config dir, so `.env.local` stays untouched.
- The Stalwart admin dashboard, its policy sections collapsed into one tabbed page
- Admin policy gates for the Unified Mailbox: turn All mail / Unread / Starred on or off org-wide, and gate cross-account capability separately (off by default, auto-enabled on upgrade for instances already using it). A gated view still respects the user's own toggle.
- Admin storage splits in two. `ADMIN_CONFIG_DIR` is operator-authored and can be mounted read-only once setup finishes; `ADMIN_STATE_DIR` holds the runtime audit log and login timestamps.
- JSON config can read secrets from files (`passwordHashFile`, `sessionSecretFile`, `oauthClientSecretFile`) for Docker and Kubernetes secret mounts
- An admin toggle controls search-engine indexing (`robots.txt` / `noindex`)
- Plugin system: a schema-driven config UI, render and intercept hooks, `onAvatarResolve`, `onBeforeEmailSend`, composer-sidebar and email-banner slots, calendar event slots, i18n APIs (sandboxed plugins localize through manifest locales and `api.i18n.t`), an `/api/translate` proxy, email-body access, and managed policy enforcement
- Plugins hot-reload, load from a dev folder, bundle `src/` on demand through esbuild, and can request `http:fetch` scoped by `httpOrigins`
- Themes upload as ZIP bundles, and admins can enforce one
- An extension marketplace browses and installs plugins and themes from a configurable directory (`EXTENSION_DIRECTORY_URL`). Installing and uninstalling stay in the admin dashboard.
- Bundled plugins, including Jitsi Meet for the calendar

## Operations

- Progressive Web App: service worker, install prompt, web push for new inbox mail, a dynamic manifest, and install screenshots configurable per domain
- Update checks run on their own, log new releases server-side, and raise a notice that can't be dismissed
- Structured logging (`text` or `json`) with per-category levels
- Anonymous instance telemetry, off unless you enable it through the admin UI, the installer, or `BULWARK_TELEMETRY=on`. It reports version, platform, bucketed account counts, and feature toggles.
- Docker images on GHCR, for release (`main`) and development (`dev`)
- `NEXT_PUBLIC_BASE_PATH` mounts the app at a subpath behind a reverse proxy
- Demo mode runs on fixture data, no mail server required
