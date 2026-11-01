"""Opt-in start/stop for the Mac node agent.

This module is imported only when a control request arrives or the user agent
starts. The privileged collector runs with ``python3 -I`` and does not ship
this file, so a failed import leaves ``/metrics`` alone.

Listing and status never run a start or stop command. Commands come from the
control catalog (default ``control.json``) and run only for an authorized
POST. The catalog is data: this file has no engine names of its own.

Each model row may supply its own ``start`` argv. The target's legacy ``start``
is usable only with at most one model. Start commands name verified switching
wrappers that own stopping, detaching, and waiting for the selected model.
``preStartStop`` is unsupported: empty telemetry cannot prove an engine stopped.
Optional ``health`` (port, path, expectedModel, timeoutMs) verifies the exact
OpenAI model ID once after success, preferring model-row settings.
``timeoutSeconds`` on a target bounds each command to 10..600 seconds (default
45). On timeout the wrapper has 60 seconds after SIGTERM to cancel and clean up
its detached engine before its owned process group is forcibly killed.
"""

from __future__ import annotations

import hmac
import json
import codecs
import math
import os
import signal
import selectors
import subprocess
import threading
import time
import urllib.request
import uuid
from pathlib import Path

CONTROL_SCHEMA = "sparkdash.mac-control/1"
CONTROL_TIMEOUT_S = 45.0
CONTROL_CANCEL_GRACE_S = 60.0
MAX_OUTPUT = 4000


def load_control_catalog(path: Path) -> tuple[dict, str | None]:
    """Return ``(catalog, error)``. A missing or unreadable file disables control."""
    if not path.is_file():
        return {"targets": []}, f"runtime control catalog is not installed ({path.name})"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"targets": []}, f"runtime control catalog is unreadable: {exc}"
    if not isinstance(data, dict) or not isinstance(data.get("targets"), list):
        return {"targets": []}, "runtime control catalog has no targets array"
    return data, None


def _signal_group(proc: subprocess.Popen, sig: int) -> None:
    try:
        os.killpg(proc.pid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.send_signal(sig)
        except OSError:
            pass


class _CommandOutput:
    """Drain fixed-size chunks; retain only a bounded tail across timeout stages."""

    def __init__(self, proc, on_output):
        self.proc = proc
        self.on_output = on_output
        self.output = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.eof = False

    def communicate(self, timeout):
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as selector:
            if not self.eof:
                selector.register(self.proc.stdout, selectors.EVENT_READ)
            while not self.eof or self.proc.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(self.proc.args, timeout)
                for key, _ in selector.select(min(remaining, 0.1)):
                    chunk = os.read(key.fd, 4096)
                    self.output = _clip(self.output + self.decoder.decode(chunk, final=not chunk))
                    if self.on_output:
                        self.on_output(self.output)
                    if not chunk:
                        self.eof = True
                        selector.unregister(key.fileobj)
        return self.output, None


def run_control_command(argv: list[str], timeout: float = CONTROL_TIMEOUT_S, *, on_output=None) -> dict[str, object]:
    """Run one catalog command. Never used by the metrics collector."""
    if not argv or not all(isinstance(part, str) and part for part in argv):
        return {"exitCode": 127, "output": "control command is not a valid argv", "timedOut": False}
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError as exc:
        return {"exitCode": 127, "output": str(exc), "timedOut": False}
    capture = _CommandOutput(proc, on_output)
    try:
        output, _ = capture.communicate(timeout=timeout)
        return {"exitCode": proc.returncode, "output": output or "", "timedOut": False}
    except subprocess.TimeoutExpired:
        _signal_group(proc, signal.SIGTERM)
        output = ""
        note = f"control command timed out after {timeout:.0f}s"
        try:
            output, _ = capture.communicate(timeout=CONTROL_CANCEL_GRACE_S)
        except subprocess.TimeoutExpired:
            _signal_group(proc, signal.SIGKILL)
            note += f"; cleanup exceeded {CONTROL_CANCEL_GRACE_S:.0f}s grace; process group killed"
            try:
                output, _ = capture.communicate(timeout=1)
            except Exception:
                output = capture.output
        return {
            "exitCode": proc.returncode if proc.returncode is not None else -1,
            "output": _clip(f"{output or ''}\n{note}"),
            "timedOut": True,
        }
    finally:
        proc.stdout.close()


def _clip(text: object) -> str:
    value = text if isinstance(text, str) else ""
    if len(value) <= MAX_OUTPUT:
        return value
    return value[-MAX_OUTPUT:]


def _argv_problem(argv: object) -> str | None:
    if not isinstance(argv, list) or not argv or not all(isinstance(part, str) and part for part in argv):
        return "no command configured"
    if not str(argv[0]).startswith("/"):
        return "command must be an absolute path"
    return None


def _models(target: dict) -> list[dict[str, str]]:
    models = []
    for row in target.get("models") or []:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue
        models.append({"id": model_id, "label": str(row.get("label") or model_id)})
    return models


def _model_rows(target: dict) -> list[dict]:
    return [row for row in target.get("models") or []
            if isinstance(row, dict) and str(row.get("id") or "").strip()]


def _prestart_problem(target: dict) -> str | None:
    if "preStartStop" in target or any("preStartStop" in row for row in _model_rows(target)):
        return "preStartStop is unsupported; use a verified switching profile"
    return None


def _start_command(target: dict, profile: dict) -> tuple[object, str | None]:
    if "start" in profile:
        argv = profile["start"]
    elif len(_model_rows(target)) <= 1:
        argv = target.get("start")
    else:
        return None, "model has no start command configured"
    return argv, _argv_problem(argv)


def _health_problem(health: object) -> str | None:
    if not isinstance(health, dict):
        return "health must be an object"
    port = health.get("port")
    path = health.get("path", "/v1/models")
    expected = health.get("expectedModel")
    timeout = health.get("timeoutMs", 1000)
    if type(port) is not int or not 1 <= port <= 65535:
        return "health port must be an integer from 1 to 65535"
    if (not isinstance(path, str) or not path.startswith("/") or path.startswith("//")
            or any(ord(char) < 33 for char in path)):
        return "health path must be an absolute loopback HTTP path"
    if not isinstance(expected, str) or not expected.strip():
        return "health expectedModel is required"
    if type(timeout) is not int or not 1 <= timeout <= 10000:
        return "health timeoutMs must be an integer from 1 to 10000"
    return None


def _verify_health(health: dict) -> str | None:
    expected = health["expectedModel"]
    url = f"http://127.0.0.1:{health['port']}{health.get('path', '/v1/models')}"
    try:
        with urllib.request.urlopen(url, timeout=health.get("timeoutMs", 1000) / 1000) as response:
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}")
            data = json.loads(response.read(65536))
        rows = data.get("data") if isinstance(data, dict) else None
        if (not isinstance(rows, list) or not rows
                or any(not isinstance(row, dict) or row.get("id") != expected for row in rows)):
            return f"health verification failed: expected model {expected} at {url}"
    except Exception as exc:
        return f"health verification failed for expected model {expected} at {url}: {exc}"
    return None


def bearer_token(headers) -> str:
    """Token from Authorization: Bearer or X-Sparkdash-Control-Token. Empty if absent."""
    if headers is None:
        return ""
    header = headers.get("Authorization") or headers.get("authorization") or ""
    if isinstance(header, str):
        prefix = "bearer "
        if header.lower().startswith(prefix):
            return header[len(prefix):].strip()
    alt = headers.get("X-Sparkdash-Control-Token") or headers.get("x-sparkdash-control-token") or ""
    return alt.strip() if isinstance(alt, str) else ""


class RuntimeControl:
    """Catalog lookup plus the permission gate. The runner is injected in tests."""

    def __init__(self, catalog: dict | None, *, token: str = "", euid: int = 1,
                 load_error: str | None = None, probe_serving=None, runner=None,
                 timeout: float = CONTROL_TIMEOUT_S):
        self._catalog = catalog if isinstance(catalog, dict) else {"targets": []}
        self._token = (token or "").strip()
        self._euid = euid
        self._load_error = load_error
        self._probe = probe_serving or (lambda: [])
        self._runner = runner or run_control_command
        self._timeout = timeout
        self._action_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._operation = None

    def capability(self) -> tuple[str, str | None]:
        """ready, disabled (unavailable to the dashboard), or denied."""
        if self._euid == 0:
            return "denied", "privileged collector cannot launch user runtimes"
        if self._load_error:
            return "disabled", self._load_error
        if not self._token:
            return "disabled", "SPARKDASH_MAC_CONTROL_TOKEN is not set; runtime control is unavailable"
        return "ready", None

    def _targets(self) -> list[dict]:
        rows = self._catalog.get("targets") or []
        return [row for row in rows if isinstance(row, dict) and str(row.get("name") or "").strip()]

    def _public_targets(self) -> list[dict[str, object]]:
        public = []
        for target in self._targets():
            name = str(target["name"]).strip()
            profiles = _model_rows(target) or [{}]
            start_problem = _prestart_problem(target) or next((problem for profile in profiles
                                  if (problem := _start_command(target, profile)[1])), None)
            stop_problem = _prestart_problem(target) or _argv_problem(target.get("stop"))
            public.append({
                "name": name,
                "label": str(target.get("label") or name),
                "group": str(target.get("group") or name),
                "groupLabel": str(target.get("groupLabel") or target.get("label") or name),
                "models": _models(target),
                "startable": start_problem is None,
                "stoppable": stop_problem is None,
                "reason": start_problem or stop_problem,
            })
        return public

    def _find(self, name: str) -> dict | None:
        for target in self._targets():
            if str(target.get("name") or "").strip() == name:
                return target
        return None

    def _serving(self) -> tuple[list | None, str | None]:
        try:
            rows = self._probe()
        except Exception as exc:
            return None, f"serving probe failed: {exc}"
        if not isinstance(rows, list):
            return None, "serving probe returned an unexpected payload"
        if any(not isinstance(row, dict) or not str(row.get("name") or "").strip() for row in rows):
            return None, "serving probe returned an invalid runtime row"
        return rows, None

    def status(self, headers=None) -> dict[str, object]:
        """Report capabilities. Only an authorized caller sees the catalog, the
        serving list, or any operation output; a refused read never probes."""
        control, reason = self.authorize(headers or {})
        if control == "denied":
            return self._refused(control, reason or "control token rejected")
        serving, serving_error = self._serving()
        return {
            "schema": CONTROL_SCHEMA,
            "control": control,
            "reason": reason,
            "serving": serving,
            "servingError": serving_error,
            "targets": self._public_targets() if control == "ready" else [],
            **self._operation_status(include_operation=control == "ready"),
        }

    def _operation_status(self, *, include_operation=True) -> dict[str, object]:
        # Reserve, complete, and release under the same lock so GET never sees
        # a new action paired with the previous operation's result.
        with self._state_lock:
            return {
                "busy": self._action_lock.locked(),
                "operation": dict(self._operation) if include_operation and self._operation else None,
            }

    def authorize(self, headers) -> tuple[str, str | None]:
        control, reason = self.capability()
        if control != "ready":
            return control, reason
        provided = bearer_token(headers)
        if not provided or not _tokens_equal(provided, self._token):
            return "denied", "control token rejected"
        return "ready", None

    def act(self, action: str, headers, body: dict | None) -> tuple[int, dict[str, object]]:
        control, reason = self.authorize(headers)
        if control != "ready":
            status = 403
            return status, self._refused(control, reason or "runtime control refused")
        if action not in ("start", "stop"):
            return 400, self._refused("ready", "action must be start or stop")
        with self._state_lock:
            acquired = self._action_lock.acquire(blocking=False)
            if acquired:
                payload = body if isinstance(body, dict) else {}
                self._operation = {
                    "id": str(uuid.uuid4()), "state": "running", "action": action,
                    "output": "",
                    "runtime": payload["runtime"].strip() if isinstance(payload.get("runtime"), str) else None,
                    "model": payload["model"].strip() if isinstance(payload.get("model"), str) else None,
                }
        if not acquired:
            return 409, self._refused("ready", "runtime control is busy; retry after the current action", probe=False)
        status = 500
        result = {
            "schema": CONTROL_SCHEMA, "ok": False, "error": "runtime control action failed",
            "control": "ready", "reason": None, "serving": None, "servingError": None, "targets": [],
        }
        try:
            status, result = self._act_locked(action, body)
        except Exception as exc:
            result["error"] = f"runtime control action failed: {_clip(str(exc))}"
        finally:
            with self._state_lock:
                self._operation = {
                    **self._operation, "state": "complete", "ok": bool(result.get("ok")),
                    "error": _clip(result.get("error")) or None,
                    "output": _clip(result.get("output")) or None,
                }
                result.update({"busy": False, "operation": dict(self._operation)})
                self._action_lock.release()
        return status, result

    def _act_locked(self, action: str, body: dict | None) -> tuple[int, dict[str, object]]:
        payload = body if isinstance(body, dict) else {}
        name = payload.get("runtime")
        if not isinstance(name, str) or not name.strip() or len(name) > 64:
            return 400, self._refused("ready", "runtime is required")
        name = name.strip()
        target = self._find(name)
        if target is None:
            return 404, self._refused("ready", f"unknown runtime {name}")
        if problem := _prestart_problem(target):
            return 409, self._refused("ready", f"{name}: {problem}", probe=False)
        requested = payload.get("model")
        model, model_error = self._resolve_model(target, requested, required=action == "start")
        if model_error:
            return 400, self._refused("ready", model_error)
        profiles = [row for row in _model_rows(target) if str(row["id"]).strip() == model]
        if len(profiles) > 1:
            return 409, self._refused("ready", f"{name}: duplicate model {model}")
        profile = profiles[0] if profiles else {}
        if action == "start":
            argv, problem = _start_command(target, profile)
        else:
            argv = target.get("stop")
            problem = _argv_problem(argv)
        if problem:
            return 409, self._refused("ready", f"{name}: {problem}")
        timeout = target.get("timeoutSeconds", self._timeout)
        if "timeoutSeconds" in target and (type(timeout) not in (int, float)
                or not math.isfinite(timeout) or not 10 <= timeout <= 600):
            return 409, self._refused("ready", f"{name}: timeoutSeconds must be a number from 10 to 600")
        health = profile.get("health", target.get("health")) if action == "start" else None
        if health is not None and (problem := _health_problem(health)):
            return 409, self._refused("ready", f"{name}: {problem}")
        if action == "start":
            # An unknown serving state cannot prove the current engine is gone,
            # so a launch is refused rather than guessed at.
            serving, serving_error = self._serving()
            if serving is None:
                return 503, self._refused("ready", serving_error or "serving state is unknown")
        with self._state_lock:
            self._operation = {**self._operation, "runtime": name, "model": model}
        # The request selects a catalog entry. It never becomes part of the command.
        result = self._run(argv, timeout)
        error = None
        if health is not None and result.get("exitCode") == 0 and not result.get("timedOut"):
            error = _verify_health(health)
        return self._completed(action, name, model, result, error)

    def _run(self, argv: list[str], timeout: float) -> dict:
        try:
            if self._runner is run_control_command:
                with self._state_lock:
                    operation_id = self._operation["id"]

                def publish(output):
                    with self._state_lock:
                        if self._operation["id"] == operation_id and self._operation["state"] == "running":
                            self._operation["output"] = _clip(output)

                return self._runner(list(argv), timeout, on_output=publish)
            return self._runner(list(argv), timeout)
        except Exception as exc:
            return {"exitCode": 127, "output": f"control command failed: {exc}", "timedOut": False}

    def _completed(self, action: str, name: str, model: str | None,
                   result: dict, error: str | None = None) -> tuple[int, dict[str, object]]:
        serving, serving_error = self._serving()
        exit_code = result.get("exitCode")
        output = _clip(result.get("output"))
        ok = exit_code == 0 and not result.get("timedOut") and error is None
        if not ok:
            error = ": ".join(part for part in (error, output.strip()) if part) or f"{action} exited {exit_code}"
        return 200, {
            "schema": CONTROL_SCHEMA,
            "ok": ok,
            "action": action,
            "runtime": name,
            "model": model,
            "exitCode": exit_code,
            "timedOut": bool(result.get("timedOut")),
            "output": output,
            "error": error,
            "control": "ready",
            "reason": None,
            "serving": serving,
            "servingError": serving_error,
            "targets": self._public_targets(),
        }

    def _resolve_model(self, target: dict, requested, *, required=True) -> tuple[str | None, str | None]:
        models = _models(target)
        if requested is None or requested == "":
            if not required:
                return None, None
            if len(models) <= 1:
                return (models[0]["id"] if models else None), None
            return None, "model is required"
        if not isinstance(requested, str):
            return None, "model must be a string"
        model_id = requested.strip()
        if not any(row["id"] == model_id for row in models):
            return None, f"unknown model {model_id}"
        return model_id, None

    def _refused(self, control: str, reason: str, *, probe=True) -> dict[str, object]:
        serving, serving_error = (None, None)
        if control == "ready" and probe:
            serving, serving_error = self._serving()
        return {
            "schema": CONTROL_SCHEMA,
            "ok": False,
            "error": reason,
            "control": control,
            "reason": reason,
            "serving": serving,
            "servingError": serving_error,
            "targets": self._public_targets() if control == "ready" else [],
            **self._operation_status(include_operation=control == "ready"),
        }


def _tokens_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left, right)
