# Recovery records of delete v2 ("Needs attention"). $1-$3: the acting account (uid, gid, home), worked out
# before any sudo. $4: list | restore | delete | forget. $5: the record id. $6: 1 when deleting folders as
# administrator is acknowledged for this Spark. $7: protected paths, one per line. $8 (restore): the original
# path the dashboard checked against its policy. $9 (restore): folders nothing may be put back into.
#
# list: every record, with what is on disk now (see sdhelper.pl mlist). Changes nothing.
# restore: rename the staged item back to its original path (no-replace; a taken name is refused and the
#   item stays), then drop the record. delete: check the staged item exactly like delete.sh, rm it, then drop
#   the record. When the staged item is no longer there, either action only drops the record: neither ever
#   touches the original path except to rename the staged item back onto a free name.
# forget: drop a record whose item is no longer staged; refused (payload-present) when anything is at the
#   recorded staging place, so dismissing a record can never delete anything.
# restore and delete only work in SparkDash's own staging folders (~/.local/state/sparkdash/staging, or
#   <top of a filesystem>/.sparkdash-staging-<uid>), pinned exactly as delete.sh pins them.
export LC_ALL=C
umask 077
ACCT_UID=$1 ACCT_GID=$2 ACCT_HOME=$3 ACTION=$4 ID=${5-} ACK=${6-0} PROT=${7-} EXPECT=${8-} TREES=${9-}
case $ACCT_UID$ACCT_GID in '' | *[!0-9]*) fail bad-path "The account on this Spark could not be identified" ;; esac
command -v perl >/dev/null 2>&1 || fail no-perl "Perl is not installed on this Spark."
PRIV=0
[ "$(id -u)" = 0 ] && PRIV=1
ELEV=false
[ "$PRIV" = 1 ] && [ "$ACCT_UID" != 0 ] && ELEV=true
H=$(sd_home)
[ -n "$H" ] || { [ "$ACTION" = list ] && { printf 'RESULT=ok\n'; exit 0; }; fail not-found "No recovery records on this Spark"; }
QDIR="$H/.local/state/sparkdash/quarantine"

if [ "$ACTION" = list ]; then
  [ -d "$QDIR" ] || { printf 'RESULT=ok\n'; exit 0; }
  sd_enter "$QDIR" 0 || fail quarantine-unavailable "The recovery records cannot be read safely: $SD_WHY"
  OUT=$(sd_pl mlist)
  printf 'RESULT=ok\n%s\n' "$OUT"
  exit 0
fi

case $ACTION in restore | delete | forget) ;; *) fail bad-path "Unknown action" ;; esac
case $ID in '' | *[!0-9a-f-]*) fail bad-path "Bad record id" ;; esac
[ -d "$QDIR" ] || fail not-found "This item is no longer listed"
sd_enter "$QDIR" 0 || fail quarantine-unavailable "The recovery records cannot be read safely: $SD_WHY"
exec 5<.
[ -f "./$ID.json" ] || fail not-found "This item is no longer listed"
M=$(sd_pl mget "$ID.json") || fail quarantine-unavailable "The recovery record cannot be read"
# One value per line: state, original, stagingDir, stagingDevIno, targetDevIno, type, elevated, createdAt.
line() { printf '%s\n' "$M" | sed -n "$1p"; }
ORIG=$(line 2) SDIR=$(line 3) SDI=$(line 4) T_ID=$(line 5)

if [ "$ACTION" = forget ]; then
  sd_pl absent "$SDIR/$ID"
  case $? in
    0) ;;
    1) fail payload-present "Something is in the staging folder for this item ($SDIR/$ID), so its record was kept. Look at the list again: it can be put back or deleted." ;;
    *) fail payload-present "The staging folder for this item cannot be checked, so its record was kept." ;;
  esac
  sd_mrm || fail quarantine-unavailable "The recovery record could not be removed"
  printf 'RESULT=ok\nOUTCOME=forgotten\n'
  exit 0
fi

# The record must point into one of SparkDash's own staging folders.
HOME_STAGE="$H/.local/state/sparkdash/staging"
valid_sdir() {
  [ "$SDIR" = "$HOME_STAGE" ] && return 0
  case ${SDIR##*/} in ".sparkdash-staging-$ACCT_UID") ;; *) return 1 ;; esac
  top=${SDIR%/*}
  [ -n "$top" ] || top=/
  [ "$(sd_pl mountof "$SDIR")" = "$top" ]
}
valid_sdir || fail bad-record "This record points outside SparkDash's staging folders ($SDIR), so nothing was changed. Check it by hand."

# Drop the record when there is nothing staged any more.
nothing_staged() {
  sd_mrm || fail quarantine-unavailable "The recovery record could not be removed"
  O=$(sd_pl id "$ORIG" | cut -f1)
  if [ "$O" = "$T_ID" ]; then printf 'RESULT=ok\nOUTCOME=in-place\n'; else printf 'RESULT=ok\nOUTCOME=gone\n'; fi
  exit 0
}

{ [ -e "$SDIR" ] || [ -L "$SDIR" ]; } || nothing_staged
sd_enter "$SDIR" 0 || fail quarantine-unavailable "The staging folder cannot be used safely ($SD_WHY), so nothing was changed."
[ "$SD_DI" = "$SDI" ] || fail changed "The staging folder $SDIR was replaced, so nothing was changed. Check it by hand."
exec 4<.
{ [ -e "./$ID" ] || [ -L "./$ID" ]; } || nothing_staged
CUR=$(sd_pl id "./$ID")
[ "$(printf '%s' "$CUR" | cut -f1)" = "$T_ID" ] ||
  fail changed "Something else is in the staging folder under this name ($SDIR/$ID), so nothing was changed. Check it by hand."
S_TYPE=$(printf '%s' "$CUR" | cut -f2)
sd_rename_ready || fail staging-unavailable "Moving it back is not possible on this Spark: $SD_WHY"

if [ "$ACTION" = restore ]; then
  # The destination: the path the dashboard checked against its policy, never a protected place.
  [ -n "$EXPECT" ] && [ "$EXPECT" = "$ORIG" ] || fail changed "The record does not match what the dashboard checked, so nothing was put back."
  PAR=${ORIG%/*}
  [ -n "$PAR" ] || PAR=/
  BASE=${ORIG##*/}
  case $BASE in '' | . | ..) fail bad-record "The record's original path cannot be used, so nothing was put back." ;; esac
  case "$ORIG/" in
    */.ssh/* | */.sparkdash-staging-*/* | "$H/.local/state/sparkdash/"*) fail protected "It cannot be put back there: $ORIG is a protected place." ;;
  esac
  cd -P -- "$PAR" 2>/dev/null || fail parent-missing "The folder it came from ($PAR) is gone. Create it again, then put the item back."
  [ "$(pwd -P)" = "$PAR" ] || fail symlinked-path "The folder it came from ($PAR) is now reached through a symbolic link, so it was not put back."
  exec 3<.
  INTO=$(printf '%s\n' "$TREES" | sd_pl ids trees | sd_pl within "$PAR")
  [ -n "$INTO" ] && fail protected "It cannot be put back there: $PAR is inside $INTO, which is never changed from here."
  cd -P /proc/self/fd/4 2>/dev/null || fail rm-failed "The staging folder cannot be opened again"
  # Only the item that was staged goes back: anything else under its staging name stays where it is.
  if [ "$(sd_pl id "./$ID" | cut -f1)" != "$T_ID" ]; then
    sd_mput state=conflict reason="Something else now has its staging name, so nothing was put back."
    fail changed "Something else now has its staging name ($SDIR/$ID), so nothing was put back. Check it by hand."
  fi
  if sd_rn . "$ID" 3 "$BASE"; then
    sd_mrm
    printf 'RESULT=ok\nOUTCOME=restored\n'
    exit 0
  fi
  case $SD_ERR in
    EEXIST)
      sd_mput state=conflict reason="Something new is at the original path, so it was not put back."
      fail restore-conflict "Something new is now at $ORIG. Rename or remove it, then put this item back."
      ;;
    EXDEV) fail restore-failed "The folder it came from is on another disk now, so it cannot be moved back." ;;
    EACCES | EPERM) fail permission "This account may not move it back. Try as administrator." ;;
    *) fail restore-failed "It could not be moved back ($SD_ERR)." ;;
  esac
fi

# delete: the same checks as delete.sh, on the staged item, then rm.
if [ "$ELEV" = true ] && [ "$S_TYPE" = d ] && [ "$ACK" != 1 ]; then
  fail no-ack "Deleting folders as administrator is not turned on for this Spark. Confirm it first."
fi
PROTIDS=$(sd_protids)
R=$(printf '%s\n' "$PROTIDS" | sd_pl check "$ID" "$T_ID" "$PRIV" "$ACCT_UID" "$SD_XNR" | head -n 1)
case $R in
  OK) ;;
  REFUSE*) fail "$(printf '%s' "$R" | cut -f2)" "$(printf '%s' "$R" | cut -f3)" ;;
  *) fail rm-failed "The item could not be checked before deleting it" ;;
esac
sd_mput state=deleting || fail quarantine-unavailable "The recovery record could not be saved"
ERRF=/dev/null
if F=$(mktemp 2>/dev/null); then
  ERRF=$F
  trap 'rm -f "$ERRF"' EXIT
fi
if rm -rf --one-file-system -- "./$ID" 2>"$ERRF" && [ ! -e "./$ID" ] && [ ! -L "./$ID" ]; then
  sd_mrm
  printf 'RESULT=ok\nOUTCOME=deleted\n'
  exit 0
fi
printf 'RESULT=error\nCODE=%s\nMSG=%s\nREMAINS=1\n' "$(sd_rm_code "$ERRF")" "$(clean "$(head -n 1 "$ERRF" 2>/dev/null)")"
