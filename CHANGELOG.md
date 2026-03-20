# Changelog

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
- **Move to folder**: Fix emails not actually moving on the server — JMAP response errors were silently ignored and shared account IDs were not resolved correctly
- **Dependencies**: Update tailwindcss, lucide-react, @tanstack/react-virtual, @typescript-eslint/\*, globals, @types/node

## 1.1.1 (2026-02-28)

### Fixes

- **Email viewer**: Show/hide details toggle now stays in place when expanded instead of jumping to the bottom of the details section (#18)
- **Email viewer**: Details toggle text is now properly translated (was hardcoded in English)
- **Instrumentation**: Resolve Edge Runtime warnings by splitting Node.js-only code into a separate module
- **Security**: Patch minimatch ReDoS vulnerability (CVE-2026-27903) — upgrade 9.0.6→9.0.9 and 3.1.3→3.1.5

## 1.1.0 (2026-02-28)

- Server-side version update check on startup (logs when a newer release is available)

## 1.0.2 (2026-02-27)

- Fix 4 CVEs in production Docker image (removed npm, upgraded Alpine packages)

## 1.0.1 (2026-02-26)

- Remove stale references, clean up README

## 1.0.0 (2026-02-25)

- Initial public release
