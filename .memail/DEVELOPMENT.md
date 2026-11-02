# Memail development

Production foundation: Bulwark Webmail. Customizations are isolated in .memail; the patch inventory tracks the small upstream integration points. See [UPSTREAM.md](UPSTREAM.md) before changing core behavior.

## Run the branded demo

Use Node 22 (the upstream CI baseline) or a compatible newer Node release:

```sh
npm ci
node .memail/demo.mjs
```

Open http://127.0.0.1:3000. The launcher uses Bulwark's built-in mock JMAP server; use any demo username/password. It binds to loopback and overrides the JMAP endpoint for this process so it does not connect to a configured real mailbox. The absolute loopback JMAP URL also lets the server verify and remember the synthetic sign-in. It generates a temporary session secret and leaves your environment files untouched. Restarting invalidates the demo session. This is a development launcher, not a production server.

Changes to upstream sandbox/PST sources require restarting the launcher so those assets rebuild. App code uses Next's normal development reload.

## Production branding

Use production.env.example as a branding overlay for upstream .env.example. Replace the JMAP endpoint and session secret, set SOURCE_CODE_URL to the deployed source revision, and follow upstream's installation/security guidance. This file is not a complete production deployment configuration. The existing Docker build includes public/branding/memail assets without changing the upstream Dockerfile.

The mark SVGs are original Memail assets. No ReUI Pro source is included. Bulwark's LICENSE and NOTICE remain intact; the runtime source link identifies our fork. Existing users' saved settings or per-domain branding can override environment defaults; inspect the admin configuration when an expected brand setting does not appear.

## Next product work

1. Validate the branded demo and current Stalwart behavior.
2. Validate and refine the optional Memail theme in the mail workspace.
3. Improve keyboard triage and split inbox workflows in focused feature PRs, checking what upstream already provides first.
4. Use supported plugin hooks for integrations; document any necessary core patch in PATCHES.md.

## Optional Memail theme

Package the light/dark theme using Bulwark's existing Theme API v2:

```sh
node .memail/package-theme.mjs
```

Memail is included in Settings > Appearance > Themes in this fork; select it there. An administrator can make `builtin-memail` the default using the existing theme policy. Existing theme choices are preserved. The ZIP is also available for administrator deployment through Admin > Themes on a compatible Bulwark installation. Ordinary user settings provide theme selection, not ZIP upload.

The 0.2 theme adds Geist typography (already self-hosted by the app), semantic light/dark status colors, consistent radii and a scoped component skin. The source manifest and skin drive both the built-in entry and ZIP, avoiding duplicate styles. User density, text size and accessibility font choices remain available. Virtualized row geometry, mail content and user tag colors are preserved. The earlier optional 0.1 package used ID `saivra-memail`; switch to the built-in Memail theme to use 0.2.


## Focus inbox plugin

The phase 1 preview adds native All inbox, Focus and Newsletters views without mail mutations. Build it with `node .memail/package-focus-plugin.mjs`, then follow the [plugin installation and semantics](plugins/focus-inbox/README.md). It is an optional full-edition plugin, not enabled by the branding launcher.
