import unittest

from inventory import Store, summary


class InventoryTest(unittest.TestCase):
    def test_total_value(self):
        s = Store()
        s.add("bolt", 0.25, 40)
        s.add("nut", 0.1, 5)
        self.assertAlmostEqual(s.total_value(), 10.5)

    def test_summary(self):
        s = Store()
        s.add("bolt", 0.25, 40)
        self.assertEqual(summary(s), "1 items, total 10.00")


if __name__ == "__main__":
    unittest.main()
