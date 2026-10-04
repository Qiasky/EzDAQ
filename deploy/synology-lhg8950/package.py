#!/usr/bin/env python3
"""Package the existing standard-library driver for Synology Container Manager."""
import argparse
import importlib.util
import json
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
SCRIPTS = ROOT / "apps" / "wechat-miniprogram" / "scripts"


def build_archive(output, current_config=None):
    example = SCRIPTS / "lhg8950.config.example.json"
    if current_config is not None:
        if not current_config.is_file():
            raise ValueError("找不到当前设备配置，无法生成迁移包")
        spec = importlib.util.spec_from_file_location("lhg8950_gateway", SCRIPTS / "lhg8950_gateway.py")
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        values = gateway.load_config(current_config)
        gateway.validate_config(values)
    else:
        values = json.loads(example.read_text(encoding="utf-8"))
        # Known device A parameters; no private configuration is opened in public mode.
        values.update(host="192.168.31.178", responseAddress=27, invalidHumidityValues=[65535])

    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        for source, name in (
            (SCRIPTS / "lhg8950_gateway.py", "app/lhg8950_gateway.py"),
            (example, "app/lhg8950.config.example.json"),
            (HERE / "docker-compose.yml", "docker-compose.yml"),
            (HERE / "README.md", "README.md"),
        ):
            bundle.write(source, name)
        bundle.writestr("config/lhg8950.config.local.json", json.dumps(values, ensure_ascii=False, indent=2) + "\n")
    return output


def main():
    parser = argparse.ArgumentParser(description="生成群晖 LH8950 采集部署包")
    parser.add_argument("--with-current-config", action="store_true", help="携带当前设备配置和密钥，供迁移到自己的 NAS")
    args = parser.parse_args()
    current_config = SCRIPTS / "lhg8950.config.local.json" if args.with_current_config else None
    name = "synology-lhg8950.private.zip" if args.with_current_config else "synology-lhg8950.zip"
    try:
        output = build_archive(ROOT / "release" / name, current_config)
    except (OSError, ValueError) as exc:
        parser.exit(1, f"打包失败：{exc}\n")
    print(f"部署包已生成：{output}")
    if args.with_current_config:
        print("此包含当前设备密钥，只用于上传到自己的 NAS；release 目录不进入 Git。")
    else:
        print("此包不含设备密钥，启动前需填写 config/lhg8950.config.local.json 的 secret。")


if __name__ == "__main__":
    main()
