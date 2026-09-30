# Changelog

## 1.11.2 (2026-09-26)

1.11.2 fixes the Docker image and the standalone tarballs of 1.11.1, which did not start. It contains all the security fixes from 1.11.1, so please update.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Fixes

- **Docker**: The server starts again. 1.11.1 excluded `data/` from the standalone build with a pattern that also dropped Next.js's own metadata modules, so the Docker image and the `bulwark-standalone-*` tarballs failed on startup. `npm start` and Bulwark Lite were not affected

## 1.11.1 (2026-09-26)

1.11.1 is a security and bug-fix release. It fixes four reported vulnerabilities, two of them critical, and the findings of a security audit. Please update.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Admin**: Only a Stalwart superuser gets into the admin dashboard. The admin probe accepted Stalwart's default tenant-admin role, so the administrator of a single tenant was signed into a dashboard that configures the whole instance (GHSA-v6hr-cmxm-pv73, thanks @douwezijlstra-frl)
- **Admin**: Admin status is only taken from an admin-configured server. A context cookie minted while custom JMAP endpoints were allowed let a user-chosen server keep answering the admin probe after the switch was turned off (GHSA-j867-89p4-v8hm, thanks @Vip3r-MC)
- **API**: Cross-origin writes are refused on the JMAP passthrough and every other cookie-authenticated `/api/` route, not only `/api/auth/*`. A page on a same-site sibling origin could run arbitrary JMAP as the signed-in user. The gate also decides on the decoded path, so `/api/%61uth/...` no longer skips it (GHSA-9mvj-98f5-9q6g, thanks @kah-ja)
- **Admin**: Admin sign-in attempts are also capped at 50 per 15 minutes across all clients, because a forged `X-Forwarded-For` got a fresh per-IP budget when no reverse proxy is in front (GHSA-7pj2-232x-6698, thanks @richardweinberger)
- **Admin**: Impersonation no longer puts the Stalwart master password into the session cookie. The webmail creates an app password on the target mailbox that expires after 8 hours and is revoked on sign-out, and a used impersonation link is refused after a restart or on another replica
- **Mail**: A sender can no longer fake a DMARC or DKIM pass in the security badges, with a crafted envelope address or an `Authentication-Results` header of their own
- **Mail**: Opening an SVG attachment's thumbnail on its own no longer runs the sender's script in the webmail origin
- **Mail**: Remote content stays blocked in the mobile conversation view, the `.eml` attachment preview, the quoted original of a reply or forward, the print view, and for URL spellings the filter missed (backslashes, CSS escapes, `image-set()`)
- **Mail**: Links in image maps (`<area>`) no longer keep `window.opener`
- **Mail**: A `mailto:` unsubscribe goes to the single address in the link, and the confirmation shows recipient, subject and body before sending
- **Mail**: A crafted `winmail.dat` no longer freezes the tab
- **Composer**: A sender name containing a quote can no longer add a recipient to a draft
- **Filters**: Rule names, header names and sizes are escaped, so rules from plugins or imported filter sets cannot add commands such as `redirect` to the Sieve script
- **Plugins**: Hooks and slots need a declared permission, like the host API does. `http.post` can no longer reach the JMAP passthrough, `/api/admin/*`, `/api/settings` or other credentialed routes, and plugin storage is kept per account and deleted on sign-out
- **Themes**: The theme CSS sanitizer no longer lets remote resources through (`url(//host)`, CSS escapes, `image-set()`, `@font-face` sources), and theme CSS can only target `:root` and `.dark`, also when a plugin transforms it
- **Files**: WOPI file downloads are always served as inert attachments, so a blob typed `text/html` cannot run script in the webmail origin
- **Server**: The SSRF guard also blocks loopback beyond `127.0.0.1`, CGNAT, benchmark, multicast and reserved ranges, and NAT64, 6to4 and Teredo addresses that wrap an internal IPv4 address. Telemetry targets are checked at connect time, and OAuth token and revocation requests never follow redirects
- **Auth**: Synced settings are keyed on the account a bearer token belongs to, so on a multi-domain server `john@b.example` can no longer read the settings of `john@a.example`
- **Auth**: Wrong passwords tried through the login pre-check are limited, so the route can no longer be used as a password oracle or trip Stalwart's ban against the webmail itself
- **Auth**: Signing out ends office editor sessions opened in that browser, and a full sign-out clears search history, open tabs, Files recents, staged plugin uploads and the other accounts' leftovers, also in other open tabs
- **Auth**: Signing out when another account's restore had failed no longer leaves that account resumable
- **Auth**: The failed TOTP login no longer passes on a user-chosen server's error body
- **Server**: Visitors who are not signed in no longer get detailed health data, the pending advisory text, the plugin list, the full admin policy or every server's domain list
- **Server**: The setup token is passed in the URL fragment, so it stays out of access logs, referers and history
- **Server**: Not-found pages outside the app tree cannot be framed, `ALLOWED_FRAME_ANCESTORS` never applies to the admin dashboard or setup, and sibling subdomains can no longer widen the sidebar-app `frame-src`
- **Server**: Favicons are only served as raster images
- **Docker**: Runtime state and secrets (`data/`, `local-data/`, `.env`) stay out of the standalone build and the image, and the mock JMAP server can no longer be switched on in a release build
- **Lite**: Sign-out revokes the refresh token, and a failed token login no longer keeps the password in `sessionStorage`
- **Lite**: Every static page gets a CSP that allows only its own inline scripts, the Stalwart bundle refuses to run inside a foreign frame, and the Stalwart install instructions use a tagged release with a published `.sha256` instead of `releases/latest`

### Features

- **Calendar**: Tasks with a due date show in the month view (#1107)

### Changes

- **Plugins**: Hooks that change outgoing mail need `email:send`, and display takeovers need `email:render-takeover`. Plugins that don't declare them lose those hooks
- **Themes**: Theme CSS keeps only `:root` and `.dark` rules plus `@font-face`, `@keyframes`, `@media` and `@supports`. Every `url()` except a `#fragment` is removed
- **Admin**: Impersonated sessions end after 8 hours, and sessions minted by earlier versions are signed out
- **Server**: `/api/health?detailed=true` needs a session

### Fixes

- **Mail**: The inbox keeps rendering when a message has an unparsable date (#1099)
- **Mail**: A folder no longer switches back to the unified inbox while it loads (#1102, thanks @guisea)
- **Mail**: Replies in the unified inbox come from the identity of the account that received the mail (#1104)
- **Mail**: Mail deleted during a list refresh no longer reappears (#966)
- **Mail**: The message list no longer jumps while attachment chips load
- **Mail**: Scrolling the unified inbox, cross-account views, tag views and "All folders" search no longer skips messages
- **Mail**: A failed message-list read keeps the list on screen instead of showing an empty folder
- **Mail**: Marking read, starring, tagging, emptying a folder and cancelling a scheduled send report it when the server refuses them
- **Mail**: Tagging and pinning write only the keywords that change, so they no longer mark mail unread that was read on another device
- **Mail**: New mail and folder changes keep arriving for users with seven or more shared accounts
- **Send**: A dropped connection can no longer send a message twice
- **Send**: Undo and edit of a message sent from a group identity act in the group's own account
- **Composer**: A reply draft stays in its thread when it is re-opened or undone
- **Composer**: An open draft stays on its own account across an account switch
- **Accounts**: Quick account switches no longer mix up identities, so replies go out with the right From address
- **Accounts**: Folders, filters and the account security page no longer show the previous account's data after a switch
- **Accounts**: Settings sync turns back on after signing out of one of several accounts
- **Push**: A notification opens its message in the account it came from
- **Calendar**: Events you declined show struck through (#1110)
- **Calendar**: Daily recurring events keep going past a DST gap
- **Calendar**: iCal subscriptions stay with the login that created them, so refreshing or removing one no longer touches a calendar of another login
- **Auth**: SSO sign-in behind nginx no longer fails with a 502 when the cookies would overflow its header buffer (#1096)
- **Auth**: Sign-in and addresses work on internationalized domains (#1100)
- **Lite**: A rate-limited token endpoint no longer signs you out
- **i18n**: The dark/light mode titles and the "Themes" settings tab are translated in every language (#1105, #1106, thanks @dulinux), and so is the themes settings panel
- **i18n**: Updated Portuguese (Brazil) translation (#1106, thanks @dulinux)

## 1.11.0 (2026-09-23)

1.11.0 introduces **Bulwark Lite**, a static build of the webmail that runs without a Node server, and fixes many places where Bulwark and Stalwart disagreed about mail, filters, calendars, contacts and files. It contains everything from the three 1.11.0 betas. The `latest` Docker tag moves to this release.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **Lite**: Bulwark Lite, a static build that talks to the JMAP server straight from the browser. `npm run build:lite` builds it, and every release ships `bulwark-lite-<version>.zip` for any static web host
- **Lite**: `bulwark-lite-stalwart.zip`, a Stalwart Application bundle that picks up its mount prefix at runtime, with OpenID Connect login
- **Lite**: Container image `ghcr.io/bulwarkmail/webmail-lite` (#1081)
- **Themes**: "Flat fields" theme
- **Calendar**: Attendees can answer a single occurrence of a recurring event (#1086)
- **Mail**: Office attachments open read-only in the document editor, straight from the message, when a WOPI editor is configured (#1047)
- **Push**: Optional inbox-only push notifications (#983, thanks @guisea)
- **Mail**: Toasts for mail actions that gave no feedback, and an "email sent" toast after immediate sends
- **Filters**: "Keep a copy" option for forward actions
- **Filters**: Per-rule "Also move messages marked as spam" option
- **Admin**: Login page toggles in admin settings for the version, the 2FA code option, the heading and the subtitle (#1068)
- **Navigation**: Deep links resolve to the local instance

### Changes

- **Auth**: Signing out of an SSO account also signs out of the identity provider when it advertises an `end_session_endpoint` (#905). Set `OAUTH_END_SESSION=false` to keep the provider session, for example when other apps share it, and `OAUTH_POST_LOGOUT_REDIRECT_URI` to send users back to the webmail afterwards
- **Filters**: Move and copy rules leave mail that Stalwart marked as spam in Junk. Before, a rule such as "subject contains invoice" also collected phishing. "Keep" rules stay unguarded as the allow-list
- **Mail**: Search sends terms exactly as typed, without adding a prefix wildcard, in tag views too
- **Mail**: The message list loads attachment chips lazily, so large folders open faster (#1089)
- **Send**: Scheduled send is limited to 7 days, the most Stalwart accepts
- **UI**: Icon set migrated from Lucide to Tabler Icons
- **Docker**: Pre-releases no longer move the `latest` tags
- **Docs**: Most README details moved to the website docs, with new screenshots

### Fixes

- **Mail**: "All folders" search includes shared accounts (#1082)
- **Mail**: A search inside a tag view narrows the tag instead of replacing it (#1084, thanks @rotterp)
- **Mail**: Leaving an account drops a search folder scope that belongs to it (#1084, thanks @rotterp)
- **Mail**: A failed search shows an error instead of "No results found"
- **Mail**: In unified views, threads belong to the account that owns them (#1012, thanks @lucamzanon)
- **Mail**: A failed move between accounts no longer deletes the original
- **Mail**: "Mark all as read" marks every unread message instead of skipping pages past the first 500
- **Mail**: Mark as spam and not spam report moves the server refuses
- **Mail**: Unread-first order keeps bringing up unread mail past the first page
- **Mail**: The tag button in a row's hover actions opens the tag picker instead of clearing the message's tags (#1032, thanks @douwezijlstra-frl)
- **Mail**: Tag and tab counters no longer download every matching id
- **Mail**: Text in fixed-width tables wraps to the screen on iOS (#1020)
- **Mail**: Mail action toasts show again
- **Send**: A send the server refuses is reported as failed instead of sent. When only filing the sent copy fails, a warning says so, so the mail is not sent twice
- **Send**: A From override is also used as the envelope sender where the server accepts it. Where it doesn't, as on Stalwart, the composer says that the identity's address shows in the Return-Path (#1009)
- **Send**: Sending with an identity adds its Bcc addresses
- **Composer**: Attachments over the server's size limits are refused before upload
- **Composer**: A staged attachment is kept until its upload finishes
- **Filters**: Filters keep running while the auto-reply is on, and saving a filter no longer turns the auto-reply off
- **Filters**: "Mark read", "star" and "add label" reach mail that the same rule moves, and rules keep their target folder after it is renamed
- **Filters**: Forward actions respect the server's redirect limit (one on Stalwart) instead of being dropped without notice
- **Auto-reply**: A warning appears before saving an auto-reply that Stalwart would refuse as too long
- **Calendar**: Edits to a single occurrence stay on that occurrence and keep its details
- **Calendar**: Date ranges are queried in the right time zone, and long recurring series or more than 1000 events no longer leave the calendar incomplete
- **Calendar**: When the server refuses an event's invitations, you can save the event without sending them
- **Calendar**: Subscriptions that fail with "Not authenticated" name the cause, such as a mail server certificate the webmail server does not trust (#1073)
- **Calendar**: The subscription dialog no longer promises CalDAV URLs
- **Calendar**: The import dropdown opens above the day and week views (#1049)
- **Contacts**: Contacts with calendar, scheduling or free/busy links save, and cleared fields are cleared on the server
- **Contacts**: vCard import no longer sends fields Stalwart rejects and writes addresses in the RFC 9553 form
- **Contacts**: Deleting an address book that still holds contacts works
- **Files**: Every file is listed, even when the account has more than `maxObjectsInGet` (#1069)
- **Files**: Copying a folder copies its contents, and changes inside a shared drive go to the drive's account
- **Files**: An upload or new folder whose name is taken becomes "name (2)" instead of failing
- **Files**: Sharing works on Stalwart versions before 0.16.6
- **Files**: Names Stalwart refuses are caught before sending, uploads store an accepted variant, and Office files keep their MIME type on Stalwart 0.16.6 and later
- **Account**: You stay signed in after changing your password in settings
- **Account**: Users who are not admins see their name, and changing the password or turning TOTP off asks for the current code
- **Auth**: OAuth endpoints on the configured issuer's own host are accepted when they resolve to a private address, so split-DNS setups no longer need `OAUTH_ALLOW_PRIVATE_ENDPOINTS` (#1028)
- **Auth**: Linking the mobile app re-authenticates against the account's own identity provider when OAuth is configured per server
- **Push**: Push subscriptions are renewed before Stalwart's 7-day expiry, so a tab or app left open for over a week keeps getting notifications
- **Sharing**: Principals are listed in directories with more than 500 users
- **Lite**: The login page hides the server field once `config.json` sets `jmapServerUrl` (#1087)
- **Plugins**: The plugin sandbox follows the app's "Automatic" language (#976, thanks @bartfaizoli76)
- **UI**: The global error page loads the app's styles

## 1.11.0-beta.3 (2026-09-23) - Pre-release

General test release of everything planned for 1.11.0 so far. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- Attendees can answer a single occurrence of a recurring event (#1086).
- Optional inbox-only push notifications (#983, thanks [@guisea](https://github.com/guisea)).
- OpenID Connect login in the Bulwark Lite bundle for Stalwart.
- Bulwark Lite as a container image (#1081).

### Changed

- The message list loads attachment chips lazily, so large folders open faster (#1089).
- Mail search sends search terms exactly as typed, without adding a prefix wildcard. This also applies in tag views.
- Scheduled send is limited to 7 days, the most Stalwart accepts.

### Fixed

- "All folders" search includes shared accounts (#1082).
- A search inside a tag view narrows the tag instead of replacing it.
- Leaving an account drops a search folder scope that belongs to it (#1084, thanks [@rotterp](https://github.com/rotterp)).
- In unified views, threads belong to the account that owns them (#1012, thanks [@lucamzanon](https://github.com/lucamzanon)).
- A failed move between accounts no longer loses the message.
- "Mark all as read" marks every unread message and reports spam moves the server refuses.
- Send and search report failed JMAP calls instead of claiming success.
- Attachments over the server's size limits are refused before upload.
- Sending with an identity adds its Bcc addresses.
- Tag and tab counters no longer download every matching id.
- Mail filters keep running while the auto-reply is on, keep flags and folder targets when mail is moved, and no longer pull spam out of Junk.
- A warning appears before you save an auto-reply that Stalwart would refuse as too long.
- Edits to a single occurrence stay on that occurrence and keep its details.
- Calendar ranges are queried in the right time zone and past the server limits.
- If the server refuses an event's invitations, you are offered to save the event anyway.
- The calendar subscription dialog no longer promises CalDAV URLs.
- Contacts with calendar links or cleared fields save correctly.
- Files lists every file, even when the account has more than `maxObjectsInGet` (#1069).
- Files can copy whole folders and write to shared drives, shares files on Stalwart versions before 0.16.6, and handles file names and types Stalwart refuses.
- You stay signed in after changing your password in settings.
- Users who are not admins see their name and can change a TOTP password.
- Push subscriptions are renewed before Stalwart's 7-day expiry.
- Sharing lists principals in directories with more than 500 users.
- The plugin sandbox follows the app's "Automatic" language (#976, thanks [@bartfaizoli76](https://github.com/bartfaizoli76)).
- The global error page loads the app's styles.

## 1.11.0-beta.2 (2026-09-21) - Pre-release

Second test release for **Bulwark Lite**. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- Toasts for mail actions that had no feedback, plus an "email sent" toast after immediate sends.
- Deep links resolve to the local instance.

### Fixed

- A staged attachment is kept until its upload finishes.
- Toasts show again.

## 1.11.0-beta.1 (2026-09-19) - Pre-release

Test release for **Bulwark Lite**, the static build of the webmail. Not recommended for production; the `latest` Docker tag stays on 1.10.0.

### Added

- **Bulwark Lite static export**: `npm run build:lite` produces a server-less build that talks to the JMAP server directly from the browser. The release ships `bulwark-lite-<version>.zip` for any static web host.
- **Bulwark Lite for Stalwart Applications**: `bulwark-lite-stalwart.zip` is a Stalwart `Application` bundle that picks up its mount prefix at runtime.
- **"Flat fields" theme**.

### Changed

- Icon set migrated from Lucide to Tabler Icons.

### Fixed

- Hardened Bulwark Lite login, deep-link replay and settings gating.

## 1.10.0 (2026-09-17)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@windsource](https://github.com/windsource)

**Monthly**

- [@jsaathof](https://github.com/jsaathof)
- [@berkersal](https://github.com/berkersal)
- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

This release fixes six vulnerabilities reported by Jan Kahmen (turingpoint). Please update.

- **Mail**: HTML mail could run script in the webmail origin. `cid:` references were rewritten to `blob:` URLs that kept the sender's `Content-Type`, and the reverse proxy skipped every security header — CSP included — on app paths whose last segment contains a dot, although the signed-in mail, calendar, contacts and files routes render there. Blob URLs are now retyped as inert, link clicks from the message frame are gated by scheme, and the proxy only skips headers for an explicit static-asset allowlist (GHSA-xvjh-v9c6-qcvc, thanks @kah-ja)
- **Auth**: `POST /api/auth/session` and `POST /api/auth/stalwart-context` minted identity cookies without checking the supplied credentials against the JMAP server, so anyone could obtain a cookie for an arbitrary username and read that user's server-side settings. Credentials are now verified upstream before a cookie is issued: Basic credentials are bound to the account they authenticate, Bearer tokens to the session's username and identity. Deployments whose webmail container cannot reach the JMAP server no longer receive identity cookies, so cross-device settings sync stops working there (GHSA-wxcm-j4jc-9fxq, thanks @kah-ja)
- **Plugins**: The `/plugin-sandbox` runtime trusted whichever window posted the first message, so a foreign site could `window.open()` it, post its own `init`, and run code under the route's `unsafe-eval` CSP in the app origin — with or without plugins enabled. The sandbox now only accepts its framing window, and the proxy refuses to serve the route outside an iframe or when plugins are disabled (GHSA-96cx-gx36-3g79, thanks @kah-ja)
- **Auth**: Encrypted payloads now carry a purpose, so a WOPI editor access token can no longer be presented as a `jmap_stalwart_ctx` session cookie (GHSA-cqqx-mjcf-mh55, thanks @kah-ja)
- **Auth**: Reject cross-site requests to `/api/auth/*`. A malicious page could `POST` the victim's browser into an attacker-controlled account (session fixation) (GHSA-qvr9-m8cq-7wvg, thanks @kah-ja)
- **Mail**: Strip CR/LF and other control characters from the header values of generated read receipts. A crafted, RFC 2047-encoded subject could inject additional headers into the receipt (GHSA-w38p-hpqv-g89c, thanks @kah-ja)
- **Auth / Branding**: Pin the resolved IP at connect time for stored custom JMAP endpoints and branding URLs too, closing the DNS-rebinding gap left after GHSA-24w9-8r42-8jwm

### Features

- **Search**: Global search across mail, contacts, calendar and files — query parser, ranking and cross-account providers, a search palette, and a search tab in the Pro shell with avatars, tinted icons and structured previews (#641); hits open through the owning login on every surface (#847)
- **Files**: Office document editing through WOPI — Collabora Online, OnlyOffice and EuroOffice (#425); the demo Files drive ships office document fixtures and a word-processor icon
- **Calendar**: Freely scrolling month, week and day views (#759), infinite scroll in the agenda view, and a setting to turn free scrolling off
- **Calendar**: Recurring occurrences use Stalwart's synthetic ids (#140)
- **Calendar**: Attendee free/busy via `Principal/getAvailability`
- **Calendar**: Invitations and updates surface from `CalendarEventNotification`, and invitations are organized as the default `ParticipantIdentity`
- **Mail**: Per-message HTML / plain-text toggle (#1022)
- **Mail**: Share mail folders with other users via `mail:share`; share notifications appear as toasts
- **Mail**: Search hits are highlighted with `SearchSnippet/get`
- **Mail**: Pushes are resolved with `Email/changes` and `Mailbox/changes` deltas instead of refetching the list
- **Mail**: Attachments show on list rows and open from there (#947, thanks @shukiv)
- **Mail**: Filter advanced search by message size
- **Mail**: Deleting a non-empty folder offers to delete its messages along with it
- **Mail**: "Clear search when switching folders" setting (#852, thanks @shukiv)
- **Mail**: Default sidebar apps for all users (#931)
- **Send**: Request delivery status notifications and REQUIRETLS when sending
- **Reply**: Choose exact-address or same-domain matching for replying from the address a message was received at (#1000)
- **Composer**: Sticky formatting toolbar, font-size picker and background colour (#987, thanks @ibayue)
- **Contacts**: Sort contacts by last name (#963)
- **Contacts**: Set an address book as default (#924)
- **Mobile**: Search-first header replacing the second toolbar row, with the query clearable from the header (#945, thanks @shukiv)
- **PWA**: The installed app icon shows the unread count via the Badging API (#934, thanks @dev-hive-kazniisa)
- **Auth**: `prompt=select_account` is sent to the identity provider when adding another account (#979, thanks @Almost-Senseless-Coder)
- **Admin**: Server-side switch for the Stalwart JMAP passthrough (#904)
- **Plugins**: `ui.openDialog` and a `plugin-dialog` slot for large, clickable custom UI (#975, thanks @bartfaizoli76)
- **Plugins**: `attachment-actions` and `composer-attachment-source` slots (#974, thanks @bartfaizoli76)
- **Plugins**: OAuth callback handler, extended contacts and address-book API (#925, thanks @ponchofiesta)
- **Accessibility**: Better labelling of the email list for screen readers (#1008, thanks @Almost-Senseless-Coder)
- **i18n**: Norwegian Bokmål (#829, thanks @larstobi)
- **i18n**: Traditional Chinese (Taiwan) (#932, thanks @kchuang1015)
- **CI**: The test suite runs on every push and pull request (#647)
- **Dev**: FileNode and blob round-trip in the mock JMAP server, and WOPI on the same-origin dev server

### Changes

- **Docs**: Installer section removed from the README and formatting cleaned up
- **Security policy**: New vulnerability report email address

### Fixes

- **Filters**: Render the "Keep" action as `fileinto "INBOX"` (#1027)
- **Mail**: List tagged mail from every account in the tag view, not just the selected folder's account (#1038)
- **Mail**: Dragging a message out of the list could hang the tab when generated `.eml` file names collided (#1039)
- **Mail**: Preserve label filtering during mailbox refreshes (#1017, thanks @ctaoist)
- **Mail**: Hide body-embedded `cid:` parts declared as `application/octet-stream` from the attachment list (#1005, thanks @dealerweb)
- **Mail**: Stop stretching images that carry their own max-width (#1034, thanks @shukiv), and let sender tables keep theirs (#790)
- **Mail**: Refetch the body when JMAP truncates the displayed part instead of rendering a blank message (#928, thanks @hildebrandttk)
- **Mail**: Auto-detect text direction in the read, print, plain-text, thread and `.eml` preview views (#663, thanks @shukiv)
- **Mail**: Open search hits from shared folders in the right account (#923)
- **Mail**: Collapse search hits for the same server object reached through several logins (#641)
- **Mail**: Guard quick search against stale responses (#872, thanks @vj1235432)
- **Mail**: Only show the unified mailbox section when it can be populated (#843), and stop it missing accounts that had not connected yet (#959, thanks @hildebrandttk)
- **Mail**: Surface `Email/set` failures on delete and move (#956)
- **Mail**: Report a missing archive mailbox instead of failing silently (#578), and archive shared-inbox mail into the owner's archive (#889)
- **Mail**: Mark as spam from the viewer after the message left the list (#695)
- **Mail**: Subscribe newly created mailboxes (#951)
- **Mail**: Sort folders in the role assignment dropdown (#984)
- **Mail**: Add the missing "Scheduled" folder role label (#495)
- **Mail**: Wire the `x` shortcut to thread expansion (#683)
- **Mail**: Keep the reading-mode toggle mounted so toolbar buttons stop jumping (#964)
- **Mail**: Stop the batch toolbar hiding the message you just selected (#948, thanks @shukiv), keep rows in place when it opens, and drop the duplicate selection checkbox
- **Mail**: Align the unread dot with the first line (#715, thanks @lucletoffe) and centre the sender avatar against the row (#953, thanks @shukiv)
- **Mail**: Use Simplified Chinese for the selected-messages label (#786)
- **Send**: Send from the address a message was delivered to (#991, thanks @rotterp)
- **Send**: Set the answered flag when a reply goes out with a send delay (#985)
- **Composer**: Upload attachments through the composing identity's account (#943)
- **Composer**: Pro compose tabs default their From to the open mailbox (#990, thanks @rotterp)
- **Calendar**: Jump to the day picked in the mini calendar (#1037, thanks @dealerweb)
- **Calendar**: Wait for the JMAP client before loading the account principal, and recognise a refused principal read by its JMAP error type (#1036, thanks @dealerweb)
- **Calendar**: Dedupe participants, resolve contact names across alias domains, and show the organizer's status (#986, thanks @ibayue)
- **Calendar**: Linkify URLs in the event description (#968, thanks @lucletoffe)
- **Calendar**: RSVP controls (#967, thanks @wrycu)
- **Calendar**: Normalize task progress states (#994, thanks @mulatta) and omit `progressUpdated` from the task completion payload (#958, thanks @sanitz)
- **Calendar**: Preserve task alarms that the edit dialog does not show (#504)
- **Calendar**: Report calendar clear failures instead of counting zero (#434)
- **Calendar**: Make the iCal subscription size limit configurable and show the real error (#692)
- **Calendar**: Paginate the event fetch on import so UID deduplication sees all existing events (#113)
- **Contacts**: Strip the local-account prefix from address-book ids on contact update (#1043)
- **Contacts**: Set `name.full` on all write paths so vCards carry the mandatory `FN` (#430)
- **Contacts**: Create new contacts in the selected address book (#940, thanks @ponchofiesta)
- **Accounts**: Detect HTTP/2 from the initial navigation timing so accounts are not capped at five (#1003, thanks @lucamzanon)
- **Auth**: Reject wrong passwords server-side so the browser never shows its Basic Auth dialog (#969)
- **Auth**: Stop retrying token refreshes that fail permanently (#972)
- **Auth**: Normalize the OAuth discovery base so a session `JMAP_SERVER_URL` refreshes (#971, thanks @thejdubb02)
- **Auth**: Use the selected server's issuer for SSO discovery (#952)
- **Auth**: Retry the JMAP session fetch when a redirect drops the auth header (#892)
- **Auth**: Drop `max_age=0` from OIDC re-authentication requests (#938)
- **Auth**: Require a session for the translate API (#903)
- **Mobile**: Keep the actions panel below the status bar and pad attachment preview overlays for the iOS PWA safe area (#936)
- **Mobile**: Render plain-text-only mail as text in the thread view (#489)
- **Mobile**: Stop the More menu flashing open when a message is opened
- **Mobile**: Dismiss the search panel once a search runs, open the folder drawer from the right in RTL (#944, thanks @shukiv), and keep the account switcher header on screen
- **PWA**: Smaller margin for the app icons (#883, thanks @ponchofiesta)
- **PWA**: Focus the client before navigating on notification click (#914, thanks @bitfactory-dk)
- **Push**: Resolve push previews for shared and group mailboxes (#839)
- **Plugins**: Allow sandbox chunk loading with CORS (#922, thanks @mulatta)
- **Plugins**: Fail fast when the plugin storage database is blocked (#840)
- **Plugins**: Refill missing managed bundles from the server (#636)
- **Plugins**: Translations for plugins installed from the marketplace (#939, thanks @paulhenry46)
- **Settings**: Index newer settings and the flat calendar toggles in the settings search
- **Settings**: Invalidate the persisted update status after an upgrade
- **UI**: Readable native `<select>` option lists in dark themes (#999)
- **i18n**: German update (#1031, thanks @GyroGearl00se), "Forward as attachment" in more languages (#1016, thanks @dulinux), toolbar keys for nb and zh-TW (thanks @ibayue), and managed sidebar-app keys for zh-TW
- **i18n**: Preserve locale cookie precedence and normalize Chinese proxy locale detection (thanks @kchuang1015); keep `basePath` when normalizing a Chinese `Accept-Language`

## 1.9.2 (2026-08-26)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Security

- **Calendar / Auth**: Pin the resolved IP address at socket-connect time when fetching caller-supplied URLs (iCalendar subscriptions, JMAP login and TOTP token-exchange servers). The public-host check used to run before `fetch()` opened its socket, so an attacker who controlled DNS for a hostname could rebind it to loopback, RFC-1918 or cloud-metadata addresses between the check and the connect and read up to 10 MB of the internal response through the unauthenticated `/api/fetch-ical` endpoint. Redirect targets are now validated the same way (GHSA-24w9-8r42-8jwm, thanks @Tike00)

### Features

- **Push**: Re-sync existing push registrations in the background on app start, so registrations created before the delivery filter existed — or whose Junk mailbox id went stale — get repaired without re-enabling notifications

### Fixes

- **Push**: Stop sending notifications for spam — the push subscription now carries a JMAP `emailPush` delivery filter that excludes `$junk` and the Junk mailbox (needs a server advertising the `emailPush` capability, e.g. Stalwart ≥ 0.16.16; older servers keep the previous behaviour)

## 1.9.1 (2026-08-26)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@NABarnes](https://github.com/NABarnes)
- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Fixes

- **Navigation**: Forward every request header through the proxy — Next 16.3's RSC header check rejected the stripped router headers and sent navigations into a 307 redirect loop (#919)
- **Calendar**: Stop emitting `RSCALE=GREGORIAN;SKIP=OMIT` on plain Gregorian recurrence rules — DAVx5 rejected them as invalid and Android sync broke (#805, thanks @hildebrandttk)

## 1.9.0 (2026-08-25)

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- Anonymous
- [@elsbrock](https://github.com/elsbrock)
- [@getpankajyadav](https://github.com/getpankajyadav)

**Monthly**

- [@felixzieger](https://github.com/felixzieger)
- [@pr0ton11](https://github.com/pr0ton11)
- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)
- [@HiltMundell](https://github.com/HiltMundell)

### Features

- **Mail**: Fullscreen email view in the standard interface
- **Mail**: Drag a mail onto a new browser tab to open it fullscreen
- **Mail**: Configurable message-list ordering (#718)
- **Mail**: Search suggestions with recent searches and contact autocomplete (#845)
- **Mail**: Render plain-text emails in the app font by default, with a monospace option (#830)
- **Mail**: Pull-to-refresh indicator while dragging the list down (#826)
- **Mail**: Redesigned unread favicon badge — a compact keyline badge
- **Mobile**: Swipe message rows left or right for quick actions — archive, delete, toggle read, toggle star, or spam, configurable per direction, RTL-aware
- **Pro**: Reworked split-screen shell with per-pane tab strips, drag & drop between panes, and pane-scoped overlays
- **Pro**: Folder tabs via drag & drop
- **Pro**: The address bar follows the focused tab, and deep links are delivered live to already-mounted surfaces
- **Composer**: Real byte progress for attachment uploads, stock and plugin-offloaded; cancel now aborts the transfer itself
- **Calendar**: Moving an event's start moves the end with it, keeping the event's length
- **Contacts**: Trusted Senders address book enabled by default on contacts-capable accounts
- **Settings**: Custom time zone setting that overrides browser detection (#755)
- **Login**: Server dropdown on the OAuth-only login screen (#799)
- **Push**: New-mail notifications grouped per account with a "+N more messages" line instead of one notification per message
- **Push**: Per-device revoke for push subscriptions (#841)
- **Admin**: Configurable Stalwart admin access to the dashboard (#870)
- **Admin**: Push relay picked from an admin-defined list instead of a free URL field
- **Branding**: OpenGraph/Twitter link previews with a generated card image
- **Performance**: Halved time-to-mail-list — lazy locale catalogs, code-split viewer and composer, shorter auth waterfall, boot snapshot
- **i18n**: Mongolian translation
- **Plugins**: `jmap.uploadBlob`
- **Plugins**: `onBeforeComposeOpenToReply` and sibling hooks let a plugin edit an email before it populates the composer for reply or forward
- **Plugins**: `getPublicKeyFromWKD`
- **Plugins**: Privileged plugins can fetch a byte range of a blob
- **Plugins**: `progressFileId` on `api.http.post` so an offloaded upload reports byte progress to the composer chip
- **Plugins**: `isActive` on `AccountResponse`
- **Plugins**: Label settings and label reordering exposed to extensions
- **Plugins**: JMAP keyword helpers and gateway keywords exposed to extensions
- **Plugins**: Mailbox refresh hook
- **Dev**: `AddressBook/set` in the dev mock JMAP server

### Changes

- **Plugins**: The PRF `getOrCreate` flow is split into separate get and create steps for better authenticator compatibility (#851)
- **Dependencies**: Next 16.3.3, pdfjs-dist 6.2.108, DOMPurify 3.4.14 (npm audit)

### Fixes

- **Send**: Route scheduled sends to the account that owns the submission — mail scheduled from a shared address can now be listed, cancelled, and rescheduled instead of going out silently (#874)
- **Send**: Split recipient lists whose angle brackets never close without dropping recipients
- **Send**: `generateMessageId` crashed on insecure origins (`crypto.randomUUID` undefined), failing the send after the draft save
- **Composer**: Keep attachments when re-opening a draft, also in the Pro draft tab, and destroy old draft versions only after a successful create or send (#849)
- **Composer**: Keep the signature in saved drafts and embed it into re-opened drafts (#848)
- **Composer**: Double-click unlocks the embedded signature for editing
- **Composer**: Keep already written text when applying a template (#540)
- **Composer**: Preselect the shared folder's identity for new messages
- **Composer**: Namespace all accounts consistently in the Pro composer identity list
- **Composer**: Opening a `mailto:` link runs the unsaved-draft dialog instead of replacing the draft outright
- **Composer**: Keep the fresh-compose tab title clear of the selected email subject
- **Composer**: Clear the viewer when sending destroys the displayed draft
- **Reply**: Honour an external Reply-To even on a self-sent message
- **Mail**: Flip `$junk`/`$notjunk` keywords on spam and not-spam (#850)
- **Mail**: Remove keywords with `null` rather than `false` in `Email/set`, per RFC 8620
- **Mail**: Escape the JSON Pointer in keyword patches so nested tags like `work/clients` patch the right keyword
- **Mail**: Route keyword writes — tags, pins, flags — to the selected shared account so they persist
- **Mail**: Route shared-folder management to the owner account, scoped to one server
- **Mail**: Open the right conversations in a shared mailbox (#814)
- **Mail**: Route multi-account email lookups and invitation parsing by source account (#847), and parse invitations in directly viewed shared folders against the folder owner (#867)
- **Mail**: Folders containing a system folder name no longer disappear from the sidebar (#771)
- **Mail**: Folder drag & drop can move folders into other parents (#855)
- **Mail**: Keep the folder tree when a refresh burst hits `maxConcurrentRequests` (#780)
- **Mail**: Stop All-Mail and cross-account views emptying on delete, star, or mark-read (#791)
- **Mail**: Keep just-read or unstarred mail in the open Unread/Starred view
- **Mail**: Search folder filter defaults to all folders and persists (#788)
- **Mail**: Fixed-width read/unread toolbar button so buttons don't jump when a message opens (#864)
- **Mail**: Transparent hover-action background on tagged rows
- **Mail**: Enforce the external media preference on plugin-rendered bodies (#797)
- **Mail**: Apply the `data:` URI allowlist to media tags and `srcset` candidates too
- **Mail**: Make label reordering atomic
- **Mail**: Pass PDF bytes to pdf.js instead of fetching the `blob:` URL that CSP `connect-src` blocks (#871)
- **Mail**: Include email templates in cross-device settings sync (#825)
- **Mail**: Toast store crashed on insecure origins, breaking every post-action acknowledgement
- **Mobile**: Reach the tag and move submenus in the more-actions menu (#779)
- **Mobile**: iOS Safari no longer zooms the viewport on every input focus (#838)
- **Calendar**: Click and double-click create events at the clicked slot instead of near the current time
- **Calendar**: Save and Cancel are available when an event is created, and the toolbar no longer overflows in edit mode
- **Calendar**: Edit a single recurring occurrence via a one-shot override patch
- **Calendar**: Hide tasks-only calendars from the event calendar
- **Calendar**: Exclude subscription and read-only calendars from event creation (#762)
- **Calendar**: Rights-first event editability, including alias organizers
- **Calendar**: Pin `supported-calendar-component-set` on created calendars (#760)
- **Calendar**: Gate first-touch calendar and contacts requests to stop duplicate default calendars (#907)
- **Calendar/Contacts**: Namespace all accounts consistently on switch, so multi-account address-book aggregation and calendar selection survive an account switch
- **Contacts**: Import vCard dates as RFC 9553 PartialDate and map common X- extensions (#224)
- **Files**: Decode percent-encoded FileNode names from WebDAV-created nodes (#869)
- **Files**: Reset the account-scoped Files drive on every account switch
- **Accounts**: Refresh the account display name from the Stalwart principal on login, restore, and switch (#900)
- **Auth**: Reuse the cached access token on session restore (#552)
- **Auth**: Refresh TOTP-minted tokens with the default client id when no OAuth client is configured (#873)
- **Auth**: Store the session cookie for relative JMAP server URLs
- **Security**: Close IPv6 transition-address and redirect bypasses in the endpoint guard
- **Security**: Add embedded custom app origins to CSP `frame-src` (#787)
- **Security**: Per-account isolation for encryption at rest
- **JMAP**: Cap live SSE streams per tab and keep exactly one stream per client, so many logins can't starve JMAP requests (#702)
- **JMAP**: Check the specific capability a request declares (`principals:owner`), not a broader one
- **JMAP**: Resolve relative session URLs without corrupting URI templates
- **Settings**: Merge per-account maps on server load, fixing the compose identity switch
- **Settings**: Leaving the Pro interface returns to the surface in use and keeps the settings scroll position
- **UI**: Position portalled popovers before first paint to stop the layout flash on open
- **Push**: Recreate the push subscription on re-register (#841)
- **i18n**: Key parity across all 24 locales, Catalan and Mongolian registered in the client provider, and scoped translation hooks instead of relative namespace paths
- **Docs**: Lengthen the example `SESSION_SECRET` so it meets the minimum length

## 1.8.1 (2026-08-07)

A GitHub Actions incident left the 1.8.0 release build queued indefinitely, so no Docker image was ever published for that tag. 1.8.1 re-runs the release with the same code, plus one plugin slot that merged in the meantime.

Thank you for your donations:

- _You? [Become a sponsor!](https://github.com/sponsors/bulwarkmail)_

**One-time**

- [@getpankajyadav](https://github.com/getpankajyadav)
- [@Beckid](https://github.com/Beckid)
- [@schnz](https://github.com/schnz)
- [@BryanBerger98](https://github.com/BryanBerger98)

**Monthly**

- [@zeddD1abl0](https://github.com/zeddD1abl0)
- [@fpauser](https://github.com/fpauser)
- [@proxforge](https://github.com/proxforge)
- [@spss20](https://github.com/spss20)
- [@elgringoYan](https://github.com/elgringoYan)
- [@pauladams8](https://github.com/pauladams8)
- [@djpriest](https://github.com/djpriest)
- [@umakers](https://github.com/umakers)
- [@zplizzi](https://github.com/zplizzi)
- [@jeremiah](https://github.com/jeremiah)
- [@Theoretisch1337](https://github.com/Theoretisch1337)
- [@svandive](https://github.com/svandive)

### Features

- **Mail**: Nest tags in a tree by picking a parent when you create one
- **Mail**: Per-tag visibility — always, only when unread, or always hidden
- **Mail**: Assign and clear several tags at once, with a reworked tag display
- **Mail**: Recover tags from the server by scanning mail for JMAP keywords no local tag explains (#658)
- **Mail**: "Forward as attachment" in the viewer and the message-list context menu
- **Mail**: Refresh button in the mail-list toolbar
- **Composer**: Confirm sending without a subject instead of blocking the send, with "Don't ask again" (#684)
- **Contacts**: Contact cards for organizations (#701)
- **Security**: Manage S/MIME and PGP public keys and configure Stalwart encryption at rest from account security settings
- **Notifications**: Background notification onboarding, sequenced after the PWA install prompt
- **Navigation**: Deep links for mail, calendar, contacts, files, and settings, with screen-reader improvements
- **Settings**: Always show the Unified Mailbox switch in Layout settings
- **i18n**: Catalan translation
- **i18n**: Localized editor toolbar across every locale
- **Plugins**: Contact API — `contact.get`, `contact.create`, `contact.update`, `contact.search`
- **Plugins**: `contact-cryptokeys` UI slot, behind the `ui:contact-cryptokeys` permission, so a plugin can render a contact's crypto keys in place of the built-in list
- **Plugins**: `user.getAccounts` and `user.getIdentities`
- **Plugins**: `user.logout` method and logout hook
- **Plugins**: Crypto API — public-key management and encryption-at-rest control on the privileged tier
- **Plugins**: `onBeforeBlobUpload` can offload an attachment to external storage
- **Plugins**: Binary `Blob`/`File` bodies for `api.http.post`
- **Plugins**: `upfiles.get` moved behind `email:blob-read`, off the privileged tier
- **Dev**: Mock JMAP defaults now include nested tags

### Changes

- **Mail**: The "Reset to defaults" button is gone from tag settings — one stray click wiped a carefully built tag list, with no confirmation and no undo

### Fixes

- **Send**: Send through the identity's own account client so DKIM matches the From domain (#461)
- **Send**: Split `Name <addr>` recipients into the JMAP `name` and `email` fields (#672)
- **Send**: Time out stalled JMAP requests so a send can't hang forever (#702)
- **Mail**: Keep inline images when replying to `application/octet-stream` cid parts (#543)
- **Mail**: Reply on your own thread message no longer re-addresses the original recipients (#703)
- **Mail**: Empty folder no longer stops after 500 emails (#711)
- **Mail**: Move messages across accounts from the "Move to" context menu, preserving read state and deferring source removal to Stalwart
- **Mail**: Stop resurrecting deleted rows in the mailbox refresh merge
- **Mail**: Keep the `message/rfc822` attachment visible after inline unwrapping
- **Mail**: Strip sender and recipient names from forward-as-attachment filenames
- **Mail**: Open `mailto:` links in the built-in composer
- **Mail**: Spell out the full tag path in drag-and-drop toasts, so `Personal/Receipts` and `Work/Receipts` no longer read as the same tag
- **Mail**: Act on current email state in the context menu's mark-as-read instead of a stale copy
- **Mail**: Match the selected-row tint between dark and light mode
- **Mail**: Restore lost animations after the Tailwind config move
- **Drafts**: Restore the sender identity when reopening a draft
- **Calendar**: Stop re-adding the organizer to the attendee list on every save (#731)
- **Calendar**: Stop re-probing shared accounts that have no calendar access
- **Calendar**: Route the parse dump through the debug logger
- **Contacts**: Stop minting duplicate "Trusted Senders" address books (#730)
- **Contacts**: Hide Contacts and Calendars when the account lacks the JMAP capability
- **Contacts**: Require an explicit shared-account fallback for contacts and calendars
- **Files**: Show the modification date instead of the creation date (#700)
- **PWA**: Honor the configured theme color in the desktop title bar and keep it in step with the active theme (#671)
- **Accounts**: Reconcile the stale persisted account chip after an impersonation handoff
- **Auth**: Only request a credential cookie when the server has a `SESSION_SECRET`
- **JMAP**: Split requests to stay inside the server's advertised limits — `maxCallsInRequest`, `maxObjectsInGet`/`InSet`, `maxSizeRequest`, and concurrency
- **JMAP**: Treat an aborted SSE connect as a close, not a failure
- **JMAP**: Surface the underlying network error cause in passthrough failures
- **Settings**: Avoid leaving `TZ="undefined"` when restoring an unset timezone
- **Plugins**: Stop a privileged plugin from reading another privileged plugin's PRF secret
- **Plugins**: Correct the method names for message errors and `crypto.getPublicKeys`
- **i18n**: Restore key parity across locales and the English `send_timeout` string
- **Docs**: Document the remaining env vars in the env templates, and correct the facts and headings in README and FEATURES

## 1.8.0 (2026-08-06)

Superseded by 1.8.1. The release build never produced a Docker image — use 1.8.1 instead. The full notes live under 1.8.1 above.

## 1.7.8 (2026-07-22)

### Features

- **Unified Mailbox**: Account-bounded Unified Mailbox with opt-in cross-account aggregation (#509)
- **Unified Mailbox**: Search in the unified views
- **Unified Mailbox**: Live unified/All-Mail counters for shared and group accounts
- **Mail**: Message-list category tabs
- **Mail**: Drag-and-drop reorder for all folders
- **Mail**: Collapse quoted reply text behind a "..." toggle (#480)
- **Mail**: Bulk Not-Spam action in the junk selection toolbar
- **Mail**: Unread count badge on the favicon
- **Mail**: Message spacing setting (auto/always/edge-to-edge)
- **Mail**: Open external links in a new tab (safely)
- **Mail**: Strip external `url()`/`@import` from `<style>` blocks in the sanitizer (#457)
- **Composer**: Text color picker in the composer toolbar
- **Composer**: Contact groups as single expandable recipient chips
- **Composer**: Drag-to-reorder To/Cc/Bcc recipient chips (#593)
- **Composer**: Auto-detect paragraph text direction by default
- **Templates**: HTML template support
- **Vacation**: HTML body support in the vacation responder
- **Send**: 'Send now' action on the send-delay toast
- **Accounts**: Remove a specific account from the switcher
- **Settings**: "Refresh cached data" recovery action
- **i18n**: Full Arabic (ar) translation with RTL support
- **Login**: `LOGIN_SHOW_TOTP` and `LOGIN_SHOW_VERSION` config flags (#520)
- **Docker**: `NEXT_PUBLIC_LOCALE_PREFIX` build argument
- **Plugins**: `ui.rerenderFetchedEmails` method (#668)
- **Plugins**: `onEmailsFetched` and `onSearchResults` hooks and `getSomeEmails` JMAP method
- **Plugins**: `onRecipientChipsChange` hook
- **Plugins**: `webauthn.getOrCreate` API method
- **Plugins**: Download files generated by a plugin (with `ui:download-file` consent permission)
- **Plugins**: Submit mail without moving to a mailbox and import-to-mailbox APIs

### Fixes

- **Mail**: Render the email body on DOM parse instead of iframe load (#635)
- **Mail**: Keep sidebar tag counts in step with read/unread changes
- **Mail**: Enable thread expansion in the focused list
- **Mail**: Show the quote bar in email replies
- **Mail**: Honor part-type fallback when quoting replies (#649)
- **Mail**: Detect typing inside the quoted-HTML shadow island (#654)
- **Mail**: Keep `target`/`rel` on links in plain-text message bodies and open signature links in a new tab
- **Accounts**: Eliminate the full-screen flash when switching accounts (including cached accounts)
- **Accounts**: Recognize canonicalized login usernames in the account-switch guard
- **Auth**: Guard account switch against slot→token desync and basic-auth identity mismatches
- **Auth**: End refresh loops on sign-out and back off failed retries
- **OAuth**: Harden OIDC discovery (timeout, retry, serve-stale)
- **JMAP**: Preserve POST across redirects in the Stalwart JMAP passthrough (#627)
- **JMAP**: File the post-send message with a full `mailboxIds` replacement
- **JMAP**: Generate the Message-ID client-side using the sender's domain
- **Identity**: Sync the default sender identity per account (#507)
- **Attachments**: Download/view attachments on cross-account All-Mail messages
- **Shared folders**: Route batch actions to the owner account
- **Templates**: Insert a mail template at the caret in replies instead of prepending (#539)
- **Templates**: Keep the signature when inserting a template (#621)
- **Templates**: Hide template buttons when templates are disabled
- **Calendar**: Honor "Show time in month view" on mobile instead of forcing dots (#666)
- **Calendar**: Classify self-organized imported events as editable
- **Contacts**: Assign a UID to contact cards on creation (#644)
- **Spam**: Stop HELO `spf=none` from downgrading a MAIL FROM `spf=pass` (#650)
- **Drafts**: Label the close-dialog draft button with the generic Save
- **RTL**: Flip JS-positioned popovers and anchor floating menus with logical start/end
- **RTL**: Isolate Latin address text from RTL bidi reordering and force LTR identity options
- **i18n**: Register Arabic messages in the client IntlProvider
- **i18n**: Fix the Hebrew Drafts folder label
- **i18n**: Add missing translation keys across 22 locales
- **Deps**: Bump `dompurify` to 3.4.12 and `next-intl` to 4.13.3

## 1.7.7 (2026-07-09)

### Features

- **Plugins**: `ui.rerenderEmail` API and restyled read-receipt banner
- **Plugins**: New hooks — `onBeforeBlobUpload`, `onBeforeDraftAutoSave`, `onBeforeEditDraft` (#586)
- **Plugins**: `ui.prompt` dialog and first-class settings-section tabs
- **Calendar**: Jalali (Persian/Shamsi) calendar support with Saturday as week start (#490)
- **i18n**: Hebrew locale with full RTL support
- **i18n**: Slovak translation
- **i18n**: User-selectable regional date format
- **Contacts**: Enable trusted-senders address book sync by default when contacts are available
- **Mail**: Pin emails to the top of the folder list
- **Mail**: Setting to disable the tag-color row tint in the message list
- **Mail**: Click the sender avatar to select a message/thread (Thunderbird-style)
- **Accounts**: Pin the default account on top and drag-to-reorder the account switcher
- **Composer**: Recipient autocomplete from Sent, with on-demand server search
- **Composer**: Preselect the identity of the active mailbox for new messages
- **Email**: Send a quick reply with Ctrl/Cmd+Enter
- **Headers**: Parse Stalwart spam headers
- **Login**: Configurable logo size and hideable heading/subtitle
- **PWA**: Apple Touch icons for the iOS home screen

### Fixes

- **Mail**: Hide Files when the account lacks the filenode capability (#563)
- **Mail**: Keep advanced search filters applied when switching folders (#553)
- **Mail**: Keep the email list scrollable when the bottom reading pane is enabled with no conversation selected
- **Mail**: Route keyword writes to the email's own account in unified view
- **Mail**: Render emails that set `height:100%` on a wrapper element
- **Mail**: Hide images that fail to load
- **Mail**: Storage quota not shown with Stalwart (#577)
- **Spam**: Hide the spam action in Sent, Drafts and Scheduled
- **Spam**: Fix stale folder counters and open message after spam actions
- **Composer**: Wait for in-flight attachment uploads before sending
- **Composer**: Only commit a recipient on Space when the input is a valid email (#571)
- **Composer**: Attachment reminder now ignores quoted text on reply/forward (#570)
- **Calendar**: Store the event organizer as owner-only to prevent duplicate ORGANIZER/ATTENDEE
- **Calendar**: Strike through cancelled events and mute their reminders (#572)
- **Calendar**: Use `calendarAddress`/`organizerCalendarAddress` for scheduling, drop retired `sendTo`/`replyTo` (#500)
- **Auth**: Keep the session when the auth server is briefly unreachable
- **Shortcuts**: Make keyboard shortcuts layout-agnostic and map by physical position
- **Shortcuts**: Don't toggle mailbox subfolders on Arrow keys while typing
- **Contacts**: Clear the photo on the server by sending `media: null` when removed
- **Plugins**: Preserve the settings slot and privileged tier
- **Pro**: Prompt to save or discard a draft when closing a compose tab via the tab-bar X
- **Pro**: Show the Edit button on draft emails opened in a new tab
- **List**: Shift-click on the checkbox extends the selection (range)
- **CSP**: Allow external/data fonts so email webfonts render
- **Notifications**: Brand push notifications with the configured PWA icon
- **Notifications**: Notification sound preview — base-path prefix and longer default beep
- **Unsubscribe**: Send `mailto:` unsubscribe ourselves instead of via the OS handler
- **Branding**: Apply per-domain favicon override in root metadata (#585)
- **Settings**: Load the trusted-senders address book on the settings page so the count isn't 0
- **Setup**: Clone source when `setup.sh` runs detached from a checkout (#518)
- **Server**: Use a callable `.get` to detect `Headers` in `pickRequestHost`

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
