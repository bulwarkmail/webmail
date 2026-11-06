# Greek translation

Greek uses the locale code `el` and the language picker label `Ελληνικά`.
The catalog covers all 6,685 keys in the English source at the time of this
contribution: mail, settings, setup, contacts, calendar, files, plugins,
offline features and desktop screens.

The initial mail workflow translation was written directly in Greek. The
remaining strings received a machine-assisted first translation, followed by
terminology corrections, review of plural messages and destructive-action
warnings, and ICU/HTML validation. Further native-speaker copy editing is
welcome; structural completeness does not guarantee perfect wording in every
screen.

Protocol names, product names, native language names, standard mail headers,
sample addresses, units, keyboard keys and strings containing only variable
values intentionally retain their original spelling.

Use polite plural address. Prefer `μήνυμα` for an email message, `Νέο μήνυμα`
for the Compose action, `Ανεπιθύμητα` for Spam/Junk, `Κάδος` for Trash,
`κλειδί πρόσβασης` for a passkey, and `πρόσθετο` for a plugin. A certificate's
subject is its holder (`Κάτοχος πιστοποιητικού`), not an email's `Θέμα`.
Keep protocol names and standard reply/forward prefixes where appropriate.

Before submitting further translations, run:

```sh
npm run test:translations
npx vitest run lib/__tests__/greek-translations.test.ts components/providers/__tests__/intl-provider-locales.test.ts
npm run typecheck
npm run lint
```

Also check Greek text in the browser at desktop and phone widths. Automated
checks cover catalog structure, ICU arguments, literal template tokens and
HTML tags, not translation quality or every possible text overflow.
