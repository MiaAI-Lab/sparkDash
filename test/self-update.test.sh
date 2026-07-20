#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/scripts/self-update.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ -x "$SCRIPT" ]] || fail "self-update script must exist and be executable"

# Build a source repository with two commits and clone only the first.
git init --bare "$TMP/origin.git" >/dev/null
git init -b main "$TMP/source" >/dev/null
git -C "$TMP/source" config user.name Test
git -C "$TMP/source" config user.email test@example.com
printf 'one\n' > "$TMP/source/version.txt"
cp "$ROOT/test/fixtures/package.json" "$TMP/source/package.json"
cp "$ROOT/test/fixtures/package-lock.json" "$TMP/source/package-lock.json"
git -C "$TMP/source" add version.txt package.json package-lock.json
git -C "$TMP/source" commit -m one >/dev/null
git -C "$TMP/source" remote add origin "$TMP/origin.git"
git -C "$TMP/source" push -u origin main >/dev/null
git --git-dir="$TMP/origin.git" symbolic-ref HEAD refs/heads/main
git clone "$TMP/origin.git" "$TMP/work" >/dev/null
printf 'two\n' > "$TMP/source/version.txt"
git -C "$TMP/source" commit -am two >/dev/null
git -C "$TMP/source" push origin main >/dev/null

mkdir -p "$TMP/bin"
cat > "$TMP/bin/npm" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$SPARKDASH_TEST_LOG"
EOF
chmod +x "$TMP/bin/npm"
cat > "$TMP/restart.sh" <<'EOF'
#!/usr/bin/env bash
printf 'restart\n' >> "$SPARKDASH_TEST_LOG"
EOF
chmod +x "$TMP/restart.sh"
export PATH="$TMP/bin:$PATH"
export SPARKDASH_TEST_LOG="$TMP/actions.log"

SPARKDASH_REPO="$TMP/work" SPARKDASH_RESTART_CMD="$TMP/restart.sh" "$SCRIPT"
[[ "$(cat "$TMP/work/version.txt")" == two ]] || fail "clean clone did not fast-forward"
grep -qx 'ci' "$TMP/actions.log" || fail "npm ci was not run"
grep -qx 'run build' "$TMP/actions.log" || fail "npm run build was not run"
grep -qx 'restart' "$TMP/actions.log" || fail "restart command was not run"

# No update means no build or restart.
: > "$TMP/actions.log"
SPARKDASH_REPO="$TMP/work" SPARKDASH_RESTART_CMD="$TMP/restart.sh" "$SCRIPT"
[[ ! -s "$TMP/actions.log" ]] || fail "no-op update ran deployment actions"

# Dirty tracked files must block update without destroying local work.
printf 'local edit\n' >> "$TMP/work/version.txt"
printf 'three\n' > "$TMP/source/version.txt"
git -C "$TMP/source" commit -am three >/dev/null
git -C "$TMP/source" push origin main >/dev/null
if SPARKDASH_REPO="$TMP/work" SPARKDASH_RESTART_CMD="$TMP/restart.sh" "$SCRIPT"; then
  fail "dirty repository update unexpectedly succeeded"
fi
grep -q 'local edit' "$TMP/work/version.txt" || fail "dirty local change was lost"

printf 'PASS: self-update behavior\n'
