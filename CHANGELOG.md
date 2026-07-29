# Changelog

## 0.1.0

- Add `/session-only-model <provider>/<model-id>` without changing Pi's existing `/model` behavior.
- Support model IDs containing `/` and `:` such as `openrouter/tencent/hy3:free`.
- Add optional session-only thinking selection through `--thinking`.
- Restore the configured default model on the next startup or session.
