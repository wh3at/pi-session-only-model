# Changelog

## Unreleased

- Replace manual provider/model and thinking arguments with a searchable, TUI-only two-stage picker.
- Require an explicit thinking-level selection and apply the confirmed model/thinking pair only to the current session.
- Keep `reset` for restoring the session-start model and thinking level without changing Pi defaults.
- Raise the supported Pi version to `0.83.0` and package the picker runtime and TUI peer dependency.

## 0.1.3

- Publish the validated tarball through an explicit `./release-artifact/` path so npm treats it as a local file.
- Supersede the unpublished `v0.1.2` attempt, which stopped before npm publication when npm interpreted the path as a GitHub shorthand.

## 0.1.2

- Move pre-install npm registry absence checks into `scripts/check-registry-version.mjs` so release eligibility can run before `npm ci`.
- Supersede the unpublished `v0.1.1` attempt, which stopped before OIDC because `verify-package.mjs` required Pi dependencies during module resolution.

## 0.1.1

- Correct the pinned artifact upload and download Action commits used by the OIDC release path.
- Supersede the unpublished `v0.1.0` attempt, which stopped before validation or npm authentication.

## 0.1.0

- Add `/session-only-model <provider>/<model-id>` without changing Pi's existing `/model` behavior.
- Support model IDs containing `/` and `:` such as `openrouter/tencent/hy3:free`.
- Add optional session-only thinking selection through `--thinking`.
- Restore the configured default model on the next startup or session.
- Publish through the secure npm release path: read-only contribution CI, digest-identified tarball verification, and OIDC Trusted Publishing from protected `main`.
- Install with `pi install npm:pi-session-only-model`.

## 0.0.0

- Bootstrap publication for `pi-session-only-model` with the public npm package contract, allowlisted runtime files, and Pi peer dependency.
- Establish secure release tooling: contribution CI, trusted OIDC publication workflow, and post-publication verification workflow.
- Intended as a disposable first registry version before the first OIDC release at `0.1.0`.
