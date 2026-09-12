# Bringing Gmail into a JMAP client

Notes from investigating how to read a Gmail / Google Workspace mailbox in
Bulwark. Nothing here is implemented; this records what was ruled out and why,
so the question does not have to be re-opened from scratch.

Upstream discussion: bulwarkmail/webmail#1007.

## The constraint

Bulwark speaks JMAP and only JMAP — RFC 8620 + 8621, with the capabilities
`core`, `mail`, `submission`, `sieve`, `calendars`, `contacts` and others. There
is no IMAP client anywhere in it, and no provider abstraction to add one behind.
Gmail speaks IMAP and its own HTTP API, and no JMAP.

So the translation has to happen outside the client, and the client has to see a
JMAP server. The direction people reach for first — "convert the webmail's JMAP
into IMAP" — is backwards: nothing consumes JMAP downstream of the client.

## What does not work

**Stalwart cannot proxy it.** Stalwart has no native fetch of external accounts.
Its "external IMAP/SMTP backend" delegates *authentication* only, not mail. The
maintainer's own answer to the fetchmail question is to script it outside
(stalwart#836).

**The reference JMAP-over-IMAP proxy is too old.** `jmapio/jmap-perl`, the
Fastmail proxy behind `proxy.jmap.io`, implements the 2015–2016 draft
(`getMessages`, the pre-`Email`/`Mailbox` model). It predates RFC 8620/8621 by
years and will not talk to a modern client. It was written as a bootstrap for a
world without native JMAP servers, and that world ended.

**`josephg/gmail-jmap` is a proof of concept.** Read-only, on the Gmail API,
heavily rate-limited, a handful of commits.

## What Bulwark already makes easy

`bulwarkmail/legacy-proxy` is Bulwark's own JMAP-to-IMAP/SMTP/ManageSieve/CardDAV
translation layer, and it already ships a `gmail` provider entry
(`imap.gmail.com`, `smtp.gmail.com`, `XOAUTH2`/`PLAIN`). Sign in with a Gmail
**App Password** and Bulwark sees a normal JMAP account — no code, and no OAuth
verification to sit through. It implements `*/changes` with a real change log,
EventSource and Web Push, and IMAP IDLE.

Two things to know before relying on it:

- **Gmail labels become duplicates.** `legacy-proxy` builds `emailId` from
  account + folder + uidvalidity + uid, so a message carrying two labels lives in
  two IMAP folders and gets two ids; moving it is copy + expunge with a new id.
  Gmail's whole model is multi-label, so this is not an edge case.
- **XOAUTH2 needs a token you supply.** The `refreshToken` field exists in the
  types but nothing uses it, so Google access tokens expire after about an hour.
  App Password is the only practical path today.

Also: `sieve` and `carddav` are `null` for the Gmail provider, so filters,
vacation and contacts are absent for that account — Bulwark hides them by
capability, so nothing breaks visibly.

## If the duplicates matter

The label problem is IMAP's, not the proxy's. Gmail's HTTP API maps onto JMAP far
better than IMAP does:

| JMAP | Gmail API |
| --- | --- |
| stable global `Email.id` | `message.id` |
| `mailboxIds` (multi-membership) | `labelIds` — the same shape |
| `Thread` | `threadId` |
| `state` / `Email/changes` | `historyId` / `users.history.list` |
| `Identity` | `settings.sendAs.list` |
| `EmailSubmission` | `messages.send`, with Google doing SPF/DKIM |

The surface a client actually needs is small — `Mailbox/get|set`,
`Email/get|query|set`, `Thread/get`, `Identity/get`, `EmailSubmission/set`,
`Email/import`, blob download/upload — and Bulwark degrades gracefully without
the rest: a missing `/changes` falls back to a full fetch, a missing
`eventSourceUrl` falls back to polling the session state, and capabilities are
gated per feature, so advertising `core` + `mail` + `submission` yields a clean
mail-only account.

The cost is not the protocol mapping, it is the surrounding work: Google's
restricted OAuth scopes (an unverified app hands out 7-day refresh tokens for
personal `@gmail.com`; a Workspace-internal app has neither problem), the
250 units/s quota — which forces a local metadata cache and makes the first index
of a large mailbox a batched job — plus `$answered` not existing in Gmail and
archived mail needing a synthesised `role: "all"` mailbox.

Estimate for a usable MVP was roughly 4–6 weeks full time, in five stages:
read-only browsing, then flags/moves, then identities and sending, then
`historyId`-backed `/changes` and SSE, then quota and token hardening.

## Where it would live

Not in Stalwart: an account whose mail lives at Google is not a storage backend
it can grow. Not in Bulwark either: a JMAP *server* inside a JMAP *client* means
Google credentials ride along with every deployment of the webmail.

It belongs in its own repository, next to `legacy-proxy`, which is exactly the
shape this problem already has: something that speaks JMAP to any client and a
provider's own protocol upstream. `app/api/dev-jmap/[...path]/route.ts` — the
in-memory mock JMAP server in this repo, with session, dispatcher, download,
upload and eventsource — is a ready-made scaffold for the dispatcher while
prototyping.

## Recommendation

Start with `legacy-proxy` and an App Password. It is maintained by the same
project, needs no code, and answers the actual question: can this mailbox be
read in Bulwark. Only if the label duplication turns out to be intolerable in
daily use is the Gmail-API bridge worth building — and by then there will be
concrete evidence of what it has to do better.
