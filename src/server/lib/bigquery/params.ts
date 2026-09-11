import { AppError } from "@/server/lib/errors";
import type { BqColumn, BqTableSpec } from "@/server/lib/bigquery/specs";

/**
 * Scalar types usable as a named query parameter. BigQuery's parameter API has
 * no reliable JSON type, so a JSON column travels as STRING and the SQL wraps
 * the source column in `PARSE_JSON` (see `columnSourceExpression`).
 */
export type BqParamType =
  | "STRING"
  | "INT64"
  | "FLOAT64"
  | "BOOL"
  | "DATE"
  | "TIMESTAMP";

/** A row headed for BigQuery: values are coerced per the spec's column types. */
export type BqInputRow = Record<string, unknown>;

export type BqQueryParam =
  | { type: BqParamType; value: unknown }
  | { type: "ARRAY<STRUCT>"; spec: BqTableSpec; rows: BqInputRow[] };

type WireParamType = {
  type: string;
  arrayType?: WireParamType;
  structTypes?: { name: string; type: WireParamType }[];
};

type WireParamValue = {
  value?: string | null;
  arrayValues?: WireParamValue[];
  structValues?: Record<string, WireParamValue>;
};

type WireQueryParameter = {
  name: string;
  parameterType: WireParamType;
  parameterValue: WireParamValue;
};

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Project ids allow hyphens, and org-prefixed ones look like `domain.com:id`. */
const PROJECT_ID_RE = /^[A-Za-z0-9.-]+(:[A-Za-z0-9.-]+)?$/;

export function buildQueryParameters(
  params: Record<string, BqQueryParam>,
): WireQueryParameter[] {
  return Object.entries(params).map(([name, param]) => {
    assertIdentifier(name, "query parameter");
    if (param.type === "ARRAY<STRUCT>") {
      return buildStructArrayParameter(name, param.spec, param.rows);
    }
    return {
      name,
      parameterType: { type: param.type },
      parameterValue: { value: encodeScalar(param.type, param.value) },
    };
  });
}

function buildStructArrayParameter(
  name: string,
  spec: BqTableSpec,
  rows: BqInputRow[],
): WireQueryParameter {
  return {
    name,
    parameterType: {
      type: "ARRAY",
      arrayType: {
        type: "STRUCT",
        structTypes: spec.columns.map((column) => ({
          name: column.name,
          type: { type: paramTypeForColumn(column) },
        })),
      },
    },
    parameterValue: {
      arrayValues: rows.map((row) => ({
        structValues: Object.fromEntries(
          spec.columns.map((column) => [
            column.name,
            { value: encodeColumnValue(column, row[column.name]) },
          ]),
        ),
      })),
    },
  };
}

function paramTypeForColumn(column: BqColumn): BqParamType {
  return column.type === "JSON" ? "STRING" : column.type;
}

/**
 * How a source column is read inside generated SQL. JSON columns arrive as
 * STRING parameters, so they need parsing back into the target's JSON column;
 * `PARSE_JSON` (not `SAFE.PARSE_JSON`) so malformed payloads fail loudly
 * instead of writing silent nulls.
 */
export function columnSourceExpression(
  column: BqColumn,
  alias: string,
): string {
  assertIdentifier(column.name, "column");
  const reference = `${alias}.${column.name}`;
  return column.type === "JSON" ? `PARSE_JSON(${reference})` : reference;
}

export function encodeColumnValue(
  column: BqColumn,
  value: unknown,
): string | null {
  if (column.type === "JSON" && value !== null && value !== undefined) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return encodeScalar(paramTypeForColumn(column), value);
}

/**
 * Every BigQuery parameter value is sent as a string (or null). `Date` maps to
 * the column's canonical text form, and a number against a TIMESTAMP is read as
 * epoch milliseconds (the JS convention), not seconds.
 */
function encodeScalar(type: BqParamType, value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return type === "DATE"
      ? value.toISOString().slice(0, 10)
      : value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && type === "TIMESTAMP") {
    return new Date(value).toISOString();
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Dataset, table and column names are interpolated into generated SQL, so they
 * are checked against the BigQuery identifier grammar rather than escaped.
 */
export function assertIdentifier(name: string, kind: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `Invalid BigQuery ${kind} name: ${JSON.stringify(name)}`,
    );
  }
}

export function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new AppError(
      "BIGQUERY_QUERY_FAILED",
      `Invalid GCP project id: ${JSON.stringify(projectId)}`,
    );
  }
}
