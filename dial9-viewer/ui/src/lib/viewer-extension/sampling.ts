import { normalizeValue } from "./geometry.js";

const ROWS_PER_PIXEL = 4;
const COLOR_ROWS_PER_PIXEL = 10;
export const SAMPLE_GAP = -1;

interface Bucket {
  first: number;
  last: number;
  minimum: number;
  maximum: number;
  minimumValue: number;
  maximumValue: number;
  colorMinimum?: number;
  colorMaximum?: number;
  colorMinimumValue?: number;
  colorMaximumValue?: number;
  colorTransitions?: number[];
  priorColorBand?: number;
  priorColorRow?: number;
}

function appendBucket(rows: number[], bucket: Bucket | undefined): void {
  if (bucket === undefined) return;
  const selected = [
    bucket.first,
    bucket.minimum,
    bucket.maximum,
    bucket.last,
    bucket.colorMinimum,
    bucket.colorMaximum,
    ...(bucket.colorTransitions ?? []),
  ].filter((row): row is number => row !== undefined).sort(
    (left, right) => left - right,
  );
  let prior = SAMPLE_GAP;
  for (const row of selected) {
    if (row !== prior) rows.push(row);
    prior = row;
  }
}

function colorBand(
  value: number | null,
  stops: readonly number[],
): number {
  if (value === null || stops.length < 2) return 0;
  for (let index = 1; index < stops.length; index += 1) {
    if (value < stops[index]!) return index - 1;
  }
  return stops.length - 1;
}

/**
 * Preserve source order, endpoints, and extrema while bounding dense sorted
 * series to representative rows per horizontal pixel and gap. When supplied,
 * color extrema and every transition between ramp bands are retained as well;
 * deliberately oscillating colors therefore remain dense.
 *
 * `null` means the caller should use the original range without allocating.
 */
export function minMaxRowsByPixel(
  start: number,
  end: number,
  pixelWidth: number,
  xStart: number,
  xEnd: number,
  xAt: (row: number) => number | null,
  yAt: (row: number) => number | null,
  colorAt?: (row: number) => number | null,
  colorStops: readonly number[] = [],
): readonly number[] | null {
  const columns = Math.max(1, Math.ceil(pixelWidth));
  const rowsPerPixel =
    colorAt === undefined ? ROWS_PER_PIXEL : COLOR_ROWS_PER_PIXEL;
  if (end - start <= columns * rowsPerPixel || !(xEnd > xStart)) {
    return null;
  }

  const rows: number[] = [];
  let activeColumn = -1;
  let bucket: Bucket | undefined;
  for (let row = start; row < end; row += 1) {
    const x = xAt(row);
    const y = yAt(row);
    if (x === null || y === null) {
      appendBucket(rows, bucket);
      bucket = undefined;
      activeColumn = -1;
      if (rows.at(-1) !== SAMPLE_GAP) rows.push(SAMPLE_GAP);
      continue;
    }
    const color = colorAt?.(row) ?? null;
    const band = colorBand(color, colorStops);
    const column = Math.max(
      0,
      Math.min(
        columns - 1,
        Math.floor(normalizeValue(x, xStart, xEnd) * columns),
      ),
    );
    if (column !== activeColumn) {
      appendBucket(rows, bucket);
      activeColumn = column;
      bucket = {
        first: row,
        last: row,
        minimum: row,
        maximum: row,
        minimumValue: y,
        maximumValue: y,
        ...(colorAt === undefined
          ? {}
          : {
              priorColorBand: band,
              priorColorRow: row,
              ...(color === null
                ? {}
                : {
                    colorMinimum: row,
                    colorMaximum: row,
                    colorMinimumValue: color,
                    colorMaximumValue: color,
                  }),
            }),
      };
      continue;
    }
    bucket!.last = row;
    if (y < bucket!.minimumValue) {
      bucket!.minimum = row;
      bucket!.minimumValue = y;
    }
    if (y > bucket!.maximumValue) {
      bucket!.maximum = row;
      bucket!.maximumValue = y;
    }
    if (colorAt !== undefined) {
      const priorColorBand = bucket!.priorColorBand!;
      const priorColorRow = bucket!.priorColorRow!;
      if (band !== priorColorBand) {
        const transitions = bucket!.colorTransitions ?? [];
        if (transitions.at(-1) !== priorColorRow) {
          transitions.push(priorColorRow);
        }
        transitions.push(row);
        bucket!.colorTransitions = transitions;
      }
      bucket!.priorColorBand = band;
      bucket!.priorColorRow = row;
      if (
        color !== null &&
        (bucket!.colorMinimumValue === undefined ||
          color < bucket!.colorMinimumValue)
      ) {
        bucket!.colorMinimum = row;
        bucket!.colorMinimumValue = color;
      }
      if (
        color !== null &&
        (bucket!.colorMaximumValue === undefined ||
          color > bucket!.colorMaximumValue)
      ) {
        bucket!.colorMaximum = row;
        bucket!.colorMaximumValue = color;
      }
    }
  }
  appendBucket(rows, bucket);
  if (rows.at(-1) === SAMPLE_GAP) rows.pop();
  return rows;
}
