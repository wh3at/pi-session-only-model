# pi-session-only-model

A [Pi](https://github.com/earendil-works/pi) extension for switching models within the current session without changing the default model.

Pi's standard `/model` behavior remains unchanged.

## Install

```bash
pi install npm:pi-session-only-model
```

Restart Pi after installation.

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review the [source code](https://github.com/wh3at/pi-session-only-model) before installing third-party packages.

### Pi peer dependency

This package declares `@earendil-works/pi-coding-agent` as a wildcard peer dependency (`"*"`). Pi bundles the host at runtime; the extension is tested against Pi `0.80.10` and later.

### Install from source

```bash
git clone https://github.com/wh3at/pi-session-only-model.git \
  ~/.pi/agent/extensions/pi-session-only-model
```

## Usage

```text
/session-only-model openrouter/tencent/hy3:free
/session-only-model anthropic/claude-sonnet-4-6 --thinking high
/session-only-model --thinking minimal
/session-only-model status
/session-only-model reset
```

## License

MIT
