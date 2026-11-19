"""The shipped launchd templates and the documented install line are loadable.

`plutil` accepts an XML comment containing a double hyphen, `plistlib` does not.
A template only `plutil` can read breaks the privileged install, because
`privileged_collector_install.py` parses that template with `plistlib`. The
install one-liner is asserted from the README text itself, so the documented
substitutions cannot drift from what is checked here.
"""

import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parents[1]
README = AGENT_DIR / "README.md"
USER_AGENT_TEMPLATE = AGENT_DIR / "ai.onyx.sparkdash-mac-agent.plist"
PRIVILEGED_TEMPLATE = AGENT_DIR / "ai.onyx.sparkdash-mac-agent.privileged.plist"
INSTALL_DIR = Path("/Library/Application Support/ai.onyx.sparkdash-mac-agent")


class LaunchdTemplates(unittest.TestCase):
    def test_every_template_parses_as_strict_xml(self):
        templates = sorted(AGENT_DIR.glob("*.plist"))
        self.assertTrue(templates, "no launchd templates next to the agent")
        for template in templates:
            with self.subTest(template=template.name):
                plistlib.loads(template.read_bytes())

    def test_privileged_installer_reads_its_own_template(self):
        sys.path.insert(0, str(AGENT_DIR))
        try:
            import privileged_collector_install as helper
            built = plistlib.loads(helper.build_plist(PRIVILEGED_TEMPLATE, INSTALL_DIR))
        finally:
            sys.path.remove(str(AGENT_DIR))
        program = built["ProgramArguments"]
        self.assertEqual(program[2], str(INSTALL_DIR / "sparkdash_mac_agent.py"))
        self.assertEqual(program[-1], str(INSTALL_DIR / "runtimes.json"))

    def test_documented_install_command_resolves_every_path(self):
        documented = re.search(r'^sed "(s\|/Users/PLACEHOLDER[^"]*)"', README.read_text(), re.M)
        self.assertIsNotNone(documented, "the README no longer carries the one-line install")
        # Matched loosely on purpose: whatever order the README documents, the
        # installed plist must end up with real paths rather than nested ones.
        home = Path(tempfile.mkdtemp()).resolve()  # macOS: $PWD resolves /var to /private/var
        checkout = home / "sparkDash"
        (checkout / "agents" / "macos").mkdir(parents=True)
        try:
            subprocess.run(
                ["/bin/sh", "-c",
                 f'sed "{documented.group(1)}" "{USER_AGENT_TEMPLATE}" > installed.plist'],
                cwd=checkout, env={"HOME": str(home), "PATH": "/bin:/usr/bin"}, check=True,
            )
            installed = plistlib.loads((checkout / "installed.plist").read_bytes())
        finally:
            shutil.rmtree(home, ignore_errors=True)
        # A doubled path is the failure this guards: the checkout substitution
        # must run before the home one, or the program lands inside $HOME twice.
        self.assertEqual(installed["ProgramArguments"][1],
                         str(checkout / "agents" / "macos" / "sparkdash_mac_agent.py"))
        self.assertEqual(installed["EnvironmentVariables"]["HOME"], str(home))
        self.assertEqual(installed["StandardOutPath"],
                         str(home / "Library" / "Logs" / "sparkdash-mac-agent.out.log"))


if __name__ == "__main__":
    unittest.main()
