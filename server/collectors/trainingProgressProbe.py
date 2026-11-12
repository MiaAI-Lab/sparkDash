# Copyright 2026 Maxrio9. SPDX-License-Identifier: Apache-2.0
"""Read only the fixed progress document directly inside each explicit root."""
import json
import os
import stat
import sys

MAX_FILE_BYTES = 64 * 1024
MAX_OUTPUT_BYTES = 256 * 1024


def collect(roots):
    result = {"files": [], "truncated": False}
    for index, root in enumerate(roots):
        directory = descriptor = None
        record = {"index": index}
        try:
            # Root and file symlinks, devices, FIFOs and races to replace them
            # are rejected. Parent path components are explicitly operator-owned.
            directory = os.open(os.path.expanduser(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            descriptor = os.open("training-progress.json", os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory)
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                raise ValueError("unsupported document")
            with os.fdopen(descriptor, "rb") as stream:
                descriptor = None
                content = stream.read(MAX_FILE_BYTES + 1)
            if len(content) > MAX_FILE_BYTES:
                raise ValueError("oversized document")
            record["content"] = content.decode("utf-8")
        except FileNotFoundError:
            record["error"] = "missing"
        except (OSError, ValueError, UnicodeError):
            record["error"] = "unreadable"
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if directory is not None:
                os.close(directory)
        candidate = {**result, "files": [*result["files"], record]}
        if len(json.dumps(candidate, ensure_ascii=False).encode()) > MAX_OUTPUT_BYTES - 1024:
            record = {"index": index, "error": "limit"}
            result["truncated"] = True
        result["files"].append(record)
    return result


if __name__ == "__main__":
    roots = json.loads(sys.argv[1])
    if not isinstance(roots, list) or len(roots) > 16 or not all(isinstance(root, str) for root in roots):
        raise ValueError("invalid probe arguments")
    print(json.dumps(collect(roots), ensure_ascii=False))
