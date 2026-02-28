# JMAP Webmail - Roadmap

This document tracks the development status and planned features for JMAP Webmail.

## Completed Features

### Core Infrastructure
- [x] Next.js 16 with TypeScript and App Router
- [x] Tailwind CSS v4 with Oxide engine
- [x] Zustand state management
- [x] Custom JMAP client implementation (RFC 8620)

### Authentication
- [x] Login with JMAP server authentication
- [x] Session management (no password storage for security)
- [x] Username autocomplete with history
- [x] Logout functionality
- [x] Authentication error handling
- [x] JMAP identities for sender address
- [x] TOTP two-factor authentication (Stalwart-compatible)
- [x] OAuth2/OIDC with PKCE (opt-in SSO, session persistence, RP-initiated logout)
- [x] External IdP support via explicit issuer URL (Keycloak, Authentik, etc.)
- [x] "Remember me" session persistence for Basic Auth (AES-256-GCM encrypted httpOnly cookie)

### JMAP Server Connection
- [x] Session establishment and keep-alive
- [x] Connection error handling and retries
- [x] CORS error detection with actionable user guidance
- [x] Session URL origin rewriting (fixes Docker/reverse proxy deployments where server returns internal hostname)
- [x] Storage quota display
- [x] Server capability detection
- [x] Shared folders support (multi-account access)

### Email Operations
- [x] Email fetching and display
- [x] Full HTML email rendering
- [x] Compose, reply, reply-all, forward
- [x] Draft auto-save with discard confirmation
- [x] Mark as read/unread
- [x] Star/unstar emails
- [x] Delete and archive
- [x] Color tags/labels
- [x] Full-text search
- [x] Advanced search with JMAP filter panel, search chips, and cross-mailbox queries
- [x] Attachment upload and download
- [x] Batch operations (multi-select)
- [x] Quick reply form
- [x] Email threading (Gmail-style inline expansion)

### Real-time Updates
- [x] EventSource for JMAP push notifications
- [x] State synchronization
- [x] Email arrival notifications
- [x] Real-time unread counts
- [x] Mailbox change handling

### User Interface
- [x] Three-pane layout (sidebar, list, viewer)
- [x] Minimalist design system
- [x] Dark and light theme support
- [x] Custom scrollbars
- [x] Mobile responsive design
- [x] Keyboard shortcuts
- [x] Drag-and-drop email organization
- [x] Right-click context menus
- [x] Hierarchical mailbox display
- [x] Email list with avatars and visual hierarchy
- [x] Expandable email headers
- [x] External content warning banner
- [x] SPF/DKIM/DMARC status indicators
- [x] Loading states and skeletons
- [x] Smooth transitions and animations
- [x] Infinite scroll pagination
- [x] Virtual scrolling for large email lists
- [x] Error boundaries
- [x] Settings page with preferences
- [x] Navigation rail (desktop vertical icon sidebar + mobile bottom tab bar)
- [x] Welcome banner for first-time users (one-time display, localStorage persistence)
- [x] Confirmation dialog component with promise-based useConfirmDialog hook
- [x] Toast notifications with undo action support and typed durations
- [x] Inline form validation with shake animation (email composer, contact form)
- [x] Login UX polish (error shake, discreet 2FA toggle, password visibility toggle, session expired banner)
- [x] Empty state patterns for contacts (distinct "no data" vs "no search results" with contextual actions)
- [x] WCAG AA reduced-motion media query (global animation/transition reset)
- [x] Safe area inset utilities for notched devices
- [x] Screen reader live region announcements (sr-only)

### Internationalization
- [x] English language support
- [x] French language support
- [x] Japanese language support
- [x] Spanish language support
- [x] Italian language support
- [x] German language support
- [x] Dutch language support
- [x] Portuguese language support
- [x] Automatic browser language detection
- [x] Language preference persistence

### Security & Accessibility
- [x] External content blocked by default
- [x] HTML sanitization with DOMPurify
- [x] User control for loading external content
- [x] Trusted senders list for automatic image loading
- [x] Dark mode email readability (intelligent color transformation)
- [x] WCAG 2.0 Level AA color contrast compliance
- [x] Newsletter unsubscribe support (RFC 2369)
- [x] XSS attack prevention with comprehensive validation
- [x] CSP Report-Only headers with per-request nonce
- [x] Security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy)
- [x] Reusable focus trap hook (Tab cycling, Escape handling, focus restore)
- [x] WCAG AA prefers-reduced-motion support (global animation/transition reset)
- [x] Safe area insets for notched mobile devices
- [x] Screen reader sr-only live region for dynamic announcements

### Identity Management
- [x] Multiple sender identities (name, email, signature)
- [x] Sub-addressing support (user+tag@domain.com)
- [x] Per-identity signatures
- [x] Identity badges in email viewer and list
- [x] Tag suggestions based on context
- [x] Display name included in From header (recipients see name, not just email)
- [x] Primary identity (matching login) selected by default in composer

### Address Book & Contacts
- [x] Contact store with JMAP sync and local fallback
- [x] Contact CRUD operations (create, read, update, delete)
- [x] Contacts list view with search/filter
- [x] Contact details view/edit form
- [x] JMAP contacts sync (RFC 9553/9610 ContactCard/AddressBook)
- [x] Email autocomplete from contacts
- [x] Contacts integration in email composer (To/Cc/Bcc)
- [x] Contact groups/lists management with JMAP members map
- [x] vCard import/export (RFC 6350 parser/generator, duplicate detection)
- [x] Bulk contact operations (multi-select, delete, group add, export)
- [x] i18n support for contacts (all 8 languages)

### Vacation Responder
- [x] JMAP VacationResponse singleton management
- [x] Settings tab with date range and message configuration
- [x] Sidebar indicator when vacation auto-reply is active
- [x] i18n support (all 8 languages)

### Calendar Integration
- [x] JMAP Calendar types (RFC 8984) and client methods
- [x] Calendar capability detection (urn:ietf:params:jmap:calendars)
- [x] Calendar store with Zustand (persist middleware)
- [x] Month, week, day, and agenda views
- [x] Event modal (create/edit/delete with recurrence, reminders)
- [x] Mini-calendar sidebar with calendar visibility toggles
- [x] Calendar settings (default view, week start, time format)
- [x] Multi-day event spanning across all covered days
- [x] Column-based overlap layout for concurrent events
- [x] Locale-aware date formatting via next-intl
- [x] First day of week and time format settings wired to views
- [x] Push notification handling for calendar state changes
- [x] Calendar page capability check (redirect if unsupported)
- [x] Error handling with toast feedback on event CRUD
- [x] Timezone auto-detection on event creation
- [x] Input validation, color sanitization, focus trap
- [x] ARIA grid roles and event card accessible labels
- [x] Mobile touch targets (44px minimum)
- [x] Calendar keyboard shortcuts (m/w/d/a views, t today, n new event)
- [x] i18n support with ICU pluralization (all 8 languages)
- [x] Drag-and-drop event rescheduling (week/day time snap, month date move)
- [x] iCalendar (.ics) file import via CalendarEvent/parse with preview and bulk create
- [x] Event notifications with client-side alert evaluation and toast display
- [x] Notification sound, acknowledged alert persistence (localStorage), proactive 24h event fetch
- [x] Configurable notification settings (enable/disable, sound toggle)
- [x] Participant scheduling with iTIP invitations (organizer/attendee UI, RSVP buttons, contact autocomplete)
- [x] Inline calendar invitation banner in email viewer (auto-detect .ics attachments, RSVP, import to calendar, cancellation display)
- [x] Scheduling message support (sendSchedulingMessages flag for create/update/delete)
- [x] Click-drag to create events (pointer-based time range selection, 15-min snap, visual overlay)
- [x] Event resize by dragging bottom edge handle (15-min snap, optimistic JMAP update)
- [x] Recurring event edit/delete scope dialog (this event / this and following / all events)
- [x] Double-click quick event creation (inline title input, PT1H default)
- [x] Event duplication button in modal (clones event +1 day, opens for editing)

### Email Filters
- [x] JMAP Sieve Scripts (RFC 9661) with capability detection
- [x] Visual rule builder (conditions: From/To/Cc/Subject/Header/Size/Body, actions: Move/Copy/Forward/Mark read/Star/Label/Discard/Reject/Keep/Stop)
- [x] Raw Sieve script editor with syntax validation
- [x] Sieve generator and parser with JSON metadata round-trip
- [x] Filter store with CRUD, reorder, toggle, auto-save with rollback
- [x] Opaque script detection with reset to visual builder option
- [x] Focus trap accessibility in modals
- [x] Toast validation feedback for empty rules
- [x] Push notification handling for SieveScript state changes
- [x] i18n support (all 8 languages)

### Email Templates
- [x] Reusable email templates with local storage persistence
- [x] Category organization (General, Business, Personal, Support, Follow-up, custom)
- [x] Dynamic placeholder variables with auto-fill from composer context
- [x] Template manager modal (create, edit, duplicate, delete)
- [x] Template picker in composer toolbar with search and category filter
- [x] Custom placeholder prompt on template insertion
- [x] Settings tab for template management
- [x] Keyboard shortcut (Ctrl+Shift+T to insert template)
- [x] i18n support (all 8 languages)

### Email Display
- [x] Proper email layout without horizontal scroll or clipping
- [x] Blocked image container collapsing (no empty spaces in newsletters)

### Testing
- [x] Unit tests for validation utilities (57 tests)
- [x] Unit tests for email sanitization (27 tests)
- [x] Unit tests for color transformation (40 tests)
- [x] Unit tests for contact store (56 tests)
- [x] Unit tests for JMAP contact client (41 tests)
- [x] Unit tests for vCard parser (18 tests)
- [x] Unit tests for thread utilities (20 tests)
- [x] Unit tests for email headers (39 tests)
- [x] Component tests (contacts, UI components — 41 tests)
- [x] JMAP client method tests (identity: 20, contacts: 41)
- [x] Unit tests for Sieve generator (50 tests)
- [x] Unit tests for Sieve parser (14 tests)
- [x] Unit tests for calendar alerts (36 tests)
- [x] Unit tests for calendar notification store (8 tests)
- [x] Unit tests for calendar invitation parsing (25 tests)
- [x] Unit tests for calendar participants (26 tests)
- [x] Unit tests for template utilities (48 tests)
- [x] Unit tests for OAuth PKCE and discovery (14 tests)
- [x] XSS attack vector testing
- [x] Playwright E2E framework setup

### Deployment
- [x] Runtime environment variables (Docker-friendly configuration)
- [x] Health check endpoint
- [x] Docker support (multi-stage build, docker-compose, standalone output)
- [x] Structured server-side logger (text/JSON format, configurable level)
- [x] Pre-built Docker image on [Docker Hub](https://hub.docker.com/r/rootfr/jmap-webmail) and [GHCR](https://ghcr.io/root-fr/jmap-webmail) with multi-arch support (amd64/arm64)
- [x] GitHub Actions CI/CD for automated image publishing on releases
- [x] CVE remediation: remove npm from production image, upgrade Alpine packages
- [x] Server-side update check (logs newer version availability on startup)

## Planned Features

### Advanced Features
- [ ] Free/busy queries (Principal/getAvailability)
- [ ] Calendar sharing UI (JMAP Sharing RFC 9670)
- [ ] Email encryption (PGP/GPG)

### Performance Optimizations
- [ ] Email content caching
- [ ] Bundle size optimization
- [ ] Service worker for offline support
- [ ] Lazy loading for attachments

### Testing (Remaining)
- [ ] E2E tests with real JMAP server
- [ ] Accessibility testing
- [ ] Performance testing

### Deployment
- [ ] Production build optimizations
- [ ] Monitoring and logging

### Security Enhancements
- [ ] Rate limiting

## Known Issues

- [ ] Next.js workspace root warning (cosmetic)

## Contributing

Want to help implement a feature? Check out our [CONTRIBUTING.md](CONTRIBUTING.md) guide!
