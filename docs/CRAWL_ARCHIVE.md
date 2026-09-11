# Crawl Archive Tooling

OpenSEO archives raw crawl runs to Cloudflare R2 as gzipped NDJSON shards for cold storage, deep-dive debugging, and ad-hoc analytical queries on a local laptop.

## Planned R2 Layout

Each crawl run writes under an organization and project prefix:

```text
crawls/{orgId}/{projectId}/{runId}/
├── manifest.json          # Run metadata, crawl stats, page/link counts
├── pages-NNN.ndjson.gz    # Sharded page crawl records (status, headers, HTML metadata)
├── links-NNN.ndjson.gz    # Sharded internal and external link records
└── issues.ndjson.gz       # Detected audit issues per URL with severity
```

## rclone Remote Configuration

Configure `rclone` to mount or sync from the R2 S3-compatible endpoint using an API token with Object Read permissions:

```ini
# ~/.config/rclone/rclone.conf
[r2-openseo]
type = s3
provider = Cloudflare
endpoint = https://<accountId>.r2.cloudflarestorage.com
access_key_id = <r2_access_key_id>
secret_access_key = <r2_secret_access_key>
acl = private
```

Sync a run to local disk:

```bash
rclone sync r2-openseo:open-seo/crawls/org_123/proj_456/run_789 ./crawl-run-789
```

## Wrangler Object Fetch

Download individual archive artifacts directly with Wrangler:

```bash
npx wrangler r2 object get open-seo/crawls/org_123/proj_456/run_789/issues.ndjson.gz \
  --file=issues-run-789.ndjson.gz
```

## DuckDB Queries via httpfs

Query archived crawls directly from R2 without downloading files locally using DuckDB's `httpfs` extension and native R2 secret support.

### Secret Setup

```sql
INSTALL httpfs;
LOAD httpfs;

CREATE SECRET (
  TYPE r2,
  KEY_ID '<r2_access_key_id>',
  SECRET '<r2_secret_access_key>',
  ACCOUNT_ID '<accountId>'
);
```

### Scan Crawl Pages

Inspect crawled pages across shards for a specific run or project:

```sql
SELECT url, status_code, title
FROM read_ndjson_auto('r2://open-seo/crawls/org_123/proj_456/*/pages-*.ndjson.gz')
WHERE status_code >= 400
LIMIT 20;
```

### Cross-Run Diff: URLs Gaining Critical Issues

Identify URLs that acquired new critical issues in a recent run (`run_b`) compared to a baseline (`run_a`):

```sql
WITH run_a_critical AS (
  SELECT DISTINCT url, issue_type
  FROM read_ndjson_auto('r2://open-seo/crawls/org_123/proj_456/run_a/issues.ndjson.gz')
  WHERE severity = 'critical'
),
run_b_critical AS (
  SELECT DISTINCT url, issue_type
  FROM read_ndjson_auto('r2://open-seo/crawls/org_123/proj_456/run_b/issues.ndjson.gz')
  WHERE severity = 'critical'
)
SELECT
  b.url,
  b.issue_type AS new_critical_issue
FROM run_b_critical b
LEFT JOIN run_a_critical a
  ON b.url = a.url AND b.issue_type = a.issue_type
WHERE a.issue_type IS NULL
ORDER BY b.url;
```
