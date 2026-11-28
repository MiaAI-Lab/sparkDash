import hashlib
import json
import os
import plistlib
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

APP_BUNDLE_NAME = "SparkDash Mac Agent.app"
APP_EXECUTABLE_NAME = "SparkDash Mac Agent"
APP_BUNDLE_ID = "ai.onyx.sparkdash-mac-agent"

LAUNCHER_C_SOURCE = r"""
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
static volatile sig_atomic_t g_child = -1;

static void forward_signal(int sig) {
    pid_t pid = (pid_t)g_child;
    if (pid > 0) {
        kill(pid, sig);
    }
}

int main(int argc, char **argv) {
    char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
    if (!child_argv) {
        perror("calloc");
        return 1;
    }
    child_argv[0] = (char *)"/usr/bin/python3";
    for (int i = 1; i < argc; i++) {
        child_argv[i] = argv[i];
    }
    child_argv[argc] = NULL;

    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_handler = forward_signal;
    sigemptyset(&sa.sa_mask);
    sa.sa_flags = SA_RESTART;
    sigaction(SIGTERM, &sa, NULL);
    sigaction(SIGINT, &sa, NULL);
    sigaction(SIGHUP, &sa, NULL);

    pid_t pid = -1;
    int rc = posix_spawn(&pid, "/usr/bin/python3", NULL, NULL, child_argv, environ);
    if (rc != 0) {
        errno = rc;
        perror("posix_spawn");
        free(child_argv);
        return 127;
    }
    g_child = (sig_atomic_t)pid;

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) {
            perror("waitpid");
            free(child_argv);
            return 1;
        }
    }
    free(child_argv);
    if (WIFEXITED(status)) {
        return WEXITSTATUS(status);
    }
    if (WIFSIGNALED(status)) {
        return 128 + WTERMSIG(status);
    }
    return 1;
}
""".lstrip()


def app_bundle_executable(install_dir):
    return Path(install_dir) / APP_BUNDLE_NAME / "Contents" / "MacOS" / APP_EXECUTABLE_NAME


def can_build_app_bundle():
    if sys.platform != "darwin":
        return False
    if not Path("/usr/bin/clang").is_file() or not Path("/usr/bin/codesign").is_file():
        return False
    try:
        proc = subprocess.run(
            ["/usr/bin/xcode-select", "-p"],
            capture_output=True,
            text=True,
            timeout=2.0,
            check=False,
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _build_icns(icon_png, out_icns):
    if not Path(icon_png).is_file():
        return False
    if not Path("/usr/bin/sips").is_file() or not Path("/usr/bin/iconutil").is_file():
        return False
    try:
        with tempfile.TemporaryDirectory(dir=out_icns.parent) as tmp_dir:
            iconset = Path(tmp_dir) / "AppIcon.iconset"
            iconset.mkdir()
            specs = (
                (16, "icon_16x16.png"),
                (32, "icon_16x16@2x.png"),
                (32, "icon_32x32.png"),
                (64, "icon_32x32@2x.png"),
                (128, "icon_128x128.png"),
                (256, "icon_128x128@2x.png"),
                (256, "icon_256x256.png"),
                (512, "icon_256x256@2x.png"),
                (512, "icon_512x512.png"),
            )
            for size, filename in specs:
                subprocess.run(
                    ["/usr/bin/sips", "-z", str(size), str(size), str(icon_png), "--out", str(iconset / filename)],
                    capture_output=True,
                    check=True,
                )
            subprocess.run(
                ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(out_icns)],
                capture_output=True,
                check=True,
            )
        return out_icns.is_file()
    except (OSError, subprocess.SubprocessError):
        return False


def _launcher_hash(icon_bytes):
    digest = hashlib.sha256()
    digest.update(LAUNCHER_C_SOURCE.encode("utf-8"))
    digest.update(b"\0")
    digest.update(APP_BUNDLE_ID.encode("utf-8"))
    digest.update(b"\0")
    digest.update(APP_EXECUTABLE_NAME.encode("utf-8"))
    digest.update(b"\0")
    digest.update(icon_bytes)
    return digest.hexdigest()


def _existing_bundle_valid(dest_app, expected_hash):
    try:
        if dest_app.is_symlink():
            return False
        info = dest_app.lstat()
        exe = dest_app / "Contents" / "MacOS" / APP_EXECUTABLE_NAME
        if not stat.S_ISDIR(info.st_mode) or (info.st_mode & 0o022):
            return False
        if os.geteuid() == 0 and info.st_uid != 0:
            return False
        if exe.is_symlink():
            return False
        exe_info = exe.lstat()
        if not stat.S_ISREG(exe_info.st_mode) or not (exe_info.st_mode & 0o111) or (exe_info.st_mode & 0o022):
            return False
        if os.geteuid() == 0 and exe_info.st_uid != 0:
            return False
        plist_path = dest_app / "Contents" / "Info.plist"
        with plist_path.open("rb") as stream:
            meta = plistlib.load(stream)
        if meta.get("SparkDashLauncherHash") != expected_hash:
            return False
        verify = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict", str(dest_app)],
            capture_output=True,
            check=False,
        )
        return verify.returncode == 0
    except (OSError, ValueError, plistlib.InvalidFileException, subprocess.SubprocessError):
        return False


def ensure_app_bundle(source_dir, install_dir, *, icon_path=None):
    """Build or reuse a branded ad-hoc-signed SparkDash Mac Agent.app launcher."""
    install_dir = Path(install_dir)
    source_dir = Path(source_dir)
    icon_candidate = (
        Path(icon_path)
        if icon_path is not None
        else source_dir.parent.parent / "public" / "icons" / "icon-512.png"
    )
    icon_bytes = icon_candidate.read_bytes() if icon_candidate.is_file() else b""
    expected_hash = _launcher_hash(icon_bytes)
    dest_app = install_dir / APP_BUNDLE_NAME
    if _existing_bundle_valid(dest_app, expected_hash):
        return dest_app

    build_root = Path(tempfile.mkdtemp(prefix=".sparkdash-app-build-", dir=install_dir))
    try:
        staging_app = build_root / APP_BUNDLE_NAME
        contents = staging_app / "Contents"
        macos_dir = contents / "MacOS"
        resources_dir = contents / "Resources"
        macos_dir.mkdir(parents=True)
        resources_dir.mkdir(parents=True)

        icns_built = bool(icon_bytes) and _build_icns(icon_candidate, resources_dir / "AppIcon.icns")
        info_plist = {
            "CFBundleExecutable": APP_EXECUTABLE_NAME,
            "CFBundleIdentifier": APP_BUNDLE_ID,
            "CFBundleName": APP_EXECUTABLE_NAME,
            "CFBundleDisplayName": APP_EXECUTABLE_NAME,
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "1.0",
            "CFBundleVersion": "1",
            "LSUIElement": True,
            "LSBackgroundOnly": True,
            "SparkDashLauncherHash": expected_hash,
        }
        if icns_built:
            info_plist["CFBundleIconFile"] = "AppIcon"
        (contents / "Info.plist").write_bytes(plistlib.dumps(info_plist))
        (contents / "PkgInfo").write_bytes(b"APPL????")

        c_src = build_root / "launcher.c"
        c_src.write_text(LAUNCHER_C_SOURCE, "utf-8")
        exe_path = macos_dir / APP_EXECUTABLE_NAME
        subprocess.run(
            ["/usr/bin/clang", "-O2", "-Wall", "-Wextra", "-o", str(exe_path), str(c_src)],
            check=True,
        )
        os.chmod(exe_path, 0o755)

        subprocess.run(
            ["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", APP_BUNDLE_ID, str(staging_app)],
            capture_output=True,
            check=True,
        )

        os.chown(staging_app, 0, 0)
        os.chmod(staging_app, 0o755)
        for root_str, dirnames, filenames in os.walk(staging_app):
            root_path = Path(root_str)
            for name in dirnames:
                p = root_path / name
                os.chown(p, 0, 0)
                os.chmod(p, 0o755)
            for name in filenames:
                p = root_path / name
                os.chown(p, 0, 0)
                os.chmod(p, 0o755 if p == exe_path else 0o644)

        backup_app = install_dir / f".{APP_BUNDLE_NAME}.old"
        if backup_app.is_symlink():
            backup_app.unlink()
        elif backup_app.exists():
            shutil.rmtree(backup_app)
        if dest_app.is_symlink():
            dest_app.unlink()
        elif dest_app.exists():
            dest_app.rename(backup_app)
        staging_app.rename(dest_app)
        if backup_app.exists():
            shutil.rmtree(backup_app, ignore_errors=True)
        return dest_app
    finally:
        shutil.rmtree(build_root, ignore_errors=True)


def resolve_privileged_python(comm=None):
    """Return a root-owned Python.app executable for LaunchDaemon TCC attribution, or None."""
    if comm is None:
        try:
            proc = subprocess.run(
                ["ps", "-p", str(os.getpid()), "-o", "comm="],
                capture_output=True,
                text=True,
                timeout=2.0,
                check=False,
            )
            comm = proc.stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return None
    if not isinstance(comm, str) or not comm.strip().startswith("/"):
        return None
    resolved = Path(os.path.realpath(comm.strip()))
    if ".app/Contents/MacOS/" not in str(resolved):
        return None
    app_bundle = next((p for p in resolved.parents if p.name.endswith(".app")), None)
    if app_bundle is None:
        return None
    try:
        info = resolved.lstat()
    except OSError:
        return None
    if not stat.S_ISREG(info.st_mode) or not (info.st_mode & 0o111) or info.st_uid != 0 or (info.st_mode & 0o022):
        return None
    in_bundle = True
    for parent in resolved.parents:
        try:
            pinfo = parent.lstat()
        except OSError:
            return None
        if not stat.S_ISDIR(pinfo.st_mode) or pinfo.st_uid != 0:
            return None
        if in_bundle:
            if pinfo.st_mode & 0o022:
                return None
            if parent == app_bundle:
                in_bundle = False
        else:
            if pinfo.st_mode & 0o002:
                return None
    return str(resolved)


def build_plist(template, install_dir, storage_categories=False, python_bin=None, use_app_bundle=None):
    with open(template, "rb") as stream:
        data = plistlib.load(stream)
    args = [
        value.replace("INSTALL_DIR", str(install_dir)) for value in data["ProgramArguments"]
    ]
    if storage_categories:
        if python_bin is not None:
            target = python_bin or None
        elif use_app_bundle or (use_app_bundle is None and can_build_app_bundle()):
            target = str(app_bundle_executable(install_dir))
        else:
            target = resolve_privileged_python()
        if target and args and args[0] == "/usr/bin/python3":
            args[0] = str(target)
        if "--storage-categories" not in args:
            args.append("--storage-categories")
    data["ProgramArguments"] = args
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


def _merge_installed_storage_categories(source_bytes, dest_path):
    """Preserve an existing root-owned regular runtimes.json's storageCategories setting."""
    try:
        info = dest_path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_uid != 0:
            return source_bytes
        existing = json.loads(dest_path.read_text("utf-8"))
        incoming = json.loads(source_bytes.decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return source_bytes
    if (
        isinstance(existing, dict)
        and isinstance(incoming, dict)
        and "storageCategories" in existing
        and "storageCategories" not in incoming
    ):
        incoming["storageCategories"] = existing["storageCategories"]
        return (json.dumps(incoming, indent=2) + "\n").encode("utf-8")
    return source_bytes


def install_payload(source, install_dir, plist_source, plist_dest):
    protected_directory(install_dir.parent)
    protected_directory(plist_dest.parent)
    if not install_dir.exists() and not install_dir.is_symlink():
        install_dir.mkdir(mode=0o755)
    protected_directory(install_dir)
    os.chown(install_dir, 0, 0)
    os.chmod(install_dir, 0o755)
    payloads = {name: (source / name).read_bytes() for name in ("sparkdash_mac_agent.py", "runtimes.json")}
    payloads["runtimes.json"] = _merge_installed_storage_categories(
        payloads["runtimes.json"], install_dir / "runtimes.json"
    )
    plist = plist_source.read_bytes()
    plist_data = plistlib.loads(plist)
    args = plist_data.get("ProgramArguments") or []
    if args and args[0] == str(app_bundle_executable(install_dir)):
        ensure_app_bundle(source, install_dir)
    for name, contents in payloads.items():
        replace_root_file(install_dir / name, contents)
    replace_root_file(plist_dest, plist)


if __name__ == "__main__":
    if sys.argv[1] == "plist":
        flags = sys.argv[4:]
        if any(flag != "--storage-categories" for flag in flags):
            raise SystemExit("unexpected plist flags")
        sys.stdout.buffer.write(
            build_plist(sys.argv[2], sys.argv[3], storage_categories="--storage-categories" in flags)
        )
    elif sys.argv[1] == "install":
        install_payload(*(Path(value) for value in sys.argv[2:]))
    else:
        raise SystemExit("expected plist or install")
