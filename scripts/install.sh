#!/bin/sh
# nelcota installer: downloads the binary, checks the checksum and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh
#
# With arguments it sets up a whole VPS in one go, as root: installs the
# prerequisites (cron, curl, Docker; ufw with --firewall), the binary, then
# runs `nelcota init <arguments>` and `nelcota up` in /opt/nelcota:
#
#   curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo sh -s -- api.yourdomain.com
#
# Every argument goes to `nelcota init` (--email, --firewall, --runtime
# systemd, --s3-*...), except --dir <folder>, the host folder.
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

# Setup mode: split --dir from the arguments forwarded to `nelcota init`.
SETUP=0
HOST_DIR=/opt/nelcota
FIREWALL=0
if [ "$#" -gt 0 ]; then
  SETUP=1
  count=$#
  while [ "$count" -gt 0 ]; do
    arg=$1
    shift
    count=$((count - 1))
    case "$arg" in
      --dir)
        [ "$count" -gt 0 ] || die "--dir needs a folder"
        HOST_DIR=$1
        shift
        count=$((count - 1))
        ;;
      --dir=*) HOST_DIR=${arg#--dir=} ;;
      --runtime)
        [ "$count" -gt 0 ] || die "--runtime needs a value"
        [ "$1" = systemd ] && NELCOTA_SKIP_DOCKER=1
        set -- "$@" "$arg" "$1"
        shift
        count=$((count - 1))
        ;;
      --runtime=systemd) NELCOTA_SKIP_DOCKER=1; set -- "$@" "$arg" ;;
      --firewall) FIREWALL=1; set -- "$@" "$arg" ;;
      *) set -- "$@" "$arg" ;;
    esac
  done
  [ "$(id -u)" -eq 0 ] || die "setting up a VPS needs root: curl -fsSL <this script> | sudo sh -s -- $*"
fi

[ "$(uname -s)" = "Linux" ] || die "the installer is for Linux (on macOS/Windows use 'cargo install --git https://github.com/$REPO nelcota-server')"

case "$(uname -m)" in
  x86_64|amd64) TARGET="x86_64-unknown-linux-musl" ;;
  aarch64|arm64) TARGET="aarch64-unknown-linux-musl" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# Packages init needs before it writes anything: an active cron scheduler
# reading /etc/cron.d, and ufw when --firewall is requested.
install_prerequisites() {
  packages="ca-certificates curl coreutils"
  [ "$FIREWALL" -eq 1 ] && packages="$packages ufw"
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing prerequisites with apt-get"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # shellcheck disable=SC2086
    apt-get install -y -qq $packages cron >/dev/null
    systemctl enable --now cron.service
  elif command -v dnf >/dev/null 2>&1; then
    say "Installing prerequisites with dnf"
    # shellcheck disable=SC2086
    dnf install -y -q $packages cronie
    systemctl enable --now crond.service
  else
    say "Unknown package manager: install curl, sha256sum and an active cron scheduler yourself"
  fi
}

[ "$SETUP" -eq 1 ] && install_prerequisites

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

if [ "$SETUP" -eq 1 ]; then
  mkdir -p "$HOST_DIR"
  if [ -e "$HOST_DIR/nelcota-host.json" ]; then
    say "A host already exists in $HOST_DIR: skipping init (add projects with 'nelcota -C $HOST_DIR init ...')"
  else
    say "Creating the host in $HOST_DIR"
    # Under `curl | sh` stdin is the script itself: ask questions on the terminal.
    if (: </dev/tty) 2>/dev/null; then
      "$PREFIX/nelcota" -C "$HOST_DIR" init "$@" </dev/tty
    else
      "$PREFIX/nelcota" -C "$HOST_DIR" init --yes "$@"
    fi
  fi
  say "Starting the projects and Caddy"
  "$PREFIX/nelcota" -C "$HOST_DIR" up
  cat <<MSG

Done. Keep the panel password shown above; it is not shown again.
  cd $HOST_DIR && nelcota status    # health, backups and versions
  nelcota -C $HOST_DIR doctor       # DNS, ports, backups (after the first nightly backup)
MSG
  exit 0
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
