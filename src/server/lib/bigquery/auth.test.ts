import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  kvGet: vi.fn<(key: string) => Promise<string | null>>(),
  kvPut: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { KV: { get: mocks.kvGet, put: mocks.kvPut } },
}));

import { getBigQueryAccessToken } from "./auth";

const CLIENT_EMAIL = "seo-yolo@example-project.iam.gserviceaccount.com";
const CACHE_KEY = `bigquery:access-token:${CLIENT_EMAIL}`;

// One throwaway key for the whole file: RSA generation is the slowest thing here
// and nothing in these tests depends on a per-test key.
const { privateKey } = await generateKeyPair("RS256", { extractable: true });
const privateKeyPem = await exportPKCS8(privateKey);

const headerSchema = z.object({ alg: z.string(), typ: z.string() });
const assertionSchema = z.object({
  iss: z.string(),
  scope: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
});

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

function sentAssertion(): { header: unknown; payload: unknown } {
  const body = mocks.fetch.mock.calls[0]?.[1]?.body;
  if (!(body instanceof URLSearchParams)) {
    throw new Error("token request body was not form-encoded");
  }
  expect(body.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const [header, payload] = (body.get("assertion") ?? "").split(".");
  return { header: decodeSegment(header), payload: decodeSegment(payload) };
}

describe("getBigQueryAccessToken", () => {
  beforeEach(() => {
    vi.stubEnv("GCP_SA_CLIENT_EMAIL", CLIENT_EMAIL);
    vi.stubEnv("GCP_SA_PRIVATE_KEY", privateKeyPem);
    vi.stubEnv("GCP_PROJECT_ID", "example-project");
    vi.stubEnv("GCP_BQ_LOCATION", "US");
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.kvGet.mockResolvedValue(null);
    mocks.fetch.mockResolvedValue(
      Response.json({ access_token: "ya29.minted", expires_in: 3600 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("exchanges an RS256 service-account assertion for an access token", async () => {
    await expect(getBigQueryAccessToken()).resolves.toBe("ya29.minted");

    expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
      "https://oauth2.googleapis.com/token",
    );
    const { header, payload } = sentAssertion();
    expect(headerSchema.parse(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = assertionSchema.parse(payload);
    expect(claims.iss).toBe(CLIENT_EMAIL);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/bigquery");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it("caches the minted token per service account, 5 minutes short of expiry", async () => {
    await getBigQueryAccessToken();

    expect(mocks.kvPut).toHaveBeenCalledWith(CACHE_KEY, "ya29.minted", {
      expirationTtl: 3300,
    });
  });

  it("reuses a cached token instead of minting a new one", async () => {
    mocks.kvGet.mockResolvedValue("ya29.cached");

    await expect(getBigQueryAccessToken()).resolves.toBe("ya29.cached");
    expect(mocks.kvGet).toHaveBeenCalledWith(CACHE_KEY);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("accepts a private key whose newlines are backslash-escaped", async () => {
    vi.stubEnv("GCP_SA_PRIVATE_KEY", privateKeyPem.replaceAll("\n", "\\n"));

    await expect(getBigQueryAccessToken()).resolves.toBe("ya29.minted");
  });

  it("fails with BIGQUERY_AUTH_FAILED when Google rejects the assertion", async () => {
    mocks.fetch.mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );

    await expect(getBigQueryAccessToken()).rejects.toMatchObject({
      code: "BIGQUERY_AUTH_FAILED",
    });
  });

  it("fails with BIGQUERY_AUTH_FAILED when a credential is not configured", async () => {
    vi.stubEnv("GCP_PROJECT_ID", "");

    await expect(getBigQueryAccessToken()).rejects.toMatchObject({
      code: "BIGQUERY_AUTH_FAILED",
    });
  });
});
