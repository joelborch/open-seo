import { describe, expect, it } from "vitest";
import { sortBy } from "remeda";
import {
  buildSeedingPlan,
  discoverClients,
  parseAhrefsClientsConfig,
  parseClientOrder,
  parseClientProfile,
  parseGscExportDatasets,
  parseMapsConfig,
  parseProjectMapping,
  DEFAULT_CLIENT_ORDER,
  DEFAULT_GSC_EXPORT_DATASETS,
} from "./seed-config";

describe("seed-config pure parsing and schemas", () => {
  describe("ProjectMappingSchema & parseProjectMapping", () => {
    it("parses valid JSON object or string", () => {
      const parsed = parseProjectMapping(
        '{"airway": "proj-1", "actc": "proj-2"}',
      );
      expect(parsed).toEqual({ airway: "proj-1", actc: "proj-2" });

      const fromObj = parseProjectMapping({ reddy: "proj-3" });
      expect(fromObj).toEqual({ reddy: "proj-3" });
    });

    it("rejects empty keys or empty project IDs", () => {
      expect(() => parseProjectMapping({ "": "proj-1" })).toThrow(
        /Project mapping validation failed/,
      );
      expect(() => parseProjectMapping({ airway: "" })).toThrow(
        /Project mapping validation failed/,
      );
    });

    it("rejects malformed JSON string", () => {
      expect(() => parseProjectMapping("{invalid-json}")).toThrow(
        /Invalid JSON in project mapping string/,
      );
    });
  });

  describe("SeoYoloProfileSchema & parseClientProfile", () => {
    it("validates compliant profile payload", () => {
      const profile = parseClientProfile({
        key: "airway",
        display_name: "The Airway Dentists",
        profile_slug: "theairwaydentists",
        domain: "theairwaydentists.com",
        dataset: "airway_marketing",
        client_type: "local_multi_location",
      });
      expect(profile.key).toBe("airway");
      expect(profile.profile_slug).toBe("theairwaydentists");
      expect(profile.domain).toBe("theairwaydentists.com");
    });

    it("rejects profiles missing required fields", () => {
      expect(() =>
        parseClientProfile({
          key: "airway",
          display_name: "The Airway Dentists",
          // missing profile_slug and domain
        }),
      ).toThrow(/Client profile validation failed/);
    });
  });

  describe("MapsConfigSchema & parseMapsConfig", () => {
    it("parses valid maps config and applies defaults", () => {
      const config = parseMapsConfig({
        client: "Test Client",
        domain: "test.com",
        keywords: ["keyword 1", "keyword 2"],
        locations: [
          {
            name: "Office 1",
            slug: "office-1",
            lat: 30.123,
            lng: -95.456,
            match_terms: ["office one"],
          },
        ],
      });

      expect(config.grid_size).toBe(7);
      expect(config.radius_miles).toBe(5);
      expect(config.zoom).toBe("13z");
      expect(config.device).toBe("mobile");
      expect(config.language_code).toBe("en");
      expect(config.locations).toHaveLength(1);
      expect(config.locations[0].slug).toBe("office-1");
      expect(config.locations[0].match_terms).toEqual(["office one"]);
    });

    it("rejects maps config with invalid device", () => {
      expect(() =>
        parseMapsConfig({
          device: "tablet", // only "mobile" | "desktop" allowed
          locations: [],
        }),
      ).toThrow(/Maps config validation failed/);
    });

    it("rejects locations missing coordinates or slug", () => {
      expect(() =>
        parseMapsConfig({
          locations: [
            {
              name: "Missing coords",
              slug: "missing",
            },
          ],
        }),
      ).toThrow(/Maps config validation failed/);
    });
  });

  describe("AhrefsClientsConfigSchema & parseAhrefsClientsConfig", () => {
    it("parses valid clients list", () => {
      const parsed = parseAhrefsClientsConfig({
        clients: [
          {
            slug: "actchealth",
            maps_config: "/path/to/maps.json",
          },
        ],
      });
      expect(parsed.clients).toHaveLength(1);
      expect(parsed.clients[0].slug).toBe("actchealth");
      expect(parsed.clients[0].maps_config).toBe("/path/to/maps.json");
    });
  });

  describe("Python extractors", () => {
    it("parseClientOrder extracts tuple items or falls back to default", () => {
      const py = `CLIENT_ORDER = (\n    "client_a",\n    "client_b",\n)`;
      expect(parseClientOrder(py)).toEqual(["client_a", "client_b"]);
      expect(parseClientOrder("NO_ORDER_HERE = 123")).toEqual(
        DEFAULT_CLIENT_ORDER,
      );
    });

    it("parseGscExportDatasets extracts dict entries or falls back to default", () => {
      const py = `GSC_EXPORT_DATASETS: dict[str, str] = {\n    "custom_client": "searchconsole_custom",\n}`;
      expect(parseGscExportDatasets(py)).toEqual({
        custom_client: "searchconsole_custom",
      });
      expect(parseGscExportDatasets("INVALID")).toEqual(
        DEFAULT_GSC_EXPORT_DATASETS,
      );
    });
  });
});

describe("seed-config live discovery & plan generation", () => {
  it("discovers all 7 live clients from the workspace", () => {
    const clients = discoverClients();
    expect(clients).toHaveLength(7);

    const keys = clients.map((c) => c.key);
    expect(keys).toEqual([
      "airway",
      "reddy",
      "advanced-dermatology",
      "actc",
      "newmouth",
      "visioncenter",
      "knowyourdna",
    ]);

    const slugs = clients.map((c) => c.slug);
    expect(slugs).toEqual([
      "theairwaydentists",
      "reddyplasticsurgerygroup",
      "advanceddermchi",
      "actchealth",
      "newmouth",
      "visioncenter",
      "knowyourdna",
    ]);

    // Local clients have maps configs
    const withMaps = clients.filter((c) => Boolean(c.mapsConfig));
    expect(
      sortBy(
        withMaps.map((c) => c.slug),
        (s) => s,
      ),
    ).toEqual([
      "actchealth",
      "advanceddermchi",
      "reddyplasticsurgerygroup",
      "theairwaydentists",
    ]);

    // Publishers have no maps configs
    const publishers = clients.filter((c) => !c.mapsConfig);
    expect(
      sortBy(
        publishers.map((c) => c.slug),
        (s) => s,
      ),
    ).toEqual(["knowyourdna", "newmouth", "visioncenter"]);
  });

  describe("buildSeedingPlan", () => {
    const clients = discoverClients();

    it("resolves clients by short key (e.g. 'airway')", () => {
      const plans = buildSeedingPlan(
        { airway: "proj-airway-1" },
        { discoveredClients: clients },
      );
      expect(plans).toHaveLength(1);
      const plan = plans[0];
      expect(plan.clientKey).toBe("airway");
      expect(plan.projectId).toBe("proj-airway-1");
      expect(plan.bigqueryTarget).toEqual({
        projectId: "proj-airway-1",
        clientKey: "theairwaydentists",
        dataset: "airway_marketing",
        gscExportDataset: "searchconsole",
      });
      expect(plan.maps).toBeDefined();
      expect(plan.maps!.locations).toHaveLength(8);
      const locNames = plan.maps!.locations.map((l) => l.name);
      expect(locNames).toContain("Sugar Land");
      expect(locNames).toContain("Friendswood");
      expect(locNames).toContain("The Heights");
    });

    it("resolves clients by profile slug (e.g. 'theairwaydentists')", () => {
      const plans = buildSeedingPlan(
        { theairwaydentists: "proj-airway-2" },
        { discoveredClients: clients },
      );
      expect(plans).toHaveLength(1);
      expect(plans[0].bigqueryTarget.clientKey).toBe("theairwaydentists");
      expect(plans[0].bigqueryTarget.projectId).toBe("proj-airway-2");
    });

    it("handles publishers: gives only bigquery target, no maps locations", () => {
      const plans = buildSeedingPlan(
        {
          newmouth: "proj-nm",
          visioncenter: "proj-vc",
          knowyourdna: "proj-kyd",
        },
        { discoveredClients: clients },
      );

      expect(plans).toHaveLength(3);
      for (const plan of plans) {
        expect(plan.maps).toBeUndefined();
        expect(plan.bigqueryTarget.dataset).toMatch(/_marketing$/);
        expect(plan.bigqueryTarget.gscExportDataset).toMatch(/^searchconsole_/);
      }
    });

    it("table-driven verification of all 7 clients", () => {
      const testCases: Array<{
        key: string;
        expectedSlug: string;
        expectedDataset: string;
        expectedGscExportDataset: string;
        expectedLocationCount: number;
      }> = [
        {
          key: "airway",
          expectedSlug: "theairwaydentists",
          expectedDataset: "airway_marketing",
          expectedGscExportDataset: "searchconsole",
          expectedLocationCount: 8,
        },
        {
          key: "reddy",
          expectedSlug: "reddyplasticsurgerygroup",
          expectedDataset: "reddy_marketing",
          expectedGscExportDataset: "searchconsole_reddyplasticsurgerygroup",
          expectedLocationCount: 1,
        },
        {
          key: "advanced-dermatology",
          expectedSlug: "advanceddermchi",
          expectedDataset: "advderm_marketing",
          expectedGscExportDataset: "searchconsole_advanceddermchi",
          expectedLocationCount: 1,
        },
        {
          key: "actc",
          expectedSlug: "actchealth",
          expectedDataset: "actc_marketing",
          expectedGscExportDataset: "searchconsole_actchealth",
          expectedLocationCount: 1,
        },
        {
          key: "newmouth",
          expectedSlug: "newmouth",
          expectedDataset: "newmouth_marketing",
          expectedGscExportDataset: "searchconsole_newmouth",
          expectedLocationCount: 0,
        },
        {
          key: "visioncenter",
          expectedSlug: "visioncenter",
          expectedDataset: "visioncenter_marketing",
          expectedGscExportDataset: "searchconsole_visioncenter",
          expectedLocationCount: 0,
        },
        {
          key: "knowyourdna",
          expectedSlug: "knowyourdna",
          expectedDataset: "knowyourdna_marketing",
          expectedGscExportDataset: "searchconsole_knowyourdna",
          expectedLocationCount: 0,
        },
      ];

      const mapping: Record<string, string> = {};
      testCases.forEach((tc, idx) => {
        mapping[tc.key] = `proj-uuid-${idx + 1}`;
      });

      const plans = buildSeedingPlan(mapping, { discoveredClients: clients });
      expect(plans).toHaveLength(7);

      for (let i = 0; i < testCases.length; i += 1) {
        const tc = testCases[i];
        const plan = plans[i];
        expect(plan.clientKey).toBe(tc.key);
        expect(plan.bigqueryTarget.clientKey).toBe(tc.expectedSlug);
        expect(plan.bigqueryTarget.dataset).toBe(tc.expectedDataset);
        expect(plan.bigqueryTarget.gscExportDataset).toBe(
          tc.expectedGscExportDataset,
        );

        if (tc.expectedLocationCount > 0) {
          expect(plan.maps).toBeDefined();
          expect(plan.maps!.locations).toHaveLength(tc.expectedLocationCount);

          for (const loc of plan.maps!.locations) {
            expect(loc.slug).toBeTruthy();
            expect(loc.lat).toBeTypeOf("number");
            expect(loc.lng).toBeTypeOf("number");
            expect(loc.radiusMiles).toBeGreaterThan(0);
            expect(loc.config.scheduleInterval).toBe("weekly");
            expect(loc.config.isActive).toBe(true);
            expect(loc.config.nextRunAt).toBeNull();
            expect(loc.keywords.length).toBeGreaterThan(0);
            expect(loc.matchTerms.length).toBeGreaterThan(0);
          }
        } else {
          expect(plan.maps).toBeUndefined();
        }
      }
    });

    it("throws clear error for unknown client", () => {
      expect(() =>
        buildSeedingPlan(
          { "nonexistent-client": "proj-xxx" },
          { discoveredClients: clients },
        ),
      ).toThrow(/Unknown client "nonexistent-client" in mapping/);
    });
  });
});
