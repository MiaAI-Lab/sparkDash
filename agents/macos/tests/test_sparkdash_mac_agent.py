"""Unit tests for the Mac node agent (stdlib unittest, no third-party deps).

Run:  python3 -m unittest discover -s agents/macos/tests
"""

from __future__ import annotations

import importlib.util
import json
import os
import plistlib
import stat
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
ROOT = HERE.parents[1]
FIXTURES = ROOT / "server" / "collectors" / "__tests__" / "fixtures" / "mac"

spec = importlib.util.spec_from_file_location("mac_agent", HERE / "sparkdash_mac_agent.py")
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
install_spec = importlib.util.spec_from_file_location("privileged_install", HERE / "privileged_collector_install.py")
installer = importlib.util.module_from_spec(install_spec)
install_spec.loader.exec_module(installer)

INVENTORY = json.loads((HERE / "runtimes.json").read_text("utf-8"))


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text("utf-8")


def proc(pid: int, argv: str, ppid: int = 1) -> dict:
    argv_list = argv.split()
    return {
        "pid": pid,
        "ppid": ppid,
        "argv": argv_list,
        "argvText": argv,
        "comm": agent._basename(argv_list[0]),
        "script": agent._script_identity(argv_list),
    }


def owned(pid: int, port: int) -> dict[int, list[dict]]:
    return {pid: [{"port": port, "address": f"*:{port}"}]}


def ok(port: int, model: str | None = None) -> dict:
    return {port: {"ok": True, "url": f"http://127.0.0.1:{port}/v1/models", "model": model}}


class InventoryDetectionTests(unittest.TestCase):
    """Detection is driven by the inventory file, not by names baked into code."""

    def setUp(self):
        self._real_health = agent.health_check

    def tearDown(self):
        agent.health_check = self._real_health

    def detect(self, procs, ports, health: dict | None = None):
        mapping = health or {}
        agent.health_check = lambda port, path, timeout: mapping.get(
            port, {"ok": False, "url": f"http://127.0.0.1:{port}{path}"}
        )
        return agent.detect_runtimes(INVENTORY, procs, ports)

    def test_tensorfold_matches_on_executable_and_port_with_the_argv_model(self):
        procs = {2302: proc(
            2302,
            "/Users/dev/.venv/bin/python /Users/dev/.venv/bin/tensorfold serve "
            "Vontra/Qwen3.8-27B-MLX-4bit --context 131072 --port 8300 --host 0.0.0.0",
        )}
        found = self.detect(procs, owned(2302, 8300), health=ok(8300, "qwen3.8-27b"))
        self.assertEqual(len(found), 1)
        row = found[0]
        self.assertEqual(row["name"], "tensorfold")
        self.assertEqual(row["port"], 8300)
        self.assertEqual(row["state"], "serving")
        # The API's own id is what clients call, so it wins over argv.
        self.assertEqual(row["model"], "qwen3.8-27b")

    def test_variant_entry_wins_over_its_catch_all_parent(self):
        procs = {10: proc(
            10,
            "/opt/homebrew/opt/splash/libexec/python/bin/python3 -u "
            "/opt/homebrew/opt/splash/libexec/server/server.py "
            "/models/incoai/Qwen3.6-35B-A3B-Splash/target "
            "--model incoai/Qwen3.6-35B-A3B-Splash --port 8100",
        )}
        found = self.detect(procs, owned(10, 8100), health=ok(8100))
        self.assertEqual([row["name"] for row in found], ["splash-35b"])
        self.assertEqual(found[0]["model"], "incoai/Qwen3.6-35B-A3B-Splash")

    def test_listener_without_a_matching_entry_is_other_runtime(self):
        # A Python server nobody catalogued keeps its own name; it is never
        # renamed into a catalogued engine.
        procs = {77: proc(77, "/usr/bin/python3 /opt/experiment/infer.py --port 9099")}
        found = self.detect(procs, owned(77, 9099))
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["name"], "other-runtime")
        self.assertEqual(found[0]["label"], "infer.py")
        self.assertEqual(found[0]["port"], 9099)
        self.assertEqual(found[0]["detectedBy"], "listener")

    def test_processes_that_are_not_serving_are_skipped(self):
        procs = {
            78: proc(78, "/usr/bin/python3 /usr/local/bin/serve_helper.py"),  # no listener
            79: proc(79, "/usr/bin/python3 -c print(1)"),                     # listener, not serving
        }
        self.assertEqual(self.detect(procs, owned(79, 9100)), [])

    def test_watchdog_entry_reports_running_without_a_health_probe(self):
        procs = {90: proc(90, "/bin/zsh /Users/dev/projects/dwarfstar/ds4-serve.sh")}
        found = self.detect(procs, {})
        self.assertEqual([row["name"] for row in found], ["ds4-serve"])
        self.assertEqual(found[0]["state"], "running")
        self.assertNotIn("health", found[0])

    def test_engine_that_does_not_own_its_port_is_not_reported(self):
        # A server binary that lost its listener (still loading, or wedged) must
        # not be reported as serving on a port it does not own.
        procs = {91: proc(91, "/Users/dev/models/ds4-server --host 0.0.0.0 --port 8000")}
        self.assertEqual(self.detect(procs, owned(91, 8123)), [])

    def test_inventory_is_the_only_name_source(self):
        procs = {92: proc(92, "/opt/venv/bin/python /opt/venv/bin/omlx --port 8000")}
        found = self.detect(procs, owned(92, 8000), health=ok(8000, "Qwen3.8-27B-4bit"))
        self.assertEqual(found[0]["name"], "omlx")
        self.assertEqual(found[0]["model"], "Qwen3.8-27B-4bit")

    def test_inventory_lists_the_engines_the_owner_starts(self):
        names = {entry["name"] for entry in INVENTORY["runtimes"]}
        for expected in ("omlx", "qflash", "splash", "splash-27b", "splash-35b", "ds4",
                         "ds4-serve", "mtplx", "mtplx-27b", "mtplx-35b", "mtplx-flash",
                         "tensorfold"):
            self.assertIn(expected, names)

    def test_agent_processes_are_excluded_from_both_matching_paths(self):
        procs = {
            500: proc(500, "/usr/bin/python3 /Users/dev/sparkdash_mac_agent.py --serve --port 8790"),
            501: proc(501, "/usr/bin/python3 -I /Library/Application Support/ai.onyx.sparkdash-mac-agent/sparkdash_mac_agent.py --serve --port 8791"),
            502: proc(502, "/usr/bin/python3 /opt/infer.py --port 9099 --model private/model"),
        }
        listeners = {**owned(500, 8790), **owned(501, 8791), **owned(502, 9099)}
        self.assertEqual([row["pid"] for row in self.detect(procs, listeners)], [502])
        inventory = {"runtimes": [{"name": "agent", "exe": "sparkdash_mac_agent", "role": "watchdog"}]}
        self.assertEqual([row["pid"] for row in agent.detect_runtimes(inventory, procs, listeners)], [502])

    def test_elevated_runtime_scope_covers_inventory_watchdogs_and_unknowns(self):
        procs = {}
        listeners = {}
        for uid in (501, 502):
            for offset, argv, port in (
                (0, "/usr/bin/python3 /opt/infer.py --port 9099 --model private/model", 9099),
                (1, "/usr/bin/python /opt/tensorfold serve model/id --port 8300", 8300),
                (2, "/bin/zsh /opt/ds4-serve.sh", None),
            ):
                pid = uid * 10 + offset
                procs[pid] = {**proc(pid, argv), "uid": uid}
                if port:
                    listeners.update(owned(pid, port))
        with patch.object(agent.os, "geteuid", return_value=0), patch.object(
            agent.os, "stat", return_value=SimpleNamespace(st_uid=501)
        ):
            found = self.detect(procs, listeners)
        self.assertEqual({row["pid"] for row in found}, {5010, 5011, 5012})
        with patch.object(agent.os, "geteuid", return_value=501):
            self.assertEqual(len(self.detect(procs, listeners)), 6)
        for console in (SimpleNamespace(st_uid=0), OSError("no console")):
            with patch.object(agent.os, "geteuid", return_value=0), patch.object(
                agent.os, "stat", **({"side_effect": console} if isinstance(console, OSError) else {"return_value": console})
            ):
                self.assertEqual(self.detect(procs, listeners), [])

    def test_process_ownership_is_parsed_with_the_full_command(self):
        with patch.object(agent, "run", return_value="10 1 501 /usr/bin/python3 /opt/infer.py --model one/two\n11 1 502 /bin/zsh /opt/ds4-serve.sh\n"):
            procs = agent.list_processes()
        self.assertEqual(procs[10]["uid"], 501)
        self.assertEqual(procs[11]["uid"], 502)
        self.assertEqual(procs[10]["script"], "infer.py")
        self.assertEqual(agent.extract_model(procs[10]["argv"], {"flags": ["--model"]}), "one/two")


class ModelExtractionTests(unittest.TestCase):
    def test_flag_then_positional(self):
        flags_only = {"flags": ["--model"], "positional": False}
        self.assertEqual(
            agent.extract_model(["engine", "--model", "a/b", "--port", "1"], flags_only), "a/b"
        )
        self.assertEqual(agent.extract_model(["engine", "--model=a/b"], flags_only), "a/b")
        self.assertIsNone(agent.extract_model(["engine", "--port", "1"], flags_only))
        self.assertEqual(
            agent.extract_model(["engine", "serve", "Vontra/Qwen3.8-27B-MLX-4bit"],
                                {"flags": [], "positional": True}),
            "Vontra/Qwen3.8-27B-MLX-4bit",
        )

    def test_a_long_path_collapses_to_its_last_two_parts(self):
        self.assertEqual(agent._display_model("/models/incoai/Qwen3.6-35B-Splash/target"),
                         "Qwen3.6-35B-Splash/target")


class ParsingTests(unittest.TestCase):
    """Shared arithmetic with the SSH collector: same fixture, same numbers."""

    def test_vm_stat_and_sysctl_match_the_ssh_collector_fixture_expectations(self):
        vm = agent.parse_vm_stat(fixture("vm_stat.txt"))
        memsize = int(agent.parse_sysctl(fixture("sysctl.txt"))["hw.memsize"])
        mem = agent.unified_memory(vm, memsize)
        self.assertEqual(vm["pageSize"], 16384)
        self.assertEqual(mem["total"], 262144)
        self.assertEqual(mem["gpuUsed"], 185502)
        self.assertEqual(mem["cpuUsed"], 9802)
        self.assertEqual(mem["used"], 195304)
        self.assertEqual(mem["available"], 66840)
        self.assertEqual(mem["percentage"], 75)
        self.assertEqual(mem["oomRisk"], "medium")

    def test_an_unwired_idle_model_still_counts_as_used(self):
        vm = agent.parse_vm_stat(fixture("vm_stat-unwired.txt"))
        memsize = int(agent.parse_sysctl(fixture("sysctl.txt"))["hw.memsize"])
        mem = agent.unified_memory(vm, memsize)
        self.assertEqual(mem["gpuUsed"], 4585)
        self.assertEqual(mem["cpuUsed"], 192794)
        self.assertEqual(mem["used"], 197379)

    def test_boot_time_and_swap(self):
        sys = agent.parse_sysctl(fixture("sysctl.txt"))
        self.assertEqual(agent.parse_boot_time(sys["kern.boottime"]), 1790650919)
        self.assertEqual(agent.parse_swap_usage(sys["vm.swapusage"]),
                         {"total": 1024, "used": 78, "free": 946})

    def test_powermetrics_fixture(self):
        parsed = agent.parse_powermetrics(fixture("powermetrics-busy.txt"))
        self.assertEqual(parsed["gpuActivePct"], 100)
        self.assertEqual(parsed["gpuW"], 84.9)
        self.assertEqual(parsed["cpuW"], 5.1)
        self.assertEqual(parsed["combinedW"], 90)
        self.assertEqual(parsed["thermalPressure"], "Nominal")

    def test_netstat_link_row(self):
        self.assertEqual(agent.parse_netstat_bytes(fixture("netstat.txt")),
                         {"name": "en1", "rxBytes": 392966387598, "txBytes": 7952987339})

    def test_df_prefers_the_data_volume(self):
        original = agent.run
        agent.run = lambda cmd, timeout=1: fixture("df.txt")
        try:
            disks = agent.disk_stats()
        finally:
            agent.run = original
        self.assertEqual(len(disks), 1)
        self.assertEqual(disks[0]["label"], "/System/Volumes/Data")
        self.assertEqual(disks[0]["total"], 948534)

    def test_iostat_reads_the_second_sample(self):
        text = (
            "              disk0               cpu    load average\n"
            "KB/t  tps MB/s  us sy id   1m   5m  15m\n"
            "19.71 776 14.9  18 27 55  61.44 64.76 69.57\n"
            " 9.62 555  5.2  45 55  0  61.44 64.76\n"
        )
        original = agent.run
        agent.run = lambda cmd, timeout=1: text
        try:
            sample = agent.cpu_sample_iostat()
        finally:
            agent.run = original
        self.assertEqual(sample["usagePercent"], 100.0)
        self.assertEqual(sample["source"], "iostat")
        self.assertIsNone(sample["perCorePercent"])

    def test_iostat_without_a_us_sy_id_header_is_no_sample(self):
        original = agent.run
        agent.run = lambda cmd, timeout=1: "iostat: unsupported\n"
        try:
            self.assertIsNone(agent.cpu_sample_iostat())
        finally:
            agent.run = original


class AvailabilityTests(unittest.TestCase):
    """Anything macOS only hands to root is declared unavailable, never zeroed."""

    def test_gpu_signals_without_root_are_declared_unavailable(self):
        block, unavailable = agent.gpu_stats(allow_powermetrics=False)
        self.assertEqual(block["powermetrics"], "requires-root")
        self.assertIsNone(block["activePercent"])
        self.assertIsNone(block["anePowerW"])
        self.assertEqual(
            {row["metric"] for row in unavailable},
            {"gpu.utilization", "gpu.power", "ane.power"},
        )
        self.assertTrue(all("root" in row["reason"] for row in unavailable))

    def test_powermetrics_that_returns_nothing_is_still_unavailable(self):
        original = agent.run
        agent.run = lambda cmd, timeout=1: ""
        try:
            block, unavailable = agent.gpu_stats(allow_powermetrics=True)
        finally:
            agent.run = original
        self.assertEqual(block["powermetrics"], "failed")
        self.assertEqual(len(unavailable), 3)

    def test_network_without_a_default_route_is_declared_unavailable(self):
        original = agent.default_interface
        agent.default_interface = lambda: None
        try:
            network, notes = agent.network_stats()
        finally:
            agent.default_interface = original
        self.assertIsNone(network)
        self.assertEqual(notes, ["no default route"])

    def test_snapshot_reports_what_it_could_not_read(self):
        inventory = {"defaults": {}, "runtimes": []}
        outputs = {
            "sysctl": fixture("sysctl.txt"),
            "vm_stat": fixture("vm_stat.txt"),
            "df": fixture("df.txt"),
            "route": "   interface: en0\n",
            "netstat": fixture("netstat.txt"),
            "ipconfig": "10.0.0.5\n",
        }
        original_run = agent.run
        original_sockets = agent.listening_sockets
        original_probe = agent.probe_reachability
        agent.run = lambda cmd, timeout=1: outputs.get(cmd[0], "")
        agent.listening_sockets = lambda: {}
        agent.probe_reachability = lambda *a: [{"target": "1.1.1.1:53", "ok": True, "rttMs": 9}]
        try:
            snap = agent.collect_snapshot(inventory, allow_powermetrics=False,
                                         cpu_probe=None, procs={}, listeners={})
        finally:
            agent.run = original_run
            agent.listening_sockets = original_sockets
            agent.probe_reachability = original_probe

        self.assertEqual(snap["schema"], agent.SCHEMA)
        self.assertEqual(snap["bootTime"], 1790650919)
        self.assertGreater(snap["uptimeSeconds"], 0)
        self.assertEqual(snap["runtimes"], [])
        self.assertEqual(snap["memory"]["total"], 262144)
        self.assertEqual(snap["disks"][0]["label"], "/System/Volumes/Data")
        self.assertEqual(snap["network"]["interfaces"][0]["ip"], "10.0.0.5")
        self.assertEqual(snap["network"]["reachability"][0]["ok"], True)
        metrics = {row["metric"] for row in snap["unavailable"]}
        self.assertEqual(snap["cpu"]["usagePercent"], None)
        self.assertIn("cpu.usage", metrics)
        self.assertIn("cpu.perCore", metrics)
        self.assertIn("gpu.power", metrics)
        for component in ("cpu", "gpu"):
            self.assertIsNone(snap[component]["temperature"])
            self.assertIn({"metric": f"{component}.temperature", "reason": "requires root for powermetrics"}, snap["unavailable"])
        self.assertEqual(snap["thermal"]["pressureState"], "unknown")


class TemperatureTests(unittest.TestCase):
    def test_parser_reads_the_powermetrics_fixture(self):
        text = (HERE / "tests" / "fixtures" / "powermetrics-die-temperature.txt").read_text("utf-8")
        parsed = agent.parse_powermetrics_temperatures(text)
        self.assertEqual(parsed["cpuCelsius"], 46.23)
        self.assertEqual(parsed["gpuCelsius"], 42.11)
        self.assertEqual(parsed["unit"], "celsius")

    def test_parser_ignores_a_suffix_and_rejects_missing_or_absurd_lines(self):
        parsed = agent.parse_powermetrics_temperatures(
            "CPU die temperature: 51.50 C (simulated:1)\nGPU die temperature: 400.00 C\n"
        )
        self.assertEqual(parsed["cpuCelsius"], 51.5)
        self.assertIsNone(parsed["gpuCelsius"])
        self.assertEqual(agent.parse_powermetrics_temperatures("")["unit"], None)
        self.assertIsNone(agent.parse_powermetrics_temperatures("unrecognized sampler: smc\n")["cpuCelsius"])

    def test_ordinary_user_stays_unavailable_even_if_smc_text_is_supplied(self):
        called = []
        original = agent.read_smc_temperature_text
        agent.read_smc_temperature_text = lambda timeout=1.5: called.append(1) or "CPU die temperature: 1.00 C"
        original_run = agent.run
        agent.run = lambda cmd, timeout=1: "Note: No thermal warning level has been recorded\n" if cmd[0] == "pmset" else ""
        try:
            snap = agent.collect_snapshot(
                {"defaults": {}, "runtimes": []},
                allow_powermetrics=False,
                cpu_probe=None,
                procs={},
                listeners={},
                elevated=False,
                smc_temperature_text=(HERE / "tests" / "fixtures" / "powermetrics-die-temperature.txt").read_text("utf-8"),
            )
        finally:
            agent.read_smc_temperature_text = original
            agent.run = original_run
        self.assertEqual(called, [])
        self.assertIsNone(snap["cpu"]["temperature"])
        self.assertIsNone(snap["gpu"]["temperature"])
        self.assertIsNone(snap["cpu"]["temperatureUnit"])
        for component in ("cpu", "gpu"):
            self.assertIn(
                {"metric": f"{component}.temperature", "reason": "requires root for powermetrics"},
                snap["unavailable"],
            )
        self.assertEqual(snap["thermal"]["pressureState"], "nominal")

    def test_elevated_collector_publishes_parsed_temperatures_with_units(self):
        die = (HERE / "tests" / "fixtures" / "powermetrics-die-temperature.txt").read_text("utf-8")
        calls = []

        def fake_run(cmd, timeout=1):
            calls.append(cmd)
            if "powermetrics" in cmd:
                return die
            if cmd and cmd[0] == "pmset":
                return "Note: No thermal warning level has been recorded\n"
            return ""

        original_run = agent.run
        original_smc = agent.read_smc_temperature_text
        agent.run = fake_run
        agent.read_smc_temperature_text = lambda timeout=1.5: (_ for _ in ()).throw(AssertionError("SMC should not run"))
        try:
            snap = agent.collect_snapshot(
                {"defaults": {}, "runtimes": []},
                allow_powermetrics=True,
                cpu_probe=None,
                procs={},
                listeners={},
                elevated=True,
                smc_temperature_text="",
            )
        finally:
            agent.run = original_run
            agent.read_smc_temperature_text = original_smc
        self.assertEqual(snap["cpu"]["temperature"], 46.23)
        self.assertEqual(snap["gpu"]["temperature"], 42.11)
        self.assertEqual(snap["cpu"]["temperatureUnit"], "celsius")
        self.assertEqual(snap["gpu"]["temperatureUnit"], "celsius")
        self.assertEqual(snap["cpu"]["temperatureSource"], "powermetrics")
        self.assertEqual(snap["gpu"]["temperatureSource"], "powermetrics")
        self.assertEqual(snap["thermal"]["pressureState"], "nominal")
        metrics = {row["metric"] for row in snap["unavailable"]}
        self.assertNotIn("cpu.temperature", metrics)
        self.assertNotIn("gpu.temperature", metrics)
        self.assertNotIn("_powermetricsText", snap["gpu"])
        self.assertEqual(sum(1 for cmd in calls if "powermetrics" in cmd), 1)

    def test_elevated_collector_uses_smc_text_when_powermetrics_has_no_die_line(self):
        die = (HERE / "tests" / "fixtures" / "powermetrics-die-temperature.txt").read_text("utf-8")
        original_run = agent.run
        agent.run = lambda cmd, timeout=1: "CPU Power: 1000 mW\nGPU Power: 2000 mW\nCombined Power (CPU + GPU + ANE): 3000 mW\n" if "powermetrics" in cmd else ""
        try:
            snap = agent.collect_snapshot(
                {"defaults": {}, "runtimes": []},
                allow_powermetrics=True,
                cpu_probe=None,
                procs={},
                listeners={},
                elevated=True,
                smc_temperature_text=die,
            )
        finally:
            agent.run = original_run
        self.assertEqual(snap["cpu"]["temperatureSource"], "smc")
        self.assertEqual(snap["gpu"]["temperatureSource"], "smc")
        self.assertEqual(snap["cpu"]["temperature"], 46.23)
        self.assertEqual(snap["gpu"]["temperature"], 42.11)


class CommandTimeoutTests(unittest.TestCase):
    def test_run_returns_when_the_command_does_not_exit(self):
        started = time.monotonic()
        text = agent.run(["sleep", "30"], timeout=0.3)
        elapsed = time.monotonic() - started
        self.assertEqual(text, "")
        self.assertLess(elapsed, 3.0, f"run waited {elapsed:.2f}s for a command that ignores the clock")

    def test_metrics_does_not_wait_on_an_in_flight_collection(self):
        started = threading.Event()
        release = threading.Event()

        def blocked(inventory, **kwargs):
            started.set()
            release.wait(5)
            return {"schema": agent.SCHEMA, "ok": True}

        original = agent.collect_snapshot
        agent.collect_snapshot = blocked
        httpd = None
        try:
            cache = agent.SampleCache({"runtimes": []}, allow_powermetrics=False, ttl=0)
            httpd = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.make_handler(cache))
            port = httpd.server_address[1]
            server = threading.Thread(target=httpd.serve_forever, daemon=True)
            server.start()

            def first():
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5) as resp:
                    resp.read()

            worker = threading.Thread(target=first)
            worker.start()
            self.assertTrue(started.wait(2), "collector never started")
            began = time.monotonic()
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=2)
            self.assertEqual(ctx.exception.code, 503)
            body = json.loads(ctx.exception.read())
            ctx.exception.close()
            self.assertLess(time.monotonic() - began, 1.0)
            self.assertEqual(body["status"], "pending")
            self.assertNotIn("schema", body)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                self.assertTrue(json.loads(resp.read())["ok"])
        finally:
            release.set()
            if "worker" in locals():
                worker.join(2)
            if httpd is not None:
                httpd.shutdown()
                httpd.server_close()
            agent.collect_snapshot = original

    def test_late_sample_is_published_and_only_one_worker_owns_refresh(self):
        release = threading.Event()
        entered = threading.Event()
        calls = []

        def collect(inventory, **kwargs):
            calls.append(1)
            entered.set()
            release.wait(2)
            return {"schema": agent.SCHEMA, "cpu": {"temperature": 46}, "unavailable": []}

        with patch.object(agent, "collect_snapshot", side_effect=collect), patch.object(agent, "COLLECT_DEADLINE_S", 0.02):
            cache = agent.SampleCache({}, False, ttl=60)
            try:
                self.assertEqual(cache.get()["status"], "pending")
                self.assertTrue(entered.is_set())
                worker = cache._worker
                for _ in range(4):
                    self.assertEqual(cache.get(force=True)["status"], "pending")
                self.assertEqual(len(calls), 1)
                release.set()
                worker.join(2)
                self.assertEqual(cache.get()["cpu"]["temperature"], 46)
                self.assertFalse(cache.get()["sampleStale"])
                self.assertEqual(len(calls), 1)

                release.clear()
                entered.clear()
                with patch.object(agent.time, "monotonic", return_value=cache._at + 61):
                    response = cache.get()
                    self.assertTrue(response["sampleStale"])
                    self.assertEqual(response["sampleAgeSeconds"], 61)
                    self.assertEqual(response["cpu"]["temperature"], 46)
                    self.assertEqual(response["unavailable"][0]["metric"], "agent.sample")
                    worker = cache._worker
                    cache.get(force=True)
                    self.assertEqual(len(calls), 2)
                release.set()
                worker.join(2)
                self.assertFalse(cache.get()["sampleStale"])
            finally:
                release.set()
                if cache._worker:
                    cache._worker.join(2)

    def test_failed_collection_releases_ownership_for_next_sample(self):
        with patch.object(agent, "collect_snapshot", side_effect=[RuntimeError("probe failed"), {"schema": agent.SCHEMA, "cpu": {"temperature": 47}}]):
            cache = agent.SampleCache({}, False, ttl=60)
            self.assertEqual(cache.get()["status"], "pending")
            self.assertEqual(cache.get()["cpu"]["temperature"], 47)

    def test_smc_wait_timeout_does_not_start_a_second_reader(self):
        releases = [threading.Event(), threading.Event()]
        results = ["CPU die temperature: 46 C\nGPU die temperature: 42 C", "CPU die temperature: 51 C\nGPU die temperature: 48 C"]
        calls = []

        def read():
            index = len(calls)
            calls.append(1)
            releases[index].wait(2)
            return results[index]

        with patch.object(agent, "_smc_temperature_text_from_reader", side_effect=read):
            try:
                self.assertEqual(agent.read_smc_temperature_text(0.01), "")
                worker = agent._SMC_READ[0]
                for _ in range(4):
                    self.assertEqual(agent.read_smc_temperature_text(0.01), "")
                self.assertEqual(len(calls), 1)
                releases[0].set()
                worker.join(2)
                self.assertFalse(worker.is_alive())
                temps = agent.resolve_die_temperatures("", elevated=True)
                self.assertEqual(temps["cpuCelsius"], 46)
                self.assertEqual(temps["gpuCelsius"], 42)
                self.assertEqual(len(calls), 1)
                self.assertEqual(agent.read_smc_temperature_text(0.01), "")
                self.assertEqual(len(calls), 2)
                worker = agent._SMC_READ[0]
                releases[1].set()
                worker.join(2)
                self.assertFalse(worker.is_alive())
                self.assertEqual(agent.read_smc_temperature_text(0.01), results[1])
                self.assertEqual(len(calls), 2)
            finally:
                for release in releases:
                    release.set()
                if agent._SMC_READ:
                    agent._SMC_READ[0].join(2)


class PrivilegedInstallationTests(unittest.TestCase):
    def test_plist_round_trip_escapes_paths_and_uses_isolated_protected_copy(self):
        dest = Path('/Library/Application Support/R&D "collector"')
        data = plistlib.loads(installer.build_plist(HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist", dest))
        args = data["ProgramArguments"]
        self.assertEqual(args[:3], ["/usr/bin/python3", "-I", str(dest / "sparkdash_mac_agent.py")])
        self.assertEqual(args[args.index("--config") + 1], str(dest / "runtimes.json"))
        self.assertEqual(args[args.index("--host") + 1], "127.0.0.1")

    def test_all_installation_parents_must_be_root_owned_protected_directories(self):
        path = Path("/Library/Application Support/collector")
        safe = SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        with patch.object(Path, "lstat", return_value=safe):
            installer.protected_directory(path)
        for parent in (path, *path.parents):
            for uid, mode in ((501, stat.S_IFDIR | 0o755), (0, stat.S_IFDIR | 0o775), (0, stat.S_IFLNK | 0o755)):
                def info(value):
                    return SimpleNamespace(st_uid=uid, st_mode=mode) if value == parent else safe
                with patch.object(Path, "lstat", autospec=True, side_effect=info), self.assertRaises(PermissionError):
                    installer.protected_directory(path)

    def test_install_copies_only_payload_and_atomically_replaces_symlinks(self):
        with tempfile.TemporaryDirectory(dir=HERE / "tests") as directory:
            root = Path(directory)
            source = root / "R&D checkout"
            source.mkdir()
            for name, contents in (("sparkdash_mac_agent.py", b"print('collector')"), ("runtimes.json", b'{"runtimes": []}'), ("unrelated.py", b"extra")):
                (source / name).write_bytes(contents)
            dest = root / "installed"
            dest.mkdir()
            victim = root / "user-file"
            victim.write_bytes(b"untouched")
            (dest / "sparkdash_mac_agent.py").symlink_to(victim)
            plist = root / "candidate.plist"
            plist.write_bytes(installer.build_plist(HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist", dest))
            output = root / "daemon.plist"
            with patch.object(installer, "protected_directory"), patch.object(installer.os, "chown"), patch.object(installer.os, "fchown") as owner:
                installer.install_payload(source, dest, plist, output)
            self.assertEqual(set(p.name for p in dest.iterdir()), {"sparkdash_mac_agent.py", "runtimes.json"})
            for name in ("sparkdash_mac_agent.py", "runtimes.json"):
                self.assertEqual((dest / name).read_bytes(), (source / name).read_bytes())
                self.assertEqual(stat.S_IMODE((dest / name).stat().st_mode), 0o644)
                self.assertFalse((dest / name).is_symlink())
            self.assertEqual(victim.read_bytes(), b"untouched")
            self.assertEqual(plistlib.loads(output.read_bytes()), plistlib.loads(plist.read_bytes()))
            self.assertEqual(owner.call_count, 3)
            self.assertTrue(all(call.args[1:] == (0, 0) for call in owner.call_args_list))
            with patch.object(installer, "protected_directory", side_effect=PermissionError("unprotected")):
                with self.assertRaises(PermissionError):
                    installer.install_payload(source, dest, plist, output)
            self.assertEqual(victim.read_bytes(), b"untouched")


class ThermalTests(unittest.TestCase):
    def test_last_recorded_states(self):
        for state in ("nominal", "slow", "trapped"):
            with self.subTest(state=state):
                text = fixture(f"pmset-therm-{state}.txt")
                parsed = agent.parse_pmset_therm(text)
                self.assertEqual(parsed["pressureState"], state)
                self.assertEqual(parsed["lastRecordedEvents"], text.splitlines())

    def test_unknown_and_no_event_output(self):
        for text in ("", "Error: Failed to get thermal warning level", "Thermal Warning Level = 255", "Thermal Warning Level = 42"):
            self.assertEqual(agent.parse_pmset_therm(text)["pressureState"], "unknown")
        self.assertEqual(agent.parse_pmset_therm("Note: No thermal warning level has been recorded")["pressureState"], "nominal")


class ServeTests(unittest.TestCase):
    def test_metrics_and_health_endpoints(self):
        inventory = {"defaults": {}, "runtimes": []}
        cache = agent.SampleCache(inventory, allow_powermetrics=False, ttl=0)
        cache.get = lambda force=False: {"schema": agent.SCHEMA, "ok": True}
        httpd = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.make_handler(cache))
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=2) as resp:
                self.assertEqual(json.loads(resp.read())["ok"], True)
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as resp:
                self.assertEqual(json.loads(resp.read())["schema"], agent.SCHEMA)
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/nope", timeout=2)
            self.assertEqual(ctx.exception.code, 404)
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_cache_serves_one_sample_inside_its_ttl(self):
        calls = []
        original = agent.collect_snapshot
        agent.collect_snapshot = lambda inventory, **kw: (calls.append(1), {"n": len(calls)})[1]
        try:
            cache = agent.SampleCache({"runtimes": []}, allow_powermetrics=False, ttl=60)
            self.assertEqual(cache.get()["n"], 1)
            self.assertEqual(cache.get()["n"], 1)
            self.assertEqual(cache.get(force=True)["n"], 2)
        finally:
            agent.collect_snapshot = original


if __name__ == "__main__":
    unittest.main()
