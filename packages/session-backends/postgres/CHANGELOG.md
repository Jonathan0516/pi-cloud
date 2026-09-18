# Changelog

## [Unreleased]

### Added

- Initial PostgreSQL Session backend: `PostgresSessionRepo`, `PostgresStorage`, `createPostgresClient`, `createSchemaIfMissing`, and `applyInitialSchema`, passing the shared Storage and SessionRepo conformance suites.
- Session leases: `session_leases` table, single-statement acquire/release/heartbeat primitives, a commit-transaction fence (`FencedError`), `SessionLeaseHeldError` with the live holder's address, and the `lease` repository option with a batched heartbeat.
