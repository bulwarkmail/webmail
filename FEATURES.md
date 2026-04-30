# Features

## Mail

- Read, compose, reply, reply-all, and forward with a Tiptap rich text editor (inline images, drag-and-drop embedding)
- Gmail-style threading with inline expansion and an optional conversation toggle
- Unified mailbox view across all connected accounts
- Draft auto-save with identity preservation
- Attachment upload, download, and inline preview; forgotten-attachment warning
- Full-text search with JMAP filter panel, search chips, wildcards, OR conditions, and cross-mailbox queries
- Batch operations – multi-select, archive, delete, move, tag
- Archive modes – direct, by year, or by month
- Multi-tag support with color labels, reordering, and drag-and-drop assignment
- Star/unstar with configurable mark-as-read delay
- Virtual scrolling for large mailboxes
- Quick reply, hover actions, sender avatars (favicon-based), and recipient popovers
- Plain-text composer mode and Reply-To support
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
- Shared calendars with CalDAV discovery and multi-account home resolution
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
- Visual rule builder with expanded view; conditions (From, To, Subject, Size, Body…) and actions (Move, Forward, Star, Discard…)
- Preserves rules authored in other clients
- Raw Sieve editor with syntax validation
- Vacation responder with date range scheduling
- Reusable email templates with placeholder auto-fill (`{{recipientName}}`, `{{date}}`, …)

## Files

- JMAP FileNode browser (Stalwart native cloud storage)
- Streamed WebDAV PUT upload and folder upload with progress tracking
- Dynamic upload limits based on server configuration
- Grid and list views with sorting by name, size, or date
- Previews for images, text, audio, and video
- Clipboard operations (cut, copy, paste, duplicate), favorites, and recent files

## Security & Privacy

- External content blocked by default, with a trusted senders list
- HTML sanitization via DOMPurify
- S/MIME – manage certificates, sign, encrypt, decrypt, and verify; legacy 3DES / PBE support; per-account key isolation
- SPF / DKIM / DMARC status indicators
- OAuth2 / OIDC with PKCE (Keycloak, Authentik, or built-in), OAuth-only mode, OAuth app passwords, and non-interactive SSO for embedded deployments
- TOTP two-factor authentication
- Account security panel for password and 2FA management via the Stalwart admin API
- Optional "Remember me" via AES-256-GCM encrypted httpOnly cookie
- Enforced CSP with per-request nonce, SSRF redirect validation, PDF iframe sandbox, and IP spoofing prevention
- Plugin hardening with dangerous-pattern detection and admin approval
- Newsletter unsubscribe (RFC 2369)

## Interface

- Three-pane layout with resizable columns
- Dark and light themes with intelligent email color transformation
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

15 languages: English · Français · 日本語 · Español · Italiano · Deutsch · Nederlands · Português · Русский · Türkçe · 한국어 · Polski · Latviešu · 简体中文 · Українська

Automatic browser detection with persistent preference. Configurable locale URL prefix via `NEXT_PUBLIC_LOCALE_PREFIX`.

## Identity & Multi-Account

- Up to 5 simultaneous accounts with instant switching and per-account session persistence
- Account switcher with connection status and default account selection
- Multiple sender identities with per-identity signatures, automatic sync, and badges in viewer/list
- Sub-addressing (`user+tag@domain.com`) with contextual tag suggestions
- Shared folders across accounts
- Optional custom JMAP endpoints on the login form (`ALLOW_CUSTOM_JMAP_ENDPOINT`)

## Admin & Extensibility

- Stalwart admin dashboard with dedicated policy sections
- Plugin system – schema-driven config UI, render and intercept hooks, `onAvatarResolve` and i18n APIs, calendar event slots, and managed policy enforcement
- Themes – upload, enforce, and manage admin-controlled themes as ZIP bundles
- Extension marketplace – browse and install plugins and themes from a configurable directory (`EXTENSION_DIRECTORY_URL`)
- Bundled plugins including Jitsi Meet calendar integration

## Operations

- Progressive Web App with service worker, install prompt, and dynamic manifest
- Automatic update check with server-side logging of new releases
- Structured logging (`text` or `json`) with category-based levels
- Release (`main`) and development (`dev`) Docker images on GHCR
- Demo mode with fixture data – no mail server required
