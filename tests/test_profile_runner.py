"""Local runner safety tests; never use a model engine or the user's cache."""
from __future__ import annotations

import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / "agents/macos/profile_runner.py"
spec = importlib.util.spec_from_file_location("profile_runner", MODULE)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def process(pid, text, parent=1, name=None):
    return {"pid": pid, "ppid": parent, "uid": os.getuid(), "argvText": text,
            "argv": text.split(), "comm": Path(text.split()[0]).name,
            "script": "", "name": name}


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Backend:
    def __init__(self):
        self.procs = {}
        self.ports = {}
        self.known_ports = {8100, 8300}

    def processes(self):
        return copy.deepcopy(self.procs)

    def listeners(self):
        return copy.deepcopy(self.ports)

    def runtimes(self, procs):
        return [{"pid": pid, "name": row["name"], "detectedBy": "inventory"}
                for pid, row in procs.items() if row.get("name")]


class FakeProcess:
    def __init__(self, pid):
        self.pid = pid
        self.returncode = None

    def wait(self, timeout=None):
        self.returncode = 0
        return 0


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config_path = self.root / "profiles.json"
        self.cache = self.root / "cache"
        self.config = {"stop": [sys.executable, "-c", "print('stop')"], "profiles": {
            "target": {"argv": [sys.executable, "-c", "pass"], "port": 8100,
                       "model": "owner/exact", "requiredPaths": [str(self.root)],
                       "readyTimeout": 2, "warmup": False}}}
        self.write_config()
        self.backend = Backend()
        self.clock = Clock()
        self.calls = []
        self.signals = []
        self.stop_result = 0
        self.stop_effect = lambda: (self.backend.procs.clear(), self.backend.ports.clear())
        self.http = lambda port, path, **kw: {"data": [{"id": "owner/exact"}]}

    def write_config(self):
        self.config_path.write_text(json.dumps(self.config))
        self.config_path.chmod(0o600)

    def spawn(self, argv, **kwargs):
        self.calls.append((list(argv), kwargs))
        pid = 600 + len(self.calls)
        proc = FakeProcess(pid)
        self.backend.procs[pid] = process(pid, " ".join(argv))
        if argv == self.config["stop"]:
            self.stop_effect()
            proc.returncode = self.stop_result
        else:
            self.backend.ports[pid] = [{"port": 8100}]
        return proc

    def kill(self, pid, sig):
        self.signals.append((pid, sig))
        self.backend.procs.pop(pid, None)
        self.backend.ports.pop(pid, None)

    def make_runner(self):
        return runner.ProfileRunner(
            runner.load_profiles(self.config_path), self.backend,
            cache_dir=self.cache, clock=self.clock, sleep=self.clock.sleep,
            popen=self.spawn, request=lambda *a, **kw: self.http(*a, **kw),
            kill=self.kill, kill_group=lambda pid, sig: None,
        )

    def test_interrupt_during_health_cancels_without_retrying_and_cleans_new_tree(self):
        def interrupted(*args, **kwargs):
            raise runner.RunnerInterrupted("profile runner interrupted by signal 15")
        self.http = interrupted
        with self.assertRaisesRegex(runner.RunnerError, "interrupted"):
            self.make_runner().execute("start", "target")
        self.assertLess(self.clock.now, 1)
        self.assertEqual(self.backend.procs, {})

    def test_valid_start_uses_only_trusted_argv_detached_with_private_log(self):
        result = self.make_runner().execute("start", "target")
        self.assertEqual(result["model"], "owner/exact")
        self.assertEqual(len(self.calls), 2)
        argv, options = self.calls[-1]
        self.assertEqual(argv, self.config["profiles"]["target"]["argv"])
        self.assertTrue(options["start_new_session"])
        self.assertEqual(options["stdin"], subprocess.DEVNULL)
        self.assertNotEqual(options["stdout"], subprocess.PIPE)
        self.assertEqual(options["stderr"], subprocess.STDOUT)
        self.assertTrue(options["close_fds"])
        self.assertEqual(Path(result["log"]).stat().st_mode & 0o777, 0o600)

    def test_progress_is_flushed_and_does_not_include_private_arguments(self):
        with mock.patch("builtins.print") as output:
            self.make_runner().execute("start", "target")
        messages = [call.args[0] for call in output.call_args_list]
        self.assertEqual(messages, [
            "Stopping current runtime…", "Waiting for process and listener release…",
            "Heavy-engine slot released.", "Starting selected profile…",
            "Waiting for exact-model readiness…", "Selected model is ready.",
        ])
        self.assertTrue(all(call.kwargs.get("flush") is True for call in output.call_args_list))
        self.assertNotIn(str(self.root), "\n".join(messages))

    def test_stop_progress_does_not_report_starting_or_readiness(self):
        with mock.patch("builtins.print") as output:
            self.make_runner().execute("stop", "target")
        self.assertEqual([call.args[0] for call in output.call_args_list], [
            "Stopping current runtime…", "Waiting for process and listener release…",
            "Heavy-engine slot released.",
        ])

    def test_unknown_profile_is_exact_and_never_stops(self):
        for name in ("target ", "TARGET", "target; touch /tmp/no"):
            with self.assertRaisesRegex(runner.RunnerError, "unknown profile"):
                self.make_runner().execute("start", name)
        self.assertEqual(self.calls, [])

    def test_root_denied_before_any_command(self):
        with mock.patch.object(runner.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(runner.RunnerError, "root"):
                runner.load_profiles(self.config_path)
        self.assertEqual(self.calls, [])

    def test_config_rejects_symlink_directory_fifo_permissions_and_owner(self):
        link = self.root / "link"
        link.symlink_to(self.config_path)
        fifo = self.root / "fifo"
        os.mkfifo(fifo, 0o600)
        for path in (link, self.root, fifo):
            with self.subTest(path=path), self.assertRaises(runner.RunnerError):
                runner.load_profiles(path)
        self.config_path.chmod(0o640)
        with self.assertRaisesRegex(runner.RunnerError, "0600"):
            runner.load_profiles(self.config_path)
        self.config_path.chmod(0o600)
        foreign_uid = os.getuid() + 1
        with mock.patch.object(runner.os, "getuid", return_value=foreign_uid), \
             mock.patch.object(runner.os, "geteuid", return_value=foreign_uid):
            with self.assertRaisesRegex(runner.RunnerError, "owner"):
                runner.load_profiles(self.config_path)

    def test_invalid_profiles_and_missing_files_do_not_stop_current_model(self):
        cases = [{"argv": ["relative"]}, {"argv": ["/does/not/exist"]},
                 {"requiredPaths": ["/not/cached"]}, {"port": True}, {"port": 0},
                 {"model": ""}, {"readyTimeout": float("nan")},
                 {"readyTimeout": 301}, {"warmup": "true"},
                 {"requiredPaths": ["relative"]}]
        cases.extend([{"port": 8200}, {"port": 8400}, {"apiKeyFile": "relative"}])
        for changes in cases:
            with self.subTest(changes=changes):
                cfg = copy.deepcopy(self.config)
                cfg["profiles"]["target"].update(changes)
                self.config_path.write_text(json.dumps(cfg))
                with self.assertRaises(runner.RunnerError):
                    self.make_runner().execute("start", "target")
        self.assertEqual(self.calls, [])

    def test_stop_failure_prevents_start(self):
        self.stop_result = 7
        with self.assertRaisesRegex(runner.RunnerError, "stop.*7"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 1)

    def test_stop_still_works_after_model_paths_or_start_executable_disappear(self):
        self.config["profiles"]["target"].update(
            argv=["/no/longer/installed"], requiredPaths=["/no/longer/cached"],
            apiKeyFile=str(self.root / "missing-key"))
        self.write_config()
        self.make_runner().execute("stop", "target")
        self.assertEqual(len(self.calls), 1)

    def test_api_key_file_is_private_and_only_used_for_local_health(self):
        key_path = self.root / "key"
        key_path.write_text("private-key\n")
        key_path.chmod(0o600)
        self.config["profiles"]["target"].update(apiKeyFile=str(key_path), warmup=True)
        self.write_config()
        requests = []
        def request(port, path, **kwargs):
            requests.append(kwargs)
            return ({"choices": [{}]} if path.endswith("completions") else
                    {"data": [{"id": "owner/exact"}]})
        self.http = request
        result = self.make_runner().execute("start", "target")
        self.assertEqual([kw["api_key"] for kw in requests], ["private-key", "private-key"])
        self.assertNotIn("private-key", json.dumps(result))
        self.assertNotIn("private-key", Path(result["log"]).read_text())
        self.assertNotIn("private-key", repr(self.calls))
        self.assertEqual(key_path.read_text(), "private-key\n")

    def test_insecure_missing_or_malformed_key_file_prevents_stop_on_start(self):
        key_path = self.root / "key"
        self.config["profiles"]["target"]["apiKeyFile"] = str(key_path)
        self.write_config()
        for content, mode in (("secret", 0o644), ("", 0o600), ("a\nb", 0o600)):
            key_path.write_text(content)
            key_path.chmod(mode)
            with self.assertRaises(runner.RunnerError):
                self.make_runner().execute("start", "target")
        key_path.unlink()
        key_path.symlink_to(self.config_path)
        with self.assertRaises(runner.RunnerError):
            self.make_runner().execute("start", "target")
        self.assertEqual(self.calls, [])

    def test_stop_waits_for_snapshot_descendants_after_parent_disappears(self):
        self.backend.procs = {10: process(10, "heavy", name="tensorfold"),
                              11: process(11, "gpu child", 10),
                              12: process(12, "gpu grandchild", 11)}
        self.stop_effect = lambda: self.backend.procs.pop(10)
        with self.assertRaisesRegex(runner.RunnerError, "stop.*(11|12)"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.signals, [])

    def test_changed_argv_is_not_proof_of_death_and_never_authorizes_a_signal(self):
        self.backend.procs[10] = process(10, "heavy", name="tensorfold")
        self.stop_effect = lambda: self.backend.procs.update({10: process(10, "unrelated")})
        with self.assertRaisesRegex(runner.RunnerError, "stop did not empty"):
            self.make_runner().execute("stop", "target")
        self.assertEqual(self.signals, [])

    def test_known_native_owner_stops_after_successful_noop_helper_before_start(self):
        self.backend.procs[10] = process(10, "omlx-server", name="omlx")
        self.backend.ports[10] = [{"port": 8000, "address": "127.0.0.1:8000"}]
        self.backend.known_ports.add(8000)
        self.stop_effect = lambda: None
        original_kill = self.kill
        def kill(pid, sig):
            self.assertEqual(len(self.calls), 1, "new engine must wait for old owner death")
            original_kill(pid, sig)
        instance = self.make_runner()
        instance.kill = kill
        self.assertTrue(instance.execute("start", "target")["ok"])
        self.assertEqual(self.signals, [(10, signal.SIGTERM)])
        self.assertEqual(len(self.calls), 2)

    def test_known_owner_ignoring_term_gets_bounded_kill(self):
        self.backend.procs[10] = process(10, "omlx-server", name="omlx")
        self.stop_effect = lambda: None
        instance = self.make_runner()
        def kill(pid, sig):
            self.signals.append((pid, sig))
            if sig == signal.SIGKILL:
                self.backend.procs.pop(pid)
        instance.kill = kill
        instance.execute("stop", "target")
        self.assertEqual(self.signals, [(10, signal.SIGTERM), (10, signal.SIGKILL)])
        self.assertGreaterEqual(self.clock.now, 5)
        self.assertLess(self.clock.now, 90)

    def test_fallback_never_signals_other_users_or_unproven_inventory_matches(self):
        for ownership in ("other-user", "listener-only"):
            with self.subTest(ownership=ownership):
                self.backend.procs[10] = process(10, "omlx-server", name="omlx")
                if ownership == "other-user":
                    self.backend.procs[10]["uid"] = os.getuid() + 1
                else:
                    self.backend.runtimes = lambda procs: [
                        {"pid": 10, "name": "omlx", "detectedBy": "listener"}]
                self.stop_effect = lambda: None
                with self.assertRaisesRegex(runner.RunnerError, "stop"):
                    self.make_runner().execute("start", "target")
        self.assertEqual(self.signals, [])

    def test_fallback_rechecks_identity_and_uid_immediately_before_each_signal(self):
        for changed in ("argvText", "uid"):
            with self.subTest(changed=changed):
                self.backend.procs = {10: process(10, "omlx-server", name="omlx")}
                self.stop_effect = lambda: None
                instance = self.make_runner()
                original = self.backend.processes
                calls = []
                def processes():
                    calls.append(1)
                    # Snapshot1 before the helper; snapshot2 after it; the
                    # immediate pre-signal check must catch replacement here.
                    if len(calls) == 3:
                        self.backend.procs[10][changed] = (
                            "replacement" if changed == "argvText" else os.getuid() + 1)
                    return original()
                self.backend.processes = processes
                with self.assertRaisesRegex(runner.RunnerError, "stop"):
                    instance.execute("stop", "target")
                self.backend.processes = original
        self.assertEqual(self.signals, [])

    def test_fallback_never_signals_original_owner_after_pid_reuse_before_kill(self):
        self.backend.procs[10] = process(10, "omlx-server", name="omlx")
        self.stop_effect = lambda: None
        instance = self.make_runner()
        def kill(pid, sig):
            self.signals.append((pid, sig))
            self.backend.procs[pid] = process(pid, "unrelated replacement")
        instance.kill = kill
        with self.assertRaisesRegex(runner.RunnerError, "stop did not empty"):
            instance.execute("stop", "target")
        self.assertEqual(self.signals, [(10, signal.SIGTERM)])

    def test_fallback_does_not_signal_before_helper_succeeds(self):
        self.backend.procs[10] = process(10, "omlx-server", name="omlx")
        self.stop_effect = lambda: None
        self.stop_result = 7
        with self.assertRaisesRegex(runner.RunnerError, "stop.*7"):
            self.make_runner().execute("start", "target")
        self.assertEqual(self.signals, [])

    def test_fallback_root_death_does_not_hide_surviving_gpu_descendant(self):
        self.backend.procs = {10: process(10, "omlx-server", name="omlx"),
                              11: process(11, "gpu child", 10)}
        self.stop_effect = lambda: None
        with self.assertRaisesRegex(runner.RunnerError, "stop.*11"):
            self.make_runner().execute("start", "target")
        self.assertEqual(self.signals, [(10, signal.SIGTERM)])
        self.assertEqual(len(self.calls), 1)

    def test_new_heavy_runtime_after_stop_blocks_start(self):
        self.stop_effect = lambda: self.backend.procs.update(
            {20: process(20, "new engine", name="tensorfold")})
        with self.assertRaisesRegex(runner.RunnerError, "stop"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 1)

    def test_unknown_listener_on_known_port_blocks_start_without_killing(self):
        self.backend.procs[99] = process(99, "unknown server")
        self.backend.ports[99] = [{"port": 8100}]
        self.stop_effect = lambda: None
        with self.assertRaisesRegex(runner.RunnerError, "(listener|port).*8100"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.signals, [])

    def test_tailnet_broker_does_not_block_empty_loopback_slot(self):
        self.backend.procs[1500] = process(1500, "/Applications/Tailscale/IPNExtension")
        self.backend.ports[1500] = [
            {"port": port, "address": f"100.84.116.98:{port}"}
            for port in (8000, 11234, 8100, 8300)]
        self.stop_effect = lambda: None
        self.make_runner().execute("start", "target")
        self.assertIn(1500, self.backend.procs)
        self.assertNotIn(1500, {pid for pid, sig in self.signals})

    def test_unknown_loopback_and_wildcard_listeners_block_slot(self):
        for address in ("127.0.0.1:8100", "127.0.0.2:8100", "*:8100",
                        "0.0.0.0:8100", "[::]:8100", "[::1]:8100",
                        "[::ffff:127.0.0.1]:8100", "unparseable:8100"):
            with self.subTest(address=address):
                self.backend.procs[1500] = process(1500, "unknown listener")
                self.backend.ports[1500] = [{"port": 8100, "address": address}]
                self.stop_effect = lambda: None
                with self.assertRaisesRegex(runner.RunnerError, "(listener|port).*8100"):
                    self.make_runner().execute("start", "target")
        self.assertEqual(self.signals, [])

    def test_mux_and_unrelated_listener_are_not_heavy(self):
        self.backend.procs = {90: process(90, "mux", name="mtplx-mux"),
                              91: process(91, "other server", name="other-runtime")}
        self.backend.ports = {90: [{"port": 8200}], 91: [{"port": 5555}]}
        self.stop_effect = lambda: None
        self.make_runner().execute("stop", "target")
        self.assertEqual(self.signals, [])

    def test_dedicated_bonsai_and_mux_ports_are_excluded(self):
        self.backend.known_ports.update({8200, 8400})
        self.backend.procs = {90: process(90, "mux", name="mtplx-mux"),
                              92: process(92, "bonsai", name="bonsai")}
        self.backend.ports = {90: [{"port": 8200}], 92: [{"port": 8400}]}
        self.stop_effect = lambda: None
        self.make_runner().execute("stop", "target")
        self.assertEqual(self.signals, [])

    def test_other_runtime_on_profile_port_is_not_ignored(self):
        self.backend.procs[91] = process(91, "other", name="other-runtime")
        self.backend.ports[91] = [{"port": 8100}]
        self.stop_effect = lambda: self.backend.ports.clear()
        with self.assertRaisesRegex(runner.RunnerError, "stop.*91"):
            self.make_runner().execute("stop", "target")

    def test_probe_failure_fails_closed_before_stop(self):
        self.backend.processes = mock.Mock(side_effect=runner.RunnerError("ps failed"))
        with self.assertRaisesRegex(runner.RunnerError, "ps failed"):
            self.make_runner().execute("start", "target")
        self.assertEqual(self.calls, [])

    def test_readiness_retries_transient_ps_timeout_during_cold_load(self):
        original = self.backend.processes
        failures = []
        def processes():
            if 602 in self.backend.procs and not failures:
                failures.append(1)
                self.clock.sleep(0.5)
                raise runner.ProbeError("ps timed out during cold load")
            return original()
        self.backend.processes = processes
        result = self.make_runner().execute("start", "target")
        self.assertTrue(result["ok"])
        self.assertEqual(failures, [1])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(self.signals, [])

    def test_readiness_probe_failure_never_counts_as_empty_or_healthy(self):
        instance = self.make_runner()
        instance._check_start_ownership = mock.Mock(side_effect=runner.ProbeError("ps unavailable"))
        with self.assertRaisesRegex(runner.RunnerError, "ps unavailable"):
            instance.execute("start", "target")
        self.assertNotIn(602, self.backend.procs)
        self.assertEqual(len(self.calls), 2)

    def test_readiness_from_foreign_listener_does_not_count_as_our_start(self):
        def request(*args, **kwargs):
            self.backend.procs[77] = process(77, "foreign listener")
            self.backend.ports = {77: [{"port": 8100}]}
            return {"data": [{"id": "owner/exact"}]}
        self.http = request
        with self.assertRaisesRegex(runner.RunnerError, "(owner|listener)"):
            self.make_runner().execute("start", "target")
        self.assertIn(77, self.backend.procs)
        self.assertNotIn(77, {pid for pid, sig in self.signals})

    def test_wrong_model_health_times_out_and_cleans_only_new_tree(self):
        self.http = lambda *a, **kw: {"data": [{"id": "owner/exact-more"}]}
        self.backend.procs[42] = process(42, "unrelated")
        self.stop_effect = lambda: None
        with self.assertRaisesRegex(runner.RunnerError, "owner/exact"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 2)
        self.assertIn(42, self.backend.procs)
        self.assertEqual(set(pid for pid, sig in self.signals), {602})
        self.assertNotIn(602, self.backend.procs)

    def test_warmup_sends_selected_model_and_one_token(self):
        self.config["profiles"]["target"]["warmup"] = True
        self.write_config()
        requests = []
        def request(port, path, **kwargs):
            requests.append((port, path, kwargs))
            if path == "/v1/models":
                return {"data": [{"id": "other"}, {"id": "owner/exact"}]}
            return {"model": "owner/exact", "choices": [{"message": {"content": "x"}}]}
        self.http = request
        self.make_runner().execute("start", "target")
        self.assertEqual([p for _, p, _ in requests], ["/v1/models", "/v1/chat/completions"])
        body = requests[-1][2]["body"]
        self.assertEqual(body["model"], "owner/exact")
        self.assertEqual(body["max_tokens"], 1)

    def test_failed_warmup_cleans_start_and_never_restores(self):
        self.config["profiles"]["target"]["warmup"] = True
        self.write_config()
        def request(port, path, **kwargs):
            if path.endswith("completions"):
                raise OSError("load failed")
            return {"data": [{"id": "owner/exact"}]}
        self.http = request
        with self.assertRaisesRegex(runner.RunnerError, "(warmup|load failed)"):
            self.make_runner().execute("start", "target")
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn(602, self.backend.procs)

    def test_one_lock_spans_wrappers_and_different_configs(self):
        first = self.make_runner()
        second = self.make_runner()
        with first.lock():
            with self.assertRaisesRegex(runner.RunnerError, "busy"):
                second.execute("start", "target")
            script = ("import importlib.util,sys,pathlib; "
                      "s=importlib.util.spec_from_file_location('r',sys.argv[1]); "
                      "m=importlib.util.module_from_spec(s);s.loader.exec_module(m); "
                      "r=m.ProfileRunner({},None,cache_dir=pathlib.Path(sys.argv[2])); "
                      "r.lock().__enter__()")
            child = subprocess.run([sys.executable, "-c", script, str(MODULE), str(self.cache)],
                                   capture_output=True, text=True, timeout=5)
            self.assertNotEqual(child.returncode, 0)
            self.assertIn("busy", child.stderr)
        self.assertEqual(self.calls, [])
        second.execute("stop", "target")

    def test_unsafe_cache_or_lock_symlink_is_rejected(self):
        self.cache.mkdir(mode=0o700)
        (self.cache / "runner.lock").symlink_to(self.config_path)
        with self.assertRaises(runner.RunnerError):
            self.make_runner().execute("stop", "target")
        self.assertEqual(self.calls, [])

    def test_stop_timeout_cleans_only_the_stop_command_tree_and_never_starts(self):
        class HungProcess(FakeProcess):
            def wait(proc, timeout=None):
                if proc.pid not in self.backend.procs:
                    proc.returncode = -signal.SIGTERM
                    return proc.returncode
                self.clock.sleep(timeout)
                raise subprocess.TimeoutExpired("stop", timeout)
        def spawn(argv, **kwargs):
            self.calls.append((argv, kwargs))
            self.backend.procs[601] = process(601, "stop command")
            self.backend.procs[602] = process(602, "stop helper", 601)
            return HungProcess(601)
        self.backend.procs[42] = process(42, "original heavy", name="tensorfold")
        instance = self.make_runner()
        instance.popen = spawn
        with self.assertRaisesRegex(runner.RunnerError, "stop.*timed out"):
            instance.execute("start", "target")
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(set(self.backend.procs), {42})
        self.assertEqual({pid for pid, sig in self.signals}, {601, 602})

    def test_cleanup_tracks_children_recursively_even_after_reparenting(self):
        self.backend.procs = {600: process(600, "started"),
                              601: process(601, "child", 600),
                              602: process(602, "gpu grandchild", 601),
                              42: process(42, "unrelated")}
        instance = self.make_runner()
        child = FakeProcess(600)
        identities = {}
        instance._track_owned(child, identities)
        self.backend.procs.pop(600)
        self.backend.procs[601]["ppid"] = 1
        instance._cleanup(child, identities)
        self.assertEqual(set(self.backend.procs), {42})
        self.assertEqual({pid for pid, sig in self.signals}, {601, 602})

    def test_cleanup_escalates_to_kill_and_proves_death(self):
        self.backend.procs[600] = process(600, "started")
        instance = self.make_runner()
        def kill(pid, sig):
            self.signals.append((pid, sig))
            if sig == signal.SIGKILL:
                self.backend.procs.pop(pid, None)
        instance.kill = kill
        instance._cleanup(FakeProcess(600), {})
        self.assertEqual(self.signals, [(600, signal.SIGTERM), (600, signal.SIGKILL)])
        self.assertEqual(self.backend.procs, {})

    def test_already_exited_child_is_reaped_without_signaling_its_dead_group(self):
        instance = self.make_runner()
        instance.kill_group = lambda *args: self.fail("dead group must not be signaled")
        instance._cleanup(FakeProcess(600), {})

    def test_group_discovery_skips_uninspectable_unrelated_user_process(self):
        backend = runner.MacBackend.__new__(runner.MacBackend)
        def group(pid):
            if pid == 42:
                raise PermissionError("protected unrelated process")
            return 600
        with mock.patch.object(runner.os, "getpgid", side_effect=group):
            self.assertEqual(backend.group_members(600, {
                42: process(42, "protected"), 601: process(601, "model child")}), [601])

    def test_cleanup_reused_descendant_pid_is_never_signaled(self):
        self.backend.procs[600] = process(600, "started")
        self.backend.procs[601] = process(601, "unrelated replacement")
        instance = self.make_runner()
        with self.assertRaisesRegex(runner.RunnerError, "could not prove process death"):
            instance._cleanup(FakeProcess(600), {601: "old gpu child"})
        self.assertEqual({pid for pid, sig in self.signals}, {600})
        self.assertIn(601, self.backend.procs)

    def test_cleanup_probe_timeout_still_kills_owned_session_and_allows_slow_reap(self):
        self.backend.procs = {600: process(600, "started"),
                              601: process(601, "gpu child", 600),
                              42: process(42, "unrelated")}
        original = self.backend.processes
        attempts = []
        def processes():
            attempts.append(1)
            if len(attempts) == 1:
                raise runner.ProbeError("ps timed out")
            return original()
        self.backend.processes = processes
        instance = self.make_runner()
        def kill_group(pid, sig):
            self.signals.append((pid, sig))
            for owned in (600, 601):
                self.backend.procs.pop(owned, None)
        instance.kill_group = kill_group
        proc = FakeProcess(600)
        wait_timeouts = []
        def wait(timeout):
            wait_timeouts.append(timeout)
            if timeout < 2:
                raise subprocess.TimeoutExpired("started", timeout)
            self.clock.sleep(2)
            proc.returncode = -signal.SIGKILL
            return proc.returncode
        proc.wait = wait
        instance._cleanup(proc, {600: "started", 601: "gpu child"})
        self.assertEqual(self.signals, [(600, signal.SIGKILL)])
        self.assertEqual(wait_timeouts[0], 15)
        self.assertEqual(set(self.backend.procs), {42})

    def test_unverifiable_cleanup_reports_failure_after_killing_owned_session(self):
        instance = self.make_runner()
        self.backend.processes = mock.Mock(side_effect=runner.ProbeError("ps unavailable"))
        instance.kill_group = mock.Mock()
        with mock.patch.object(runner.os, "killpg"), mock.patch.object(runner.os, "kill"):
            with self.assertRaisesRegex(runner.RunnerError, "death could not be verified"):
                instance._cleanup(FakeProcess(600), {601: "gpu child"})
        instance.kill_group.assert_called_once_with(600, signal.SIGKILL)

    def test_real_cleanup_reaps_parent_and_terminates_child_in_separate_session(self):
        inventory = self.root / "inventory.json"
        inventory.write_text('{"runtimes": []}')
        backend = runner.MacBackend(inventory)
        ready = self.root / "ready"
        script = (
            "import subprocess,sys,signal,time,pathlib\n"
            "child=subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)'],"
            "start_new_session=True)\n"
            "def stop(*args):\n"
            " child.wait(timeout=5)\n"
            " sys.exit(0)\n"
            "signal.signal(signal.SIGTERM,stop)\n"
            "pathlib.Path(sys.argv[1]).write_text(str(child.pid))\n"
            "time.sleep(60)\n")
        proc = subprocess.Popen([sys.executable, "-c", script, str(ready)],
                                start_new_session=True, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child_pid = None
        try:
            deadline = time.monotonic() + 5
            while not ready.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready.exists(), "test subprocess did not initialize")
            child_pid = int(ready.read_text())
            instance = runner.ProfileRunner(self.config, backend, cache_dir=self.cache)
            identities = {}
            instance._track_owned(proc, identities)
            self.assertIn(child_pid, identities)
            instance._cleanup(proc, identities)
            self.assertIsNotNone(proc.returncode)
            self.assertNotIn(child_pid, backend.processes())
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
        finally:
            for pid in (child_pid, proc.pid):
                if pid:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            proc.wait(timeout=2)


class BackendTests(unittest.TestCase):
    def test_process_probes_allow_fifteen_seconds_and_lsof_failure_is_not_empty(self):
        proc = mock.Mock(returncode=0)
        proc.communicate.return_value = ("output", "")
        with mock.patch.object(runner.subprocess, "Popen", return_value=proc):
            self.assertEqual(runner._strict_probe(["ps", "-Ao", "args="], timeout=3), "output")
        proc.communicate.assert_called_once_with(timeout=15)
        proc.returncode = 1
        proc.communicate.return_value = ("", "lsof permission denied")
        with mock.patch.object(runner.subprocess, "Popen", return_value=proc):
            with self.assertRaisesRegex(runner.ProbeError, "permission denied"):
                runner._strict_probe(["lsof"], timeout=4)
        proc.communicate.return_value = ("", "")
        with mock.patch.object(runner.subprocess, "Popen", return_value=proc):
            self.assertEqual(runner._strict_probe(["lsof"], timeout=4), "")

    def test_nonlistening_engine_is_detected_without_health_or_protected_ports(self):
        with tempfile.TemporaryDirectory() as directory:
            inventory = Path(directory) / "inventory.json"
            inventory.write_text(json.dumps({"runtimes": [
                {"name": "engine", "ports": [8100], "argvAll": ["heavy-engine"]},
                {"name": "bonsai", "ports": [8400], "argvAll": ["bonsai"]},
                {"name": "mtplx-mux", "ports": [8200], "argvAll": ["mux"]}]}))
            backend = runner.MacBackend(inventory)
            with mock.patch.object(backend.agent, "health_check", side_effect=AssertionError("no HTTP")):
                found = backend.runtimes({10: process(10, "heavy-engine loading")})
            self.assertEqual([row["name"] for row in found], ["engine"])
            self.assertEqual(backend.known_ports, {8100})


class HttpTests(unittest.TestCase):
    def test_real_local_http_and_redirect_refusal_without_proxy(self):
        requests = []
        headers = []
        redirect = [False]
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                headers.append(self.headers.get("Authorization"))
                if not redirect[0]:
                    data = json.dumps({"data": [{"id": "exact"}]}).encode()
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(data)
                else:
                    self.send_response(302)
                    self.send_header("Location", "http://example.invalid/")
                    self.end_headers()
            def do_POST(self):
                headers.append(self.headers.get("Authorization"))
                requests.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"choices":[{}]}')
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_port
            with mock.patch.dict(os.environ, {"http_proxy": "http://invalid:1", "no_proxy": ""}):
                self.assertEqual(runner.request_json(port, "/v1/models", timeout=1,
                                                     api_key="test-key")["data"][0]["id"], "exact")
                runner.request_json(port, "/v1/chat/completions", timeout=1,
                                    body={"model": "exact"}, api_key="test-key")
                redirect[0] = True
                with self.assertRaises(urllib.error.HTTPError):
                    runner.request_json(port, "/v1/models", timeout=1, api_key="test-key")
            self.assertEqual(requests, [{"model": "exact"}])
            self.assertEqual(headers, ["Bearer test-key"] * 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
