# Read-only: files and folders that coding agents (Claude Code, Codex, Aider, Gemini CLI, editors' remote servers,
# browser-test tools) tend to leave behind, for "Remove agent junk". Changes nothing and writes no file. Run with bash.
# $1 seconds the whole program may take  $2... temporary folders to look in (/tmp, /var/tmp)
# Which items are junk is decided by the dashboard (agentJunk.js); this program only finds the candidates and
# measures them. Every path is hex-encoded, so no byte of a name can be mistaken for the format.
# Output: KEY=value lines.
#   NOW=<seconds since 1970, the unit's clock>  HOME_HEX=<the account's home>  GIT=ok|missing
#   I=<type>|<size bytes or ->|<newest mtime or ->|<flags>|<path hex>   one candidate. type: d or f. size and mtime
#       are "-" when they could not be measured in time. flags (any of): T tracked by git, U untracked inside a git
#       work tree, D a work tree with uncommitted changes, M holds an agent's saved memory, R measured only partly
#   WALK=<home hex>|<code>   looking through a home folder: 0 complete, 124 out of time
#   MORE=1                   more candidates than are reported
export LC_ALL=C
BUDGET=$1
shift
T0=$(date +%s)
DEADLINE=$((T0 + BUDGET))
MAX_ITEMS=2000
left() {
  l=$((DEADLINE - $(date +%s)))
  [ "$l" -ge 0 ] || l=0
  echo "$l"
}
hex() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n'; }
LOW=""
command -v nice >/dev/null 2>&1 && LOW="nice -n 10"

ME=$(id -u)
H=${HOME-}
[ -n "$H" ] && [ -d "$H" ] || H=$(getent passwd "$ME" 2>/dev/null | cut -d: -f6)
HOMES=()
[ -n "$H" ] && [ -d "$H" ] && HOMES+=("$H")
# As root (a dashboard in a container), the people's homes too: their agents leave the junk.
if [ "$ME" = 0 ]; then
  while IFS=: read -r _n _p uid _g _c dir _s; do
    case "$uid" in '' | *[!0-9]*) continue ;; esac
    [ "$uid" -ge 1000 ] && [ "$uid" -lt 60000 ] || continue
    case "$dir" in /home/?*) [ -d "$dir" ] && [ "$dir" != "$H" ] && HOMES+=("$dir") ;; esac
  done < <(getent passwd 2>/dev/null)
fi

GIT=missing
command -v git >/dev/null 2>&1 && GIT=ok
printf 'RESULT=ok\n'
printf 'NOW=%s\n' "$T0"
printf 'HOME_HEX=%s\n' "$(hex "$H")"
printf 'GIT=%s\n' "$GIT"

# Candidates as NUL-terminated "type size mtime path" records (size and mtime "-" for a folder, measured later).
LIST=$(mktemp 2>/dev/null) || fail no-temp "A temporary file could not be made on the Spark"
trap 'rm -f "$LIST"' EXIT
add() { [ -d "$2" ] && [ ! -L "$2" ] && printf 'd - - %s\0' "$2" >>"$LIST"; return 0; }
addKids() { # every folder or file directly inside $1
  [ -d "$1" ] || return 0
  find "$1" -mindepth 1 -maxdepth 1 \( -type d -printf 'd - - %p\0' -o -type f -printf 'f %s %T@ %p\0' \) 2>/dev/null >>"$LIST"
}

for h in "${HOMES[@]}"; do
  # Fixed places agents keep their state.
  for n in shell-snapshots todos debug statsig file-history paste-cache session-env ide; do add d "$h/.claude/$n"; done
  addKids "$h/.claude/projects"
  for n in sessions archived_sessions log; do add d "$h/.codex/$n"; done
  addKids "$h/.codex/worktrees"
  add d "$h/.gemini/tmp"
  add d "$h/.cache/claude-cli-nodejs"
  add d "$h/.cache/claude"
  add d "$h/.local/share/opencode/log"
  add d "$h/.local/share/opencode/snapshot"
  add d "$h/.continue/sessions"
  add d "$h/.npm/_npx"
  for n in ms-playwright puppeteer pip uv; do add d "$h/.cache/$n"; done
  for e in .vscode-server .cursor-server .windsurf-server; do
    addKids "$h/$e/bin"
    for d in "$h/$e/bin"/linux-*; do addKids "$d"; done
    addKids "$h/$e/cli/servers"
    add d "$h/$e/data/logs"
  done
done

# Temporary folders: only what belongs to this account (or, as root, to anyone).
OWN=(-user "$ME")
[ "$ME" = 0 ] && OWN=()
for t in "$@"; do
  [ -d "$t" ] || continue
  find "$t" -mindepth 1 -maxdepth 1 "${OWN[@]}" \( -iname 'claude*' -o -iname 'codex*' -o -iname 'aider*' -o -iname 'gemini*' \
    -o -iname 'opencode*' -o -iname 'cursor*' -o -iname 'devin*' -o -iname 'openhands*' -o -iname 'goose*' -o -iname 'cline*' \
    -o -name 'playwright*' -o -name 'puppeteer*' -o -name '.org.chromium.*' -o -name 'chrome_*' -o -name 'chromium*' \
    -o -name '.com.google.Chrome*' -o -name 'lighthouse*' -o -name 'pytest-of-*' -o -name 'tmp*' -o -name 'npm-*' -o -name 'pip-*' \
    -o -name 'uv-*' -o -name 'vite*' -o -name 'jiti' -o -name 'node-compile-cache' -o -name 'tsx-*' \) \
    \( -type d -printf 'd - - %p\0' -o -type f -printf 'f %s %T@ %p\0' \) 2>/dev/null >>"$LIST"
done

# The homes themselves: worktrees agents made, and loose scratch, report and backup files. Big trees of other
# software are skipped; the walk stops when its share of the time is used up.
WALK_LIMIT=$(( $(left) / 2 ))
[ "$WALK_LIMIT" -ge 1 ] || WALK_LIMIT=1
for h in "${HOMES[@]}"; do
  timeout "$WALK_LIMIT" $LOW find "$h" -mindepth 1 -maxdepth 7 \
    \( \( -type d \( -name node_modules -o -name .git -o -name .cache -o -name .npm -o -name .local -o -name .cargo \
      -o -name .rustup -o -name .conda -o -name .nvm -o -name .ollama -o -name .vscode-server -o -name .cursor-server \
      -o -name .windsurf-server -o -name .docker -o -name .mozilla -o -name .config -o -name snap -o -name miniconda3 \
      -o -name anaconda3 -o -name .pyenv -o -name .venv -o -name venv -o -name site-packages -o -name __pycache__ \
      -o -name .codex -o -name .gemini -o -name .grok -o -name .vscode -o -name .ssh -o -name .gnupg -o -name huggingface -o -name .triton \
      -o -name .sparkdash-staging-\* \) \) -prune \) \
    -o \( -path "$h/.claude" -prune \) \
    -o \( -type d \( -path '*/.claude/worktrees/*' -o -path '*/.worktrees/*' -o -name '.aider.tags.cache.v*' \) -printf 'd - - %p\0' -prune \) \
    -o \( -type f \( -name '*.bak' -o -name '*.bak-*' -o -name '*.bak.*' -o -name '*.orig' -o -name '*.rej' -o -name '*~' \
      -o -name '*.old' -o -name '*.backup' -o -name '.aider.chat.history.md' -o -name '.aider.input.history' \
      -o -name 'nohup.out' -o -name 'core' -o -name 'core.[0-9]*' \
      -o \( -name '*.log' -size +1M \) \
      -o -regex '.*/\(test\|debug\|tmp\|temp\|scratch\|fix\|patch\|check\|quick\|try\|demo\|repro\|verify\)[_-][^/]*\.\(py\|js\|mjs\|cjs\|ts\|sh\)' \
      -o -regex '.*/\(scratch\|playground\|untitled\)[^/]*\.\(py\|js\|ts\|sh\|txt\|md\)' \
      -o -regex '.*/[A-Z0-9_ -]*\(SUMMARY\|REPORT\|IMPLEMENTATION\|ANALYSIS\|FINDINGS\|PROGRESS\|HANDOFF\|INVESTIGATION\|FIXES\|_PLAN\|_NOTES\|_CHANGES\)[A-Z0-9_ -]*\.\(md\|txt\)' \
    \) -printf 'f %s %T@ %p\0' \) 2>/dev/null >>"$LIST"
  rc=$?
  [ "$rc" = 124 ] || rc=0
  printf 'WALK=%s|%s\n' "$(hex "$h")" "$rc"
done

# Read the candidates (each once), files and folders apart.
FILES=()
DIRS=()
while IFS= read -r -d '' rec; do
  case "$rec" in
    "d - - /"*) DIRS+=("${rec#d - - }") ;;
    f\ *) FILES+=("${rec#f }") ;;
  esac
done < <(sort -zu "$LIST")

n=0
emit() { # type size mtime flags path
  if [ "$n" -ge "$MAX_ITEMS" ]; then
    [ -n "${MORE-}" ] || printf 'MORE=1\n'
    MORE=1
    return 1
  fi
  n=$((n + 1))
  printf 'I=%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$(hex "$5")"
}

# Folders: size and the newest change of anything in it (du), whether it is a work tree with uncommitted changes,
# and whether it holds an agent's saved memory. Out of time: reported without a size.
for p in "${DIRS[@]}"; do
  size=-
  mt=-
  flags=""
  l=$(left)
  if [ "$l" -gt 0 ]; then
    [ "$l" -gt 15 ] && l=15
    out=$(timeout "$l" $LOW du -sk --time --time-style=+%s -- "$p" 2>/dev/null | tail -n 1)
    rc=$?
    s=$(printf '%s' "$out" | cut -f1)
    m=$(printf '%s' "$out" | cut -f2)
    case "$s" in '' | *[!0-9]*) ;; *) size=$((s * 1024)) ;; esac
    case "$m" in '' | *[!0-9]*) ;; *) mt=$m ;; esac
    [ "$rc" = 0 ] || flags="${flags}R"
  else
    flags="${flags}R"
  fi
  [ -d "$p/memory" ] && flags="${flags}M"
  if [ "$GIT" = ok ] && [ -e "$p/.git" ] && [ "$(left)" -gt 0 ]; then
    dirty=$(timeout 5 git -c safe.directory='*' -C "$p" status --porcelain --untracked-files=normal 2>/dev/null | head -c 1)
    [ -n "$dirty" ] && flags="${flags}D"
  fi
  emit d "$size" "$mt" "$flags" "$p" || break
done

# Loose files: what git knows about them, asked once per folder. A file git tracks is part of a project and is not
# reported at all.
declare -A TRACKED=() INREPO=() ASKED=() ISHOME=()
for h in "${HOMES[@]}"; do ISHOME[$h]=1; done
if [ "$GIT" = ok ]; then
  declare -A BYDIR=()
  for rec in "${FILES[@]}"; do
    p=${rec#* * }
    d=${p%/*}
    BYDIR[$d]+="${p##*/}"$'\n'
  done
  for d in "${!BYDIR[@]}"; do
    [ "$(left)" -gt 0 ] || break
    ASKED[$d]=1
    names=()
    while IFS= read -r nm; do [ -n "$nm" ] && names+=("$nm"); done <<<"${BYDIR[$d]}"
    out=$(timeout 5 git -c safe.directory='*' -C "$d" ls-files -z -- "${names[@]}" 2>/dev/null | tr '\0' '\n'; printf 'rc=%s' "${PIPESTATUS[0]}")
    rc=${out##*rc=}
    [ "$rc" = 0 ] || continue
    INREPO[$d]=1
    while IFS= read -r t; do [ -n "$t" ] && [ "${t#rc=}" = "$t" ] && TRACKED["$d/$t"]=1; done <<<"$out"
  done
fi
for rec in "${FILES[@]}"; do
  size=${rec%% *}
  rest=${rec#* }
  mt=${rest%% *}
  mt=${mt%.*}
  p=${rest#* }
  case "$p" in /*) ;; *) continue ;; esac
  d=${p%/*}
  [ -n "${TRACKED[$p]-}" ] && continue
  flags=""
  if [ -n "${INREPO[$d]-}" ]; then
    flags=U
  elif [ -z "${ISHOME[$d]-}" ]; then
    # Outside git a test_/check_/verify_ script cannot be told from a project's own: not reported (agentJunk.js agrees).
    case "${p##*/}" in test[_-]* | check[_-]* | verify[_-]*) continue ;; esac
  fi
  case "$size" in '' | *[!0-9]*) size=- ;; esac
  case "$mt" in '' | *[!0-9]*) mt=- ;; esac
  emit f "$size" "$mt" "$flags" "$p" || break
done
