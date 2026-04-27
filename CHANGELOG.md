# Changelog

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
