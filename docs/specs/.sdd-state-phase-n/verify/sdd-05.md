# Verification Report: sdd-05 (Wire Into Capture)
**Date:** 2026-09-27
**Spec:** `docs/specs/260926_fbh-phase-n_sdd-05-wire-capture.md`
**Acceptance tests:** `packages/fbh/test/fbh-phase-n/sdd-05.test.ts`

## Summary
- Acceptance tests: 13 pass, 0 fail
- Typecheck: green (exit 0)
- No new test failures (292 pre-existing baseline tolerated)

The capture hook in prompt.ts now calls `classify(input)` from the pipeline instead of the old stub extractors. All stub calls (EntityExtractor.extract, MemoryExtractor.extract, persistEntities, persistMemories) removed. TraceIngestor.ingest preserved. Buffer NOT called directly (pipeline owns it). isMemoryEnabled gate + run.fork async pattern preserved.

VERDICT: PASS
