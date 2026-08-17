# pi-session-only-model

A [Pi](https://github.com/earendil-works/pi) extension for choosing a temporary model and thinking level for the current session without changing the default model.

Pi's standard `/model` behavior remains unchanged.

## Install

```bash
pi install npm:pi-session-only-model
```

Restart Pi after installation.

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review the [source code](https://github.com/wh3at/pi-session-only-model) before installing third-party packages.

### Pi peer dependencies

This package declares `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` as wildcard peer dependencies (`"*"`). Pi supplies these packages at runtime. The extension uses public APIs and requires Pi `0.83.0` or later.

## Install from source

```bash
git clone https://github.com/wh3at/pi-session-only-model.git \
  ~/.pi/agent/extensions/pi-session-only-model
```

## Usage

Run the command without arguments in Pi's interactive TUI:

```text
/session-only-model
```

1. Search and select a model from Pi's current model scope. The search matches provider, provider-qualified model ID, bare model ID, and display name.
2. Select one thinking level supported by that model.
3. Both selections are applied together to the current in-memory session.

Canceling either picker leaves the current model and thinking level unchanged. The picker is TUI-only; direct model arguments, thinking-only arguments, `status`, print mode, JSON mode, and RPC mode are unsupported and do not change state.

Restore the model and thinking level from the start of the session with:

```text
/session-only-model reset
```

The temporary selection does not change Pi defaults, `settings.json`, or normal `/model` persistence.

## License

MIT
