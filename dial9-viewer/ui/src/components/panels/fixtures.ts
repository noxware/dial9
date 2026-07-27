import {
  intervalData,
  mappedColumn,
  projectedColumn,
} from "./data.js";
import type { ResolvedPanel } from "./model.js";

const CPU_COLOR = "#4fc3f7";
const CAPACITY_COLOR = "rgba(255,207,153,0.65)";

export interface CpuInterval {
  readonly start: number;
  readonly end: number;
  readonly wallDeltaNs: number;
  readonly cpuDeltaNs: number;
  readonly cores: number;
  readonly totalPercent?: number | null;
}

export interface CpuPanelInput {
  readonly intervals: readonly CpuInterval[];
  readonly capacity: number | null;
}

export function cpuPanel(input: CpuPanelInput): ResolvedPanel | null {
  if (input.intervals.length === 0) return null;
  const start = projectedColumn(input.intervals, (row) => row.start);
  const end = projectedColumn(input.intervals, (row) => row.end);
  const cores = projectedColumn(input.intervals, (row) => row.cores);
  const intervals = intervalData(start, end, cores);
  const percent = input.capacity === null
    ? projectedColumn(input.intervals, (row) => row.totalPercent)
    : mappedColumn(cores, (value) => Math.min(100, (value / input.capacity!) * 100));

  return {
    key: "components.cpu",
    title: "CPU Usage",
    yDomain: { min: 0, include: [1] },
    components: [
      ...(input.capacity === null
        ? []
        : [{
            name: "horizontal-rule/v1" as const,
            value: input.capacity,
            color: CAPACITY_COLOR,
          }]),
      { name: "interval-area/v1", data: intervals, color: CPU_COLOR },
      { name: "interval-line/v1", data: intervals, color: CPU_COLOR },
      {
        name: "tooltip/v1",
        data: intervals,
        items: [
          {
            label: "Window",
            values: projectedColumn(input.intervals, (row) => row.wallDeltaNs),
            unit: "ns",
          },
          {
            label: "CPU time",
            values: projectedColumn(input.intervals, (row) => row.cpuDeltaNs),
            unit: "ns",
          },
          { label: "Cores", values: cores },
          ...(input.capacity === null
            ? []
            : [{ label: "Total CPU", values: percent, unit: "%" }]),
        ],
      },
      ...(input.capacity === null
        ? []
        : [{
            name: "swatch/v1" as const,
            label: "available parallelism",
            kind: "reference" as const,
            color: CAPACITY_COLOR,
            value: input.capacity,
            unit: "cores",
          }]),
      {
        name: "readout/v1",
        data: intervals,
        items: [
          {
            label: "avg",
            values: cores,
            reduce: { name: "time-weighted-mean", start, end },
            unit: "cores",
          },
          ...(input.capacity === null
            ? []
            : [{
                label: "avg",
                values: percent,
                reduce: { name: "time-weighted-mean" as const, start, end },
                unit: "%",
              }]),
          { label: "max", values: cores, reduce: "max", unit: "cores" },
        ],
      },
    ],
  };
}
