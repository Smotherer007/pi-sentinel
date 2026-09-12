# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `formatError` no longer claims the working tree was rolled back when
  `autoRollback` is off and the changes are still on disk.
- Globs are now matched against project-relative paths, so `exclude` patterns
  such as `dist/**` also catch absolute paths (previously reduced to a bare
  basename).
- `sentinel_verify`, `sentinel_rollback` and `sentinel_status` use the session
  `cwd` instead of `process.cwd()`, so they act on the correct repository.
- Pipeline subprocesses are killed on abort and run through the platform shell
  (`sh` on POSIX, `cmd.exe` on Windows) instead of assuming `sh` exists.
- `pruneTrace` caps output at exactly `maxLines` while keeping header/footer
  context, strips ANSI escape sequences and collapses duplicate lines.
- `warnOnly` failures are surfaced to the agent as warnings instead of being
  dropped silently.
- The package now exposes `main`/`exports`, so the documented
  `import { defineConfig } from "@patimweb/pi-sentinel"` resolves.

### Added
- Snapshot-based rollback (`src/clients/snapshot.ts`): the pre-state of every
  mutated file is captured before the mutation, so a failed check restores
  exactly those files — including newly created (untracked) ones — without
  touching unrelated uncommitted work.
- `include` config patterns now actually restrict which files trigger
  verification.
- Per-step `cwd`/`env` and per-project state scoping
  (`~/.pi/sentinel-state/<project>.json`).
- `sentinel_rollback` modes (`turn` | `head`) and a `force` escape hatch.

### Changed
- State is persisted once per pipeline run instead of once per step.
- A byte-identical rewrite skips verification entirely.

### Added
- Initial scaffold of `@patimweb/pi-sentinel`.
- In-loop verification guard (edit/write tool hooks).
- Configurable validation pipelines (`tsc`, `eslint`, tests) with timeouts.
- AST/RegEx trace pruning to keep error output token-efficient.
- Git working-tree rollback on invariant violation.
- Tools: `sentinel_verify`, `sentinel_rollback`, `sentinel_status`.
- `/sentinel` command with `status`, `verify`, `test`, `rollback`, `config`.
- `sentinel.config.ts` config manifest with `defineConfig` helper.
- Atomic, permission-safe state persistence (`~/.pi/sentinel-state.json`).
- Semantic-release pipeline config + GitHub Actions CI.
