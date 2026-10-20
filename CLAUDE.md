# xenaxio webmail (fork of Bulwark Mail)

This is the public AGPL client of xenaxio. Project status, rules and next
steps live in the platform repository's `docs/progress.md` (es-ua/xenaxio);
read it first if you have access.

- xenaxio code lives in `lib/xenaxio/`, `components/xenaxio/` and the
  `app/(main)/[locale]/{login,onboarding,workspace,operator}` pages; keep
  changes to upstream files minimal so upstream merges stay easy.
- The client talks only to the platform API under `/api` (no direct
  connection to the mail server); never import platform code here.
- User-facing strings: German and English in `lib/xenaxio/messages-*.json`.
- Work in a `step-N-…` branch and open a pull request into `main`.
