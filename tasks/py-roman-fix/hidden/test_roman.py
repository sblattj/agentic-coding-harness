import os
import sys

sys.path.insert(0, os.environ.get("ACH_WORKSPACE", os.getcwd()))
import unittest

from roman import from_roman, to_roman


class RomanTest(unittest.TestCase):
    def test_to_roman(self):
        for n, s in [(1, "I"), (4, "IV"), (9, "IX"), (14, "XIV"), (40, "XL"), (90, "XC"),
                     (400, "CD"), (1994, "MCMXCIV"), (3999, "MMMCMXCIX")]:
            self.assertEqual(to_roman(n), s)

    def test_to_roman_rejects(self):
        for bad in [0, -1, 4000, 2.0, "5", True]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                to_roman(bad)

    def test_from_roman(self):
        self.assertEqual(from_roman("MCMXCIV"), 1994)
        self.assertEqual(from_roman("xiv"), 14)
        self.assertEqual(from_roman("IV"), 4)

    def test_from_roman_rejects(self):
        for bad in ["", "ABC", "X V"]:
            with self.assertRaises(ValueError, msg=repr(bad)):
                from_roman(bad)

    def test_round_trip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)


if __name__ == "__main__":
    unittest.main()
