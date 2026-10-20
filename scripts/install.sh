#!/bin/sh
# nelcota installer: downloads the binary, checks the checksum and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh
#
# Optional variables:
#   NELCOTA_VERSION=0.3.0     version (default: the latest)
#   NELCOTA_REPO=owner/repo   GitHub repository (default: Nelcota/Nelcota)
#   PREFIX=/usr/local/bin     where to install
#   NELCOTA_SKIP_DOCKER=1     do not install Docker (for `nelcota init --runtime systemd`)
#
# Rather not run `curl | sh`? Download the binary and the .sha256 from the
# releases page and check them with `sha256sum -c`. This script does exactly that.
set -eu

REPO="${NELCOTA_REPO:-Nelcota/Nelcota}"
VERSION="${NELCOTA_VERSION:-latest}"
PREFIX="${PREFIX:-/usr/local/bin}"

say() { printf '%s\n' "→ $*"; }
die() { printf '%s\n' "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "the installer is for Linux (on macOS/Windows use 'cargo install --git https://github.com/$REPO nelcota-server')"

case "$(uname -m)" in
  x86_64|amd64) TARGET="x86_64-unknown-linux-musl" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-musl" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

for tool in curl sha256sum; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool not found (apt install curl coreutils, or your distribution's equivalent)"
done

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "this operation needs root (or sudo); use a writable PREFIX and NELCOTA_SKIP_DOCKER=1 for a user installation"
  sudo "$@"
}

install_binary() {
  if mkdir -p "$PREFIX" 2>/dev/null && [ -w "$PREFIX" ]; then
    install -m 0755 "$TMP/$BIN" "$PREFIX/nelcota"
    return
  fi
  as_root mkdir -p "$PREFIX"
  as_root install -m 0755 "$TMP/$BIN" "$PREFIX/nelcota"
}

case "$VERSION" in
  latest) BASE="https://github.com/$REPO/releases/latest/download" ;;
  *) BASE="https://github.com/$REPO/releases/download/v$VERSION" ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="nelcota-$TARGET"

say "Downloading $BIN ($VERSION)"
curl -fsSL "$BASE/$BIN" -o "$TMP/$BIN"
curl -fsSL "$BASE/$BIN.sha256" -o "$TMP/$BIN.sha256"

say "Checking the checksum (SHA-256)"
(cd "$TMP" && sha256sum -c "$BIN.sha256") >/dev/null || die "checksum does not match; aborted"

install_binary
say "nelcota installed at $PREFIX/nelcota ($("$PREFIX/nelcota" --version))"

if ! command -v docker >/dev/null 2>&1; then
  case "${NELCOTA_SKIP_DOCKER:-0}" in
    1) say "Docker not installed (NELCOTA_SKIP_DOCKER=1): use 'nelcota init --runtime systemd', or install Docker first" ;;
    *) say "Docker not found: installing it with the official script (get.docker.com)"
       curl -fsSL https://get.docker.com -o "$TMP/install-docker.sh"
       as_root sh "$TMP/install-docker.sh" ;;
  esac
fi

cat <<'MSG'

VPS next steps (run in a root shell, for example sudo -i):
  # Prepare a running, boot-enabled cron/crond scheduler that reads /etc/cron.d.
  # Debian/Ubuntu: apt-get install cron && systemctl enable --now cron.service
  # --firewall also requires installed ufw; allow your actual SSH port first.
  mkdir -p /opt/nelcota && cd /opt/nelcota   # the host folder
  nelcota init api.yourdomain.com    # point DNS (A record) at this machine first
  nelcota up
  nelcota doctor                     # checks DNS, ports, backups and health

For local application development, use nelcota dev in your application folder.
It does not require root or a backup scheduler.
MSG
