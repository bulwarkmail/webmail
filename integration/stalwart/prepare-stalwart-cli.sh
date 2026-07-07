#!/usr/bin/env bash
# Fetch the stalwart-cli binary used by the Stalwart bootstrap image.
#
# The Dockerfile COPYs ./stalwart-cli instead of downloading it during the
# build, because the base image's apt sources and the build network are
# unreachable in the sandboxed CI environment. This script does the fetch on
# the host (which has working outbound HTTPS) and extracts the binary with
# Python's lzma module (xz is not guaranteed to be installed).
#
# Idempotent: skips the download when a matching binary already exists.
set -euo pipefail

CLI_VERSION="${STALWART_CLI_VERSION:-1.0.6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${HERE}/stalwart-cli"

case "$(uname -m)" in
  x86_64)  TRIPLE=x86_64-unknown-linux-gnu ;;
  aarch64|arm64) TRIPLE=aarch64-unknown-linux-gnu ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [ -x "${OUT}" ] && "${OUT}" --version 2>/dev/null | grep -q "${CLI_VERSION}"; then
  echo "stalwart-cli ${CLI_VERSION} already present at ${OUT}"
  exit 0
fi

URL="https://github.com/stalwartlabs/cli/releases/download/v${CLI_VERSION}/stalwart-cli-${TRIPLE}.tar.xz"
TARBALL="$(mktemp)"
trap 'rm -f "${TARBALL}"' EXIT

echo "Downloading ${URL}"
curl -sfL -o "${TARBALL}" "${URL}"

python3 - "${TARBALL}" "${OUT}" <<'PY'
import io, lzma, os, sys, tarfile
tarball, out = sys.argv[1], sys.argv[2]
with lzma.open(tarball) as f:
    data = f.read()
tf = tarfile.open(fileobj=io.BytesIO(data))
member = next(m for m in tf.getmembers() if m.name.endswith("stalwart-cli"))
with open(out, "wb") as w:
    w.write(tf.extractfile(member).read())
os.chmod(out, 0o755)
print(f"wrote {out}")
PY

"${OUT}" --version
