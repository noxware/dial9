export interface ColumnView<T> {
  readonly length: number;
  get(index: number): T | null;
}

export function arrayColumn<T>(
  values: ArrayLike<T | null | undefined>,
): ColumnView<T> {
  return {
    length: values.length,
    get(index) {
      return values[index] ?? null;
    },
  };
}

export function projectedColumn<Row, Value>(
  rows: readonly Row[],
  project: (row: Row) => Value | null | undefined,
): ColumnView<Value> {
  return {
    length: rows.length,
    get(index) {
      const row = rows[index];
      return row === undefined ? null : (project(row) ?? null);
    },
  };
}

export function mappedColumn<Input, Output>(
  source: ColumnView<Input>,
  project: (value: Input) => Output | null | undefined,
): ColumnView<Output> {
  return {
    length: source.length,
    get(index) {
      const value = source.get(index);
      return value === null ? null : (project(value) ?? null);
    },
  };
}

export interface IntervalData {
  readonly length: number;
  readonly start: ColumnView<number>;
  readonly end: ColumnView<number>;
  readonly y: ColumnView<number>;
}

export interface PointData {
  readonly length: number;
  readonly x: ColumnView<number>;
  readonly y: ColumnView<number>;
}

function commonLength(columns: readonly ColumnView<unknown>[]): number {
  const length = columns[0]?.length ?? 0;
  if (columns.some((column) => column.length !== length)) {
    throw new Error("panel data columns must have equal lengths");
  }
  return length;
}

export function intervalData(
  start: ColumnView<number>,
  end: ColumnView<number>,
  y: ColumnView<number>,
): IntervalData {
  return { length: commonLength([start, end, y]), start, end, y };
}

export function pointData(
  x: ColumnView<number>,
  y: ColumnView<number>,
): PointData {
  return { length: commonLength([x, y]), x, y };
}
