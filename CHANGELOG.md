# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
