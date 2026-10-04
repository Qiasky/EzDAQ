import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("synology_package", HERE / "package.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class MigrationPackageTests(unittest.TestCase):
    def test_public_package_never_reads_private_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "public.zip"
            original = Path.read_text

            def safe_read(path, *args, **kwargs):
                self.assertFalse(path.name.endswith(".local.json"))
                return original(path, *args, **kwargs)

            with patch.object(Path, "read_text", safe_read):
                package.build_archive(output)
            with zipfile.ZipFile(output) as bundle:
                config = json.loads(bundle.read("config/lhg8950.config.local.json"))
                self.assertEqual(config["secret"], "")
                self.assertEqual(config["responseAddress"], 27)
                self.assertEqual(config["invalidHumidityValues"], [65535])
                self.assertEqual(bundle.read("app/lhg8950_gateway.py"), (package.SCRIPTS / "lhg8950_gateway.py").read_bytes())
                self.assertEqual(len(bundle.namelist()), 5)

    def test_migration_preserves_identity_and_nondefault_protocol_settings(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            config = json.loads((package.SCRIPTS / "lhg8950.config.example.json").read_text(encoding="utf-8"))
            config.update(host="192.168.31.201", responseAddress=1, invalidHumidityValues=[65535],
                          deviceId="HOME-TH-002", secret="test-private-migration-key")
            source = folder / "source.local.json"
            source.write_text(json.dumps(config), encoding="utf-8")
            output = package.build_archive(folder / "migration.zip", source)
            with zipfile.ZipFile(output) as bundle:
                self.assertEqual(json.loads(bundle.read("config/lhg8950.config.local.json")), config)
                self.assertNotIn("device.local.json", " ".join(bundle.namelist()))

    def test_invalid_migration_configuration_does_not_create_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / "invalid.local.json"
            source.write_text('{"host":"192.168.31.178","secret":""}', encoding="utf-8")
            output = folder / "migration.zip"
            with self.assertRaisesRegex(ValueError, "密钥"):
                package.build_archive(output, source)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
