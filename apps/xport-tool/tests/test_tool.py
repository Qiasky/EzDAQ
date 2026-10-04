import importlib.util
import json
import socket
import sys
import tempfile
import threading
import time
import tkinter as tk
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import xport_core as core
from app import App


def sensor_frame(temperature=0x2181, humidity=0xFFFF):
    payload = bytes([0x1B, 4, 8]) + bytes.fromhex('5066') + temperature.to_bytes(2, 'big') + humidity.to_bytes(2, 'big') + bytes.fromhex('0024')
    return b':' + (payload + bytes([-sum(payload) & 255])).hex().upper().encode() + b'\r\n'


class TcpFixture:
    def __init__(self, response, hold=False):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(('127.0.0.2', 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.response = response
        self.hold = hold
        self.request = b''
        self.finished = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        try:
            self.sock.settimeout(3)
            with self.sock.accept()[0] as conn:
                conn.settimeout(2)
                while len(self.request) < len(core.REQUEST):
                    part = conn.recv(len(core.REQUEST) - len(self.request))
                    if not part:
                        break
                    self.request += part
                if self.hold:
                    self.finished.wait(2)
                else:
                    conn.sendall(self.response[:8])
                    time.sleep(0.02)
                    conn.sendall(self.response[8:])
        finally:
            self.sock.close()

    def close(self):
        self.finished.set()
        self.thread.join(4)


class UdpFixture:
    def __init__(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.2', core.UDP_PORT))
        self.sock.settimeout(0.1)
        self.record = bytearray((i * 7) % 256 for i in range(120))
        self.record[:4] = bytes([127, 0, 0, 2])
        self.record[6] = 8
        self.record[20:22] = (10050).to_bytes(2, 'little')
        self.original = bytes(self.record)
        self.mac = bytes.fromhex('00204AB993F7')
        self.ops = []
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.serve, daemon=True)
        self.thread.start()

    def serve(self):
        while not self.done.is_set():
            try:
                frame, peer = self.sock.recvfrom(8192)
            except TimeoutError:
                continue
            opcode = frame[3]
            self.ops.append(opcode)
            if opcode == 0xF6:
                response = b'\0\0\0\xf7' + bytes(20) + self.mac
            elif opcode == 0xF8:
                response = b'\0\0\0\xf9' + self.record
            elif opcode == 0xFD:
                self.record = bytearray(frame[4:])
                response = b'\0\0\0\xfb'
            else:
                continue
            self.sock.sendto(response, peer)

    def close(self):
        self.done.set()
        self.thread.join(1)
        self.sock.close()


class ProtocolTests(unittest.TestCase):
    def test_verified_real_capture_and_faulty_probe(self):
        metrics = core.parse_sensor(b':1B040850662181FFFF00245F\r\n')
        self.assertEqual(metrics, dict(temperature=24.0625, humidity=None, address=27))

    def test_valid_probe_and_bounds(self):
        for word in (0, 567, 1000):
            self.assertEqual(core.parse_sensor(sensor_frame(humidity=word))['humidity'], word / 10)

    def test_corrupt_and_unconfirmed_negative_data_fail_with_original_hex(self):
        invalid = [sensor_frame()[:-4] + b'00\r\n', sensor_frame(humidity=1001),
                   sensor_frame(temperature=0x2801), b'garbage\r\n', sensor_frame()[:15]]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaises(core.ReadError) as error:
                core.parse_sensor(raw)
            self.assertEqual(error.exception.raw, raw)

    def test_tcp_fragmentation_and_exact_command(self):
        fixture = TcpFixture(sensor_frame(humidity=567))
        try:
            metrics, frame = core.SensorReader().read('127.0.0.2', fixture.port, '127.0.0.1', 0, 1)
            self.assertEqual(fixture.request, b':000450000008A4\r\n')
            self.assertEqual(frame, sensor_frame(humidity=567))
            self.assertEqual(metrics['humidity'], 56.7)
        finally:
            fixture.close()

    def test_partial_frame_retained_on_disconnect(self):
        fixture = TcpFixture(sensor_frame()[:17])
        try:
            with self.assertRaises(core.ReadError) as error:
                core.SensorReader().read('127.0.0.2', fixture.port, '127.0.0.1', 0, 1)
            self.assertEqual(error.exception.raw, sensor_frame()[:17])
        finally:
            fixture.close()

    def test_stop_interrupts_wait_and_never_emits_sample(self):
        fixture = TcpFixture(sensor_frame(), hold=True)
        reader = core.SensorReader()
        errors = []
        def read():
            try:
                reader.read('127.0.0.2', fixture.port, '127.0.0.1', 30, 1)
            except core.ReadError as error:
                errors.append(error)
        thread = threading.Thread(target=read)
        try:
            thread.start()
            time.sleep(0.1)
            reader.stop()
            thread.join(0.7)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
        finally:
            fixture.close()


class NetworkSetupTests(unittest.TestCase):
    def setUp(self):
        self.device = UdpFixture()
        self.interface = dict(ip='127.0.0.1', prefix=8)

    def tearDown(self):
        self.device.close()

    def test_mac_mismatch_prevents_every_configuration_write(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(core.DeviceError):
            core.change_ip(self.interface, '127.0.0.2', '00:20:4A:A6:FB:43', '192.168.31.201', '255.255.255.0', '192.168.31.1', folder)
        self.assertEqual(self.device.ops, [0xF6])

    def test_real_udp_flow_preserves_port_and_every_non_network_byte(self):
        with tempfile.TemporaryDirectory() as folder:
            result = core.change_ip(self.interface, '127.0.0.2', '00:20:4A:B9:93:F7', '192.168.31.201', '255.255.255.0', '192.168.31.1', folder)
            self.assertTrue(result['acknowledged'])
            self.assertEqual(result['port'], 10050)
            self.assertEqual(Path(result['backup']).read_bytes(), self.device.original)
            allowed = {*range(4), 6, *range(12, 16)}
            for index in range(120):
                if index not in allowed:
                    self.assertEqual(self.device.original[index], self.device.record[index], index)
        self.assertEqual(self.device.ops, [0xF6, 0xF8, 0xFD])

    def test_invalid_ip_mask_gateway_fail_before_udp_write(self):
        choices = [('192.168.31.0', '255.255.255.0', '192.168.31.1'),
                   ('192.168.31.255', '255.255.255.0', '192.168.31.1'),
                   ('111.111.111.201', '255.255.255.0', '111.111.111.111'),
                   ('192.168.31.201', '255.0.255.0', '192.168.31.1'),
                   ('192.168.31.201', '255.255.255.0', '192.168.18.1')]
        for ip, mask, gateway in choices:
            with self.subTest(ip=ip, mask=mask), self.assertRaises(ValueError):
                core.prepare_change(self.device.original, ip, mask, gateway)
        self.assertEqual(self.device.ops, [])

    def test_off_subnet_target_cannot_follow_internet_default_route(self):
        with self.assertRaises(core.DeviceError):
            core.read_setup(dict(ip='192.168.31.122', prefix=24), '111.111.111.201', '00:20:4A:B9:93:F7')
        self.assertEqual(self.device.ops, [])

    def test_arp_deduplicates_valid_mac_and_ignores_other_vendor(self):
        output = '00:20:4a:b9:93:f7\t111.111.111.201\n' * 2 + '00:14:08:10:c9:c6\t192.168.31.28\n00:20:4a:b9:93:f7\t0.0.0.0'
        records = core.parse_arp(output)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]['ip'], '111.111.111.201')


class UiTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = tk.Tk()
        self.root.withdraw()
        self.app = App(self.root, self.folder.name, load_network=False)

    def tearDown(self):
        self.app.close()
        self.folder.cleanup()

    def test_failure_clears_old_values_and_retains_partial_hex(self):
        self.app._handle('sample', dict(core.parse_sensor(sensor_frame()), raw=sensor_frame()))
        self.assertEqual(self.app.temp.get(), '24.06')
        self.assertEqual(self.app.humidity.get(), '无效')
        self.app._handle('sample_error', dict(message='接收超时', raw=b':1B04'))
        self.assertEqual(self.app.temp.get(), '—')
        self.assertEqual(self.app.humidity.get(), '—')
        self.assertEqual(self.app.rx.get('1.0', 'end').strip(), '3A 31 42 30 34')

    def test_previous_hex_survives_next_poll_and_status_marks_previous_success(self):
        raw = sensor_frame()
        self.app._handle('rx', raw)
        self.app._handle('sample', dict(core.parse_sensor(raw), raw=raw))
        self.app._handle('status', '已连接，等待读取…')
        self.assertIn('上次通讯正常', self.app.status.get())
        self.assertEqual(self.app.rx.get('1.0', 'end').strip(), raw.hex(' ').upper())

    def test_button_worker_receives_and_stops_on_real_tcp_socket(self):
        fixture = TcpFixture(sensor_frame(humidity=567))
        try:
            self.app._handle('interfaces', [dict(alias='测试', ip='127.0.0.1', prefix=8, guid='')])
            self.app.host.set('127.0.0.2')
            self.app.port.set(str(fixture.port))
            self.app.wait.set('0')
            self.app.start_button.invoke()
            deadline = time.monotonic() + 3
            while not self.app.count_ok and time.monotonic() < deadline:
                self.root.update()
                time.sleep(0.02)
            self.assertEqual(self.app.humidity.get(), '56.7')
            self.assertIn('通讯正常', self.app.status.get())
            self.assertEqual(self.app.rx.get('1.0', 'end').strip(), sensor_frame(humidity=567).hex(' ').upper())
            self.app.stop_button.invoke()
            deadline = time.monotonic() + 1
            while self.app.reader and time.monotonic() < deadline:
                self.root.update()
                time.sleep(0.02)
            self.assertIsNone(self.app.reader)
        finally:
            fixture.close()


if __name__ == '__main__':
    unittest.main()
