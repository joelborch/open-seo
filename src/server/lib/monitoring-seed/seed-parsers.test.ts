import { describe, expect, it } from "vitest";
import {
  MAX_KEYWORDS_PER_CONFIG,
  MAX_TRACKED_KEYWORD_LENGTH,
} from "@/shared/rank-tracking";
import {
  normalizeTrackedKeywords,
  parseAhrefsClientsConfig,
  parseClientOrder,
  parseClientProfile,
  parseGscExportDatasets,
  parseMapsConfig,
  parseProjectMapping,
  parsePublisherKeywords,
} from "./seed-parsers";
import {
  DEFAULT_CLIENT_ORDER,
  DEFAULT_GSC_EXPORT_DATASETS,
} from "./seed-schemas";

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

  describe("PublisherKeywordsFileSchema & parsePublisherKeywords", () => {
    it("parses the file, trimming, de-duplicating and capping keywords", () => {
      const parsed = parsePublisherKeywords(
        '{"newmouth": ["  veneers  ", "veneers", "braces"]}',
      );
      expect(parsed).toEqual({ newmouth: ["veneers", "braces"] });

      // The cap the app enforces per config also bounds what the seeder emits.
      expect(
        normalizeTrackedKeywords(
          Array.from(
            { length: MAX_KEYWORDS_PER_CONFIG + 5 },
            (_, i) => `keyword ${i}`,
          ),
        ),
      ).toHaveLength(MAX_KEYWORDS_PER_CONFIG);
      expect(() =>
        parsePublisherKeywords({
          visioncenter: Array.from(
            { length: MAX_KEYWORDS_PER_CONFIG + 5 },
            (_, i) => `keyword ${i}`,
          ),
        }),
      ).toThrow(/Publisher keywords validation failed/);
    });

    it("rejects a keyword longer than the tracked-keyword limit", () => {
      expect(() =>
        parsePublisherKeywords({
          newmouth: ["x".repeat(MAX_TRACKED_KEYWORD_LENGTH + 1)],
        }),
      ).toThrow(/Publisher keywords validation failed/);
    });

    it("rejects a value that is not a keyword array", () => {
      expect(() => parsePublisherKeywords('{"newmouth": "veneers"}')).toThrow(
        /Publisher keywords validation failed/,
      );
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
