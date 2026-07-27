import { normalizeValue } from "./geometry.js";

const ROWS_PER_PIXEL = 4;
export const SAMPLE_GAP = -1;

interface Bucket {
  first: number;
  last: number;
  minimum: number;
  maximum: number;
  minimumValue: number;
  maximumValue: number;
}

function appendBucket(rows: number[], bucket: Bucket | undefined): void {
  if (bucket === undefined) return;
  const selected = [
    bucket.first,
    bucket.minimum,
    bucket.maximum,
    bucket.last,
  ].sort((left, right) => left - right);
  let prior = SAMPLE_GAP;
  for (const row of selected) {
    if (row !== prior) rows.push(row);
    prior = row;
  }
}

/**
 * Preserve source order, endpoints, and extrema while bounding dense sorted
 * series to at most four representative rows per horizontal pixel and gap.
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
): readonly number[] | null {
  const columns = Math.max(1, Math.ceil(pixelWidth));
  if (end - start <= columns * ROWS_PER_PIXEL || !(xEnd > xStart)) {
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
  }
  appendBucket(rows, bucket);
  if (rows.at(-1) === SAMPLE_GAP) rows.pop();
  return rows;
}
