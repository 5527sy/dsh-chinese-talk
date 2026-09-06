#!/usr/bin/env python
"""fetch_harness — 下载并解压 deepseek-harness 指定 tag 到目标目录。"""
import os
import shutil
import urllib.request
import zipfile

URL = "https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/dsh-v0.1.3-alpha.1.zip"
TMP = "D:/dsh_workspeace/_dl_harness.zip"
TARGET = "D:/deepseekharness"
EXTRACT_ROOT = "D:/"


def main() -> None:
    os.makedirs(os.path.dirname(TMP), exist_ok=True)
    print("downloading harness zip ...", flush=True)
    urllib.request.urlretrieve(URL, TMP)
    print("extracting ...", flush=True)
    with zipfile.ZipFile(TMP) as z:
        root = z.namelist()[0].split("/")[0]
        z.extractall(EXTRACT_ROOT)
    src = os.path.join(EXTRACT_ROOT, root)
    os.makedirs(TARGET, exist_ok=True)
    for n in os.listdir(src):
        shutil.move(os.path.join(src, n), os.path.join(TARGET, n))
    shutil.rmtree(src)
    os.remove(TMP)
    print(f"done. files in target: {len(os.listdir(TARGET))}", flush=True)


if __name__ == "__main__":
    main()
