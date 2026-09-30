import os
import sys

sys.path.insert(0, os.environ.get("ACH_WORKSPACE", os.getcwd()))
import unittest

from slug import slugify


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("  --Already--slugged--  "), "already-slugged")
        self.assertEqual(slugify("Version 2.0 released"), "version-2-0-released")

    def test_accents(self):
        self.assertEqual(slugify("Crème Brûlée"), "creme-brulee")
        self.assertEqual(slugify("Café"), "cafe")

    def test_empty(self):
        self.assertEqual(slugify("!!!"), "")
        self.assertEqual(slugify(""), "")

    def test_max_length(self):
        self.assertEqual(slugify("the quick brown fox", max_length=12), "the-quick")
        self.assertEqual(slugify("the quick brown fox", max_length=9), "the-quick")
        self.assertEqual(slugify("the quick brown fox", max_length=10), "the-quick")
        self.assertEqual(slugify("supercalifragilistic", max_length=5), "super")
        self.assertEqual(slugify("short", max_length=50), "short")


if __name__ == "__main__":
    unittest.main()
