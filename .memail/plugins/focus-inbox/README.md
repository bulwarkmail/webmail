# Memail Focus Inbox - phase 1 preview

A sandboxed Bulwark plugin contributing native Inbox tabs. It does not replace the message list or change the mail engine.

## Views

- **All inbox** includes every message in the current Inbox, including read mail and newsletters. It is not All mail across every folder.
- **Focus** includes starred messages and unread messages without a List-Unsubscribe header.
- **Newsletters** includes messages with a List-Unsubscribe header. This is a header-based heuristic, not a guarantee that a message is a newsletter. A starred newsletter appears in both Focus and Newsletters.

Tab badges are unread counts, not message totals. Reading an unstarred message can remove it from Focus; this view is not a persistent task list. Use Star if it should remain there. The host scopes queries to the current mailbox and evaluates them server-side, including subsequent pages. The tabs are hidden in search, tag and unified views, as required by Bulwark's current native tab contract.

No message is moved, relabeled, marked read or sent by this plugin. It requests only `ui:message-list-tabs` and `ui:commands`, with no mail-body, email-write, send, HTTP or credential permissions.

## Package and install

From the client repository root, after `npm ci`:

```sh
node .memail/package-focus-plugin.mjs
```

Upload `out/memail-focus-inbox.zip` using Bulwark's existing plugin upload UI. The full edition, Bulwark 1.19.1 or later, and an administrator's plugin policy/approval are required. Lite does not run plugins. Enable the plugin, then open a normal Inbox folder. No production policy is changed by packaging.

The host settings UI exposes Show focus tabs, Show Newsletters view and Show unread counts. Settings and labels use the host UI; English is the initial locale, with fallback for other languages. Custom translations and account-specific rules are subsequent work.

The command palette includes Hide Memail focus tabs / Show Memail focus tabs. Hiding pauses this plugin for its current activation; reloading or changing its settings restores the configured default. Standard native tab keyboard and phone behavior comes from Bulwark.

## Other category plugins

Use one category-tab provider at a time. Bulwark merges tab providers, and a universal All query would empty another provider's default/complement bucket. Memail refuses activation when another provider is present. If another provider registers later, Memail clears only its own tabs and warns the user. The other provider is left intact.

## Development

```sh
node .memail/package-focus-plugin.mjs --dev
```

This additionally writes the built manifest/bundle under ignored `local-data/memail-plugins/focus-inbox`. Set `PLUGIN_DEV_DIR` to the absolute path of `local-data/memail-plugins` in your development environment, restart the demo, then enable the plugin through Settings. The existing admin plugin policy still applies. The ZIP build has no new dependencies or external runtime imports.

After changing the plugin, rebuild and refresh/reinstall it. Do not copy generated ZIPs into the tracked source.

## Checks

The targeted checks include the actual built ZIP through the upstream package validator, the real native tab store, independent query-membership fixtures, settings/locale updates, command toggling, activation failures and competing category providers. Run:

```sh
npx vitest run .memail/focus-plugin.test.ts lib/__tests__/message-list-tabs-store.test.ts stores/__tests__/email-store-refresh-category-tab.test.ts components/email/__tests__/message-list-tabs.test.tsx --pool=forks --maxWorkers=2 --testTimeout=15000
```

The package test rebuilds the ZIP automatically, so a clean checkout does not need a pre-existing out directory. Browser installation, live Stalwart behavior, performance budgets and cross-device preference synchronization still require acceptance testing. None is implied by unit/contract tests.

## Next slice

Validate installation in a disposable full-edition Stalwart deployment. Then add user-defined, account-scoped rules and saved-view export/import through plugin settings, keeping the query semantics explicit. Durable reminders remain a separate server-side phase.
