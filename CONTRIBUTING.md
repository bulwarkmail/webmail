# Contributing to Bulwark Webmail

Bug reports, feature requests, translations and patches are all welcome.

The full guide is in the documentation under [Contributing](https://bulwarkmail.org/docs/development/contributing). It covers the development setup, the test suites, translations and right-to-left layouts, code style, and how pull requests are reviewed.

To get a development server running:

```bash
git clone https://github.com/bulwarkmail/webmail.git
cd webmail
npm install
cp .env.dev.example .env.local   # built-in mock JMAP server, no mail server needed
npm run dev
```

Before you open a pull request, run `npm run typecheck && npm run lint && npx vitest run`. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` and so on).

You can use AI tools for your contributions. The guide's [AI-assisted contributions](https://bulwarkmail.org/docs/development/contributing#ai-assisted-contributions) section explains what we expect.

By contributing, you agree that your contributions are licensed under the terms in [LICENSE](LICENSE): AGPL-3.0-only, with the additional permission for app store distribution. The permission is still provisional for older code, but it applies in full to contributions made since 30 September 2026.

- Questions: ask on [Discord](https://discord.gg/tYCujymGrT).
- Documentation fixes: the docs are Markdown files in the [website repository](https://github.com/bulwarkmail/website/tree/main/docs).
- Security vulnerabilities: report them privately to [dev@bulwarkmail.org](mailto:dev@bulwarkmail.org) or through a [security advisory](https://github.com/bulwarkmail/webmail/security/advisories/new), never in a public issue.
