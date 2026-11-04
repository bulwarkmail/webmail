# Contributing to Memail

Memail is Saivra's downstream fork of Bulwark. Workflow, accessibility, composition, localization and JMAP compatibility contributions are welcome.

## Development

```sh
git clone https://github.com/Saivra/memail-webmail.git
cd memail-webmail
npm ci
node .memail/demo.mjs
```

Use Node 22 or a compatible newer version. The loopback demo uses synthetic data. Never commit credentials, environment files, personal mail or server backups. Read [.memail/DEVELOPMENT.md](.memail/DEVELOPMENT.md) and [.memail/UPSTREAM.md](.memail/UPSTREAM.md).

## Pull requests

Discuss large behavior changes, dependencies, authentication, sanitization, outgoing-request guards or plugin sandbox changes first. Keep PRs focused; explain the user-visible problem, result and verification. Include phone/keyboard checks for UI work. Use Heroicons through the existing adapter and preserve custom/plugin identifiers.

```sh
npm run typecheck
npm run lint
npx vitest run --pool=forks --maxWorkers=2 --testTimeout=15000
npm run build
```

Mail changes also need real Stalwart checks in a disposable environment following [integration/README.md](integration/README.md). Do not use production mailboxes for destructive tests. Record known failures rather than treating a build as mail acceptance.

Preserve upstream ancestry with merge commits. Retain LICENSE, NOTICE, attribution, account/policy boundaries and supported plugins. Do not include paid block source or enable AI providers in unrelated UI work. Contributions use [LICENSE](LICENSE). Report vulnerabilities through [SECURITY.md](SECURITY.md).
