"""Run Lantronix's official, read-only DeviceInstaller discovery utility on Windows."""
import argparse
import hashlib
import ipaddress
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

TOOL_URL = "https://ts.lantronix.com/ftp/DeviceInstaller/Command-Line-Utilities/dsearch.exe"
TOOL_SHA256 = "809a7ed393541272a4d578b26e9e10beff28fbeb1cc14741e830edbdaad7ac2a"
LOCAL = Path(__file__).resolve().parents[1] / ".local" / "lantronix"
ROW = re.compile(r"(?P<mac>(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2})\s+(?P<ip>\d+(?:\.\d+){3})\s*$")


def normalize_mac(value):
    compact = re.sub(r"[-:]", "", value.strip())
    if not re.fullmatch(r"[0-9A-Fa-f]{12}", compact):
        raise ValueError("MAC 必须是 6 字节，例如 00-20-4A-12-34-56")
    if compact.upper() in ("000000000000", "FFFFFFFFFFFF") or int(compact[:2], 16) & 1:
        raise ValueError("MAC 必须是有效的单播设备地址")
    return ":".join(compact[index:index + 2].upper() for index in range(0, 12, 2))


def parse_devices(output, interface):
    devices = {}
    for line in output.splitlines():
        match = ROW.search(line)
        if not match:
            continue
        mac = match["mac"].upper()
        address = ipaddress.IPv4Address(match["ip"])
        # The old utility can list its own broadcast with a zero MAC as a device.
        if mac in ("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF") or int(mac[:2], 16) & 1:
            continue
        if str(address) == interface or address.is_unspecified or address.is_multicast:
            continue
        devices[(mac, str(address))] = {"mac": mac, "ip": str(address)}
    return list(devices.values())


def official_tool():
    LOCAL.mkdir(parents=True, exist_ok=True)
    tool = LOCAL / "dsearch.exe"
    if tool.exists():
        content = tool.read_bytes()
    else:
        with urllib.request.urlopen(TOOL_URL, timeout=30) as response:
            content = response.read(200001)
    if hashlib.sha256(content).hexdigest() != TOOL_SHA256:
        raise ValueError("官方搜索工具校验不匹配，请核对 Lantronix 下载源；未运行该文件")
    if not tool.exists():
        tool.write_bytes(content)
    return tool


def main():
    parser = argparse.ArgumentParser(description="用 Lantronix 官方 dsearch 查找 XPort，不修改设备配置")
    parser.add_argument("--interface", required=True, help="连接家庭网络的本机 IPv4 地址")
    parser.add_argument("--mac", help="只匹配指定模块 MAC；省略时读取本地采集配置的 expectedMac")
    args = parser.parse_args()
    try:
        interface = str(ipaddress.IPv4Address(args.interface))
        target = args.mac
        config_file = LOCAL.parent.parent / "scripts" / "lhg8950.config.local.json"
        if not target and config_file.exists():
            target = json.loads(config_file.read_text(encoding="utf-8-sig")).get("expectedMac")
        target = normalize_mac(target) if target else None
        if sys.platform != "win32":
            raise ValueError("官方 dsearch.exe 需要 Windows")
        tool = official_tool()
        print(f"Lantronix 官方发现工具：{tool}\n使用本机接口 {interface}，正在查询…", flush=True)
        if target:
            print(f"匹配目标 MAC：{target}", flush=True)
        process = subprocess.run([str(tool), interface], capture_output=True, timeout=60,
                                 encoding="ascii", errors="replace")
        output = process.stdout + process.stderr
        log = LOCAL / ("dsearch-" + time.strftime("%Y%m%d-%H%M%S") + ".log")
        log.write_text(output, encoding="utf-8")
        if process.returncode:
            raise RuntimeError(f"官方工具退出码 {process.returncode}；原始结果：{log}")
        devices = parse_devices(output, interface)
        (LOCAL / "discovery.local.json").write_text(json.dumps(devices, indent=2) + "\n", encoding="utf-8")
        if target:
            devices = [device for device in devices if device["mac"] == target]
        for device in devices:
            print(f"发现 Lantronix 候选：IP={device['ip']}，MAC={device['mac']}", flush=True)
        print(f"原始查询日志：{log}", flush=True)
        if not devices:
            print("未发现匹配的有效 Lantronix 设备；本机地址及全零 MAC 已过滤。请核对网线链路、接口和设备发现功能。")
            return 1
        print("请与传感器标签 MAC 核对，再检查 TCP 10050；发现结果尚不代表温湿度读取成功。")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"发现失败：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
