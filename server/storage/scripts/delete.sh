# Delete one file or folder, permanently (delete v2: stage, check, then delete).
# $1-$3: the acting account (uid, gid, home), worked out before any sudo. $4: the path, already checked by
# the dashboard. $5: an id for the recovery record. $6: 1 when this Spark's owner acknowledged that deleting
# folders as administrator treats the account as root-equivalent. $7: protected paths, one per line.
#
# 1. cd -P into the folder holding the item and hold it open (fd 3); a symbolic link in the path is refused.
# 2. Pick a private staging folder on the same filesystem (fd 4); write the recovery record (fd 5), fsynced.
# 3. Rename the item into the staging folder (no-replace). Path swaps above it no longer matter.
# 4. Check the staged tree: still the same item, no mount points (bind mounts too), nothing protected inside
#    and, as root, nothing in it another account can write to.
# 5. rm --one-file-system it. On a refusal it is renamed back; if its name was taken meanwhile it stays
#    staged and the record lists it under "Needs attention".
# Where staging is impossible, a delete as the account itself checks the item in place (pinned parent);
# a delete as root is refused.
export LC_ALL=C
umask 077
ACCT_UID=$1 ACCT_GID=$2 ACCT_HOME=$3 P=$4 ID=${5-} ACK=${6-0} PROT=${7-}
case $ACCT_UID$ACCT_GID in '' | *[!0-9]*) fail bad-path "The account on this Spark could not be identified" ;; esac
case $P in /?*) ;; *) fail bad-path "The path must be absolute" ;; esac
[ -n "$ID" ] || ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null)
case $ID in '' | *[!0-9a-f-]*) fail bad-path "Bad operation id" ;; esac
command -v perl >/dev/null 2>&1 || fail no-perl "Perl is not installed on this Spark, so it cannot be deleted safely from here."
PRIV=0
[ "$(id -u)" = 0 ] && PRIV=1
ELEV=false
[ "$PRIV" = 1 ] && [ "$ACCT_UID" != 0 ] && ELEV=true
H=$(sd_home)
ERRF=/dev/null

PAR=${P%/*}
[ -n "$PAR" ] || PAR=/
BASE=${P##*/}
case $BASE in '' | . | ..) fail bad-path "This cannot be deleted from here" ;; esac
if ! cd -P -- "$PAR" 2>/dev/null; then
  [ -d "$PAR" ] && fail permission "This account cannot open the folder that holds this item"
  fail not-found "That item is already gone from the Spark"
fi
[ "$(pwd -P)" = "$PAR" ] || fail symlinked-path "This path goes through a symbolic link. Open the real folder and delete it from there."
exec 3<. || fail permission "This account cannot open the folder that holds this item"
T=$(sd_pl id "./$BASE") || fail not-found "That item is already gone from the Spark"
T_ID=$(printf '%s' "$T" | cut -f1)
T_TYPE=$(printf '%s' "$T" | cut -f2)
if [ "$PAR" = / ]; then ABS="/$BASE"; else ABS="$PAR/$BASE"; fi
# Kept items and their records are only ever handled through quarantine.sh, never deleted around their record.
case "$ABS/" in */.sparkdash-staging-*/*) fail protected "This is SparkDash's own recovery area. Use Needs attention on the Storage page." ;; esac
if [ -n "$H" ]; then
  case "$ABS/" in "$H/.local/state/sparkdash/"*) fail protected "This is SparkDash's own recovery area. Use Needs attention on the Storage page." ;; esac
fi

MNT=$(sd_pl mnt "$BASE" | head -n 1)
if [ "$MNT" = "$ABS" ]; then
  fail mountpoint "This is a separate disk or mount point, not a folder. It cannot be deleted from here."
elif [ -n "$MNT" ]; then
  fail mountpoint "It contains a separate disk or mount point ($MNT), so it cannot be deleted from here. Unmount it first."
fi
if [ "$ELEV" = true ] && [ "$T_TYPE" = d ] && [ "$ACK" != 1 ]; then
  fail no-ack "Deleting folders as administrator is not turned on for this Spark. Confirm it first."
fi
# Protected identities, and a refusal before anything moves when one of them is this item or inside it.
PROTIDS=$(sd_protids)
INSIDE=$(printf '%s\n' "$PROTIDS" | sd_pl under "$ABS")
case $INSIDE in
  SELF*) fail protected "This is $(printf '%s' "$INSIDE" | cut -f2), which is never deleted from here." ;;
  IN*) fail protected-descendant "It contains $(printf '%s' "$INSIDE" | cut -f2), which is never deleted from here." ;;
esac

# rm's messages, for the error code.
if F=$(mktemp 2>/dev/null); then
  ERRF=$F
  trap 'rm -f "$ERRF"' EXIT
fi

# Report a refusal after the item was staged: put it back where it was (no-replace). If that name is
# taken now, the item stays staged and its record says why, so the page lists it under "Needs attention".
put_back() {
  code=$1 msg=$2 remains=${3-0}
  cd -P /proc/self/fd/4 2>/dev/null
  # Only the item that was staged goes back: anything else under its staging name stays where it is.
  now=$(sd_pl id "./$ID" | cut -f1)
  if [ "$now" = - ]; then
    sd_mrm
    printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=%s\n' "$code" "$msg It was no longer in the staging folder, so it could not be put back." "$remains"
    exit 0
  fi
  if [ "$now" != "$T_ID" ]; then
    why="Something else now has its staging name, so nothing was put back"
    sd_mput state=conflict reason="$why. $msg"
    printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=%s\nQID=%s\n' "$code" "$msg $why; it is kept under Needs attention." "$remains" "$ID"
    exit 0
  fi
  if sd_rn . "$ID" 3 "$BASE"; then
    sd_mrm
    if [ "$remains" = 1 ]; then printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=1\n' "$code" "$msg"; else fail "$code" "$msg"; fi
    exit 0
  fi
  why="Its name is in use again, so it was not put back"
  [ "$SD_ERR" = EEXIST ] || why="It could not be put back ($SD_ERR)"
  sd_mput state=conflict reason="$why. $msg"
  printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=%s\nQID=%s\n' "$code" "$msg $why; it is kept under Needs attention." "$remains" "$ID"
  exit 0
}

# Try one staging folder. 0: staged. 1: not here (SD_WHY), try the next. 2: staging cannot work for this item.
STAGED=''
try_stage() {
  sdir=$1 kind=$2 create=$3
  sd_enter "$sdir" "$create" || return 1
  exec 4<. || { SD_WHY="$sdir cannot be opened"; return 1; }
  SD_ID=$SD_DI
  sd_rename_ready || return 1
  sd_mput version=1 id="$ID" state=staging original="$ABS" stagingDir="$sdir" staged="$sdir/$ID" stagingDevIno="$SD_ID" \
    targetDevIno="$T_ID" parentDevIno="$PAR_ID" type="$T_TYPE" elevated="$ELEV" uid="$ACCT_UID" createdAt="$(date +%s)" ||
    { SD_WHY='the recovery record could not be saved'; return 2; }
  if sd_rn 3 "$BASE" . "$ID"; then
    STAGED=$kind
    return 0
  fi
  sd_mrm
  case $SD_ERR in
    ENOENT) fail not-found "That item is already gone from the Spark" ;;
    EBUSY) fail mountpoint "This is a separate disk or mount point, or in use by the system. It cannot be deleted from here." ;;
    EXDEV) SD_WHY="$sdir is on another filesystem"; return 1 ;;
    EACCES | EPERM) SD_WHY='this account may not move it'; return 2 ;;
    EROFS) fail readonly "The disk is read-only" ;;
    *) SD_WHY="it could not be moved ($SD_ERR)"; return 2 ;;
  esac
}

PAR_ID=$(sd_pl id . | cut -f1)
QDIR=''
[ -n "$H" ] && QDIR="$H/.local/state/sparkdash/quarantine"
WHY='the account has no home folder for the recovery record'
if [ -n "$QDIR" ] && sd_enter "$QDIR" 4; then
  exec 5<.
  MP=$(sd_pl mountof "$PAR")
  HOME_STAGE="$H/.local/state/sparkdash/staging"
  if [ "$MP" = / ]; then TOP_STAGE="/.sparkdash-staging-$ACCT_UID"; else TOP_STAGE="$MP/.sparkdash-staging-$ACCT_UID"; fi
  # The home filesystem stages under the home folder only; another filesystem at its own top folder.
  if [ "$(sd_pl mountof "$H")" = "$MP" ]; then set -- "$HOME_STAGE home 4"; else set -- "$TOP_STAGE topdir 1"; fi
  for c in "$@"; do
    # Each candidate is "<path> <kind> <folders it may create>"; the path is the part before the last two words.
    n=${c##* } r=${c% *}
    k=${r##* } d=${r% *}
    try_stage "$d" "$k" "$n"
    rc=$?
    WHY=$SD_WHY
    [ "$rc" = 1 ] && continue
    break
  done
else
  [ -n "$QDIR" ] && WHY="the recovery record folder is not private ($SD_WHY)"
fi

if [ -z "$STAGED" ]; then
  if [ "$PRIV" = 1 ]; then
    fail staging-unavailable "Deleting as administrator needs a private staging folder on the same disk, and none can be used here ($WHY)."
  fi
  # Pinned parent: check the item where it is, then delete ./name relative to the held folder.
  cd -P /proc/self/fd/3 2>/dev/null || fail rm-failed "The folder that holds this item cannot be opened again"
  [ "$(sd_pl id . | cut -f1)" = "$PAR_ID" ] || fail changed "The folder changed while it was being deleted, so nothing was deleted."
  R=$(printf '%s\n' "$PROTIDS" | sd_pl check "$BASE" "$T_ID" 0 "$ACCT_UID" "$SD_XNR" | head -n 1)
  case $R in
    OK) ;;
    REFUSE*) fail "$(printf '%s' "$R" | cut -f2)" "$(printf '%s' "$R" | cut -f3)" ;;
    *) fail rm-failed "The item could not be checked before deleting it" ;;
  esac
  if rm -rf --one-file-system -- "./$BASE" 2>"$ERRF"; then
    printf 'RESULT=ok\nSTAGED=none\n'
    exit 0
  fi
  LEFT=0
  { [ -e "./$BASE" ] || [ -L "./$BASE" ]; } && LEFT=1
  printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=%s\n' "$(sd_rm_code "$ERRF")" "$(clean "$(head -n 1 "$ERRF" 2>/dev/null)")" "$LEFT"
  exit 0
fi

# Staged: everything below works on ./$ID in the held staging folder.
cd -P /proc/self/fd/4 2>/dev/null || put_back rm-failed "The staging folder cannot be opened again"
sd_mput state=staged || put_back rm-failed "The recovery record could not be saved"
S=$(sd_pl id "./$ID" | cut -f2)
R=$(printf '%s\n' "$PROTIDS" | sd_pl check "$ID" "$T_ID" "$PRIV" "$ACCT_UID" "$SD_XNR" | head -n 1)
case $R in
  OK) ;;
  REFUSE*)
    code=$(printf '%s' "$R" | cut -f2)
    msg=$(printf '%s' "$R" | cut -f3)
    if [ "$PRIV" = 1 ] && [ "$code" = tree-writable-by-others ]; then
      msg="$msg As administrator, only folders nobody else can change are deleted from here."
    fi
    put_back "$code" "$msg"
    ;;
  *) put_back rm-failed "The item could not be checked before deleting it" ;;
esac
if [ "$ELEV" = true ] && [ "$S" = d ] && [ "$ACK" != 1 ]; then
  put_back no-ack "Deleting folders as administrator is not turned on for this Spark. Confirm it first."
fi
sd_mput state=deleting || put_back rm-failed "The recovery record could not be saved"
if rm -rf --one-file-system -- "./$ID" 2>"$ERRF" && [ ! -e "./$ID" ] && [ ! -L "./$ID" ]; then
  sd_mrm
  printf 'RESULT=ok\nSTAGED=%s\nRENAME=%s\n' "$STAGED" "$SD_RN"
  exit 0
fi
# Some of it may be gone: what is left goes back to its place.
put_back "$(sd_rm_code "$ERRF")" "$(clean "$(head -n 1 "$ERRF" 2>/dev/null)")" 1
