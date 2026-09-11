/**
 * Seed OpenSEO database with monitoring targets and maps grid configurations
 * for seo-yolo clients.
 *
 * Usage:
 *   pnpm db:migrate:local
 *   tsx scripts/seed-monitoring.ts '{"airway": "<projectId>", "newmouth": "<projectId>"}'
 *   tsx scripts/seed-monitoring.ts --mapping=path/to/mapping.json --dry-run
 *   tsx scripts/seed-monitoring.ts path/to/mapping.json
 */

import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { drizzle } from "drizzle-orm/d1";
import { and, eq } from "drizzle-orm";
import * as appSchema from "../src/db/app.schema";
import * as monitoringSchema from "../src/db/monitoring.schema";
import { CLIENT_DATASETS } from "../src/server/lib/bigquery/specs";
import {
  buildSeedingPlan,
  discoverClients,
  parseProjectMapping,
  DEFAULT_GSC_EXPORT_DATASETS,
  type ClientSeedPlan,
} from "../src/server/lib/monitoring-seed/seed-config";
import { parseArgs } from "./cli-utils";

const schema = {
  ...appSchema,
  ...monitoringSchema,
};

type SeedDb = ReturnType<typeof drizzle<typeof schema>>;

export async function seedMonitoring(
  db: SeedDb,
  plans: ClientSeedPlan[],
): Promise<{
  clientsSeeded: number;
  locationsUpserted: number;
  configsUpserted: number;
  matchTermsInserted: number;
  keywordsInserted: number;
  bigqueryTargetsUpserted: number;
}> {
  let locationsUpserted = 0;
  let configsUpserted = 0;
  let matchTermsInserted = 0;
  let keywordsInserted = 0;
  let bigqueryTargetsUpserted = 0;

  for (const plan of plans) {
    // 1. Verify project exists in DB
    const existingProject = await db.query.projects.findFirst({
      where: eq(appSchema.projects.id, plan.projectId),
    });
    if (!existingProject) {
      throw new Error(
        `Project ID "${plan.projectId}" for client "${plan.clientKey}" not found in database. Please create the project first.`,
      );
    }

    // 2. Upsert project_bigquery_targets (PK: projectId)
    await db
      .insert(monitoringSchema.projectBigqueryTargets)
      .values({
        projectId: plan.bigqueryTarget.projectId,
        clientKey: plan.bigqueryTarget.clientKey,
        dataset: plan.bigqueryTarget.dataset,
        gscExportDataset: plan.bigqueryTarget.gscExportDataset,
      })
      .onConflictDoUpdate({
        target: monitoringSchema.projectBigqueryTargets.projectId,
        set: {
          clientKey: plan.bigqueryTarget.clientKey,
          dataset: plan.bigqueryTarget.dataset,
          gscExportDataset: plan.bigqueryTarget.gscExportDataset,
        },
      });
    bigqueryTargetsUpserted += 1;

    // 3. Upsert maps grid locations, match terms, configs, and keywords
    if (plan.maps) {
      for (const loc of plan.maps.locations) {
        // Find existing location by (projectId, slug)
        const existingLoc = await db.query.mapsGridLocations.findFirst({
          where: and(
            eq(monitoringSchema.mapsGridLocations.projectId, plan.projectId),
            eq(monitoringSchema.mapsGridLocations.slug, loc.slug),
          ),
        });

        let locationId: string;
        if (existingLoc) {
          locationId = existingLoc.id;
          await db
            .update(monitoringSchema.mapsGridLocations)
            .set({
              name: loc.name,
              lat: loc.lat,
              lng: loc.lng,
              radiusMiles: loc.radiusMiles,
              brandName: loc.brandName,
              domain: loc.domain,
              phone: loc.phone,
              street: loc.street,
              postalCode: loc.postalCode,
              placeId: loc.placeId,
              locationUrl: loc.locationUrl,
            })
            .where(eq(monitoringSchema.mapsGridLocations.id, locationId));
        } else {
          locationId = crypto.randomUUID();
          await db.insert(monitoringSchema.mapsGridLocations).values({
            id: locationId,
            projectId: plan.projectId,
            name: loc.name,
            slug: loc.slug,
            lat: loc.lat,
            lng: loc.lng,
            radiusMiles: loc.radiusMiles,
            brandName: loc.brandName,
            domain: loc.domain,
            phone: loc.phone,
            street: loc.street,
            postalCode: loc.postalCode,
            placeId: loc.placeId,
            locationUrl: loc.locationUrl,
          });
        }
        locationsUpserted += 1;

        // Match terms (unique on locationId, term)
        for (const term of loc.matchTerms) {
          await db
            .insert(monitoringSchema.mapsGridLocationMatchTerms)
            .values({
              locationId,
              term,
            })
            .onConflictDoNothing();
          matchTermsInserted += 1;
        }

        // Config (one per locationId in a project)
        const existingConfig = await db.query.mapsGridConfigs.findFirst({
          where: and(
            eq(monitoringSchema.mapsGridConfigs.projectId, plan.projectId),
            eq(monitoringSchema.mapsGridConfigs.locationId, locationId),
          ),
        });

        let configId: string;
        if (existingConfig) {
          configId = existingConfig.id;
          await db
            .update(monitoringSchema.mapsGridConfigs)
            .set({
              gridSize: loc.config.gridSize,
              radiusMiles: loc.config.radiusMiles,
              zoom: loc.config.zoom,
              languageCode: loc.config.languageCode,
              device: loc.config.device,
              depth: loc.config.depth,
              scheduleInterval: loc.config.scheduleInterval,
              isActive: loc.config.isActive,
            })
            .where(eq(monitoringSchema.mapsGridConfigs.id, configId));
        } else {
          configId = crypto.randomUUID();
          await db.insert(monitoringSchema.mapsGridConfigs).values({
            id: configId,
            projectId: plan.projectId,
            locationId,
            gridSize: loc.config.gridSize,
            radiusMiles: loc.config.radiusMiles,
            zoom: loc.config.zoom,
            languageCode: loc.config.languageCode,
            device: loc.config.device,
            depth: loc.config.depth,
            scheduleInterval: loc.config.scheduleInterval,
            isActive: loc.config.isActive,
            nextRunAt: null,
          });
        }
        configsUpserted += 1;

        // Keywords (unique on configId, keyword)
        for (const keyword of loc.keywords) {
          await db
            .insert(monitoringSchema.mapsGridKeywords)
            .values({
              id: crypto.randomUUID(),
              configId,
              keyword,
            })
            .onConflictDoNothing();
          keywordsInserted += 1;
        }
      }
    }
  }

  return {
    clientsSeeded: plans.length,
    locationsUpserted,
    configsUpserted,
    matchTermsInserted,
    keywordsInserted,
    bigqueryTargetsUpserted,
  };
}

export function printPlan(plans: ClientSeedPlan[]): void {
  console.log(`\n=== Monitoring Seed Plan (${plans.length} client(s)) ===\n`);
  for (const plan of plans) {
    console.log(`Client: ${plan.clientKey} (${plan.profile.display_name})`);
    console.log(`  Project ID:        ${plan.projectId}`);
    console.log(
      `  BigQuery Target:   client_key="${plan.bigqueryTarget.clientKey}", dataset="${plan.bigqueryTarget.dataset}", gsc_export="${plan.bigqueryTarget.gscExportDataset ?? "none"}"`,
    );

    if (plan.maps) {
      console.log(
        `  Maps Grid:         ${plan.maps.locations.length} location(s)`,
      );
      if (plan.maps.configSource) {
        console.log(`  Config Source:     ${plan.maps.configSource}`);
      }
      for (const loc of plan.maps.locations) {
        console.log(`    - Location: ${loc.name} (${loc.slug})`);
        console.log(
          `      Coordinates:   ${loc.lat}, ${loc.lng} (radius: ${loc.radiusMiles} mi)`,
        );
        console.log(`      Brand/Domain:  ${loc.brandName} (${loc.domain})`);
        console.log(`      Match Terms:   [${loc.matchTerms.join(", ")}]`);
        console.log(
          `      Grid Config:   ${loc.config.gridSize}x${loc.config.gridSize}, zoom=${loc.config.zoom}, device=${loc.config.device}, schedule=${loc.config.scheduleInterval}`,
        );
        console.log(
          `      Keywords (${loc.keywords.length}): [${loc.keywords.slice(0, 5).join(", ")}${loc.keywords.length > 5 ? ", ..." : ""}]`,
        );
      }
    } else {
      console.log(
        `  Maps Grid:         None (publisher client - BigQuery target only)`,
      );
    }
    console.log("");
  }
}

function printUsage(): void {
  console.log(`
seed-monitoring: Seed OpenSEO with monitoring targets and maps grids.

Usage:
  tsx scripts/seed-monitoring.ts '<mapping-json>' [--dry-run]
  tsx scripts/seed-monitoring.ts <path-to-mapping.json> [--dry-run]
  tsx scripts/seed-monitoring.ts --mapping=<mapping> [--dry-run]

Examples:
  tsx scripts/seed-monitoring.ts '{"airway": "00000000-0000-0000-0000-000000000000"}' --dry-run
  tsx scripts/seed-monitoring.ts '{"newmouth": "11111111-1111-1111-1111-111111111111"}'
`);
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const args = parseArgs(rawArgv);
  const isDryRun =
    args["dry-run"] === "true" ||
    args.dryRun === "true" ||
    rawArgv.includes("--dry-run");

  // Extract mapping input: flag or first positional non-flag arg
  const mappingArg =
    args.mapping ||
    args["mapping-file"] ||
    args.m ||
    rawArgv.find((arg) => !arg.startsWith("-"));

  if (!mappingArg) {
    printUsage();
    process.exit(1);
  }

  const mapping = parseProjectMapping(mappingArg);
  const discovered = discoverClients();
  const plans = buildSeedingPlan(mapping, {
    discoveredClients: discovered,
    clientDatasets: CLIENT_DATASETS,
    gscExportDatasets: DEFAULT_GSC_EXPORT_DATASETS,
  });

  if (isDryRun) {
    printPlan(plans);
    console.log("Dry run complete. No database records were modified.");
    return;
  }

  console.log("Setting up local D1 connection...");
  const { env, dispose } = await getPlatformProxy<{ DB: D1Database }>();
  const db = drizzle(env.DB, { schema });

  try {
    const results = await seedMonitoring(db, plans);
    console.log(
      `\nDone. Seeded ${results.clientsSeeded} client(s): ` +
        `${results.bigqueryTargetsUpserted} BQ target(s), ` +
        `${results.locationsUpserted} location(s), ` +
        `${results.configsUpserted} config(s), ` +
        `${results.matchTermsInserted} match term(s), ` +
        `${results.keywordsInserted} keyword(s).`,
    );
  } finally {
    await dispose();
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("seed-monitoring.ts") ||
    process.argv[1].endsWith("seed-monitoring"));

if (isDirectRun) {
  main().catch((err) => {
    console.error(`\nError: ${(err as Error).message}`);
    process.exit(1);
  });
}
