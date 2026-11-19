import path from "node:path";
import { randomUUID } from "node:crypto";

const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set(["EINVAL", "ENOTSUP", "EISDIR", "EBADF"]);

/**
 * Write a file atomically (temp file, fsync, rename) at mode 0600.
 * Windows has no POSIX modes (stat reports 0666 whatever chmod asked for) and cannot
 * fsync a directory handle (EPERM), so neither is treated as a failure there.
 */
export function writeStateAtomically(filePath, contents, fileSystem, platform = process.platform) {
  const windows = platform === "win32";
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
    const finalMode = fileSystem.statSync(filePath).mode & 0o777;
    if (!windows && finalMode !== 0o600) {
      throw new Error(`Failed to secure ${filePath}: expected mode 0600, got 0${finalMode.toString(8)}`);
    }

    try {
      directoryFd = fileSystem.openSync(directory, "r");
      fileSystem.fsyncSync(directoryFd);
    } catch (error) {
      const unsupported = UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(error?.code) || (windows && error?.code === "EPERM");
      if (!unsupported) throw error;
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
