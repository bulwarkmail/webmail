## What and why

<!-- What changes for the user, and why. A few sentences are enough. -->

## Related issues

<!-- "Fixes #123". For a change that needed agreement first, link the issue where the approach was agreed. -->

## Checklist

- [ ] The change fits [What fits in Bulwark](https://bulwarkmail.org/docs/development/contributing#what-fits-in-bulwark) (core, not plugin material)
- [ ] It needed no issue first, or the approach was agreed in the linked issue (over ~500 lines excluding locales and tests, a new runtime dependency, or security-sensitive code: [details](https://bulwarkmail.org/docs/development/contributing#before-you-write-code))
- [ ] `npm run typecheck && npm run lint && npx vitest run` pass, and new logic has tests
- [ ] New user-facing text goes through translations
- [ ] Works in Bulwark Lite, or is hidden there
- [ ] UI changes checked at phone width and in the light and dark theme
- [ ] Documentation updated in the [website repository](https://github.com/bulwarkmail/website/tree/main/docs), or not needed

## Screenshots

<!-- For UI changes: desktop and phone width. -->
