import fs from "fs";
import path from "path";

/**
 * Where the built frontend lives. Docker compose bind-mounts ./dist over the
 * image's own build, so a checkout that was never built on the host (or a fresh
 * clone after an upgrade) leaves an empty mount that hides it. The image keeps a
 * second copy in dist-baked; use it whenever ./dist has no index.html.
 * Checked per request, so a host `npm run build` takes over without a restart.
 */
export function resolveFrontendDir(root, exists = fs.existsSync) {
  for (const name of ["dist", "dist-baked"]) {
    const dir = path.join(root, name);
    if (exists(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

export const FRONTEND_MISSING_MESSAGE =
  "Frontend not built. On the host run `npm run build`, or rebuild the image with " +
  "`docker compose up --build -d`. For development use `npm run dev`.";
