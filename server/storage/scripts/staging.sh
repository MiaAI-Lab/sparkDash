# Shared by delete.sh and quarantine.sh (delete v2). $SD_PL (sdhelper.pl) is defined in front of this file.
#
# Rename primitive: rename-only and no-replace, one implementation for staging, putting back and restore.
# renameat2(RENAME_NOREPLACE) through perl's syscall, or `mv -n --no-copy -T` when that is unavailable; each
# is used only after a self-test in the folder it will work in. Nothing ever falls back to copy-and-delete.
#
# Descriptors: 3 = the folder holding the item, 4 = the staging folder, 5 = the recovery records folder.
# Each is opened right after `cd -P` into a folder whose path and dev:ino were checked, and every later step
# uses the descriptor or the working directory, never the absolute path again.
sd_pl() { perl -e "$SD_PL" -- "$@"; }

# renameat2 and lgetxattr system call numbers for this machine, or empty.
case $(uname -m 2>/dev/null) in
  aarch64 | arm64) SD_NR=276 SD_XNR=9 ;;
  x86_64 | amd64) SD_NR=316 SD_XNR=192 ;;
  *) SD_NR='' SD_XNR='' ;;
esac

SD_WHY=''
# sd_enter <path> <max folders to create>: make sure <path> is a private folder no other account can rename
# or replace (see sdhelper.pl pin), then cd into it and check it is what was checked.
sd_enter() {
  SD_DI=$(sd_pl pin "$1" "$ACCT_UID" "$ACCT_GID" "$2") || { SD_WHY=$SD_DI; return 1; }
  cd -P -- "$1" 2>/dev/null || { SD_WHY="$1 cannot be opened"; return 1; }
  [ "$(pwd -P)" = "$1" ] || { SD_WHY="$1 moved while it was being opened"; return 1; }
  [ "$(sd_pl id . | cut -f1)" = "$SD_DI" ] || { SD_WHY="$1 changed while it was being opened"; return 1; }
  return 0
}

# Which primitive works in the working directory: SD_RN=perl|mv, or return 1 with SD_WHY.
sd_rename_ready() {
  SD_RN=''
  if [ -n "$SD_NR" ] && sd_pl selftest "$SD_NR" >/dev/null 2>&1; then
    SD_RN=perl
    return 0
  fi
  SD_MT=.sparkdash-mvtest-$$
  rm -f "$SD_MT-a" "$SD_MT-b" "$SD_MT-c" 2>/dev/null
  if printf a >"$SD_MT-a" && printf b >"$SD_MT-b" &&
    ! mv -n --no-copy -T -- "$SD_MT-a" "$SD_MT-b" 2>/dev/null && [ -e "$SD_MT-a" ] && [ "$(cat "$SD_MT-b")" = b ] &&
    mv -n --no-copy -T -- "$SD_MT-a" "$SD_MT-c" 2>/dev/null && [ ! -e "$SD_MT-a" ] && [ -e "$SD_MT-c" ]; then
    SD_RN=mv
  fi
  rm -f "$SD_MT-a" "$SD_MT-b" "$SD_MT-c" 2>/dev/null
  [ -n "$SD_RN" ] && return 0
  SD_WHY='renaming without replacing is not available here'
  return 1
}

# sd_rn <from dir: . or descriptor> <name> <to dir> <name>: 0 when renamed, else 1 with SD_ERR=EEXIST|EXDEV|...
sd_rn() {
  SD_ERR=''
  if [ "$SD_RN" = perl ]; then
    SD_ERR=$(sd_pl rn "$SD_NR" "$1" "$2" "$3" "$4") && return 0
    [ -n "$SD_ERR" ] || SD_ERR=EIO
    return 1
  fi
  if [ "$1" = . ]; then SD_F="./$2"; else SD_F="/proc/self/fd/$1/$2"; fi
  if [ "$3" = . ]; then SD_T="./$4"; else SD_T="/proc/self/fd/$3/$4"; fi
  if SD_O=$(mv -n --no-copy -T -- "$SD_F" "$SD_T" 2>&1); then
    { [ -e "$SD_T" ] || [ -L "$SD_T" ]; } && return 0
    SD_ERR=EIO
    return 1
  fi
  case $SD_O in
    *"not replacing"* | *"File exists"*) SD_ERR=EEXIST ;;
    *"cross-device"*) SD_ERR=EXDEV ;;
    *"Permission denied"*) SD_ERR=EACCES ;;
    *"not permitted"*) SD_ERR=EPERM ;;
    *"No such file"*) SD_ERR=ENOENT ;;
    *"busy"*) SD_ERR=EBUSY ;;
    *"Read-only"*) SD_ERR=EROFS ;;
    *) SD_ERR=EIO ;;
  esac
  return 1
}

# The recovery record for $ID, merged with key=value pairs. Durable (fsynced) when it returns 0.
sd_mput() { (cd -P /proc/self/fd/5 && sd_pl mput "$ID.json" "$ACCT_UID" "$ACCT_GID" updatedAt="$(date +%s)" "$@") >/dev/null 2>&1; }
sd_mrm() { (cd -P /proc/self/fd/5 && sd_pl mrm "$ID.json") >/dev/null 2>&1; }

# Identities never deleted from here, as "dev:ino<TAB>label" lines: the dashboard's list ($PROT), the account's
# own SSH keys and SparkDash state, and (in sdhelper.pl) every home folder and Docker's/containerd's storage.
sd_protids() {
  {
    printf '%s\n' "$PROT"
    [ -n "$H" ] && printf '%s\n' "$H" "$H/.ssh" "$H/.local/state/sparkdash"
    printf '%s\n' /root/.ssh /
  } | sd_pl ids
}

# The error code for what rm printed.
sd_rm_code() {
  if grep -qiE 'permission denied|operation not permitted' "$1" 2>/dev/null; then
    printf permission
  elif grep -qi 'read-only file system' "$1" 2>/dev/null; then
    printf readonly
  else
    printf rm-failed
  fi
}

# The account's home folder as a real path, or empty.
sd_home() {
  [ -n "$ACCT_HOME" ] || return 0
  (cd -P -- "$ACCT_HOME" 2>/dev/null && pwd -P) || :
}
