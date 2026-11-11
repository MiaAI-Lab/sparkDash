# Read-only: evidence for the delete advisor about each path given. Never elevated; changes nothing and writes no
# file. Run with sh.
# $1 minutes that count as "changed recently"  $2 seconds the whole program may take  $3... the paths (absolute,
#    already checked by the dashboard's delete policy, so none holds a newline or another control character).
# Output: KEY=value lines. A path is named by its position (1 = the first path given). Every name the unit reports
# back (a file inside, a program, a container) is hex-encoded, so no byte of it can be mistaken for the format.
#   NOW=<seconds since 1970, the unit's clock>  UID=<uid>  HOME_HEX=<the account's home>
#   PROCS=all|own|failed     whose processes were looked at: every account's, only this account's, or none (no time)
#   DOCKER=ok|missing|denied|down|failed   whether the running containers and their mounts could be listed
#   GIT=ok|old|missing       git is there and new enough (2.35.2: it refuses repositories owned by another account)
#   USE=<i>|<pid>|<how>|<program hex>|<target hex>   a process holds it or something in it: f open file,
#                            c working folder, e the program file itself, m mapped into memory (first five processes)
#   USES=<i>|<processes>
#   MNT=<i>|<relation>|<container hex>|<source hex>|<destination hex>   a running container mounts it ("within": the
#                            mount is it or inside it) or a folder around it ("around") (first five)
#   MNTS=<i>|<mounts>
#   P=<i>|<type>             d, f, l, o, or - (not there)
#   WALK=<i>|<code>          looking through it: 0 complete, 1 something could not be read, 124 out of time,
#                            - not started (no time left)
#   RECENT=<i>|<count>|<newest mtime>|<type>|<relative path hex>   entries changed within $1 minutes; the newest one
#                            (type as find's %y: f file, d folder, l link, ...)
#   PART=<i>|<count>|<relative path hex>   partial-download files (*.incomplete, *.part, ...); the first one
#   CRED=<i>|<count>|<relative path hex>   files that look like private keys or saved logins; the first one
#   REPO=<i>|<relative top hex>|<state>|<changed>|<untracked>|<unpushed>|<remotes>|<stashes>   a git repository in it
#                            (top "." = the path itself; "" = the path is a .git folder). state: ok, refused (owned by
#                            another account), timeout, error, skipped (git missing or too old, too many, no time left)
#   GITDIRS=<i>|<found>|<checked>
#   INREPO=<i>|<top hex>|<relation>|<state>|<changed>|<untracked>|<tracked>|<ignored>   the path is inside a repository:
#                            its work tree ("tree") or its history folder ("history")
export LC_ALL=C
RECENT_MIN=$1
BUDGET=$2
shift 2
TAB=$(printf '\t')
NL='
'
T0=$(date +%s)
DEADLINE=$((T0 + BUDGET))
# Seconds left of the budget (0 when none).
left() {
  l=$((DEADLINE - $(date +%s)))
  [ "$l" -ge 0 ] || l=0
  echo "$l"
}
# At most $1 seconds, and never past the budget (or past PATH_END, the current path's share of it, when set).
PATH_END=""
cap() {
  c=$(left)
  if [ -n "$PATH_END" ]; then
    e=$((PATH_END - $(date +%s)))
    [ "$e" -ge "$c" ] || c=$e
    [ "$c" -ge 0 ] || c=0
  fi
  if [ "$1" -le "$c" ]; then echo "$1"; else echo "$c"; fi
}
hex() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n'; }
num() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }
# Be gentle: the check must not slow down a model that is loading or serving.
LOW=""
command -v nice >/dev/null 2>&1 && LOW="nice -n 10"
command -v ionice >/dev/null 2>&1 && LOW="$LOW ionice -c 2 -n 7"
MAX_REPOS=10
MAX_REPOS_ALL=30

printf 'RESULT=ok\n'
printf 'NOW=%s\n' "$T0"
U=$(id -u 2>/dev/null | tr -cd '0-9')
printf 'UID=%s\n' "$U"
H=$(getent passwd "$U" 2>/dev/null | head -n 1 | cut -d: -f6)
[ -n "$H" ] || H=${HOME-}
printf 'HOME_HEX=%s\n' "$(hex "$H")"

# ─── Which processes and containers hold the paths ───────────────────────────
# Reading another account's open files needs the right to inspect its processes. Reading PID 1's working folder
# proves that right; without it only this account's own processes are seen.
if readlink /proc/1/cwd >/dev/null 2>&1; then SCOPE=all; else SCOPE=own; fi

# The real place of a path: its folder with every symbolic link resolved, plus its own name (a link itself is not
# followed: deleting it leaves its target alone). Nothing when the folder cannot be entered.
realof() {
  d=${1%/*}
  [ -n "$d" ] || d=/
  r=$(cd -P -- "$d" 2>/dev/null && pwd -P) || return 0
  [ "$r" = / ] && r=""
  printf '%s/%s' "$r" "${1##*/}"
}

# "W<TAB>i<TAB>path" for each path, and again for its real place when that differs.
wanted() {
  i=0
  for P in "$@"; do
    i=$((i + 1))
    printf 'W\t%s\t%s\n' "$i" "$P"
    R=$(realof "$P")
    [ -z "$R" ] || [ "$R" = "$P" ] || printf 'W\t%s\t%s\n' "$i" "$R"
  done
}

# Running containers and their mounts: "D<TAB>name<TAB>type<TAB>source<TAB>destination..." (three fields a mount),
# then "K<TAB>state".
containers() {
  command -v docker >/dev/null 2>&1 || { echo "K${TAB}missing"; return 0; }
  L=$(cap 8)
  [ "$L" -ge 1 ] || { echo "K${TAB}failed"; return 0; }
  if ! OUT=$(timeout -k 2 "$L" docker ps -q --no-trunc 2>&1); then
    case "$OUT" in
      *"ermission denied"*) echo "K${TAB}denied" ;;
      *) echo "K${TAB}down" ;;
    esac
    return 0
  fi
  IDS=$(printf '%s\n' "$OUT" | grep -E '^[0-9a-f]{64}$')
  [ -n "$IDS" ] || { echo "K${TAB}ok"; return 0; }
  L=$(cap 8)
  # shellcheck disable=SC2086
  if [ "$L" -ge 1 ] && timeout -k 2 "$L" docker inspect --format '{{"D\t"}}{{.Name}}{{range .Mounts}}{{"\t"}}{{.Type}}{{"\t"}}{{.Source}}{{"\t"}}{{.Destination}}{{end}}' $IDS 2>/dev/null; then
    echo "K${TAB}ok"
  else
    echo "K${TAB}failed"
  fi
}

# Every process's open files (F), working folder and program (X), and mapped files (/proc/<pid>/maps lines), each
# step followed by "E<TAB>exit code" (124 or more: it ran out of time).
processes() {
  L=$(cap 8)
  [ "$L" -ge 1 ] || { echo "E${TAB}124"; return 0; }
  timeout -k 2 "$L" find /proc/[0-9]*/fd -mindepth 1 -maxdepth 1 -printf 'F\t%h\t%l\n' 2>/dev/null
  echo "E${TAB}$?"
  L=$(cap 8)
  [ "$L" -ge 1 ] || { echo "E${TAB}124"; return 0; }
  timeout -k 2 "$L" find /proc/[0-9]*/cwd /proc/[0-9]*/exe -maxdepth 0 -printf 'X\t%p\t%l\n' 2>/dev/null
  echo "E${TAB}$?"
  L=$(cap 8)
  [ "$L" -ge 1 ] || { echo "E${TAB}124"; return 0; }
  timeout -k 2 "$L" grep -s -H ' /' /proc/[0-9]*/maps
  echo "E${TAB}$?"
}

# What processes and containers hold, matched against the paths: a target is held when it is a path or inside one
# (looked up from the target through each folder above it). Prints "H<TAB>i<TAB>pid<TAB>how<TAB>target" (the first
# five processes of a path), "HN<TAB>i<TAB>count", "M<TAB>i<TAB>relation<TAB>name<TAB>source<TAB>destination" (the
# first five), "MN<TAB>i<TAB>count", "PROCS<TAB>ok|failed" and "DOCKER<TAB>state".
MATCH='
BEGIN { FS = "\t"; procs = "ok"; docker = "missing" }
function rest(s, n,   k) { for (k = 0; k < n; k++) s = substr(s, index(s, "\t") + 1); return s }
function up(s) { if (!match(s, /\/[^\/]*$/)) return ""; return RSTART <= 1 ? "" : substr(s, 1, RSTART - 1) }
function holders(t,   s, out) {
  if (t in memo) return memo[t]
  out = ""
  for (s = t; s != ""; s = up(s)) if (s in want) out = out want[s]
  memo[t] = out
  return out
}
function pidof(p,   a) { split(p, a, "/"); return a[3] }
function held(t, pid, how,   list, n, k, i, ids) {
  if (substr(t, 1, 1) != "/") return
  sub(/ \(deleted\)$/, "", t)
  list = holders(t)
  if (list == "") return
  n = split(list, ids, " ")
  for (k = 1; k <= n; k++) {
    i = ids[k]
    if ((i, pid) in seen) continue
    seen[i, pid] = 1
    uses[i]++
    if (uses[i] <= 5) print "H\t" i "\t" pid "\t" how "\t" t
  }
}
function mounted(i, rel, name, src, dst) {
  if ((i, name, src) in mseen) return
  mseen[i, name, src] = 1
  mounts[i]++
  if (mounts[i] <= 5) print "M\t" i "\t" rel "\t" name "\t" src "\t" dst
}
$1 == "W" { p = rest($0, 2); want[p] = want[p] " " $2; next }
$1 == "K" { docker = $2; next }
$1 == "E" { if ($2 + 0 >= 124) procs = "failed"; next }
$1 == "D" {
  name = $2
  sub(/^\//, "", name)
  for (k = 3; k + 2 <= NF; k += 3) {
    src = $(k + 1)
    if (substr(src, 1, 1) != "/") continue
    nm++
    msrc[nm] = src; mname[nm] = name; mdst[nm] = $(k + 2)
    n = split(holders(src), ids, " ")
    for (j = 1; j <= n; j++) mounted(ids[j], "within", name, src, $(k + 2))
  }
  next
}
$1 == "F" { held(rest($0, 2), pidof($2), "f"); next }
$1 == "X" { held(rest($0, 2), pidof($2), ($2 ~ /cwd$/) ? "c" : "e"); next }
/^\/proc\/[0-9]+\/maps:/ {
  c = index($0, ":")
  r = substr($0, c + 1)
  s = index(r, " /")
  if (s) held(substr(r, s + 1), pidof(substr($0, 1, c - 1)), "m")
  next
}
END {
  # A path inside a mounted folder: the container can read it, and usually write it.
  for (q = 1; q <= nm; q++) mpos[msrc[q]] = mpos[msrc[q]] " " q
  for (p in want) {
    n = split(want[p], ids, " ")
    for (s = up(p); s != ""; s = up(s)) {
      if (!(s in mpos)) continue
      m = split(mpos[s], qs, " ")
      for (j = 1; j <= m; j++) for (k = 1; k <= n; k++) mounted(ids[k], "around", mname[qs[j]], msrc[qs[j]], mdst[qs[j]])
    }
  }
  for (i in uses) print "HN\t" i "\t" uses[i]
  for (i in mounts) print "MN\t" i "\t" mounts[i]
  print "PROCS\t" procs
  print "DOCKER\t" docker
}
'

{
  wanted "$@"
  containers
  processes
} | awk "$MATCH" | while IFS="$TAB" read -r k i a b c d; do
  case "$k" in
    H) printf 'USE=%s|%s|%s|%s|%s\n' "$i" "$a" "$b" "$(hex "$(head -c 64 "/proc/$a/comm" 2>/dev/null | tr -d '\n')")" "$(hex "$c")" ;;
    HN) printf 'USES=%s|%s\n' "$i" "$a" ;;
    M) printf 'MNT=%s|%s|%s|%s|%s\n' "$i" "$a" "$(hex "$b")" "$(hex "$c")" "$(hex "$d")" ;;
    MN) printf 'MNTS=%s|%s\n' "$i" "$a" ;;
    PROCS) if [ "$i" = failed ]; then printf 'PROCS=failed\n'; else printf 'PROCS=%s\n' "$SCOPE"; fi ;;
    DOCKER) printf 'DOCKER=%s\n' "$i" ;;
  esac
done

# ─── What is inside each path ────────────────────────────────────────────────
GIT=missing
if command -v git >/dev/null 2>&1; then
  GIT=$(git --version 2>/dev/null | awk '{ split($3, v, "."); print (v[1] > 2 || (v[1] == 2 && (v[2] > 35 || (v[2] == 35 && v[3] >= 2)))) ? "ok" : "old" }')
  [ -n "$GIT" ] || GIT=old
fi
printf 'GIT=%s\n' "$GIT"

# git, read-only and safely: no fsmonitor, no hooks, no optional index writes, no prompts, paths taken literally. A
# repository owned by another account is refused by git itself (safe.directory); that refusal is reported, never
# overridden.
g() {
  L=$(cap 10)
  [ "$L" -ge 1 ] || return 124
  GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1 timeout -k 2 "$L" \
    git -C "$TOPDIR" -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}
# Uncommitted changes in $TOPDIR as "ok <changed> <untracked>" (any arguments narrow it to a path inside), or the
# reason they could not be told: refused, timeout or error.
git_changes() {
  OUT=$(g status --porcelain=v1 --untracked-files=normal --ignore-submodules=all "$@" 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$OUT" in
      *"dubious ownership"*) echo refused ;;
      *) if [ "$rc" -ge 124 ]; then echo timeout; else echo error; fi ;;
    esac
    return 0
  fi
  echo "ok $(printf '%s\n' "$OUT" | grep -c '^[MTADRCU ][MTADRCU ] ') $(printf '%s\n' "$OUT" | grep -c '^?? ')"
}

REPOS_ALL=0
i=0
for P in "$@"; do
  i=$((i + 1))
  if [ -L "$P" ]; then T=l; elif [ -d "$P" ]; then T=d; elif [ -f "$P" ]; then T=f; elif [ -e "$P" ]; then T=o; else T=-; fi
  printf 'P=%s|%s\n' "$i" "$T"
  [ "$T" != - ] || continue
  # This path's share of what is left: the paths still to look at split it evenly (one that needs less leaves the
  # rest to those after it), so a slow folder cannot use up their time.
  L=$(left)
  PATH_END=$(($(date +%s) + L / ($# - i + 1)))

  # Inside a repository: its work tree, or its history folder (.git). Found by looking for .git in each folder above.
  TOPDIR=""
  REL=""
  REL_KIND=tree
  case "$P" in
    */.git)
      # The history folder itself: reported with the repositories found in it below.
      ;;
    */.git/*)
      TOPDIR=${P%%/.git/*}
      REL_KIND=history
      ;;
    *)
      d=${P%/*}
      while [ -n "$d" ]; do
        if [ -e "$d/.git" ]; then TOPDIR=$d; break; fi
        d=${d%/*}
      done
      ;;
  esac
  if [ -n "$TOPDIR" ]; then
    if [ "$GIT" != ok ] || [ "$(cap 1)" -lt 1 ]; then
      printf 'INREPO=%s|%s|%s|skipped|0|0|0|0\n' "$i" "$(hex "$TOPDIR")" "$REL_KIND"
    elif [ "$REL_KIND" = history ]; then
      # Part of the history itself: deleting it can break the repository whatever its state.
      printf 'INREPO=%s|%s|history|ok|0|0|0|0\n' "$i" "$(hex "$TOPDIR")"
    else
      REL=${P#"$TOPDIR"/}
      R=$(git_changes -- "$REL")
      ST=${R%% *}
      CH=0 UT=0 TR=0 IG=0
      if [ "$ST" = ok ]; then
        R=${R#ok }
        CH=$(num "${R%% *}")
        UT=$(num "${R#* }")
        [ -n "$(g ls-files -- "$REL" 2>/dev/null | head -n 1)" ] && TR=1
        g check-ignore -q -- "$REL" >/dev/null 2>&1 && IG=1
      fi
      printf 'INREPO=%s|%s|tree|%s|%s|%s|%s|%s\n' "$i" "$(hex "$TOPDIR")" "$ST" "$CH" "$UT" "$TR" "$IG"
    fi
  fi

  # One walk through it: git folders (G, not entered), partial downloads (I), files that look like keys or saved
  # logins (C), entries changed within RECENT_MIN minutes (R), then "E<TAB>exit code". Other filesystems are not
  # entered (-xdev): a delete does not cross into them either.
  # Two thirds of the share for the walk, the rest for the git checks after it.
  L=$(cap 100000)
  if [ "$L" -lt 1 ]; then
    printf 'WALK=%s|-\n' "$i"
    printf 'GITDIRS=%s|0|0\n' "$i"
    continue
  fi
  SHARE=$((L * 2 / 3))
  [ "$SHARE" -ge 1 ] || SHARE=1
  WALKOUT=$(
    {
      # shellcheck disable=SC2086
      timeout -k 2 "$SHARE" $LOW find "$P" -xdev \( -name .git -printf 'G\t%P\n' -prune \) -o \( \
        \( -type f \( -name '*.incomplete' -o -name '*.part' -o -name '*.partial' -o -name '*.crdownload' -o -name '*.aria2' \) -printf 'I\t%P\n' \) , \
        \( \( -name id_rsa -o -name id_dsa -o -name id_ecdsa -o -name id_ed25519 -o -name id_ecdsa_sk -o -name id_ed25519_sk \
        -o -name .netrc -o -name .git-credentials -o -name .pgpass -o -path '*/.aws/credentials' -o -path '*/.docker/config.json' \
        -o -path '*/.kube/config' -o -path '*/gh/hosts.yml' -o -path '*/huggingface/token' -o -path '*/huggingface/stored_tokens' \
        -o -path '*/.gnupg/private-keys-v1.d' \) -printf 'C\t%P\n' \) , \
        \( -mmin "-$RECENT_MIN" -printf 'R\t%T@\t%y\t%P\n' \) \) 2>/dev/null
      printf 'E\t%s\n' "$?"
    } | awk -F '\t' -v max="$MAX_REPOS_ALL" '
      function rest(s, n,   k) { for (k = 0; k < n; k++) s = substr(s, index(s, "\t") + 1); return s }
      $1 == "G" { if (g < max) print "G\t/" rest($0, 1); g++; next }
      $1 == "I" { if (!ni) it = rest($0, 1); ni++; next }
      $1 == "C" { if (!nc) ct = rest($0, 1); nc++; next }
      $1 == "R" { t = $2 + 0; if (!nr || t > rt) { rt = t; ry = $3; rp = rest($0, 3) } nr++; next }
      $1 == "E" { rc = $2; next }
      END {
        print "S\t" (rc == "" ? 124 : rc) "\t" g + 0 "\t" ni + 0 "\t" nc + 0 "\t" nr + 0 "\t" int(rt)
        if (ni) print "I\t" it
        if (nc) print "C\t" ct
        if (nr) print "R\t" ry "\t" rp
      }'
  )
  FOUND=0
  REPOLIST=""
  while IFS="$TAB" read -r k a b c d e f; do
    case "$k" in
      S)
        # timeout's own exit codes: 124 (out of time), 137 (killed after it). find: 0, or 1 when something could
        # not be read (or vanished while it looked).
        if [ "$(num "$a")" -ge 124 ]; then a=124; elif [ "$a" != 0 ]; then a=1; fi
        printf 'WALK=%s|%s\n' "$i" "$a"
        FOUND=$(num "$b") W_I=$c W_C=$d W_R=$e W_RT=$f
        ;;
      G) REPOLIST="$REPOLIST$a$NL" ;;
      I) printf 'PART=%s|%s|%s\n' "$i" "$W_I" "$(hex "$a")" ;;
      C) printf 'CRED=%s|%s|%s\n' "$i" "$W_C" "$(hex "$a")" ;;
      R) printf 'RECENT=%s|%s|%s|%s|%s\n' "$i" "$W_R" "$W_RT" "$(printf '%s' "$a" | tr -cd 'a-z')" "$(hex "$b")" ;;
    esac
  done <<EOF
$WALKOUT
EOF

  # Each repository is the folder holding a .git; when the path itself is a .git folder, its history.
  CHECKED=0
  SKIPPED=0
  OLDIFS=$IFS
  # Split the list on newlines only, and never expand a name like "a*" against the current folder.
  set -f
  IFS=$NL
  for GD in $REPOLIST; do
    IFS=$OLDIFS
    # Each line is "/" and the .git entry's path inside P: "/" alone means P is that .git folder.
    GD=${GD#/}
    case "$GD" in
      "") TOPREL=""; TOPDIR=${P%/*} ;;
      */*) TOPREL=${GD%/*}; TOPDIR=$P/$TOPREL ;;
      *) TOPREL=.; TOPDIR=$P ;;
    esac
    if [ "$GIT" != ok ] || [ "$CHECKED" -ge "$MAX_REPOS" ] || [ "$REPOS_ALL" -ge "$MAX_REPOS_ALL" ] || [ "$(cap 1)" -lt 1 ]; then
      # Not checked: named while there is room (GITDIRS says how many were found in all).
      SKIPPED=$((SKIPPED + 1))
      [ "$((CHECKED + SKIPPED))" -gt "$MAX_REPOS" ] || printf 'REPO=%s|%s|skipped|0|0|0|0|0\n' "$i" "$(hex "$TOPREL")"
      IFS=$NL
      continue
    fi
    CHECKED=$((CHECKED + 1))
    REPOS_ALL=$((REPOS_ALL + 1))
    R=$(git_changes)
    ST=${R%% *}
    CH=0 UT=0 UP=0 RM=0 SS=0
    if [ "$ST" = ok ]; then
      R=${R#ok }
      CH=$(num "${R%% *}")
      UT=$(num "${R#* }")
      # Commits on a branch, or on a detached HEAD, that no remote-tracking branch holds: never pushed, as far as
      # this copy knows (its last fetch). Without any remote, every commit is only here.
      A=$(g rev-list --count --branches --not --remotes 2>/dev/null)
      B=$(g rev-list --count HEAD --not --branches --remotes 2>/dev/null)
      UP=$(($(num "$A") + $(num "$B")))
      RM=$(num "$(g remote 2>/dev/null | grep -c .)")
      SS=$(num "$(g rev-list --walk-reflogs --count refs/stash 2>/dev/null)")
    fi
    printf 'REPO=%s|%s|%s|%s|%s|%s|%s|%s\n' "$i" "$(hex "$TOPREL")" "$ST" "$CH" "$UT" "$UP" "$RM" "$SS"
    IFS=$NL
  done
  IFS=$OLDIFS
  set +f
  printf 'GITDIRS=%s|%s|%s\n' "$i" "$FOUND" "$CHECKED"
done
exit 0
