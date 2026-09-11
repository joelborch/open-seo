/**
 * Seed OpenSEO database with monitoring targets, scheduled crawls, rank
 * tracking, and maps grid configurations for seo-yolo clients.
 *
 * Local dev writes straight to the miniflare D1 through `getPlatformProxy`.
 * Production is a remote D1 that proxy cannot reach, so `--sql-out` renders the
 * same plan as an idempotent SQL file for
 * `wrangler d1 execute DB --remote --file=...`.
 *
 * Usage:
 *   pnpm db:migrate:local
 *   tsx scripts/seed-monitoring.ts '{"airway": "<projectId>", "newmouth": "<projectId>"}'
 *   tsx scripts/seed-monitoring.ts --mapping=path/to/mapping.json --dry-run
 *   tsx scripts/seed-monitoring.ts --mapping=path/to/mapping.json --sql-out=seed.sql
 *   tsx scripts/seed-monitoring.ts path/to/mapping.json
 */

import { writeFileSync } from "node:fs";
import process from "node:process";
import { getPlatformProxy } from "wrangler";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, isNull } from "drizzle-orm";
import * as appSchema from "../src/db/app.schema";
import * as monitoringSchema from "../src/db/monitoring.schema";
import { CLIENT_DATASETS } from "../src/server/lib/bigquery/specs";
import {
  buildSeedingPlan,
  discoverClients,
  parseProjectMapping,
  parsePublisherKeywords,
  DEFAULT_GSC_EXPORT_DATASETS,
  type ClientSeedPlan,
  type PublisherKeywordsFile,
} from "../src/server/lib/monitoring-seed/seed-config";
import {
  buildSeedRows,
  renderSeedSql,
  seedRowCountsByTable,
  seedUuid,
} from "../src/server/lib/monitoring-seed/seed-sql";
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
  auditSchedulesInserted: number;
  rankConfigsInserted: number;
  rankKeywordsInserted: number;
}> {
  let locationsUpserted = 0;
  let configsUpserted = 0;
  let matchTermsInserted = 0;
  let keywordsInserted = 0;
  let bigqueryTargetsUpserted = 0;
  let auditSchedulesInserted = 0;
  let rankConfigsInserted = 0;
  let rankKeywordsInserted = 0;

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

    // 3. Audit schedule — one per project, left alone if it already exists so a
    // re-run never resets an hour someone has since changed.
    const existingSchedule = await db.query.auditSchedules.findFirst({
      where: eq(monitoringSchema.auditSchedules.projectId, plan.projectId),
    });
    if (!existingSchedule) {
      await db.insert(monitoringSchema.auditSchedules).values({
        id: seedUuid(`audit_schedules:${plan.projectId}`),
        projectId: plan.projectId,
        ...plan.auditSchedule,
      });
      auditSchedulesInserted += 1;
    }

    // 4. Rank tracking config + keywords. The config's natural key is the one
    // the schema's partial uniques use: national rows have a null location_name.
    const rank = plan.rankTracking;
    const existingRankConfig = await db.query.rankTrackingConfigs.findFirst({
      where: and(
        eq(appSchema.rankTrackingConfigs.projectId, plan.projectId),
        eq(appSchema.rankTrackingConfigs.domain, rank.domain),
        eq(appSchema.rankTrackingConfigs.locationCode, rank.locationCode),
        rank.locationName === null
          ? isNull(appSchema.rankTrackingConfigs.locationName)
          : eq(appSchema.rankTrackingConfigs.locationName, rank.locationName),
      ),
    });

    let rankConfigId = existingRankConfig?.id;
    if (!rankConfigId) {
      rankConfigId = seedUuid(
        `rank_tracking_configs:${plan.projectId}:${rank.domain}:${rank.locationCode}:${rank.locationName ?? ""}`,
      );
      await db.insert(appSchema.rankTrackingConfigs).values({
        id: rankConfigId,
        projectId: plan.projectId,
        domain: rank.domain,
        locationCode: rank.locationCode,
        languageCode: rank.languageCode,
        devices: rank.devices,
        serpDepth: rank.serpDepth,
        scheduleInterval: rank.scheduleInterval,
        locationName: rank.locationName,
        trackCompetitors: rank.trackCompetitors,
        trackAiOverview: rank.trackAiOverview,
        isActive: rank.isActive,
        nextCheckAt: rank.nextCheckAt,
      });
      rankConfigsInserted += 1;
    }

    for (const keyword of rank.keywords) {
      await db
        .insert(appSchema.rankTrackingKeywords)
        .values({
          id: seedUuid(`rank_tracking_keywords:${rankConfigId}:${keyword}`),
          configId: rankConfigId,
          keyword,
        })
        .onConflictDoNothing();
      rankKeywordsInserted += 1;
    }

    // 5. Upsert maps grid locations, match terms, configs, and keywords
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
    auditSchedulesInserted,
    rankConfigsInserted,
    rankKeywordsInserted,
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

    const schedule = plan.auditSchedule;
    console.log(
      `  Audit Schedule:    start_url=${schedule.startUrl}, quick ${schedule.quickMaxPages}p @${schedule.quickHourUtc}:00 UTC daily (next ${schedule.nextQuickAt}), deep ${schedule.deepMaxPages}p dow=${schedule.deepDowUtc} @${schedule.deepHourUtc}:00 UTC (next ${schedule.nextDeepAt}), lighthouse=${schedule.deepLighthouse}`,
    );

    const rank = plan.rankTracking;
    console.log(
      `  Rank Tracking:     domain=${rank.domain}, location_name=${rank.locationName ?? `none (location_code ${rank.locationCode})`}, devices=${rank.devices}, depth=${rank.serpDepth}, schedule=${rank.scheduleInterval} (next ${rank.nextCheckAt})`,
    );
    console.log(
      `    Keywords (${rank.keywords.length}): [${rank.keywords.slice(0, 5).join(", ")}${rank.keywords.length > 5 ? ", ..." : ""}]`,
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
seed-monitoring: Seed OpenSEO with monitoring targets, scheduled crawls,
rank tracking, and maps grids.

Usage:
  tsx scripts/seed-monitoring.ts '<mapping-json>' [options]
  tsx scripts/seed-monitoring.ts <path-to-mapping.json> [options]
  tsx scripts/seed-monitoring.ts --mapping=<mapping> [options]

Options:
  --dry-run                    Print the plan; touch nothing.
  --sql-out=<path>             Write idempotent SQL instead of executing, for
                               \`wrangler d1 execute DB --remote --file=<path>\`.
  --publisher-keywords=<path>  { "<client_key>": ["kw", ...] } rank keywords for
                               publishers (locals use their seo-yolo panel).
  --quick-pages=<n>            Override quick_max_pages (default 300).
  --deep-pages=<n>             Override deep_max_pages (default 5000).

Examples:
  tsx scripts/seed-monitoring.ts '{"airway": "00000000-0000-0000-0000-000000000000"}' --dry-run
  tsx scripts/seed-monitoring.ts --mapping=map.json --sql-out=seed-monitoring.sql
`);
}

function parsePositiveInt(value: string | undefined, flag: string) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer, got "${value}".`);
  }
  return parsed;
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

  const publisherKeywordsArg =
    args["publisher-keywords"] ?? args.publisherKeywords;
  const publisherKeywords: PublisherKeywordsFile | undefined =
    publisherKeywordsArg
      ? parsePublisherKeywords(publisherKeywordsArg)
      : undefined;

  const mapping = parseProjectMapping(mappingArg);
  const discovered = discoverClients();
  const plans = buildSeedingPlan(mapping, {
    discoveredClients: discovered,
    clientDatasets: CLIENT_DATASETS,
    gscExportDatasets: DEFAULT_GSC_EXPORT_DATASETS,
    publisherKeywords,
    auditPageLimits: {
      quickMaxPages: parsePositiveInt(args["quick-pages"], "--quick-pages"),
      deepMaxPages: parsePositiveInt(args["deep-pages"], "--deep-pages"),
    },
  });

  if (isDryRun) {
    printPlan(plans);
    console.log("Dry run complete. No database records were modified.");
    return;
  }

  const sqlOut = args["sql-out"] ?? args.sqlOut;
  if (sqlOut) {
    const rows = buildSeedRows(plans);
    writeFileSync(sqlOut, renderSeedSql(plans), "utf8");
    console.log(`\nWrote ${rows.length} statement(s) to ${sqlOut}:`);
    for (const [table, count] of Object.entries(
      seedRowCountsByTable(rows),
    ).sort()) {
      console.log(`  ${table}: ${count}`);
    }
    console.log(
      "\nApply with: npx wrangler d1 execute DB --remote --file=" + sqlOut,
    );
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
        `${results.auditSchedulesInserted} audit schedule(s), ` +
        `${results.rankConfigsInserted} rank config(s), ` +
        `${results.rankKeywordsInserted} rank keyword(s), ` +
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
  main().catch((err: unknown) => {
    const message =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Unknown error";
    console.error(`\nError: ${message}`);
    process.exit(1);
  });
}
