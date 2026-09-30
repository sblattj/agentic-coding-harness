import os
import sys

sys.path.insert(0, os.environ.get("ACH_WORKSPACE", os.getcwd()))
import os
import subprocess
import unittest
import warnings

from inventory import Store, summary

WS = os.environ.get("ACH_WORKSPACE", os.getcwd())


def make():
    s = Store()
    s.add("bolt", 0.25, 40)
    s.add("nut", 0.1, 5)
    return s


class RefactorTest(unittest.TestCase):
    def test_total_value(self):
        self.assertAlmostEqual(make().total_value(), 10.5)

    def test_calc_is_deprecated_alias(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            self.assertAlmostEqual(make().calc(), 10.5)
        self.assertTrue(any(issubclass(w.category, DeprecationWarning) for w in caught), "calc() must warn")

    def test_summary_format(self):
        self.assertEqual(summary(make()), "2 items, total 10.50")

    def test_summary_delegates(self):
        s = make()
        s.total_value = lambda: 42
        self.assertEqual(summary(s), "2 items, total 42.00")

    def test_report_has_no_duplicate_logic(self):
        with open(os.path.join(WS, "inventory", "report.py"), encoding="utf8") as f:
            self.assertNotIn('["price"]', f.read())

    def test_visible_tests_pass(self):
        r = subprocess.run(
            ["python3", "-m", "unittest", "discover", "-s", "tests", "-t", "."],
            cwd=WS, capture_output=True, text=True,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn("DeprecationWarning", r.stderr, "tests should use total_value()")


if __name__ == "__main__":
    unittest.main()
