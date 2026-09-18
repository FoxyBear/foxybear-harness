# SDD-01: Preserve & Rename (Stage 0 + Stage 1)

**Date:** 2026-09-18
**Project:** FoxyBear Harness
**Status:** Draft (pending audit + council + human gate)
**Master:** `260918_fbh-rebrand_sdd-00-master.md`
**Depends on:** none. Owns the pre-fork safety contract and the repo rename.

Implements Phase A Stage 0 (backup & snapshot) and Stage 1 (GitHub repo + local dir + remote). Research corrections C-1 through C-4 are resolved here. No code rebrand in this spec — it preserves the work to be rebranded.

## Background

Research found the working tree dirty (14 modified + 5 untracked files, all in-flight customizations), 7 commits unpushed to `origin/port/foxybear-v2`, the working branch is `port/foxybear-v2` (not `dev`), and `origin` is already `FoxyBear/opencode` (not `anomalyco/opencode`). The source plan's Stage 0 backup checklist covers files on disk but not uncommitted git state; its Stage 1 presumes a cross-org rename that is not the actual operation. This spec corrects both.

---

## WHAT

### Git hygiene (research C-2, C-3, C-4)

1. **WHEN** SDD-01 begins, the system **SHALL** verify the working branch is `port/foxybear-v2` and **SHALL** refuse to proceed if on any other branch without an explicit override flag.

2. **WHEN** the working tree is dirty, the system **SHALL** commit all 19 files (14 modified + 5 untracked) as a single commit `chore(pre-fork): snapshot in-flight customizations` on `port/foxybear-v2` before any tagging, OR **SHALL** stash them per Open Question 3. The commit **SHALL** be the union of the research C-3 file list. No file in that list **SHALL** be dropped.

3. **WHEN** the dirty tree is committed, the system **SHALL** push `port/foxybear-v2` to `origin` (`git push origin port/foxybear-v2`) and **SHALL** verify the push succeeded (remote ref matches local HEAD). The 7 unpushed commits identified in research C-4 **SHALL** be on the remote before tagging.

4. **WHEN** the push succeeds, the system **SHALL** assert the working tree is clean (`git status --porcelain` output is empty) before tagging. If non-empty, the system **SHALL** abort with `DIRTY_TREE_BLOCK: commit or stash pending changes before tagging` (per council B5). When clean, the system **SHALL** tag the current HEAD `pre-fork-YYYYMMDD` (date at tag time) on `port/foxybear-v2` and **SHALL** push the tag to `origin` (`git push origin pre-fork-YYYYMMDD`). The tag message **SHALL** record the commit count, the dirty-tree commit hash, and the upstream base (`v1.4.x`).

5. **WHEN** any Step 1–4 operation fails (push rejected, tag exists, branch mismatch), the system **SHALL** abort SDD-01 with a non-zero exit and a message naming the failed step, and **SHALL NOT** proceed to the GitHub rename.

### GitHub repo rename (research C-1)

6. **WHEN** the git hygiene steps pass, the system **SHALL** rename the GitHub repo `FoxyBear/opencode` → `FoxyBear/foxybear-harness` via `gh repo rename foxybear-harness --repo FoxyBear/opencode` (or the equivalent `gh api` call). The rename **SHALL** preserve stars, issues, PRs, Actions, and the automatic redirect from the old name.

7. **WHEN** the rename completes, the system **SHALL** verify `https://github.com/FoxyBear/foxybear-harness` resolves (HTTP 200) and `https://github.com/FoxyBear/opencode` redirects to it (HTTP 301/302 to the new URL). The old `upstream` remote (`anomalyco/opencode`) **SHALL** remain untouched.

### Local directory + remote (research C-1)

8. **WHEN** the GitHub rename is verified, the system **SHALL** update the local git remote: `git -C development/opencode remote set-url origin https://github.com/FoxyBear/foxybear-harness.git`. The `upstream` remote **SHALL** remain `https://github.com/anomalyco/opencode.git`.

9. **WHEN** the remote is updated, the system **SHALL** rename the local directory `development/opencode/` → `development/foxybear/` via `git mv`-safe filesystem rename (the dir is a git repo; rename the top-level dir, not contents). The system **SHALL** verify `development/foxybear/.git` is intact and `git -C development/foxybear status` reports the same branch and clean tree as before the rename.

10. **WHEN** the local dir is renamed, the system **SHALL** verify `git -C development/foxybear remote -v` shows `origin → FoxyBear/foxybear-harness` and `upstream → anomalyco/opencode`, and **SHALL** run `git -C development/foxybear fetch --all` to confirm both remotes fetch cleanly.

### Backup (plan Stage 0 checklist, corrected)

11. **WHEN** SDD-01 begins (before git hygiene), the system **SHALL** create a backup archive at `~/.local/share/foxybear-pre-fork-backup-YYYYMMDD.tar.zst` containing every file from the research §Phase A.5 inventory that exists, EXCLUDING the API key files at `~/Development/.{openai_api,anthropic,deepinfra}.key` (never backed up by the rebrand; research notes they are not opencode-branded). The archive **SHALL** include the `.git` directory of `development/opencode/`.

12. **WHEN** the backup archive is created, the system **SHALL** verify it is non-empty and **SHALL** list its top-level entries to a manifest file `~/.local/share/foxybear-pre-fork-backup-YYYYMMDD.manifest.txt`. The system **SHALL NOT** proceed to git hygiene if the archive is missing any expected file from the inventory (excluding files the inventory marks as "skip").

### License preservation (OQ7)

12b. **WHEN** SDD-01 preserves the work, the system **SHALL** copy `development/opencode/LICENSE` to `development/foxybear/LICENSE` with the original MIT block preserved verbatim (the `Copyright (c) 2025 opencode` line and the full MIT text stay — legally required, cannot strip) AND **SHALL** add a second copyright line `Copyright (c) 2026 Foxy Bear Inc.` below the opencode line. The final license choice (proprietary vs BSD-3 vs MIT vs Apache for the Foxy Bear Inc. modifications) is deferred to publish time per OQ7 — this step applies the interim dual-copyright posture only. The system **SHALL** verify a static grep for `Copyright (c) 2025 opencode` in `development/foxybear/LICENSE` confirms the original line is preserved, and a grep for `Copyright (c) 2026 Foxy Bear Inc.` confirms the new line is added.

### Branch disposition (Open Question 4)

13. **WHEN** the rename is verified and the default for Open Question 4 is `main`, the system **SHALL** rename the local branch `port/foxybear-v2` → `main` (`git branch -m port/foxybear-v2 main`) and **SHALL** push the rename to origin (`git push origin :port/foxybear-v2 main` and set upstream). If Todd chooses to keep `port/foxybear-v2`, this step is a no-op. Either way, the system **SHALL** record the chosen branch name in the SDD state.

---

## HOW

- The SDD-01 implementation is a shell script (`scripts/fbh-rebrand/01-preserve-and-rename.sh` in the workstream state dir) that runs the git hygiene, backup, rename, and verification in order, exiting non-zero on any failure. It is idempotent (CC-2): re-running after success detects the renamed repo and the pushed tag and reports "already done."
- **Backup:** `tar --zstd -cf` the inventory paths. The inventory is hardcoded from research §Phase A.5; API keys excluded via a denylist. The manifest is generated by `tar -tf`.
- **Dirty tree commit:** `git add -A && git commit -m "chore(pre-fork): snapshot in-flight customizations"`. The 19-file union is the entire working tree state (git tracks it); the spec's file list is the assertion basis for VERIFY, not the add command.
- **Push + tag:** `git push origin port/foxybear-v2`, then `git tag -a pre-fork-YYYYMMDD -m "..."`, then `git push origin pre-fork-YYYYMMDD`. Tag-exists check: `git rev-parse pre-fork-YYYYMMDD 2>/dev/null` → if exit 0, skip tagging (idempotent).
- **GitHub rename:** `gh repo rename foxybear-harness --repo FoxyBear/opencode --yes`. Verify: `gh repo view FoxyBear/foxybear-harness --json url` and `curl -sI https://github.com/FoxyBear/opencode` checks for 30x to the new URL.
- **Remote + local dir:** `git remote set-url origin ...`, then `mv development/opencode development/foxybear` (filesystem rename; `.git` travels intact). Verify `git -C development/foxybear remote -v`, `git -C development/foxybear status`, `git -C development/foxybear fetch --all`.
- **Branch rename:** `git branch -m port/foxybear-v2 main && git push -u origin main && git push origin :port/foxybear-v2` (delete old remote branch). Idempotent: if `main` exists and `port/foxybear-v2` doesn't, no-op.
- What is explicitly NOT built: no code rebrand (SDD-02+), no upstream rebase (FBH-FF-001), no brew tap creation (FBH-FF-002).

---

## VERIFY

Acceptance tests live at `test/fbh-rebrand/sdd-01.test.ts`. These are shell-script-level tests (the SDD-01 implementation is a script); they run the script against a throwaway clone of the repo in a tmp dir and assert the outcomes. No mocks of git or gh.

- **V1 — dirty tree committed (reqs 1–2).** Setup: a fresh clone of `FoxyBear/opencode` on `port/foxybear-v2` in a tmp dir; artificially dirty the tree with a test file. Action: run the preserve step. Expected: the test file is committed; `git status` clean; the commit message matches `chore(pre-fork): snapshot in-flight customizations`.
- **V2 — push + tag (reqs 3–4).** Action: run the push+tag step. Expected: `origin/port/foxybear-v2` matches local HEAD; tag `pre-fork-<today>` exists locally and on origin; tag message contains the commit count and dirty-tree hash. Re-run: no-op (idempotent, CC-2).
- **V3 — GitHub rename (reqs 6–7).** Action: run the rename step against the test clone's repo (a throwaway test repo, not the real one). Expected: `gh repo view FoxyBear/<test-repo>-renamed --json url` returns 200; old URL 30x-redirects. NOTE: this V runs against a throwaway GitHub repo created by the test harness, not the real `FoxyBear/opencode`. The real rename is a manual gate step, not automated.
- **V4 — remote + local dir (reqs 8–10).** Action: run the remote+dir step. Expected: `git remote -v` shows `origin → FoxyBear/foxybear-harness`; `upstream` unchanged; `development/foxybear/.git` intact; `git fetch --all` succeeds.
- **V5 — backup archive (reqs 11–12).** Action: run the backup step. Expected: archive exists; manifest lists every inventory file that exists on this machine; API key files are ABSENT from the archive (assert `tar -tf` output contains none of `openai_api.key`, `anthropic.key`, `deepinfra.key`); `.git` is present.
- **V6 — abort on failure (req 5).** Action: run with a simulated push failure (point origin at a non-existent remote). Expected: non-zero exit; message names the failed step; no tag created; no rename attempted.
- **V7 — branch disposition (req 13).** Action: run the branch step with default `main`. Expected: `git branch --show-current` → `main`; `origin/port/foxybear-v2` deleted; `origin/main` exists. Re-run: no-op.
- **V8 — idempotent re-run (CC-2).** Action: run the full script twice. Expected: second run reports "already done" for every step and changes nothing.
- **V9 — no original text lost (CC-1).** Action: before and after the full script, compute `git -C development/foxybear rev-parse HEAD` and `git stash list`. Expected: HEAD advances by exactly the dirty-tree commit (or zero if tree was clean); no stash created (default commits); `git diff pre-fork-<today> HEAD` is empty (the tag is the committed state).
