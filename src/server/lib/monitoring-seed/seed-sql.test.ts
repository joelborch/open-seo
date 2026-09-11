import { describe, expect, it } from "vitest";
import { buildSeedingPlan } from "./seed-config";
import type { DiscoveredClient, SeoYoloProfile } from "./seed-schemas";
import {
  buildSeedRows,
  renderSeedSql,
  seedRowCountsByTable,
  sqlLiteral,
} from "./seed-sql";

function profile(overrides: Partial<SeoYoloProfile> = {}): SeoYoloProfile {
  return {
    key: "local-client",
    display_name: "Local Client",
    profile_slug: "localclient",
    domain: "localclient.com",
    ...overrides,
  };
}

function localClient(): DiscoveredClient {
  return {
    key: "local-client",
    slug: "localclient",
    displayName: "Local Client",
    domain: "localclient.com",
    profile: profile({ topics: ["local_visibility"] }),
    mapsConfigPath: "/configs/localclient.json",
    mapsConfig: {
      grid_size: 7,
      radius_miles: 5,
      zoom: "13z",
      language_code: "en",
      device: "mobile",
      keywords: ["dentist near me", "joe's dentist"],
      locations: [
        {
          name: "Main Office",
          slug: "main-office",
          lat: 29.5,
          lng: -95.5,
          match_terms: ["joe's dental"],
        },
      ],
    },
    bigqueryDataset: "localclient_marketing",
    gscExportDataset: "searchconsole_localclient",
    isLocal: true,
    weeklyRankKeywords: ["dentist near me"],
    rankLocationName: "Houston,Texas,United States",
  };
}

function publisherClient(): DiscoveredClient {
  return {
    key: "publisher",
    slug: "publisher",
    displayName: "Publisher",
    domain: "publisher.com",
    profile: profile({
      key: "publisher",
      display_name: "Publisher",
      profile_slug: "publisher",
      domain: "publisher.com",
      topics: ["content_growth"],
    }),
    mapsConfigPath: null,
    mapsConfig: null,
    bigqueryDataset: "publisher_marketing",
    gscExportDataset: "searchconsole_publisher",
    isLocal: false,
    weeklyRankKeywords: [],
    rankLocationName: null,
  };
}

const discoveredClients = [localClient(), publisherClient()];
const mapping = { "local-client": "project-local", publisher: "project-pub" };
const publisherKeywords = { publisher: ["best dna test"] };

function buildRows() {
  return buildSeedRows(
    buildSeedingPlan(mapping, { discoveredClients, publisherKeywords }),
  );
}

function rowIds(rows: ReturnType<typeof buildSeedRows>): string[] {
  return rows.flatMap((row) => {
    const id = row.values.id;
    return typeof id === "string" ? [`${row.table}:${id}`] : [];
  });
}

describe("seed-sql emission", () => {
  it("emits one guarded statement per planned row", () => {
    const rows = buildRows();
    const sql = renderSeedSql(
      buildSeedingPlan(mapping, { discoveredClients, publisherKeywords }),
    );
    const statements = sql
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.startsWith("INSERT INTO "));

    expect(statements).toHaveLength(rows.length);
    for (const statement of statements) {
      expect(statement).toMatch(/^INSERT INTO \w+ \(.+\)\nSELECT /u);
      expect(statement).toContain("WHERE NOT EXISTS (SELECT 1 FROM ");
      expect(statement.endsWith(");")).toBe(true);
    }

    expect(seedRowCountsByTable(rows)).toEqual({
      project_bigquery_targets: 2,
      audit_schedules: 2,
      maps_grid_locations: 1,
      maps_grid_location_match_terms: 1,
      maps_grid_configs: 1,
      gbp_schedules: 1,
      maps_grid_keywords: 2,
      rank_tracking_configs: 2,
      rank_tracking_keywords: 2,
    });
  });

  it("derives every id from its natural key, so two runs agree", () => {
    const first = rowIds(buildRows());
    // A second, independent plan build: next_quick_at / next_check_at differ
    // between the two (the shared helpers pick a random hour), ids must not.
    expect(rowIds(buildRows())).toEqual(first);
    expect(first).toHaveLength(11);
    for (const id of first) {
      expect(id).toMatch(
        /:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
    }
  });

  it("splits the rank config guard on location_name the way the schema does", () => {
    const configs = buildRows().filter(
      (row) => row.table === "rank_tracking_configs",
    );

    expect(configs[0].match).toEqual({
      project_id: "project-local",
      domain: "localclient.com",
      location_code: 2840,
      location_name: "Houston,Texas,United States",
    });
    expect(configs[1].match.location_name).toBeNull();

    const sql = renderSeedSql(
      buildSeedingPlan(mapping, { discoveredClients, publisherKeywords }),
    );
    expect(sql).toContain("location_name = 'Houston,Texas,United States'");
    expect(sql).toContain("location_name IS NULL");
  });

  it("emits child rows after the parent whose id they carry", () => {
    const rows = buildRows();
    const locationId = rows.find((row) => row.table === "maps_grid_locations")
      ?.values.id;
    const firstTermIndex = rows.findIndex(
      (row) => row.table === "maps_grid_location_match_terms",
    );

    expect(rows[firstTermIndex].values.location_id).toBe(locationId);
    expect(
      rows.findIndex((row) => row.table === "maps_grid_locations"),
    ).toBeLessThan(firstTermIndex);
  });

  it("escapes quotes and renders dialect-neutral literals", () => {
    expect(sqlLiteral("joe's dentist")).toBe("'joe''s dentist'");
    expect(sqlLiteral(true)).toBe("true");
    expect(sqlLiteral(null)).toBe("NULL");
    expect(
      renderSeedSql(buildSeedingPlan(mapping, { discoveredClients })),
    ).toContain("'joe''s dentist'");
  });
});
