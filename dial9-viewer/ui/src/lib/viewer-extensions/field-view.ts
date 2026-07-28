import type { CustomTraceEvent } from "../../types/trace.js";
import { parseManifest } from "./manifest.js";
import { ExtensionTableStore } from "./tables.js";
import type {
  ColumnChunk,
  PanelManifest,
  ViewerExtensionManifest,
} from "./types.js";

const TABLE_NAME = "field_values";
const SERIES_COLOR = "#4fc3f7";

export type FieldViewInterpretation = "intervals" | "points";

export interface FieldViewRequest {
  readonly eventName: string;
  readonly field: string;
  readonly unit?: string;
  readonly interpretation: FieldViewInterpretation;
}

export interface MaterializedFieldView {
  readonly panel: PanelManifest;
  readonly tables: ExtensionTableStore;
}

/**
 * Materialize one numeric custom-event field into the same immutable column
 * store consumed by WASM-backed semantic panels.
 */
export function materializeFieldView(
  events: readonly CustomTraceEvent[],
  request: FieldViewRequest,
): MaterializedFieldView {
  const manifest = fieldViewManifest(request);
  const tables = new ExtensionTableStore(manifest);
  const batch =
    request.interpretation === "intervals"
      ? intervalBatch(events, request.eventName, request.field)
      : pointBatch(events, request.eventName, request.field);

  if (batch.rows === 0) {
    const requirement =
      request.interpretation === "intervals"
        ? "two events at increasing timestamps"
        : "one timestamped event";
    throw new Error(
      `${request.eventName}.${request.field} requires at least ${requirement}`,
    );
  }
  if (!batchHasValue(batch.columns[batch.columns.length - 1]!)) {
    throw new Error(
      `${request.eventName}.${request.field} has no finite numeric values`,
    );
  }

  tables.append(batch);
  return Object.freeze({
    panel: manifest.panels[0]!,
    tables,
  });
}

function fieldViewManifest(
  request: FieldViewRequest,
): ViewerExtensionManifest {
  const intervals = request.interpretation === "intervals";
  const interpretation = intervals ? "Intervals" : "Points";
  const unit =
    request.unit === undefined || request.unit.length === 0
      ? undefined
      : request.unit;
  const itemUnit = unit === undefined ? {} : { unit };
  const timeColumn = intervals ? "start" : "timestamp";
  const graphs = intervals
    ? [
        {
          name: "interval-area/v1",
          table: TABLE_NAME,
          start: "start",
          end: "end",
          y: "value",
          color: SERIES_COLOR,
        },
        {
          name: "interval-line/v1",
          table: TABLE_NAME,
          start: "start",
          end: "end",
          y: "value",
          color: SERIES_COLOR,
        },
      ]
    : [
        {
          name: "line/v1",
          table: TABLE_NAME,
          x: "timestamp",
          y: "value",
          color: SERIES_COLOR,
        },
      ];
  const average = intervals
    ? {
        name: "time_weighted_mean",
        start: "start",
        end: "end",
      }
    : "mean";
  const components = [
    ...graphs,
    {
      name: "tooltip/v1",
      table: TABLE_NAME,
      items: [
        { label: request.field, column: "value", ...itemUnit },
        { label: "Time", column: timeColumn, unit: "timestamp" },
      ],
    },
    {
      name: "readout/v1",
      table: TABLE_NAME,
      items: [
        {
          label: "avg",
          column: "value",
          reduce: average,
          ...itemUnit,
        },
        {
          label: "min",
          column: "value",
          reduce: "min",
          ...itemUnit,
        },
        {
          label: "max",
          column: "value",
          reduce: "max",
          ...itemUnit,
        },
      ],
    },
  ];

  return parseManifest(
    JSON.stringify({
      version: 1,
      tables: [
        {
          name: TABLE_NAME,
          columns:
            intervals
              ? [
                  { name: "start", type: "f64" },
                  { name: "end", type: "f64" },
                  { name: "value", type: "f64", nullable: true },
                ]
              : [
                  { name: "timestamp", type: "f64" },
                  { name: "value", type: "f64", nullable: true },
                ],
        },
      ],
      panels: [
        {
          title: `${request.eventName} · ${request.field} · ${interpretation}`,
          components,
        },
      ],
    }),
  );
}

function pointBatch(
  events: readonly CustomTraceEvent[],
  eventName: string,
  field: string,
) {
  let rows = 0;
  let previousTimestamp = -Infinity;
  for (const event of events) {
    if (event.name !== eventName || !Number.isFinite(event.timestamp)) continue;
    assertChronological(event.timestamp, previousTimestamp);
    previousTimestamp = event.timestamp;
    rows++;
  }

  const timestamps = new Float64Array(rows);
  const values = new Float64Array(rows);
  const validity = new Uint8Array(Math.ceil(rows / 8));
  let row = 0;
  let valid = 0;

  for (const event of events) {
    if (event.name !== eventName || !Number.isFinite(event.timestamp)) continue;
    timestamps[row] = event.timestamp;
    const value = fieldViewNumber(event.fields[field]);
    if (value !== null) {
      values[row] = value;
      setValid(validity, row);
      valid++;
    }
    row++;
  }

  return {
    table: 0,
    rows,
    columns: [
      numericColumn(timestamps, rows),
      numericColumn(values, rows, valid === rows ? null : validity),
    ],
  } as const;
}

function intervalBatch(
  events: readonly CustomTraceEvent[],
  eventName: string,
  field: string,
) {
  let rows = 0;
  let previousTimestamp: number | null = null;
  for (const event of events) {
    if (event.name !== eventName || !Number.isFinite(event.timestamp)) continue;
    if (previousTimestamp !== null) {
      assertChronological(event.timestamp, previousTimestamp);
      if (event.timestamp > previousTimestamp) rows++;
    }
    previousTimestamp = event.timestamp;
  }

  const starts = new Float64Array(rows);
  const ends = new Float64Array(rows);
  const values = new Float64Array(rows);
  const validity = new Uint8Array(Math.ceil(rows / 8));
  let row = 0;
  let valid = 0;
  let previous: CustomTraceEvent | null = null;

  for (const event of events) {
    if (event.name !== eventName || !Number.isFinite(event.timestamp)) continue;
    if (previous === null) {
      previous = event;
      continue;
    }
    if (!(event.timestamp > previous.timestamp)) {
      previous = event;
      continue;
    }
    starts[row] = previous.timestamp;
    ends[row] = event.timestamp;
    const value = fieldViewNumber(previous.fields[field]);
    if (value !== null) {
      values[row] = value;
      setValid(validity, row);
      valid++;
    }
    row++;
    previous = event;
  }

  return {
    table: 0,
    rows,
    columns: [
      numericColumn(starts, rows),
      numericColumn(ends, rows),
      numericColumn(values, rows, valid === rows ? null : validity),
    ],
  } as const;
}

function numericColumn(
  values: Float64Array,
  rows: number,
  validity: Uint8Array | null = null,
): ColumnChunk {
  return {
    type: "f64",
    values,
    validity,
    rows,
  };
}

export function fieldViewNumber(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    typeof value !== "string"
  ) {
    return null;
  }
  if (typeof value === "string" && value.trim().length === 0) return null;
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function setValid(validity: Uint8Array, row: number): void {
  validity[row >> 3] = validity[row >> 3]! | (1 << (row & 7));
}

function assertChronological(timestamp: number, previous: number): void {
  if (timestamp < previous) {
    throw new Error("custom events must be ordered by timestamp");
  }
}

function batchHasValue(column: ColumnChunk): boolean {
  if (column.validity === null) return column.rows > 0;
  return column.validity.some((byte) => byte !== 0);
}
