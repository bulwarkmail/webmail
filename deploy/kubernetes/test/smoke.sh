#!/usr/bin/env bash
# Smoke test for a running deployment of deploy/kubernetes:
#   - Valkey and every Bulwark replica become ready, on the shared store;
#   - an admin session made on one replica is valid on every other one;
#   - a config change saved on one replica reaches the others within 5 s;
#   - deleting a pod and a rolling restart don't fail requests through the
#     Service, and the admin session survives the new pods.
#
# Usage: ADMIN_PASSWORD=... deploy/kubernetes/test/smoke.sh [namespace]
# With READ_ONLY_CONFIG=1 (overlays/config-in-git) it checks that config saves
# are refused instead of spread.
# Uses the current kubectl context. The password goes to curl on stdin, never
# on a command line.
set -euo pipefail

NS="${1:-bulwark}"
: "${ADMIN_PASSWORD:?set ADMIN_PASSWORD to the admin password of the deployment}"
k() { kubectl -n "$NS" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
step() { echo "== $*"; }

step "rollout"
k rollout status statefulset/valkey --timeout=300s
k rollout status deployment/bulwark --timeout=600s

step "curl pod"
if ! k get pod smoke-curl >/dev/null 2>&1; then
  k run smoke-curl --image=curlimages/curl:8.11.1 --restart=Never --labels=app.kubernetes.io/name=smoke-curl \
    --command -- sleep 1800 >/dev/null
fi
k wait pod/smoke-curl --for=condition=Ready --timeout=180s >/dev/null
c() { k exec -i smoke-curl -- curl -sS --max-time 10 "$@"; }
status() { k exec smoke-curl -- curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" || echo 000; }

pod_ips() { k get pods -l app.kubernetes.io/name=bulwark --field-selector=status.phase=Running -o jsonpath='{.items[*].status.podIP}'; }
read -r -a IPS <<<"$(pod_ips)"
[ "${#IPS[@]}" -ge 2 ] || fail "need at least 2 replicas, found ${#IPS[@]}"
echo "replicas: ${IPS[*]}"

step "every replica is ready on the shared store"
for ip in "${IPS[@]}"; do
  out="$(c "http://$ip:3000/api/ready")"
  echo "$ip $out"
  grep -q '"ready":true' <<<"$out" || fail "$ip not ready"
  grep -q '"store":"redis"' <<<"$out" || fail "$ip not on the shared store"
done

step "an admin session made on one replica works on every replica"
json_string() {
  local s="${1//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '"%s"' "$s"
}
code="$(printf '{"password":%s}' "$(json_string "$ADMIN_PASSWORD")" \
  | c -o /dev/null -w '%{http_code}' -c /tmp/jar -H 'Content-Type: application/json' --data-binary @- \
      "http://${IPS[0]}:3000/api/admin/auth")"
[ "$code" = 200 ] || fail "admin sign-in on ${IPS[0]} answered $code"
# curl's jar keeps cookies per host and every pod has its own address, so the
# cookie goes in a header. It stays in the curl pod, off every command line.
k exec smoke-curl -- sh -c "awk '{ sub(/^#HttpOnly_/, \"\") } !/^#/ && NF >= 7 { printf \"%s=%s; \", \$6, \$7 }' /tmp/jar > /tmp/cookie"
ca() { k exec -i smoke-curl -- sh -c 'curl -sS --max-time 10 -H "Cookie: $(cat /tmp/cookie)" "$@"' sh "$@"; }
for ip in "${IPS[@]}"; do
  ca "http://$ip:3000/api/admin/auth" </dev/null | grep -q '"authenticated":true' || fail "admin session not valid on $ip"
done

if [ "${READ_ONLY_CONFIG:-}" = 1 ]; then
  step "with config from files, every replica refuses a config save (409)"
  for ip in "${IPS[@]}"; do
    code="$(ca -o /dev/null -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' \
      --data '{"appName":"not-saved"}' "http://$ip:3000/api/admin/config" </dev/null)"
    [ "$code" = 409 ] || fail "$ip answered $code to a save into read-only config"
  done
else
step "a config change on one replica reaches the others"
name="smoke-$(date +%s)"
code="$(ca -o /dev/null -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' \
  --data "{\"appName\":\"$name\"}" "http://${IPS[0]}:3000/api/admin/config" </dev/null)"
[ "$code" = 200 ] || fail "config save answered $code"
for ip in "${IPS[@]:1}"; do
  ok=""
  for _ in $(seq 1 25); do
    if c "http://$ip:3000/api/config" </dev/null | grep -q "\"appName\":\"$name\""; then ok=1; break; fi
    sleep 0.2
  done
  [ -n "$ok" ] || fail "$ip didn't see the change within 5 s"
done
ca -o /dev/null -X DELETE -H 'Content-Type: application/json' --data '{"key":"appName"}' \
  "http://${IPS[0]}:3000/api/admin/config" </dev/null
fi

SVC="http://bulwark.$NS.svc/api/ready"
probe_while() {
  # Ask the Service once a second while "$@" runs; count failed answers.
  local failures=0 total=0
  "$@" &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    total=$((total + 1))
    [ "$(status "$SVC")" = 200 ] || failures=$((failures + 1))
    sleep 1
  done
  wait "$pid"
  echo "requests: $total, failed: $failures"
  [ "$failures" -eq 0 ] || fail "$failures requests failed"
}

step "deleting a pod keeps the Service answering"
victim="$(k get pods -l app.kubernetes.io/name=bulwark -o jsonpath='{.items[0].metadata.name}')"
probe_while k delete pod "$victim" --wait=true
k rollout status deployment/bulwark --timeout=300s

step "a rolling restart keeps the Service answering"
k rollout restart deployment/bulwark
probe_while k rollout status deployment/bulwark --timeout=600s

step "the admin session survives the new pods"
ca "http://bulwark.$NS.svc/api/admin/auth" </dev/null | grep -q '"authenticated":true' || fail "admin session lost"

k delete pod smoke-curl --wait=false >/dev/null
echo "OK"
