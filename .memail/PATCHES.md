# Downstream patch inventory

Base: Bulwark Webmail, https://github.com/bulwarkmail/webmail.

| Change | Location | Upstream impact | Verification |
| --- | --- | --- | --- |
| Fork maintenance guide and update helper | `.memail/` | Additive; no application or upstream workflow edits | Node syntax check; local Git merge/guard regression test |
| Memail branding and mock-mail development launcher | `.memail/demo.mjs`, `.memail/production.env.example`, `public/branding/memail/` | Existing branding environment hooks only; no application patch | Launcher syntax check, upstream config/identity tests, typecheck, lint, production build |
| Memail visual system and built-in picker entry | `.memail/theme/`, `.memail/package-theme.mjs`, `lib/builtin-themes.ts` | Native Theme API v2; one additive built-in registry entry, no theme-loader or component layout patch | Package validator and light/dark contrast tests in `.memail/theme.test.ts` |
| Read-only focus inbox plugin | `.memail/plugins/focus-inbox/`, `.memail/package-focus-plugin.mjs` | Native tabs/commands plugin APIs; no core application patch | Built ZIP validation, membership/lifecycle tests, native tab/store regressions |
| Focus presets and account targeting | `.memail/plugins/focus-inbox/` | Plugin settings/lifecycle hooks and account identity lookup only | Preset membership, account switch races, stale-state cleanup and package tests |
| Demo header and size query compatibility | `lib/demo/demo-client.ts` | Small isolated fix: mock queries previously ignored newsletter header/size conditions | Header/value/size boundary tests, pagination/counts, and real demo Focus queries |
| Fork discovery banner | `README.md` | Three additive lines above the upstream README | Diff review |

No authentication, mail rendering, synchronization, dependencies or license text has been changed. Memail identity is supplied through upstream configuration; its demo launcher uses synthetic mail and an absolute configured loopback endpoint for server-side session verification.

Add each customization here. Include the relevant upstream files, the reason it cannot use configuration/theme/plugin hooks, and the checks required after upstream updates. Remove entries when upstream absorbs the change.
