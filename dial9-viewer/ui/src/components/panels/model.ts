import type { ColumnView, IntervalData, PointData } from "./data.js";

export type PanelData = IntervalData | PointData;
export type SwatchKind = "area" | "line" | "reference";

export interface BackgroundComponent {
  readonly name: "background/v1";
  readonly color: string;
}

export interface IntervalAreaComponent {
  readonly name: "interval-area/v1";
  readonly data: IntervalData;
  readonly color: string;
}

export interface IntervalLineComponent {
  readonly name: "interval-line/v1";
  readonly data: IntervalData;
  readonly color: string;
}

export interface PolylineComponent {
  readonly name: "polyline/v1";
  readonly data: PointData;
  readonly color: string;
}

export interface HorizontalRuleComponent {
  readonly name: "horizontal-rule/v1";
  readonly value: number | null;
  readonly color: string;
}

export interface TooltipItem {
  readonly label: string;
  readonly values: ColumnView<unknown>;
  readonly unit?: string;
}

export interface TooltipComponent {
  readonly name: "tooltip/v1";
  readonly data: PanelData;
  readonly items: readonly TooltipItem[];
}

export interface SwatchComponent {
  readonly name: "swatch/v1";
  readonly label: string;
  readonly color: string;
  readonly kind: SwatchKind;
  readonly value?: number | null;
  readonly unit?: string;
}

export type Reduce =
  | "min"
  | "max"
  | "sum"
  | "count"
  | "mean"
  | {
      readonly name: "time-weighted-mean";
      readonly start: ColumnView<number>;
      readonly end: ColumnView<number>;
    };

export interface ReadoutItem {
  readonly label: string;
  readonly values: ColumnView<number>;
  readonly reduce: Reduce;
  readonly unit?: string;
}

export interface ReadoutComponent {
  readonly name: "readout/v1";
  readonly data: PanelData;
  readonly items: readonly ReadoutItem[];
}

export type GraphComponent =
  | BackgroundComponent
  | IntervalAreaComponent
  | IntervalLineComponent
  | PolylineComponent
  | HorizontalRuleComponent;

export type PresentationComponent =
  | TooltipComponent
  | SwatchComponent
  | ReadoutComponent;

export type PanelComponent = GraphComponent | PresentationComponent;

export interface PanelDomain {
  readonly min?: number;
  readonly max?: number;
  readonly include?: readonly number[];
}

export interface ResolvedPanel {
  readonly key: string;
  readonly title: string;
  readonly components: readonly PanelComponent[];
  readonly yDomain?: PanelDomain;
}
