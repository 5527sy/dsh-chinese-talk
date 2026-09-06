# Contributing

Use Node.js 22.19 or newer, pnpm, and Python 3.10 or newer.

Before opening a pull request, run:

```sh
pnpm install
pnpm run check
python -m py_compile bridge/record_sink.py bridge/__init__.py
```

Keep machine-specific paths and model files out of the repository. New deployment settings must use command-line options or environment variables and must be documented in both READMEs.

By submitting a contribution, you agree that it is licensed under Apache-2.0.
