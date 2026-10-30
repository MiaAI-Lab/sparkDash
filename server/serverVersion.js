import fs from "fs";
import path from "path";

/**
 * Version of the running server, read from the package manifest beside `server/`.
 *
 * Reporting a version is not worth refusing to serve for: a deployment whose layout hides
 * or truncates `package.json` (a bind mount over it, a trimmed image) must still start, so
 * an unreadable or malformed manifest yields null and the health field, the Settings line
 * and their fallbacks behave as they do for a server too old to report one.
 */
export function readServerVersion(root) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}
