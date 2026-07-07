# Stalwart Mail Server with a declarative bootstrap for webmail integration
# testing.
#
# Extends the official image with stalwart-cli and an entrypoint that, on first
# container start, applies the bootstrap + account plans against the freshly
# started server. On subsequent starts the `.bootstrap-applied` marker short-
# circuits both phases and Stalwart boots straight into normal mode.
#
# NOTE: stalwart-cli is COPYed in rather than downloaded during the build. The
# binary is fetched by ./prepare-stalwart-cli.sh (run for you by the Playwright
# global-setup / integration runner). This keeps the build offline-friendly and
# avoids the base image's apt sources, which are unreachable in sandboxed CI.

FROM stalwartlabs/stalwart:v0.16

USER root

# Host-prefetched stalwart-cli matching the build architecture.
COPY stalwart-cli /usr/local/bin/stalwart-cli

RUN mkdir -p /etc/stalwart-bootstrap
COPY plan-bootstrap.ndjson /etc/stalwart-bootstrap/plan-bootstrap.ndjson
COPY plan-accounts.ndjson.tpl /etc/stalwart-bootstrap/plan-accounts.ndjson.tpl
COPY entrypoint.sh /usr/local/bin/stalwart-bootstrap-entrypoint.sh
RUN chmod +x /usr/local/bin/stalwart-cli /usr/local/bin/stalwart-bootstrap-entrypoint.sh

USER stalwart

ENTRYPOINT ["/usr/local/bin/stalwart-bootstrap-entrypoint.sh"]
