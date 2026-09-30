import os
import sys

sys.path.insert(0, os.environ.get("ACH_WORKSPACE", os.getcwd()))
import unittest

from intervals import merge


class MergeTest(unittest.TestCase):
    def test_overlap_unsorted(self):
        self.assertEqual(merge([(8, 10), (1, 3), (2, 6), (15, 18)]), [(1, 6), (8, 10), (15, 18)])

    def test_touching(self):
        self.assertEqual(merge([(3, 5), (1, 3)]), [(1, 5)])

    def test_contained_and_points(self):
        self.assertEqual(merge([(1, 10), (2, 3), (4, 4), (11, 11)]), [(1, 10), (11, 11)])

    def test_empty_and_generator(self):
        self.assertEqual(merge([]), [])
        self.assertEqual(merge(iter([(1, 2)])), [(1, 2)])

    def test_no_mutation(self):
        data = [(5, 6), (1, 2)]
        merge(data)
        self.assertEqual(data, [(5, 6), (1, 2)])

    def test_bad_interval(self):
        with self.assertRaises(ValueError):
            merge([(1, 2), (5, 4)])

    def test_returns_tuples(self):
        self.assertTrue(all(isinstance(p, tuple) for p in merge([[1, 2], [2, 3]])))


if __name__ == "__main__":
    unittest.main()
