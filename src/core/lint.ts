/**
 * Epistemology lint — detect unattributed factual claims in compiled_truth fields.
 *
 * Per Spec 04, every factual claim must carry a source attribution tag of the form:
 *   [observed: ...]  [self-described: ...]  [reported: ...]  [inferred: ...]
 *
 * Lines that are blank, markdown headers, or very short (< 20 chars) are skipped.
 * Warnings are raised for bullet-point lines (starting with `-`) and paragraph
 * lines that lack the attribution tag.
 */

export interface LintWarning {
  line: number;
  text: string;
  rule: string;
  suggestion: string;
}

/**
 * Pattern that matches a valid source attribution tag anywhere on the line.
 * Accepted prefixes: observed, self-described, reported, inferred.
 */
const SOURCE_TAG_RE = /\[(?:observed|self-described|reported|inferred):/;

/**
 * Pattern that matches a source tag containing a date.
 * Captures the full tag content and the trailing YYYY-MM-DD date.
 * Matches: [source-type: ..., YYYY-MM-DD]
 */
const SOURCE_TAG_DATE_RE = /\[(?:observed|self-described|reported|inferred):[^\]]*,\s*(\d{4}-\d{2}-\d{2})\s*\]/g;

/**
 * Detect claims in `compiledTruth` that lack a `[source-type: ...]` attribution tag.
 *
 * @param compiledTruth - The compiled_truth string of a page.
 * @returns Array of LintWarning, one per offending line.
 */
export function lintUnattributed(compiledTruth: string): LintWarning[] {
  const warnings: LintWarning[] = [];

  const lines = compiledTruth.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip blank lines
    if (trimmed.length === 0) continue;

    // Skip markdown headers
    if (trimmed.startsWith('#')) continue;

    // Skip very short lines (likely labels, standalone keywords, etc.)
    if (trimmed.length < 20) continue;

    const isBullet = trimmed.startsWith('-');
    const isParagraph = !isBullet && !trimmed.startsWith('>') && !trimmed.startsWith('|');

    if (!isBullet && !isParagraph) continue;

    // If line already carries an attribution tag, it's fine
    if (SOURCE_TAG_RE.test(trimmed)) continue;

    warnings.push({
      line: lineNum,
      text: trimmed,
      rule: 'unattributed-claim',
      suggestion:
        'Add a source attribution tag: [observed: ...], [self-described: ...], [reported: ...], or [inferred: ...]',
    });
  }

  return warnings;
}

/** Default staleness threshold in days. */
const DEFAULT_STALE_THRESHOLD_DAYS = 90;

/** Per-type default staleness thresholds (days). */
const TYPE_STALE_THRESHOLDS: Record<string, number> = {
  company: 180,
  person: 90,
};

/**
 * Resolve the staleness threshold for a page based on its types.
 * Explicit thresholdDays > per-type default (max across types) > global 90-day default.
 */
function resolveThreshold(explicitDays: number | undefined, pageTypes?: string[]): number {
  if (explicitDays !== undefined) return explicitDays;
  if (pageTypes && pageTypes.length > 0) {
    const typeThresholds = pageTypes
      .map(t => TYPE_STALE_THRESHOLDS[t])
      .filter((v): v is number => v !== undefined);
    if (typeThresholds.length > 0) return Math.max(...typeThresholds);
  }
  return DEFAULT_STALE_THRESHOLD_DAYS;
}

/**
 * Detect claims in `compiledTruth` whose source attribution dates are older than
 * `thresholdDays` days, indicating the information may be stale.
 *
 * Only lines that carry a dated source tag of the form
 *   [source-type: ..., YYYY-MM-DD]
 * are considered. Lines without any date are left to lintUnattributed.
 *
 * @param compiledTruth  - The compiled_truth string of a page.
 * @param thresholdDays  - Age in days beyond which a claim is considered stale. Overrides per-type defaults.
 * @param pageTypes      - The page's types array. Used to select per-type default thresholds when thresholdDays is not provided.
 * @returns Array of LintWarning, one per stale dated tag found.
 */
export function lintStale(compiledTruth: string, thresholdDays?: number, pageTypes?: string[]): LintWarning[] {
  const effectiveThreshold = resolveThreshold(thresholdDays, pageTypes);
  const warnings: LintWarning[] = [];
  const today = new Date();
  // Normalise to midnight UTC so date arithmetic is day-accurate.
  today.setUTCHours(0, 0, 0, 0);
  const thresholdMs = effectiveThreshold * 24 * 60 * 60 * 1000;

  const lines = compiledTruth.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const trimmed = lines[i].trim();

    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.length < 20) continue;

    // Reset lastIndex before each exec loop (regex is stateful with /g flag).
    SOURCE_TAG_DATE_RE.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = SOURCE_TAG_DATE_RE.exec(trimmed)) !== null) {
      const dateStr = match[1]; // YYYY-MM-DD captured group
      const claimDate = new Date(dateStr + 'T00:00:00Z');

      if (isNaN(claimDate.getTime())) continue;

      const ageMs = today.getTime() - claimDate.getTime();
      if (ageMs > thresholdMs) {
        warnings.push({
          line: lineNum,
          text: trimmed,
          rule: 'stale-claim',
          suggestion: `Claim dated ${dateStr} is older than ${effectiveThreshold} days. Add [stale: last-verified ${dateStr}] or re-verify and update the date.`,
        });
        // One warning per line is enough even if multiple stale tags appear.
        break;
      }
    }
  }

  return warnings;
}
