import { describe, expect, test } from "bun:test"
import { stripTags } from "../../../src/voice/plugin"

describe("VT-FMT — stripTags preserves layout formatting", () => {
  test("preserves newlines in multi-line text without tags", () => {
    const input = "First line.\nSecond line.\nThird line."
    expect(stripTags(input)).toBe(input)
  })

  test("preserves tabs in text without tags", () => {
    const input = "col1\tcol2\tcol3"
    expect(stripTags(input)).toBe(input)
  })

  test("preserves markdown table structure", () => {
    const input = "| Col1 | Col2 |\n|------|------|\n| a    | b    |"
    expect(stripTags(input)).toBe(input)
  })

  test("preserves code block indentation", () => {
    const input = "```ts\n  const x = 1\n  const y = 2\n```"
    expect(stripTags(input)).toBe(input)
  })

  test("preserves paragraph breaks (double newline)", () => {
    const input = "Paragraph one.\n\nParagraph two."
    expect(stripTags(input)).toBe(input)
  })

  test("preserves list formatting", () => {
    const input = "- item one\n- item two\n  - nested item"
    expect(stripTags(input)).toBe(input)
  })

  test("preserves indentation on subsequent lines", () => {
    const input = "Line 1\n  indented line 2\n  indented line 3"
    expect(stripTags(input)).toBe(input)
  })

  test("does not collapse multiple newlines", () => {
    const input = "Line 1\n\n\n\nLine 2"
    expect(stripTags(input)).toBe(input)
  })

  test("strips tags while preserving newlines between paragraphs", () => {
    const input = "[sighs] First line.\nSecond line.\n[laughs] Third line."
    const result = stripTags(input)
    expect(result.split("\n").length).toBe(3)
    expect(result).toContain("First line.")
    expect(result).toContain("Second line.")
    expect(result).toContain("Third line.")
    expect(result).not.toContain("[sighs]")
    expect(result).not.toContain("[laughs]")
  })

  test("preserves newlines when tag is on its own line", () => {
    const input = "First line.\n[laughs]\nThird line."
    const result = stripTags(input)
    expect(result.split("\n").length).toBe(3)
    expect(result).toContain("First line.")
    expect(result).toContain("Third line.")
    expect(result).not.toContain("[laughs]")
  })

  test("preserves markdown table with tags in cells", () => {
    const input = "| [sighs] Col1 | Col2 |\n|------|------|\n| a    | b    |"
    const result = stripTags(input)
    expect(result.split("\n").length).toBe(3)
    expect(result).toContain("|")
    expect(result).toContain("------")
    expect(result).not.toContain("[sighs]")
  })

  test("preserves numbered list with tags", () => {
    const input = "1. [curious] First item\n2. Second item\n3. [excited] Third item"
    const result = stripTags(input)
    expect(result.split("\n").length).toBe(3)
    expect(result).toContain("1.")
    expect(result).toContain("2.")
    expect(result).toContain("3.")
    expect(result).not.toContain("[curious]")
    expect(result).not.toContain("[excited]")
  })

  test("preserves blockquote formatting with tags", () => {
    const input = "> [sighs] Quoted text\n> More quoted text"
    const result = stripTags(input)
    expect(result.split("\n").length).toBe(2)
    expect(result).toContain(">")
    expect(result).toContain("Quoted text")
    expect(result).toContain("More quoted text")
    expect(result).not.toContain("[sighs]")
  })

  test("preserves complex box-drawing report without tags", () => {
    const input = [
      "I'll create a comprehensive test output with various formatting elements for you to review your changes.",
      "╔════════════════════════════════════════════════════════════════════════════╗",
      "║                        TEST EXECUTION REPORT                              ║",
      "║                     Generated: 2026-08-11 14:32:15 UTC                    ║",
      "╚════════════════════════════════════════════════════════════════════════════╝",
      "┌─ SUMMARY ─────────────────────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│  Total Tests:        847                                                  │",
      "│  Passed:             812 ✓                                                │",
      "│  Failed:             18 ✗                                                 │",
      "│  Skipped:            17 ⊘                                                 │",
      "│  Warnings:           12 ⚠                                                 │",
      "│  Duration:           23m 47s                                              │",
      "│  Success Rate:       95.9%                                                │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ TEST SUITE BREAKDOWN ──────────────────────────────────────────────────────┐",
      "│                                                                              │",
      "│ Suite Name                          │ Passed │ Failed │ Skipped │ Duration │",
      "│ ────────────────────────────────────┼────────┼────────┼─────────┼──────────│",
      "│ Unit Tests - Core                   │   234  │   2    │    0    │   3.2s   │",
      "│ Unit Tests - Utils                  │   156  │   0    │    3    │   2.1s   │",
      "│ Integration Tests - API              │   189  │   8    │    2    │   8.4s   │",
      "│ Integration Tests - Database         │   142  │   5    │    8    │   5.3s   │",
      "│ E2E Tests - User Flow                │    61  │   2    │    3    │   3.7s   │",
      "│ E2E Tests - Admin Panel              │    30  │   1    │    1    │   1.1s   │",
      "│                                                                              │",
      "└──────────────────────────────────────────────────────────────────────────────┘",
      "┌─ FAILED TESTS DETAIL ──────────────────────────────────────────────────────┐",
      "│                                                                             │",
      "│ [FAIL] Unit Tests - Core › validateUserInput                              │",
      "│   Error: Expected true, got false                                         │",
      "│   Location: src/validators/user.test.ts:456                               │",
      "│   Duration: 24ms                                                          │",
      "│                                                                             │",
      "│ [FAIL] Integration Tests - API › POST /api/users (timeout)                │",
      "│   Error: Request timeout after 5000ms                                     │",
      "│   Location: tests/integration/users.test.ts:892                           │",
      "│   Duration: 5023ms                                                        │",
      "│                                                                             │",
      "│ [FAIL] E2E Tests - User Flow › Complete checkout process                  │",
      "│   Error: Element #submit-button not found within timeout                  │",
      "│   Location: tests/e2e/checkout.test.ts:445                                │",
      "│   Duration: 15234ms                                                       │",
      "│                                                                             │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ PERFORMANCE METRICS ──────────────────────────────────────────────────────┐",
      "│                                                                             │",
      "│ Component                     │ Avg Time │ Min Time │ Max Time │ Status   │",
      "│ ──────────────────────────────┼──────────┼──────────┼──────────┼──────────│",
      "│ Authentication Module         │   45ms   │   12ms   │  234ms   │   OK    │",
      "│ User Service                  │   78ms   │   23ms   │  512ms   │   OK    │",
      "│ Product Catalog               │   156ms  │   45ms   │  1,200ms │  WARN   │",
      "│ Email Delivery Service        │   1,234ms│   456ms  │  8,900ms │  SLOW   │",
      "│ Database Queries (avg)        │   34ms   │   5ms    │  487ms   │   OK    │",
      "│ Cache Operations              │   2ms    │   1ms    │   15ms   │   OK    │",
      "│                                                                             │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ CODE COVERAGE REPORT ─────────────────────────────────────────────────────┐",
      "│                                                                             │",
      "│ Module                        │ Lines   │ Branches │ Functions │ Statements│",
      "│ ──────────────────────────────┼─────────┼──────────┼───────────┼───────────│",
      "│ src/auth/                     │  92.3%  │  87.5%   │   94.1%   │   91.8%   │",
      "│ src/services/                 │  78.9%  │  72.3%   │   81.2%   │   77.4%   │",
      "│ src/utils/                    │  96.7%  │  94.2%   │   98.3%   │   96.1%   │",
      "│ src/database/                 │  68.4%  │  61.2%   │   72.1%   │   67.8%   │",
      "│                                                                             │",
      "│ TOTAL COVERAGE                │  83.7%  │  78.3%   │   86.0%   │   82.8%   │",
      "│                                                                             │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ WARNINGS ────────────────────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│ [WARN] Deprecated API usage in src/handlers/legacy.ts                    │",
      "│        Function `parseUserAgent()` scheduled for removal in v3.0          │",
      "│                                                                            │",
      "│ [WARN] Missing test coverage in src/database/migrations.ts               │",
      "│        Coverage: 45% (threshold: 80%)                                     │",
      "│                                                                            │",
      "│ [WARN] Slow test detected: E2E › Admin Panel › Generate reports          │",
      "│        Duration: 8,234ms (expected: < 5,000ms)                            │",
      "│                                                                            │",
      "│ [WARN] Flaky test: Integration › API › GET /api/health                   │",
      "│        Failed 2 out of 5 runs in this batch                               │",
      "│                                                                            │",
      "│ [WARN] Memory leak suspected in PaymentService                           │",
      "│        Heap delta: +45MB over 100 iterations                              │",
      "│                                                                            │",
      "│ [WARN] High complexity detected: src/services/OrderService.ts            │",
      "│        Cyclomatic complexity: 18 (threshold: 10)                          │",
      "│                                                                            │",
      "│ [WARN] Unhandled promise rejection in test queue cleanup                │",
      "│        May cause intermittent failures in CI/CD                          │",
      "│                                                                            │",
      "│ [WARN] Database index missing on users.email                             │",
      "│        Query performance degraded by ~340%                                │",
      "│                                                                            │",
      "│ [WARN] Test timeout increased to 10s (was 5s)                            │",
      "│        May mask real performance issues                                    │",
      "│                                                                            │",
      "│ [WARN] Deprecated Node.js API usage: fs.readFile callback                │",
      "│        Use promisified version in src/utils/file-io.ts:89                 │",
      "│                                                                            │",
      "│ [WARN] SQL query N+1 detected in ProductController.getDetails()          │",
      "│        Optimization recommended                                           │",
      "│                                                                            │",
      "│ [WARN] Potential XSS vulnerability in user input sanitization            │",
      "│        Review src/validators/sanitize.ts before production release        │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ SKIPPED TESTS ───────────────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│ [SKIP] Unit Tests - Utils › parseISO8601Date (requires Node 18+)          │",
      "│ [SKIP] Unit Tests - Utils › cryptoRandomBytes (flaky in CI)               │",
      "│ [SKIP] Unit Tests - Utils › getSystemMemory (platform-specific)           │",
      "│ [SKIP] Integration - Database › PostgreSQL array types (requires v12+)    │",
      "│ [SKIP] Integration - Database › UUID comparison (marked for refactor)     │",
      "│ [SKIP] Integration - API › OAuth2 flow (requires live service)            │",
      "│ [SKIP] Integration - API › Stripe integration (requires API key)          │",
      "│ [SKIP] E2E › Admin Panel › Bulk user import (data setup incomplete)      │",
      "│ [SKIP] E2E › User Flow › Mobile payment (requires device emulator)        │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ DETAILED EXECUTION LOG ──────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│ [14:32:15.023] Starting test suite: Unit Tests - Core                   │",
      "│ [14:32:15.145] ✓ validateEmail (12ms)                                   │",
      "│ [14:32:15.167] ✓ validatePassword (8ms)                                 │",
      "│ [14:32:15.234] ✗ validateUserInput (24ms)                               │",
      "│ [14:32:15.312] ✓ createUser (34ms)                                      │",
      "│ [14:32:15.401] ✓ updateUser (28ms)                                      │",
      "│ [14:32:15.523] ✓ deleteUser (19ms)                                      │",
      "│ [14:32:15.687] ✓ getUserById (7ms)                                      │",
      "│ [14:32:15.823] ✓ listUsers (45ms)                                       │",
      "│                                                                            │",
      "│ [14:32:16.124] Starting test suite: Unit Tests - Utils                  │",
      "│ [14:32:16.234] ✓ arrayFilter (5ms)                                      │",
      "│ [14:32:16.289] ✓ arrayMap (4ms)                                         │",
      "│ [14:32:16.401] ✓ stringTrim (3ms)                                       │",
      "│ [14:32:16.534] ✓ objectMerge (8ms)                                      │",
      "│                                                                            │",
      "│ [14:32:17.001] Starting test suite: Integration Tests - API              │",
      "│ [14:32:17.234] ✓ GET /api/health (23ms)                                 │",
      "│ [14:32:17.512] ✓ POST /api/users (145ms)                                │",
      "│ [14:32:17.834] ✗ POST /api/users (timeout) (5023ms)                     │",
      "│ [14:32:22.923] ✗ GET /api/products/search (156ms)                       │",
      "│                                                                            │",
      "│ [14:32:50.234] SUMMARY: 812 passed, 18 failed, 17 skipped                │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "╔════════════════════════════════════════════════════════════════════════════╗",
      "║                         END OF REPORT                                     ║",
      "║          All artifacts available in ./test-results/                        ║",
      "╚════════════════════════════════════════════════════════════════════════════╝",
    ].join("\n")

    const result = stripTags(input)
    const inputLines = input.split("\n")
    const resultLines = result.split("\n")

    // Line count preserved
    expect(resultLines.length).toBe(inputLines.length)

    // Box-drawing characters preserved
    expect(result).toContain("╔")
    expect(result).toContain("╚")
    expect(result).toContain("╝")
    expect(result).toContain("╗")
    expect(result).toContain("║")

    // Section headers preserved
    expect(result).toContain("TEST EXECUTION REPORT")
    expect(result).toContain("SUMMARY")
    expect(result).toContain("TEST SUITE BREAKDOWN")
    expect(result).toContain("FAILED TESTS DETAIL")
    expect(result).toContain("PERFORMANCE METRICS")
    expect(result).toContain("CODE COVERAGE REPORT")
    expect(result).toContain("WARNINGS")
    expect(result).toContain("SKIPPED TESTS")
    expect(result).toContain("DETAILED EXECUTION LOG")
    expect(result).toContain("END OF REPORT")

    // Table structure preserved (alignment spaces within lines)
    expect(result).toContain("│  Total Tests:        847")
    expect(result).toContain("│  Passed:             812")
    expect(result).toContain("│  Success Rate:       95.9%")

    // Table separators preserved
    expect(result).toContain("│ ────────────────────────────────────┼────────┼────────┼─────────┼──────────│")

    // [FAIL], [WARN], [SKIP] bracket tokens NOT stripped (not in vocabulary)
    expect(result).toContain("[FAIL]")
    expect(result).toContain("[WARN]")
    expect(result).toContain("[SKIP]")

    // Timestamps preserved
    expect(result).toContain("[14:32:15.023]")
    expect(result).toContain("[14:32:50.234]")

    // Coverage data preserved
    expect(result).toContain("83.7%")
    expect(result).toContain("78.3%")
    expect(result).toContain("86.0%")
    expect(result).toContain("82.8%")

    // First line preserved
    expect(result).toContain("I'll create a comprehensive test output")

    // No audio tags in the text, so no tags should be added
    expect(result).not.toContain("[laughs]")
    expect(result).not.toContain("[sighs]")
  })

  test("preserves complex box-drawing report WITH tags interspersed", () => {
    const input = [
      "[sighs] Here's the test report.",
      "╔════════════════════════════════════════════════════════════════════════════╗",
      "║                        TEST EXECUTION REPORT                              ║",
      "╚════════════════════════════════════════════════════════════════════════════╝",
      "┌─ SUMMARY ─────────────────────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│  Total Tests:        847                                                  │",
      "│  [excited] Passed:             812 ✓                                     │",
      "│  [sighs] Failed:             18 ✗                                        │",
      "│  Skipped:            17 ⊘                                                 │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
      "┌─ WARNINGS ────────────────────────────────────────────────────────────────┐",
      "│                                                                            │",
      "│ [WARN] [laughs] Deprecated API usage in src/handlers/legacy.ts           │",
      "│        Function `parseUserAgent()` scheduled for removal in v3.0          │",
      "│                                                                            │",
      "│ [WARN] Memory leak suspected in [whispers] PaymentService              │",
      "│        Heap delta: +45MB over 100 iterations                              │",
      "│                                                                            │",
      "└────────────────────────────────────────────────────────────────────────────┘",
    ].join("\n")

    const result = stripTags(input)
    const resultLines = result.split("\n")

    // Line count preserved (tags stripped, but newlines intact)
    // Lines with tags may have leading/trailing spaces collapsed but structure intact
    expect(resultLines.length).toBe(input.split("\n").length)

    // Tags stripped
    expect(result).not.toContain("[sighs]")
    expect(result).not.toContain("[excited]")
    expect(result).not.toContain("[laughs]")
    expect(result).not.toContain("[whispers]")

    // [WARN] tokens preserved (not in vocabulary)
    expect(result).toContain("[WARN]")

    // Box-drawing structure preserved
    expect(result).toContain("╔")
    expect(result).toContain("╚")
    expect(result).toContain("┌─")
    expect(result).toContain("└")

    // Content preserved
    expect(result).toContain("TEST EXECUTION REPORT")
    expect(result).toContain("Total Tests:        847")
    expect(result).toContain("Passed:")
    expect(result).toContain("812")
    expect(result).toContain("Failed:")
    expect(result).toContain("18")
    expect(result).toContain("Deprecated API usage")
    expect(result).toContain("Memory leak suspected")
    expect(result).toContain("PaymentService")

    // Table structure intact
    expect(result).toContain("│  Total Tests:")
  })
})
