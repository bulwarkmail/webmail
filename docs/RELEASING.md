# Memail release policy

Product metadata lives in `.memail/release.json` and package metadata. `VERSION` retains the upstream compatibility version. Tags use `v<product-version>`, such as `v0.2.0-preview.1`.

Preview releases use GitHub's pre-release flag. Stable releases require real Stalwart mail acceptance, account/recovery checks, rich-content round trips, desktop/phone accessibility review and an upstream merge rehearsal.

## Prepare

- Update product metadata and CHANGELOG, retain LICENSE/NOTICE, and record known limits.
- Run relevant tests, lint, type checks, production builds and disposable Stalwart integration. Report actual results and inherited failures.
- Review account/policy/plugin boundaries, backups, rollback and migrations.
- Use synthetic screenshots. Never publish private mail, secrets, backups or commercial block source.
- Merge with a merge commit and tag the exact main revision. Never move a published tag.

## Publish

Release notes include highlights, compatibility, upgrades and limitations. GitHub provides source archives. Optional theme/Focus ZIPs are partial extensions, not the full UI. Publish SHA-256 checksums and identify the source revision.

The Memail container workflow publishes images separately. Advertise a platform/tag only after it succeeds and its digest is recorded. Preview builds do not move stable `latest`. Inherited upstream publishing/deployment workflows remain restricted to upstream ownership.

A source release does not deploy a server. Keep a private deployment record with image/source, backup path, readiness/config/storage checks and rollback. Do not put credentials or backups in public assets.
