#!/usr/bin/env python
"""register_plugin — 把 dsh-plugin 复制进 deepseek-harness 并完成三处注册（幂等）。

目标：D:/deepseekharness（dsh-v0.1.3-alpha.1）
三处注册：
  1) tsconfig.client.json   references 加 packages/client/ui-voice-call
  2) packages/bundle/web-app/cordis.patch.yml  加 ui-voice-call roster 行
  3) packages/bundle/web-app/package.json       dependencies 加 workspace 依赖
最后把插件源码目录放入 packages/client/ui-voice-call。
"""
from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path

HARNESS = Path("D:/deepseekharness")
PLUGIN_SRC = Path(__file__).resolve().parent.parent / "dsh-plugin"
DEST = HARNESS / "packages" / "client" / "ui-voice-call"
PKG = "@deepseek-ai/dsh-client-ui-voice-call"
ROW_ID = "ui-voice-call"


def log(msg: str) -> None:
    print(msg, flush=True)


def step1_tsconfig() -> None:
    p = HARNESS / "tsconfig.client.json"
    if not p.is_file():
        log(f"!! 跳过 1) 未找到 {p}")
        return
    s = p.read_text(encoding="utf-8")
    needle = './packages/client/ui-voice-call'
    if needle in s:
        log("1) tsconfig.client.json 已包含 ui-voice-call")
        return
    # 找 "./packages/client/ui-voice"（若有）或最后一个 ui-* 引用行后插入
    lines = s.splitlines()
    out, inserted = [], False
    for line in lines:
        out.append(line)
        m = re.search(r'"\./packages/client/(ui-[a-z0-9-]+)"', line)
        if m and not inserted:
            # 在相同字母序附近追加；简单策略：紧接本行后插入
            out.append(line.replace(m.group(1), "ui-voice-call"))
            inserted = True
    if not inserted:
        # 兜底：在 references 数组的最后一个 "{ \"path\"... }" 行后插
        for i in range(len(out) - 1, -1, -1):
            if re.search(r'"\./packages/client/', out[i]):
                out.insert(i + 1, '    { "path": "./packages/client/ui-voice-call" },')
                inserted = True
                break
    if not inserted:
        log("!! 1) 无法定位插入点，请手动添加 references 条目")
        return
    p.write_text("\n".join(out) + "\n", encoding="utf-8")
    log("1) tsconfig.client.json 已更新")


def step2_patch() -> None:
    p = HARNESS / "packages" / "bundle" / "web-app" / "cordis.patch.yml"
    if not p.is_file():
        log(f"!! 跳过 2) 未找到 {p}")
        return
    s = p.read_text(encoding="utf-8")
    if f"- id: {ROW_ID}" in s:
        log("2) cordis.patch.yml 已包含 ui-voice-call")
        return
    block = (
        "\n    # Voice call: mic -> bridge FunASR STT -> conversation.send; "
        "reply streaming TTS.\n"
        f"    - id: {ROW_ID}\n"
        f"      name: '{PKG}'\n"
    )
    # 插到任一 ui- 行之前（保持 roster 区域整洁即可）
    m = re.search(r"^(\s*)- id: ui-", s, re.M)
    if m:
        s = s[: m.start()] + block + s[m.start():]
    else:
        s = s.rstrip() + "\n" + block
    p.write_text(s, encoding="utf-8")
    log("2) cordis.patch.yml 已更新")


def step3_webapp_pkg() -> None:
    p = HARNESS / "packages" / "bundle" / "web-app" / "package.json"
    if not p.is_file():
        log(f"!! 跳过 3) 未找到 {p}")
        return
    data = json.loads(p.read_text(encoding="utf-8"))
    deps = data.setdefault("dependencies", {})
    if PKG in deps:
        log("3) web-app package.json 已包含依赖")
        return
    deps[PKG] = "workspace:^"
    p.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log("3) web-app package.json 已更新")


def copy_plugin() -> None:
    if DEST.is_dir():
        shutil.rmtree(DEST)
    shutil.copytree(PLUGIN_SRC, DEST)
    # 去掉本地编译残留（若有）
    for junk in ("lib", "node_modules"):
        d = DEST / junk
        if d.is_dir():
            shutil.rmtree(d)
    log(f"插件已复制到 {DEST}")


def main() -> None:
    if not HARNESS.is_dir() or not (HARNESS / "package.json").is_file():
        log(f"!! 目标目录不是 deepseek-harness: {HARNESS}")
        return
    copy_plugin()
    step1_tsconfig()
    step2_patch()
    step3_webapp_pkg()
    log("全部完成。接下来在 D:/deepseekharness 执行：pnpm install 然后构建。")


if __name__ == "__main__":
    main()
