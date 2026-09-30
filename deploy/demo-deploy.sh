#!/usr/bin/env bash
# Deploys the demo at https://demo.bulwarkmail.org on mail.rath.li.
#
# The demo is a single container off the published release image, so there is
# nothing to build here: this pulls a tag from GHCR and recreates the
# container. Installed as /usr/local/bin/bulwark-demo-deploy and run as the
# `ubuntu` user through a forced command on the deploy key in
# ~ubuntu/.ssh/authorized_keys:
#
#   command="/usr/local/bin/bulwark-demo-deploy",restrict ssh-ed25519 AAAA... demo deploy
#
# so the key can do nothing but this. Re-install it by hand when this file
# changes. The requested action comes in SSH_ORIGINAL_COMMAND:
#
#   deploy [tag]   pull ghcr.io/bulwarkmail/webmail:<tag> (default latest),
#                  recreate the container, check it, roll back on failure
#   rollback       go back to the image the last deploy replaced
#   status         print the running image, its version and health
#
# Replaces Watchtower for this container: the webmail repo deploys here after
# it publishes a release image (.github/workflows/deploy-demo.yml). The two
# rbm.systems containers are still on Watchtower's watch list.
set -euo pipefail

IMAGE=ghcr.io/bulwarkmail/webmail
NAME=bulwark-demo
PORT=3002
DATA=/opt/bulwark-demo-data
# The image this deploy replaced. Containers always run an image id; this tag
# exists only so pruning cannot collect the image we may need to go back to.
PREVIOUS=bulwark-demo:previous
STATE=/opt/bulwark-demo-deploy

log() { echo "[demo-deploy] $*"; }

docker_() { sudo -n docker "$@"; }

image_id() { docker_ image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

running_image_id() { docker_ inspect -f '{{.Image}}' "$NAME" 2>/dev/null || true; }

version_of() { docker_ image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true; }

# Recreate the container from $1. Mirrors the original `docker run`: demo mode,
# host port 3002, and the three bind mounts that keep the demo past the setup
# wizard (admin/config.json holds setupComplete).
run_container() {
  docker_ rm -f "$NAME" >/dev/null 2>&1 || true
  docker_ run -d \
    --name "$NAME" \
    --restart unless-stopped \
    -p "${PORT}:3000" \
    -e DEMO_MODE=true \
    -v "$DATA/admin:/app/data/admin" \
    -v "$DATA/settings:/app/data/settings" \
    -v "$DATA/telemetry:/app/data/telemetry" \
    "$1" >/dev/null
}

healthy() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null "http://127.0.0.1:${PORT}/api/health"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

cmd=${SSH_ORIGINAL_COMMAND:-${1:-}}
mkdir -p "$STATE"
exec 9>"$STATE/.deploy.lock"
flock -n 9 || { log "another deploy is running"; exit 1; }

case "$cmd" in
  deploy|deploy\ *)
    tag=${cmd#deploy}
    tag=${tag# }
    tag=${tag:-latest}
    [[ "$tag" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || { log "bad tag: $tag"; exit 2; }

    log "pulling $IMAGE:$tag"
    docker_ pull -q "$IMAGE:$tag" >/dev/null

    new=$(image_id "$IMAGE:$tag")
    [[ -n "$new" ]] || { log "no such image after pull"; exit 3; }
    old=$(running_image_id)

    if [[ "$new" == "$old" ]] && healthy; then
      log "already on $(version_of "$new") ($tag), nothing to do"
      exit 0
    fi

    [[ -n "$old" ]] && docker_ tag "$old" "$PREVIOUS"
    run_container "$IMAGE:$tag"
    if healthy; then
      log "live: $(version_of "$new") ($tag)"
    else
      log "health check failed"
      if [[ -n "$old" ]]; then
        run_container "$old"
        healthy && log "back on $(version_of "$old")" || log "rollback is not answering either"
      fi
      exit 4
    fi

    # Only untagged leftovers; $PREVIOUS stays because it is tagged.
    docker_ image prune -f >/dev/null || true
    ;;

  rollback)
    prev=$(image_id "$PREVIOUS")
    [[ -n "$prev" ]] || { log "no earlier image to roll back to"; exit 5; }
    cur=$(running_image_id)
    run_container "$prev"
    # Point $PREVIOUS at what we just left, so a second rollback comes back.
    [[ -n "$cur" ]] && docker_ tag "$cur" "$PREVIOUS"
    healthy && log "rolled back to $(version_of "$prev")" || { log "rolled back, but the health check failed"; exit 4; }
    ;;

  status)
    cur=$(running_image_id)
    if [[ -n "$cur" ]]; then
      echo "running: $(version_of "$cur") ($(docker_ inspect -f '{{.Config.Image}}' "$NAME")) ${cur:7:12}"
      echo "state:   $(docker_ inspect -f '{{.State.Status}}' "$NAME")"
    else
      echo "running: none"
    fi
    prev=$(image_id "$PREVIOUS")
    [[ -n "$prev" ]] && echo "previous: $(version_of "$prev") ${prev:7:12}" || echo "previous: none"
    curl -fsS -o /dev/null -w "health:   %{http_code}\n" "http://127.0.0.1:${PORT}/api/health" || true
    ;;

  *)
    echo "usage: deploy [tag] | rollback | status" >&2
    exit 2
    ;;
esac
