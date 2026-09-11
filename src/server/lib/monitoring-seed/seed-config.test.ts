import { describe, expect, it } from "vitest";
import { sortBy } from "remeda";
import { buildSeedingPlan, discoverClients } from "./seed-config";
import { AUDIT_SCHEDULE_SEED_DEFAULTS } from "./seed-schemas";

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

    it("gives every project the same audit schedule, on the shared grid", () => {
      const [plan] = buildSeedingPlan(
        { airway: "proj-airway-3" },
        { discoveredClients: clients },
      );
      const schedule = plan.auditSchedule;

      expect(schedule).toMatchObject({
        startUrl: "https://theairwaydentists.com/",
        isActive: true,
        quickEnabled: true,
        quickMaxPages: 300,
        quickHourUtc: 9,
        deepEnabled: true,
        deepMaxPages: 5000,
        deepDowUtc: 1,
        deepHourUtc: 10,
        deepLighthouse: true,
      });

      const nextQuick = new Date(schedule.nextQuickAt);
      expect(nextQuick.getUTCHours()).toBe(
        AUDIT_SCHEDULE_SEED_DEFAULTS.quickHourUtc,
      );
      expect(nextQuick.getTime()).toBeGreaterThan(Date.now());

      const nextDeep = new Date(schedule.nextDeepAt);
      expect(nextDeep.getUTCDay()).toBe(
        AUDIT_SCHEDULE_SEED_DEFAULTS.deepDowUtc,
      );
      expect(nextDeep.getUTCHours()).toBe(
        AUDIT_SCHEDULE_SEED_DEFAULTS.deepHourUtc,
      );
      expect(nextDeep.getTime()).toBeGreaterThan(Date.now());
    });

    it("applies global page overrides, with the per-client map winning", () => {
      const plans = buildSeedingPlan(
        { airway: "proj-airway-4", newmouth: "proj-nm-2" },
        {
          discoveredClients: clients,
          auditPageLimits: { quickMaxPages: 50, deepMaxPages: 500 },
          auditPageLimitsByClient: { airway: { deepMaxPages: 9000 } },
        },
      );

      expect(plans[0].auditSchedule).toMatchObject({
        quickMaxPages: 50,
        deepMaxPages: 9000,
      });
      expect(plans[1].auditSchedule).toMatchObject({
        quickMaxPages: 50,
        deepMaxPages: 500,
      });
    });

    it("tracks locals in their rankings location and publishers nationally", () => {
      const plans = buildSeedingPlan(
        { airway: "proj-airway-5", newmouth: "proj-nm-3" },
        {
          discoveredClients: clients,
          publisherKeywords: { newmouth: ["veneers", "braces"] },
        },
      );

      expect(plans[0].rankTracking).toMatchObject({
        domain: "theairwaydentists.com",
        locationName: "Houston,Texas,United States",
        devices: "mobile",
        serpDepth: 20,
        scheduleInterval: "weekly",
        isActive: true,
        trackCompetitors: true,
        trackAiOverview: true,
      });
      expect(plans[0].rankTracking.keywords).toEqual([
        "airway dentist",
        "dentist near me",
        "invisalign near me",
      ]);

      expect(plans[1].rankTracking).toMatchObject({
        domain: "newmouth.com",
        locationName: null,
        locationCode: 2840,
        devices: "desktop",
        keywords: ["veneers", "braces"],
      });
      expect(
        new Date(plans[1].rankTracking.nextCheckAt).getTime(),
      ).toBeGreaterThan(Date.now());
    });

    it("leaves a publisher with no keywords file entry empty", () => {
      const [plan] = buildSeedingPlan(
        { knowyourdna: "proj-kyd-2" },
        { discoveredClients: clients },
      );
      expect(plan.rankTracking.keywords).toEqual([]);
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
