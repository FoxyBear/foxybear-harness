# Verification Report: sdd-06 (Re-backfill)
**Date:** 2026-09-27
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-06-re-backfill.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-n/sdd-06.test.ts`

## Summary
- Acceptance tests: 10 pass, 0 fail
- Typecheck: green (exit 0)
- No new test failures (292 pre-existing baseline tolerated)

The backfill script now calls `classify(input)` from the pipeline instead of the old stub extractors. Stub-generated nodes (ENTITY/MEMORY/PROCEDURE with source_path "regex" or "llm") are deleted before re-ingest. Deterministic nodes (ACTION/ERROR/MESSAGE from TraceIngestor) are preserved. TraceIngestor.ingest still runs. Idempotent markers, --all-dbs, --dry-run, progress logging, and resume capability all preserved.

VERDICT: PASS
