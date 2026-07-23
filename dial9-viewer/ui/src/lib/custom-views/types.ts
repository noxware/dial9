export type NumericColumn =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/** UTF-8 transport columns are decoded once at the bundle boundary. */
export type Utf8Column = readonly string[];
export type TableColumn = NumericColumn | Utf8Column;
export type TableCell = number | bigint | string;

export interface ColumnarTable {
  readonly length: number;
  readonly columns: Readonly<Record<string, TableColumn>>;
}

export interface ViewBundle {
  readonly panels: readonly PanelManifest[];
  readonly tables: Readonly<Record<string, ColumnarTable>>;
}

export interface ScaleSpec {
  readonly id: string;
  readonly min?: number;
  readonly max?: number;
  readonly includeZero?: boolean;
}

interface ComponentBase {
  readonly id: string;
}

interface InputComponentBase extends ComponentBase {
  readonly input: string;
}

interface ScaledComponentBase extends InputComponentBase {
  readonly scale: string;
  readonly valueColumn: string;
}

interface StrokeComponentBase extends ScaledComponentBase {
  readonly color: string;
  readonly lineWidth?: number;
  readonly dash?: readonly number[];
}

export interface BackgroundComponent extends InputComponentBase {
  readonly kind: "background";
  readonly colorColumn: string;
}

interface IntervalComponentBase extends ScaledComponentBase {
  /** Both columns must be sorted ascending. */
  readonly startColumn: string;
  readonly endColumn: string;
}

export interface IntervalAreaComponent extends IntervalComponentBase {
  readonly kind: "interval-area";
  readonly color: string;
  /** Defaults to zero. */
  readonly baseline?: number;
}

export interface IntervalLineComponent
  extends IntervalComponentBase,
    StrokeComponentBase {
  readonly kind: "interval-line";
}

interface PointStrokeComponentBase extends StrokeComponentBase {
  readonly xColumn: string;
  /**
   * A non-zero value starts a new subpath at this row. The row itself remains
   * drawable, so an already-materialized reset cannot bridge the old series.
   */
  readonly gapColumn?: string;
}

interface PointSeriesComponentBase extends PointStrokeComponentBase {
  /** Must be sorted ascending; equal adjacent x values are preserved. */
  readonly sampling: "none" | "pixel";
}

export interface LineComponent extends PointSeriesComponentBase {
  readonly kind: "line";
}

export interface StepLineComponent extends PointSeriesComponentBase {
  readonly kind: "step-line";
}

/** Draws every row in source order, including backward and repeated x values. */
export interface PolylineComponent extends PointStrokeComponentBase {
  readonly kind: "polyline";
}

export interface HorizontalRuleComponent extends StrokeComponentBase {
  readonly kind: "horizontal-rule";
}

export interface TextComponent extends ScaledComponentBase {
  readonly kind: "text";
  readonly xColumn: string;
  readonly textColumn: string;
  readonly color?: string;
  readonly colorColumn?: string;
  readonly font?: string;
  readonly align?: CanvasTextAlign;
}

export type TooltipHitStrategy =
  | { readonly kind: "interval" }
  | { readonly kind: "nearest-point"; readonly radius?: number };

export interface TooltipRowSpec {
  readonly label: string;
  readonly field: string;
  readonly unit?: string;
}

export interface TooltipComponent extends ComponentBase {
  readonly kind: "tooltip";
  readonly target: string;
  readonly strategy: TooltipHitStrategy;
  readonly rows: readonly TooltipRowSpec[];
}

export interface LegendStaticItem {
  readonly label: string;
  readonly value?: string;
  readonly color?: string;
}

export interface LegendAtCursorSpec {
  readonly input: string;
  readonly xColumn: string;
  readonly valueColumn: string;
  readonly label: string;
  readonly unit?: string;
  readonly color?: string;
}

export interface LegendComponent extends ComponentBase {
  readonly kind: "legend";
  readonly position?: "top-left" | "top-right";
  readonly items?: readonly LegendStaticItem[];
  readonly atCursor?: readonly LegendAtCursorSpec[];
}

export type DrawingComponent =
  | BackgroundComponent
  | IntervalAreaComponent
  | IntervalLineComponent
  | LineComponent
  | StepLineComponent
  | PolylineComponent
  | HorizontalRuleComponent
  | TextComponent;

export type PanelComponent =
  | DrawingComponent
  | TooltipComponent
  | LegendComponent;

export type PanelXAxis =
  | { readonly kind: "time" }
  | { readonly kind: "linear"; readonly min: number; readonly max: number };

export interface PanelManifest {
  readonly id: string;
  readonly title: string;
  readonly height: number;
  /** Defaults to the viewer's current time viewport. */
  readonly x?: PanelXAxis;
  /** May be omitted only when the panel has no scaled drawing components. */
  readonly scales?: readonly ScaleSpec[];
  /** Drawing entries are painted in this order. Later entries are on top. */
  readonly components: readonly PanelComponent[];
}

/** Draw-area geometry in CSS pixels. */
export interface PanelViewport {
  readonly startNs: number;
  readonly endNs: number;
  readonly width: number;
  readonly height: number;
}

export interface ScaleDomain {
  readonly min: number;
  readonly max: number;
}

export interface PanelRenderResult {
  readonly domains: ReadonlyMap<string, ScaleDomain>;
}

export interface PanelHit {
  readonly componentId: string;
  readonly row: number;
}

export interface TooltipRow {
  readonly label: string;
  readonly value: string;
}

export interface LegendItem {
  readonly label: string;
  readonly value?: string;
  readonly color?: string;
}

export interface LegendModel {
  readonly componentId: string;
  readonly position: "top-left" | "top-right";
  readonly items: readonly LegendItem[];
}
