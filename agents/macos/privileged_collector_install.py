import os
import plistlib
import stat
import sys
import tempfile
from pathlib import Path


def build_plist(template, install_dir):
    with open(template, "rb") as stream:
        data = plistlib.load(stream)
    data["ProgramArguments"] = [
        value.replace("INSTALL_DIR", str(install_dir)) for value in data["ProgramArguments"]
    ]
    return plistlib.dumps(data)


def protected_directory(path):
    for parent in reversed((path, *path.parents)):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise PermissionError(f"unprotected installation directory: {parent}")


def replace_root_file(path, contents):
    fd, name = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), 0o644)
            stream.write(contents)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def install_payload(source, install_dir, plist_source, plist_dest):
    protected_directory(install_dir.parent)
    protected_directory(plist_dest.parent)
    if not install_dir.exists() and not install_dir.is_symlink():
        install_dir.mkdir(mode=0o755)
    protected_directory(install_dir)
    os.chown(install_dir, 0, 0)
    os.chmod(install_dir, 0o755)
    payloads = {name: (source / name).read_bytes() for name in ("sparkdash_mac_agent.py", "runtimes.json")}
    plist = plist_source.read_bytes()
    plistlib.loads(plist)
    for name, contents in payloads.items():
        replace_root_file(install_dir / name, contents)
    replace_root_file(plist_dest, plist)


if __name__ == "__main__":
    if sys.argv[1] == "plist":
        sys.stdout.buffer.write(build_plist(sys.argv[2], sys.argv[3]))
    elif sys.argv[1] == "install":
        install_payload(*(Path(value) for value in sys.argv[2:]))
    else:
        raise SystemExit("expected plist or install")
