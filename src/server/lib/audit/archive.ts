/**
 * Cold-storage archive of one crawl, written to R2 as gzipped NDJSON shards.
 *
 * Layout and the tooling that reads it (rclone, wrangler, DuckDB httpfs) are
 * documented in docs/CRAWL_ARCHIVE.md:
 *
 *   crawls/{organizationId}/{projectId}/{auditId}/
 *     manifest.json
 *     pages-NNN.ndjson.gz
 *     links-NNN.ndjson.gz
 *     issues.ndjson.gz
 *
 * Runs in the audit worker as its own workflow step, so every read is paged and
 * every part is streamed straight into R2 — the isolate never holds a whole
 * crawl. Writes are plain `put`s on deterministic keys, which is what makes a
 * step retry idempotent: the same rows in the same order produce the same parts,
 * and a retry overwrites them.
 *
 * Only scheduled audits are archived (the workflow's `archive` param). Manual
 * audits are read in the app and cost nothing to re-run, so paying R2 writes for
 * them buys nothing.
 */
import { env } from "cloudflare:workers";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import {
  getIssueRowsForArchive,
  getPageRowsForArchive,
} from "@/server/features/audit/repositories/auditArchiveQueries";

/** Page rows per DB read, and per pages part — one read fills one part. */
const PAGES_PER_PART = 1_000;
/** Rows per exportLinks RPC; the DO caps it at the same number. */
const LINKS_PER_RPC = 2_000;
/** Edges per links part — 10 RPC pages, so parts stay a useful scan unit. */
const LINKS_PER_PART = 20_000;
/** Issue rows per DB read; issues are one streamed file, not sharded. */
const ISSUES_PER_READ = 1_000;

type CrawlArchiveManifest = {
  auditId: string;
  projectId: string;
  organizationId: string;
  startUrl: string;
  archivedAt: string;
  healthScore: number | null;
  pagesConsidered: number;
  /** The crawl stopped at the page budget, so the archive is a partial site. */
  truncated: boolean;
  /** False when the crawl hit the scratchpad's link-storage budget. */
  linkGraphComplete: boolean;
  counts: { pages: number; links: number; issues: number };
  parts: { pages: string[]; links: string[]; issues: string[] };
};

export async function archiveCrawl(input: {
  auditId: string;
  projectId: string;
  organizationId: string;
  startUrl: string;
  healthScore: number | null;
  pagesConsidered: number;
  truncated: boolean;
}): Promise<{ prefix: string; manifest: CrawlArchiveManifest }> {
  const prefix = `crawls/${input.organizationId}/${input.projectId}/${input.auditId}`;

  const pages = await archivePages(prefix, input.auditId);
  const links = await archiveLinks(prefix, input.auditId);
  const issues = await archiveIssues(prefix, input.auditId);

  const manifest: CrawlArchiveManifest = {
    auditId: input.auditId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    startUrl: input.startUrl,
    archivedAt: new Date().toISOString(),
    healthScore: input.healthScore,
    pagesConsidered: input.pagesConsidered,
    truncated: input.truncated,
    linkGraphComplete: links.linkGraphComplete,
    counts: { pages: pages.count, links: links.count, issues: issues.count },
    parts: { pages: pages.parts, links: links.parts, issues: issues.parts },
  };

  await env.R2.put(
    `${prefix}/manifest.json`,
    JSON.stringify(manifest, null, 2),
    {
      httpMetadata: { contentType: "application/json" },
    },
  );

  return { prefix, manifest };
}

/** One part per keyset page of audit_pages. */
async function archivePages(prefix: string, auditId: string) {
  const parts: string[] = [];
  let count = 0;
  let afterId: string | null = null;

  for (;;) {
    const rows = await getPageRowsForArchive({
      auditId,
      afterId,
      limit: PAGES_PER_PART,
    });
    if (rows.length === 0) break;
    const part = `pages-${partSuffix(parts.length + 1)}.ndjson.gz`;
    count += await putNdjsonGz(`${prefix}/${part}`, oneBatch(rows));
    parts.push(part);
    afterId = rows[rows.length - 1].id;
    if (rows.length < PAGES_PER_PART) break;
  }

  return { parts, count };
}

/**
 * Link edges come from the crawl scratchpad DO, which pages them far smaller
 * than a part (its RPC results are one serialized message), so pages are
 * buffered until a part is full.
 */
async function archiveLinks(prefix: string, auditId: string) {
  const scratchpad = getAuditScratchpad(auditId);
  const parts: string[] = [];
  const buffer: Record<string, unknown>[] = [];
  let count = 0;
  let linkGraphComplete = true;
  let cursor: { sourcePageId: string; targetUrl: string } | null = null;

  const writePart = async (rows: Record<string, unknown>[]) => {
    const part = `links-${partSuffix(parts.length + 1)}.ndjson.gz`;
    count += await putNdjsonGz(`${prefix}/${part}`, oneBatch(rows));
    parts.push(part);
  };

  for (;;) {
    const page = await scratchpad.exportLinks({
      afterSourcePageId: cursor?.sourcePageId ?? null,
      afterTargetUrl: cursor?.targetUrl ?? null,
      limit: LINKS_PER_RPC,
    });
    linkGraphComplete = page.linkGraphComplete;
    const last = page.links[page.links.length - 1];
    if (last) {
      cursor = { sourcePageId: last.sourcePageId, targetUrl: last.targetUrl };
      buffer.push(...page.links);
    }
    while (buffer.length >= LINKS_PER_PART) {
      await writePart(buffer.splice(0, LINKS_PER_PART));
    }
    if (page.links.length < LINKS_PER_RPC) {
      // Short page means the frontier of edges is done; flush the remainder so
      // there is no empty trailing part.
      if (buffer.length > 0) await writePart(buffer.splice(0));
      break;
    }
  }

  return { parts, count, linkGraphComplete };
}

/** One streamed file: issues are paged from the DB as the gzip stream pulls. */
async function archiveIssues(prefix: string, auditId: string) {
  const part = "issues.ndjson.gz";
  const count = await putNdjsonGz(`${prefix}/${part}`, issueBatches(auditId));
  return { parts: count > 0 ? [part] : [], count };
}

async function* issueBatches(auditId: string) {
  let afterId: string | null = null;
  for (;;) {
    const rows = await getIssueRowsForArchive({
      auditId,
      afterId,
      limit: ISSUES_PER_READ,
    });
    if (rows.length === 0) return;
    yield rows;
    afterId = rows[rows.length - 1].id;
    if (rows.length < ISSUES_PER_READ) return;
  }
}

async function* oneBatch<T>(rows: T[]) {
  yield rows;
}

/**
 * Write one NDJSON part, gzipping as it goes: the batches are encoded into a
 * ReadableStream that `CompressionStream` pulls from, so neither the joined text
 * nor the compressed body is ever fully resident. Returns the row count.
 */
async function putNdjsonGz(
  key: string,
  batches: AsyncIterable<Record<string, unknown>[]>,
): Promise<number> {
  const encoder = new TextEncoder();
  const iterator = batches[Symbol.asyncIterator]();
  let count = 0;

  // Typed as BufferSource so it lines up with CompressionStream's writable side.
  const source = new ReadableStream<BufferSource>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      count += next.value.length;
      controller.enqueue(
        encoder.encode(
          next.value.map((row) => JSON.stringify(toSnakeCase(row))).join("\n") +
            "\n",
        ),
      );
    },
  });

  await env.R2.put(key, source.pipeThrough(new CompressionStream("gzip")), {
    httpMetadata: {
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    },
  });

  return count;
}

/**
 * Drizzle rows and DO rows are camelCase; the archive is snake_case so the
 * DuckDB queries in docs/CRAWL_ARCHIVE.md read the same names as the database
 * columns. Converting generically (rather than hand-mapping 35 page columns)
 * means a new column reaches the archive without touching this file.
 */
function toSnakeCase(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
      value,
    ]),
  );
}

function partSuffix(partNo: number): string {
  return String(partNo).padStart(3, "0");
}
