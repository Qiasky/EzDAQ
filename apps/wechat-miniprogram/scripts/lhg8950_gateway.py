#!/usr/bin/env python3
"""8950 TCP reader and cloud reporter, based on the supplied LabVIEW program.

No third-party dependencies. Default operation reads once; --watch repeats.
The omitted negative-temperature branch is rejected unless explicitly confirmed.
"""
import argparse
import concurrent.futures
import hashlib
import hmac
import ipaddress
import json
import math
import re
import secrets
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
EXAMPLE = HERE / "lhg8950.config.example.json"
LOCAL = HERE / "lhg8950.config.local.json"


class ProtocolError(ValueError):
    pass


def validate_ascii_frame(frame):
    if not frame.startswith(b":") or not frame.endswith(b"\r\n"):
        raise ProtocolError("响应缺少冒号或 CRLF，未收到完整 ASCII 帧")
    try:
        text = frame[1:-2].decode("ascii")
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{2})+", text):
            raise ValueError("non-hex data")
        payload = bytes.fromhex(text)
    except (ValueError, UnicodeError) as exc:
        raise ProtocolError("响应不是 ASCII 十六进制帧") from exc
    if len(payload) < 3 or sum(payload) & 0xFF:
        raise ProtocolError("响应 LRC 校验失败")
    return payload


def parse_response(frame, config):
    payload = validate_ascii_frame(frame)
    request = bytes.fromhex(config["requestHex"])
    expected_address = config.get("responseAddress")
    if expected_address is None:
        expected_address = bytes.fromhex(request[1:-2].decode("ascii"))[0]
    if payload[0] != expected_address:
        raise ProtocolError(f"响应设备地址 0x{payload[0]:02X} 与配置 0x{expected_address:02X} 不一致")
    if payload[1] & 0x80:
        raise ProtocolError(f"传感器返回异常码 {payload[2]}")
    if payload[1] != 4 or payload[2] != len(payload) - 4:
        raise ProtocolError("响应功能码或数据长度不匹配")
    values = []
    for field in ("temperatureOffset", "humidityOffset"):
        offset = config[field]
        text = frame[offset:offset + 4]
        if offset < 7 or offset + 4 > len(frame) - 4 or not re.fullmatch(rb"[0-9A-Fa-f]{4}", text):
            raise ProtocolError(f"{field} 对应测点数据不完整")
        values.append(int(text, 16))
    temperature_word, humidity_word = values
    # LabVIEW: high-byte bit 3 selects sign; false case masks high byte with 0x07.
    raw_temperature = temperature_word & 0x7FF
    if temperature_word & 0x800:
        if config["negativeMode"] != "signed12":
            raise ProtocolError("读到负温标记，但 LabVIEW 真分支尚未确认；本次不上传")
        raw_temperature -= 0x800
    temperature = raw_temperature * 0.0625
    if not math.isfinite(temperature):
        raise ProtocolError("温度超出有效解析范围")
    if humidity_word in config.get("invalidHumidityValues", []):
        # Only an explicitly configured sentinel may be omitted; arbitrary bad values still fail.
        return {"temp": temperature}
    humidity = humidity_word / 10.0
    if not 0 <= humidity <= 100:
        raise ProtocolError("温湿度超出有效解析范围，请检查返回报文与解析参数")
    return {"temp": temperature, "humidity": humidity}


def receive_exact(connection, count, timeout):
    deadline = time.monotonic() + timeout
    parts = bytearray()
    while len(parts) < count:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ProtocolError(f"TCP 接收超时：只收到 {len(parts)}/{count} 字节，HEX={parts.hex(' ')}")
        connection.settimeout(remaining)
        try:
            chunk = connection.recv(count - len(parts))
        except socket.timeout as exc:
            raise ProtocolError(f"TCP 接收超时：只收到 {len(parts)}/{count} 字节，HEX={parts.hex(' ')}") from exc
        if not chunk:
            raise ProtocolError(f"连接提前关闭：只收到 {len(parts)}/{count} 字节，HEX={parts.hex(' ')}")
        parts.extend(chunk)
    return bytes(parts)


def read_sensor(config):
    timeout = config["timeoutMs"] / 1000
    with socket.create_connection((config["host"], config["port"]), timeout=timeout) as connection:
        connection.sendall(bytes.fromhex(config["requestHex"]))
        time.sleep(config["waitMs"] / 1000)
        frame = receive_exact(connection, config["responseBytes"], timeout)
    try:
        metrics = parse_response(frame, config)
    except ProtocolError as exc:
        raise ProtocolError(f"{exc}；接收 HEX={frame.hex(' ')}") from exc
    return metrics, frame


def post_metrics(config, metrics, metric_quality=None):
    timestamp = int(time.time() * 1000)
    signature = hmac.new(config["secret"].encode(), f"{config['deviceId']}:{timestamp}".encode(), hashlib.sha256).hexdigest()
    payload = {"deviceId": config["deviceId"], "timestamp": timestamp,
               "sign": signature, "metrics": metrics, "source": "tcp"}
    if metric_quality:
        payload["metricQuality"] = metric_quality
    request = urllib.request.Request(config["reportUrl"], data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        result = json.loads(response.read().decode("utf-8"))
    if not isinstance(result, dict) or result.get("code") != 0:
        message = result.get("msg", "未知错误") if isinstance(result, dict) else "非 JSON 对象"
        raise RuntimeError(f"云端上报失败：{message}")
    data = result.get("data") or {}
    if not isinstance(data, dict):
        raise RuntimeError("云端返回数据格式错误")
    if data.get("skipped"):
        return "云端节流跳过，本次未更新设备数据"
    if data.get("received") is not True:
        raise RuntimeError("云端未确认收到设备数据")
    return f"云端保存成功，状态={data.get('status', 'unknown')}"


def load_config(filename):
    config = json.loads(EXAMPLE.read_text(encoding="utf-8"))
    if filename.exists():
        config.update(json.loads(filename.read_text(encoding="utf-8-sig")))
    return config


def validate_config(config, read_only=False):
    if not isinstance(config.get("host"), str) or not config["host"].strip():
        raise ValueError("尚未设置传感器 IP：填写配置 host，或使用 --host；可先 --discover 查找端口")
    bounds = {"port": (1, 65535), "timeoutMs": (100, 120000), "waitMs": (0, 60000),
              "intervalMs": (30000, 3600000), "responseBytes": (19, 4096),
              "temperatureOffset": (7, 4090), "humidityOffset": (7, 4090)}
    for key, (low, high) in bounds.items():
        value = config.get(key)
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"{key} 必须是 {low}～{high} 之间的整数")
    if max(config["temperatureOffset"], config["humidityOffset"]) + 4 > config["responseBytes"] - 4:
        raise ValueError("测点位置超出了响应数据区")
    if config["negativeMode"] not in ("unconfirmed", "signed12"):
        raise ValueError("negativeMode 必须是 unconfirmed 或经确认的 signed12")
    address = config.get("responseAddress")
    if address is not None and (type(address) is not int or not 0 <= address <= 247):
        raise ValueError("responseAddress 必须为空或 0～247 之间的整数")
    invalid_humidity = config.get("invalidHumidityValues", [])
    if not isinstance(invalid_humidity, list) or any(type(v) is not int or not 1000 < v <= 65535 for v in invalid_humidity):
        raise ValueError("invalidHumidityValues 只能包含经确认的无效湿度原始值（1001～65535）")
    query = bytes.fromhex(config["requestHex"])
    payload = validate_ascii_frame(query)
    if payload[1] != 4:
        raise ValueError("此采集器只允许功能码 04 的读取请求")
    if not read_only:
        if not isinstance(config.get("secret"), str) or not config["secret"]:
            raise ValueError("缺少设备密钥，请先 --init 并将生成的台账添加到云数据库")
        if not isinstance(config.get("deviceId"), str) or not config["deviceId"]:
            raise ValueError("缺少 deviceId")
        if not config.get("reportUrl", "").startswith("https://"):
            raise ValueError("云端上报必须使用 HTTPS 地址")


def initialize(filename, host=None, port=None):
    device_file = filename.with_name(filename.stem.replace("config", "device") + ".json")
    if filename == device_file or filename.exists() or device_file.exists():
        raise ValueError("配置或设备台账已存在，请直接编辑已有文件")
    config = load_config(EXAMPLE)
    config["host"] = host or ""
    if port is not None:
        config["port"] = port
    config["secret"] = secrets.token_hex(32)
    now = int(time.time() * 1000)
    device = {"deviceId": config["deviceId"], "name": "家庭温湿度传感器 8950", "type": "sensor",
              "model": "LHG8950", "vendor": "韩感", "site": "家中", "enabled": True,
              "maintainFlag": False, "source": "tcp", "secret": config["secret"],
              "status": "offline", "metrics": {}, "lastReportTime": 0, "createdAt": now}
    filename.parent.mkdir(parents=True, exist_ok=True)
    filename.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    device_file.write_text(json.dumps(device, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"配置已生成：{filename}\n云设备记录已生成：{device_file}")
    print("在云开发数据库 devices → 添加记录中粘贴设备文件内容；然后填写配置中的 host。")


def discover(network, port=10050):
    subnet = ipaddress.ip_network(network, strict=False)
    if subnet.version != 4 or subnet.num_addresses > 256 or not subnet.is_private:
        raise ValueError("请使用一个家庭私有 IPv4 网段，例如 192.168.31.0/24（最多 256 个地址）")
    def probe(address):
        try:
            # A cold Windows ARP lookup can exceed 2 seconds before TCP responds.
            with socket.create_connection((str(address), port), timeout=5):
                return str(address)
        except OSError:
            return None
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        found = sorted(filter(None, pool.map(probe, subnet.hosts())), key=ipaddress.ip_address)
    for host in found:
        print(f"开放端口：{host}:{port}（需通过读取报文确认设备）")
    if not found:
        print(f"当前网段未发现可连接的 TCP {port}；请核对传感器 IP、端口和 TCP 服务模式。超时也可能由设备离线或网络过滤造成。")
    return found


def main():
    parser = argparse.ArgumentParser(description="8950 TCP 温湿度采集与微信云端上报")
    parser.add_argument("--config", type=Path, default=LOCAL)
    parser.add_argument("--host", help="传感器 IP，可覆盖配置")
    parser.add_argument("--port", type=int, help="默认 10050")
    parser.add_argument("--init", action="store_true", help="生成本地配置、独立密钥及云端台账")
    parser.add_argument("--discover", metavar="CIDR", help="只探测该家庭网段的指定 TCP 端口")
    parser.add_argument("--decode", metavar="HEX", help="离线解析一条完整接收报文的 HEX")
    parser.add_argument("--read-only", action="store_true", help="读取传感器，不上报云端")
    parser.add_argument("--watch", action="store_true", help="持续采集，Ctrl+C 停止；默认只读一次")
    parser.add_argument("--count", type=int, default=1, help="不使用 --watch 时的采集轮数")
    args = parser.parse_args()
    try:
        if args.init:
            initialize(args.config, args.host, args.port)
            return 0
        if args.discover:
            port = args.port if args.port is not None else 10050
            if not 1 <= port <= 65535:
                raise ValueError("TCP 端口必须是 1～65535")
            return 0 if discover(args.discover, port) else 1
        config = load_config(args.config)
        if args.decode:
            print(json.dumps(parse_response(bytes.fromhex(args.decode), config), ensure_ascii=False))
            return 0
        if args.host:
            config["host"] = args.host
        if args.port is not None:
            config["port"] = args.port
        validate_config(config, args.read_only)
        if args.count < 1:
            raise ValueError("--count 必须至少为 1")
        print(f"采集 {config['host']}:{config['port']}；等待 {config['waitMs']}ms；周期 {config['intervalMs']}ms", flush=True)
        failed = completed = 0
        while args.watch or completed < args.count:
            started = time.monotonic()
            try:
                metrics, frame = read_sensor(config)
                print(f"接收 HEX：{frame.hex(' ')}", flush=True)
                quality = {}
                if "humidity" in metrics:
                    humidity_text = f"{metrics['humidity']:.1f}%RH"
                else:
                    quality["humidity"] = "invalid"
                    humidity_text = "无效，请检查探头（保留有效温度）"
                print(f"温度 {metrics['temp']:.4f}℃；湿度 {humidity_text}", flush=True)
                if not args.read_only:
                    print(post_metrics(config, metrics, quality), flush=True)
            except (OSError, ValueError, RuntimeError) as exc:
                failed += 1
                print(f"采集/上报失败：{exc}", file=sys.stderr, flush=True)
            completed += 1
            if args.watch or completed < args.count:
                time.sleep(max(0, config["intervalMs"] / 1000 - (time.monotonic() - started)))
        return 1 if failed else 0
    except KeyboardInterrupt:
        print("采集已停止。")
        return 0
    except (OSError, ValueError) as exc:
        print(f"配置/操作失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
