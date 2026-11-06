# Greek translation (in progress)

Greek uses the locale code `el` and the language picker label `Ελληνικά`.

This is an initial translation of the mail workflow, not a complete Greek
catalog. It contains 1,491 strings changed from English, out of 6,685 keys at
the time of this contribution. Language names, protocol headers, example
addresses and other technical tokens can intentionally match English.

Covered areas include sign-in and session messages, navigation, message lists,
the message reader (including invitations), the composer, attachments,
notifications, folder actions, conversations and keyboard shortcuts. The
settings navigation and basic appearance controls are also translated.

Most settings, the standalone calendar, contacts, files, plugins, offline
features and desktop-specific screens still contain English. Untranslated
entries retain the English source text so the catalog stays structurally
complete. Future translations should replace those values without changing
keys or ICU arguments.

Use polite plural address. Prefer `μήνυμα` for an email message, `Νέο μήνυμα`
for the Compose action, `Ανεπιθύμητα` for Spam/Junk, and `Κάδος` for Trash.
Keep `Email`, `Webmail`, protocol names and standard reply/forward prefixes
where appropriate.

Before submitting further translations, run:

```sh
npm run test:translations
npx vitest run lib/__tests__/greek-translations.test.ts components/providers/__tests__/intl-provider-locales.test.ts
npm run typecheck
npm run lint
```

Also check Greek text in the browser at desktop and phone widths. Automated
checks cover catalog structure and ICU arguments, not translation quality or
every possible text overflow.
