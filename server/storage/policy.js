/**
 * Which paths the Storage Manager will touch. Everything that reaches a unit passes through here
 * first; the delete program on the unit adds its own checks (real path, mount points).
 *
 * The dashboard logs in over SSH, so the account's own `~/.ssh` is protected along with the system
 * folders: deleting it would lock the dashboard out of the unit.
 */

const MAX_PATH_LENGTH = 4096;

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** True when the name cannot be sent back to the unit byte for byte (control characters, invalid UTF-8). */
export function hasUnsafeName(p) {
  return typeof p !== "string" || CONTROL_CHARS.test(p) || p.includes("�");
}

/**
 * A clean absolute path: no `.`/`..` segments, no doubled or trailing slash, no control characters.
 * Anything else is rejected rather than "fixed", so the path checked is the path used.
 * @param {unknown} input
 * @returns {string}
 */
export function parseAbsolutePath(input) {
  const fail = (msg) => httpError(400, msg, "bad-path");
  if (typeof input !== "string" || input === "") throw fail("path must be an absolute folder path");
  if (input.length > MAX_PATH_LENGTH) throw fail("path is too long");
  if (hasUnsafeName(input)) throw fail("path contains characters that cannot be used here");
  if (!input.startsWith("/")) throw fail("path must start with /");
  if (input === "/") return input;
  if (input.endsWith("/") || input.includes("//")) throw fail("path must not contain empty segments");
  if (input.split("/").some((seg) => seg === "." || seg === "..")) throw fail("path must not contain . or .. segments");
  return input;
}

/** Folders whose contents are never deleted from here, with the reason shown to the person. */
const PROTECTED_TREES = [
  ["/boot", "Boot files. Deleting them can stop the Spark from starting."],
  ["/dev", "Device files managed by the system."],
  ["/proc", "Virtual folder managed by the system."],
  ["/sys", "Virtual folder managed by the system."],
  ["/run", "Runtime files managed by the system."],
  ["/bin", "System programs."],
  ["/sbin", "System programs."],
  ["/lib", "System libraries."],
  ["/lib32", "System libraries."],
  ["/lib64", "System libraries."],
  ["/etc", "System configuration."],
  ["/usr/bin", "System programs."],
  ["/usr/sbin", "System programs."],
  ["/usr/lib", "System libraries. Use the package manager to remove software."],
  ["/usr/lib32", "System libraries."],
  ["/usr/lib64", "System libraries."],
  ["/usr/libexec", "System programs."],
  ["/var/lib/docker", "Docker's own storage. Deleting files here by hand corrupts Docker. Use the Docker tab instead."],
  ["/var/lib/containerd", "Container runtime storage. Deleting files here by hand corrupts it."],
  ["/var/lib/dpkg", "The package database. Deleting it breaks software updates."],
  ["/var/lib/snapd", "Snap package storage."],
  ["/snap", "Snap package storage."],
  ["/lost+found", "Filesystem recovery folder."],
];

/** Folders that may be emptied by hand but never removed themselves. */
const PROTECTED_EXACT = [
  ["/usr/local", "Part of the system layout. Delete things inside it instead."],
  ["/usr/share", "Part of the system layout. Delete things inside it instead."],
  ["/usr/include", "Part of the system layout. Delete things inside it instead."],
  ["/var/lib", "Part of the system layout. Delete things inside it instead."],
  ["/var/log", "Part of the system layout. Delete files inside it instead."],
  ["/var/cache", "Part of the system layout. Delete things inside it instead."],
  ["/var/tmp", "Part of the system layout. Delete things inside it instead."],
];

const SSH_FOLDER = /(^|\/)\.ssh(\/|$)/;
/** Delete v2's own state: staging folders, kept items and their records (handled from "Needs attention"). */
const SPARKDASH_STATE = /\/\.local\/state\/sparkdash(\/|$)|\/\.sparkdash-staging-[^/]*(\/|$)/;

/**
 * Every protected location, plus the top-level system folders. The delete program refuses an item that is
 * one of them or contains one (compared by identity on the unit, so a symlinked or relocated root counts),
 * on top of the account's own SSH keys and SparkDash state, home folders and Docker's configured storage.
 */
export const PROTECTED_ROOTS = Object.freeze([
  ...PROTECTED_TREES.map(([p]) => p),
  ...PROTECTED_EXACT.map(([p]) => p),
  "/home",
  "/root",
  "/usr",
  "/var",
  "/opt",
  "/srv",
]);

/** Folders nothing is put back into (a restore destination inside one is refused, also through a bind mount). */
export const PROTECTED_TREE_ROOTS = Object.freeze(PROTECTED_TREES.map(([p]) => p));

/**
 * Why a path must not be deleted, or null when it may be. `parseAbsolutePath` first.
 * @param {string} p
 * @returns {string | null}
 */
export function protectedReason(p) {
  if (hasUnsafeName(p)) return "The name has unusual characters, so it cannot be deleted from here. Use a terminal on the Spark.";
  const parts = p.split("/").filter(Boolean);
  if (parts.length === 0) return "This is the whole disk.";
  if (parts.length === 1) return "A top-level system folder. Open it and delete things inside instead.";
  if (SSH_FOLDER.test(p)) return "SSH keys. Deleting them can lock the dashboard out of this Spark.";
  if (SPARKDASH_STATE.test(p)) return "SparkDash's own working folder. Items kept after an unfinished delete are handled under Needs attention.";
  for (const [tree, why] of PROTECTED_TREES) {
    if (p === tree || p.startsWith(`${tree}/`)) return why;
  }
  for (const [exact, why] of PROTECTED_EXACT) {
    if (p === exact) return why;
  }
  // /home/<user> and the like: a person's whole home folder is not one click away from deletion.
  if (parts.length === 2 && (parts[0] === "home" || parts[0] === "mnt" || parts[0] === "media")) {
    return parts[0] === "home" ? "A whole home folder. Open it and delete things inside instead." : "A mount point. Open it and delete things inside instead.";
  }
  return null;
}

/**
 * Throws a 403 `protected` error for a path that must not be deleted.
 * @param {string} p
 */
export function assertDeletable(p) {
  const why = protectedReason(p);
  if (why) throw httpError(403, why, "protected");
}

/** `/a/b/c` -> `/a/b`; the parent of a top-level path is `/`. */
export function parentOf(p) {
  if (p === "/") return null;
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Number of path segments: `/` is 0, `/a/b` is 2. */
export function depthOf(p) {
  return p === "/" ? 0 : p.split("/").length - 1;
}
