import math
import unittest

import helpers  # noqa: F401  (sets sys.path)
from report import mcnemar_exact, wilson


def ref_wilson(k, n):
    # independent formulation: solve the Wilson quadratic directly
    z = 1.959963984540054
    p = k / n
    a = 1 + z * z / n
    b = -(2 * p + z * z / n)
    c = p * p
    disc = math.sqrt(b * b - 4 * a * c)
    return ((-b - disc) / (2 * a), (-b + disc) / (2 * a))


class WilsonTests(unittest.TestCase):
    def test_known_8_of_10(self):
        lo, hi = wilson(8, 10)
        self.assertAlmostEqual(lo, 0.490, places=3)
        self.assertAlmostEqual(hi, 0.943, places=3)

    def test_matches_independent_quadratic(self):
        for k, n in [(0, 5), (5, 5), (1, 20), (45, 98), (3, 3)]:
            for got, want in zip(wilson(k, n), ref_wilson(k, n)):
                self.assertAlmostEqual(got, want, places=9)

    def test_bounds_and_empty(self):
        lo, hi = wilson(10, 10)
        self.assertLessEqual(hi, 1.0)
        self.assertTrue(math.isnan(wilson(0, 0)[0]))


class McNemarTests(unittest.TestCase):
    def test_b1_c9(self):
        expected = 2 * sum(math.comb(10, k) for k in range(2)) / 2 ** 10
        self.assertEqual(expected, 0.021484375)
        self.assertAlmostEqual(mcnemar_exact(1, 9), 0.021484375, places=12)
        self.assertAlmostEqual(mcnemar_exact(9, 1), 0.021484375, places=12)

    def test_no_discordant(self):
        self.assertEqual(mcnemar_exact(0, 0), 1.0)

    def test_balanced_is_one(self):
        self.assertEqual(mcnemar_exact(5, 5), 1.0)

    def test_issue_example(self):  # 1 vs 2 discordant -> p = 1.0
        self.assertEqual(mcnemar_exact(1, 2), 1.0)


if __name__ == "__main__":
    unittest.main()
