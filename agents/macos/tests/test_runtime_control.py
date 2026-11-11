"""Control endpoint: list, start, stop, and the gates around them.

Status and /metrics must not run a catalog command.
"""

from __future__ import annotations

import json
import http.client
import os
import signal
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import importlib.util

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("mac_agent", HERE / "sparkdash_mac_agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)

control_spec = importlib.util.spec_from_file_location("runtime_control", HERE / "runtime_control.py")
control = importlib.util.module_from_spec(control_spec)
control_spec.loader.exec_module(control)


def catalog():
    return {
        "targets": [
            {
                "name": "splash-35b",
                "label": "Splash 35B",
                "group": "splash",
                "groupLabel": "Splash",
                "models": [{"id": "incoai/Qwen3.6-35B-A3B-Splash", "label": "35B"}],
                "start": ["/bin/zsh", "-c", "model-start splash-35b"],
                "stop": ["/bin/zsh", "-c", "model-stop splash"],
            },
            {
                "name": "tensorfold",
                "label": "TensorFold",
                "group": "tensorfold",
                "groupLabel": "TensorFold",
                "models": [
                    {"id": "a", "label": "A"},
                    {"id": "b", "label": "B"},
                ],
                "start": ["/bin/zsh", "-c", "model-start tensorfold"],
                "stop": ["/bin/zsh", "-c", "model-stop tensorfold"],
            },
        ]
    }


class ControlUnitTests(unittest.TestCase):
    def test_status_lists_targets_and_does_not_run_a_command(self):
        calls = []
        probes = []

        def runner(argv, timeout):
            calls.append(argv)
            return {"exitCode": 0, "output": "", "timedOut": False}

        def probe():
            probes.append(1)
            return [{"name": "splash-35b", "state": "serving", "model": "35b"}]

        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=501, probe_serving=probe, runner=runner,
        )
        payload = ctl.status({"Authorization": "Bearer secret"})
        self.assertEqual(payload["schema"], control.CONTROL_SCHEMA)
        self.assertEqual(payload["control"], "ready")
        self.assertEqual(payload["serving"][0]["name"], "splash-35b")
        self.assertEqual([row["name"] for row in payload["targets"]], ["splash-35b", "tensorfold"])
        self.assertNotIn("start", payload["targets"][0])
        self.assertEqual(calls, [])
        self.assertEqual(probes, [1])

    def test_start_and_stop_round_trip_uses_catalog_argv_not_the_request(self):
        calls = []

        def runner(argv, timeout):
            calls.append((list(argv), timeout))
            return {"exitCode": 0, "output": "ok", "timedOut": False}

        serving = []

        def probe():
            return list(serving)

        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=501, probe_serving=probe, runner=runner, timeout=3,
        )
        headers = {"Authorization": "Bearer secret"}
        status, started = ctl.act("start", headers, {
            "runtime": "splash-35b",
            "model": "incoai/Qwen3.6-35B-A3B-Splash",
            "start": ["rm", "-rf", "/"],
        })
        self.assertEqual(status, 200)
        self.assertTrue(started["ok"])
        self.assertEqual(calls[0][0], ["/bin/zsh", "-c", "model-start splash-35b"])
        serving.append({"name": "splash-35b", "state": "serving"})
        status, stopped = ctl.act("stop", headers, {"runtime": "splash-35b"})
        self.assertEqual(status, 200)
        self.assertTrue(stopped["ok"])
        self.assertEqual(calls[1][0], ["/bin/zsh", "-c", "model-stop splash"])
        self.assertEqual(stopped["serving"][0]["name"], "splash-35b")

    def test_wrong_token_is_permission_denied_and_does_not_run(self):
        calls = []
        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=501,
            probe_serving=lambda: [],
            runner=lambda argv, timeout: calls.append(argv),
        )
        status, payload = ctl.act("start", {"Authorization": "Bearer no"}, {"runtime": "splash-35b"})
        self.assertEqual(status, 403)
        self.assertEqual(payload["control"], "denied")
        self.assertIn("rejected", payload["error"])
        self.assertEqual(calls, [])

    def test_missing_token_configuration_is_unavailable_and_does_not_run(self):
        calls = []
        ctl = control.RuntimeControl(
            catalog(), token="", euid=501,
            probe_serving=lambda: [],
            runner=lambda argv, timeout: calls.append(argv),
        )
        self.assertEqual(ctl.status()["control"], "disabled")
        status, payload = ctl.act("start", {"Authorization": "Bearer secret"}, {"runtime": "splash-35b"})
        self.assertEqual(status, 403)
        self.assertEqual(payload["control"], "disabled")
        self.assertIn("SPARKDASH_MAC_CONTROL_TOKEN", payload["error"])
        self.assertEqual(calls, [])

    def test_root_is_permission_denied_before_any_command(self):
        calls = []
        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=0,
            probe_serving=lambda: [{"name": "should-not-matter"}],
            runner=lambda argv, timeout: calls.append(argv),
        )
        status, payload = ctl.act("stop", {"Authorization": "Bearer secret"}, {"runtime": "splash-35b"})
        self.assertEqual(status, 403)
        self.assertEqual(payload["control"], "denied")
        self.assertIn("privileged", payload["error"])
        self.assertEqual(calls, [])

    def test_command_failure_keeps_the_real_output(self):
        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=501,
            probe_serving=lambda: [],
            runner=lambda argv, timeout: {"exitCode": 1, "output": "splash: model is not installed\n", "timedOut": False},
        )
        status, payload = ctl.act("start", {"Authorization": "Bearer secret"}, {"runtime": "splash-35b"})
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertIn("not installed", payload["error"])
        self.assertEqual(payload["serving"], [])

    def test_unknown_model_does_not_run(self):
        calls = []
        ctl = control.RuntimeControl(
            catalog(), token="secret", euid=501,
            probe_serving=lambda: [],
            runner=lambda argv, timeout: calls.append(argv) or {"exitCode": 0, "output": "", "timedOut": False},
        )
        status, payload = ctl.act("start", {"Authorization": "Bearer secret"}, {
            "runtime": "tensorfold", "model": "not-a-catalog-model",
        })
        self.assertEqual(status, 400)
        self.assertIn("unknown model", payload["error"])
        self.assertEqual(calls, [])


class ProfileControlTests(unittest.TestCase):
    def setUp(self):
        self.data = catalog()
        self.target = self.data["targets"][1]
        self.target["models"][0]["start"] = ["/owned/launcher", "start", "a"]
        self.target["models"][1]["start"] = ["/owned/launcher", "start", "b"]
        self.calls = []
        self.serving = []
        self.headers = {"Authorization": "Bearer secret"}
        self.ctl = control.RuntimeControl(
            self.data, token="secret", euid=501,
            probe_serving=lambda: list(self.serving), runner=self.run_command,
        )

    def run_command(self, argv, timeout):
        self.calls.append((argv, timeout))
        return {"exitCode": 0, "output": "done", "timedOut": False}

    def act(self, action="start", **payload):
        return self.ctl.act(action, self.headers, {"runtime": "tensorfold", **payload})

    def test_each_model_dispatches_its_exact_catalog_command(self):
        for model in ("a", "b"):
            with self.subTest(model=model):
                status, payload = self.act(model=model, start=["/untrusted"], timeoutSeconds=600)
                self.assertEqual(status, 200)
                self.assertTrue(payload["ok"])
                self.assertEqual(payload["model"], model)
                self.assertEqual(self.calls[-1], (["/owned/launcher", "start", model], 45))
        public = self.ctl.status(self.headers)["targets"][1]
        self.assertTrue(public["startable"])
        self.assertEqual(public["models"], [{"id": "a", "label": "A"}, {"id": "b", "label": "B"}])
        self.assertNotIn("/owned", json.dumps(public))

    def test_ambiguous_target_command_cannot_substitute_for_model_command(self):
        del self.target["models"][0]["start"]
        status, payload = self.act(model="a")
        self.assertEqual(status, 409)
        self.assertIn("model", payload["error"])
        self.assertEqual(self.calls, [])

    def test_unknown_missing_and_duplicate_models_do_not_run(self):
        for requested in (None, "unknown", 42):
            with self.subTest(requested=requested):
                status, _ = self.act(model=requested)
                self.assertEqual(status, 400)
        self.target["models"].append(dict(self.target["models"][0]))
        status, payload = self.act(model="a")
        self.assertEqual(status, 409)
        self.assertIn("duplicate", payload["error"])
        self.assertEqual(self.calls, [])

    def test_unknown_runtime_and_uncatalogued_model_do_not_run(self):
        status, _ = self.ctl.act("start", self.headers, {"runtime": "unknown"})
        self.assertEqual(status, 404)
        self.target["models"] = []
        status, _ = self.act(model="uncatalogued")
        self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_denied_requests_never_run_hooks_probe_or_health(self):
        self.target["preStartStop"] = ["/owned/launcher", "stop-all"]
        self.target["health"] = {"port": 8100, "expectedModel": "a"}
        probe = mock.Mock(side_effect=AssertionError("denied request probed runtimes"))
        self.ctl._probe = probe
        for euid, token in ((501, "wrong"), (0, "secret")):
            with self.subTest(euid=euid):
                self.ctl._euid = euid
                with mock.patch.object(control.urllib.request, "urlopen") as health:
                    status, payload = self.ctl.act("start", {"Authorization": f"Bearer {token}"}, {
                        "runtime": "tensorfold", "model": "a",
                    })
                    self.assertEqual(status, 403)
                    self.assertEqual(payload["targets"], [])
                    health.assert_not_called()
        probe.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_model_command_must_be_absolute_even_with_target_fallback(self):
        self.target["models"][0]["start"] = ["relative-launcher"]
        status, payload = self.act(model="a")
        self.assertEqual(status, 409)
        self.assertIn("absolute", payload["error"])
        self.assertEqual(self.calls, [])

    def test_single_model_legacy_command_and_model_override(self):
        self.target["models"] = [self.target["models"][0]]
        status, payload = self.act()
        self.assertEqual(status, 200)
        self.assertEqual(payload["model"], "a")
        self.assertEqual(self.calls[-1][0], ["/owned/launcher", "start", "a"])
        del self.target["models"][0]["start"]
        status, payload = self.act()
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(self.calls[-1][0], self.target["start"])

    def test_stop_multiple_models_without_a_model_and_invalid_action(self):
        status, payload = self.act("stop")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(self.calls[-1][0], self.target["stop"])
        self.calls.clear()
        for action in ("restart", "START", "", None):
            with self.subTest(action=action):
                status, _ = self.act(action, model="a")
                self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_busy_rejects_concurrent_actions_after_authentication(self):
        entered = threading.Event()
        release = threading.Event()
        results = []

        def blocked(argv, timeout):
            self.calls.append((argv, timeout))
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test runner was not released")
            return {"exitCode": 0, "output": "", "timedOut": False}

        self.ctl._runner = blocked
        worker = threading.Thread(target=lambda: results.append(self.act(model="a")))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            running = self.ctl.status(self.headers)
            self.assertTrue(running["busy"])
            operation = running["operation"]
            self.assertIsInstance(operation["id"], str)
            self.assertEqual(operation["state"], "running")
            self.assertEqual((operation["runtime"], operation["model"], operation["action"]),
                             ("tensorfold", "a", "start"))
            status, denied = self.ctl.act("stop", {"Authorization": "Bearer wrong"}, {"runtime": "tensorfold"})
            self.assertEqual(status, 403)
            self.assertEqual(denied["serving"], None)
            status, busy = self.act("stop")
            self.assertEqual(status, 409)
            self.assertIn("busy", busy["error"])
            self.assertEqual(len(self.calls), 1)
            self.assertEqual(self.ctl.status(self.headers)["control"], "ready")
            self.assertEqual(self.ctl.status(self.headers)["operation"], operation)
            self.assertEqual(busy["operation"], operation)
            self.assertTrue(busy["busy"])
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertTrue(results[0][1]["ok"])
        completed = self.ctl.status(self.headers)
        self.assertFalse(completed["busy"])
        self.assertEqual(completed["operation"]["id"], operation["id"])
        self.assertEqual(completed["operation"]["state"], "complete")
        self.assertEqual(results[0][1]["operation"], completed["operation"])
        self.assertFalse(results[0][1]["busy"])
        self.assertTrue(self.act("stop")[1]["ok"])

    def test_operation_persists_success_and_failure_without_request_credentials(self):
        self.assertFalse(self.ctl.status(self.headers)["busy"])
        self.assertIsNone(self.ctl.status(self.headers)["operation"])
        previous_id = None
        for exit_code in (0, 1):
            with self.subTest(exit_code=exit_code):
                self.ctl._runner = lambda argv, timeout: {
                    "exitCode": exit_code, "output": "finished", "timedOut": False,
                }
                status, result = self.act(model="a", token="request-private", start=["/request-private"])
                self.assertEqual(status, 200)
                snapshot = self.ctl.status(self.headers)
                operation = snapshot["operation"]
                self.assertFalse(snapshot["busy"])
                self.assertEqual(operation, result["operation"])
                self.assertNotEqual(operation["id"], previous_id)
                previous_id = operation["id"]
                self.assertEqual(operation["state"], "complete")
                self.assertEqual(operation["ok"], exit_code == 0)
                self.assertEqual(operation["output"], "finished")
                self.assertEqual(operation["error"], None if exit_code == 0 else "finished")
                self.assertEqual(set(operation), {"id", "state", "runtime", "model", "action", "ok", "error", "output"})
                self.assertNotIn("secret", json.dumps(result))
                self.assertNotIn("request-private", json.dumps(snapshot))
                operation["state"] = "tampered"
                result["operation"]["state"] = "tampered"
                self.assertEqual(self.ctl.status(self.headers)["operation"]["state"], "complete")

    def test_unexpected_action_exception_completes_failure_and_releases_lock(self):
        with mock.patch.object(self.ctl, "_act_locked", side_effect=RuntimeError("unexpected failure")):
            status, result = self.act(model="b")
        self.assertEqual(status, 500)
        self.assertFalse(result["busy"])
        self.assertFalse(result["ok"])
        operation = self.ctl.status(self.headers)["operation"]
        self.assertEqual(operation, result["operation"])
        self.assertEqual(operation["state"], "complete")
        self.assertFalse(operation["ok"])
        self.assertIn("unexpected failure", operation["error"])
        self.assertEqual(self.calls, [])
        self.assertTrue(self.act(model="a")[1]["ok"])

    def test_prestart_hook_is_unsupported_without_commands_or_probes(self):
        probe = mock.Mock(side_effect=AssertionError("unsupported hook must not probe"))
        self.ctl._probe = probe
        for location in (self.target, self.target["models"][0]):
            for hook in (["/owned/stop-all"], None, []):
                for action in ("start", "stop"):
                    with self.subTest(location=location, hook=hook, action=action):
                        location["preStartStop"] = hook
                        try:
                            status, payload = self.act(action, model="a")
                            self.assertEqual(status, 409)
                            self.assertIn("preStartStop is unsupported", payload["error"])
                            self.assertIn("verified switching profile", payload["error"])
                            self.assertFalse(payload["targets"][1]["startable"])
                            self.assertFalse(payload["targets"][1]["stoppable"])
                            self.assertIsNone(payload["serving"])
                            self.assertEqual(self.calls, [])
                            probe.assert_not_called()
                        finally:
                            del location["preStartStop"]
        self.ctl._probe = lambda: []
        self.assertTrue(self.act(model="b")[1]["ok"])

    def test_wrapper_without_prestart_hook_owns_switching_and_verification(self):
        self.serving = [{"name": "old-engine", "state": "serving"}]
        probe = mock.Mock(side_effect=lambda: list(self.serving))
        self.ctl._probe = probe

        def switch(argv, timeout):
            # The pre-launch check only asks whether the serving state is knowable
            # at all; the wrapper still owns stopping, detaching, and waiting.
            self.assertEqual(probe.call_count, 1)
            self.serving = [{"name": "tensorfold", "state": "serving", "model": "a"}]
            return self.run_command(argv, timeout)

        self.ctl._runner = switch
        status, payload = self.act(model="a")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["serving"][0]["model"], "a")
        # One bounded read before the launch, one after it to report the result.
        self.assertEqual(probe.call_count, 2)

    def test_timeout_reports_failure_even_when_cancelled_wrapper_exits_zero(self):
        self.ctl._runner = lambda argv, timeout: {
            "exitCode": 0, "output": "control command timed out; cleanup complete", "timedOut": True,
        }
        status, payload = self.act(model="a")
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertTrue(payload["timedOut"])
        self.assertIn("timed out", payload["error"])

    def test_runner_exception_reports_failure_and_releases_lock(self):
        self.ctl._runner = mock.Mock(side_effect=OSError("cannot launch"))
        status, payload = self.act(model="a")
        self.assertEqual(status, 200)
        self.assertFalse(payload["ok"])
        self.assertIn("cannot launch", payload["error"])
        self.ctl._runner = self.run_command
        self.assertTrue(self.act(model="a")[1]["ok"])

    def test_catalog_timeout_is_bounded_and_invalid_budget_does_not_run(self):
        self.target["timeoutSeconds"] = 300
        self.assertTrue(self.act(model="a")[1]["ok"])
        self.assertEqual(self.calls[-1][1], 300)
        for timeout in (9, 601, True, "300", float("nan"), float("inf")):
            with self.subTest(timeout=timeout):
                self.calls.clear()
                self.target["timeoutSeconds"] = timeout
                status, _ = self.act(model="a")
                self.assertEqual(status, 409)
                self.assertEqual(self.calls, [])

    def test_health_requires_exact_expected_model_and_hides_configuration(self):
        self.target["models"][0]["health"] = {
            "port": 8100, "path": "/v1/models", "expectedModel": "served-a", "timeoutMs": 1000,
        }
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        with mock.patch.object(control.urllib.request, "urlopen", return_value=response) as request:
            for rows, ok in (([{"id": "served-a"}], True), ([{"id": "served-b"}], False),
                             ([{"id": "served-a"}, {"id": "served-b"}], False), ([], False)):
                with self.subTest(rows=rows):
                    response.read.return_value = json.dumps({"data": rows}).encode()
                    status, payload = self.act(model="a")
                    self.assertEqual(status, 200)
                    self.assertEqual(payload["ok"], ok)
                    if not ok:
                        self.assertIn("served-a", payload["error"])
            request.assert_called_with("http://127.0.0.1:8100/v1/models", timeout=1.0)
        self.assertNotIn("health", json.dumps(self.ctl.status(self.headers)["targets"]))

    def test_health_failure_and_invalid_health_configuration_fail_closed(self):
        health = {"port": 8100, "expectedModel": "served-a"}
        self.target["health"] = health
        with mock.patch.object(control.urllib.request, "urlopen", side_effect=OSError("unavailable")):
            self.assertFalse(self.act(model="a")[1]["ok"])
        for invalid in ({"port": 0, "expectedModel": "a"}, {"port": 8100},
                        {**health, "path": "//remote"}, {**health, "timeoutMs": 0}):
            with self.subTest(health=invalid):
                self.calls.clear()
                self.target["health"] = invalid
                status, _ = self.act(model="a")
                self.assertEqual(status, 409)
                self.assertEqual(self.calls, [])


class ControlHttpTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.serving = []
        self.ctl = control.RuntimeControl(
            catalog(),
            token="secret",
            euid=501,
            probe_serving=lambda: list(self.serving),
            runner=self._run,
        )
        sample = {
            "schema": agent.SCHEMA,
            "agentVersion": agent.AGENT_VERSION,
            "runtimes": [{"name": "from-metrics"}],
            "unavailable": [],
            "cpu": {"usagePercent": 3},
        }
        cache = agent.SampleCache({"runtimes": []}, False, ttl=60)
        cache._sample = sample
        cache._at = time.monotonic()
        self.httpd = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.make_handler(cache, self.ctl))
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(2)

    def _run(self, argv, timeout):
        self.calls.append(list(argv))
        if argv[-1].endswith("splash-35b"):
            self.serving = [{"name": "splash-35b", "state": "serving", "model": "35b", "port": 8100}]
        if "model-stop" in argv[-1]:
            self.serving = []
        return {"exitCode": 0, "output": "done", "timedOut": False}

    def _get(self, path, token="secret"):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            headers={"Authorization": f"Bearer {token}"} if token is not None else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=2) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, json.loads(exc.read())

    def _post(self, path, payload, token="secret"):
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=2) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            try:
                return exc.code, json.loads(exc.read())
            finally:
                exc.close()

    def test_list_start_stop_round_trip_and_metrics_stay_put(self):
        status, listed = self._get("/control")
        self.assertEqual(status, 200)
        self.assertEqual(listed["control"], "ready")
        self.assertEqual(listed["serving"], [])
        self.assertEqual(self.calls, [])

        status, started = self._post("/control/start", {"runtime": "splash-35b"})
        self.assertEqual(status, 200)
        self.assertTrue(started["ok"])
        self.assertEqual(started["serving"][0]["name"], "splash-35b")
        self.assertEqual(self.calls, [["/bin/zsh", "-c", "model-start splash-35b"]])

        status, stopped = self._post("/control/stop", {"runtime": "splash-35b"})
        self.assertEqual(status, 200)
        self.assertEqual(stopped["serving"], [])
        self.assertEqual(len(self.calls), 2)

        status, metrics = self._get("/metrics")
        self.assertEqual(status, 200)
        self.assertEqual(metrics["schema"], agent.SCHEMA)
        self.assertEqual(metrics["runtimes"], [{"name": "from-metrics"}])
        self.assertEqual(metrics["cpu"], {"usagePercent": 3})
        self.assertNotIn("targets", metrics)
        self.assertNotIn("control", metrics)
        self.assertEqual(set(metrics) - {"schema", "agentVersion", "runtimes", "unavailable", "cpu"},
                         {"sampleAgeSeconds", "sampleStale"})
        self.assertEqual(len(self.calls), 2)

    def test_http_permission_denied_does_not_run(self):
        status, payload = self._post("/control/start", {"runtime": "splash-35b"}, token="wrong")
        self.assertEqual(status, 403)
        self.assertEqual(payload["control"], "denied")
        self.assertEqual(self.calls, [])

    def test_authenticated_get_shows_real_live_output_and_denied_get_hides_it(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "release"
            script = ("import pathlib, sys, time; print('live startup', flush=True); "
                      "p = pathlib.Path(sys.argv[1]); "
                      "exec('while not p.exists(): time.sleep(0.01)'); "
                      "print('ready', flush=True)")
            self.ctl._catalog["targets"][0]["start"] = [sys.executable, "-c", script, str(release)]
            self.ctl._runner = control.run_control_command
            results = []
            # Exercise the real command independently of the POST socket's timeout.
            worker = threading.Thread(target=lambda: results.append(self.ctl.act(
                "start", {"Authorization": "Bearer secret"}, {"runtime": "splash-35b"})))
            worker.start()
            try:
                deadline = time.monotonic() + 1.5
                while time.monotonic() < deadline:
                    status, running = self._get("/control")
                    if "live startup" in (running.get("operation") or {}).get("output", ""):
                        break
                    time.sleep(0.01)
                else:
                    self.fail("authenticated GET did not expose output while command was running")
                self.assertEqual(status, 200)
                self.assertTrue(running["busy"])
                for token in (None, "wrong"):
                    _, denied = self._get("/control", token=token)
                    self.assertIsNone(denied.get("operation"))
                    self.assertNotIn("live startup", json.dumps(denied))
            finally:
                release.touch()
                worker.join(3)
            self.assertFalse(worker.is_alive())
            _, completed = self._get("/control")
            self.assertEqual(completed["operation"]["output"], "live startup\nready\n")
            self.assertEqual(completed["operation"], results[0][1]["operation"])

    def test_get_control_reports_busy_then_completion_while_post_is_blocked(self):
        entered = threading.Event()
        release = threading.Event()
        results = []

        def blocked(argv, timeout):
            self.calls.append(list(argv))
            entered.set()
            release.wait(3)
            return {"exitCode": 1, "output": "startup failed", "timedOut": False}

        self.ctl._runner = blocked
        worker = threading.Thread(target=lambda: results.append(self._post("/control/start", {"runtime": "splash-35b"})))
        worker.start()
        try:
            self.assertTrue(entered.wait(1))
            status, running = self._get("/control")
            self.assertEqual(status, 200)
            self.assertTrue(running["busy"])
            self.assertEqual(running["operation"]["state"], "running")
            self.assertEqual(running["operation"]["model"], "incoai/Qwen3.6-35B-A3B-Splash")
            self.assertEqual(len(self.calls), 1)
        finally:
            release.set()
            worker.join(2)
        self.assertFalse(worker.is_alive())
        status, completed = self._get("/control")
        self.assertEqual(status, 200)
        self.assertFalse(completed["busy"])
        self.assertEqual(completed["operation"]["id"], running["operation"]["id"])
        self.assertFalse(completed["operation"]["ok"])
        self.assertEqual(completed["operation"]["error"], "startup failed")
        self.assertEqual(completed["operation"], results[0][1]["operation"])
        self.assertEqual(len(self.calls), 1)

    def test_completed_operation_survives_disconnected_post_client(self):
        entered = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        original_act = self.ctl.act

        def observed_act(*args):
            try:
                return original_act(*args)
            finally:
                finished.set()

        def blocked(argv, timeout):
            self.calls.append(list(argv))
            entered.set()
            release.wait(3)
            return {"exitCode": 0, "output": "ready after disconnect", "timedOut": False}

        self.ctl.act = observed_act
        self.ctl._runner = blocked
        # A failed write to the intentionally abandoned socket is expected.
        self.httpd.handle_error = mock.Mock()
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        try:
            connection.request("POST", "/control/start", json.dumps({"runtime": "splash-35b"}), {
                "Content-Type": "application/json", "Authorization": "Bearer secret",
            })
            self.assertTrue(entered.wait(1))
            connection.close()
            _, running = self._get("/control")
            self.assertTrue(running["busy"])
        finally:
            connection.close()
            release.set()
        self.assertTrue(finished.wait(2))
        _, completed = self._get("/control")
        self.assertFalse(completed["busy"])
        self.assertEqual(completed["operation"]["id"], running["operation"]["id"])
        self.assertTrue(completed["operation"]["ok"])
        self.assertEqual(completed["operation"]["output"], "ready after disconnect")
        self.assertEqual(len(self.calls), 1)

    def test_metrics_while_a_control_command_is_blocked_does_not_wait_on_it(self):
        started = threading.Event()
        release = threading.Event()

        def blocked(argv, timeout):
            started.set()
            release.wait(3)
            return {"exitCode": 0, "output": "", "timedOut": False}

        self.ctl._runner = blocked
        worker = threading.Thread(
            target=lambda: self._post("/control/start", {"runtime": "splash-35b"}),
        )
        worker.start()
        self.assertTrue(started.wait(2))
        began = time.monotonic()
        status, metrics = self._get("/metrics")
        self.assertLess(time.monotonic() - began, 1.0)
        self.assertEqual(status, 200)
        self.assertEqual(metrics["schema"], agent.SCHEMA)
        release.set()
        worker.join(2)

    def test_status_read_rejects_a_mismatched_token(self):
        # _get reports the HTTP status rather than raising, so a refused status
        # read is asserted on its code and payload.
        status, payload = self._get("/control", token="wrong")
        self.assertEqual(status, 403)
        self.assertEqual(payload["control"], "denied")
        self.assertIsNone(payload["serving"])
        self.assertEqual(payload["targets"], [])
        self.assertEqual(self.calls, [])


class ControlCommandTests(unittest.TestCase):
    def test_real_command_output_is_visible_only_to_authorized_polling_before_exit(self):
        with tempfile.TemporaryDirectory() as directory:
            release = Path(directory) / "release"
            script = ("import pathlib, sys, time; print('loading selected model', flush=True); "
                      "p = pathlib.Path(sys.argv[1]); "
                      "exec('while not p.exists(): time.sleep(0.01)'); "
                      "print('model ready', flush=True)")
            data = catalog()
            data["targets"][0]["start"] = [sys.executable, "-c", script, str(release)]
            ctl = control.RuntimeControl(data, token="secret", euid=501, timeout=5)
            headers = {"Authorization": "Bearer secret"}
            results = []
            worker = threading.Thread(target=lambda: results.append(
                ctl.act("start", headers, {"runtime": "splash-35b"})))
            worker.start()
            try:
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline:
                    running = ctl.status(headers)
                    if "loading selected model" in (running.get("operation") or {}).get("output", ""):
                        break
                    time.sleep(0.01)
                else:
                    self.fail("flushed command output was not visible before exit")
                self.assertTrue(worker.is_alive())
                self.assertEqual(running["operation"]["state"], "running")
                for denied_headers in (None, {}, {"Authorization": "Bearer wrong"}):
                    denied = ctl.status(denied_headers)
                    self.assertIsNone(denied["operation"])
                    self.assertNotIn("loading selected model", json.dumps(denied))
                status, busy = ctl.act("stop", headers, {"runtime": "splash-35b"})
                self.assertEqual(status, 409)
                self.assertEqual(busy["operation"]["id"], running["operation"]["id"])
            finally:
                release.touch()
                worker.join(7)
            self.assertFalse(worker.is_alive())
            completed = ctl.status(headers)["operation"]
            self.assertEqual(completed["state"], "complete")
            self.assertEqual(completed["output"], "loading selected model\nmodel ready\n")
            self.assertEqual(completed, results[0][1]["operation"])
            self.assertIsNone(ctl.status()["operation"])

    def test_running_output_is_bounded_even_without_a_newline(self):
        snapshots = []
        result = control.run_control_command(
            [sys.executable, "-c", "import os; os.write(1, b'x' * 200000); print('done', flush=True)"],
            timeout=5, on_output=snapshots.append,
        )
        self.assertTrue(snapshots)
        self.assertTrue(all(len(value) <= control.MAX_OUTPUT for value in snapshots))
        self.assertEqual(len(result["output"]), control.MAX_OUTPUT)
        self.assertTrue(result["output"].endswith("done\n"))

    def test_success_does_not_signal_the_wrapper(self):
        proc = mock.Mock(returncode=0)
        proc.communicate.return_value = ("ready\n", None)
        with mock.patch.object(control.subprocess, "Popen", return_value=proc), \
                mock.patch.object(control, "_CommandOutput", return_value=proc), \
                mock.patch.object(control.os, "killpg") as killpg:
            result = control.run_control_command(["/owned/wrapper"], timeout=2)
        self.assertEqual(result, {"exitCode": 0, "output": "ready\n", "timedOut": False})
        killpg.assert_not_called()

    def test_timeout_sends_term_and_allows_sixty_seconds_for_wrapper_cleanup(self):
        proc = mock.Mock(pid=123, returncode=0)
        proc.communicate.side_effect = [subprocess.TimeoutExpired("wrapper", 2), ("cleanup complete\n", None)]
        with mock.patch.object(control.subprocess, "Popen", return_value=proc), \
                mock.patch.object(control, "_CommandOutput", return_value=proc), \
                mock.patch.object(control.os, "killpg") as killpg:
            result = control.run_control_command(["/owned/wrapper"], timeout=2)
        killpg.assert_called_once_with(123, signal.SIGTERM)
        self.assertEqual(proc.communicate.call_args_list, [mock.call(timeout=2), mock.call(timeout=60)])
        self.assertTrue(result["timedOut"])
        self.assertEqual(result["exitCode"], 0)
        self.assertIn("cleanup complete", result["output"])
        self.assertIn("timed out", result["output"])

    def test_timeout_kills_only_after_term_cleanup_grace_expires(self):
        proc = mock.Mock(pid=123, returncode=-signal.SIGKILL)
        proc.communicate.side_effect = [
            subprocess.TimeoutExpired("wrapper", 2), subprocess.TimeoutExpired("wrapper", 60),
            ("unfinished cleanup\n", None),
        ]
        with mock.patch.object(control.subprocess, "Popen", return_value=proc), \
                mock.patch.object(control, "_CommandOutput", return_value=proc), \
                mock.patch.object(control.os, "killpg") as killpg:
            result = control.run_control_command(["/owned/wrapper"], timeout=2)
        self.assertEqual(killpg.call_args_list, [mock.call(123, signal.SIGTERM), mock.call(123, signal.SIGKILL)])
        self.assertEqual(proc.communicate.call_args_list, [
            mock.call(timeout=2), mock.call(timeout=60), mock.call(timeout=1),
        ])
        self.assertTrue(result["timedOut"])
        self.assertIn("timed out", result["output"])

    @unittest.skipUnless(hasattr(os, "killpg"), "requires POSIX process groups")
    def test_timeout_lets_real_wrapper_reap_its_detached_child(self):
        script = textwrap.dedent("""
            import json
            import os
            import signal
            import subprocess
            import sys
            import time
            from pathlib import Path

            child = subprocess.Popen(
                [sys.executable, '-c', 'import time; time.sleep(120)'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )

            def cancel(signum, frame):
                child.terminate()
                child.wait(timeout=2)
                print('detached child reaped', flush=True)
                raise SystemExit(0)

            signal.signal(signal.SIGTERM, cancel)
            Path(sys.argv[1]).write_text(json.dumps({
                'wrapper': os.getpid(), 'wrapperGroup': os.getpgid(0),
                'child': child.pid, 'childGroup': os.getpgid(child.pid),
            }))
            while True:
                time.sleep(60)
        """)
        real_popen = subprocess.Popen
        owned = []

        def launch(*args, **kwargs):
            proc = real_popen(*args, **kwargs)
            owned.append(proc)
            return proc

        with tempfile.TemporaryDirectory() as directory:
            pids_file = Path(directory) / "owned-pids.json"
            pids = {}
            try:
                # Exercise real signals and reaping without waiting the production 60s grace.
                with mock.patch.object(control.subprocess, "Popen", side_effect=launch), \
                        mock.patch.object(control, "CONTROL_CANCEL_GRACE_S", 3):
                    result = control.run_control_command([sys.executable, "-c", script, str(pids_file)], timeout=2)
                pids = json.loads(pids_file.read_text())
                self.assertEqual(pids["wrapper"], owned[0].pid)
                self.assertEqual(pids["wrapperGroup"], pids["wrapper"])
                self.assertEqual(pids["childGroup"], pids["child"])
                self.assertTrue(result["timedOut"])
                self.assertEqual(result["exitCode"], 0)
                self.assertIn("detached child reaped", result["output"])
                self.assertIn("timed out", result["output"])
                for name in ("wrapper", "child"):
                    with self.subTest(process=name):
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pids[name], 0)
                        with self.assertRaises(ProcessLookupError):
                            os.killpg(pids[name], 0)
            finally:
                # Bound fixture cleanup even when a regression prevents the wrapper handler.
                if not pids and pids_file.exists():
                    pids = json.loads(pids_file.read_text())
                for proc in owned:
                    if proc.poll() is None:
                        try:
                            os.killpg(proc.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        proc.communicate(timeout=2)
                if pids:
                    try:
                        os.killpg(pids["childGroup"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass


class ShippedCatalogTests(unittest.TestCase):
    def test_shipped_catalog_uses_explicit_profiles_and_hides_argv_on_status(self):
        data, error = control.load_control_catalog(HERE / "control.json")
        self.assertIsNone(error)
        names = [row["name"] for row in data["targets"]]
        self.assertEqual(names, [
            "omlx-thinkingcap", "mlx-serve-27b", "mlx-serve-35b", "splash-thinkingcap", "mtplx-27b",
        ])
        for row in data["targets"]:
            self.assertEqual(len(row["models"]), 1)
            self.assertNotEqual(row["models"][0]["id"], "default")
            self.assertEqual(row["timeoutSeconds"], 600)
            for action in ("start", "stop"):
                self.assertIsNone(control._argv_problem(row[action]))
                self.assertIn("profile_runner.py", row[action][-1])
                self.assertTrue(row[action][-1].endswith(f"{action} {row['name']}"))
        ctl = control.RuntimeControl(data, token="", euid=501, probe_serving=lambda: [], runner=lambda *a: self.fail("ran"))
        payload = ctl.status()
        self.assertEqual(payload["control"], "disabled")
        self.assertNotIn("profile_runner.py", json.dumps(payload))
        # The catalog is only rendered for an authorized caller; there every
        # target must still be launchable and still hide every command.
        authorized_ctl = control.RuntimeControl(
            data, token="secret", euid=501, probe_serving=lambda: [], runner=lambda *a: self.fail("ran"),
        )
        authorized = authorized_ctl.status({"Authorization": "Bearer secret"})
        self.assertEqual(authorized["control"], "ready")
        self.assertTrue(all(row["startable"] for row in authorized["targets"]))
        self.assertTrue(all("start" not in row for row in authorized["targets"]))
        self.assertNotIn("profile_runner.py", json.dumps(authorized))




class ReviewControlRegressionTests(unittest.TestCase):
    def test_status_rejects_wrong_token_without_probing_or_running(self):
        calls = []
        ctl = control.RuntimeControl(catalog(), token="secret", euid=501, probe_serving=lambda: calls.append("probe"), runner=lambda *a: calls.append("run"))
        result = ctl.status({"Authorization": "Bearer wrong"})
        self.assertEqual(result["control"], "denied")
        self.assertIsNone(result["serving"])
        self.assertEqual(result["targets"], [])
        self.assertEqual(calls, [])

    def test_unknown_serving_state_blocks_launch_before_command(self):
        calls = []
        def failed_probe():
            raise RuntimeError("synthetic process probe failure")
        ctl = control.RuntimeControl(catalog(), token="secret", euid=501, probe_serving=failed_probe, runner=lambda *a: calls.append("run"))
        result = ctl.status({"Authorization": "Bearer secret"})
        self.assertIsNone(result["serving"])
        self.assertIn("probe failed", result["servingError"])
        status, result = ctl.act("start", {"Authorization": "Bearer secret"}, {"runtime": "splash-35b"})
        self.assertEqual(status, 503)
        self.assertFalse(result["ok"])
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
