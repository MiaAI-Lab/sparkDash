#!/usr/bin/env python3
"""Run an owner-installed Mac model profile in the single heavy-engine slot.

Usage: profile_runner.py --profiles /path/profiles.json --inventory /path/runtimes.json
                        start|stop EXACT_PROFILE

Profiles are trusted data, never request-supplied shell fragments. Stop intentionally
stops every heavy engine via the installed model-stop-all command; no engine is
restored automatically. After that helper succeeds, surviving inventory-recognized
roots owned by this user may be stopped by exact captured process identity.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import copy
import fcntl
import importlib.util
import ipaddress
import json
import math
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

STOP_TIMEOUT = 90.0
STOP_TERM_GRACE = 5.0
CLEANUP_TIMEOUT = 30.0
MAX_READY_TIMEOUT = 300.0
POLL_INTERVAL = 0.25
# These persistent services are outside the dashboard's heavy-engine slot.
EXCLUDED_PORTS = {8200, 8400}
EXCLUDED_RUNTIMES = {"mtplx-mux", "bonsai"}


class RunnerError(Exception):
    """An actionable refusal or failed transition; no automatic recovery follows."""


class RunnerInterrupted(RunnerError):
    """Cancellation must escape retryable health and probe failures."""


class ProbeError(RunnerError):
    """Process state is temporarily unavailable; never evidence of an empty slot."""


def require_user():
    if os.getuid() == 0 or os.geteuid() == 0:
        raise RunnerError("root may not control user model profiles")
    if os.getuid() != os.geteuid():
        raise RunnerError("real and effective user must match")


def _private_file(info, mode):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
        raise RunnerError("file must be regular and owned by the current user (owner mismatch)")
    if stat.S_IMODE(info.st_mode) != mode:
        raise RunnerError(f"file permissions must be {mode:04o}")


def _argv(value, label):
    if (not isinstance(value, list) or not value or
            not all(isinstance(part, str) and part and "\0" not in part for part in value) or
            not os.path.isabs(value[0])):
        raise RunnerError(f"{label}: expected argv with an absolute executable")
    return value


def _validate_config(config):
    if not isinstance(config, dict) or not isinstance(config.get("profiles"), dict):
        raise RunnerError("profiles config must contain a profiles object")
    _argv(config.get("stop"), "stop")
    if not config["profiles"]:
        raise RunnerError("profiles config is empty")
    for name, profile in config["profiles"].items():
        if not isinstance(name, str) or not name or not isinstance(profile, dict):
            raise RunnerError("each profile needs a nonempty name and object")
        _argv(profile.get("argv"), name)
        port = profile.get("port")
        if type(port) is not int or not 1 <= port <= 65535:
            raise RunnerError(f"{name}: port must be an integer from 1 to 65535")
        if port in EXCLUDED_PORTS:
            raise RunnerError(f"{name}: port {port} belongs to a persistent service outside the heavy slot")
        model = profile.get("model")
        if not isinstance(model, str) or not model.strip() or "\0" in model:
            raise RunnerError(f"{name}: exact model API id is required")
        paths = profile.get("requiredPaths")
        if (not isinstance(paths, list) or
                not all(isinstance(p, str) and os.path.isabs(p) and "\0" not in p for p in paths)):
            raise RunnerError(f"{name}: requiredPaths must contain absolute local paths")
        timeout = profile.get("readyTimeout", MAX_READY_TIMEOUT)
        if (type(timeout) not in (int, float) or not math.isfinite(timeout) or
                not 0 < timeout <= MAX_READY_TIMEOUT):
            raise RunnerError(f"{name}: readyTimeout must be positive and at most 300 seconds")
        if type(profile.get("warmup", False)) is not bool:
            raise RunnerError(f"{name}: warmup must be boolean")
        key_file = profile.get("apiKeyFile")
        if key_file is not None and (not isinstance(key_file, str) or
                                     not os.path.isabs(key_file) or "\0" in key_file):
            raise RunnerError(f"{name}: apiKeyFile must be an absolute local path")


def load_api_key(path):
    """Read an existing credential without modifying it or exposing its value."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            _private_file(os.fstat(handle.fileno()), 0o600)
            key = handle.read(16385).strip()
        if not key or len(key) > 16384 or any(char.isspace() or ord(char) < 33 or
                                             ord(char) > 126 for char in key):
            raise RunnerError("API key must be a nonempty single ASCII token")
        return key
    except (OSError, ValueError) as exc:
        # Decode errors can contain credential bytes; never include them.
        raise RunnerError(f"cannot read private API key file {path}") from exc


def load_profiles(path):
    """Check the opened inode, not a path stat susceptible to symlink replacement."""
    require_user()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "r", encoding="utf-8") as handle:
            _private_file(os.fstat(handle.fileno()), 0o600)
            text = handle.read(1024 * 1024 + 1)
            if len(text) > 1024 * 1024:
                raise RunnerError("profiles config exceeds 1 MiB")
            config = json.loads(text)
        _validate_config(config)
        return config
    except (OSError, ValueError, TypeError) as exc:
        raise RunnerError(f"cannot read trusted profiles {path}: {exc}") from exc


def _strict_probe(argv, timeout=4.0):
    """The metrics collector tolerates empty probes; slot ownership cannot."""
    timeout = max(timeout, 15.0 if argv[0] == "ps" else 10.0)
    proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        out, err = proc.communicate(timeout=timeout)
    except BaseException as exc:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate(timeout=15)
        if isinstance(exc, subprocess.TimeoutExpired):
            raise ProbeError(f"{argv[0]} probe timed out after {timeout:g}s") from exc
        raise
    # lsof uses status 1 for an empty result. Diagnostics still mean failure.
    if proc.returncode and not (argv[0] == "lsof" and proc.returncode == 1 and not err.strip()):
        raise ProbeError(f"{argv[0]} probe failed (exit {proc.returncode}): {err.strip()}")
    return out


class MacBackend:
    """Reuse inventory matching, including known engines before they bind a port."""

    def __init__(self, inventory_path):
        spec = importlib.util.spec_from_file_location(
            "profile_inventory", Path(__file__).with_name("sparkdash_mac_agent.py"))
        self.agent = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.agent)
        self.agent.run = self._probe
        try:
            inventory = self.agent.load_inventory(Path(inventory_path))
        except SystemExit as exc:
            raise RunnerError(str(exc)) from exc
        self.known_ports = {
            int(port) for entry in inventory["runtimes"] if entry.get("name") not in EXCLUDED_RUNTIMES
            for port in entry.get("ports", [])
        } - EXCLUDED_PORTS
        self.inventory = copy.deepcopy(inventory)
        self.inventory["runtimes"] = [entry for entry in self.inventory["runtimes"]
                                      if entry.get("name") == "mtplx-mux" or
                                      not (entry.get("name") in EXCLUDED_RUNTIMES or
                                           (entry.get("ports") and
                                            set(entry["ports"]) <= EXCLUDED_PORTS))]
        # No health HTTP is needed for stop: process identity owns the GPU slot.
        # Removing port requirements also finds engines loading before listen().
        for entry in self.inventory["runtimes"]:
            entry["ports"] = []
        self.inventory.setdefault("defaults", {})["otherRuntime"] = {"enabled": False}

    def processes(self):
        procs = self.agent.list_processes()
        if os.getpid() not in procs:
            raise ProbeError("ps probe did not include this runner; cannot prove process state")
        return procs

    def _probe(self, argv, timeout=4.0, *, strict=False, allowed_codes=(0,)):
        # The collector calls these probes with strict=True so an unreadable
        # inventory can never be read as an empty one. Every probe here already
        # fails closed: _strict_probe raises ProbeError instead of returning an
        # empty sentinel, and it accepts only lsof's status 1 with no
        # diagnostics, which is the one answer that legitimately means "no
        # listeners". So the strict request needs no weaker path here.
        if argv == ["ps", "-Ao", "pid=,ppid=,uid=,args="]:
            # Include zombie state in the same probe, then preserve the existing
            # collector parser's input shape. Cold loads must not run two ps calls.
            text = _strict_probe(["ps", "-Ao", "pid=,ppid=,uid=,stat=,args="], timeout)
            rows = (line.split(None, 4) for line in text.splitlines())
            return "\n".join(" ".join((*parts[:3], parts[4])) for parts in rows
                             if len(parts) == 5 and not parts[3].startswith("Z"))
        return _strict_probe(argv, timeout)

    def listeners(self):
        return self.agent.listening_sockets()

    def runtimes(self, procs):
        return self.agent.detect_runtimes(self.inventory, procs, {})

    def group_members(self, pgid, procs):
        members = []
        for pid in procs:
            if procs[pid].get("uid") != os.getuid():
                continue
            try:
                if os.getpgid(pid) == pgid:
                    members.append(pid)
            except (ProcessLookupError, PermissionError):
                pass
        return members


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request_json(port, path, *, timeout, body=None, api_key=None):
    """Fixed loopback only: no proxy environment, redirects, or inventory URLs."""
    if type(port) is not int or not 1 <= port <= 65535 or path not in (
            "/v1/models", "/v1/chat/completions"):
        raise RunnerError("health request must use a fixed loopback models/chat endpoint")
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key is not None:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    with opener.open(req, timeout=timeout) as response:
        if response.status != 200:
            raise RunnerError(f"health returned HTTP {response.status}")
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise RunnerError("health response exceeds 1 MiB")
        return json.loads(payload)


def _extend_tree(identities, procs, roots=()):
    """Only follow children of an identity still present in this snapshot."""
    live = {pid for pid, text in identities.items()
            if pid in procs and procs[pid]["argvText"] == text}
    live.update(pid for pid in roots if pid in procs)
    while True:
        children = {pid for pid, row in procs.items() if row["ppid"] in live}
        if children <= live:
            break
        live.update(children)
    for pid in live:
        identities[pid] = procs[pid]["argvText"]


def _remaining(identities, procs):
    # A process may rewrite argv while retaining its GPU allocations. A changed
    # identity never authorizes a signal, but it also cannot prove process death.
    # Ambiguous PID reuse therefore refuses the switch instead of guessing.
    return set(identities).intersection(procs)


def _local_listener(row):
    """Tailnet brokers do not own the loopback slot; unknown binds fail closed."""
    address = row.get("address")
    if not isinstance(address, str) or ":" not in address:
        return True
    host, _, port = address.rpartition(":")
    if not port.isdigit() or host == "*":
        return True
    try:
        ip = ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_unspecified


class ProfileRunner:
    def __init__(self, config, backend, *, cache_dir=None, clock=time.monotonic,
                 sleep=time.sleep, popen=subprocess.Popen, request=request_json,
                 kill=os.kill, kill_group=os.killpg):
        self.config = config
        self.backend = backend
        self.cache_dir = Path(cache_dir) if cache_dir is not None else (
            Path.home() / "Library/Caches/sparkdash/profile-runner")
        self.clock = clock
        self.sleep = sleep
        self.popen = popen
        self.request = request
        self.kill = kill
        self.kill_group = kill_group
        self.cache_fd = None

    @contextmanager
    def lock(self):
        require_user()
        try:
            self.cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            directory = os.open(self.cache_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(directory)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise RunnerError("runner cache must be owned by the current user with mode 0700")
            with os.fdopen(os.open("runner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                                   0o600, dir_fd=directory), "a+") as handle:
                _private_file(os.fstat(handle.fileno()), 0o600)
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise RunnerError("model profile runner is busy; retry after the active transition") from exc
                self.cache_fd = directory
                try:
                    yield
                finally:
                    self.cache_fd = None
        except OSError as exc:
            raise RunnerError(f"cannot lock private runner cache: {exc}") from exc
        finally:
            if "directory" in locals():
                os.close(directory)

    def _log(self):
        name = f"profile-{uuid.uuid4().hex}.log"
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=self.cache_fd)
        return self.cache_dir / name, os.fdopen(fd, "ab", buffering=0)

    def _snapshot(self):
        procs = self.backend.processes()
        listeners = self.backend.listeners()
        runtimes = self.backend.runtimes(procs)
        ports = (set(self.backend.known_ports) | {p["port"] for p in self.config["profiles"].values()}) - EXCLUDED_PORTS
        excluded = {row["pid"] for row in runtimes if row["name"] in EXCLUDED_RUNTIMES}
        excluded.update(pid for pid, rows in listeners.items()
                        if rows and all(row["port"] in EXCLUDED_PORTS for row in rows))
        occupied = {pid: [row["port"] for row in rows if row["port"] in ports and _local_listener(row)]
                    for pid, rows in listeners.items() if pid not in excluded}
        occupied = {pid: rows for pid, rows in occupied.items() if rows}
        heavy = {row["pid"] for row in runtimes if row["pid"] not in excluded and
                 (row["name"] != "other-runtime" or row["pid"] in occupied)}
        heavy.update(occupied)
        return procs, heavy, occupied

    def _spawn(self, argv, log):
        return self.popen(argv, stdin=subprocess.DEVNULL, stdout=log,
                          stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)

    def _track_owned(self, proc, identities, procs=None):
        if procs is None:
            procs = self.backend.processes()
        # Do not poll/reap this child until cleanup is finished: its PID remains
        # reserved, even if it exits or execs while we are collecting identities.
        roots = (proc.pid,) if proc.returncode is None else ()
        if roots and hasattr(self.backend, "group_members"):
            roots = (*roots, *self.backend.group_members(proc.pid, procs))
        _extend_tree(identities, procs, roots=roots)
        return procs

    def _cleanup(self, proc, identities):
        try:
            self._cleanup_tree(proc, identities)
        except Exception:
            # A failed ps probe cannot prevent terminating the session we own.
            # With its child unreaped, this group ID cannot belong to a reused PID.
            if proc.returncode is None:
                try:
                    self.kill_group(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait(timeout=15)
            try:
                # A transient probe or delayed reap is not a cleanup failure if
                # a fresh snapshot proves all owned identities have now exited.
                self._cleanup_tree(proc, identities)
            except ProbeError as exc:
                def exists(pid, group=False):
                    try:
                        (os.killpg if group else os.kill)(pid, 0)
                        return True
                    except ProcessLookupError:
                        return False
                if exists(proc.pid, group=True) or any(exists(pid) for pid in identities):
                    raise RunnerError("owned session was killed but process death could not be verified") from exc

    def _cleanup_tree(self, proc, identities):
        """Terminate our session plus observed descendants, never previous engines."""
        deadline = self.clock() + CLEANUP_TIMEOUT
        for sig, grace in ((signal.SIGTERM, 2.0), (signal.SIGKILL, CLEANUP_TIMEOUT)):
            procs = self._track_owned(proc, identities)
            if proc.pid not in procs and not _remaining(identities, procs):
                proc.wait(timeout=15)
                return
            signaled = set()
            if proc.returncode is None:
                try:
                    self.kill_group(proc.pid, sig)
                except ProcessLookupError:
                    pass
                else:
                    if hasattr(self.backend, "group_members"):
                        signaled.update((pid, procs[pid]["argvText"]) for pid in
                                        self.backend.group_members(proc.pid, procs))
            until = min(deadline, self.clock() + grace)
            while True:
                procs = self._track_owned(proc, identities)
                for pid in _remaining(identities, procs):
                    if (pid, identities[pid]) in signaled:
                        continue
                    # Recheck identity immediately before a signal; a reused PID
                    # must never turn failure cleanup into an unrelated kill.
                    current = self.backend.processes().get(pid)
                    if current and current["argvText"] == identities[pid]:
                        try:
                            self.kill(pid, sig)
                            signaled.add((pid, identities[pid]))
                        except ProcessLookupError:
                            pass
                procs = self._track_owned(proc, identities)
                if not _remaining(identities, procs):
                    proc.wait(timeout=max(0.1, deadline - self.clock()))
                    return
                if self.clock() >= until:
                    break
                self.sleep(min(POLL_INTERVAL, until - self.clock()))
        raise RunnerError(f"failed start cleanup could not prove process death: PIDs {sorted(_remaining(identities, procs))}")

    def _stop(self, log):
        print("Stopping current runtime…", flush=True)
        deadline = self.clock() + STOP_TIMEOUT
        procs, heavy, occupied = self._snapshot()
        captured = {}
        _extend_tree(captured, procs, roots=heavy)
        # Port ownership alone is never permission to signal a process. Freeze
        # the recognized roots before the helper; a replacement or auto-restart
        # is a new process and must block the switch rather than inherit consent.
        authorized = {row["pid"]: procs[row["pid"]]["argvText"]
                      for row in self.backend.runtimes(procs)
                      if row.get("detectedBy") == "inventory" and
                      row.get("name") not in EXCLUDED_RUNTIMES | {"other-runtime"} and
                      row["pid"] in heavy and row["pid"] in procs and
                      procs[row["pid"]].get("uid") == os.getuid()}
        proc = self._spawn(self.config["stop"], log)
        owned = {}
        try:
            while proc.returncode is None:
                procs, heavy, occupied = self._snapshot()
                self._track_owned(proc, owned, procs)
                _extend_tree(captured, procs, roots=heavy)
                # A short wait lets us discover stop-command descendants even if
                # the command ignores TERM or the surrounding job times out.
                try:
                    proc.wait(timeout=min(POLL_INTERVAL, max(0.001, deadline - self.clock())))
                except subprocess.TimeoutExpired:
                    if self.clock() >= deadline:
                        raise RunnerError("stop command timed out after 90 seconds")
            if proc.returncode != 0:
                raise RunnerError(f"stop command exited {proc.returncode}; start refused")
        except BaseException:
            self._cleanup(proc, owned)
            raise
        print("Waiting for process and listener release…", flush=True)
        sent = {}
        while True:
            procs, heavy, occupied = self._snapshot()
            _extend_tree(captured, procs, roots=heavy)
            remaining = _remaining(captured, procs)
            if not remaining and not heavy and not occupied:
                print("Heavy-engine slot released.", flush=True)
                return
            if self.clock() >= deadline:
                raise RunnerError(f"stop did not empty the heavy-engine slot: PIDs {sorted(remaining | heavy)}; "
                                  f"listeners/ports {occupied}; start refused")
            for pid, text in authorized.items():
                if pid not in heavy or pid not in procs or procs[pid]["argvText"] != text:
                    continue
                previous = sent.get(pid)
                if previous is None:
                    sig = signal.SIGTERM
                elif previous[0] == signal.SIGTERM and self.clock() >= previous[1] + STOP_TERM_GRACE:
                    sig = signal.SIGKILL
                else:
                    continue
                current = self.backend.processes().get(pid)
                if self.clock() >= deadline:
                    break
                if current and current.get("uid") == os.getuid() and current["argvText"] == text:
                    try:
                        self.kill(pid, sig)
                    except ProcessLookupError:
                        pass
                    sent[pid] = (sig, self.clock())
                    log.write(f"stop fallback {sig.name}: inventory-owned PID {pid}\n".encode())
            self.sleep(min(POLL_INTERVAL, max(0, deadline - self.clock())))

    def _check_start_ownership(self, proc, profile, identities):
        procs, heavy, occupied = self._snapshot()
        self._track_owned(proc, identities, procs)
        if proc.pid not in procs:
            raise RunnerError("started process exited before model readiness")
        ours = _remaining(identities, procs)
        foreign = heavy - ours
        if foreign:
            raise RunnerError(f"foreign runtime/listener PIDs {sorted(foreign)} occupy the heavy-engine slot")
        return any(profile["port"] in ports for pid, ports in occupied.items() if pid in ours)

    def _ready(self, proc, profile, identities, api_key=None):
        print("Waiting for exact-model readiness…", flush=True)
        deadline = self.clock() + profile.get("readyTimeout", MAX_READY_TIMEOUT)
        last_error = "model not yet listed"
        while self.clock() < deadline:
            try:
                owns_listener = self._check_start_ownership(proc, profile, identities)
            except ProbeError as exc:
                last_error = f"process probe unavailable: {exc}"
                self.sleep(min(POLL_INTERVAL, max(0, deadline - self.clock())))
                continue
            if self.clock() >= deadline:
                break
            try:
                if not owns_listener:
                    raise RunnerError("started process tree does not yet own the profile listener")
                data = self.request(profile["port"], "/v1/models",
                                    timeout=min(1.0, deadline - self.clock()), api_key=api_key)
                rows = data.get("data", []) if isinstance(data, dict) else []
                if any(isinstance(row, dict) and row.get("id") == profile["model"] for row in rows):
                    if profile.get("warmup", False):
                        print("Warming selected model…", flush=True)
                        # Catalog presence (notably oMLX) does not prove GPU load.
                        remaining = deadline - self.clock()
                        if remaining <= 0:
                            break
                        result = self.request(profile["port"], "/v1/chat/completions", timeout=remaining,
                                              api_key=api_key, body={"model": profile["model"], "messages": [
                                                  {"role": "user", "content": "Hi"}], "max_tokens": 1,
                                                  "stream": False})
                        if not isinstance(result, dict) or not result.get("choices"):
                            raise RunnerError("warmup returned no completion choices")
                        if result.get("model", profile["model"]) != profile["model"]:
                            raise RunnerError("warmup completion used a different model API id")
                    if self.clock() >= deadline:
                        break
                    if not self._check_start_ownership(proc, profile, identities):
                        raise RunnerError("profile listener disappeared after readiness")
                    print("Selected model is ready.", flush=True)
                    return
                last_error = f"/v1/models does not list exact id {profile['model']!r}"
            except RunnerInterrupted:
                raise
            except (OSError, ValueError, RunnerError) as exc:
                last_error = f"readiness/warmup failed: {exc}"
            self.sleep(min(POLL_INTERVAL, max(0, deadline - self.clock())))
        raise RunnerError(f"model {profile['model']!r} was not ready: {last_error}")

    def execute(self, action, name):
        require_user()
        _validate_config(self.config)
        if action not in ("start", "stop"):
            raise RunnerError("action must be start or stop")
        if name not in self.config["profiles"]:
            raise RunnerError(f"unknown profile {name!r}; use an exact installed profile name")
        profile = self.config["profiles"][name]
        with self.lock():
            # Validate before model-stop-all so an invalid target cannot evict
            # the current engine. No user request is appended to either argv.
            commands = [self.config["stop"]]
            if action == "start":
                commands.append(profile["argv"])
            for argv in commands:
                if not Path(argv[0]).is_file() or not os.access(argv[0], os.X_OK):
                    raise RunnerError(f"executable is missing or not executable: {argv[0]}")
            api_key = None
            if action == "start":
                for path in profile["requiredPaths"]:
                    if not Path(path).exists():
                        raise RunnerError(f"required cached model path is missing: {path}")
                if profile.get("apiKeyFile") is not None:
                    api_key = load_api_key(profile["apiKeyFile"])
            log_path, log = self._log()
            with log:
                proc = None
                identities = {}
                try:
                    self._stop(log)
                    if action == "start":
                        print("Starting selected profile…", flush=True)
                        proc = self._spawn(profile["argv"], log)
                        self._ready(proc, profile, identities, api_key)
                except BaseException as exc:
                    try:
                        if proc is not None:
                            self._cleanup(proc, identities)
                    except Exception as cleanup:
                        message = f"{exc}; cleanup failed: {cleanup}"
                    else:
                        message = str(exc)
                    log.write(("ERROR: " + message + "\n").encode("utf-8", "replace"))
                    if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                        raise
                    raise RunnerError(f"{message}; inspect private log {log_path}") from exc
            return {"ok": True, "action": action, "profile": name,
                    "model": profile["model"], "log": str(log_path)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profiles", required=True, type=Path)
    parser.add_argument("--inventory", required=True, type=Path)
    parser.add_argument("action", choices=("start", "stop"))
    parser.add_argument("profile")
    args = parser.parse_args(argv)
    # Ensure an enclosing wrapper timeout follows the same owned-tree cleanup.
    def interrupted(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        raise RunnerInterrupted(f"profile runner interrupted by signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        config = load_profiles(args.profiles)
        backend = MacBackend(args.inventory)
        result = ProfileRunner(config, backend).execute(args.action, args.profile)
    except (RunnerError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(f"profile-runner: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
