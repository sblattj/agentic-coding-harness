import csv
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import contextlib

HERE = os.path.dirname(os.path.abspath(__file__))
KIT = os.path.dirname(HERE)
sys.path.insert(0, KIT)
sys.path.insert(0, HERE)

import ablate_row  # noqa: E402
import skill_meta  # noqa: E402
import fixtures_helper as fx  # noqa: E402


def slurp(path):
    with open(path) as f:
        return f.read()


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(KIT, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


usage = load("skill_usage", "skill-usage.py")
lint = load("skill_lint", "skill-lint.py")

NOW = "2026-01-31T00:00:00+00:00"


class TmpCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ctxdiet-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def run_main(self, mod, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                rc = mod.main(argv)
            except SystemExit as e:
                rc = e.code
        return rc, out.getvalue(), err.getvalue()


class FrontmatterTests(unittest.TestCase):
    def test_quoted_and_folded(self):
        fm = 'name: a\ndescription: "Say \\"hi\\""\nwhen_to_use: >\n  one\n  two\n'
        m = skill_meta.parse_frontmatter(fm)
        self.assertEqual(m["description"], 'Say "hi"')
        self.assertEqual(m["when_to_use"], "one two")

    def test_no_frontmatter(self):
        fm, body = skill_meta.split_frontmatter("just text")
        self.assertEqual(fm, "")
        self.assertEqual(body, "just text")


class AblateRowTests(unittest.TestCase):
    RES = {"type": "result", "usage": {"input_tokens": 2, "cache_creation_input_tokens": 100,
           "cache_read_input_tokens": 50, "output_tokens": 4}, "total_cost_usd": 0.5,
           "num_turns": 1, "duration_ms": 1200, "is_error": False, "result": "OK"}

    def test_object_payload(self):
        r = ablate_row.build_row(self.RES, "v", 0, 1, expect="OK", wall_ms=9)
        self.assertEqual(r["start_tokens"], 152)
        self.assertEqual(r["cache_write_tokens"], 100)
        self.assertEqual(r["cache_read_tokens"], 50)
        self.assertTrue(r["pass"])
        self.assertEqual(r["wall_ms"], 9)

    def test_event_list_payload_and_fail(self):
        payload = [{"type": "system"}, self.RES]
        r = ablate_row.build_row(payload, "v", 1, 2, expect="NOPE")
        self.assertEqual(r["start_tokens"], 152)
        self.assertFalse(r["pass"])
        self.assertNotIn("pass", ablate_row.build_row(payload, "v", 0, 1))

    def test_empty_payload_is_error(self):
        r = ablate_row.build_row({}, "v", 0, 1, expect="OK")
        self.assertTrue(r["is_error"])
        self.assertFalse(r["pass"])
        self.assertEqual(r["start_tokens"], 0)


class AblateScriptTests(TmpCase):
    def fake_claude(self):
        p = os.path.join(self.tmp, "fakeclaude")
        with open(p, "w") as f:
            f.write("#!/bin/sh\necho \"$@\" > \"$FAKE_ARGS_DIR/args.$$\"\n"
                    "echo \"MDS=$CLAUDE_CODE_DISABLE_CLAUDE_MDS KEY=${ANTHROPIC_API_KEY:-unset}\" >> \"$FAKE_ARGS_DIR/args.$$\"\n"
                    "echo '{\"type\":\"result\",\"result\":\"OK\",\"num_turns\":1,\"duration_ms\":5,"
                    "\"total_cost_usd\":0.1,\"usage\":{\"input_tokens\":1,\"cache_creation_input_tokens\":10,"
                    "\"cache_read_input_tokens\":4,\"output_tokens\":2}}'\n")
        os.chmod(p, 0o755)
        return p

    def run_script(self, *args):
        env = dict(os.environ, CLAUDE_BIN=self.fake_claude(), FAKE_ARGS_DIR=self.tmp,
                   ANTHROPIC_API_KEY="secret")
        return subprocess.run(["/bin/bash", os.path.join(KIT, "ablate.sh")] + list(args),
                              env=env, capture_output=True, text=True)

    def test_writes_one_jsonl_per_variant(self):
        out = os.path.join(self.tmp, "out")
        p = self.run_script("-v", "baseline,floor", "-n", "2", "-e", "OK", "-o", out)
        self.assertEqual(p.returncode, 0, p.stderr)
        for v in ("baseline", "floor"):
            rows = [json.loads(l) for l in slurp(os.path.join(out, v + ".jsonl")).splitlines()]
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["variant"], v)
            self.assertEqual(rows[0]["start_tokens"], 15)
            self.assertTrue(rows[0]["pass"])
        captured = "".join(slurp(os.path.join(self.tmp, f))
                           for f in os.listdir(self.tmp) if f.startswith("args."))
        self.assertIn("--strict-mcp-config", captured)
        self.assertIn("MDS=1", captured)
        self.assertNotIn("KEY=secret", captured)

    def test_prompts_file(self):
        pf = os.path.join(self.tmp, "prompts.txt")
        with open(pf, "w") as f:
            f.write("one\n\ntwo\nthree")
        out = os.path.join(self.tmp, "out")
        p = self.run_script("-v", "no-skills", "-f", pf, "-o", out)
        self.assertEqual(p.returncode, 0, p.stderr)
        rows = [json.loads(l) for l in slurp(os.path.join(out, "no-skills.jsonl")).splitlines()]
        self.assertEqual([r["prompt"] for r in rows], [0, 1, 2])

    def test_unknown_variant_rejected_before_running(self):
        out = os.path.join(self.tmp, "out")
        p = self.run_script("-v", "baseline,bogus", "-o", out)
        self.assertEqual(p.returncode, 2)
        self.assertIn("unknown variant", p.stderr)
        self.assertFalse(os.path.exists(out))

    def test_help(self):
        p = self.run_script("--help")
        self.assertEqual(p.returncode, 0)
        self.assertIn("Usage: ablate.sh", p.stdout)


class SkillUsageTests(TmpCase):
    def build(self):
        proj = os.path.join(self.tmp, "projects")
        skills = os.path.join(self.tmp, "skills")
        fx.write_jsonl(os.path.join(proj, "a", "s1.jsonl"), [
            fx.skill_call("alpha", "2026-01-30T10:00:00Z"),
            fx.skill_call("alpha", "2026-01-20T10:00:00Z"),
            fx.other_tool("2026-01-30T11:00:00Z"),
            fx.typed("beta", "2026-01-29T10:00:00Z"),
            fx.typed("beta", "2026-01-28T10:00:00Z", as_list=True),
            fx.skill_call("old", "2025-06-01T10:00:00Z"),
            fx.skill_call("longy", "2026-01-30T09:00:00Z"),
        ])
        with open(os.path.join(proj, "a", "s2.jsonl"), "w") as f:
            f.write("not json Skill\n")
        fx.write_skill(skills, "alpha", "Short.")
        fx.write_skill(skills, "beta", "Short.")
        fx.write_skill(skills, "old", "Short.")
        fx.write_skill(skills, "longy", "x" * 400, "y" * 300)
        fx.write_skill(skills, "never", "Short.")
        return proj, skills

    def rows(self, **kw):
        proj, skills = self.build()
        rc, out, err = self.run_main(usage, [proj, "--skills-dir", skills, "--now", NOW])
        self.assertEqual(rc, 0, err)
        rd = list(csv.DictReader(io.StringIO(out)))
        return {r["skill"]: r for r in rd}, out

    def test_counts_and_tiers(self):
        rows, out = self.rows()
        self.assertEqual(out.splitlines()[0], ",".join(usage.HEADER))
        self.assertEqual(rows["alpha"]["model_invocations"], "2")
        self.assertEqual(rows["alpha"]["last_used"], "2026-01-30")
        self.assertEqual(rows["alpha"]["suggested_tier"], "keep")
        self.assertEqual(rows["beta"]["typed_invocations"], "2")
        self.assertEqual(rows["beta"]["suggested_tier"], "user-invocable-only")
        self.assertEqual(rows["old"]["suggested_tier"], "name-only")
        self.assertEqual(rows["never"]["invocations"], "0")
        self.assertEqual(rows["never"]["last_used"], "")
        self.assertEqual(rows["never"]["suggested_tier"], "name-only")
        self.assertEqual(rows["longy"]["description_length"], "700")
        self.assertEqual(rows["longy"]["suggested_tier"], "trim")

    def test_missing_dir(self):
        rc, _, err = self.run_main(usage, [os.path.join(self.tmp, "nope")])
        self.assertEqual(rc, 2)
        self.assertIn("no such transcript directory", err)


class SkillLintTests(TmpCase):
    def test_flags_overflow_and_exit_codes(self):
        root = os.path.join(self.tmp, "skills")
        fx.write_skill(root, "ok", "x" * 600)
        fx.write_skill(root, "split", "x" * 400, "y" * 201)
        fx.write_skill(root, "folded", "word " * 130, folded=True)
        rc, out, _ = self.run_main(lint, [root])
        self.assertEqual(rc, 1)
        self.assertIn("split", out)
        self.assertIn("folded", out)
        self.assertNotIn("/ok/", out)
        self.assertIn("## More triggers", out)
        self.assertIn("3 skill(s) checked, 2 over the cap", out)

    def test_boundary_is_inclusive(self):
        root = os.path.join(self.tmp, "skills")
        fx.write_skill(root, "edge", "x" * 600)
        rc, out, _ = self.run_main(lint, [root])
        self.assertEqual(rc, 0, out)
        rc, _, _ = self.run_main(lint, [root, "--cap", "599"])
        self.assertEqual(rc, 1)

    def test_existing_more_triggers_section(self):
        root = os.path.join(self.tmp, "skills")
        fx.write_skill(root, "has", "x" * 700, body="## More triggers\n- a\n")
        rc, out, _ = self.run_main(lint, [root])
        self.assertEqual(rc, 1)
        self.assertIn("existing '## More triggers'", out)

    def test_no_files(self):
        rc, _, err = self.run_main(lint, [self.tmp])
        self.assertEqual(rc, 2)


class LeanAgentTests(unittest.TestCase):
    def test_lean_agent_frontmatter(self):
        sk = skill_meta.read_skill(os.path.join(os.path.dirname(KIT), "agents", "lean.md"))
        self.assertEqual(sk["meta"]["name"], "lean")
        tools = [t.strip() for t in sk["meta"]["tools"].split(",")]
        self.assertEqual(tools, ["Bash", "Read", "Edit", "Write", "Grep", "Glob"])
        self.assertNotIn("Skill", tools)
        self.assertLessEqual(skill_meta.listing_length(sk["meta"]), 600)


if __name__ == "__main__":
    unittest.main()
