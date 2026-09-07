#!/bin/bash
#
# rotate-reports.sh — Delete report files older than RETENTION_DAYS from reports/ directory.
#
# Called by cron-run.sh --script cron-rotate <this-script>
# Runs daily at 04:00 via com.<AGENT_NAME>.cron-rotate.plist
#
# Retention policy: keep files from the last 7 days (based on date in filename).
# Files without a parseable date in the filename are skipped.
# .gitkeep is always preserved.
#

set -euo pipefail

RETENTION_DAYS=7
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORTS_DIR="${REPO_ROOT}/shared/outbox/reports"

# Get today's date as epoch seconds (midnight)
TODAY_EPOCH=$(date -j -f "%Y-%m-%d" "$(date +%Y-%m-%d)" "+%s" 2>/dev/null)
if [ -z "${TODAY_EPOCH:-}" ]; then
    echo "ERROR: failed to compute today's epoch" >&2
    exit 1
fi

CUTOFF_EPOCH=$((TODAY_EPOCH - RETENTION_DAYS * 86400))

deleted_count=0
skipped_count=0
errors=()

if [ ! -d "$REPORTS_DIR" ]; then
    echo "ERROR: reports directory not found: $REPORTS_DIR" >&2
    exit 1
fi

for filepath in "$REPORTS_DIR"/*.md; do
    # Handle case where glob matches nothing
    [ -e "$filepath" ] || continue

    filename=$(basename "$filepath")

    # Skip .gitkeep (shouldn't match *.md, but defensive)
    [ "$filename" = ".gitkeep" ] && continue

    # Extract date from filename (first occurrence of YYYY-MM-DD pattern)
    file_date=$(echo "$filename" | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)

    if [ -z "$file_date" ]; then
        echo "WARNING: cannot parse date from filename '$filename', skipping"
        skipped_count=$((skipped_count + 1))
        continue
    fi

    # Convert file date to epoch
    file_epoch=$(date -j -f "%Y-%m-%d" "$file_date" "+%s" 2>/dev/null)
    if [ -z "${file_epoch:-}" ]; then
        echo "WARNING: failed to convert date '$file_date' from '$filename' to epoch, skipping"
        skipped_count=$((skipped_count + 1))
        continue
    fi

    # Check if file is older than retention period
    if [ "$file_epoch" -lt "$CUTOFF_EPOCH" ]; then
        if (cd "$REPO_ROOT" && git rm --quiet "$filepath" 2>/dev/null); then
            deleted_count=$((deleted_count + 1))
        else
            # Fallback: file might not be tracked by git
            rm -f "$filepath"
            deleted_count=$((deleted_count + 1))
            echo "WARNING: git rm failed for '$filename', removed with rm"
        fi
    fi
done

echo "Rotation complete: deleted=$deleted_count skipped=$skipped_count"

if [ "$deleted_count" -gt 0 ]; then
    (
        cd "$REPO_ROOT" \
        && git add shared/outbox/reports/ \
        && git commit -m "chore: rotate reports older than ${RETENTION_DAYS} days (${deleted_count} files removed)" \
        && { git push || { git pull --rebase && git push; }; }
    )
    echo "Committed and pushed deletion of $deleted_count report files"
else
    echo "No expired reports found, nothing to do"
fi

exit 0
