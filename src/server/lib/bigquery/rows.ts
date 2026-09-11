/**
 * BigQuery's REST read format is positional: `schema.fields[i]` names and types
 * the value at `rows[n].f[i].v`, every scalar arrives as a string (or null), and
 * repeated/record fields nest the same shape. This module is the one place that
 * turns that into plain objects.
 */

export type BqValue =
  | string
  | number
  | boolean
  | Date
  | null
  | BqValue[]
  | { [field: string]: BqValue };

export type BqRow = Record<string, BqValue>;

export type BqSchemaField = {
  name: string;
  type: string;
  mode?: string;
  fields?: BqSchemaField[];
};

type BqRawCell = { v?: unknown };
type BqRawRow = { f?: BqRawCell[] };

export function coerceRows(
  fields: BqSchemaField[],
  rawRows: BqRawRow[],
): BqRow[] {
  return rawRows.map((rawRow) => coerceRecord(fields, rawRow));
}

function coerceRecord(fields: BqSchemaField[], rawRow: BqRawRow): BqRow {
  const row: BqRow = {};
  fields.forEach((field, index) => {
    row[field.name] = coerceField(field, rawRow.f?.[index]?.v);
  });
  return row;
}

function coerceField(field: BqSchemaField, value: unknown): BqValue {
  if (field.mode === "REPEATED") {
    // A repeated field's `v` is itself a list of cells.
    return asCells(value).map((cell) =>
      coerceValue({ ...field, mode: undefined }, cell.v),
    );
  }
  return coerceValue(field, value);
}

function coerceValue(field: BqSchemaField, value: unknown): BqValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (field.type === "RECORD" || field.type === "STRUCT") {
    const nested = asRawRow(value);
    return nested ? coerceRecord(field.fields ?? [], nested) : null;
  }

  if (typeof value !== "string") {
    // Only nested shapes are non-strings on the wire; anything else is a
    // BigQuery change we shouldn't silently reinterpret.
    return null;
  }

  switch (field.type) {
    case "INTEGER":
    case "INT64": {
      // Out-of-safe-range ids (BigQuery INT64 is 64-bit) stay strings rather
      // than losing precision to a float.
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : value;
    }
    case "FLOAT":
    case "FLOAT64": {
      const parsed = Number(value);
      return Number.isNaN(parsed) ? value : parsed;
    }
    case "BOOLEAN":
    case "BOOL":
      return value === "true";
    case "TIMESTAMP": {
      // Epoch seconds with microsecond precision, e.g. "1700000000.123456".
      const seconds = Number(value);
      return Number.isNaN(seconds) ? value : new Date(seconds * 1000);
    }
    // DATE / DATETIME / TIME stay as their canonical strings (no timezone to
    // anchor them to), and JSON stays raw text for the caller to parse.
    default:
      return value;
  }
}

function asCells(value: unknown): BqRawCell[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    isRecord(entry) ? { v: entry.v } : { v: undefined },
  );
}

function asRawRow(value: unknown): BqRawRow | null {
  if (!isRecord(value)) return null;
  return { f: asCells(value.f) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
