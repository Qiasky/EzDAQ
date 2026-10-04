"""XPort CoBos UDP configuration and the user's LH8950 ASCII TCP protocol.

Configuration layout: Lantronix XPress DR User Guide, appendix B.
Temperature conversion: supplied LabVIEW 8950 diagram and verified captures.
"""
import datetime
import base64
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
from pathlib import Path

UDP_PORT = 30718
REQUEST = b':000450000008A4\r\n'
NO_WINDOW = getattr(subprocess, 'CREATE_NO_WINDOW', 0)


class DeviceError(ValueError):
    pass


class ReadError(DeviceError):
    def __init__(self, message, raw=b''):
        super().__init__(message)
        self.raw = raw


def normalize_mac(value):
    compact = re.sub(r'[:-]', '', value.strip()).upper()
    if not re.fullmatch(r'[0-9A-F]{12}', compact) or compact in ('0' * 12, 'F' * 12) or int(compact[:2], 16) & 1:
        raise DeviceError('请输入有效的设备 MAC 地址')
    return ':'.join(compact[i:i + 2] for i in range(0, 12, 2))


def network_for(interface):
    return ipaddress.IPv4Network(f"{interface['ip']}/{interface['prefix']}", strict=False)


def require_local(interface, target):
    address = ipaddress.IPv4Address(target)
    network = network_for(interface)
    if address not in network or address in (network.network_address, network.broadcast_address):
        raise DeviceError(f"模块 {address} 与所选电脑网卡 {interface['ip']}/{interface['prefix']} 不在同一网段。请换网卡，或按“网段帮助”临时设置电脑 IP。")
    if str(address) == interface['ip']:
        raise DeviceError('模块地址不能与电脑网卡地址相同')
    return str(address)


def list_interfaces():
    command = '''$json=@(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {$_.IPAddress -ne '127.0.0.1'} | ForEach-Object {
      $address=$_; $adapter=Get-NetAdapter -InterfaceIndex $address.InterfaceIndex -ErrorAction SilentlyContinue;
      if ($adapter -and $adapter.Status -eq 'Up' -and $adapter.HardwareInterface) {
        [PSCustomObject]@{alias=$address.InterfaceAlias;ip=$address.IPAddress;prefix=$address.PrefixLength;guid=$adapter.InterfaceGuid.ToString()}
      }
    }) | ConvertTo-Json -Compress;
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))'''
    result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command],
                            capture_output=True, encoding='ascii', errors='replace', timeout=15,
                            creationflags=NO_WINDOW)
    if result.returncode:
        raise DeviceError('读取电脑网卡失败，请确认 Windows 网络服务正常')
    records = json.loads(base64.b64decode(result.stdout.strip()).decode('utf-8') or '[]')
    if isinstance(records, dict):
        records = [records]
    return sorted(records, key=lambda row: row['ip'].startswith('169.254.'))


def decode_firmware(frame):
    if len(frame) != 30 or frame[:4] != b'\0\0\0\xf7':
        raise DeviceError('该模块不支持此工具使用的 XPort 固件响应格式')
    return normalize_mac(frame[-6:].hex())


def setup_info(record):
    record = bytes(record)
    if len(record) != 120:
        raise DeviceError('配置记录长度错误；不会修改设备')
    host_bits = record[6] or (8 if record[0] >= 192 else 16 if record[0] >= 128 else 24)
    if not 1 <= host_bits <= 30:
        raise DeviceError('模块子网掩码不受支持')
    port = int.from_bytes(record[20:22], 'little')
    if not 1 <= port <= 65535:
        raise DeviceError('模块返回无效的 TCP 端口')
    return dict(ip=str(ipaddress.IPv4Address(record[:4])), port=port,
                mask=str(ipaddress.IPv4Network(f'0.0.0.0/{32 - host_bits}').netmask),
                gateway=str(ipaddress.IPv4Address(record[12:16])))


def exchange(connection, target, opcode, payload=b'', timeout=3):
    connection.sendto(b'\0\0\0' + bytes([opcode]) + payload, (target, UDP_PORT))
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection.settimeout(max(0.01, deadline - time.monotonic()))
        try:
            frame, peer = connection.recvfrom(8192)
        except TimeoutError as exc:
            raise TimeoutError('XPort 配置口没有响应；请检查网线、电脑网段及模块配置口是否启用') from exc
        if peer == (target, UDP_PORT):
            return frame
    raise TimeoutError('XPort 配置口没有响应')


def read_setup(interface, target, expected_mac):
    target = require_local(interface, target)
    expected_mac = normalize_mac(expected_mac)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
        conn.bind((interface['ip'], 0))
        actual_mac = decode_firmware(exchange(conn, target, 0xF6))
        if actual_mac != expected_mac:
            raise DeviceError(f'MAC 不匹配：实际 {actual_mac}；不会修改设备')
        frame = exchange(conn, target, 0xF8)
        if len(frame) != 124 or frame[:4] != b'\0\0\0\xf9':
            raise DeviceError('配置响应格式错误；不会修改设备')
        record = frame[4:]
        info = setup_info(record)
        if info['ip'] != target:
            raise DeviceError('响应 IP 与设备配置不一致；不会修改设备')
        return dict(info, mac=actual_mac), record


def prepare_change(record, new_ip, new_mask, new_gateway):
    before = setup_info(record)
    address = ipaddress.IPv4Address(new_ip)
    network = ipaddress.IPv4Network(f'{address}/{new_mask}', strict=False)
    gateway = ipaddress.IPv4Address(new_gateway)
    if not address.is_private or address.is_loopback or address.is_link_local or address.is_unspecified:
        raise DeviceError('新地址请使用局域网私有 IPv4 地址，例如 192.168.31.201')
    if not 2 <= network.prefixlen <= 30 or address in (network.network_address, network.broadcast_address):
        raise DeviceError('新 IP 或子网掩码无效')
    if not gateway.is_unspecified and (gateway not in network or gateway in (address, network.network_address, network.broadcast_address)):
        raise DeviceError('网关须是新网段内的其他有效地址；不使用网关时填写 0.0.0.0')
    updated = bytearray(record)
    updated[:4] = address.packed
    updated[6] = 32 - network.prefixlen
    updated[12:16] = gateway.packed
    allowed = {*range(4), 6, *range(12, 16)}
    if any(updated[i] != record[i] for i in range(120) if i not in allowed) or setup_info(updated)['port'] != before['port']:
        raise DeviceError('端口或其他配置发生变化，已阻止写入')
    return bytes(updated)


def change_ip(interface, target, expected_mac, new_ip, mask, gateway, backup_dir):
    # Reread MAC and setup immediately before every write; never use a stale GUI snapshot.
    info, record = read_setup(interface, target, expected_mac)
    updated = prepare_change(record, new_ip, mask, gateway)
    if updated == record:
        raise DeviceError('配置相同，无需写入')
    folder = Path(backup_dir)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    stem = info['mac'].replace(':', '') + '-' + stamp
    backup = folder / (stem + '-before.bin')
    # Complete configuration includes management settings. Save locally, never display it in the HEX log.
    backup.write_bytes(record)
    (folder / (stem + '-requested.bin')).write_bytes(updated)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
        conn.bind((interface['ip'], 0))
        try:
            response = exchange(conn, target, 0xFD, updated)
            acknowledged = response == b'\0\0\0\xfb'
        except TimeoutError:
            acknowledged = False
    result = dict(mac=info['mac'], oldIp=target, newIp=new_ip, port=info['port'], mask=mask,
                  gateway=gateway, acknowledged=acknowledged, backup=str(backup),
                  verification='待连接新网段后读取核对')
    (folder / (stem + '-result.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    return result


def discover_udp(interface, duration=4):
    results = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as conn:
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        conn.bind((interface['ip'], 0))
        deadline = time.monotonic() + duration
        next_send = 0
        destinations = {str(network_for(interface).broadcast_address), '255.255.255.255'}
        while time.monotonic() < deadline:
            if time.monotonic() >= next_send:
                for dest in destinations:
                    conn.sendto(b'\0\0\0\xf6', (dest, UDP_PORT))
                next_send = time.monotonic() + 1
            conn.settimeout(min(0.25, max(0.01, deadline - time.monotonic())))
            try:
                frame, peer = conn.recvfrom(8192)
                if peer[1] != UDP_PORT or peer[0] == interface['ip']:
                    continue
                mac = decode_firmware(frame)
                address = ipaddress.IPv4Address(peer[0])
                if address.is_unspecified or address.is_multicast:
                    continue
                results[(mac, peer[0])] = dict(mac=mac, ip=peer[0], port='', evidence='XPort 响应')
            except (TimeoutError, DeviceError):
                continue
    return list(results.values())


def parse_arp(output):
    results = {}
    for line in output.splitlines():
        parts = line.split('\t')
        if len(parts) != 2:
            continue
        try:
            mac = normalize_mac(parts[0])
            address = ipaddress.IPv4Address(parts[1])
        except ValueError:
            continue
        if not mac.startswith('00:20:4A:') or address.is_unspecified or address.is_multicast:
            continue
        results[(mac, str(address))] = dict(mac=mac, ip=str(address), port='', evidence='网线 ARP；待读配置')
    return list(results.values())


def discover_arp(interface, duration=6):
    executable = shutil.which('tshark.exe') or str(Path(os.environ.get('ProgramFiles', r'C:\Program Files')) / 'Wireshark' / 'tshark.exe')
    if not Path(executable).is_file() or not interface.get('guid'):
        return []
    guid = interface['guid'].strip('{}')
    result = subprocess.run([executable, '-i', '\\Device\\NPF_{' + guid + '}', '-a', f'duration:{duration}',
                             '-f', 'arp', '-Y', 'arp', '-T', 'fields', '-e', 'arp.src.hw_mac', '-e', 'arp.src.proto_ipv4'],
                            capture_output=True, encoding='utf-8', errors='replace', timeout=duration + 8,
                            creationflags=NO_WINDOW)
    return parse_arp(result.stdout) if result.returncode == 0 else []


def parse_sensor(frame):
    if not frame.startswith(b':') or not frame.endswith(b'\r\n'):
        raise ReadError('响应不是完整的 8950 ASCII 帧', frame)
    text = frame[1:-2]
    if not re.fullmatch(rb'(?:[0-9A-Fa-f]{2})+', text):
        raise ReadError('响应含有非十六进制字符', frame)
    payload = bytes.fromhex(text.decode('ascii'))
    if len(payload) < 3 or sum(payload) & 255:
        raise ReadError('响应 LRC 校验失败', frame)
    if payload[1] & 0x80:
        raise ReadError(f'设备返回异常码 {payload[2]}', frame)
    if payload[1] != 4 or len(frame) != 27 or payload[2] != 8 or len(payload) != 12:
        raise ReadError('响应功能码或长度与 8950 程序不一致', frame)
    temperature_word = int(frame[11:15], 16)
    humidity_word = int(frame[15:19], 16)
    if temperature_word & 0x800:
        raise ReadError('负温标记：尚缺原 LabVIEW 负温换算分支', frame)
    temperature = (temperature_word & 0x7FF) * 0.0625
    if humidity_word == 0xFFFF:
        humidity = None
    elif humidity_word > 1000:
        raise ReadError('湿度超出有效范围', frame)
    else:
        humidity = humidity_word / 10
    return dict(temperature=temperature, humidity=humidity, address=payload[0])


class SensorReader:
    """Cancelable polling. Every result, including partial failures, carries original bytes."""
    def __init__(self):
        self.stop_event = threading.Event()
        self.connection = None
        self.lock = threading.Lock()

    def stop(self):
        self.stop_event.set()
        with self.lock:
            if self.connection is not None:
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def read(self, host, port, local_ip=None, wait_seconds=10, timeout=10, notify=None):
        notify = notify or (lambda kind, value: None)
        raw = bytearray()
        conn = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        with self.lock:
            self.connection = conn
        try:
            if self.stop_event.is_set():
                raise ReadError('采集已停止')
            conn.settimeout(timeout)
            if local_ip:
                conn.bind((local_ip, 0))
            notify('status', '正在连接…')
            conn.connect((host, port))
            conn.sendall(REQUEST)
            notify('tx', REQUEST)
            notify('status', '已连接，等待读取…')
            if self.stop_event.wait(wait_seconds):
                raise ReadError('采集已停止')
            deadline = time.monotonic() + timeout
            while len(raw) < 27:
                if self.stop_event.is_set():
                    raise ReadError('采集已停止', bytes(raw))
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ReadError(f'接收超时：{len(raw)}/27 字节', bytes(raw))
                conn.settimeout(min(0.5, remaining))
                try:
                    part = conn.recv(27 - len(raw))
                except TimeoutError:
                    continue
                if not part:
                    raise ReadError(f'连接关闭：{len(raw)}/27 字节', bytes(raw))
                raw.extend(part)
                notify('rx', bytes(raw))
            metrics = parse_sensor(bytes(raw))
            return metrics, bytes(raw)
        except OSError as exc:
            raise ReadError(f'通讯失败：{exc}', bytes(raw)) from exc
        finally:
            with self.lock:
                self.connection = None
            conn.close()
