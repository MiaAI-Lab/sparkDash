#!/usr/bin/env bash
# Install, upgrade or remove sparkdash-agent on this host. Run it on the host
# itself, as root, next to the binary:
#
#   sudo ./install.sh --listen 192.0.2.10:9110 --allow 192.0.2.0/24
#   sudo ./install.sh --listen 192.0.2.10:9110 --allow 192.0.2.0/24 --token-file ./token
#   sudo ./install.sh --uninstall
#
# --listen and --allow may repeat. They are written to
# /etc/sparkdash-agent/agent.env only when that file doesn't exist yet; edit it
# to change them later. --token-file installs that token (so several hosts can
# share the dashboard's SPARKDASH_AGENT_TOKEN); without it a token is generated
# once and printed. --binary defaults to ./sparkdash-agent, then the build
# output for this architecture.
set -euo pipefail

usage() {
  sed -n '2,14s/^# \{0,1\}//p' "$0" >&2
  exit 2
}

here=$(cd "$(dirname "$0")" && pwd)
conf_dir=/etc/sparkdash-agent
bin_path=/usr/local/bin/sparkdash-agent
unit_path=/etc/systemd/system/sparkdash-agent.service
listen=()
allow=()
binary=""
token_file=""
uninstall=0

while [ $# -gt 0 ]; do
  case "$1" in
    --listen) listen+=("${2:?--listen needs IP:PORT}"); shift 2 ;;
    --allow) allow+=("${2:?--allow needs a CIDR}"); shift 2 ;;
    --binary) binary=${2:?--binary needs a path}; shift 2 ;;
    --token-file) token_file=${2:?--token-file needs a path}; shift 2 ;;
    --uninstall) uninstall=1; shift ;;
    -h | --help) usage ;;
    *) echo "unknown option: $1" >&2; usage ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root (sudo $0 ...)" >&2
  exit 1
fi

if [ "$uninstall" = 1 ]; then
  systemctl disable --now sparkdash-agent 2>/dev/null || true
  rm -f "$bin_path" "$unit_path"
  rm -rf "$conf_dir"
  systemctl daemon-reload
  echo "sparkdash-agent removed (binary, unit, $conf_dir)"
  exit 0
fi

if [ -z "$binary" ]; then
  for candidate in "$here/sparkdash-agent" \
    "$here/../dist/sparkdash-agent-$(uname -m)-linux" \
    "$here/../target/release/sparkdash-agent"; do
    if [ -f "$candidate" ]; then
      binary=$candidate
      break
    fi
  done
fi
if [ -z "$binary" ] || [ ! -f "$binary" ]; then
  echo "no sparkdash-agent binary found; pass --binary PATH" >&2
  exit 1
fi
unit_src="$here/sparkdash-agent.service"
[ -f "$unit_src" ] || { echo "missing $unit_src" >&2; exit 1; }

if [ ! -f "$conf_dir/agent.env" ] && [ ${#listen[@]} -eq 0 ]; then
  echo "first install: --listen IP:PORT is required" >&2
  exit 2
fi
if [ -n "$token_file" ]; then
  token=$(tr -d '[:space:]' <"$token_file")
  if [ ${#token} -lt 24 ]; then
    echo "token in $token_file is shorter than 24 characters" >&2
    exit 1
  fi
fi

install -m 0755 "$binary" "$bin_path.new"
if ! "$bin_path.new" --version >/dev/null; then
  rm -f "$bin_path.new"
  echo "$binary does not run on this host (wrong architecture or glibc?)" >&2
  exit 1
fi
mv -f "$bin_path.new" "$bin_path"
install -m 0644 "$unit_src" "$unit_path"
install -d -m 0700 "$conf_dir"

if [ -f "$conf_dir/agent.env" ]; then
  [ ${#listen[@]} -eq 0 ] || echo "keeping existing $conf_dir/agent.env (edit it to change --listen/--allow)"
else
  args=""
  for l in "${listen[@]}"; do args+=" --listen $l"; done
  for a in "${allow[@]}"; do args+=" --allow $a"; done
  printf 'SPARKDASH_AGENT_ARGS=%s\n' "${args# }" >"$conf_dir/agent.env"
  chmod 0644 "$conf_dir/agent.env"
fi

umask 077
if [ -n "$token_file" ]; then
  printf '%s\n' "$token" >"$conf_dir/token"
  echo "installed the token from $token_file"
elif [ ! -f "$conf_dir/token" ]; then
  head -c 32 /dev/urandom | base64 | tr -d '/+=\n' >"$conf_dir/token"
  echo "generated a token; set SPARKDASH_AGENT_TOKEN for sparkDash to:"
  cat "$conf_dir/token"
  echo
fi
chmod 0600 "$conf_dir/token"

systemctl daemon-reload
systemctl enable sparkdash-agent >/dev/null
systemctl restart sparkdash-agent
sleep 1
systemctl --no-pager --lines=5 status sparkdash-agent
