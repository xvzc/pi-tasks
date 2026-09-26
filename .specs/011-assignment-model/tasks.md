# Tasks

## T1. Model and persistence

- [x] Add the assignment union, structural validation, cloning, and persisted-schema rejection of `assignee` for active/history records.

Satisfies: S1, S2, S7, S8

## T2. Opaque delegated owners

- [x] Remove package-local owner discovery and resolver plumbing.
- [x] Preserve arbitrary non-empty delegated owner strings exactly as supplied.
- [x] Preserve structural validation and atomic mutation behavior.

Satisfies: S3, S4, S9

## T3. Surfaces and configuration

- [x] Rename config/schema/prompt/display behavior.
- [x] Add `@self` and delegated labels across UI/rendering.
- [x] Update documentation.

Satisfies: S5, S6

## T4. Verification

- [x] Replace registry-parity coverage with opaque-owner and structural-validation coverage.
- [x] Record final full-suite, typecheck, lint, formatting, and diff-check results.

Satisfies: A1, A2, A3, A4, A5
