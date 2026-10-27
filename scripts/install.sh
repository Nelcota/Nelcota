#!/bin/sh
# nelcota installer: downloads the binary, checks the checksum and installs it.
#
#   curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sh
#
# With arguments it sets up a whole VPS in one go, as root: installs the
# prerequisites (cron, curl, Docker, ufw, automatic security updates), turns the
# firewall on (SSH, 80 and 443), adds swap below 2 GB of RAM, installs the
# binary, then runs `nelcota init <arguments>` and `nelcota up` in /opt/nelcota:
#
#   curl -fsSL https://raw.githubusercontent.com/Nelcota/Nelcota/main/scripts/install.sh | sudo sh -s -- api.yourdomain.com
#
# Every argument goes to `nelcota init` (--email, --runtime systemd,
# --s3-*...), except --dir <absolute folder>, the host folder, and
# --no-firewall, which leaves the firewall off. --yes skips every init
# question, such as the S3 backup one.
#
# Optional variables:
#   NELCOTA_VERSION=0.5.5     version (default: the latest release)
#   NELCOTA_REPO=owner/repo   GitHub repository (default: Nelcota/Nelcota)
#   PREFIX=/usr/local/bin     where to install
#   NELCOTA_SKIP_DOCKER=1     do not install Docker (for `nelcota init --runtime systemd`)
#   NELCOTA_SWAP_FILE=/swapfile  swap file created when RAM is below 2 GB and no swap exists
#
# Rather not run `curl | sh`? Download the binary and the .sha256 from the
# releases page and check them with `sha256sum -c`. This script does exactly that.
#
# Everything runs from main(), called on the last line: if the download stops
# halfway, `sh` reads an unfinished function and runs nothing.
set -eu

# The released binaries are about 35 MB; anything far larger is not ours.
MAX_DOWNLOAD_BYTES=268435456
# Fresh VPS images run unattended upgrades right after boot.
APT_LOCK_WAIT_SECONDS=300
APT_UPDATE_ATTEMPTS=6
DOCKER_START_WAIT_SECONDS=30
# Postgres, the app and Caddy share small VPS: below this RAM, without swap,
# the kernel kills one of them under load.
SWAP_BELOW_RAM_MB=2048
SWAP_SIZE_MB=2048
SWAP_KEEP_FREE_MB=2048

say() { printf '%s\n' "→ $*"; }
die() { printf '%s\n' "error: $*" >&2; exit 1; }

# HTTPS only, also after redirects, with bounded time and retries for
# transient network errors.
fetch() {
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 \
    --connect-timeout 15 --max-time 600 "$@"
}

TMP=""
STAGED=""
cleanup() {
  [ -z "$TMP" ] || rm -rf "$TMP"
  if [ -n "$STAGED" ] && [ -e "$STAGED" ]; then
    rm -f "$STAGED" 2>/dev/null || sudo -n rm -f "$STAGED" 2>/dev/null || true
  fi
}

validate_settings() {
  case "$REPO" in
    */*/* | /* | */ | *..* | *[!A-Za-z0-9._/-]*) die "NELCOTA_REPO must look like owner/repo" ;;
    */*) ;;
    *) die "NELCOTA_REPO must look like owner/repo" ;;
  esac
  case "${NELCOTA_SKIP_DOCKER:-0}" in
    0 | 1) ;;
    *) die "NELCOTA_SKIP_DOCKER must be 0 or 1" ;;
  esac
  case "$PREFIX" in
    /*) ;;
    *) die "PREFIX must be an absolute folder, such as /usr/local/bin" ;;
  esac
  if [ "$VERSION" != latest ]; then
    VERSION=${VERSION#v}
    validate_version
  fi
}

# Accepts 1.2.3 and 1.2.3-rc.1. The character check comes first so a newline
# can never reach grep, which matches line by line.
validate_version() {
  case "$VERSION" in
    '' | *[!0-9A-Za-z.-]*) die "NELCOTA_VERSION must be a version such as 0.5.5" ;;
  esac
  printf '%s\n' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' ||
    die "NELCOTA_VERSION must be a version such as 0.5.5"
}

validate_host_dir() {
  case "$HOST_DIR" in
    /*) ;;
    *) die "--dir needs an absolute folder, such as /opt/nelcota" ;;
  esac
  [ "$(printf '%s' "$HOST_DIR" | tr -s /)" != / ] || die "--dir cannot be the root folder"
}

# Packages init needs before it writes anything: an active cron scheduler
# reading /etc/cron.d, ufw for the firewall (Debian/Ubuntu; Fedora/RHEL use
# firewalld) and automatic security updates.
install_prerequisites() {
  command -v systemctl >/dev/null 2>&1 ||
    die "setting up a VPS needs systemd (systemctl not found); install the binary without arguments and follow docs/deploy.md"
  packages="ca-certificates curl coreutils"
  if command -v apt-get >/dev/null 2>&1; then
    say "Installing prerequisites with apt-get"
    export DEBIAN_FRONTEND=noninteractive
    [ "$FIREWALL" -eq 0 ] || packages="$packages ufw"
    # Debian ships unattended-upgrades disabled; this answer turns it on.
    if command -v debconf-set-selections >/dev/null 2>&1; then
      printf '%s\n' 'unattended-upgrades unattended-upgrades/enable_auto_updates boolean true' | debconf-set-selections
    fi
    apt_update
    # shellcheck disable=SC2086
    apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_SECONDS" install -y -qq $packages cron unattended-upgrades >/dev/null
    systemctl enable --now cron.service
  elif command -v dnf >/dev/null 2>&1; then
    say "Installing prerequisites with dnf"
    # shellcheck disable=SC2086
    dnf install -y -q $packages cronie
    systemctl enable --now crond.service
  else
    # init needs cron.service/crond.service, so stop before changing anything.
    die "setting up a VPS supports Debian/Ubuntu (apt-get) and Fedora/RHEL (dnf); on this system install the binary without arguments and follow docs/deploy.md"
  fi
}

ufw_active() {
  command -v ufw >/dev/null 2>&1 && LC_ALL=C ufw status 2>/dev/null | grep -q '^Status: active'
}

# An already active firewall blocks 80/443 and HTTPS fails without an error,
# so its rules are only ever added to. Otherwise `nelcota init --firewall`
# turns ufw on with SSH (22 and the ports sshd reports), 80 and 443.
prepare_firewall() {
  INIT_FIREWALL=0
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    say "firewalld is active: allowing HTTP and HTTPS"
    firewall-cmd --permanent --add-service=http --add-service=https --add-port=443/udp >/dev/null
    firewall-cmd --reload >/dev/null
    return
  fi
  if ufw_active; then
    say "ufw is active: allowing ports 80 and 443"
    ufw allow 80/tcp >/dev/null
    ufw allow 443 >/dev/null
    return
  fi
  if [ "$FIREWALL" -eq 0 ]; then
    say "Firewall left off (--no-firewall): allow SSH, 80 and 443 before turning one on"
    return
  fi
  if command -v ufw >/dev/null 2>&1; then
    INIT_FIREWALL=1
    return
  fi
  [ "$FIREWALL_REQUESTED" -eq 0 ] ||
    die "--firewall uses ufw, which this distribution does not provide; enable firewalld (systemctl enable --now firewalld) and run the same command again"
  say "note: no firewall turned on (ufw is not available here); enable your distribution's firewall and allow SSH, 80 and 443"
}

ensure_swap() {
  case "$SWAP_FILE" in
    /*) ;;
    *) die "NELCOTA_SWAP_FILE must be an absolute path, such as /swapfile" ;;
  esac
  command -v free >/dev/null 2>&1 || return 0
  # Parsed output: the English labels and columns, whatever the system language.
  ram_mb=$(LC_ALL=C free -m | awk '/^Mem:/ {print $2}')
  swap_mb=$(LC_ALL=C free -m | awk '/^Swap:/ {print $2}')
  is_number "$ram_mb" && is_number "$swap_mb" || return 0
  if [ "$ram_mb" -ge "$SWAP_BELOW_RAM_MB" ] || [ "$swap_mb" -gt 0 ]; then
    return 0
  fi
  if [ -e "$SWAP_FILE" ]; then
    say "note: $SWAP_FILE exists but no swap is active; it was left untouched"
    return 0
  fi
  disk=$(LC_ALL=C df -PTk / | awk 'NR == 2 {print $2 " " $5}')
  fs_type=${disk%% *}
  free_kb=${disk#* }
  case "$fs_type" in
    btrfs | zfs) say "note: less than 2 GB of RAM and no swap; create swap by hand on $fs_type"; return 0 ;;
  esac
  is_number "$free_kb" || return 0
  if [ "$free_kb" -lt $(((SWAP_SIZE_MB + SWAP_KEEP_FREE_MB) * 1024)) ]; then
    say "note: less than 2 GB of RAM and no swap, but too little disk to create it"
    return 0
  fi
  say "Less than 2 GB of RAM and no swap: creating a ${SWAP_SIZE_MB} MB swap file at $SWAP_FILE"
  if ! create_swap; then
    rm -f "$SWAP_FILE"
    say "warning: could not create the swap file; continuing without swap"
  fi
}

is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
}

create_swap() {
  (umask 077 && dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none) &&
    mkswap "$SWAP_FILE" >/dev/null &&
    swapon "$SWAP_FILE" &&
    { swap_in_fstab || printf '%s none swap sw 0 0\n' "$SWAP_FILE" >>"$FSTAB"; }
}

swap_in_fstab() {
  awk -v file="$SWAP_FILE" '$1 == file { found = 1 } END { exit found ? 0 : 1 }' "$FSTAB" 2>/dev/null
}

# `apt-get update` fails at once while another apt process holds the lists
# lock, so it is retried for a bounded time.
apt_update() {
  attempt=1
  until apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_SECONDS" update -qq; do
    [ "$attempt" -lt "$APT_UPDATE_ATTEMPTS" ] || die "apt-get update kept failing; check the messages above and run the same command again"
    say "apt-get update failed (another apt process may be running); retrying in 10 s"
    attempt=$((attempt + 1))
    sleep 10
  done
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  command -v sudo >/dev/null 2>&1 || die "this operation needs root (or sudo); use a writable PREFIX and NELCOTA_SKIP_DOCKER=1 for a user installation"
  sudo "$@"
}

# One resolution for both downloads, so the binary and its checksum always
# come from the same release.
resolve_latest() {
  url=$(fetch -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest") ||
    die "could not reach GitHub to find the latest release of $REPO"
  tag=${url##*/releases/tag/}
  [ "$tag" != "$url" ] || die "no published release found for $REPO"
  VERSION=${tag#v}
  validate_version
}

download() {
  fetch --max-filesize "$MAX_DOWNLOAD_BYTES" -o "$TMP/$1" "$BASE/$1" ||
    die "could not download $1 for version $VERSION; check that it exists at https://github.com/$REPO/releases/tag/v$VERSION"
}

# Reads the expected hash ourselves instead of `sha256sum -c`, which checks
# whatever files the .sha256 lists and so could skip the downloaded binary.
verify_checksum() {
  line=""
  IFS= read -r line <"$TMP/$BIN.sha256" || [ -n "$line" ] || die "the checksum file is empty; aborted"
  line=${line%"$(printf '\r')"}
  expected=${line%%[[:space:]]*}
  name=${line#"$expected"}
  name=${name#"${name%%[![:space:]]*}"}
  name=${name#\*}
  [ "${#expected}" -eq 64 ] || die "the checksum file is malformed; aborted"
  case "$expected" in
    *[!0-9a-fA-F]*) die "the checksum file is malformed; aborted" ;;
  esac
  [ -z "$name" ] || [ "$name" = "$BIN" ] || die "the checksum file is for another file ($name); aborted"
  actual=$(sha256sum "$TMP/$BIN")
  actual=${actual%%[[:space:]]*}
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  [ "$actual" = "$expected" ] || die "checksum does not match; aborted"
}

# Copies next to the destination, runs it, then renames it over the previous
# binary: an interrupted install never leaves a partial `nelcota`, and a file
# created in PREFIX gets that folder's SELinux label.
install_binary() {
  STAGED="$PREFIX/.nelcota.new.$$"
  if mkdir -p "$PREFIX" 2>/dev/null && [ -w "$PREFIX" ]; then
    install -m 0755 "$TMP/$BIN" "$STAGED"
    check_staged_version
    mv -f "$STAGED" "$PREFIX/nelcota"
  else
    as_root mkdir -p "$PREFIX"
    as_root install -m 0755 "$TMP/$BIN" "$STAGED"
    check_staged_version
    as_root mv -f "$STAGED" "$PREFIX/nelcota"
  fi
  STAGED=""
}

check_staged_version() {
  reported=$("$STAGED" --version 2>&1) || die "the downloaded binary does not run on this machine: $reported"
  [ "$reported" = "nelcota $VERSION" ] || die "expected nelcota $VERSION, but the binary reports: $reported"
}

install_docker() {
  say "Docker not found: installing it with the official script (get.docker.com)"
  fetch --max-filesize "$MAX_DOWNLOAD_BYTES" -o "$TMP/install-docker.sh" https://get.docker.com ||
    die "could not download the Docker installer from get.docker.com"
  as_root sh "$TMP/install-docker.sh"
}

# get.docker.com does not start the daemon on Fedora/RHEL, and an existing
# installation may be stopped.
start_docker() {
  say "Starting Docker"
  systemctl enable --now docker.service
  waited=0
  until docker info >/dev/null 2>&1; do
    [ "$waited" -lt "$DOCKER_START_WAIT_SECONDS" ] || die "Docker did not start; check 'systemctl status docker' and run the same command again"
    sleep 1
    waited=$((waited + 1))
  done
}

warn_if_not_on_path() {
  case ":$PATH:" in
    *":$PREFIX:"*) ;;
    *) say "note: $PREFIX is not in PATH; run $PREFIX/nelcota or add the folder to PATH" ;;
  esac
}

main() {
  REPO="${NELCOTA_REPO:-Nelcota/Nelcota}"
  VERSION="${NELCOTA_VERSION:-latest}"
  PREFIX="${PREFIX:-/usr/local/bin}"
  validate_settings

  # Setup mode: split --dir from the arguments forwarded to `nelcota init`.
  SETUP=0
  HOST_DIR=/opt/nelcota
  FIREWALL_REQUESTED=0
  NO_FIREWALL=0
  LOCAL=0
  ASSUME_YES=0
  SWAP_FILE="${NELCOTA_SWAP_FILE:-/swapfile}"
  FSTAB="${NELCOTA_FSTAB:-/etc/fstab}"
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
          [ "$1" != systemd ] || NELCOTA_SKIP_DOCKER=1
          set -- "$@" "$arg" "$1"
          shift
          count=$((count - 1))
          ;;
        --runtime=systemd) NELCOTA_SKIP_DOCKER=1; set -- "$@" "$arg" ;;
        # Sent to init below, only when ufw is the firewall to turn on.
        --firewall) FIREWALL_REQUESTED=1 ;;
        --no-firewall) NO_FIREWALL=1 ;;
        --local) LOCAL=1; set -- "$@" "$arg" ;;
        # Passed once below: init refuses a repeated --yes.
        --yes | -y) ASSUME_YES=1 ;;
        *) set -- "$@" "$arg" ;;
      esac
    done
    validate_host_dir
    [ "$FIREWALL_REQUESTED" -eq 0 ] || [ "$NO_FIREWALL" -eq 0 ] || die "--firewall and --no-firewall cannot be used together"
    [ "$FIREWALL_REQUESTED" -eq 0 ] || [ "$LOCAL" -eq 0 ] || die "--firewall does not apply to a --local host"
    # On by default for a public VPS; a --local host stays as it is.
    FIREWALL=1
    if [ "$NO_FIREWALL" -eq 1 ] || [ "$LOCAL" -eq 1 ]; then
      FIREWALL=0
    fi
    # The arguments are not repeated: they may carry secrets such as --s3-secret-key.
    [ "$(id -u)" -eq 0 ] || die "setting up a VPS needs root: run the same command with sudo (curl -fsSL <this script> | sudo sh -s -- <your arguments>)"
  fi

  [ "$(uname -s)" = "Linux" ] || die "the installer is for Linux (on macOS/Windows use 'cargo install --git https://github.com/$REPO nelcota-server')"

  case "$(uname -m)" in
    x86_64 | amd64) TARGET="x86_64-unknown-linux-musl" ;;
    aarch64 | arm64) TARGET="aarch64-unknown-linux-musl" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac

  if [ "$SETUP" -eq 1 ]; then
    install_prerequisites
    prepare_firewall
    ensure_swap
  fi

  for tool in curl sha256sum mktemp install; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found (apt install curl coreutils, or your distribution's equivalent)"
  done

  TMP="$(mktemp -d)"
  trap cleanup EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM

  [ "$VERSION" != latest ] || resolve_latest
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
  BIN="nelcota-$TARGET"

  say "Downloading $BIN ($VERSION)"
  download "$BIN"
  download "$BIN.sha256"

  say "Checking the checksum (SHA-256)"
  verify_checksum

  install_binary
  say "nelcota $VERSION installed at $PREFIX/nelcota"
  warn_if_not_on_path

  if [ "${NELCOTA_SKIP_DOCKER:-0}" = 1 ]; then
    command -v docker >/dev/null 2>&1 ||
      say "Docker not installed (NELCOTA_SKIP_DOCKER=1): use 'nelcota init --runtime systemd', or install Docker first"
  else
    command -v docker >/dev/null 2>&1 || install_docker
    [ "$SETUP" -eq 0 ] || start_docker
  fi

  if [ "$SETUP" -eq 1 ]; then
    mkdir -p "$HOST_DIR"
    if [ -e "$HOST_DIR/nelcota-host.json" ]; then
      say "A host already exists in $HOST_DIR: skipping init (add projects with 'nelcota -C $HOST_DIR init ...')"
    else
      say "Creating the host in $HOST_DIR"
      [ "$INIT_FIREWALL" -eq 0 ] || set -- "$@" --firewall
      # Under `curl | sh` stdin is the script itself: ask questions on the terminal.
      if [ "$ASSUME_YES" -eq 0 ] && (: </dev/tty) 2>/dev/null; then
        "$PREFIX/nelcota" -C "$HOST_DIR" init "$@" </dev/tty ||
          die "nelcota init failed; fix the problem above and run the same command again"
      else
        "$PREFIX/nelcota" -C "$HOST_DIR" init --yes "$@" ||
          die "nelcota init failed; fix the problem above and run the same command again"
      fi
    fi
    say "Starting the projects and Caddy"
    # `up` also fails while DNS does not point here yet, with the projects
    # already running; say how to finish in both cases.
    if ! "$PREFIX/nelcota" -C "$HOST_DIR" up; then
      printf '%s\n' "Keep the panel password shown above; it is not shown again." >&2
      die "nelcota up did not finish. If it says the projects are running and only HTTPS is unreachable, point the domain's DNS at this machine and run 'nelcota -C $HOST_DIR up'. Otherwise fix the problem above and run the same command again (the host in $HOST_DIR is kept)"
    fi
    cat <<MSG

Done. Keep the panel password shown above; it is not shown again.
  cd $HOST_DIR && nelcota status    # health, backups and versions
  nelcota -C $HOST_DIR doctor       # DNS, ports, backups (after the first nightly backup)

If HTTPS does not answer from outside, check your provider's firewall or
security group too: ports 80 and 443 must be open there.
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
}

main "$@"
