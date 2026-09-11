/**
 * Site Health score computation.
 *
 * Severity weights correspond to the issue vocabulary in `src/shared/audit-issues.ts`:
 * - Critical issues -> errorPages (weight 1.0)
 * - Warning issues  -> warningPages (weight 0.5)
 * - Info issues     -> noticePages (weight 0.1)
 */

export type SiteHealthInput = {
  pagesConsidered: number; // indexable pages fetched ok
  errorPages: number; // distinct pages with ≥1 critical issue
  warningPages: number; // distinct pages with ≥1 warning and no critical
  noticePages: number; // distinct pages with only info issues
  truncated: boolean; // crawl stopped at the page budget
};

export type SiteHealth = {
  score: number | null;
  penalty: number;
  truncated: boolean;
};

/**
 * Computes a 0–100 site health score based on page-level issue severities.
 *
 * penalty = errorPages + 0.5 * warningPages + 0.1 * noticePages
 * score = Math.round(100 * Math.max(0, 1 - penalty / pagesConsidered))
 *
 * Score is null when pagesConsidered < 10 (sample size too small to be meaningful).
 */
export function computeSiteHealth(input: SiteHealthInput): SiteHealth {
  const rawPenalty =
    input.errorPages + 0.5 * input.warningPages + 0.1 * input.noticePages;
  const penalty = Math.round(rawPenalty * 10) / 10;

  if (input.pagesConsidered < 10) {
    return {
      score: null,
      penalty,
      truncated: input.truncated,
    };
  }

  const score = Math.round(
    100 * Math.max(0, 1 - penalty / input.pagesConsidered),
  );

  return {
    score,
    penalty,
    truncated: input.truncated,
  };
}

/**
 * Returns score change between current and previous site health audits,
 * or null when either audit lacks a score.
 */
export function siteHealthDelta(
  current: SiteHealth,
  previous: SiteHealth,
): number | null {
  if (current.score === null || previous.score === null) {
    return null;
  }
  return current.score - previous.score;
}
