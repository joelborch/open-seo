// Per-audit bounds. A leaf module with no imports, shared so the launch form, the
// input schema, the server-side tier gate, the crawl scratchpad and the archiver
// all read the same numbers and can't drift apart.
export const MIN_AUDIT_PAGES = 10;
export const DEFAULT_AUDIT_PAGES = 50;
export const FREE_MAX_AUDIT_PAGES = 50;
export const PAID_MAX_AUDIT_PAGES = 10_000;

/**
 * Rows in one `exportLinks` page. The scratchpad DO caps its own page at this
 * number and the archiver asks for exactly it, so the archiver can read a short
 * page as "the edges are done" — two independent 2,000s would silently truncate
 * the archive the moment one of them moved. RPC results cross the DO boundary as
 * a single message capped at 1 MiB; 2,000 rows of source/target URL plus anchor
 * text stays well under it even for long URLs.
 */
export const AUDIT_LINK_EXPORT_MAX_ROWS = 2_000;
