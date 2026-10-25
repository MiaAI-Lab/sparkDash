"""Opt-in start/stop for the Mac node agent.

This module is imported only when a control request arrives or the user agent
starts. The privileged collector runs with ``python3 -I`` and does not ship
this file, so a failed import leaves ``/metrics`` alone.

Listing and status never run a start or stop command. Commands come from the
control catalog (default ``control.json``) and run only for an authorized
POST. The catalog is data: this file has no engine names of its own.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
from pathlib import Path

CONTROL_SCHEMA = "sparkdash.mac-control/1"
CONTROL_TIMEOUT_S = 45.0
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


def _kill_group(proc: subprocess.Popen) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def run_control_command(argv: list[str], timeout: float = CONTROL_TIMEOUT_S) -> dict[str, object]:
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
            text=True,
        )
    except OSError as exc:
        return {"exitCode": 127, "output": str(exc), "timedOut": False}
    try:
        output, _ = proc.communicate(timeout=timeout)
        return {"exitCode": proc.returncode, "output": output or "", "timedOut": False}
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        output = ""
        try:
            output, _ = proc.communicate(timeout=1)
        except Exception:
            output = ""
        note = f"control command timed out after {timeout:.0f}s"
        return {
            "exitCode": proc.returncode if proc.returncode is not None else -1,
            "output": f"{output or ''}{note}",
            "timedOut": True,
        }


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
            start_problem = _argv_problem(target.get("start"))
            stop_problem = _argv_problem(target.get("stop"))
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
        return rows, None

    def status(self) -> dict[str, object]:
        control, reason = self.capability()
        serving, serving_error = self._serving()
        return {
            "schema": CONTROL_SCHEMA,
            "control": control,
            "reason": reason,
            "serving": serving,
            "servingError": serving_error,
            "targets": self._public_targets(),
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
        payload = body if isinstance(body, dict) else {}
        name = payload.get("runtime")
        if not isinstance(name, str) or not name.strip() or len(name) > 64:
            return 400, self._refused("ready", "runtime is required")
        name = name.strip()
        target = self._find(name)
        if target is None:
            return 404, self._refused("ready", f"unknown runtime {name}")
        model, model_error = self._resolve_model(target, payload.get("model"))
        if model_error:
            return 400, self._refused("ready", model_error)
        argv = target.get("stop" if action == "stop" else "start")
        problem = _argv_problem(argv)
        if problem:
            return 409, self._refused("ready", f"{name}: {problem}")
        # The request selects a catalog entry. It never becomes part of the command.
        result = self._runner(list(argv), self._timeout)
        serving, serving_error = self._serving()
        exit_code = result.get("exitCode")
        output = _clip(result.get("output"))
        ok = exit_code == 0 and not result.get("timedOut")
        error = None if ok else (output.strip() or f"{action} exited {exit_code}")
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

    def _resolve_model(self, target: dict, requested) -> tuple[str | None, str | None]:
        models = _models(target)
        if requested is None or requested == "":
            if len(models) <= 1:
                return (models[0]["id"] if models else None), None
            return None, "model is required"
        if not isinstance(requested, str):
            return None, "model must be a string"
        model_id = requested.strip()
        if models and not any(row["id"] == model_id for row in models):
            return None, f"unknown model {model_id}"
        return model_id, None

    def _refused(self, control: str, reason: str) -> dict[str, object]:
        serving, serving_error = (None, None)
        if control == "ready":
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
        }


def _tokens_equal(left: str, right: str) -> bool:
    if len(left) != len(right):
        return False
    diff = 0
    for a, b in zip(left, right):
        diff |= ord(a) ^ ord(b)
    return diff == 0
