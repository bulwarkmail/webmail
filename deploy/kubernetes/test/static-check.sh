#!/usr/bin/env bash
# Static checks of deploy/kubernetes. Needs no cluster: it reads the manifests
# and runs the containers' start commands with stand-ins for the servers.
#
#  1. With an empty VALKEY_PASSWORD the store does not start; with one set it
#     does, and the password is not on the server's command line.
#  2. A NetworkPolicy that is part of the deployment selects the store's pods
#     and lets only the webmail's pods reach port 6379.
#  3. No workload mounts a service account token.
#  4. With an empty SESSION_SECRET the webmail does not start; with one set it
#     does.
#
#   bash deploy/kubernetes/test/static-check.sh [path to deploy/kubernetes]
set -u
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0
say() { printf '%s\n' "$1"; }

# Every manifest of the deployment: the files a kustomization.yaml under the
# folder lists as resources. Patches and examples define nothing by themselves
# and are not looked at.
manifests() {
  find "$DIR" -type f -name kustomization.yaml ! -path '*/test/*' | sort | while IFS= read -r k; do
    awk -v dir="$(dirname "$k")" '
      { sub(/\r$/, "") }
      /^resources:/ { on = 1; next }
      /^[^ \t#-]/ { on = 0 }
      on && /^[ \t]*-[ \t]*[^ \t]+\.ya?ml[ \t]*$/ { sub(/^[ \t]*-[ \t]*/, ""); sub(/[ \t]*$/, ""); print dir "/" $0 }
    ' "$k"
  done | sort -u
}

# Prints the file of each YAML document (split at "---") whose kind matches the
# pattern $1 and in which the fixed strings $2 (must all occur, separated by
# "|") and $3 (must not occur) decide. Comment lines do not count.
docs() {
  manifests | while IFS= read -r f; do
    awk -v kinds="$1" -v need="$2" -v forbid="$3" -v file="$f" '
      function flush(   i, n, want, ok) {
        if (doc ~ ("(^|\n)kind: (" kinds ")(\n|$)")) {
          ok = 1
          n = split(need, want, "|")
          for (i = 1; i <= n; i++) if (want[i] != "" && index(doc, want[i]) == 0) ok = 0
          if (forbid != "" && index(doc, forbid) > 0) ok = 0
          if (ok) print file
        }
        doc = ""
      }
      { sub(/\r$/, "") }
      /^---[ \t]*$/ { flush(); next }
      /^[ \t]*#/ { next }
      { doc = doc $0 "\n" }
      END { flush() }
    ' "$f"
  done
}

# The start command of the first container in $1, as the manifest spells it:
# the folded block after `- >-`, joined into one line.
start_command() {
  awk '
    { sub(/\r$/, "") }
    !on && /^ *- >-$/ { on = 1; match($0, /^ */); indent = RLENGTH; next }
    on { match($0, /^ */); if (RLENGTH <= indent || $0 ~ /^ *$/) exit; sub(/^ +/, ""); printf "%s ", $0 }
  ' "$1"
}

# Runs start command $1 with environment variable $2 empty and set to $3, a
# stand-in for program $4 on the PATH. Sets out/code (empty) and started (set).
run_start() {
  local tmp
  tmp="$(mktemp -d)"
  printf '#!/bin/sh\necho "STARTED $*"\n' > "$tmp/$4"
  chmod +x "$tmp/$4"
  out="$(env "$2=" TMPDIR="$tmp" PATH="$tmp:$PATH" sh -c "$1" 2>&1)"; code=$?
  started="$(env "$2=$3" TMPDIR="$tmp" PATH="$tmp:$PATH" sh -c "$1" 2>&1)"
  rm -rf "$tmp"
}

# 1. The store.
cmd="$(start_command "$DIR/base/valkey.yaml")"
if [ -z "$cmd" ]; then say "FAIL 1: could not read the store's start command from base/valkey.yaml"; fail=1; else
  run_start "$cmd" VALKEY_PASSWORD a-made-up-password valkey-server
  if printf '%s' "$out" | grep -q '^STARTED'; then
    say "FAIL 1: with an empty VALKEY_PASSWORD the store starts anyway: $out"; fail=1
  elif ! printf '%s' "$started" | grep -q '^STARTED'; then
    say "FAIL 1: with a password set the store does not start: $started"; fail=1
  elif printf '%s' "$started" | grep '^STARTED' | grep -q 'a-made-up-password'; then
    say "FAIL 1: the store's password is on its command line: $started"; fail=1
  else
    say "ok 1: an empty VALKEY_PASSWORD stops the store (exit $code), a set one starts it, off the command line"
  fi
fi

# 2. A NetworkPolicy for the store: it selects the store's pods and names port
#    6379 and the webmail's pods as the only source.
policy="$(docs 'NetworkPolicy' 'app.kubernetes.io/name: valkey|6379|app.kubernetes.io/name: bulwark|Ingress' '' | head -n 1)"
if [ -n "$policy" ]; then say "ok 2: the store is closed to other pods by ${policy#"$DIR"/}"; else
  say "FAIL 2: no NetworkPolicy in the deployment selects the store (app.kubernetes.io/name: valkey) and limits port 6379 to the webmail's pods"; fail=1
fi

# 3. No service account token in any workload.
with_token="$(docs 'Deployment|StatefulSet|DaemonSet|Job|CronJob' '' 'automountServiceAccountToken: false' | sort -u | sed "s|^$DIR/||" | tr '\n' ' ')"
if [ -z "$with_token" ]; then say "ok 3: no workload mounts a service account token"; else
  say "FAIL 3: automountServiceAccountToken: false is missing in a workload of: $with_token"; fail=1
fi

# 4. The webmail.
cmd="$(start_command "$DIR/base/bulwark.yaml")"
if [ -z "$cmd" ]; then say "FAIL 4: base/bulwark.yaml has no start command that checks SESSION_SECRET"; fail=1; else
  run_start "$cmd" SESSION_SECRET a-made-up-session-secret node
  if printf '%s' "$out" | grep -q '^STARTED'; then
    say "FAIL 4: with an empty SESSION_SECRET the webmail starts anyway: $out"; fail=1
  elif ! printf '%s' "$started" | grep -q '^STARTED'; then
    say "FAIL 4: with SESSION_SECRET set the webmail does not start: $started"; fail=1
  else
    say "ok 4: an empty SESSION_SECRET stops the webmail (exit $code), a set one starts it"
  fi
fi

exit $fail
