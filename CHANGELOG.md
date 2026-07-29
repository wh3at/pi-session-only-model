# Changelog

## 0.0.0

- Bootstrap publication for `pi-session-only-model` with the public npm package contract, allowlisted runtime files, and Pi peer dependency.
- Establish secure release tooling: contribution CI, trusted OIDC publication workflow, and post-publication verification workflow.
- Intended as a disposable first registry version before the first OIDC release at `0.1.0`.

## 0.1.0

- Add `/session-only-model <provider>/<model-id>` without changing Pi's existing `/model` behavior.
- Support model IDs containing `/` and `:` such as `openrouter/tencent/hy3:free`.
- Add optional session-only thinking selection through `--thinking`.
- Restore the configured default model on the next startup or session.
