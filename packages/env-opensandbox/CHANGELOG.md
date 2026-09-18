# Changelog

## [Unreleased]

### Added

- Initial OpenSandbox execution environment: `OpenSandboxExecutionEnv`, `LazySandboxProvider`, and `StaticSandboxProvider`, passing the shared `ExecutionEnv` conformance suite.
- `killSandbox(connectionConfig, sandboxId)` for fencing a taken-over session's sandbox.
