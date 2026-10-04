import importlib.util
import io
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "lhg8950_gateway.py"
spec = importlib.util.spec_from_file_location("lhg8950_gateway", SCRIPT)
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def fixture_frame(temp=0x0190, humidity=555):
    # Synthetic complete ASCII response matching the supplied offsets, not a device capture.
    data = bytes.fromhex(f"0004080000{temp:04X}{humidity:04X}0000")
    lrc = (-sum(data)) & 0xFF
    return b":" + (data + bytes([lrc])).hex().upper().encode() + b"\r\n"


def config():
    values = gateway.load_config(gateway.EXAMPLE)
    values.update(host="127.0.0.1", secret="unittest-secret", waitMs=0, timeoutMs=1000)
    return values


class GatewayTests(unittest.TestCase):
    def test_exact_request_and_positive_fields(self):
        values = config()
        self.assertEqual(bytes.fromhex(values["requestHex"]), b":000450000008A4\r\n")
        frame = fixture_frame()
        self.assertEqual(len(frame), 27)
        self.assertEqual(gateway.parse_response(frame, values), {"temp": 25.0, "humidity": 55.5})
        self.assertEqual(gateway.parse_response(fixture_frame(0, 0), values), {"temp": 0.0, "humidity": 0.0})

    def test_unconfirmed_negative_is_not_guessed(self):
        values = config()
        with self.assertRaisesRegex(gateway.ProtocolError, "真分支尚未确认"):
            gateway.parse_response(fixture_frame(0xFFF0), values)
        values["negativeMode"] = "signed12"
        self.assertEqual(gateway.parse_response(fixture_frame(0xFFF0), values)["temp"], -1.0)

    def test_captured_sensor_address_and_invalid_humidity_preserve_real_temperature(self):
        frame = b":1B040850662181FFFF00245F\r\n"
        values = config()
        with self.assertRaisesRegex(gateway.ProtocolError, "设备地址"):
            gateway.parse_response(frame, values)
        values["responseAddress"] = 27
        with self.assertRaisesRegex(gateway.ProtocolError, "有效解析范围"):
            gateway.parse_response(frame, values)
        values["invalidHumidityValues"] = [65535]
        self.assertEqual(gateway.parse_response(frame, values), {"temp": 24.0625})
        # Explicit sentinel handling never accepts other invalid humidity measurements.
        with self.assertRaises(gateway.ProtocolError):
            gateway.parse_response(fixture_frame(humidity=1001), {**values, "responseAddress": 0})

    def test_partial_read_reports_invalid_quality_without_fabricating_humidity(self):
        capture = io.StringIO()
        with patch.object(gateway, "load_config", return_value=config()), \
             patch.object(gateway, "read_sensor", return_value=({"temp": 24.0625}, b":captured\r\n")), \
             patch.object(gateway, "post_metrics", return_value="saved") as post, \
             patch.object(gateway.sys, "argv", ["gateway.py"]), \
             patch.object(gateway.sys, "stdout", capture):
            self.assertEqual(gateway.main(), 0)
        post.assert_called_once_with(config(), {"temp": 24.0625}, {"humidity": "invalid"})
        self.assertIn("湿度 无效", capture.getvalue())

    def test_corrupt_incomplete_and_invalid_humidity_rejected(self):
        frame = fixture_frame()
        corrupt = bytearray(frame)
        corrupt[-3] = ord("0") if corrupt[-3] != ord("0") else ord("1")
        for sample in (bytes(corrupt), frame[:-2], fixture_frame(humidity=1001)):
            with self.subTest(sample=sample), self.assertRaises(gateway.ProtocolError):
                gateway.parse_response(sample, config())

    def test_exception_address_and_byte_count_rejected(self):
        def wrap(data):
            return b":" + (data + bytes([(-sum(data)) & 255])).hex().encode() + b"\r\n"
        for data in (bytes.fromhex("008402"), bytes.fromhex("01040800000190022B0000"), bytes.fromhex("00040900000190022B0000")):
            with self.subTest(data=data), self.assertRaises(gateway.ProtocolError):
                gateway.parse_response(wrap(data), config())

    def test_fragmented_tcp_reply_is_reassembled_and_exact_query_sent(self):
        errors = []
        received = []
        with socket.socket() as server:
            server.bind(("127.0.0.1", 0))
            server.listen()
            server.settimeout(2)
            def serve():
                try:
                    with server.accept()[0] as peer:
                        received.append(gateway.receive_exact(peer, 17, 1))
                        reply = fixture_frame()
                        for part in (reply[:3], reply[3:12], reply[12:]):
                            peer.sendall(part)
                except Exception as exc:
                    errors.append(exc)
            worker = threading.Thread(target=serve)
            worker.start()
            values = config()
            values["port"] = server.getsockname()[1]
            metrics, frame = gateway.read_sensor(values)
            worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(received, [b":000450000008A4\r\n"])
        self.assertEqual(frame, fixture_frame())
        self.assertEqual(metrics, {"temp": 25.0, "humidity": 55.5})

    def test_early_close_and_timeout_preserve_partial_capture(self):
        sender, receiver = socket.socketpair()
        with sender, receiver:
            sender.sendall(b":0004")
            sender.shutdown(socket.SHUT_WR)
            with self.assertRaisesRegex(gateway.ProtocolError, "5/27"):
                gateway.receive_exact(receiver, 27, 0.1)
        sender, receiver = socket.socketpair()
        with sender, receiver:
            with self.assertRaisesRegex(gateway.ProtocolError, "0/27"):
                gateway.receive_exact(receiver, 27, 0.02)

    def test_failed_sensor_read_never_posts_fake_metrics(self):
        with patch.object(gateway, "load_config", return_value=config()), \
             patch.object(gateway, "read_sensor", side_effect=gateway.ProtocolError("bad frame")), \
             patch.object(gateway, "post_metrics") as post, \
             patch.object(gateway.sys, "argv", ["gateway.py"]), \
             patch.object(gateway.sys, "stdout", io.StringIO()), \
             patch.object(gateway.sys, "stderr", io.StringIO()):
            self.assertEqual(gateway.main(), 1)
            post.assert_not_called()

    def test_init_creates_matching_private_key_without_overwrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            filename = Path(temporary) / "lhg8950.config.local.json"
            with patch.object(gateway.sys, "stdout", io.StringIO()):
                gateway.initialize(filename, "127.0.0.1")
            values = json.loads(filename.read_text(encoding="utf-8"))
            device = json.loads(filename.with_name("lhg8950.device.local.json").read_text(encoding="utf-8"))
            self.assertEqual(values["secret"], device["secret"])
            self.assertEqual(len(values["secret"]), 64)
            self.assertEqual(device["metrics"], {})
            self.assertEqual(device["lastReportTime"], 0)
            with self.assertRaises(ValueError):
                gateway.initialize(filename)

    def test_real_metrics_are_signed_for_existing_cloud_contract(self):
        values = config()
        captured = []
        def response(request, timeout):
            captured.append(json.loads(request.data))
            self.assertEqual(timeout, 15)
            return io.BytesIO(b'{"code":0,"data":{"received":true,"status":"normal"}}')
        with patch.object(gateway.urllib.request, "urlopen", side_effect=response):
            self.assertIn("保存成功", gateway.post_metrics(values, {"temp": 25.0, "humidity": 55.5}))
        payload = captured[0]
        signature = gateway.hmac.new(values["secret"].encode(), f"{values['deviceId']}:{payload['timestamp']}".encode(), gateway.hashlib.sha256).hexdigest()
        self.assertEqual(payload["sign"], signature)
        self.assertEqual(payload["metrics"], {"temp": 25.0, "humidity": 55.5})
        self.assertEqual(payload["source"], "tcp")

    def test_partial_metrics_quality_is_sent_in_http_payload(self):
        captured = []
        def response(request, timeout):
            captured.append(json.loads(request.data))
            return io.BytesIO(b'{"code":0,"data":{"received":true}}')
        with patch.object(gateway.urllib.request, "urlopen", side_effect=response):
            gateway.post_metrics(config(), {"temp": 24.0625}, {"humidity": "invalid"})
        self.assertEqual(captured[0]["metrics"], {"temp": 24.0625})
        self.assertEqual(captured[0]["metricQuality"], {"humidity": "invalid"})

    def test_response_address_and_sentinel_configuration_rejects_unsafe_values(self):
        for change in ({"responseAddress": True}, {"responseAddress": 248}, {"responseAddress": "27"},
                       {"invalidHumidityValues": [500]}, {"invalidHumidityValues": [True]},
                       {"invalidHumidityValues": "FFFF"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                gateway.validate_config({**config(), **change})

    def test_missing_host_and_write_command_rejected(self):
        values = config()
        values["host"] = ""
        with self.assertRaisesRegex(ValueError, "IP"):
            gateway.validate_config(values)
        values["host"] = "127.0.0.1"
        data = bytes.fromhex("000650000001")
        query = b":" + (data + bytes([(-sum(data)) & 255])).hex().encode() + b"\r\n"
        values["requestHex"] = query.hex()
        with self.assertRaisesRegex(ValueError, "读取请求"):
            gateway.validate_config(values)


if __name__ == "__main__":
    unittest.main()
