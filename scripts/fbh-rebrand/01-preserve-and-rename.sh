#!/usr/bin/env bash
# SDD-01: Preserve & Rename (Phase A Stage 0 + Stage 1)
# Spec: development/opencode/docs/specs/260918_fbh-rebrand_sdd-01-preserve-and-rename.md
# Cardinal rule: do NOT lose Todd's work. Every step is idempotent (CC-2).
set -euo pipefail

PHASE="all"
REPO=""
SOURCE=""
HOME_DIR="${HOME}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --source) SOURCE="$2"; shift 2 ;;
    --home) HOME_DIR="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Resolve repo path
if [[ -z "$REPO" ]]; then
  REPO="$(cd "$(dirname "$0")/../.." && pwd)"
fi

DATE="$(date +%Y%m%d)"
TAG="pre-fork-${DATE}"
BACKUP="${HOME_DIR}/.local/share/foxybear-pre-fork-backup-${DATE}.tar.zst"
MANIFEST="${HOME_DIR}/.local/share/foxybear-pre-fork-backup-${DATE}.manifest.txt"

# API keys are NEVER backed up (CC-Security)
API_KEY_DENYLIST='openai_api.key|anthropic.key|deepinfra.key'

log() { echo "[fbh-sdd-01] $*" >&2; }
already() { echo "[fbh-sdd-01] already done: $1" >&2; }

# --- PHASE: backup (reqs 11-12) ---
do_backup() {
  if [[ -f "$BACKUP" ]]; then already "backup"; return 0; fi
  log "creating backup archive at $BACKUP"
  mkdir -p "$(dirname "$BACKUP")"

  local src_root="${SOURCE:-$HOME_DIR}"
  local sources=()

  # XDG config
  [[ -d "${HOME_DIR}/.config/opencode" ]] && sources+=("${HOME_DIR}/.config/opencode")
  # XDG data
  [[ -d "${HOME_DIR}/.local/share/opencode" ]] && sources+=("${HOME_DIR}/.local/share/opencode")
  # XDG state
  [[ -d "${HOME_DIR}/.local/state/opencode" ]] && sources+=("${HOME_DIR}/.local/state/opencode")
  # XDG cache
  [[ -d "${HOME_DIR}/.cache/opencode" ]] && sources+=("${HOME_DIR}/.cache/opencode")
  # The repo .git (the work to preserve)
  [[ -d "${REPO}/.git" ]] && sources+=("${REPO}/.git")
  # The repo working tree (specs, audit reports, in-flight work)
  [[ -d "${REPO}" ]] && sources+=("${REPO}")

  if [[ ${#sources[@]} -eq 0 ]]; then
    log "ERROR: no source paths found to back up"; exit 1
  fi

  # Create archive, excluding API keys
  tar --zstd -cf "$BACKUP" \
    --exclude="$API_KEY_DENYLIST" \
    -C / "${sources[@]/#\//}" 2>/dev/null || {
      log "ERROR: archive creation failed"; exit 1
    }

  # Verify non-empty
  local size
  size=$(stat -f%z "$BACKUP" 2>/dev/null || stat -c%s "$BACKUP")
  if [[ "$size" -eq 0 ]]; then
    log "ERROR: archive is empty"; exit 1
  fi

  # Manifest
  tar -tf "$BACKUP" > "$MANIFEST"

  # Verify no API keys in archive
  if grep -qE "$API_KEY_DENYLIST" "$MANIFEST"; then
    log "ERROR: API key file found in archive — aborting"; rm -f "$BACKUP" "$MANIFEST"; exit 1
  fi

  log "backup complete: $BACKUP ($(stat -f%z "$BACKUP" 2>/dev/null || stat -c%s "$BACKUP") bytes)"
}

# --- PHASE: commit (reqs 1-2) ---
do_commit() {
  local branch
  branch=$(git -C "$REPO" branch --show-current 2>/dev/null || echo "")
  if [[ "$branch" != "port/foxybear-v2" ]]; then
    log "ERROR: not on port/foxybear-v2 (on '$branch'). Use --repo to target a test repo."; exit 1
  fi

  local status
  status=$(git -C "$REPO" status --porcelain)
  if [[ -z "$status" ]]; then
    already "commit (tree clean)"
    return 0
  fi

  log "committing dirty tree as pre-fork snapshot"
  git -C "$REPO" add -A
  git -C "$REPO" commit -m "chore(pre-fork): snapshot in-flight customizations

Pre-fork snapshot of uncommitted work before FoxyBear harness rebrand (Phase A).
Includes: council fault-tolerance, context/compaction graduated thresholds,
TUI dialog-context, fbh-rebrand SDD spec suite + audit reports.

See: docs/260916_foxybear_fork-rebrand-plan.md (Phase A)
     docs/specs/260918_fbh-rebrand_sdd-01-preserve-and-rename.md"
}

# --- PHASE: push (req 3) ---
do_push() {
  local branch
  branch=$(git -C "$REPO" branch --show-current)
  # Check if origin exists and branch is already pushed
  if git -C "$REPO" rev-parse --verify "origin/${branch}" >/dev/null 2>&1; then
    local unpushed
    unpushed=$(git -C "$REPO" log "origin/${branch}..HEAD" --oneline 2>/dev/null || echo "")
    if [[ -z "$unpushed" ]]; then
      already "push (${branch} up to date with origin)"
      return 0
    fi
  fi
  log "pushing ${branch} to origin"
  git -C "$REPO" push "origin" "${branch}" || {
    log "ERROR: push failed (req 5: abort before tagging)"; exit 1
  }
}

# --- PHASE: tag (req 4, B5: clean-tree assertion) ---
do_tag() {
  if git -C "$REPO" rev-parse --verify "$TAG" >/dev/null 2>&1; then
    already "tag ${TAG}"; return 0
  fi

  # B5: assert clean tree before tagging
  local status
  status=$(git -C "$REPO" status --porcelain)
  if [[ -n "$status" ]]; then
    log "DIRTY_TREE_BLOCK: Resolve pending changes before tagging (req 4, B5)"
    log "$status"
    exit 1
  fi

  local branch head commit_count dirty_commit
  branch=$(git -C "$REPO" branch --show-current)
  head=$(git -C "$REPO" rev-parse HEAD)
  commit_count=$(git -C "$REPO" rev-list --count HEAD)
  # Find the dirty-tree commit (most recent chore(pre-fork) commit)
  dirty_commit=$(git -C "$REPO" log --grep="chore(pre-fork)" --format="%H" -1 2>/dev/null || echo "$head")

  log "tagging ${head:0:12} as ${TAG}"
  git -C "$REPO" tag -a "$TAG" -m "Pre-fork snapshot before FoxyBear harness rebrand (Phase A)

Branch: ${branch}
Commit count: ${commit_count}
Dirty-tree commit: ${dirty_commit:0:12}
Upstream base: v1.4.x

See: docs/260918_fbh-rebrand_sdd-01-preserve-and-rename.md"

  log "pushing tag ${TAG}"
  git -C "$REPO" push origin "$TAG" || {
    log "ERROR: tag push failed"; exit 1
  }
}

# --- PHASE: github-rename (reqs 6-7) — ONE-SHOT, real GitHub repo ---
do_github_rename() {
  local current
  current=$(gh repo view "FoxyBear/opencode" --json name --jq '.name' 2>/dev/null || echo "")
  if [[ "$current" == "foxybear-harness" ]]; then
    already "github rename (FoxyBear/foxybear-harness)"; return 0
  fi
  if [[ "$current" != "opencode" ]]; then
    log "ERROR: FoxyBear/opencode not found or already renamed unexpectedly (got '$current')"; exit 1
  fi
  log "renaming FoxyBear/opencode → FoxyBear/foxybear-harness"
  gh repo rename foxybear-harness --repo FoxyBear/opencode --yes || {
    log "ERROR: gh repo rename failed"; exit 1
  }
  # Verify (req 7)
  local new_url
  new_url=$(gh repo view FoxyBear/foxybear-harness --json url --jq '.url' 2>/dev/null || echo "")
  if [[ -z "$new_url" ]]; then
    log "ERROR: FoxyBear/foxybear-harness does not resolve after rename"; exit 1
  fi
  log "verified: ${new_url}"
}

# --- PHASE: remote (req 8) ---
do_remote() {
  local current
  current=$(git -C "$REPO" remote get-url origin 2>/dev/null || echo "")
  if [[ "$current" == "https://github.com/FoxyBear/foxybear-harness.git" ]]; then
    already "remote origin"; return 0
  fi
  log "updating origin remote → FoxyBear/foxybear-harness"
  git -C "$REPO" remote set-url origin "https://github.com/FoxyBear/foxybear-harness.git"
}

# --- PHASE: dir (reqs 9-10) — rename local directory ---
do_dir() {
  local parent new_dir
  parent=$(dirname "$REPO")
  new_dir="${parent}/foxybear"
  if [[ -d "$new_dir" ]]; then
    already "dir rename (${new_dir})"; return 0
  fi
  if [[ ! -d "$REPO" ]]; then
    log "ERROR: source repo not found at $REPO"; exit 1
  fi
  log "renaming ${REPO} → ${new_dir}"
  mv "$REPO" "$new_dir"
  # Verify .git intact (req 9)
  if [[ ! -d "${new_dir}/.git" ]]; then
    log "ERROR: .git not intact after rename"; exit 1
  fi
  # Verify remote + fetch (req 10)
  git -C "$new_dir" remote -v | grep -q "FoxyBear/foxybear-harness" || {
    log "ERROR: origin remote not FoxyBear/foxybear-harness after rename"; exit 1
  }
  git -C "$new_dir" fetch --all || { log "ERROR: fetch --all failed"; exit 1; }
  log "verified: ${new_dir} (remote + fetch OK)"
}

# --- PHASE: branch (req 13) — rename port/foxybear-v2 → main ---
do_branch() {
  local current
  current=$(git -C "$REPO" branch --show-current)
  if [[ "$current" == "main" ]]; then
    already "branch (main)"; return 0
  fi
  if [[ "$current" != "port/foxybear-v2" ]]; then
    log "ERROR: not on port/foxybear-v2 (on '$current')"; exit 1
  fi
  log "renaming port/foxybear-v2 → main"
  git -C "$REPO" branch -m "port/foxybear-v2" main
  # Push main, delete old remote branch
  git -C "$REPO" push -u origin main || { log "ERROR: push main failed"; exit 1; }
  git -C "$REPO" push origin :port/foxybear-v2 2>/dev/null || log "note: port/foxybear-v2 not on remote (OK)"
}

case "$PHASE" in
  backup) do_backup ;;
  commit) do_commit ;;
  push) do_push ;;
  tag) do_tag ;;
  github-rename) do_github_rename ;;
  remote) do_remote ;;
  dir) do_dir ;;
  branch) do_branch ;;
  all)
    do_backup
    do_commit
    do_push
    do_tag
    do_github_rename
    do_remote
    do_dir
    do_branch
    log "SDD-01 complete."
    ;;
  *) echo "unknown phase: $PHASE" >&2; exit 2 ;;
esac
