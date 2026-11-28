"""Tests for setup.py: python3 -m unittest mods/usage-eta/skills/usage-eta-setup/test_setup.py"""
import os, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.path.join(HERE, "setup.py")
BEGIN = "<!-- usage-eta:begin (managed by the usage-eta plugin; run /usage-eta-setup to update) -->"
END = "<!-- usage-eta:end -->"


def run(path, *args):
    return subprocess.run([sys.executable, SETUP, "--file", path, *args], capture_output=True, text=True)


class SetupTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "CLAUDE.md")

    def put(self, text):
        with open(self.path, "w", encoding="utf-8", newline="") as f:
            f.write(text)

    def get(self):
        with open(self.path, encoding="utf-8", newline="") as f:
            return f.read()

    def test_adds_once_and_is_idempotent(self):
        self.put("# Mine\n\nrule one\n")
        self.assertEqual(run(self.path).returncode, 0)
        once = self.get()
        self.assertEqual(once.count(BEGIN), 1)
        self.assertTrue(once.startswith("# Mine\n\nrule one\n"))
        self.assertIn("already up to date", run(self.path).stdout)
        self.assertEqual(self.get(), once)

    def test_remove_restores_the_original_text(self):
        original = "# Mine\n\nrule one\n"
        self.put(original)
        run(self.path)
        self.assertEqual(run(self.path, "--remove").returncode, 0)
        self.assertEqual(self.get().rstrip("\n"), original.rstrip("\n"))

    def test_lone_end_marker_is_refused_and_nothing_changes(self):
        text = f"before\n{END}\nafter\n"
        self.put(text)
        r = run(self.path)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.get(), text)

    def test_begin_without_end_never_deletes_the_text_after_it(self):
        text = f"before\n{BEGIN}\nmy own rules\nmore of mine\n"
        self.put(text)
        self.assertEqual(run(self.path).returncode, 2)
        self.assertEqual(run(self.path, "--remove").returncode, 2)
        self.assertEqual(self.get(), text)

    def test_reversed_and_repeated_markers_are_refused(self):
        for text in (f"{END}\n{BEGIN}\n", f"{BEGIN}\nx\n{END}\n{BEGIN}\ny\n{END}\n"):
            self.put(text)
            self.assertEqual(run(self.path).returncode, 2, text)
            self.assertEqual(self.get(), text)

    def test_an_unmarked_usage_eta_section_is_not_duplicated(self):
        text = "## usage-eta: task tracking\nold rules\n"
        self.put(text)
        self.assertEqual(run(self.path).returncode, 2)
        self.assertEqual(self.get(), text)

    def test_a_reworded_begin_line_is_still_found(self):
        self.put(f"a\n<!-- usage-eta:begin old wording -->\nold\n{END}\nz\n")
        self.assertEqual(run(self.path).returncode, 0)
        out = self.get()
        self.assertEqual(out.count("usage-eta:begin"), 1)
        self.assertIn(BEGIN, out)
        self.assertNotIn("old wording", out)
        self.assertTrue(out.startswith("a\n"))
        self.assertTrue(out.endswith("z\n"))

    def test_text_outside_the_block_is_untouched_by_update_and_remove(self):
        self.put(f"top\n\n{BEGIN}\nstale\n{END}\n\nbottom\n")
        run(self.path)
        self.assertTrue(self.get().startswith("top\n\n" + BEGIN))
        self.assertTrue(self.get().endswith(END + "\n\nbottom\n"))
        run(self.path, "--remove")
        self.assertEqual(self.get(), "top\n\nbottom\n")

    def test_every_change_gets_its_own_backup_and_keeps_the_mode(self):
        self.put("x\n")
        os.chmod(self.path, 0o600)
        run(self.path)
        run(self.path, "--remove")
        baks = [f for f in os.listdir(self.dir) if ".bak-" in f]
        self.assertGreaterEqual(len(baks), 1)
        self.assertEqual(os.stat(self.path).st_mode & 0o777, 0o600)

    def test_crlf_files_stay_crlf(self):
        self.put("a\r\nb\r\n")
        run(self.path)
        out = self.get()
        self.assertNotIn("\n", out.replace("\r\n", ""))

    def test_config_dir_env_picks_the_default_file(self):
        env = dict(os.environ, CLAUDE_CONFIG_DIR=self.dir)
        r = subprocess.run([sys.executable, SETUP, "--dry-run"], capture_output=True, text=True, env=env)
        self.assertIn(self.dir, r.stdout)


if __name__ == "__main__":
    unittest.main()
