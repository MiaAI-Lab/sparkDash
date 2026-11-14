/**
 * On-unit programs for per-card GPU power limits on dedicated GPU hosts:
 * `nvidia-smi -i UUID -pl WATTS`, optionally kept across reboots by a oneshot
 * systemd service. Same rules as the clock cap programs in commands.js: POSIX sh,
 * only values validated here are interpolated, privilege through the shared sudo
 * header, always exit 0 and report as `KEY=value` lines.
 *
 * Cards are targeted by UUID because an index can move when a card is added or
 * removed. A request is all or nothing: every card is checked before the first
 * one changes, and cards already changed are put back if a later one fails.
 */
import { header, needSudoLine, resolvePaths } from "./commands.js";

export const POWER_UNIT_NAME = "spark-gpu-power-limit.service";

const MAX_CARDS = 64;
/** Sanity bound only: the card's own range is checked on the unit. */
const MAX_WATTS = 5000;
const CARD_UUID = /^GPU-[0-9a-fA-F-]{8,64}$/;
const WATTS_FIELD = /^\d+(\.\d+)?$/;

/** One line per card: index,uuid,limit,enforced,default,min,max,name. Unknown values stay as nvidia-smi prints them. */
const CARDS_FN =
  'cards() { "$NV" --query-gpu=index,uuid,power.limit,enforced.power.limit,power.default_limit,power.min_limit,power.max_limit,name --format=csv,noheader,nounits 2>/dev/null | sed "s/, */,/g"; }';

/** awk condition on a cards() line. `power.management` is not used: current drivers answer it with a deprecation notice. */
const ADJUSTABLE = "$2 ~ /^GPU-[0-9a-fA-F-]+$/ && $3 ~ /^[0-9.]+$/ && $6 ~ /^[0-9.]+$/ && $7 ~ /^[0-9.]+$/ && $6 + 0 < $7 + 0";

/**
 * Validate a limits request. Returns normalized values or throws an Error with `status` 400.
 * `persist` is required: leaving it out must not remove a boot service by accident.
 * @param {unknown} body
 * @returns {{ limits: { uuid: string, watts: number }[], persist: boolean }}
 */
export function parsePowerRequest(body) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  if (!Array.isArray(b.limits) || b.limits.length > MAX_CARDS) throw fail(`limits must be a list of at most ${MAX_CARDS} cards`);
  if (typeof b.persist !== "boolean") throw fail("persist must be true or false");
  const seen = new Set();
  const limits = b.limits.map((item) => {
    const uuid = item?.uuid;
    const watts = item?.watts;
    if (typeof uuid !== "string" || !CARD_UUID.test(uuid)) throw fail("each limit needs a card uuid such as GPU-1a2b3c4d");
    if (seen.has(uuid)) throw fail("each card can only be listed once");
    seen.add(uuid);
    if (!Number.isInteger(watts) || watts < 1 || watts > MAX_WATTS) throw fail(`watts must be a whole number from 1 to ${MAX_WATTS}`);
    return { uuid, watts };
  });
  return { limits, persist: b.persist };
}

function preamble(paths) {
  return [
    ...header(paths),
    `UNITDIR=${paths.unitDir}`,
    `POWER_UNIT=${paths.unitDir}/${POWER_UNIT_NAME}`,
    CARDS_FN,
    // Enabled units an administrator wrote that also set a limit at boot. Only safe names, because they end up in our unit.
    "others() {",
    '  for f in "$UNITDIR"/*.service; do',
    '    [ -f "$f" ] || continue',
    "    n=${f##*/}",
    `    [ "$n" = ${POWER_UNIT_NAME} ] && continue`,
    '    case "$n" in *[!A-Za-z0-9_.@-]*) continue ;; esac',
    "    grep -Eq '^ExecStart.*nvidia-smi.*[[:space:]](-pl|--power-limit)' \"$f\" 2>/dev/null || continue",
    '    [ "$($SYSTEMCTL is-enabled "$n" 2>/dev/null)" = enabled ] || continue',
    "    printf '%s\\n' \"$n\"",
    "  done",
    "}",
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
  ];
}

/** Read-only: each card's limits and range, sudo availability, and the boot services. */
export function buildPowerStatusProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...preamble(paths),
    "OUT=$(cards)",
    '[ -n "$OUT" ] || fail no-gpu "nvidia-smi could not read the cards on this unit"',
    'if [ "$(id -u)" = 0 ]; then S=root; elif need_sudo; then S=yes; else S=no; fi',
    "printf 'RESULT=ok\\nSUDO=%s\\n' \"$S\"",
    "printf '%s\\n' \"$OUT\" | sed 's/^/CARD=/'",
    'if [ -f "$POWER_UNIT" ]; then',
    "  sed -n 's/^ExecStart=.* -i \\(GPU-[0-9a-fA-F-]*\\) -pl \\([0-9.]*\\).*/SVC_CARD=\\1,\\2/p' \"$POWER_UNIT\"",
    `  printf 'SVC_INSTALLED=1\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\n' "$($SYSTEMCTL is-enabled ${POWER_UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc a-z-)" "$($SYSTEMCTL is-active ${POWER_UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc a-z-)"`,
    "fi",
    "others | sed 's/^/OTHER_SVC=/'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Set the limits now. With `persist` the boot service is written with every adjustable card's
 * limit as read back from the unit, so changing one card never drops another; it runs after any
 * other boot unit that sets a limit, so its values are the ones that stay. Without `persist` a
 * previous service is removed. `limits` may be empty when only the service changes.
 */
export function buildPowerApplyProgram(request, overrides = {}) {
  const paths = resolvePaths(overrides);
  // Defense in depth: the caller validated already, but this is what reaches a root shell.
  const { limits, persist } = parsePowerRequest(request);
  const pairs = limits.map((l) => `${l.uuid}=${l.watts}`).join(" ");
  return [
    ...preamble(paths),
    `LIMITS='${pairs}'; PERSIST=${persist ? 1 : 0}`,
    "BEFORE=$(cards)",
    '[ -n "$BEFORE" ] || fail no-gpu "nvidia-smi could not read the cards on this unit"',
    `check() { printf '%s\\n' "$BEFORE" | awk -F, -v u="$1" -v w="$2" '$2 == u { found = 1; if (${ADJUSTABLE}) r = (w + 0 >= $6 + 0 && w + 0 <= $7 + 0) ? "ok" : $6 " to " $7; else r = "fixed" } END { print found ? r : "missing" }'; }`,
    "for P in $LIMITS; do",
    "  U=${P%%=*}; W=${P#*=}; R=$(check \"$U\" \"$W\")",
    '  case "$R" in',
    "    ok) ;;",
    '    missing) fail no-card "card $U is not on this unit" ;;',
    '    fixed) fail not-adjustable "card $U does not allow a power limit to be set" ;;',
    '    *) fail range "$W W is outside the range of card $U ($R W)" ;;',
    "  esac",
    "done",
    needSudoLine(paths),
    `if [ "$PERSIST" = 1 ] && [ ! -d ${paths.systemdRunDir} ]; then fail no-systemd "systemd is not running on this unit"; fi`,
    "DONE=''",
    "restore() {",
    "  RC=0",
    "  for P in $DONE; do",
    "    U=${P%%=*}",
    "    OLD=$(printf '%s\\n' \"$BEFORE\" | awk -F, -v u=\"$U\" '$2 == u { print $3; exit }')",
    '    $SUDO "$NV" -i "$U" -pl "$OLD" >/dev/null 2>&1 || RC=1',
    "  done",
    "  return $RC",
    "}",
    "undo() { if restore; then printf 'no card was changed'; else printf 'some cards could not be put back, check their limits'; fi; }",
    "for P in $LIMITS; do",
    "  U=${P%%=*}; W=${P#*=}",
    '  OUT=$($SUDO "$NV" -i "$U" -pl "$W" 2>&1) || fail pl-failed "nvidia-smi refused $W W for card $U: $(clean "$OUT"); $(undo)"',
    '  DONE="$DONE $P"',
    "done",
    "AFTER=$(cards)",
    "held() { printf '%s\\n' \"$AFTER\" | awk -F, -v u=\"$1\" -v w=\"$2\" '$2 == u && $3 ~ /^[0-9.]+$/ && $3 - w < 0.5 && w - $3 < 0.5 { print \"yes\"; exit }'; }",
    "for P in $LIMITS; do",
    "  U=${P%%=*}; W=${P#*=}",
    // With persistence mode off and nothing using the card, the driver can drop the limit straight away.
    '  [ "$(held "$U" "$W")" = yes ] || fail pl-not-held "card $U did not keep $W W, persistence mode may be off (nvidia-smi -pm 1); $(undo)"',
    "done",
    'if [ "$PERSIST" = 1 ]; then',
    '  D=$(mktemp -d) || fail service-failed "could not create a temporary directory; the limits apply until the next reboot"',
    "  trap 'rm -rf \"$D\"' EXIT",
    '  if [ -f "$POWER_UNIT" ]; then cp "$POWER_UNIT" "$D/unit.old" || fail service-failed "could not back up the existing service; the limits apply until the next reboot"; fi',
    "  {",
    "    printf '%s\\n' '[Unit]' 'Description=Set NVIDIA GPU power limits, managed by sparkDash' \"After=nvidia-persistenced.service$(others | sed 's/^/ /' | tr -d '\\n')\" 'Wants=nvidia-persistenced.service' 'StartLimitIntervalSec=300' 'StartLimitBurst=10' '' '[Service]' 'Type=oneshot' 'RemainAfterExit=yes'",
    `    printf '%s\\n' "$AFTER" | awk -F, -v nv="$NV" '${ADJUSTABLE} { print "ExecStart=" nv " -i " $2 " -pl " ($3 + 0) }'`,
    "    printf '%s\\n' 'Restart=on-failure' 'RestartSec=5' '' '[Install]' 'WantedBy=multi-user.target'",
    '  } > "$D/unit" || fail service-failed "could not prepare the service file; the limits apply until the next reboot"',
    "  grep -q '^ExecStart=' \"$D/unit\" || fail not-adjustable \"no card on this unit allows a power limit to be set\"",
    // Past this point a failure restores the previous service (or removes ours). The live limits stay either way.
    "  rollback() {",
    `    $SUDO $SYSTEMCTL stop ${POWER_UNIT_NAME} >/dev/null 2>&1`,
    '    if [ -f "$D/unit.old" ]; then',
    '      $SUDO install -m 644 $OWNER "$D/unit.old" "$POWER_UNIT" >/dev/null 2>&1',
    "    else",
    `      $SUDO $SYSTEMCTL disable ${POWER_UNIT_NAME} >/dev/null 2>&1`,
    '      $SUDO rm -f "$POWER_UNIT"',
    "    fi",
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1",
    "  }",
    '  $SUDO install -m 644 $OWNER "$D/unit" "$POWER_UNIT" || fail service-failed "could not install the service file; the limits apply until the next reboot"',
    '  $SUDO $SYSTEMCTL daemon-reload || { rollback; fail service-failed "systemctl daemon-reload failed; the limits apply until the next reboot"; }',
    `  $SUDO $SYSTEMCTL enable ${POWER_UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "could not enable the service; the limits apply until the next reboot"; }`,
    `  $SUDO $SYSTEMCTL restart ${POWER_UNIT_NAME} >/dev/null 2>&1 || { rollback; fail service-failed "the service did not start; the limits apply until the next reboot"; }`,
    `  [ "$($SYSTEMCTL is-active ${POWER_UNIT_NAME} 2>/dev/null)" = active ] || { rollback; fail service-failed "the service is not active; the limits apply until the next reboot"; }`,
    'elif [ -f "$POWER_UNIT" ]; then',
    // The unit has no ExecStop, so removing it leaves the live limits as they are.
    `  $SUDO $SYSTEMCTL disable --now ${POWER_UNIT_NAME} >/dev/null 2>&1 || true`,
    '  $SUDO rm -f "$POWER_UNIT" || fail service-failed "could not remove the boot service; the limits apply now, but it still runs at boot"',
    "  $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1 || true",
    "fi",
    "printf 'RESULT=ok\\nPERSIST=%s\\n' \"$PERSIST\"",
    "printf '%s\\n' \"$AFTER\" | sed 's/^/CARD=/'",
    "exit 0",
    "",
  ].join("\n");
}

const watts = (v) => (WATTS_FIELD.test(v ?? "") ? Number(v) : null);

/**
 * Turn `CARD=` lines into card records. A value nvidia-smi could not give is null, never 0, and a
 * card without a readable limit and range is listed but not adjustable. Lines without a card uuid are dropped.
 * @param {string[]} [lines]
 */
export function parseCards(lines = []) {
  const cards = [];
  for (const line of lines) {
    const [index, uuid, limit, enforced, dflt, min, max, ...name] = line.split(",");
    if (!CARD_UUID.test(uuid ?? "")) continue;
    const limitW = watts(limit);
    const minW = watts(min);
    const maxW = watts(max);
    cards.push({
      index: /^\d+$/.test(index) ? Number(index) : null,
      uuid,
      name: name.join(",").trim().slice(0, 120) || null,
      limitW,
      enforcedW: watts(enforced),
      defaultW: watts(dflt),
      minW,
      maxW,
      adjustable: limitW != null && minW != null && maxW != null && minW < maxW,
    });
  }
  return cards;
}

/** The limit the boot service sets for each card, from `SVC_CARD=uuid,watts` lines. */
export function parseBootLimits(lines = []) {
  const boot = new Map();
  for (const line of lines) {
    const [uuid, value] = line.split(",");
    if (CARD_UUID.test(uuid ?? "") && watts(value) != null) boot.set(uuid, watts(value));
  }
  return boot;
}
