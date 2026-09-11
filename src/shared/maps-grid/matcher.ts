import { z } from "zod";

/**
 * Deciding which row of a Google Maps pack is the client's own listing.
 *
 * A grid cell's whole value depends on this being right: score the wrong row and
 * the heatmap reports a competitor's position as the client's. Name alone is not
 * enough — multi-location brands return several near-identical titles — so a row
 * is only accepted once a hard identity signal (phone, or the domain plus this
 * location's slug) or a brand signal anchored to this address (postal code,
 * street number, a configured match term) lines up.
 *
 * The scoring is a port of
 * `tools/studio-tools/apps/analytics/scripts/local_intent/google_maps_radius_grid.py`;
 * `fixtures/matcher-cases.json` holds that script's decisions and the tests
 * assert equality against them.
 */

const addressInfoSchema = z
  .object({
    address: z.string().nullable().optional(),
    borough: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    zip: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * One row of a `/v3/serp/google/maps/task_get/advanced` result. The shape is the
 * provider's, so matching, the persisted cell results and the Zod validation at
 * the API boundary all read the same fields instead of three near-copies.
 * Unknown keys pass through: DataForSEO adds columns without warning, and we
 * only act on the ones named here.
 */
export const mapsCandidateItemSchema = z
  .object({
    type: z.string().nullable().optional(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    title: z.string().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    address_info: addressInfoSchema.nullable().optional(),
    place_id: z.string().nullable().optional(),
    cid: z.string().nullable().optional(),
    // Maps returns the rating as a block, not a bare number — the review count
    // lives in `votes_count` rather than a top-level `reviews_count`.
    rating: z
      .object({
        value: z.number().nullable().optional(),
        votes_count: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    category: z.string().nullable().optional(),
  })
  .passthrough();

export type CandidateItem = z.infer<typeof mapsCandidateItemSchema>;

/** Who we are looking for: the location's own identity plus its extra aliases. */
export interface MatchIdentity {
  brandName: string;
  domain: string;
  slug: string;
  phone?: string | null;
  street?: string | null;
  postalCode?: string | null;
  matchTerms: string[];
}

/**
 * Why a row scored what it did. Order of the array is evaluation order, which
 * the parity fixtures assert — a reordering here is a behavior change.
 */
type MatchReason =
  | "brand_title"
  | "domain"
  | "phone"
  | "postal"
  | "street_number"
  | "location_term"
  | "location_url";

interface CandidateMatch {
  score: number;
  reasons: MatchReason[];
  /** An identity signal tied to this specific location, not just the brand. */
  hard: boolean;
  /** Good enough to call this row the client's listing. */
  accepted: boolean;
}

interface TargetMatch {
  /** The accepted row, or null when nothing cleared the bar. */
  target: CandidateItem | null;
  /**
   * Best-ranked row that merely looks like the brand. Reported so the UI can
   * say "we found something that might be you" instead of a bare "not found".
   */
  brandFallback: CandidateItem | null;
  reasons: MatchReason[];
  score: number;
}

/** Rank we treat a listing as holding: the pack position it was returned at. */
const NO_RANK = Number.MAX_SAFE_INTEGER;

/** Minimum score for an accepted target, on top of a hard identity signal. */
const ACCEPT_SCORE = 7;

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function digitsOnly(value: string | null | undefined): string {
  return (value ?? "").replace(/\D+/g, "");
}

/** Ranked pack position, or null when the row carries neither rank field. */
export function candidateRank(item: CandidateItem): number | null {
  for (const value of [item.rank_group, item.rank_absolute]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}

/** Everything in a row that could carry the client's address. */
function addressText(item: CandidateItem): string {
  const info = item.address_info;
  const parts = [info?.address, info?.city, info?.zip, info?.region];
  if (item.address) parts.push(item.address);
  return normalize(parts.filter(Boolean).join(" "));
}

/** Everything in a row that could carry the client's domain or slug. */
function urlText(item: CandidateItem): string {
  return normalize([item.url, item.domain].filter(Boolean).join(" "));
}

/**
 * Brand names drift by a leading article between Google and a CRM, so "The
 * Airway Dentists" and "Airway Dentists" have to read as the same brand.
 */
function matchesBrandTitle(title: string, brandName: string): boolean {
  const brand = normalize(brandName);
  if (!brand) return false;
  return (
    title.includes(brand) ||
    title.includes(brand.replace(/^the\s+/, "")) ||
    title.includes(`the ${brand}`)
  );
}

/** Does this row belong to the brand at all (by title or by domain)? */
export function isBrandMatch(
  item: CandidateItem,
  identity: MatchIdentity,
): boolean {
  const domain = normalize(identity.domain);
  return (
    matchesBrandTitle(normalize(item.title), identity.brandName) ||
    (domain !== "" && urlText(item).includes(domain))
  );
}

/**
 * Score one row against the location's identity.
 *
 * Brand title +4 and domain-in-URL +3 say "this is the right company"; phone +7
 * and domain-plus-`/locations/<slug>` +4 say "this is the right office" and are
 * hard on their own. Postal code, street number and match terms add +2 each and
 * can promote a soft brand signal to hard — which is the whole point: a brand
 * name that also carries this location's ZIP is this location, while a brand
 * name on its own could be any of thirty offices.
 */
export function scoreCandidate(
  item: CandidateItem,
  identity: MatchIdentity,
): CandidateMatch {
  const title = normalize(item.title);
  const address = addressText(item);
  const urls = urlText(item);
  const itemPhoneDigits = digitsOnly(item.phone);

  const domain = normalize(identity.domain);
  const slug = normalize(identity.slug);
  // Last 10 digits: the provider returns E.164 while configs hold local format.
  const identityPhone = digitsOnly(identity.phone).slice(-10);
  const postalCode = normalize(identity.postalCode);
  const streetNumber = /\d+/.exec(identity.street ?? "")?.[0] ?? "";
  const matchTerms = identity.matchTerms.map(normalize).filter(Boolean);

  const reasons: MatchReason[] = [];
  let score = 0;
  let hasIdentity = false;
  let hard = false;

  if (matchesBrandTitle(title, identity.brandName)) {
    score += 4;
    reasons.push("brand_title");
    hasIdentity = true;
  }
  if (domain !== "" && urls.includes(domain)) {
    score += 3;
    reasons.push("domain");
    hasIdentity = true;
  }
  if (identityPhone !== "" && itemPhoneDigits.includes(identityPhone)) {
    score += 7;
    reasons.push("phone");
    hasIdentity = true;
    hard = true;
  }
  if (postalCode !== "" && address.includes(postalCode)) {
    score += 2;
    reasons.push("postal");
  }
  if (streetNumber !== "" && address.includes(streetNumber)) {
    score += 2;
    reasons.push("street_number");
  }
  if (
    matchTerms.some(
      (term) =>
        title.includes(term) || address.includes(term) || urls.includes(term),
    )
  ) {
    score += 2;
    reasons.push("location_term");
  }
  if (
    domain !== "" &&
    slug !== "" &&
    urls.includes(domain) &&
    urls.includes(`/locations/${slug}`)
  ) {
    score += 4;
    reasons.push("location_url");
    hasIdentity = true;
    hard = true;
  }

  // A brand signal plus any address-level anchor identifies the office, not just
  // the company, so it counts as hard.
  const anchored =
    reasons.includes("postal") ||
    reasons.includes("street_number") ||
    reasons.includes("location_term");
  if (hasIdentity && !hard && anchored) hard = true;

  const isHard = hasIdentity && hard;
  return {
    score,
    reasons,
    hard: isHard,
    accepted: isHard && score >= ACCEPT_SCORE,
  };
}

/**
 * Pick the client's listing out of one cell's pack. Highest accepted score wins;
 * the better-ranked row breaks a tie, so a tied pair resolves to the listing
 * Google actually put first rather than to array order.
 */
export function findTarget(
  items: CandidateItem[],
  identity: MatchIdentity,
): TargetMatch {
  let best: { item: CandidateItem; match: CandidateMatch } | null = null;
  let brandFallback: CandidateItem | null = null;

  for (const item of items) {
    if (isBrandMatch(item, identity)) {
      const rank = candidateRank(item) ?? NO_RANK;
      const bestBrandRank = brandFallback
        ? (candidateRank(brandFallback) ?? NO_RANK)
        : NO_RANK;
      if (!brandFallback || rank < bestBrandRank) brandFallback = item;
    }

    const match = scoreCandidate(item, identity);
    if (!match.accepted) continue;
    if (
      !best ||
      match.score > best.match.score ||
      (match.score === best.match.score &&
        (candidateRank(item) ?? NO_RANK) <
          (candidateRank(best.item) ?? NO_RANK))
    ) {
      best = { item, match };
    }
  }

  return {
    target: best?.item ?? null,
    brandFallback,
    reasons: best?.match.reasons ?? [],
    score: best?.match.score ?? 0,
  };
}
