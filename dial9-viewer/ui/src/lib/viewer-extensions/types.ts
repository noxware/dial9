export const VIEWER_EXTENSION_ABI_VERSION = 1;
export const VIEWER_EXTENSION_MANIFEST_SECTION = "dial9.viewer.manifest";

export type ColumnType = "f64" | "i64" | "u64" | "u32" | "u8" | "utf8";

export interface ColumnManifest {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}

export interface TableManifest {
  readonly name: string;
  readonly columns: readonly ColumnManifest[];
}

export type ReducerName = "min" | "max" | "sum" | "count" | "mean";

export interface TimeWeightedMean {
  readonly name: "time_weighted_mean";
  readonly start: string;
  readonly end: string;
}

export type Reducer = ReducerName | TimeWeightedMean;

export interface ScalarRef {
  readonly table: string;
  readonly column: string;
  readonly select?: "first" | "last";
  readonly reduce?: ReducerName;
}

export type DomainValue = number | ScalarRef;

export interface AxisManifest {
  readonly kind: "time" | "linear";
}

export interface ScaleManifest {
  readonly name: string;
  readonly include_zero?: boolean;
  readonly min?: DomainValue;
  readonly max?: DomainValue;
}

export interface ColorStop {
  readonly value: number;
  readonly color: string;
}

export interface ColorRamp {
  readonly column: string;
  readonly stops: readonly ColorStop[];
}

export type ColorSpec = string | ColorRamp;

export interface TooltipItem {
  readonly label: string;
  readonly column: string;
  readonly unit?: string;
}

export interface ReadoutItem extends TooltipItem {
  readonly reduce?: Reducer;
  readonly sample?: "hit" | "cursor";
}

export interface ChannelMatch {
  readonly x?: string;
  readonly start?: string;
  readonly end?: string;
  readonly y?: string;
}

/**
 * Component manifests stay structurally open so a newer component version can
 * reach an older viewer and produce an explicit in-panel compatibility error.
 */
export interface ComponentManifest {
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface PanelManifest {
  readonly title: string;
  readonly x_axis: AxisManifest;
  readonly y_scales: readonly ScaleManifest[];
  readonly components: readonly ComponentManifest[];
}

export interface ViewerExtensionManifest {
  readonly version: 1;
  readonly tables: readonly TableManifest[];
  readonly panels: readonly PanelManifest[];
}

export interface NumericColumnChunk<T extends ArrayBufferView = ArrayBufferView> {
  readonly type: Exclude<ColumnType, "utf8">;
  readonly values: T;
  readonly validity: Uint8Array | null;
  readonly rows: number;
}

export interface Utf8ColumnChunk {
  readonly type: "utf8";
  readonly offsets: Uint32Array;
  readonly data: Uint8Array;
  readonly validity: Uint8Array | null;
  readonly rows: number;
}

export type ColumnChunk = NumericColumnChunk | Utf8ColumnChunk;

export interface RecordBatch {
  readonly table: number;
  readonly rows: number;
  readonly columns: readonly ColumnChunk[];
}

export interface ExtensionIdentity {
  readonly id: string;
  readonly name: string;
}
