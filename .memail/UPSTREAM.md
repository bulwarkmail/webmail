# Maintaining the Memail fork

Memail is a downstream fork of https://github.com/bulwarkmail/webmail. Keep upstream ancestry and its license/NOTICE intact. The original research is at https://github.com/Saivra/memail-research.

## Branches and remotes

- `origin`: https://github.com/Saivra/memail.git — our product repository.
- `upstream`: https://github.com/bulwarkmail/webmail.git — fetch updates here; never push here as part of synchronization.
- `main`: Bulwark plus reviewed Memail changes. Avoid force-pushes and published-history rebases.
- `memail/<feature>`: one focused customization per branch/PR.
- `sync/bulwark-<commit>`: merge the upstream commit into our main, then review the resulting PR.

Use merge commits for upstream sync PRs. Do not squash or rebase them: a merge records which Bulwark commits we have incorporated and makes later merges reliable. The repository permits merge commits and disables squash/rebase merging to enforce this policy for all PRs.

Initial local setup:

```sh
git remote add upstream https://github.com/bulwarkmail/webmail.git
git remote set-url --push upstream DISABLED
git fetch upstream --tags
git config pull.ff only
git config fetch.prune true
```

If `upstream` already exists, inspect it rather than adding it again. Fresh clones already have origin. A shallow checkout should fetch full history with `git fetch --unshallow upstream` once.

## Prepare an update

Run from a clean checkout on any branch; the helper starts a new sync branch from fetched origin/main. It never force-pushes, resets files, edits conflicts, or merges directly into main.

```sh
node .memail/sync-upstream.mjs --ref main
# Or prefer a reviewed release tag:
node .memail/sync-upstream.mjs --ref vX.Y.Z
```

Read upstream release notes and security advisories. Prefer tagged releases for production; main is useful for evaluating unreleased fixes. The exact fetched commit is recorded in the merge and PR.

To prepare, push the branch, and open a draft PR in one invocation:

```sh
node .memail/sync-upstream.mjs --ref vX.Y.Z --publish
```

If a conflict occurs, Git leaves the sync branch and conflict markers in place. Resolve files, run `git add <resolved-files>` and `git commit`, then push the branch and open a draft PR with `gh pr create --repo Saivra/memail --base main --draft`. `git merge --abort` returns to the branch's pre-merge state. Do not silently prefer ours/theirs across the whole tree.

If the helper reports an existing local sync branch, inspect that branch and its PR; do not delete it blindly or rerun with a force option. Updates are manual. No scheduled synchronization, automatic merge, or automatic upstream contribution is configured.

## Review and validation

1. Review changed workflows, dependency/install scripts, licensing, authentication, sanitizer, plugin sandbox, network guards and configuration before executing new upstream code.
2. Follow upstream CONTRIBUTING.md. Use Node 22 as the current CI baseline and `npm ci` with the committed lockfile.
3. Run `npm run typecheck`, `npm run lint`, and `npx vitest run --pool=forks --maxWorkers=2 --testTimeout=15000`.
4. Build the full application with `npm run build`. If we ship Lite, also run `npm run build:lite` and its smoke tests.
5. Run the dockerized Stalwart integration suite following integration/README.md; verify login, read/compose/send, attachments, folder actions and push/reconnect. Upstream's integration workflow runs on PRs labeled `integration`.
6. Check Memail behavior and upstream regression fixtures; record commands/results in the PR. A passing build alone does not validate mail correctness.
7. Merge the sync PR using a merge commit only after the relevant checks pass. Verify our deployed version separately; merging source does not deploy it.

GitHub Actions permissions are enabled at repository level; individual inherited workflows may still be disabled on a new fork. Enable CI intentionally in the repository's Actions tab. Review inherited publishing, scheduled and deployment workflows before enabling them; no upstream credentials should be copied. Configure branch protection/check requirements once CI names and repository policies are verified. This setup has not explicitly enabled workflows, changed protection policies, configured secrets, or deployed the application.

## Keep the downstream patch small

Prefer supported branding/environment configuration, themes and plugins. Keep Memail-only documentation and maintenance tools in `.memail/`. Keep product-specific modules together when adding features; avoid broad formatting, file moves, dependency upgrades or framework migrations mixed into UI work.

Use small adapters at existing boundaries instead of rewriting JMAP, offline synchronization, HTML rendering or authentication. A custom React UI may still need core edits: document those in PATCHES.md with upstream files touched, why extension points were insufficient, and the regression checks.

When a fix is broadly useful, prepare it as a separate upstream-friendly commit. Follow Bulwark's contribution process before larger/security-sensitive changes. Do not send an upstream PR or contact maintainers without an explicit request.

## Licensing and assets

Preserve LICENSE, NOTICE and existing attribution. Bulwark is AGPL-3.0-only with additional app-store permission terms; Memail does not relicense it as MIT. Review any future upstream license changes.

Use free MIT ReUI components for public source with required notices. The standard ReUI Pro license does not permit publishing premium block source. Do not copy the old local Vite/ReUI Pro experiment into this fork unless a separately negotiated, compatible redistribution agreement covers it.
