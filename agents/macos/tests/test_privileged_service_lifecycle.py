import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parents[1]
LABEL = "ai.onyx.sparkdash-mac-agent.privileged"
TARGET = f"system/{LABEL}"
PLIST = f"/Library/LaunchDaemons/{LABEL}.plist"

SUDO_STUB = r'''
import json
import os
import sys
from pathlib import Path

root = Path(os.environ["SERVICE_TEST_DIR"])
scenario = json.loads(os.environ["SERVICE_TEST_SCENARIO"])
args = sys.argv[1:]
with (root / "calls.jsonl").open("a") as log:
    log.write(json.dumps(args) + "\n")
if args == ["-v"]:
    sys.exit(scenario.get("auth", 0))
if args and args[0] == "-n":
    args = args[1:]
if args[:2] == ["launchctl", "print"]:
    counter = root / "print-count"
    index = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(index + 1))
    result = scenario["prints"][index]
    if result == "loaded":
        print(args[2] + " = { pid = 123; }")
        sys.exit(0)
    if result in ("absent", "other-service"):
        label = args[2].split("/", 1)[1] if result == "absent" else "unrelated.service"
        print('Bad request.\nCould not find service "' + label + '" in domain for system', file=sys.stderr)
        sys.exit(113)
    print("inspection denied", file=sys.stderr)
    sys.exit(113 if result == "unknown113" else 1)
if args and args[0] == "launchctl":
    sys.exit(scenario.get(args[1], 0))
if args and args[0] in ("/usr/bin/python3", "rm"):
    sys.exit(0)
sys.exit(99)
'''


class PrivilegedLifecycleTests(unittest.TestCase):
    def run_script(self, name, **scenario):
        with tempfile.TemporaryDirectory(dir=HERE / "tests") as directory:
            root = Path(directory)
            sudo = root / "sudo"
            sudo.write_text(f"#!{sys.executable}\n" + SUDO_STUB)
            sudo.chmod(0o755)
            env = {
                **os.environ,
                "PATH": str(root) + os.pathsep + os.environ["PATH"],
                "TMPDIR": str(root),
                "SERVICE_TEST_DIR": str(root),
                "SERVICE_TEST_SCENARIO": json.dumps(scenario),
            }
            result = subprocess.run(
                ["sh", str(HERE / name)], env=env, capture_output=True, text=True, timeout=10,
            )
            log = root / "calls.jsonl"
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
            return result, calls

    def test_authentication_failure_stops_both_scripts_before_inspection(self):
        for name in ("install-privileged-collector.sh", "uninstall-privileged-collector.sh"):
            with self.subTest(script=name):
                result, calls = self.run_script(name, auth=1, prints=[])
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(calls, [["-v"]])
                self.assertNotIn("Privileged collector removed", result.stdout)
                self.assertNotIn("Privileged collector is on", result.stdout)

    def test_unknown_inspection_failures_stop_before_any_privileged_changes(self):
        for name in ("install-privileged-collector.sh", "uninstall-privileged-collector.sh"):
            for result_kind in ("error", "unknown113", "other-service"):
                with self.subTest(script=name, result=result_kind):
                    result, calls = self.run_script(name, prints=[result_kind])
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(calls, [["-v"], ["-n", "launchctl", "print", TARGET]])
                    self.assertIn("Cannot inspect", result.stderr)
                    self.assertNotIn("Privileged collector removed", result.stdout)
                    self.assertNotIn("Privileged collector is on", result.stdout)

    def test_uninstall_deletes_only_after_explicit_absence(self):
        for initially_loaded in (True, False):
            with self.subTest(loaded=initially_loaded):
                result, calls = self.run_script(
                    "uninstall-privileged-collector.sh", prints=["loaded" if initially_loaded else "absent", "absent"],
                )
                expected = [["-v"], ["-n", "launchctl", "print", TARGET]]
                if initially_loaded:
                    expected.append(["-n", "launchctl", "bootout", TARGET])
                expected += [["-n", "launchctl", "print", TARGET], ["-n", "rm", "-f", PLIST]]
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls, expected)
                self.assertIn("Privileged collector removed", result.stdout)

    def test_uninstall_preserves_plist_when_deactivation_or_confirmation_fails(self):
        for scenario in (
            {"prints": ["loaded"], "bootout": 1},
            {"prints": ["loaded", "loaded"]},
            {"prints": ["loaded", "error"]},
            {"prints": ["loaded", "unknown113"]},
            {"prints": ["absent", "error"]},
        ):
            with self.subTest(scenario=scenario):
                result, calls = self.run_script("uninstall-privileged-collector.sh", **scenario)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(["-n", "rm", "-f", PLIST], calls)
                self.assertNotIn("Privileged collector removed", result.stdout)

    def test_install_replaces_only_a_confirmed_loaded_service(self):
        for initially_loaded in (True, False):
            with self.subTest(loaded=initially_loaded):
                result, calls = self.run_script(
                    "install-privileged-collector.sh", prints=["loaded" if initially_loaded else "absent", "loaded"],
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(calls[:2], [["-v"], ["-n", "launchctl", "print", TARGET]])
                self.assertEqual(calls[2][:2], ["-n", "/usr/bin/python3"])
                lifecycle = calls[3:]
                expected = [["-n", "launchctl", "bootout", TARGET]] if initially_loaded else []
                expected += [
                    ["-n", "launchctl", "enable", TARGET],
                    ["-n", "launchctl", "bootstrap", "system", PLIST],
                    ["-n", "launchctl", "kickstart", "-k", TARGET],
                    ["-n", "launchctl", "print", TARGET],
                ]
                self.assertEqual(lifecycle, expected)
                self.assertIn("Privileged collector is on", result.stdout)

    def test_install_never_reports_success_after_bootout_or_bootstrap_failure(self):
        for action in ("bootout", "bootstrap"):
            with self.subTest(action=action):
                result, calls = self.run_script("install-privileged-collector.sh", prints=["loaded"], **{action: 1})
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Privileged collector is on", result.stdout)
                self.assertEqual(calls[-1][1:3], ["launchctl", action])


if __name__ == "__main__":
    unittest.main()
