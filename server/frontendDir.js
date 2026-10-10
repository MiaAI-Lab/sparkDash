import fs from "fs";
import path from "path";

/**
 * Where the built frontend lives. Docker compose bind-mounts ./dist over the image's own
 * build, so a checkout that was never built on the host (or a fresh clone after an
 * upgrade) leaves an empty mount that hides it. The image keeps a second copy in
 * dist-baked. Use ./dist when it has an index.html, unless the baked copy is newer: a host
 * build from before `git pull` + `docker compose up --build` must not shadow the new image.
 * Checked per request, so a host `npm run build` takes over without a restart.
 */
export function resolveFrontendDir(root, exists = fs.existsSync, mtimeMs = defaultMtime) {
  const found = ["dist", "dist-baked"]
    .map((name) => path.join(root, name))
    .filter((dir) => exists(path.join(dir, "index.html")));
  if (found.length <= 1) return found[0] ?? null;
  const [host, baked] = found;
  try {
    return mtimeMs(path.join(baked, "index.html")) > mtimeMs(path.join(host, "index.html")) ? baked : host;
  } catch {
    return host;
  }
}

function defaultMtime(file) {
  return fs.statSync(file).mtimeMs;
}

export const FRONTEND_MISSING_MESSAGE =
  "Frontend not built. On the host run `npm run build`, or rebuild the image with " +
  "`docker compose up --build -d`. For development use `npm run dev`.";
