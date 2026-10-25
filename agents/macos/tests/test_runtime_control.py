"""Control endpoint: list, start, stop, and the gates around them.

Status and /metrics must not run a catalog command.
"""

from __future__ import annotations

import json
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

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
        payload = ctl.status()
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

    def _get(self, path):
        with urllib.request.urlopen(f"http://127.0.0.1:{self.port}{path}", timeout=2) as resp:
            return resp.status, json.loads(resp.read())

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


class ShippedCatalogTests(unittest.TestCase):
    def test_shipped_catalog_matches_model_start_names_and_hides_argv_on_status(self):
        data, error = control.load_control_catalog(HERE / "control.json")
        self.assertIsNone(error)
        names = [row["name"] for row in data["targets"]]
        self.assertEqual(names, [
            "omlx", "qflash", "splash", "splash-27b", "splash-35b", "ds4", "ds4-serve",
            "mtplx", "mtplx-27b", "mtplx-flash", "mtplx-35b", "tensorfold",
        ])
        ctl = control.RuntimeControl(data, token="", euid=501, probe_serving=lambda: [], runner=lambda *a: self.fail("ran"))
        payload = ctl.status()
        self.assertEqual(payload["control"], "disabled")
        self.assertTrue(all(row["startable"] for row in payload["targets"]))
        self.assertTrue(all("start" not in row for row in payload["targets"]))
        self.assertNotIn("model-start", json.dumps(payload))


if __name__ == "__main__":
    unittest.main()
