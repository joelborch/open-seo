import { env } from "cloudflare:workers";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { getRequiredEnvValue } from "@/server/lib/runtime-env";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";
const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Google caps service-account assertions at one hour. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** Refresh early so a cached token never expires mid-query. */
const TOKEN_CACHE_MARGIN_SECONDS = 300;
/** KV rejects an expirationTtl under 60s. */
const MIN_TOKEN_CACHE_TTL_SECONDS = 60;

const tokenCacheKey = (clientEmail: string) =>
  `bigquery:access-token:${clientEmail}`;

export type BigQueryConfig = {
  projectId: string;
  location: string;
  clientEmail: string;
  privateKey: string;
};

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

/**
 * Service-account credentials for the monitoring pipeline's BigQuery access.
 * Deployment-level secrets rather than per-user OAuth (unlike the GA4/GSC
 * clients): the pipeline runs unattended against our own datasets.
 */
export async function getBigQueryConfig(): Promise<BigQueryConfig> {
  try {
    const [clientEmail, privateKey, projectId, location] = await Promise.all([
      getRequiredEnvValue("GCP_SA_CLIENT_EMAIL"),
      getRequiredEnvValue("GCP_SA_PRIVATE_KEY"),
      getRequiredEnvValue("GCP_PROJECT_ID"),
      getRequiredEnvValue("GCP_BQ_LOCATION"),
    ]);
    return {
      projectId,
      location,
      clientEmail,
      privateKey: normalizePrivateKey(privateKey),
    };
  } catch (error) {
    throw new AppError(
      "BIGQUERY_AUTH_FAILED",
      `BigQuery is not configured: ${error instanceof Error ? error.message : String(error)}. Set GCP_SA_CLIENT_EMAIL, GCP_SA_PRIVATE_KEY, GCP_PROJECT_ID and GCP_BQ_LOCATION (see src/server/lib/bigquery/README.md).`,
    );
  }
}

/**
 * Mints (and caches in KV) an OAuth access token for the BigQuery scope using
 * the JWT-bearer flow, which is the only service-account path available on
 * Workers — google-auth-library needs Node APIs we don't have.
 */
export async function getBigQueryAccessToken(): Promise<string> {
  const config = await getBigQueryConfig();
  const cacheKey = tokenCacheKey(config.clientEmail);

  const cached = await readCachedToken(cacheKey);
  if (cached) {
    return cached;
  }

  const assertion = await signAssertion(config);
  const token = await exchangeAssertion(assertion);

  await writeCachedToken(cacheKey, token.access_token, token.expires_in);

  return token.access_token;
}

/**
 * Secret stores that can't hold literal newlines (wrangler secret prompts, most
 * CI UIs) carry the PEM with escaped `\n`; importPKCS8 needs the real thing.
 */
function normalizePrivateKey(privateKey: string): string {
  return privateKey.includes("\\n")
    ? privateKey.replaceAll("\\n", "\n")
    : privateKey;
}

async function signAssertion(config: BigQueryConfig): Promise<string> {
  try {
    const key = await importPKCS8(config.privateKey, "RS256");
    const issuedAt = Math.floor(Date.now() / 1000);
    return await new SignJWT({ scope: BIGQUERY_SCOPE })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.clientEmail)
      .setAudience(TOKEN_ENDPOINT)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SECONDS)
      .sign(key);
  } catch (error) {
    console.warn("bigquery.assertion-sign failed:", error);
    throw new AppError(
      "BIGQUERY_AUTH_FAILED",
      "Could not sign the BigQuery service-account assertion — GCP_SA_PRIVATE_KEY is not a valid PKCS#8 PEM key.",
    );
  }
}

async function exchangeAssertion(assertion: string) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    }),
  });

  const body = await response.text();

  if (!response.ok) {
    // Body is Google's `{"error":"invalid_grant",...}` — it names the actual
    // cause (clock skew, revoked key, wrong audience) and carries no secret.
    throw new AppError(
      "BIGQUERY_AUTH_FAILED",
      `Google rejected the BigQuery service-account assertion (${response.status}): ${body.slice(0, 500)}`,
    );
  }

  const parsed = tokenResponseSchema.safeParse(safeJsonParse(body));
  if (!parsed.success) {
    throw new AppError(
      "BIGQUERY_AUTH_FAILED",
      "Google's token response did not contain an access token.",
    );
  }

  return parsed.data;
}

async function readCachedToken(cacheKey: string): Promise<string | null> {
  try {
    return await env.KV.get(cacheKey);
  } catch (error) {
    // A KV read outage must not take BigQuery down; mint a fresh token.
    console.warn("bigquery.token-cache-read failed:", error);
    return null;
  }
}

async function writeCachedToken(
  cacheKey: string,
  token: string,
  expiresIn: number,
): Promise<void> {
  const ttl = Math.max(
    expiresIn - TOKEN_CACHE_MARGIN_SECONDS,
    MIN_TOKEN_CACHE_TTL_SECONDS,
  );
  try {
    await env.KV.put(cacheKey, token, { expirationTtl: ttl });
  } catch (error) {
    console.warn("bigquery.token-cache-write failed:", error);
  }
}

function safeJsonParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
