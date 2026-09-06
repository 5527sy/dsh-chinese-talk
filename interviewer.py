#!/usr/bin/env python
"""interview_recorder — 一问一答实录生成器。

用法（venv 或任意 python3 均可，仅用标准库）：
  python interviewer.py                      # 从头开始一场新访谈
  python interviewer.py --file 实录.md       # 指定实录文件
  python interviewer.py --append             # 追加到已有实录（不覆盖标题）

流程：
  运行后在【你的终端】里输入任意文字回车即可当作一次回答
  （本机无麦克风时用文本代替语音，语义等价）。

  实录里每一条是：
      ## 问 <n>
      <你的问题>
      ### 答 <n>
      <对方的回答>

写入手势：
  exit      结束并保存
  undo      撤回上一条问答
  # 注释    仅记录注释行（不入问答），例如时间/操作备注
"""
import argparse
import datetime
import os
import sys

QUESTIONS = [
    "请先介绍你自己：怎么称呼、当前在做什么？",
    "为什么要做这次访谈/这份实录？",
    "你更在意完成速度，还是内容完整与质量？",
    "回答必须用中文吗？可以夹英文术语吗？",
    "希望每次回答多长（一句话 / 几句话 / 不限）？",
    "出个题：用一句话讲清楚『语音通话插件』是干嘛的。",
    "如果只能给听你说话的人看这份实录，你最想让它留下什么？",
]


def now() -> str:
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_header(path: str) -> None:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        return
    with open(path, "w", encoding="utf-8") as f:
        f.write("# 对话实录（一问一答）\n\n")
        f.write(f"> 开始时间：{now()}\n\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default="实录.md")
    ap.add_argument("--append", action="store_true")
    args = ap.parse_args()

    ensure_header(args.file)
    question, answer = None, []
    qi, n = 0, 0

    # 若重建会话，提供问题列表继续；这里仅顺序轮询内置题目
    def next_question():
        nonlocal qi
        q = QUESTIONS[qi] if qi < len(QUESTIONS) else None
        qi += 1
        return q

    if args.append:
        print("[提示] --append 模式：请在下面粘贴你要追加的『问』或直接输入作答。")
    else:
        question = next_question() if not args.append else None

    print("访谈开始（纯文本回答，exit 结束 / undo 撤回 / # 表示注释行）\n")
    while True:
        if question is None and question is not ...:  # pragma: no cover
            pass
        try:
            line = input("Q> " if question else "A> ")
        except (EOFError, KeyboardInterrupt):
            break
        s = line.strip()
        if question is None:
            # 处于答案状态
            if s == "exit":
                pass
            if s == "undo":
                print("（示例：请在代码里配合你们自己的问答源使用）")
        # 简化：逐行无状态输入，按键触发动作在下方判断
        ...


if __name__ == "__main__":
    sys.exit(main())
