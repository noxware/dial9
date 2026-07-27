import { pointData, projectedColumn } from "./data.js";
import type { ResolvedPanel } from "./model.js";

const BODY_COLOR = "#66d17a";
const FLAME_COLOR = "#ff7043";

const BODY = [
  [10, 3.0, "💩"], [18, 4.0, "💩"], [28, 5.8, ""],
  [40, 7.0, ""], [52, 6.8, ""], [59, 7.8, "❤️"],
  [66, 8.4, "❤️"], [76, 8.2, "❤️"], [78, 7.0, "❤️"],
  [69, 6.7, "❤️"], [63, 5.4, ""], [68, 4.8, ""],
  [62, 5.1, ""], [56, 3.8, ""], [56, 1.2, ""],
  [50, 1.2, ""], [48, 3.5, ""], [38, 3.6, ""],
  [38, 1.1, ""], [32, 1.1, ""], [34, 4.1, ""],
  [25, 4.4, "💩"], [10, 3.0, "💩"],
] as const;

const FLAMES = [
  [78, 7.6, "🔥"], [84, 8.5, "🔥"], [82, 7.5, "🔥"],
  [90, 7.8, "🔥"], [84, 6.8, "🔥"], [78, 7.2, "🔥"],
] as const;

export function dinosaurPanel(traceStart: number, traceEnd: number): ResolvedPanel {
  const timestamp = (percent: number): number =>
    traceStart + (traceEnd - traceStart) * (percent / 100);
  const body = pointData(
    projectedColumn(BODY, (point) => timestamp(point[0])),
    projectedColumn(BODY, (point) => point[1]),
  );
  const flames = pointData(
    projectedColumn(FLAMES, (point) => timestamp(point[0])),
    projectedColumn(FLAMES, (point) => point[1]),
  );

  return {
    key: "components.dinosaur",
    title: "Extremely Scientific Dinosaur",
    yDomain: { min: 0, max: 10 },
    components: [
      { name: "background/v1", color: "#102219" },
      { name: "polyline/v1", data: body, color: BODY_COLOR },
      { name: "polyline/v1", data: flames, color: FLAME_COLOR },
      {
        name: "tooltip/v1",
        data: body,
        items: [
          { label: "Dino says", values: projectedColumn(BODY, (point) => point[2]) },
        ],
      },
      {
        name: "tooltip/v1",
        data: flames,
        items: [
          { label: "Science", values: projectedColumn(FLAMES, (point) => point[2]) },
        ],
      },
      {
        name: "swatch/v1",
        label: "Dino 🦖",
        kind: "line",
        color: BODY_COLOR,
      },
      {
        name: "swatch/v1",
        label: "Flames 🔥",
        kind: "line",
        color: FLAME_COLOR,
      },
    ],
  };
}
