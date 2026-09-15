import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type * as GbpRepositoryModule from "./GbpRepository";

vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

const client = createClient({ url: "file::memory:" });
const database = drizzle(client);
let repository: typeof GbpRepositoryModule.GbpRepository;
const parameterCounts: number[] = [];

beforeAll(async () => {
  vi.doMock("@/db", () => ({ db: database }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (
      build: (
        tx: typeof database,
      ) => Array<{ toSQL(): { sql: string; params: unknown[] } }>,
    ) => {
      const queries = build(database).map((query) => query.toSQL());
      for (const query of queries) {
        parameterCounts.push(query.params.length);
        if (query.params.length > 100) throw new Error("D1 parameter limit");
      }
      await client.batch(
        queries.map((query) => ({
          sql: query.sql,
          args: query.params.map((value) => {
            if (
              value === null ||
              typeof value === "string" ||
              typeof value === "number"
            )
              return value;
            throw new Error("Unexpected test parameter type");
          }),
        })),
        "write",
      );
    },
  }));
  await client.executeMultiple(`
    CREATE TABLE gbp_snapshots (id TEXT PRIMARY KEY, reviews_collected_at TEXT);
    CREATE TABLE gbp_snapshot_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT, snapshot_id TEXT NOT NULL,
      review_id TEXT, rating INTEGER CHECK(rating <= 5), author TEXT,
      published_at TEXT, text TEXT, owner_reply INTEGER NOT NULL
    );
  `);
  repository = (await import("./GbpRepository")).GbpRepository;
});
beforeEach(async () => {
  parameterCounts.length = 0;
  await client.executeMultiple(`DELETE FROM gbp_snapshot_reviews; DELETE FROM gbp_snapshots;
    INSERT INTO gbp_snapshots VALUES ('snapshot', 'old');
    INSERT INTO gbp_snapshot_reviews (snapshot_id, review_id, rating, owner_reply) VALUES ('snapshot', 'old', 5, 0);`);
});
afterAll(() => client.close());

const reviews = Array.from({ length: 20 }, (_, index) => ({
  reviewId: String(index),
  rating: 5,
  author: "Example",
  publishedAt: "2026-09-15",
  text: "Example review",
  ownerReply: false,
}));

it("saves 20 reviews below D1's parameter limit and replays without duplicates", async () => {
  for (let replay = 0; replay < 2; replay++) {
    await repository.replaceReviews({
      snapshotId: "snapshot",
      reviews,
      collectedAt: "new",
    });
    expect(
      (await client.execute("SELECT * FROM gbp_snapshot_reviews")).rows,
    ).toHaveLength(20);
  }
  expect(Math.max(...parameterCounts)).toBeLessThanOrEqual(100);
  expect(parameterCounts).toHaveLength(44);
  expect(
    (await client.execute("SELECT reviews_collected_at FROM gbp_snapshots"))
      .rows[0].reviews_collected_at,
  ).toBe("new");
});

it("rolls back the delete and partial inserts when a later review fails", async () => {
  await expect(
    repository.replaceReviews({
      snapshotId: "snapshot",
      reviews: [...reviews, { ...reviews[0], rating: 6 }],
      collectedAt: "new",
    }),
  ).rejects.toThrow();
  expect(
    (await client.execute("SELECT review_id FROM gbp_snapshot_reviews")).rows,
  ).toEqual([{ review_id: "old" }]);
  expect(
    (await client.execute("SELECT reviews_collected_at FROM gbp_snapshots"))
      .rows[0].reviews_collected_at,
  ).toBe("old");
});

it("records a completed empty result without leaving old reviews", async () => {
  await repository.replaceReviews({
    snapshotId: "snapshot",
    reviews: [],
    collectedAt: "new",
  });
  expect(
    (await client.execute("SELECT * FROM gbp_snapshot_reviews")).rows,
  ).toHaveLength(0);
  expect(
    (await client.execute("SELECT reviews_collected_at FROM gbp_snapshots"))
      .rows[0].reviews_collected_at,
  ).toBe("new");
});
