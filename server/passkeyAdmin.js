#!/usr/bin/env node
/**
 * Host-side passkey recovery. Deliberately not an HTTP route: a route that clears
 * enrolment is one an attacker could use to un-enrol the operator and enrol
 * themselves. Running this needs the same access as editing the config volume.
 *
 *   docker exec sparkDash node server/passkeyAdmin.js list
 *   docker exec sparkDash node server/passkeyAdmin.js reset
 *   docker exec sparkDash node server/passkeyAdmin.js sign-out-all
 *
 * With the container stopped: docker compose run --rm sparkdash node server/passkeyAdmin.js reset
 * Normal resets take effect through the shared SQLite database; the service logs
 * the generation change on its next store read. Restart after corrupt-store recovery.
 */
import { passkeysDbPath } from "./config.js";
import { destroyAllSessions, listCredentials, resetAll } from "./passkeys/store.js";

const USAGE = `usage: node server/passkeyAdmin.js <list|reset|sign-out-all>

  list          show enrolled passkeys (label, enrolled, last used)
  reset         remove every passkey and session; the access token can enrol again
  sign-out-all  end every browser session, keeping the passkeys`;

function main(command) {
  const file = passkeysDbPath();
  switch (command) {
    case "list": {
      const passkeys = listCredentials();
      if (passkeys.length === 0) {
        console.log(`No passkeys enrolled (${file}).`);
        return 0;
      }
      for (const p of passkeys) {
        console.log(`${p.id}  ${p.label || "(no label)"}  enrolled ${p.createdAt}  last used ${p.lastUsedAt ?? "never"}`);
      }
      return 0;
    }
    case "reset": {
      const removed = resetAll();
      console.warn(`[passkeys] reset on the host: removed ${removed} passkey(s) and every session from ${file}. Enrolment is open again to the holder of SPARKDASH_TOKEN.`);
      return 0;
    }
    case "sign-out-all": {
      const ended = destroyAllSessions();
      console.log(`Ended ${ended} session(s).`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main(process.argv[2]);
} catch (err) {
  console.error(`[passkeys] ${err.message}`);
  process.exitCode = 1;
}
