# Validation status

## Phase 1 focus-inbox preview

- Packaged ZIP: out/memail-focus-inbox.zip (generated, not tracked).
- 47 targeted Vitest tests passed, covering plugin behavior, upstream tab/refresh contracts and Memail theme checks.
- The actual compiled ZIP passed the upstream plugin package validator without warnings.
- Typecheck passed; downstream ESLint passed.
- The application production build passed during branding validation. No application source or runtime dependency changed in the plugin preview.
- The inherited full-suite local run begun on 2 November 2026 did not produce a summary within more than 25 minutes and was stopped. It is inconclusive, not a pass or a confirmed test failure. Baseline investigation remains open.
- Browser plugin installation, live Stalwart integration, cross-device preferences, accessibility acceptance and performance budgets remain unverified.

The preview is in draft PR #3. Phase 0 and full phase 1 acceptance are not complete. The next milestone is an installed-plugin smoke on a disposable full-edition Stalwart deployment, followed by account-scoped custom rules.

## Focus rules polish (0.2.0)

- Focus mode presets, optional sign-in-name account targeting, dynamic labels, stale-account protection and visible settings errors are implemented.
- 56 targeted tests passed across the plugin, host tab/refresh contracts and theme. Typecheck and downstream lint passed.
- The updated package adds account:read permission for optional identity matching; it adds no mail-body, send, mutation or network access.
- Real Stalwart and browser installation acceptance remain outstanding; the Docker engine is not running in this environment.
