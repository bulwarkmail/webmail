# Unified cross-account views

Three changes that only matter once the unified mailbox spans more than one
account: a correctness fix for thread identity, an optional per-account row
tint, and the admin gate that has to be on before either is reachable.

## Turning the cross-account view on

The sub-toggle **Settings → Layout → Across all accounts** needs four things at
once (`components/settings/layout-settings.tsx`), and with any of them missing it
is not rendered at all — there is no disabled control to hint at what is wrong:

1. **Unified Mailbox** on (the parent toggle);
2. **two or more connected accounts** — `connectedAccountCount > 1`;
3. the admin gate `unifiedCrossAccountEnabled`, which defaults to `false`
   (`lib/admin/types.ts`);
4. the setting not hidden by policy.

The gate lives in `<ADMIN_CONFIG_DIR>/policy.json` and is merged over the
defaults, so a partial file is enough:

```json
{
  "features": {
    "unifiedCrossAccountEnabled": true,
    "crossUnreadViewEnabled": true,
    "crossStarredViewEnabled": true,
    "crossAllViewEnabled": true
  }
}
```

Policy is read at startup, so restart after editing. `GET /api/admin/policy` is
deliberately not admin-protected (users read it), which makes it the quickest way
to check what a running instance actually serves.

## Thread identity is per-account

JMAP thread ids are unique only within their account (RFC 8620 §1.2), and
Stalwart hands them out as short per-account counters — `b`, `c`, `d`. Every
account therefore has a thread `b`, and grouping on the bare id merged unrelated
conversations from different accounts into one row: mixed participants, a wrong
count badge, and one account's colour standing in for several.

`ThreadGroup` carries two ids:

- **`threadId`** — the raw JMAP id. Use it for `Thread/get` / `getThreadEmails`,
  always together with the owning account (`resolveThreadRoute`, #281).
- **`threadKey`** — the client-side identity, `<sourceClientAccountId>/<sourceAccountId>:<threadId>`
  when the email carries the aggregate-view source stamps, the bare `threadId`
  otherwise. `threadKeyFor()` / `threadIdFromKey()` in `lib/thread-utils.ts`.

Everything that identifies a thread on the client keys by `threadKey`: grouping,
`expandedThreadIds`, `threadEmailsCache`, `isLoadingThread`, `threadEmailCounts`,
the virtualizer's `getItemKey`, and the cache invalidation that runs on refresh
and delta sync. `fetchThreadEmailCounts` groups the ids by source account and
asks each account's own client, instead of asking one client about ids that mean
something different to it.

Single-account views carry no source stamps, so their key is the bare id and
nothing about them changes.

Upstream: issue #1012, PR #1013.

## Tinting rows by account

**Settings → Layout → Tint List Rows by Account Color** (off by default). In the
unified view each row takes its account's colour as a background and the small
per-account dot is dropped, since the row already carries that information.

- It only applies in the unified view. Outside it every row would share one
  colour, which is noise rather than information.
- It outranks the tag tint; tags keep their own colour on their chips.
- Row tints are Tailwind class pairs (light + dark), not raw colours, so an
  account's `avatarColor` hex is mapped onto the shared tag palette by
  `accountTintKey()` (`lib/account-utils.ts`). This keeps account tints in the
  same visual language as tag tints and gets dark mode for free.
- The mapping picks the palette's `-dark` variants. A tag tint can afford to be
  faint because the tag also shows a chip; an account tint replaces the dot and
  has to carry that information alone, and the fainter variants are close to
  invisible against the row background.
- The palette has no violet, so the two purple-ish avatar hues would collide:
  purple keeps `purple-dark`, violet falls back to the plain `purple`.

Resolving the account is layered, because `accountId` is a display-only
reference that only maps to a local account for personal entries — shared
entries carry the JMAP owner id, which no `AccountEntry` matches. The tint falls
back to the reaching client (`sourceClientAccountId`) and then to a colour
derived from the account label, so a row that knows which account it came from
is never left blank.

Account colours themselves are still assigned automatically by hashing the
address (`generateAvatarColor`); there is no UI to choose them.
