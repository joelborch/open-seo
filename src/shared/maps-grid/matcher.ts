/**
 * Maps grid candidate matcher: scores Google Maps ranking candidates against
 * a business location identity and identifies the target business listing.
 *
 * Ported from `tools/studio-tools/apps/analytics/scripts/local_intent/google_maps_radius_grid.py`.
 */

export interface MatchIdentity {
  brandName: string;
  domain: string;
  slug: string;
  phone?: string;
  street?: string;
  address?: string;
  postalCode?: string;
  matchTerms: string[];
}

export interface CandidateItem {
  title: string;
  url?: string;
  domain?: string;
  phone?: string;
  phone_number?: string;
  phoneNumber?: string;
  address?: string;
  zip?: string;
  postal_code?: string;
  postalCode?: string;
  rankGroup?: number;
  rank_group?: number;
  rankAbsolute?: number;
  rank_absolute?: number;
  placeId?: string;
  place_id?: string;
  cid?: string;
  rating?: number;
  reviewsCount?: number;
  reviews_count?: number;
  address_info?: Record<string, unknown>;
  addressInfo?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MatchScoreResult {
  score: number;
  reasons: string[];
  hard: boolean;
  accepted: boolean;
  [Symbol.iterator](): Iterator<unknown>;
}

export interface FindTargetResult {
  target: CandidateItem | null;
  brandFallback: CandidateItem | null;
  reasons: string[];
  score: number;
  [Symbol.iterator](): Iterator<unknown>;
}

function normalize(text: unknown): string {
  return String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function digits(text: unknown): string {
  return String(text ?? "").replace(/\D+/g, "");
}

function getStreetNumber(street?: string): string {
  const match = (street ?? "").match(/\d+/);
  return match ? match[0] : "";
}

function getItemPhone(candidate: CandidateItem): string {
  if (candidate.phone) return String(candidate.phone);
  if (candidate.phone_number) return String(candidate.phone_number);
  if (candidate.phoneNumber) return String(candidate.phoneNumber);
  const contact =
    candidate.contact_url ?? candidate.contactUrl ?? candidate.url;
  return contact ? String(contact) : "";
}

function getItemAddress(candidate: CandidateItem): string {
  const bits: string[] = [];
  const info = (candidate.address_info ?? candidate.addressInfo) as
    | Record<string, unknown>
    | undefined;

  if (info && typeof info === "object") {
    for (const key of ["address", "city", "zip", "region"]) {
      if (info[key]) {
        bits.push(String(info[key]));
      }
    }
  }

  if (candidate.address) {
    bits.push(String(candidate.address));
  }
  const zip = candidate.zip ?? candidate.postal_code ?? candidate.postalCode;
  if (zip && !bits.includes(String(zip))) {
    bits.push(String(zip));
  }

  return bits.join(" ");
}

function getItemUrlText(candidate: CandidateItem): string {
  const parts = [
    candidate.url,
    candidate.domain,
    candidate.website,
    candidate.contact_url,
    candidate.contactUrl,
    candidate.check_url,
    candidate.checkUrl,
  ];
  return parts.filter(Boolean).map(String).join(" ");
}

function getRank(item: CandidateItem): number | null {
  for (const val of [
    item.rankGroup,
    item.rank_group,
    item.rankAbsolute,
    item.rank_absolute,
  ]) {
    if (val !== undefined && val !== null) {
      const num = Number(val);
      if (Number.isInteger(num) && num > 0) {
        return num;
      }
      if (!Number.isNaN(num) && num > 0) {
        return Math.floor(num);
      }
    }
  }
  return null;
}

function matchesBrandTitle(title: string, brandName: string): boolean {
  const brandNorm = normalize(brandName);
  if (!brandNorm) {
    return false;
  }
  const brandWithoutThe = brandNorm.replace(/^the\s+/, "");
  return (
    title.includes(brandNorm) ||
    title.includes(`the ${brandNorm}`) ||
    (brandWithoutThe.length > 0 && title.includes(brandWithoutThe))
  );
}

/**
 * Checks whether an item belongs to the target brand (by title or domain).
 */
export function isBrandMatch(
  item: CandidateItem,
  identity: MatchIdentity,
): boolean {
  const title = normalize(item.title);
  const urlText = normalize(getItemUrlText(item));
  const domainNorm = normalize(identity.domain);

  return (
    matchesBrandTitle(title, identity.brandName) ||
    (Boolean(domainNorm) && urlText.includes(domainNorm))
  );
}

/**
 * Scores a candidate listing against a target business identity:
 * - Phone digits match: +7 (hard match)
 * - Domain + `/locations/<slug>`: +4 (hard match)
 * - Brand title match: +4 (identity signal)
 * - Domain in URL text: +3 (identity signal)
 * - Postal code in address: +2
 * - Street number in address: +2
 * - Match term in title, address, or URL: +2
 * - Soft to hard promotion: if identity matched (brand_title or domain) and has
 *   a location anchor (postal, street_number, or match_term), hard is promoted to true.
 * - Accept target if hard is true and score >= 7.
 */
export function scoreCandidate(
  candidate: CandidateItem,
  identity: MatchIdentity,
): MatchScoreResult {
  const title = normalize(candidate.title);
  const address = normalize(getItemAddress(candidate));
  const urlText = normalize(getItemUrlText(candidate));
  const phoneDigits = digits(getItemPhone(candidate));

  const locPhone = digits(identity.phone).slice(-10);
  const postal = identity.postalCode
    ? String(identity.postalCode).trim().toLowerCase()
    : "";
  const streetNo = getStreetNumber(identity.street ?? identity.address);
  const matchTerms = (identity.matchTerms ?? []).map(normalize).filter(Boolean);
  const domainNorm = normalize(identity.domain);

  let score = 0;
  const reasons: string[] = [];
  let hard = false;
  let hasIdentity = false;

  // 1. Brand title (+4)
  if (matchesBrandTitle(title, identity.brandName)) {
    score += 4;
    reasons.push("brand_title");
    hasIdentity = true;
  }

  // 2. Domain in URL (+3)
  if (domainNorm && urlText.includes(domainNorm)) {
    score += 3;
    reasons.push("domain");
    hasIdentity = true;
  }

  // 3. Phone digits match (+7 hard)
  if (locPhone && phoneDigits.includes(locPhone)) {
    score += 7;
    reasons.push("phone");
    hard = true;
    hasIdentity = true;
  }

  // 4. Postal match (+2)
  if (postal && address.includes(postal)) {
    score += 2;
    reasons.push("postal");
  }

  // 5. Street number match (+2)
  if (streetNo && address.includes(streetNo)) {
    score += 2;
    reasons.push("street_number");
  }

  // 6. Match term in title, address, or url (+2)
  if (
    matchTerms.some(
      (term) =>
        term &&
        (title.includes(term) ||
          address.includes(term) ||
          urlText.includes(term)),
    )
  ) {
    score += 2;
    reasons.push("location_term");
  }

  // 7. Location URL with slug (+4 hard)
  const slug = identity.slug ? normalize(identity.slug) : "";
  if (
    domainNorm &&
    urlText.includes(domainNorm) &&
    slug &&
    urlText.includes(`/locations/${slug}`)
  ) {
    score += 4;
    reasons.push("location_url");
    hard = true;
    hasIdentity = true;
  }

  // Soft to hard promotion:
  // If identity matched (brand_title or domain) and has location disambiguation
  // (postal or street_number or location_term), promote hard to true.
  if (
    hasIdentity &&
    !hard &&
    (reasons.includes("brand_title") || reasons.includes("domain")) &&
    (reasons.includes("postal") ||
      reasons.includes("street_number") ||
      reasons.includes("location_term"))
  ) {
    hard = true;
  }

  const isHard = Boolean(hasIdentity && hard);
  const accepted = Boolean(isHard && score >= 7);

  return {
    score,
    reasons,
    hard: isHard,
    accepted,
    *[Symbol.iterator]() {
      yield this.score;
      yield this.reasons;
      yield this.hard;
      yield this.accepted;
    },
  };
}

/**
 * Evaluates candidate items from Google Maps SERP against a business identity.
 * Finds the accepted target listing (highest score, lowest rank wins ties),
 * along with the highest-ranked brand fallback listing.
 */
export function findTarget(
  items: CandidateItem[],
  identity: MatchIdentity,
): FindTargetResult {
  let best: { score: number; item: CandidateItem; reasons: string[] } | null =
    null;
  let bestBrand: CandidateItem | null = null;

  for (const item of items) {
    if (isBrandMatch(item, identity)) {
      const currentRank = getRank(item) ?? 999;
      const bestBrandRank = bestBrand ? (getRank(bestBrand) ?? 999) : 999;
      if (!bestBrand || currentRank < bestBrandRank) {
        bestBrand = item;
      }
    }

    const match = scoreCandidate(item, identity);
    if (match.hard && match.score >= 7) {
      const itemRank = getRank(item) ?? 999;
      const bestRank = best ? (getRank(best.item) ?? 999) : 999;
      if (
        best === null ||
        match.score > best.score ||
        (match.score === best.score && itemRank < bestRank)
      ) {
        best = { score: match.score, item, reasons: match.reasons };
      }
    }
  }

  const target = best ? best.item : null;
  const reasons = best ? best.reasons : [];
  const score = best ? best.score : 0;

  return {
    target,
    brandFallback: bestBrand,
    reasons,
    score,
    *[Symbol.iterator]() {
      yield this.target;
      yield this.brandFallback;
      yield this.reasons;
      yield this.score;
    },
  };
}
