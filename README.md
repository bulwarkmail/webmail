# JMAP Webmail

A webmail client for [Stalwart Mail Server](https://stalw.art/), built with Next.js and the JMAP protocol.

## Why Stalwart?

Stalwart is a mail server written in Rust with native JMAP support, not IMAP/SMTP with JMAP added as an afterthought. It handles JMAP, IMAP, SMTP, and ManageSieve. Self-hosted, no third-party dependencies.

[Stalwart on GitHub](https://github.com/stalwartlabs/mail-server) | [Documentation](https://stalw.art/docs/)

## Features

### Email

- Read, compose, reply, reply-all, and forward
- HTML rendering with DOMPurify sanitization
- Attachment upload and download
- Draft auto-save with discard confirmation
- Threading with inline expansion
- Mark as read/unread, star/unstar
- Archive and delete with configurable behavior
- Color tags/labels
- Search with JMAP filter panel, search chips, cross-mailbox queries
- Virtual scrolling for large lists

### Interface

- Three-pane layout with dark and light themes
- Responsive (desktop sidebar + mobile bottom tab bar)
- Keyboard shortcuts
- Drag-and-drop email organization
- Right-click context menus
- Animations that respect `prefers-reduced-motion`
- Infinite scroll pagination
- Toast notifications with undo support
- Form validation with shake feedback
- Safe area insets for notched devices
- Screen reader live regions

### Real-time

- Push notifications via JMAP EventSource
- Live unread counts
- Email arrival notifications
- Connection status indicator

### Identity management

- Multiple sender identities with per-identity signatures
- Sub-addressing (user+tag@domain.com) with tag suggestions
- Identity badges in viewer and list

### Address book

- Contact management with search and filtering
- JMAP server sync (RFC 9553/9610) with local fallback
- Email autocomplete in composer
- Contact groups with group expansion
- vCard import/export (RFC 6350) with duplicate detection
- Bulk operations (multi-select, delete, group add, export)

### Calendar

- JMAP Calendar (RFC 8984) with capability detection
- Month, week, day, and agenda views
- Event create, edit, delete with recurrence and reminders
- Participant scheduling with iTIP invitations and RSVP
- Inline calendar invitation banner in email viewer (.ics detection, RSVP, import)
- Multi-day events, column-based overlap layout
- Mini-calendar sidebar with calendar visibility toggles
- Locale-aware date formatting
- Settings for first day of week, time format (12h/24h), default view
- Drag-and-drop rescheduling with time snap
- Click-drag on empty slots to create events
- Resize events by dragging (15-minute snap)
- Double-click quick create
- Event duplication (+1 day offset)
- Recurring event edit/delete scope (this, this and following, all)
- iCalendar (.ics) file import with preview
- Real-time updates via JMAP push
- Event notifications with configurable sound

### Email templates

- Reusable templates organized by category
- Placeholder variables (`{{recipientName}}`, `{{date}}`, etc.) with auto-fill
- Template picker in compose toolbar with search and filter
- Template manager in settings

### Email filters

- Server-side filtering with JMAP Sieve Scripts (RFC 9661)
- Visual rule builder: conditions (From, To, Subject, Size, Body...) and actions (Move, Forward, Mark read, Star, Discard, Reject...)
- Raw Sieve editor with syntax validation
- Auto-save with rollback on failure
- Drag-and-drop rule reordering
- Only shown when the server supports Sieve

### Vacation responder

- JMAP VacationResponse with date range scheduling
- Settings tab for message configuration
- Sidebar indicator when active

### Security and privacy

- External content blocked by default
- Trusted senders list for automatic image loading
- HTML sanitization (DOMPurify)
- SPF/DKIM/DMARC status indicators
- Session-based auth, no password storage by default
- TOTP two-factor authentication
- "Remember me" with AES-256-GCM encrypted httpOnly cookie (opt-in)
- OAuth2/OIDC with PKCE for SSO (opt-in, RP-initiated logout)
- External IdP support (Keycloak, Authentik) via configurable issuer URL
- CORS misconfiguration detection with detailed error messages
- Shared folder support
- Newsletter unsubscribe (RFC 2369)
- CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy headers

### Internationalization

- 8 languages: English, French, Japanese, Spanish, Italian, German, Dutch, Portuguese
- Automatic browser language detection
- Persistent language preference

### Deployment

- Pre-built Docker images on [Docker Hub](https://hub.docker.com/r/rootfr/jmap-webmail) and [GHCR](https://ghcr.io/root-fr/jmap-webmail) (amd64/arm64)
- Multi-stage build with standalone output
- Runtime environment variables (no rebuild needed)
- Health check endpoint
- Structured logging (text/JSON)
- Update check on startup (server logs only, no client exposure)

## Tech stack

- [Next.js 16](https://nextjs.org/) with App Router
- TypeScript
- [Tailwind CSS v4](https://tailwindcss.com/)
- [Zustand](https://zustand-demo.pmnd.rs/) for state management
- Custom JMAP client (RFC 8620)
- [next-intl](https://next-intl-docs.vercel.app/) for i18n
- [Lucide React](https://lucide.dev/) icons

## Getting started

### Prerequisites

- Node.js 18+
- A JMAP-compatible mail server ([Stalwart](https://stalw.art/) recommended)

### Installation

```bash
git clone https://github.com/root-fr/jmap-webmail.git
cd jmap-webmail
npm install
cp .env.example .env.local
```

### Configuration

Edit `.env.local`:

```env
# App name displayed in the UI
APP_NAME=My Webmail

# Your JMAP server URL (required)
JMAP_SERVER_URL=https://mail.example.com
```

These are runtime environment variables, read at request time. Docker deployments can be configured without rebuilding. Legacy `NEXT_PUBLIC_*` variables still work as fallbacks.

#### OAuth2/OIDC (optional)

To enable SSO login alongside Basic Auth:

```env
OAUTH_ENABLED=true
OAUTH_CLIENT_ID=webmail
OAUTH_CLIENT_SECRET=              # optional, for confidential clients
OAUTH_ISSUER_URL=                 # optional, for external IdPs (Keycloak, Authentik)
```

Endpoints are auto-discovered via `.well-known/oauth-authorization-server` or `.well-known/openid-configuration`. If your JMAP server delegates auth to an external IdP, set `OAUTH_ISSUER_URL` to the IdP's base URL (e.g., `https://keycloak.example.com/realms/mail`).

#### Remember me (optional)

To enable "Remember me" for Basic Auth login:

```env
SESSION_SECRET=your-secret-key    # Generate with: openssl rand -base64 32
```

When set, a "Remember me" checkbox appears on the login form. Credentials are encrypted with AES-256-GCM and stored in an httpOnly cookie (30-day expiry).

### Development

```bash
npm run dev        # Start dev server
npm run typecheck  # Type checking
npm run lint       # Linting
```

### Production

```bash
npm run build
npm start
```

### Docker

```bash
# Pre-built image
docker run -p 3000:3000 -e JMAP_SERVER_URL=https://mail.example.com rootfr/jmap-webmail:latest

# From GHCR
docker run -p 3000:3000 -e JMAP_SERVER_URL=https://mail.example.com ghcr.io/root-fr/jmap-webmail:latest

# With docker compose
cp .env.example .env.local
# Edit .env.local with your JMAP_SERVER_URL
docker compose up -d

# Build from source
docker build -t jmap-webmail .
docker run -p 3000:3000 -e JMAP_SERVER_URL=https://mail.example.com jmap-webmail
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate between emails |
| `Enter` / `o` | Open selected email |
| `Esc` | Close viewer / deselect |
| `c` | Compose new email |
| `r` | Reply |
| `R` / `a` | Reply all |
| `f` | Forward |
| `s` | Toggle star |
| `e` | Archive |
| `#` / `Delete` | Delete |
| `u` | Mark as unread |
| `/` | Focus search |
| `x` | Expand/collapse thread |
| `Ctrl+Shift+T` | Insert template |
| `?` | Show shortcuts help |

## Screenshots

<table>
<tr>
<td width="50%">

**Login**
<img src="screenshots/01-login.png" width="100%" alt="Login">

</td>
<td width="50%">

**Inbox**
<img src="screenshots/02-inbox.png" width="100%" alt="Inbox">

</td>
</tr>
<tr>
<td width="50%">

**Email Viewer**
<img src="screenshots/03-email-viewer.png" width="100%" alt="Email Viewer">

</td>
<td width="50%">

**Compose**
<img src="screenshots/04-compose.png" width="100%" alt="Compose">

</td>
</tr>
<tr>
<td width="50%">

**Dark Mode**
<img src="screenshots/05-dark-mode.png" width="100%" alt="Dark Mode">

</td>
<td width="50%">

**Settings**
<img src="screenshots/06-settings.png" width="100%" alt="Settings">

</td>
</tr>
</table>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for planned features.

## Acknowledgments

- [Stalwart Labs](https://stalw.art/) for the mail server
- The [JMAP](https://jmap.io/) working group for the protocol spec

## License

MIT. See [LICENSE](LICENSE).
