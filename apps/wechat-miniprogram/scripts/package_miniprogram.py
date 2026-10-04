"""Package public mini-program sources; exclude runtime files and device credentials."""
import json
import os
import re
import zipfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
VERSION = json.loads((PROJECT / "package.json").read_text(encoding="utf-8"))["version"]
if not re.fullmatch(r"\d+\.\d+\.\d+", VERSION):
    raise ValueError("Invalid release version")
RELEASE = PROJECT.parent.parent / "release"
ARCHIVE = RELEASE / f"ezdaq-wechat-miniprogram-{VERSION}.zip"
SKIP_DIRS = {"node_modules", "__pycache__", ".git", ".local"}


def public_files():
    for current, directories, files in os.walk(PROJECT, followlinks=False):
        directories[:] = [name for name in directories if name not in SKIP_DIRS
                          and not (Path(current) / name).is_symlink()]
        for name in sorted(files):
            source = Path(current) / name
            if name.endswith((".local.json", ".pyc", ".log")) or name.startswith(".env") or source.is_symlink():
                continue
            if not source.resolve().is_relative_to(PROJECT):
                raise ValueError(f"Source outside project: {source}")
            yield source


def main():
    RELEASE.mkdir(parents=True, exist_ok=True)
    files = list(public_files())
    with zipfile.ZipFile(ARCHIVE, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for source in files:
            archive.write(source, f"wechat-miniprogram/{source.relative_to(PROJECT).as_posix()}")
    with zipfile.ZipFile(ARCHIVE) as archive:
        if archive.testzip() is not None:
            raise ValueError("Archive integrity check failed")
        if any(name.endswith(".local.json") or "__pycache__/" in name for name in archive.namelist()):
            raise ValueError("Private gateway files included in archive")
    print(f"Release verified: {ARCHIVE} ({len(files)} files; local credentials excluded)")


if __name__ == "__main__":
    main()
