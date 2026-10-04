#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
设备上报模拟器 —— 本地/内网调试用
作用：在还没有真实设备接入时，用它造数据，验证「上报 → 状态判定 → 告警生成」整条链路

★ 这个脚本对应云函数 deviceReport 的接口协议，换真网关时只需替换调用方式

用法：
  python mock_device.py --url https://你的云函数HTTP地址
  python mock_device.py --url xxx --count 5 --interval 2 --abnormal
  python mock_device.py --url xxx --devices DEV001,DEV002 --no-sleep   # 一次性全发

仅使用 Python 标准库，无需安装额外依赖。
"""
import argparse
import hashlib
import hmac
import json
import random
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime

# ===== 设备台账（与云数据库 devices 集合对应）=====
DEVICES = [
    {
        "deviceId": "DEV001",
        "name": "1# 循环水泵",
        "type": "pump",
        "site": "东侧循环水站",
        "secret": "test-secret-dev001",   # ★ 与云端 devices.secret 一致
        "source": "modbus",
        "normal": {"vibration": 2.1, "temp": 52, "current": 62, "pressure": 0.004, "rpm": 2950},
        "abnormal": {"vibration": 8.3, "temp": 96, "current": 108, "pressure": 0.07, "rpm": 3100},
    },
    {
        "deviceId": "DEV002",
        "name": "2# 送风机",
        "type": "fan",
        "site": "屋顶风机房",
        "secret": "test-secret-dev002",
        "source": "modbus",
        "normal": {"vibration": 1.8, "temp": 48, "current": 45, "pressure": 0.002, "rpm": 1450},
        "abnormal": {"vibration": 5.2, "temp": 82, "current": 88, "pressure": 0.03, "rpm": 1520},
    },
    {
        "deviceId": "DEV003",
        "name": "真空机组 A",
        "type": "vacuum",
        "site": "真空室下层",
        "secret": "test-secret-dev003",
        "source": "opcua",
        "normal": {"vibration": 1.2, "temp": 45, "current": 38, "pressure": 0.001, "rpm": 900},
        "abnormal": {"vibration": 3.1, "temp": 79, "current": 82, "pressure": 0.025, "rpm": 950},
    },
]


def sign(device_id, ts, secret):
    """与云函数 deviceReport 里的验签逻辑严格一致"""
    payload = f"{device_id}:{ts}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def report(url, dev, metrics):
    ts = int(time.time() * 1000)
    body = {
        "deviceId": dev["deviceId"],
        "timestamp": ts,
        "sign": sign(dev["deviceId"], ts, dev["secret"]),
        "metrics": metrics,
        "source": dev["source"],
    }
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"}, method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            r = json.loads(resp.read().decode("utf-8"))
        if not isinstance(r, dict):
            raise ValueError("接口未返回 JSON 对象")
        result_data = r.get("data") or {}
        if not isinstance(result_data, dict):
            result_data = {}
        flag = "✓" if r.get("code") == 0 else "✗"
        note = "（被节流跳过）" if result_data.get("skipped") else ""
        print(f"  {flag} {dev['name']:<12} 状态={result_data.get('status', r.get('msg'))}{note}")
        return r
    except urllib.error.HTTPError as e:
        print(f"  ✗ {dev['name']:<12} HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:120]}")
    except Exception as e:
        print(f"  ✗ {dev['name']:<12} {type(e).__name__}: {e}")
    return None


def jitter(metrics, ratio=0.03):
    """给正常值加小幅抖动，避免每次数据一模一样"""
    out = {}
    for k, v in metrics.items():
        out[k] = round(v * (1 + random.uniform(-ratio, ratio)), 3)
    return out


def main():
    ap = argparse.ArgumentParser(description="设备上报模拟器")
    ap.add_argument("--url", required=True, help="deviceReport 的 HTTP 访问地址")
    ap.add_argument("--devices", default="", help="设备ID 逗号分隔，默认全部")
    ap.add_argument("--count", type=int, default=3, help="上报轮数")
    ap.add_argument("--interval", type=int, default=35, help="轮次间隔秒数（须>30，否则被节流）")
    ap.add_argument("--abnormal", action="store_true", help="注入异常值，触发告警")
    ap.add_argument("--no-sleep", action="store_true", help="不等间隔，一次性全发（会被节流，仅调试用）")
    args = ap.parse_args()
    if args.count < 1:
        ap.error("--count 必须至少为 1")
    if args.interval < 0:
        ap.error("--interval 不可为负数")

    devices = DEVICES
    if args.devices:
        want = set(args.devices.split(","))
        devices = [d for d in DEVICES if d["deviceId"] in want]
    if not devices:
        print("没有匹配的设备")
        return 1

    print(f"目标: {args.url}")
    print(f"设备: {', '.join(d['deviceId'] for d in devices)}")
    print(f"轮数: {args.count}  间隔: {args.interval}s  模式: {'异常' if args.abnormal else '正常'}")
    print("-" * 56)

    succeeded = skipped = failed = 0
    for i in range(args.count):
        print(f"\n第 {i + 1}/{args.count} 轮 · {datetime.now().strftime('%H:%M:%S')}")
        for dev in devices:
            base = dev["abnormal"] if args.abnormal else dev["normal"]
            result = report(args.url, dev, jitter(base))
            if result and result.get("code") == 0:
                succeeded += 1
                result_data = result.get("data") or {}
                if isinstance(result_data, dict) and result_data.get("skipped"):
                    skipped += 1
            else:
                failed += 1
        if i < args.count - 1 and not args.no_sleep:
            print(f"  … 等待 {args.interval}s")
            time.sleep(args.interval)

    print(f"\n完成：成功 {succeeded} 次（其中节流跳过 {skipped} 次），失败 {failed} 次。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
