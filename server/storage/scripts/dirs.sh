# Read-only: the folders directly inside $1 (names only, no sizes), for the folder picker.
export LC_ALL=C
P=$1
[ -d "$P" ] || fail not-found "That folder does not exist on the Spark"
[ -r "$P" ] && [ -x "$P" ] || fail permission "This folder cannot be opened by the dashboard's account"
printf 'RESULT=ok\n'
# Real folders only (a symbolic link is not followed). Capped, the dashboard says when there are more.
find "$P" -mindepth 1 -maxdepth 1 -type d -printf 'D=%f\n' 2>/dev/null | head -n 801
