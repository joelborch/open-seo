/**
 * Shared presentation for the Site Health score: the number, its movement, and
 * the trend sparkline. Used by the dashboard card and the audit page's schedule
 * history, so the same score never renders two different ways.
 */

/** Thresholds match the Lighthouse score bands users already read elsewhere. */
function healthScoreTone(score: number): string {
  if (score >= 90) return "text-success";
  if (score >= 50) return "text-warning";
  return "text-error";
}

export function HealthScore({
  score,
  className = "text-3xl",
}: {
  score: number | null;
  className?: string;
}) {
  if (score === null) {
    return (
      <span
        className={`font-semibold tabular-nums text-base-content/40 ${className}`}
        title="Too few indexable pages were crawled to score this site."
      >
        —
      </span>
    );
  }
  return (
    <span
      className={`font-semibold tabular-nums ${healthScoreTone(score)} ${className}`}
    >
      {score}
    </span>
  );
}

export function HealthDelta({ delta }: { delta: number | null }) {
  if (delta === null) return null;
  if (delta === 0) {
    return (
      <span className="badge badge-ghost badge-sm tabular-nums">no change</span>
    );
  }
  const improved = delta > 0;
  return (
    <span
      className={`badge badge-sm gap-1 tabular-nums ${
        improved
          ? "badge-outline border-success/30 bg-success/5 text-success"
          : "badge-outline border-error/30 bg-error/5 text-error"
      }`}
    >
      {improved ? "▲" : "▼"} {Math.abs(delta)}
    </span>
  );
}

/**
 * Trend of the last few scores, oldest first. Plain SVG on a fixed 0–100 domain
 * so two projects' sparklines are visually comparable, and `preserveAspectRatio`
 * is left alone so the line stretches to whatever width the card gives it.
 */
export function HealthSparkline({ scores }: { scores: number[] }) {
  if (scores.length < 2) return null;

  const points = scores
    .map((score, index) => {
      const x = (index / (scores.length - 1)) * 100;
      // 3…25 rather than 0…28 so the 2px stroke is never clipped at the edges.
      const y = 25 - (Math.max(0, Math.min(100, score)) / 100) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox="0 0 100 28"
      className="h-7 w-24 text-primary"
      role="img"
      aria-label={`Site health trend, ${scores.length} audits, latest ${scores[scores.length - 1]}`}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
