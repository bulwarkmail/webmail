# Deploying and upgrading Memail

Memail is a full client deployment based on Bulwark. The complete UI is not a plugin for an unchanged Bulwark installation. Stalwart remains the mail server and stores mail/accounts separately.

## Fresh install

Build a reviewed tag as shown in the README, then use [the Compose example](../deploy/memail/compose.yml). It binds to loopback and persists all `/app/data` directories. Configure HTTPS for public use, then connect Stalwart through the setup wizard. Keep secrets out of Git.

Do not use `.env.dev.example`, `DEV_MOCK_JMAP=true` or `.memail/demo.mjs` in production. The [branding overlay](../.memail/production.env.example) is an example, not a complete configuration. Stored branding can override defaults.

## Upgrade an existing installation

1. Record the image digest, Compose, environment, mounts and source revision. Back up every webmail data directory, including settings, admin, admin-state and plugin-secrets. Keep the mail server's backup policy in place.
2. Build/pull an exact reviewed release. Verify its source and published checksum/digest.
3. Start a loopback-only canary with **copies** of webmail data. Check readiness, JMAP configuration, authentication/branding policy and storage permissions. Do not mount production settings writable in a canary.
4. Stop only webmail briefly and take a final data copy. Change its image/source revision, retain volumes/environment, and recreate only that service without dependencies.
5. Verify readiness, public login, build/source, volume identity and unchanged settings. Use a designated test account for authenticated read/compose/draft/send acceptance.

Never run `docker compose down -v`, delete Stalwart storage or restore old data over newer user writes during an image update.

## Rollback

Retain the previous image and compatible Compose. Switch only the image while keeping current data volumes, including newly persistent credential directories. Check readiness/configuration again. Schema-changing upstream updates require their own migration review.

## Versions

Memail `0.2.0-preview.1` retains Bulwark `1.19.1` for protocol/marketplace compatibility. About shows both when product metadata is present. The inherited upstream update indicator is not a Memail auto-updater; follow Memail releases for downstream images.

Capabilities depend on server, permissions and policy. Stalwart is the primary target. [Upstream docs](https://bulwarkmail.org/docs) remain useful for shared configuration, although Memail's interface differs.
