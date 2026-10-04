import importlib.util
import unittest
from pathlib import Path

script = Path(__file__).resolve().parents[1] / "scripts" / "find_xport.py"
spec = importlib.util.spec_from_file_location("find_xport", script)
finder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(finder)


class XPortDiscoveryTests(unittest.TestCase):
    def test_target_mac_accepts_label_and_discovery_formats(self):
        for value in ("00-20-4A-12-34-56", "00:20:4a:12:34:56", "00204a123456"):
            self.assertEqual(finder.normalize_mac(value), "00:20:4A:12:34:56")

    def test_invalid_target_mac_rejected(self):
        for value in ("00:20:4A", "not-a-mac", "000000000000", "FFFFFFFFFFFF", "01204A123456"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                finder.normalize_mac(value)

    def test_observed_zero_mac_self_result_is_not_a_sensor(self):
        output = "  1       0.0 00:00:00:00:00:00 192.168.31.122\n1 device(s) were found"
        self.assertEqual(finder.parse_devices(output, "192.168.31.122"), [])

    def test_realistic_candidates_deduplicate_and_preserve_other_subnet(self):
        output = "  1 X5 6.9 00:80:a3:12:34:56 192.168.1.50\n" * 2
        self.assertEqual(finder.parse_devices(output, "192.168.31.122"),
                         [{"mac": "00:80:A3:12:34:56", "ip": "192.168.1.50"}])

    def test_local_and_broadcast_or_multicast_mac_are_excluded(self):
        output = "\n".join([" 1 X5 6.9 00:80:A3:12:34:56 192.168.31.122",
                             " 2 X5 6.9 FF:FF:FF:FF:FF:FF 192.168.31.33",
                             " 3 X5 6.9 01:80:A3:12:34:56 192.168.31.34"])
        self.assertEqual(finder.parse_devices(output, "192.168.31.122"), [])


if __name__ == "__main__":
    unittest.main()
