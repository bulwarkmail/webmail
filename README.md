<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/branding/Bulwark_Logo_with_Lettering_White_and_Color.svg" />
  <source media="(prefers-color-scheme: light)" srcset="public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" />
  <img src="public/branding/Bulwark_Logo_with_Lettering_Dark_Color.svg" alt="Bulwark Webmail" width="280" />
</picture>

# Bulwark Webmail

A modern, self-hosted webmail client for [Stalwart Mail Server](https://stalw.art/), built with Next.js and the JMAP protocol.

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL%20v3-blue.svg?logo=gnu&logoColor=white)](LICENSE)
[![Discord](https://img.shields.io/discord/1482128142939455674?color=7289da&label=discord&logo=discord&logoColor=white)](https://discord.gg/tYCujymGrT)
[![Version](https://img.shields.io/badge/version-1.5.1-green.svg?logo=git&logoColor=white)](CHANGELOG.md)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fbulwarkmail%2Fwebmail-blue?logo=docker&logoColor=white)](https://ghcr.io/bulwarkmail/webmail)

</div>

---

## Screenshots

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="screenshots/mail-dark.png" />
  <img src="screenshots/mail-white.png" alt="Mail view" width="100%" />
</picture>

<table>
<tr>
<td width="50%"><img src="screenshots/calendar.png" alt="Calendar" /></td>
<td width="50%"><img src="screenshots/contacts.png" alt="Contacts" /></td>
</tr>
<tr>
<td><sub><b>Calendar</b> – month, week, day, and agenda views with drag-to-reschedule, iMIP invitations, and CalDAV subscriptions.</sub></td>
<td><sub><b>Contacts</b> – multiple address books, groups, vCard import/export, and autocomplete in the composer.</sub></td>
</tr>
<tr>
<td><img src="screenshots/theme.png" alt="Themes" /></td>
<td><img src="screenshots/plugins.png" alt="Plugins" /></td>
</tr>
<tr>
<td><sub><b>Themes</b> – bundled color themes or upload your own as ZIP bundles; admins can enforce presets.</sub></td>
<td><sub><b>Plugins</b> – extend the client with bundled or third-party plugins installed from a .zip file.</sub></td>
</tr>
<tr>
<td><img src="screenshots/mail-white.png" alt="Light mode" /></td>
<td><img src="screenshots/settings.png" alt="Settings" /></td>
</tr>
<tr>
<td><sub><b>Light mode</b> – full theme support with intelligent color transformation for HTML emails.</sub></td>
<td><sub><b>Settings</b> – appearance, identities, filters, templates, security, and more.</sub></td>
</tr>
</table>

## Overview

Bulwark is a full webmail suite – not just an inbox. It bundles the four apps most self-hosters end up wanting on the same login:

- **Mail** – threading, unified inbox, full-text search, Sieve filters, S/MIME, templates
- **Calendar** – month/week/day/agenda, recurring events, iMIP invitations, CalDAV subscriptions
- **Contacts** – multiple address books, groups, vCard import/export
- **Files** – Stalwart's JMAP FileNode storage with previews and folder upload

Plus the infrastructure around them: OAuth2 / OIDC SSO, TOTP 2FA, multi-account (up to 5 at once), 14 languages, PWA install, dark/light themes, a plugin system with an extension marketplace, and a admin dashboard.

Full feature list: **[FEATURES.md](FEATURES.md)**.

---

## Quick Start

### Docker

```bash
docker run -d -p 3000:3000 \
  -e JMAP_SERVER_URL=https://mail.example.com \
  ghcr.io/bulwarkmail/webmail:latest
```

Or with Docker Compose:

```bash
cp .env.example .env.local
# Edit .env.local – set JMAP_SERVER_URL
docker compose up -d
```

### From Source

```bash
git clone https://github.com/bulwarkmail/webmail.git
cd webmail
npm install
cp .env.example .env.local
# Edit .env.local – set JMAP_SERVER_URL
npm run build && npm start
```

### Development

```bash
npm run dev        # Dev server with a mock JMAP server
npm run typecheck
npm run lint
```

## Configuration

All variables are evaluated at runtime, so Docker deployments can be reconfigured without rebuilding. Edit `.env.local`:

```env
# Required
JMAP_SERVER_URL=https://mail.example.com

# Optional
APP_NAME=My Webmail
```

<details>
<summary>Server listen address</summary>

```env
HOSTNAME=0.0.0.0    # Default; use "::" for IPv6
PORT=3000
```

</details>

<details>
<summary>OAuth2 / OIDC</summary>

```env
OAUTH_ENABLED=true
OAUTH_CLIENT_ID=webmail
OAUTH_CLIENT_SECRET=              # optional, for confidential clients
OAUTH_CLIENT_SECRET_FILE=         # path to a file containing the secret
OAUTH_ISSUER_URL=                 # optional, for external IdPs
```

Endpoints are auto-discovered via `.well-known/oauth-authorization-server` or `.well-known/openid-configuration`.

</details>

<details>
<summary>Session & settings sync</summary>

```env
SESSION_SECRET=                      # openssl rand -base64 32
SESSION_SECRET_FILE=/session-secret  # path to a file containing the secret

SETTINGS_SYNC_ENABLED=true
SETTINGS_DATA_DIR=./data/settings    # mount as a volume in Docker
```

Credentials are encrypted with AES-256-GCM and stored in an httpOnly cookie (30-day expiry). Settings sync stores per-account preferences encrypted at rest and requires `SESSION_SECRET`.

</details>

<details>
<summary>Custom JMAP endpoint</summary>

```env
ALLOW_CUSTOM_JMAP_ENDPOINT=true
```

Shows a "JMAP Server" field on the login form. External servers must CORS-allow the webmail origin.

</details>

<details>
<summary>Branding & PWA</summary>

```env
APP_NAME=My Webmail
APP_SHORT_NAME=Webmail
APP_DESCRIPTION=Your personal mail

FAVICON_URL=/branding/favicon.svg
PWA_ICON_URL=/branding/icon.svg      # falls back to FAVICON_URL
PWA_THEME_COLOR=#3b82f6
PWA_BACKGROUND_COLOR=#ffffff

APP_LOGO_LIGHT_URL=/branding/logo-light.svg
APP_LOGO_DARK_URL=/branding/logo-dark.svg
LOGIN_LOGO_LIGHT_URL=/branding/login-light.svg
LOGIN_LOGO_DARK_URL=/branding/login-dark.svg

LOGIN_COMPANY_NAME=My Company
LOGIN_WEBSITE_URL=https://example.com
LOGIN_IMPRINT_URL=https://example.com/imprint
LOGIN_PRIVACY_POLICY_URL=https://example.com/privacy
```

</details>

<details>
<summary>Extension directory</summary>

```env
EXTENSION_DIRECTORY_URL=https://extensions.bulwarkmail.org
```

Enables the admin marketplace for browsing and installing plugins and themes.

</details>

<details>
<summary>Stalwart integration & logging</summary>

```env
STALWART_FEATURES=true               # password change, Sieve filters, etc.

LOG_FORMAT=text                      # "text" or "json"
LOG_LEVEL=info                       # error | warn | info | debug
```

</details>

## Keyboard Shortcuts

| Key           | Action                  |
| ------------- | ----------------------- |
| `j` / `k`     | Navigate between emails |
| `Enter` / `o` | Open email              |
| `Esc`         | Close / deselect        |
| `c`           | Compose                 |
| `r` / `R`     | Reply / Reply all       |
| `f`           | Forward                 |
| `s`           | Star                    |
| `e`           | Archive                 |
| `#`           | Delete                  |
| `/`           | Search                  |
| `?`           | Show all shortcuts      |

## Tech Stack

|               |                                                   |
| ------------- | ------------------------------------------------- |
| **Framework** | [Next.js 16](https://nextjs.org/) with App Router |
| **Language**  | TypeScript                                        |
| **Styling**   | [Tailwind CSS v4](https://tailwindcss.com/)       |
| **State**     | [Zustand](https://zustand-demo.pmnd.rs/)          |
| **Protocol**  | Custom JMAP client (RFC 8620)                     |
| **i18n**      | [next-intl](https://next-intl-docs.vercel.app/)   |
| **Icons**     | [Lucide React](https://lucide.dev/)               |

## Why Stalwart?

[Stalwart](https://github.com/stalwartlabs/mail-server) is a Rust mail server with native JMAP support – not IMAP/SMTP with JMAP bolted on. It handles JMAP, IMAP, SMTP, and ManageSieve in a single self-hosted binary with no third-party dependencies.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[GNU AGPL v3](LICENSE). This repository preserves the original MIT attribution for the fork lineage in [NOTICE](NOTICE).

## Acknowledgments

Thanks to [root-fr/jmap-webmail](https://github.com/root-fr/jmap-webmail/) and [@ma2t](https://github.com/ma2t) for the groundwork this project builds upon.
