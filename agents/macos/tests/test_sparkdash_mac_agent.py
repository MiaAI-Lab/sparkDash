"""Unit tests for the Mac node agent (stdlib unittest, no third-party deps).

Run:  python3 -m unittest discover -s agents/macos/tests
"""

from __future__ import annotations

import importlib.util
import json
import os
import plistlib
import stat
import subprocess
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

    def test_splash_public_launcher_matches_cellar_binary_and_current_model(self):
        model = "bottlecapai/ThinkingCap-Qwen3.8-27B-MLX-4bit-DWQ"
        procs = {35930: proc(35930,
            "/opt/homebrew/Cellar/splash/1.4.0/libexec/python/bin/python3 -u -P -m server.server "
            f"--model {model} --binary /opt/homebrew/Cellar/splash/1.4.0/libexec/engine/splash --port 8100")}
        found = self.detect(procs, owned(35930, 8100), health=ok(8100, model))
        self.assertEqual(found[0]["name"], "splash")
        self.assertEqual(found[0]["model"], model)

    def test_mtplx_module_server_is_a_model_runtime_not_the_mux(self):
        model = "Youssofal/Qwen3.8-27B-MTPLX-Optimized-Speed"
        procs = {351: proc(351, f"/opt/homebrew/bin/python3 -P -m mtplx.server.openai --model {model} --port 8210")}
        found = self.detect(procs, owned(351, 8210), health=ok(8210, model))
        self.assertEqual(found[0]["name"], "mtplx-27b")

    def test_native_omlx_server_matches_its_listener(self):
        found = self.detect({777: proc(777, "omlx-server")}, owned(777, 8000), health=ok(8000, "model"))
        self.assertEqual(found[0]["name"], "omlx")

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

    def test_physical_memory_and_pressure_use_native_counters(self):
        vm = agent.parse_vm_stat("Pages occupied by compressor: 65536.\n")
        counters = {
            "hw.memsize": "17179869184", "hw.pagesize": "16384",
            "vm.page_pageable_internal_count": "327680", "vm.page_pageable_external_count": "196608",
            "vm.page_free_count": "262144", "vm.page_wired_count": "131072", "vm.page_purgeable_count": "32768",
            "kern.memorystatus_vm_pressure_level": "1",
        }
        mem = agent.unified_memory(vm, 17179869184, counters)
        self.assertEqual(mem["physical"], {"apps": 4608, "wired": 2048, "compressed": 1024, "cached": 3584, "free": 4096, "other": 1024})
        self.assertEqual(mem["used"], 8704)
        self.assertEqual(mem["memoryPressure"], "normal")
        self.assertEqual(mem["oomRisk"], "low")
        counters.pop("kern.memorystatus_vm_pressure_level")
        self.assertEqual(agent.unified_memory(vm, 17179869184, counters)["oomRisk"], None)

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
        self.assertIsNone(mem["oomRisk"])

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
            {"gpu.utilization", "gpu.power", "ane.power", "cpu.power"},
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
        self.assertEqual(len(unavailable), 4)

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
                    self.assertAlmostEqual(response["sampleAgeSeconds"], 61)
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

    def test_build_plist_adds_storage_categories_flag_when_requested(self):
        dest = Path("/Library/Application Support/sparkdash-collector")
        without = plistlib.loads(installer.build_plist(HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist", dest))
        self.assertNotIn("--storage-categories", without["ProgramArguments"])
        self.assertEqual(without["ProgramArguments"][0], "/usr/bin/python3")
        with_flag = plistlib.loads(
            installer.build_plist(
                HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist",
                dest,
                storage_categories=True,
                python_bin="",
            )
        )
        self.assertIn("--storage-categories", with_flag["ProgramArguments"])
        self.assertEqual(with_flag["ProgramArguments"][0], "/usr/bin/python3")

    def test_resolve_privileged_python_and_build_plist_uses_python_app_for_storage_categories(self):
        dest = Path("/Library/Application Support/sparkdash-collector")
        xcode_py = (
            "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/"
            "Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python"
        )
        clt_py = (
            "/Library/Developer/CommandLineTools/Library/Frameworks/"
            "Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python"
        )
        plist_bytes = installer.build_plist(
            HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist",
            dest,
            storage_categories=True,
            python_bin=xcode_py,
        )
        parsed = plistlib.loads(plist_bytes)
        self.assertEqual(parsed["ProgramArguments"][0], xcode_py)
        self.assertIn("--storage-categories", parsed["ProgramArguments"])

        def make_lstat(overrides):
            def _lstat(path_obj):
                s = str(path_obj)
                if s in overrides:
                    return overrides[s]
                if s.endswith("/MacOS/Python"):
                    return SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=0)
                if s == "/Applications":
                    return SimpleNamespace(st_mode=stat.S_IFDIR | 0o775, st_uid=0)
                return SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0)
            return _lstat

        with patch.object(Path, "lstat", autospec=True, side_effect=make_lstat({})), \
             patch.object(installer.os.path, "realpath", side_effect=lambda p: p):
            self.assertEqual(installer.resolve_privileged_python(xcode_py), xcode_py)
            self.assertEqual(installer.resolve_privileged_python(clt_py), clt_py)
            # Non-.app binary must be rejected.
            self.assertIsNone(installer.resolve_privileged_python("/opt/custom/bin/python3"))
            self.assertIsNone(installer.resolve_privileged_python(""))
            self.assertIsNone(installer.resolve_privileged_python("python3"))

        # User-owned binary or parent -> rejected.
        with patch.object(
            Path, "lstat", autospec=True,
            side_effect=make_lstat({xcode_py: SimpleNamespace(st_mode=stat.S_IFREG | 0o755, st_uid=501)}),
        ), patch.object(installer.os.path, "realpath", side_effect=lambda p: p):
            self.assertIsNone(installer.resolve_privileged_python(xcode_py))

        with patch.object(
            Path, "lstat", autospec=True,
            side_effect=make_lstat({"/Applications": SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=501)}),
        ), patch.object(installer.os.path, "realpath", side_effect=lambda p: p):
            self.assertIsNone(installer.resolve_privileged_python(xcode_py))

        # World-writable ancestor above bundle -> rejected.
        with patch.object(
            Path, "lstat", autospec=True,
            side_effect=make_lstat({"/Applications": SimpleNamespace(st_mode=stat.S_IFDIR | 0o777, st_uid=0)}),
        ), patch.object(installer.os.path, "realpath", side_effect=lambda p: p):
            self.assertIsNone(installer.resolve_privileged_python(xcode_py))

        # Group-writable directory inside .app bundle -> rejected.
        bundle_macos = str(Path(xcode_py).parent)
        with patch.object(
            Path, "lstat", autospec=True,
            side_effect=make_lstat({bundle_macos: SimpleNamespace(st_mode=stat.S_IFDIR | 0o775, st_uid=0)}),
        ), patch.object(installer.os.path, "realpath", side_effect=lambda p: p):
            self.assertIsNone(installer.resolve_privileged_python(xcode_py))

    def test_build_plist_uses_branded_app_bundle_for_storage_categories_when_enabled(self):
        dest = Path("/Library/Application Support/sparkdash-collector")
        bundle_plist = plistlib.loads(
            installer.build_plist(
                HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist",
                dest,
                storage_categories=True,
                use_app_bundle=True,
            )
        )
        self.assertEqual(
            bundle_plist["ProgramArguments"][0],
            str(dest / "SparkDash Mac Agent.app" / "Contents" / "MacOS" / "SparkDash Mac Agent"),
        )
        self.assertIn("--storage-categories", bundle_plist["ProgramArguments"])

    def test_ensure_app_bundle_compiles_signs_icons_executes_and_is_idempotent(self):
        if not installer.can_build_app_bundle():
            self.skipTest("macOS clang/codesign toolchain unavailable")
        with tempfile.TemporaryDirectory(dir=HERE / "tests") as directory:
            root = Path(directory)
            install_dir = root / "install"
            install_dir.mkdir()
            icon_png = HERE.parent.parent / "public" / "icons" / "icon-512.png"
            with patch.object(installer.os, "chown"):
                app_path = installer.ensure_app_bundle(HERE, install_dir, icon_path=icon_png)
                exe_path = app_path / "Contents" / "MacOS" / installer.APP_EXECUTABLE_NAME
                info = plistlib.loads((app_path / "Contents" / "Info.plist").read_bytes())
                self.assertEqual(info["CFBundleIdentifier"], "ai.onyx.sparkdash-mac-agent")
                self.assertEqual(info["CFBundleName"], "SparkDash Mac Agent")
                self.assertEqual(info["CFBundleExecutable"], "SparkDash Mac Agent")
                if icon_png.is_file() and Path("/usr/bin/iconutil").is_file():
                    self.assertEqual(info.get("CFBundleIconFile"), "AppIcon")
                    self.assertTrue((app_path / "Contents" / "Resources" / "AppIcon.icns").is_file())
                verify = subprocess.run(
                    ["/usr/bin/codesign", "--verify", "--strict", str(app_path)],
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(verify.returncode, 0, verify.stderr)

                stat_before = exe_path.stat()
                app_again = installer.ensure_app_bundle(HERE, install_dir, icon_path=icon_png)
                self.assertEqual(app_again, app_path)
                stat_after = exe_path.stat()
                self.assertEqual(stat_before.st_ino, stat_after.st_ino)
                self.assertEqual(stat_before.st_mtime_ns, stat_after.st_mtime_ns)

                run_res = subprocess.run(
                    [str(exe_path), "-c", 'import sys; print("ok", sys.argv[1])', "hello"],
                    capture_output=True,
                    text=True,
                    timeout=10,
                    check=False,
                )
                self.assertEqual(run_res.returncode, 0, run_res.stderr)
                self.assertEqual(run_res.stdout.strip(), "ok hello")

    def test_install_preserves_existing_root_owned_storage_categories_config(self):
        with tempfile.TemporaryDirectory(dir=HERE / "tests") as directory:
            root = Path(directory)
            source = root / "src"
            source.mkdir()
            (source / "sparkdash_mac_agent.py").write_bytes(b"print('agent')\n")
            (source / "runtimes.json").write_text(json.dumps({"runtimes": [{"name": "a"}]}), "utf-8")
            dest = root / "installed"
            dest.mkdir()
            existing_cfg = {"runtimes": [], "storageCategories": {"enabled": True, "home": "/Users/alice"}}
            (dest / "runtimes.json").write_text(json.dumps(existing_cfg), "utf-8")
            plist = root / "candidate.plist"
            plist.write_bytes(installer.build_plist(HERE / "ai.onyx.sparkdash-mac-agent.privileged.plist", dest))
            output = root / "daemon.plist"
            root_reg = SimpleNamespace(st_mode=stat.S_IFREG | 0o644, st_uid=0)
            with patch.object(installer, "protected_directory"), \
                 patch.object(installer.os, "chown"), \
                 patch.object(installer.os, "fchown"), \
                 patch.object(Path, "lstat", return_value=root_reg):
                installer.install_payload(source, dest, plist, output)
            installed_cfg = json.loads((dest / "runtimes.json").read_text("utf-8"))
            self.assertEqual(installed_cfg["runtimes"], [{"name": "a"}])
            self.assertEqual(installed_cfg["storageCategories"], {"enabled": True, "home": "/Users/alice"})


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




class ReviewRegressionTests(unittest.TestCase):
    def test_background_cpu_failure_expires_previous_sample_and_recovers(self):
        probe = agent.CpuProbe()
        with patch.object(agent, "cpu_sample_psutil", return_value={"usagePercent": 91}), patch.object(agent, "cpu_sample_iostat", return_value=None), patch.object(agent, "cpu_sample_top", return_value=None):
            probe._refresh()
            self.assertEqual(probe.sample()["usagePercent"], 91)
        with patch.object(agent, "cpu_sample_psutil", return_value=None), patch.object(agent, "cpu_sample_iostat", return_value=None), patch.object(agent, "cpu_sample_top", return_value=None):
            probe._refresh()
            self.assertIsNone(probe.sample())
        with patch.object(agent, "cpu_sample_psutil", return_value={"usagePercent": 32}):
            probe._refresh()
            self.assertEqual(probe.sample()["usagePercent"], 32)

    def test_parsed_cpu_power_is_published_and_missing_power_is_unknown(self):
        with patch.object(agent, "run", return_value="CPU Power: 10000 mW\nGPU Power: 2000 mW\nCombined Power (CPU + GPU + ANE): 12000 mW\n"):
            block, gaps = agent.gpu_stats(True)
        self.assertEqual(block["cpuW"], 10)
        self.assertNotIn("cpu.power", {gap["metric"] for gap in gaps})
        block, gaps = agent.gpu_stats(False)
        self.assertIsNone(block["cpuW"])
        self.assertIn("cpu.power", {gap["metric"] for gap in gaps})

    def test_failed_process_probe_is_unknown_instead_of_empty(self):
        with patch.object(agent, "run", return_value=""):
            with self.assertRaises(RuntimeError):
                agent.list_processes()
        failed = SimpleNamespace(returncode=2, communicate=lambda **kw: ("", "denied"))
        with patch.object(agent.subprocess, "Popen", return_value=failed):
            with self.assertRaises(RuntimeError):
                agent.listening_sockets()
        empty = SimpleNamespace(returncode=1, communicate=lambda **kw: ("", ""))
        with patch.object(agent.subprocess, "Popen", return_value=empty):
            self.assertEqual(agent.listening_sockets(), {})


class AuthenticatedHealthTests(unittest.TestCase):
    def test_private_key_is_used_only_for_authenticated_loopback_health(self):
        import sys
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"data":[{"id":"private-model"}]}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.object(sys, "path", [str(HERE), *sys.path]):
                key = Path(directory) / "key"
                key.write_text("test-health-key")
                key.chmod(0o600)
                result = agent.health_check(server.server_port, "/v1/models", 1000, api_key_file=str(key))
                self.assertTrue(result["ok"])
                self.assertEqual(result["model"], "private-model")
                self.assertEqual(calls, ["Bearer test-health-key"])
                key.chmod(0o644)
                self.assertFalse(agent.health_check(server.server_port, "/v1/models", 1000, api_key_file=str(key))["ok"])
                self.assertEqual(calls, ["Bearer test-health-key"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


class StorageCategoryTests(unittest.TestCase):
    @staticmethod
    def du_with(answers):
        """du fake: known calls answer from the table; unknown calls report 0 KB, exit 0."""
        return lambda paths: answers.get(tuple(paths)) or ("\n".join(f"0\t{p}" for p in paths), 0)

    def test_parse_du_output_keeps_paths_with_spaces_and_skips_junk(self):
        sizes = agent.parse_du_output("12\t/Applications\n3456\t/Users/u/Library/Mobile Documents\nnot-a-du-line\n\nab\tcd\n")
        self.assertEqual(sizes, {"/Applications": 12, "/Users/u/Library/Mobile Documents": 3456})

    def test_external_volumes_lists_local_writable_non_tm_mounts_only(self):
        df = ("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n"
              "/dev/disk3s5 1 1 1 1% 512 0 0 /System/Volumes/Data\n"
              "/dev/disk3s3 1 1 1 1% 512 0 0 /Volumes/Recovery\n"
              "/dev/disk5s1 1 1 1 1% 512 0 0 /Volumes/ExternalSSD\n"
              "/dev/disk5s2 1 1 1 1% 512 0 0 /Volumes/My  Space Drive\n"
              "/dev/disk8s1 1 1 1 1% 512 0 0 /Volumes/InstallerDMG\n"
              "/dev/disk9s1 1 1 1 1% 512 0 0 /Volumes/TimeMachine\n"
              "smbfs//u@nas/share 1 1 1 1% 512 0 0 /Volumes/nas\n"
              "/dev/disk6s1 1 1 1 1% 512 0 0 /Volumes/.Spotlight-V100\n"
              "/dev/disk7s1 1 1 1 1% 512 0 0 /Volumes/Backups\n")
        found = agent.external_volumes(
            df,
            exclude_volumes={"/Volumes/Backups"},
            is_readonly=lambda m: m == "/Volumes/InstallerDMG",
            is_timemachine=lambda m: m == "/Volumes/TimeMachine",
        )
        self.assertEqual(found, ["/Volumes/ExternalSSD", "/Volumes/My  Space Drive"])

    def test_disk_stats_defaults_to_internal_only_and_supports_root_fallback(self):
        df_ext = ("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n"
                  "/dev/disk3s5 500000000 100000000 400000000 20% 512 0 0 /System/Volumes/Data\n"
                  "smbfs//u@nas/share 1000000000 200000000 800000000 20% 512 0 0 /Volumes/nas\n"
                  "/dev/disk5s1 1000000000 204800000 795200000 21% 512 0 0 /Volumes/ExternalSSD\n"
                  "/dev/disk8s1 1024000 1024000 0 100% 512 0 0 /Volumes/InstallerDMG\n"
                  "/dev/disk3s3 1 1 1 1% 512 0 0 /Volumes/Recovery\n")
        cmds = []
        def fake_run(cmd, timeout=1):
            cmds.append(cmd)
            return df_ext
        with patch.object(agent, "run", side_effect=fake_run):
            default_disks = agent.disk_stats()
            self.assertEqual(cmds[-1], ["df", "-kl"])
            self.assertEqual([d["label"] for d in default_disks], ["/System/Volumes/Data"])

            with_ext = agent.disk_stats(
                include_external=True,
                is_readonly=lambda m: m == "/Volumes/InstallerDMG",
                is_timemachine=lambda m: False,
            )
            self.assertEqual([d["label"] for d in with_ext], ["/System/Volumes/Data", "/Volumes/ExternalSSD"])
            self.assertEqual(with_ext[1]["device"], "disk5s1")
            self.assertEqual(with_ext[1]["used"], 200000)

        df_root_only = ("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n"
                        "/dev/disk1s1 200000000 50000000 150000000 25% 512 0 0 /\n")
        with patch.object(agent, "run", return_value=df_root_only):
            root_disks = agent.disk_stats()
            self.assertEqual([d["label"] for d in root_disks], ["/"])

    def test_internal_volume_documents_residual_scans_top_level_and_excludes_apps_developer(self):
        home = "/Users/alice"
        top_entries = [
            f"{home}/Applications",
            f"{home}/Developer",
            f"{home}/Library",
            f"{home}/Pictures",
            f"{home}/Music",
            f"{home}/Movies",
            f"{home}/.Trash",
            f"{home}/Documents",
            f"{home}/Projects",
        ]
        answers = {
            (f"{home}/Documents", f"{home}/Projects"): (
                f"12000\t{home}/Documents\n30000\t{home}/Projects\n", 0),
        }
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value=home):
            cats = agent._scan_volume_categories(
                "/System/Volumes/Data",
                dir_state=lambda p: "ok" if p.startswith(home) else "missing",
                du_runner=StorageCategoryTests.du_with(answers),
                list_dir=lambda base: top_entries if base == home else [],
                path_dev=lambda p: 1,
            )
        docs = next(c for c in cats if c["id"] == "documents")
        self.assertEqual(docs, {"id": "documents", "megabytes": 41})

    def test_internal_volume_documents_residual_omitted_when_home_unreadable(self):
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value="/Users/alice"):
            cats = agent._scan_volume_categories(
                "/System/Volumes/Data",
                dir_state=lambda p: "denied",
                du_runner=lambda paths: ("", 1),
                path_dev=lambda p: 1,
            )
        self.assertEqual([c for c in cats if c["id"] == "documents"], [])

    def test_external_volume_denied_root_emits_restricted_documents(self):
        m = "/Volumes/SSD"
        cats_denied = agent._scan_volume_categories(
            m,
            dir_state=lambda p: "denied" if p == m else "missing",
            du_runner=lambda paths: ("", 1),
            path_dev=lambda p: 2,
        )
        self.assertEqual(cats_denied, [{"id": "documents", "megabytes": 0, "restricted": True}])

        cats_missing = agent._scan_volume_categories(
            m,
            dir_state=lambda p: "missing",
            du_runner=lambda paths: ("", 0),
            path_dev=lambda p: 2,
        )
        self.assertEqual(cats_missing, [])

    def test_external_volume_categories_root_at_the_mount_point_without_double_counting(self):
        m = "/Volumes/SSD"
        existing = {m + "/Applications", m + "/Developer", m + "/.Trashes", m, m + "/Library", m + "/Projects"}
        answers = {
            (m + "/Applications",): (f"12000\t{m}/Applications\n", 0),
            (m + "/Developer",): (f"8000\t{m}/Developer\n", 0),
            (m + "/.Trashes",): (f"800\t{m}/.Trashes\n", 0),
            (m + "/Projects",): (f"69200\t{m}/Projects\n", 0),
        }
        cats = agent._scan_volume_categories(
            m,
            dir_state=lambda p: "ok" if p in existing else "missing",
            du_runner=StorageCategoryTests.du_with(answers),
            list_dir=lambda base: [
                f"{m}/Applications", f"{m}/Developer", f"{m}/Library",
                f"{m}/.Trashes", f"{m}/.Spotlight-V100", f"{m}/Projects",
            ],
            path_dev=lambda p: 2,
        )
        # Applications (12000), Developer (8000), Library, .Trashes (800), and .Spotlight-V100
        # are excluded from Documents -> only Projects (69200 KB ~= 68 MB) counts in Documents.
        self.assertEqual(cats, [
            {"id": "applications", "megabytes": 12},
            {"id": "developer", "megabytes": 8},
            {"id": "documents", "megabytes": 68},
            {"id": "trash", "megabytes": 1},
        ])

    def test_external_denied_directory_marks_category_restricted(self):
        m = "/Volumes/SSD"
        state = lambda p: "denied" if p == m + "/Pictures" else "ok"
        du = lambda paths: (f"12000\t{m}/Applications\n", 1)
        cats = agent._scan_volume_categories(
            m,
            dir_state=state,
            du_runner=du,
            list_dir=lambda base: [f"{m}/Applications", f"{m}/Pictures", f"{m}/Data"],
            path_dev=lambda p: 2,
        )
        self.assertEqual(next(c for c in cats if c["id"] == "photos"),
                         {"id": "photos", "megabytes": 0, "restricted": True})

    def test_external_du_silently_skipping_readable_dir_restricts_it(self):
        m = "/Volumes/SSD"
        answers = {
            (m + "/Applications",): (f"12000\t{m}/Applications\n", 0),
            (m + "/.Trashes",): ("", 0),
            (m + "/Data",): (f"40000\t{m}/Data\n", 0),
        }
        cats = agent._scan_volume_categories(
            m,
            dir_state=lambda p: "ok",
            du_runner=StorageCategoryTests.du_with(answers),
            list_dir=lambda base: [f"{m}/Applications", f"{m}/Library", f"{m}/.Trashes", f"{m}/Data"],
            path_dev=lambda p: 2,
        )
        self.assertTrue(next(c for c in cats if c["id"] == "trash")["restricted"])

    def test_real_chmod_000_directory_is_denied_and_marks_documents_restricted(self):
        with tempfile.TemporaryDirectory() as tmp:
            denied = os.path.join(tmp, "Documents")
            readable = os.path.join(tmp, "Projects")
            os.makedirs(denied)
            os.makedirs(readable)
            with open(os.path.join(readable, "a.bin"), "wb") as handle:
                handle.write(b"x" * (1024 * 1024))
            os.chmod(denied, 0o000)
            try:
                if os.geteuid() != 0:
                    self.assertEqual(agent._dir_state(denied), "denied")
                    self.assertEqual(agent._dir_state(readable), "ok")
                # Even when mocked as non-root or checked via du_runner, denied child sets restricted.
                with patch.object(agent.os, "geteuid", return_value=0), \
                     patch.object(agent, "console_user_home", return_value=tmp):
                    cats = agent._scan_volume_categories(
                        "/System/Volumes/Data",
                        dir_state=(agent._dir_state if os.geteuid() != 0 else (lambda p: "denied" if p == denied else "ok")),
                        du_runner=lambda paths: ("\n".join(f"1024\t{p}" for p in paths), 0),
                        path_dev=lambda p: 1,
                    )
                docs = next(c for c in cats if c["id"] == "documents")
                self.assertEqual(docs["restricted"], True)
            finally:
                os.chmod(denied, 0o700)

    def test_run_du_treats_benign_file_provider_deadlock_as_ok_but_keeps_eperm_nonzero(self):
        deadlock_proc = SimpleNamespace(
            returncode=1,
            communicate=lambda **kw: ("100\t/Users/alice/Drive\n", "du: /Users/alice/Drive/p: Resource deadlock avoided\n"),
        )
        with patch.object(agent.subprocess, "Popen", return_value=deadlock_proc):
            out, code = agent._run_du(["/Users/alice/Drive"])
        self.assertEqual(code, 0)
        self.assertIn("/Users/alice/Drive", out)

        eperm_proc = SimpleNamespace(
            returncode=1,
            communicate=lambda **kw: ("100\t/Users/alice/Documents\n", "du: /Users/alice/Documents: Operation not permitted\n"),
        )
        with patch.object(agent.subprocess, "Popen", return_value=eperm_proc):
            _, code = agent._run_du(["/Users/alice/Documents"])
        self.assertEqual(code, 1)

        mixed_proc = SimpleNamespace(
            returncode=1,
            communicate=lambda **kw: ("", "du: p1: Resource deadlock avoided\ndu: p2: Permission denied\n"),
        )
        with patch.object(agent.subprocess, "Popen", return_value=mixed_proc):
            _, code = agent._run_du(["/Users/alice/Documents"])
        self.assertEqual(code, 1)

    def test_volume_with_nothing_measured_yields_no_entry(self):
        cats = agent._scan_volume_categories(
            "/Volumes/Empty",
            dir_state=lambda p: "missing",
            du_runner=lambda paths: ("", 0),
            path_dev=lambda p: 2,
        )
        self.assertEqual(cats, [])
        self.assertEqual(
            agent.storage_category_scan(
                volumes=["/Volumes/Empty"],
                dir_state=lambda p: "missing",
                du_runner=lambda paths: ("", 0),
                path_dev=lambda p: 2,
            ),
            [],
        )

    def test_scan_walks_internal_and_external_volumes_and_respects_extra_paths_and_st_dev(self):
        home = "/Users/alice"
        m = "/Volumes/SSD"
        cfg = agent.storage_category_config({
            "runtimes": [],
            "storageCategories": {
                "enabled": True,
                "home": home,
                "excludeVolumes": ["/Volumes/SkipMe"],
                "extraPaths": {
                    "models": [f"{home}/work/models", f"{m}/models"],
                },
            },
        })
        assert cfg is not None
        # Nested extraPath inside ~/work must be deducted from Documents (no double-count),
        # and ~/RemoteMount on a different st_dev must not be counted on the internal volume.
        devs = {
            "/System/Volumes/Data": 1,
            f"{home}": 1,
            f"{home}/Pictures": 1,
            f"{home}/work": 1,
            f"{home}/work/models": 1,
            f"{home}/RemoteMount": 99,
            m: 2,
            f"{m}/models": 2,
            f"{m}/Projects": 2,
        }
        answers = {
            (f"{home}/Pictures",): (f"2048\t{home}/Pictures\n", 0),
            (f"{home}/work/models",): (f"10240\t{home}/work/models\n", 0),
            (f"{home}/work",): (f"15360\t{home}/work\n", 0),
            (f"{m}/models",): (f"20480\t{m}/models\n", 0),
            (f"{m}/Projects",): (f"51200\t{m}/Projects\n", 0),
        }
        existing = set(devs)
        result = agent.storage_category_scan(
            volumes=["/System/Volumes/Data", m],
            config=cfg,
            dir_state=lambda p: "ok" if p in existing else "missing",
            du_runner=StorageCategoryTests.du_with(answers),
            list_dir=lambda base: (
                [f"{home}/Pictures", f"{home}/work", f"{home}/RemoteMount"]
                if base == home else [f"{m}/models", f"{m}/Projects"]
            ),
            path_dev=lambda p: devs.get(p),
        )
        self.assertEqual([entry["volume"] for entry in result], ["/System/Volumes/Data", m])
        internal_by_id = {c["id"]: c for c in result[0]["categories"]}
        self.assertEqual(internal_by_id["photos"]["megabytes"], 2)
        self.assertEqual(internal_by_id["models"]["megabytes"], 10)
        # ~/work is 15 MB total minus 10 MB nested models = 5 MB Documents
        self.assertEqual(internal_by_id["documents"]["megabytes"], 5)

        ext_by_id = {c["id"]: c for c in result[1]["categories"]}
        self.assertEqual(ext_by_id["models"]["megabytes"], 20)
        self.assertEqual(ext_by_id["documents"]["megabytes"], 50)

    def test_storage_category_config_parses_boolean_and_object_forms(self):
        self.assertIsNone(agent.storage_category_config({"runtimes": []}))
        self.assertIsNone(agent.storage_category_config({"runtimes": [], "storageCategories": False}))
        self.assertIsNone(agent.storage_category_config({"runtimes": [], "storageCategories": {"enabled": False}}))
        cli = agent.storage_category_config({"runtimes": [], "storageCategories": {"enabled": False, "home": "/Users/bob"}}, cli_enabled=True)
        self.assertEqual(cli["home"], "/Users/bob")
        obj = agent.storage_category_config({
            "runtimes": [],
            "storageCategories": {
                "enabled": True,
                "externalVolumes": False,
                "excludeVolumes": ["/Volumes/TimeMachine/"],
                "extraPaths": {"developer": ["/opt/homebrew"]},
            },
        })
        self.assertFalse(obj["external_volumes"])
        self.assertEqual(obj["exclude_volumes"], {"/Volumes/TimeMachine"})
        self.assertEqual(obj["extra_paths"], {"developer": ["/opt/homebrew"]})

    def _snapshot_with_categories(self, storage_probe):
        df = ("Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n"
              "/dev/disk3s5 500000000 134227000 365773000 27% 512 0 0 /System/Volumes/Data\n"
              "/dev/disk5s1 1000000000 204800000 795200000 21% 512 0 0 /Volumes/ExternalSSD\n")
        original_run = agent.run
        original_sockets = agent.listening_sockets
        original_probe = agent.probe_reachability
        agent.run = lambda cmd, timeout=1: df if cmd[:1] == ["df"] else ""
        agent.listening_sockets = lambda: {}
        agent.probe_reachability = lambda *a: []
        try:
            with patch.object(agent, "_is_readonly_mount", return_value=False), \
                 patch.object(agent, "_is_timemachine_volume", return_value=False):
                return agent.collect_snapshot(
                    INVENTORY, allow_powermetrics=False, cpu_probe=None,
                    storage_probe=storage_probe, procs={}, listeners={},
                )
        finally:
            agent.run = original_run
            agent.listening_sockets = original_sockets
            agent.probe_reachability = original_probe

    def test_categories_attach_to_each_volume_with_per_volume_residual(self):
        probe = SimpleNamespace(
            _config={"external_volumes": True, "exclude_volumes": set()},
            sample=lambda: [
                {"volume": "/System/Volumes/Data", "categories": [
                    {"id": "applications", "megabytes": 12000},
                    {"id": "trash", "megabytes": 800},
                ]},
                {"volume": "/Volumes/ExternalSSD", "categories": [
                    {"id": "documents", "megabytes": 100000},
                ]},
            ],
        )
        snap = self._snapshot_with_categories(probe)
        data = next(d for d in snap["disks"] if d["label"] == "/System/Volumes/Data")
        external = next(d for d in snap["disks"] if d["label"] == "/Volumes/ExternalSSD")
        self.assertEqual(data["categories"], [
            {"id": "applications", "megabytes": 12000},
            {"id": "trash", "megabytes": 800},
            {"id": "systemData", "megabytes": 131081 - 12800},
        ])
        self.assertEqual(external["categories"], [
            {"id": "documents", "megabytes": 100000},
            {"id": "systemData", "megabytes": 200000 - 100000},
        ])

    def test_categories_stay_absent_and_external_disks_stay_off_without_probe(self):
        snap = self._snapshot_with_categories(None)
        self.assertEqual([d["label"] for d in snap["disks"]], ["/System/Volumes/Data"])
        self.assertNotIn("categories", snap["disks"][0])
        no_sample = SimpleNamespace(_config={"external_volumes": True}, sample=lambda: None)
        snap = self._snapshot_with_categories(no_sample)
        data = next(d for d in snap["disks"] if d["label"] == "/System/Volumes/Data")
        self.assertNotIn("categories", data)

    def test_started_probe_never_blocks_requests_on_the_first_du(self):
        gate = threading.Event()
        def slow_scan(*args, **kwargs):
            gate.wait(2)
            return [{"volume": "/System/Volumes/Data", "categories": [{"id": "documents", "megabytes": 1}]}]
        probe = agent.StorageCategoryProbe(interval=60)
        with patch.object(agent, "storage_category_scan", side_effect=slow_scan):
            probe.start()
            t0 = time.monotonic()
            sample = probe.sample()
            elapsed = time.monotonic() - t0
            self.assertIsNone(sample)
            self.assertLess(elapsed, 1.0)
        gate.set()
        for _ in range(60):
            if probe.sample() is not None:
                break
            time.sleep(0.05)
        self.assertEqual(probe.sample()[0]["volume"], "/System/Volumes/Data")
        probe.stop()

    def test_probe_retries_at_retry_interval_without_concurrent_scans(self):
        calls = []
        active = 0
        overlap = False
        done = threading.Event()

        def flaky_scan(*args, **kwargs):
            nonlocal active, overlap
            active += 1
            if active > 1:
                overlap = True
            calls.append(time.monotonic())
            try:
                if len(calls) == 1:
                    raise RuntimeError("transient du error")
                done.set()
                return [{"volume": "/System/Volumes/Data", "categories": [{"id": "documents", "megabytes": 3}]}]
            finally:
                active -= 1

        probe = agent.StorageCategoryProbe(interval=60.0, retry_interval=0.05)
        with patch.object(agent, "storage_category_scan", side_effect=flaky_scan):
            probe.start()
            self.assertTrue(done.wait(2.0), "probe did not retry within retry_interval")
            probe.stop()
        self.assertFalse(overlap)
        self.assertGreaterEqual(len(calls), 2)
        self.assertLess(calls[1] - calls[0], 1.0, "retry waited the full interval instead of retry_interval")
        self.assertEqual(probe.sample()[0]["volume"], "/System/Volumes/Data")

    def test_unstarted_probe_computes_inline_for_once_mode(self):
        probe = agent.StorageCategoryProbe(interval=60)
        with patch.object(agent, "storage_category_scan",
                          return_value=[{"volume": "/System/Volumes/Data",
                                         "categories": [{"id": "documents", "megabytes": 5}]}]):
            self.assertEqual(probe.sample(), [{"volume": "/System/Volumes/Data",
                                               "categories": [{"id": "documents", "megabytes": 5}]}])

    def test_tilde_paths_expand_for_root_console_user_headless_and_non_root_agent(self):
        fake = "/Users/consoleuser"
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value=fake):
            self.assertEqual(agent.expand_category_path("~/Pictures"), fake + "/Pictures")
            self.assertEqual(agent.expand_category_path("~/.Trash"), fake + "/.Trash")
            self.assertEqual(agent.expand_category_path("/Applications"), "/Applications")
        # Root daemon with no logged-in console user must NOT resolve ~ to /var/root.
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value=None):
            self.assertIsNone(agent.expand_category_path("~/Pictures"))
            self.assertEqual(
                agent._scan_volume_categories("/System/Volumes/Data", dir_state=lambda p: "ok", du_runner=lambda p: ("", 0)),
                [],
            )
        # Non-root user agent uses its own HOME rather than /dev/console.
        with patch.object(agent.os, "geteuid", return_value=501), \
             patch.object(agent, "console_user_home", return_value="/Users/other"), \
             patch.dict(os.environ, {"HOME": "/Users/self"}):
            self.assertEqual(agent.expand_category_path("~/Pictures"), "/Users/self/Pictures")

    def test_internal_scan_roots_at_the_console_user_home(self):
        fake = "/Users/consoleuser"
        calls: list[list[str]] = []
        def du(paths):
            calls.append(list(paths))
            return ("\n".join(f"0\t{p}" for p in paths), 0)
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value=fake):
            agent._scan_volume_categories(
                "/System/Volumes/Data",
                dir_state=lambda p: "ok" if p == fake + "/Pictures" else "missing",
                du_runner=du,
                path_dev=lambda p: 1,
            )
        self.assertIn([fake + "/Pictures"], calls)

    def test_documents_residual_restricts_when_an_entry_is_missing_from_du_output(self):
        home = "/Users/alice"
        answers = {
            (f"{home}/Desktop", f"{home}/Documents"): (f"700\t{home}/Desktop\n", 0),
        }
        with patch.object(agent.os, "geteuid", return_value=0), \
             patch.object(agent, "console_user_home", return_value=home):
            cats = agent._scan_volume_categories(
                "/System/Volumes/Data",
                dir_state=lambda p: "ok" if p.startswith(home) else "missing",
                du_runner=StorageCategoryTests.du_with(answers),
                list_dir=lambda base: [f"{home}/Desktop", f"{home}/Documents"] if base == home else [],
                path_dev=lambda p: 1,
            )
        self.assertEqual(next(c for c in cats if c["id"] == "documents"),
                         {"id": "documents", "megabytes": 1, "restricted": True})

    def test_resolve_fda_target_extracts_app_bundle_and_setup_fda_runs_cleanly(self):
        with tempfile.TemporaryDirectory(dir=HERE / "tests") as directory:
            installed = Path(directory) / agent.BRANDED_APP_BUNDLE_NAME
            installed.mkdir()
            self.assertEqual(agent.resolve_fda_target(installed_app=installed), str(installed))
            missing = Path(directory) / "Absent.app"
            with patch.object(agent, "run", return_value="/System/Python.app/Contents/MacOS/Python"):
                self.assertEqual(agent.resolve_fda_target(installed_app=missing), "/System/Python.app")
        app_exec = "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python"
        self.assertEqual(
            agent.resolve_fda_target(executable="/usr/bin/python3", comm=app_exec),
            "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app",
        )
        xcode_exec = "/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/Resources/Python.app/Contents/MacOS/Python"
        self.assertEqual(
            agent.resolve_fda_target(executable="/usr/bin/python3", comm=xcode_exec),
            "/Applications/Xcode.app",
        )
        self.assertEqual(
            agent.resolve_fda_target(executable="/opt/custom/bin/python3", comm=""),
            os.path.realpath("/opt/custom/bin/python3"),
        )
        opened = []
        with patch.object(agent, "resolve_fda_target", return_value="/System/Python.app"), \
             patch.object(agent, "_resolve_scan_home", return_value="/Users/alice"), \
             patch.object(agent.sys, "platform", "darwin"), \
             patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SSH_CONNECTION", None)
            # open_ui=True opens Finder + Settings
            rc = agent.setup_fda(
                open_ui=True,
                opener=lambda cmd, **kw: opened.append(cmd),
                dir_state=lambda p: "denied" if p.endswith("Documents") else "ok",
            )
            self.assertEqual(rc, 0)
            self.assertEqual(opened, [
                ["open", "-R", "/System/Python.app"],
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
            ])
            # open_ui=None on darwin (non-SSH) opens even when Terminal inherits FDA ("ok" everywhere)
            opened.clear()
            rc_auto = agent.setup_fda(
                open_ui=None,
                opener=lambda cmd, **kw: opened.append(cmd),
                dir_state=lambda p: "ok",
            )
            self.assertEqual(rc_auto, 0)
            self.assertEqual(opened, [
                ["open", "-R", "/System/Python.app"],
                ["open", "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"],
            ])
            # open_ui=False skips Finder + Settings
            opened.clear()
            rc_no_open = agent.setup_fda(
                open_ui=False,
                opener=lambda cmd, **kw: opened.append(cmd),
                dir_state=lambda p: "denied",
            )
            self.assertEqual(rc_no_open, 0)
            self.assertEqual(opened, [])


if __name__ == "__main__":
    unittest.main()
