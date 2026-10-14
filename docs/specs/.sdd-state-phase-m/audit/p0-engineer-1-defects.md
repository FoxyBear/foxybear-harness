# P-0 Audit — Engineer 1 Defect Log

**Auditor:** Engineer 1 (GLM-5.2, fresh-context agent)
**Date:** 2026-09-22
**Components reviewed:** 11
**Total inputs reviewed:** 114

## Verdict: GO

## Defects filed (7 total — 2 core, 5 non-core)

1. extractTurn (b) — (b) schema-violating: metadata is JSON string not object [CORE]
2. extractTurn (k) — (d) spec-divergent: timeoutMs:1 not honored, extraction completed [CORE]
3. graduation (c) — (c) semantically-wrong: promoted:0 for eligible memory with existing entity
4. graduation (d) — (c) semantically-wrong: contradictions_handled:0 (backtick issue)
5. graduation (g) — (c) semantically-wrong: promoted:1 expected 2 (backtick issue)
6. graduation (j) — (c) semantically-wrong: proj2.promoted:0 expected 1 (backtick issue)
7. prunable (g) — (d) spec-divergent: accessed_at:null NOT prunable (SQL NULL vs JS coercion)

Full details in the decision log: docs/decisions/260921_fbh-phase-m_p0-dormant-code-audit.md
