#!/usr/bin/env python
"""fetch_harness — 下载并解压 deepseek-harness 指定 tag 到目标目录。

路径默认按本脚本所在层级相对推导（工作区、上级目录），无盘符写死；
目标 harness 目录可用环境变量 DSH_HARNESS 覆盖。
"""
from __future__ import annotations

import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/dsh-v0.1.3-alpha.1.zip"

_SCRIPT = Path(__file__).resolve()
WORKSPACE = _SCRIPT.parents[2]  # 本脚本位于 <workspace>/<repo>/scripts
DRIVE = _SCRIPT.parents[3]      # workspace 的上一级（下载/解压根）

TARGET = (
    Path(os.environ["DSH_HARNESS"])
    if os.environ.get("DSH_HARNESS")
    else DRIVE / "deepseekharness"
)
TMP = WORKSPACE / "_dl_harness.zip"
EXTRACT_ROOT = DRIVE


def main() -> None:
    TMP.parent.mkdir(parents=True, exist_ok=True)
    print("downloading harness zip ...", flush=True)
    urllib.request.urlretrieve(URL, TMP)
    print("extracting ...", flush=True)
    with zipfile.ZipFile(TMP) as z:
        root = z.namelist()[0].split("/")[0]
        z.extractall(EXTRACT_ROOT)
    src = EXTRACT_ROOT / root
    TARGET.mkdir(parents=True, exist_ok=True)
    for n in os.listdir(src):
        shutil.move(str(src / n), str(TARGET / n))
    shutil.rmtree(src)
    try:
        TMP.unlink()
    except OSError:
        pass
    print(f"done. files in target: {len(os.listdir(TARGET))}", flush=True)


if __name__ == "__main__":
    main()
