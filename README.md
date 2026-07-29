# pi-session-only-model

A [Pi](https://github.com/earendil-works/pi) extension for switching models within the current session without changing the default model.

Pi's standard `/model` behavior remains unchanged.

## Install

```bash
git clone https://github.com/wh3at/pi-session-only-model.git \
  ~/.pi/agent/extensions/pi-session-only-model
```

Restart Pi after installation.

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
