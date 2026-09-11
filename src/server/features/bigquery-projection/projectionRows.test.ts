import { describe, expect, it } from "vitest";
import {
  buildAuditProjection,
  buildMapsProjection,
  buildProjectionObservation,
  buildRankProjection,
  PROJECTION_SOURCE,
  type AuditRunSource,
  type MapsRunSource,
  type RankRunSource,
} from "./projectionRows";

const PULLED_AT = "2026-03-04T05:06:07.000Z";

function auditSource(
  overrides: Partial<AuditRunSource["run"]> = {},
  issueCounts: AuditRunSource["issueCounts"] = [],
): AuditRunSource {
  return {
    run: {
      id: "run-audit",
      cadence: "deep",
      triggeredAt: "2026-03-01 01:02:03",
      completedAt: "2026-03-02 04:05:06",
      pagesCrawled: 120,
      pagesWithErrors: 3,
      pagesWithWarnings: null,
      pagesWithNotices: null,
      pagesBlocked: null,
      healthScore: 88,
      healthScoreDelta: null,
      ...overrides,
    },
    issueCounts,
  };
}

describe("buildAuditProjection", () => {
  it("reports the completion date and drops unmeasured metrics", () => {
    const result = buildAuditProjection({
      source: auditSource(),
      pulledAt: PULLED_AT,
    });

    expect(result.reportDate).toBe("2026-03-02");
    expect(result.rowsByTable.weekly_health_metrics).toEqual([
      {
        report_date: "2026-03-02",
        metric: "crawl_health_score",
        value: 88,
        detail: "deep",
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-audit",
        request_id: null,
      },
      {
        report_date: "2026-03-02",
        metric: "crawl_pages_crawled",
        value: 120,
        detail: "deep",
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-audit",
        request_id: null,
      },
      {
        report_date: "2026-03-02",
        metric: "crawl_pages_with_errors",
        value: 3,
        detail: "deep",
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-audit",
        request_id: null,
      },
    ]);
  });

  it("falls back to the trigger date and names one metric per issue type", () => {
    const result = buildAuditProjection({
      source: auditSource({ completedAt: null, healthScore: null }, [
        { issueType: "missing_title", severity: "error", pages: 7 },
      ]),
      pulledAt: PULLED_AT,
    });

    expect(result.reportDate).toBe("2026-03-01");
    expect(result.rowsByTable.weekly_health_metrics).toContainEqual(
      expect.objectContaining({
        metric: "crawl_issue_missing_title",
        value: 7,
        detail: "error",
      }),
    );
  });
});

function rankSource(
  snapshots: RankRunSource["snapshots"],
  features: RankRunSource["features"] = [],
  aioCitations: RankRunSource["aioCitations"] = [],
): RankRunSource {
  return {
    run: {
      id: "run-rank",
      startedAt: "2026-03-01 00:00:00",
      completedAt: "2026-03-03 09:00:00",
    },
    config: {
      locationName: "Chicago,Illinois,United States",
      locationCode: 2840,
    },
    snapshots,
    features,
    aioCitations,
  };
}

function snapshot(
  overrides: Partial<RankRunSource["snapshots"][number]> = {},
): RankRunSource["snapshots"][number] {
  return {
    id: 1,
    keyword: "dentist chicago",
    device: "desktop",
    position: 4,
    url: "https://example.com/",
    aioPresent: true,
    aioClientCited: true,
    aioCitationPosition: 2,
    aioBrandMentioned: true,
    aioSnippet: "Chicago dentists offering same-day crowns include…",
    ...overrides,
  };
}

describe("buildRankProjection", () => {
  it("keeps the desktop snapshot when a run checked both devices", () => {
    const result = buildRankProjection({
      source: rankSource([
        snapshot({ id: 1, device: "mobile", position: 9 }),
        snapshot({ id: 2, device: "desktop", position: 4 }),
      ]),
      pulledAt: PULLED_AT,
    });

    expect(result.rowsByTable.keyword_rankings).toEqual([
      {
        date: "2026-03-03",
        keyword: "dentist chicago",
        location: "Chicago,Illinois,United States",
        surface: "organic",
        rank: 4,
        url: "https://example.com/",
        top_domains: null,
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-rank",
        request_id: null,
      },
    ]);
  });

  it("adds a keyword_rankings row per SERP feature the client appears in", () => {
    const result = buildRankProjection({
      source: rankSource(
        [snapshot({ id: 5 })],
        [
          {
            snapshotId: 5,
            featureType: "local_pack",
            rankAbsolute: 2,
            clientPresent: true,
          },
          {
            snapshotId: 5,
            featureType: "people_also_ask",
            rankAbsolute: 6,
            clientPresent: false,
          },
        ],
      ),
      pulledAt: PULLED_AT,
    });

    expect(
      result.rowsByTable.keyword_rankings?.map((row) => [
        row.surface,
        row.rank,
      ]),
    ).toEqual([
      ["organic", 4],
      ["local_pack", 2],
    ]);
  });

  it("writes aio_tracking only for snapshots that were evaluated", () => {
    const result = buildRankProjection({
      source: rankSource(
        [
          snapshot({ id: 1, keyword: "evaluated" }),
          snapshot({ id: 2, keyword: "not evaluated", aioPresent: null }),
        ],
        [],
        [
          // In citation order, as the query returns them — and only the
          // evaluated snapshot's citations reach a row.
          { snapshotId: 1, domain: "rival.com" },
          { snapshotId: 1, domain: "example.com" },
          { snapshotId: 2, domain: "ignored.com" },
        ],
      ),
      pulledAt: PULLED_AT,
    });

    expect(result.rowsByTable.aio_tracking).toEqual([
      {
        report_date: "2026-03-03",
        keyword: "evaluated",
        tier: null,
        aio_present: true,
        client_domain_cited: true,
        citation_position: 2,
        client_name_mentioned: true,
        cited_domains: '["rival.com","example.com"]',
        aio_text_snippet: "Chicago dentists offering same-day crowns include…",
        organic_rank: 4,
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-rank",
        request_id: null,
      },
    ]);
  });

  it("uses the location code when the config has no location name", () => {
    const source = rankSource([snapshot()]);
    source.config = { locationName: null, locationCode: 2840 };
    const result = buildRankProjection({ source, pulledAt: PULLED_AT });

    expect(result.rowsByTable.keyword_rankings?.[0]?.location).toBe("2840");
  });
});

function mapsSource(): MapsRunSource {
  return {
    run: {
      id: "run-maps",
      startedAt: "2026-03-01 00:00:00",
      completedAt: "2026-03-05 12:00:00",
    },
    locationSlug: "north-office",
    cells: [
      {
        id: 10,
        keyword: "emergency dentist",
        lat: 41.9,
        lng: -87.6,
        clientRank: 3,
        providerTaskId: "task-10",
      },
    ],
    cellResults: [
      {
        cellId: 10,
        name: "Competitor C",
        rank: 4,
        rating: 4.1,
        url: "https://c.example",
        isClient: false,
      },
      {
        cellId: 10,
        name: "Client",
        rank: 3,
        rating: 4.9,
        url: "https://client.example",
        isClient: true,
      },
      {
        cellId: 10,
        name: "Competitor A",
        rank: 1,
        rating: 4.5,
        url: "https://a.example",
        isClient: false,
      },
      {
        cellId: 10,
        name: "Competitor B",
        rank: 2,
        rating: null,
        url: "https://b.example",
        isClient: false,
      },
      {
        cellId: 10,
        name: "Competitor D",
        rank: 5,
        rating: 3.2,
        url: "https://d.example",
        isClient: false,
      },
    ],
  };
}

describe("buildMapsProjection", () => {
  it("projects one row per cell with the top three non-client competitors", () => {
    const result = buildMapsProjection({
      source: mapsSource(),
      pulledAt: PULLED_AT,
    });

    expect(result.rowsByTable.maps_rankings).toEqual([
      {
        report_date: "2026-03-05",
        keyword: "emergency dentist",
        office: "north-office",
        rank_type: "maps",
        position: 3,
        ranked_url: "https://client.example",
        grid_lat: 41.9,
        grid_lng: -87.6,
        competitors: [
          { name: "Competitor A", position: 1, rating: 4.5 },
          { name: "Competitor B", position: 2, rating: null },
          { name: "Competitor C", position: 4, rating: 4.1 },
        ],
        source: PROJECTION_SOURCE,
        pulled_at: PULLED_AT,
        run_id: "run-maps",
        request_id: "task-10",
      },
    ]);
  });
});

describe("buildProjectionObservation", () => {
  it("derives a stable sha256 observation id from run, metric and dimensions", async () => {
    const input = {
      clientKey: "airway",
      runKind: "maps_grid_run" as const,
      runId: "run-maps",
      projectId: "project-1",
      reportDate: "2026-03-05",
      rowCount: 49,
      pulledAt: PULLED_AT,
    };
    const first = await buildProjectionObservation(input);
    const second = await buildProjectionObservation({
      ...input,
      // Only the ingest stamp differs, so the id must not move.
      pulledAt: "2026-04-04T00:00:00.000Z",
    });

    expect(first.observation_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(second.observation_id).toBe(first.observation_id);
    expect(first).toMatchObject({
      client_key: "airway",
      source_family: "maps",
      observed_date: "2026-03-05",
      metric_key: "projected_rows",
      value_numeric: 49,
      unit: "rows",
      observed_at: "2026-03-05T00:00:00+00:00",
      ingested_at: PULLED_AT,
    });
  });
});
