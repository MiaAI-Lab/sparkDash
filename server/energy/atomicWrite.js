import path from "node:path";
import { randomUUID } from "node:crypto";

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]);
// WINDOWS-ARM64-PORT: NTFS has no POSIX mode bits — fs.stat().mode is a fixed
// 0666/0444 shape and chmod only toggles the read-only attribute. Verifying
// 0600 here would reject every write and silently drop all energy history.
// Confidentiality on Windows is provided by the NTFS ACL that start.ps1 sets
// on the config directory (current user + SYSTEM + Administrators only).
const IS_WINDOWS_HOST = process.platform === "win32";

/** Write a file atomically (temp file, fsync, rename) at mode 0600. */
export function writeStateAtomically(filePath, contents, fileSystem) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryFd = null;
  let directoryFd = null;
  let renamed = false;

  fileSystem.mkdirSync(directory, { recursive: true });
  try {
    temporaryFd = fileSystem.openSync(temporaryPath, "wx", 0o600);
    fileSystem.writeFileSync(temporaryFd, contents, { encoding: "utf8" });
    fileSystem.fchmodSync(temporaryFd, 0o600);
    fileSystem.fsyncSync(temporaryFd);
    fileSystem.closeSync(temporaryFd);
    temporaryFd = null;

    fileSystem.renameSync(temporaryPath, filePath);
    renamed = true;
    fileSystem.chmodSync(filePath, 0o600);
    if (!IS_WINDOWS_HOST) {
      const finalMode = fileSystem.statSync(filePath).mode & 0o777;
      if (finalMode !== 0o600) {
        throw new Error(`Failed to secure ${filePath}: expected mode 0600, got 0${finalMode.toString(8)}`);
      }
    }

    try {
      directoryFd = fileSystem.openSync(directory, "r");
      fileSystem.fsyncSync(directoryFd);
    } catch (error) {
      if (!UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error?.code)) throw error;
    } finally {
      if (directoryFd !== null) fileSystem.closeSync(directoryFd);
    }
  } catch (error) {
    if (temporaryFd !== null) {
      try {
        fileSystem.closeSync(temporaryFd);
      } catch {
        // Preserve the original persistence error.
      }
    }
    if (!renamed) {
      try {
        fileSystem.unlinkSync(temporaryPath);
      } catch {
        // The temp may not have been created; never remove the prior target.
      }
    }
    throw error;
  }
}
