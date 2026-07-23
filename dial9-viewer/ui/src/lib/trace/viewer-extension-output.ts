import type {
  ColumnarTable,
  DrawingComponent,
  LegendAtCursorSpec,
  LegendComponent,
  LegendStaticItem,
  PanelComponent,
  PanelManifest,
  ScaleSpec,
  TableColumn,
  NumericColumn,
  TooltipComponent,
  TooltipRowSpec,
  ViewBundle,
} from "../custom-views/types.js";

const MAGIC = [0x44, 0x39, 0x56, 0x4f] as const; // D9VO
const VERSION = 1;
const MAX_TOOLTIP_RADIUS = 128;

export const VIEW_OUTPUT_LIMITS = Object.freeze({
  bytes: 32 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
  tables: 256,
  columnsPerTable: 128,
  rowsPerTable: 1_000_000,
  cells: 4_000_000,
  utf8Rows: 500_000,
  panels: 16,
  panelHeight: 512,
  totalPanelHeight: 2048,
  componentsPerPanel: 64,
  displayItems: 256,
  stringBytes: 64 * 1024,
  presentedUtf8Bytes: 64 * 1024,
  renderRows: 2_000_000,
  intervalRows: 250_000,
  unsampledRows: 100_000,
  textRows: 10_000,
  horizontalRules: 256,
});

interface Utf8ColumnStats {
  readonly totalBytes: number;
  readonly maximumCellBytes: number;
  readonly firstCellBytes: number;
}

const UTF8_COLUMN_STATS = new WeakMap<readonly string[], Utf8ColumnStats>();

export class ViewerExtensionOutputError extends Error {
  constructor(message: string) {
    super(`Invalid viewer-extension output: ${message}`);
    this.name = "ViewerExtensionOutputError";
  }
}

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset = 0;

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength > VIEW_OUTPUT_LIMITS.bytes) {
      throw new ViewerExtensionOutputError(
        `output is ${buffer.byteLength} bytes; limit is ${VIEW_OUTPUT_LIMITS.bytes}`,
      );
    }
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);
  }

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  take(length: number, what: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining()) {
      throw new ViewerExtensionOutputError(`truncated ${what}`);
    }
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  u8(what: string): number {
    return this.take(1, what)[0]!;
  }

  u16(what: string): number {
    this.take(2, what);
    const value = this.view.getUint16(this.offset - 2, true);
    return value;
  }

  u32(what: string): number {
    this.take(4, what);
    const value = this.view.getUint32(this.offset - 4, true);
    return value;
  }

  align(alignment: number, what: string): void {
    const padding = (alignment - (this.offset % alignment)) % alignment;
    this.take(padding, `${what} alignment`);
  }

  utf8(length: number, what: string): string {
    if (length > VIEW_OUTPUT_LIMITS.stringBytes) {
      throw new ViewerExtensionOutputError(
        `${what} is ${length} bytes; limit is ${VIEW_OUTPUT_LIMITS.stringBytes}`,
      );
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.take(length, what));
    } catch {
      throw new ViewerExtensionOutputError(`${what} is not valid UTF-8`);
    }
  }

  string16(what: string): string {
    return this.utf8(this.u16(`${what} length`), what);
  }
}

function fail(message: string): never {
  throw new ViewerExtensionOutputError(message);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, what: string, limit: number): unknown[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  if (value.length > limit) fail(`${what} has ${value.length} entries; limit is ${limit}`);
  return value;
}

function string(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} must be a string`);
  if (new TextEncoder().encode(value).length > VIEW_OUTPUT_LIMITS.stringBytes) {
    fail(`${what} exceeds ${VIEW_OUTPUT_LIMITS.stringBytes} UTF-8 bytes`);
  }
  return value;
}

function optionalString(value: unknown, what: string): string | undefined {
  return value === undefined ? undefined : string(value, what);
}

function finite(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${what} must be a finite number`);
  }
  return value;
}

function optionalFinite(value: unknown, what: string): number | undefined {
  return value === undefined ? undefined : finite(value, what);
}

function bounded(
  value: unknown,
  what: string,
  minimum: number,
  maximum: number,
): number {
  const result = finite(value, what);
  if (result < minimum || result > maximum) {
    fail(`${what} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function optionalBounded(
  value: unknown,
  what: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : bounded(value, what, minimum, maximum);
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(`${what} must be a boolean`);
  return value;
}

function optionalBool(value: unknown, what: string): boolean | undefined {
  return value === undefined ? undefined : bool(value, what);
}

function dash(value: unknown, what: string): readonly number[] | undefined {
  if (value === undefined) return undefined;
  return array(value, what, 64).map((entry, index) =>
    bounded(entry, `${what}[${index}]`, 0, 1_000_000),
  );
}

function scale(value: unknown, index: number): ScaleSpec {
  const source = record(value, `scales[${index}]`);
  const result: ScaleSpec = {
    id: string(source["id"], `scales[${index}].id`),
  };
  const min = optionalFinite(source["min"], `scales[${index}].min`);
  const max = optionalFinite(source["max"], `scales[${index}].max`);
  const includeZero = optionalBool(
    source["includeZero"],
    `scales[${index}].includeZero`,
  );
  if (min !== undefined) Object.assign(result, { min });
  if (max !== undefined) Object.assign(result, { max });
  if (includeZero !== undefined) Object.assign(result, { includeZero });
  if (min !== undefined && max !== undefined && min > max) {
    fail(`scales[${index}] has min greater than max`);
  }
  return result;
}

function drawingBase(source: Record<string, unknown>, what: string) {
  return {
    id: string(source["id"], `${what}.id`),
    input: string(source["input"], `${what}.input`),
    scale: string(source["scale"], `${what}.scale`),
    valueColumn: string(source["valueColumn"], `${what}.valueColumn`),
  };
}

function stroke(source: Record<string, unknown>, what: string) {
  const lineWidth = optionalBounded(source["lineWidth"], `${what}.lineWidth`, 0, 1024);
  const result: {
    color: string;
    lineWidth?: number;
    dash?: readonly number[];
  } = {
    color: string(source["color"], `${what}.color`),
  };
  if (lineWidth !== undefined) result.lineWidth = lineWidth;
  const lineDash = dash(source["dash"], `${what}.dash`);
  if (lineDash !== undefined) result.dash = lineDash;
  return result;
}

function tooltipRow(value: unknown, what: string): TooltipRowSpec {
  const source = record(value, what);
  const result: TooltipRowSpec = {
    label: string(source["label"], `${what}.label`),
    field: string(source["field"], `${what}.field`),
  };
  const unit = optionalString(source["unit"], `${what}.unit`);
  if (unit !== undefined) Object.assign(result, { unit });
  return result;
}

function tooltip(source: Record<string, unknown>, what: string): TooltipComponent {
  const strategySource = record(source["strategy"], `${what}.strategy`);
  const strategyKind = string(strategySource["kind"], `${what}.strategy.kind`);
  let strategy: TooltipComponent["strategy"];
  if (strategyKind === "interval") {
    strategy = { kind: "interval" };
  } else if (strategyKind === "nearest-point") {
    const radius = optionalBounded(
      strategySource["radius"],
      `${what}.strategy.radius`,
      0,
      MAX_TOOLTIP_RADIUS,
    );
    strategy = radius === undefined ? { kind: "nearest-point" } : {
      kind: "nearest-point",
      radius,
    };
  } else {
    fail(`${what}.strategy.kind is unsupported`);
  }
  return {
    id: string(source["id"], `${what}.id`),
    kind: "tooltip",
    target: string(source["target"], `${what}.target`),
    strategy,
    rows: array(
      source["rows"],
      `${what}.rows`,
      VIEW_OUTPUT_LIMITS.displayItems,
    ).map((row, index) => tooltipRow(row, `${what}.rows[${index}]`)),
  };
}

function legendStatic(value: unknown, what: string): LegendStaticItem {
  const source = record(value, what);
  const result: LegendStaticItem = {
    label: string(source["label"], `${what}.label`),
  };
  const text = optionalString(source["value"], `${what}.value`);
  const color = optionalString(source["color"], `${what}.color`);
  if (text !== undefined) Object.assign(result, { value: text });
  if (color !== undefined) Object.assign(result, { color });
  return result;
}

function legendCursor(value: unknown, what: string): LegendAtCursorSpec {
  const source = record(value, what);
  const result: LegendAtCursorSpec = {
    input: string(source["input"], `${what}.input`),
    xColumn: string(source["xColumn"], `${what}.xColumn`),
    valueColumn: string(source["valueColumn"], `${what}.valueColumn`),
    label: string(source["label"], `${what}.label`),
  };
  const unit = optionalString(source["unit"], `${what}.unit`);
  const color = optionalString(source["color"], `${what}.color`);
  if (unit !== undefined) Object.assign(result, { unit });
  if (color !== undefined) Object.assign(result, { color });
  return result;
}

function legend(source: Record<string, unknown>, what: string): LegendComponent {
  const result: {
    id: string;
    kind: "legend";
    position?: "top-left" | "top-right";
    items?: readonly LegendStaticItem[];
    atCursor?: readonly LegendAtCursorSpec[];
  } = {
    id: string(source["id"], `${what}.id`),
    kind: "legend",
  };
  const position = optionalString(source["position"], `${what}.position`);
  if (
    position !== undefined &&
    position !== "top-left" &&
    position !== "top-right"
  ) {
    fail(`${what}.position must be "top-left" or "top-right"`);
  }
  if (position !== undefined) result.position = position;
  if (source["items"] !== undefined) {
    result.items = array(
      source["items"],
      `${what}.items`,
      VIEW_OUTPUT_LIMITS.displayItems,
    ).map((item, index) => legendStatic(item, `${what}.items[${index}]`));
  }
  if (source["atCursor"] !== undefined) {
    result.atCursor = array(
      source["atCursor"],
      `${what}.atCursor`,
      VIEW_OUTPUT_LIMITS.displayItems,
    ).map((item, index) => legendCursor(item, `${what}.atCursor[${index}]`));
  }
  return result;
}

function component(value: unknown, what: string): PanelComponent {
  const source = record(value, what);
  const kind = string(source["kind"], `${what}.kind`);

  switch (kind) {
    case "background":
      return {
        id: string(source["id"], `${what}.id`),
        kind,
        input: string(source["input"], `${what}.input`),
        colorColumn: string(source["colorColumn"], `${what}.colorColumn`),
      };
    case "interval-area": {
      const baseline = optionalFinite(source["baseline"], `${what}.baseline`);
      return {
        ...drawingBase(source, what),
        kind,
        startColumn: string(source["startColumn"], `${what}.startColumn`),
        endColumn: string(source["endColumn"], `${what}.endColumn`),
        color: string(source["color"], `${what}.color`),
        ...(baseline === undefined ? {} : { baseline }),
      };
    }
    case "interval-line":
      return {
        ...drawingBase(source, what),
        ...stroke(source, what),
        kind,
        startColumn: string(source["startColumn"], `${what}.startColumn`),
        endColumn: string(source["endColumn"], `${what}.endColumn`),
      };
    case "line":
    case "step-line": {
      const sampling = string(source["sampling"], `${what}.sampling`);
      if (sampling !== "none" && sampling !== "pixel") {
        fail(`${what}.sampling must be "none" or "pixel"`);
      }
      const gapColumn = optionalString(source["gapColumn"], `${what}.gapColumn`);
      return {
        ...drawingBase(source, what),
        ...stroke(source, what),
        kind,
        xColumn: string(source["xColumn"], `${what}.xColumn`),
        sampling,
        ...(gapColumn === undefined ? {} : { gapColumn }),
      };
    }
    case "polyline": {
      const gapColumn = optionalString(source["gapColumn"], `${what}.gapColumn`);
      return {
        ...drawingBase(source, what),
        ...stroke(source, what),
        kind,
        xColumn: string(source["xColumn"], `${what}.xColumn`),
        ...(gapColumn === undefined ? {} : { gapColumn }),
      };
    }
    case "horizontal-rule":
      return {
        ...drawingBase(source, what),
        ...stroke(source, what),
        kind,
      };
    case "text": {
      const color = optionalString(source["color"], `${what}.color`);
      const colorColumn = optionalString(source["colorColumn"], `${what}.colorColumn`);
      const font = optionalString(source["font"], `${what}.font`);
      const alignValue = optionalString(source["align"], `${what}.align`);
      if (
        alignValue !== undefined &&
        !["center", "end", "left", "right", "start"].includes(alignValue)
      ) {
        fail(`${what}.align is unsupported`);
      }
      return {
        ...drawingBase(source, what),
        kind,
        xColumn: string(source["xColumn"], `${what}.xColumn`),
        textColumn: string(source["textColumn"], `${what}.textColumn`),
        ...(color === undefined ? {} : { color }),
        ...(colorColumn === undefined ? {} : { colorColumn }),
        ...(font === undefined ? {} : { font }),
        ...(alignValue === undefined ? {} : { align: alignValue as CanvasTextAlign }),
      };
    }
    case "tooltip":
      return tooltip(source, what);
    case "legend":
      return legend(source, what);
    default:
      return fail(`${what}.kind ${JSON.stringify(kind)} is unsupported`);
  }
}

function panel(value: unknown, index: number): PanelManifest {
  const what = `panels[${index}]`;
  const source = record(value, what);
  const xSource = source["x"];
  let x: PanelManifest["x"];
  if (xSource !== undefined) {
    const xRecord = record(xSource, `${what}.x`);
    const xKind = string(xRecord["kind"], `${what}.x.kind`);
    if (xKind === "time") {
      x = { kind: "time" };
    } else if (xKind === "linear") {
      const min = finite(xRecord["min"], `${what}.x.min`);
      const max = finite(xRecord["max"], `${what}.x.max`);
      if (min >= max) fail(`${what}.x requires min < max`);
      x = { kind: "linear", min, max };
    } else {
      fail(`${what}.x.kind is unsupported`);
    }
  }
  const result: PanelManifest = {
    id: string(source["id"], `${what}.id`),
    title: string(source["title"], `${what}.title`),
    height: bounded(
      source["height"],
      `${what}.height`,
      16,
      VIEW_OUTPUT_LIMITS.panelHeight,
    ),
    components: array(
      source["components"],
      `${what}.components`,
      VIEW_OUTPUT_LIMITS.componentsPerPanel,
    ).map((entry, componentIndex) =>
      component(entry, `${what}.components[${componentIndex}]`),
    ),
  };
  if (x !== undefined) Object.assign(result, { x });
  if (source["scales"] !== undefined) {
    Object.assign(result, {
      scales: array(source["scales"], `${what}.scales`, 128).map(scale),
    });
  }
  return result;
}

function manifest(bytes: Uint8Array): readonly PanelManifest[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("manifest is not valid UTF-8 JSON");
  }
  const root = record(decoded, "manifest");
  if (root["version"] !== VERSION) fail(`manifest version must be ${VERSION}`);
  const panels = array(root["panels"], "panels", VIEW_OUTPUT_LIMITS.panels).map(panel);
  const totalHeight = panels.reduce((sum, value) => sum + value.height, 0);
  if (totalHeight > VIEW_OUTPUT_LIMITS.totalPanelHeight) {
    fail(
      `panels total ${totalHeight}px high; limit is ` +
        `${VIEW_OUTPUT_LIMITS.totalPanelHeight}px`,
    );
  }
  return panels;
}

function typedColumn(
  reader: Reader,
  kind: number,
  rows: number,
  byteLength: number,
  what: string,
): TableColumn {
  const widths: Readonly<Record<number, number>> = {
    1: 8, // f64
    2: 8, // u64
    3: 8, // i64
    4: 4, // u32
    5: 1, // u8
  };
  if (kind === 6) {
    const offsetsLength = (rows + 1) * 4;
    if (!Number.isSafeInteger(offsetsLength) || byteLength < offsetsLength) {
      fail(`${what} has an invalid UTF-8 offset table`);
    }
    reader.align(4, what);
    const data = reader.take(byteLength, what);
    const offsets = new Uint32Array(data.buffer, data.byteOffset, rows + 1);
    const strings = data.subarray(offsetsLength);
    if (offsets[0] !== 0 || offsets[rows] !== strings.length) {
      fail(`${what} UTF-8 offsets do not cover its string bytes`);
    }
    const result: string[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let maximumCellBytes = 0;
    for (let row = 0; row < rows; row++) {
      const start = offsets[row]!;
      const end = offsets[row + 1]!;
      if (start > end || end > strings.length) fail(`${what} UTF-8 offsets are invalid`);
      const cellBytes = end - start;
      if (cellBytes > VIEW_OUTPUT_LIMITS.stringBytes) {
        fail(
          `${what}[${row}] exceeds ` +
            `${VIEW_OUTPUT_LIMITS.stringBytes} UTF-8 bytes`,
        );
      }
      maximumCellBytes = Math.max(maximumCellBytes, cellBytes);
      try {
        result.push(decoder.decode(strings.subarray(start, end)));
      } catch {
        fail(`${what}[${row}] is not valid UTF-8`);
      }
    }
    UTF8_COLUMN_STATS.set(result, {
      totalBytes: strings.length,
      maximumCellBytes,
      firstCellBytes: rows === 0 ? 0 : offsets[1]!,
    });
    return result;
  }
  const width = widths[kind];
  if (width === undefined) fail(`${what} has unknown column kind ${kind}`);
  const expected = rows * width;
  if (!Number.isSafeInteger(expected) || expected !== byteLength) {
    fail(`${what} has ${byteLength} data bytes; expected ${expected}`);
  }
  reader.align(width, what);
  const data = reader.take(byteLength, what);
  switch (kind) {
    case 1:
      return new Float64Array(data.buffer, data.byteOffset, rows);
    case 2:
      return new BigUint64Array(data.buffer, data.byteOffset, rows);
    case 3:
      return new BigInt64Array(data.buffer, data.byteOffset, rows);
    case 4:
      return new Uint32Array(data.buffer, data.byteOffset, rows);
    case 5:
      return new Uint8Array(data.buffer, data.byteOffset, rows);
    default:
      return fail(`${what} has unknown column kind ${kind}`);
  }
}

function tables(reader: Reader, count: number): Readonly<Record<string, ColumnarTable>> {
  const result = Object.create(null) as Record<string, ColumnarTable>;
  let totalCells = 0;
  let totalUtf8Rows = 0;
  for (let tableIndex = 0; tableIndex < count; tableIndex++) {
    const tableName = reader.string16(`table ${tableIndex} name`);
    if (Object.hasOwn(result, tableName)) fail(`duplicate table ${JSON.stringify(tableName)}`);
    const rows = reader.u32(`table ${tableName} row count`);
    if (rows > VIEW_OUTPUT_LIMITS.rowsPerTable) {
      fail(
        `table ${JSON.stringify(tableName)} has ${rows} rows; limit is ` +
          VIEW_OUTPUT_LIMITS.rowsPerTable,
      );
    }
    const columnCount = reader.u16(`table ${tableName} column count`);
    if (columnCount > VIEW_OUTPUT_LIMITS.columnsPerTable) {
      fail(
        `table ${JSON.stringify(tableName)} has ${columnCount} columns; limit is ` +
          VIEW_OUTPUT_LIMITS.columnsPerTable,
      );
    }
    const columns = Object.create(null) as Record<string, TableColumn>;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const columnName = reader.string16(`table ${tableName} column ${columnIndex} name`);
      if (Object.hasOwn(columns, columnName)) {
        fail(
          `table ${JSON.stringify(tableName)} has duplicate column ` +
            JSON.stringify(columnName),
        );
      }
      const kind = reader.u8(`column ${columnName} kind`);
      const flags = reader.u8(`column ${columnName} flags`);
      const reserved = reader.u16(`column ${columnName} reserved`);
      if (flags !== 0 || reserved !== 0) {
        fail(`column ${JSON.stringify(columnName)} uses unsupported flags`);
      }
      const dataLength = reader.u32(`column ${columnName} data length`);
      totalCells += rows;
      if (!Number.isSafeInteger(totalCells) || totalCells > VIEW_OUTPUT_LIMITS.cells) {
        fail(`output has more than ${VIEW_OUTPUT_LIMITS.cells} table cells`);
      }
      if (kind === 6) {
        totalUtf8Rows += rows;
        if (
          !Number.isSafeInteger(totalUtf8Rows) ||
          totalUtf8Rows > VIEW_OUTPUT_LIMITS.utf8Rows
        ) {
          fail(`output has more than ${VIEW_OUTPUT_LIMITS.utf8Rows} UTF-8 rows`);
        }
      }
      columns[columnName] = typedColumn(
        reader,
        kind,
        rows,
        dataLength,
        `table ${JSON.stringify(tableName)} column ${JSON.stringify(columnName)}`,
      );
    }
    result[tableName] = { length: rows, columns };
  }
  return result;
}

function requireTable(
  bundle: ViewBundle,
  name: string,
  what: string,
): ColumnarTable {
  const source = bundle.tables[name];
  if (source === undefined) fail(`${what} references unknown table ${JSON.stringify(name)}`);
  return source;
}

function requireColumn(
  source: ColumnarTable,
  name: string,
  what: string,
  kind: "numeric" | "utf8",
): void {
  const value = source.columns[name];
  if (value === undefined) fail(`${what} references unknown column ${JSON.stringify(name)}`);
  const isUtf8 = Array.isArray(value);
  if ((kind === "utf8") !== isUtf8) {
    fail(`${what} column ${JSON.stringify(name)} must be ${kind}`);
  }
}

function numeric(source: ColumnarTable, name: string): NumericColumn {
  return source.columns[name] as NumericColumn;
}

function numericValue(source: NumericColumn, row: number): number {
  return Number(source[row]!);
}

function validateReferences(bundle: ViewBundle): void {
  const panelIds = new Set<string>();
  const finiteColumns = new Set<NumericColumn>();
  const sortedColumns = new Set<NumericColumn>();
  let renderRows = 0;
  let displayItems = 0;
  let presentedUtf8Bytes = 0;

  const addPresentedBytes = (bytes: number): void => {
    presentedUtf8Bytes += bytes;
    if (presentedUtf8Bytes > VIEW_OUTPUT_LIMITS.presentedUtf8Bytes) {
      fail(
        `panels reference more than ${VIEW_OUTPUT_LIMITS.presentedUtf8Bytes} ` +
          "UTF-8 bytes for presentation",
      );
    }
  };

  const addPresentedString = (value: string | undefined): void => {
    if (value !== undefined) addPresentedBytes(new TextEncoder().encode(value).length);
  };

  const addPresentedUtf8 = (
    column: TableColumn,
    rows: "all" | "first" | "one",
  ): void => {
    if (!Array.isArray(column)) return;
    const stats = UTF8_COLUMN_STATS.get(column);
    if (stats === undefined) fail("UTF-8 presentation accounting is unavailable");
    addPresentedBytes(
      rows === "all"
        ? stats.totalBytes
        : rows === "first"
          ? stats.firstCellBytes
          : stats.maximumCellBytes,
    );
  };

  const validateNumeric = (
    source: ColumnarTable,
    name: string,
    what: string,
    sorted: boolean,
  ): NumericColumn => {
    requireColumn(source, name, what, "numeric");
    const values = numeric(source, name);
    if (!finiteColumns.has(values)) {
      for (let row = 0; row < values.length; row++) {
        if (!Number.isFinite(numericValue(values, row))) {
          fail(`${what} column ${JSON.stringify(name)} has a non-finite value`);
        }
      }
      finiteColumns.add(values);
    }
    if (sorted && !sortedColumns.has(values)) {
      for (let row = 1; row < values.length; row++) {
        if (numericValue(values, row) < numericValue(values, row - 1)) {
          fail(`${what} column ${JSON.stringify(name)} must be sorted ascending`);
        }
      }
      sortedColumns.add(values);
    }
    return values;
  };

  for (const panel of bundle.panels) {
    if (!panelIds.add(panel.id)) fail(`duplicate panel id ${JSON.stringify(panel.id)}`);
    addPresentedString(panel.title);
    const scales = new Set<string>();
    for (const scale of panel.scales ?? []) {
      if (!scales.add(scale.id)) {
        fail(`panel ${JSON.stringify(panel.id)} has duplicate scale ${JSON.stringify(scale.id)}`);
      }
    }
    const drawings = new Map<string, DrawingComponent>();
    const componentIds = new Set<string>();
    for (const item of panel.components) {
      if (!componentIds.add(item.id)) {
        fail(
          `panel ${JSON.stringify(panel.id)} has duplicate component id ` +
            JSON.stringify(item.id),
        );
      }
      if (item.kind === "tooltip" || item.kind === "legend") continue;
      drawings.set(item.id, item);
      const source = requireTable(bundle, item.input, `component ${JSON.stringify(item.id)}`);
      if (item.kind === "background") {
        requireColumn(source, item.colorColumn, `component ${JSON.stringify(item.id)}`, "utf8");
        addPresentedUtf8(source.columns[item.colorColumn]!, "first");
        continue;
      }
      addPresentedString(item.color);
      if (item.kind === "text") addPresentedString(item.font);
      renderRows += source.length;
      if (renderRows > VIEW_OUTPUT_LIMITS.renderRows) {
        fail(
          `drawing components reference more than ` +
            `${VIEW_OUTPUT_LIMITS.renderRows} source rows`,
        );
      }
      if (!scales.has(item.scale)) {
        fail(
          `component ${JSON.stringify(item.id)} references unknown scale ` +
            JSON.stringify(item.scale),
        );
      }
      validateNumeric(
        source,
        item.valueColumn,
        `component ${JSON.stringify(item.id)}`,
        false,
      );
      if (item.kind === "interval-area" || item.kind === "interval-line") {
        if (source.length > VIEW_OUTPUT_LIMITS.intervalRows) {
          fail(
            `component ${JSON.stringify(item.id)} has ${source.length} intervals; ` +
              `limit is ${VIEW_OUTPUT_LIMITS.intervalRows}`,
          );
        }
        const starts = validateNumeric(
          source,
          item.startColumn,
          `component ${JSON.stringify(item.id)}`,
          true,
        );
        const ends = validateNumeric(
          source,
          item.endColumn,
          `component ${JSON.stringify(item.id)}`,
          true,
        );
        for (let row = 0; row < source.length; row++) {
          if (numericValue(starts, row) > numericValue(ends, row)) {
            fail(
              `component ${JSON.stringify(item.id)} has an interval whose ` +
                `start exceeds its end`,
            );
          }
        }
      } else if (item.kind === "line" || item.kind === "step-line") {
        if (
          item.sampling === "none" &&
          source.length > VIEW_OUTPUT_LIMITS.unsampledRows
        ) {
          fail(
            `component ${JSON.stringify(item.id)} has ${source.length} unsampled rows; ` +
              `limit is ${VIEW_OUTPUT_LIMITS.unsampledRows}`,
          );
        }
        validateNumeric(
          source,
          item.xColumn,
          `component ${JSON.stringify(item.id)}`,
          true,
        );
        if (item.gapColumn !== undefined) {
          validateNumeric(
            source,
            item.gapColumn,
            `component ${JSON.stringify(item.id)}`,
            false,
          );
        }
      } else if (item.kind === "polyline") {
        if (source.length > VIEW_OUTPUT_LIMITS.unsampledRows) {
          fail(
            `component ${JSON.stringify(item.id)} has ${source.length} unsampled rows; ` +
              `limit is ${VIEW_OUTPUT_LIMITS.unsampledRows}`,
          );
        }
        validateNumeric(
          source,
          item.xColumn,
          `component ${JSON.stringify(item.id)}`,
          false,
        );
        if (item.gapColumn !== undefined) {
          validateNumeric(
            source,
            item.gapColumn,
            `component ${JSON.stringify(item.id)}`,
            false,
          );
        }
      } else if (item.kind === "text") {
        if (source.length > VIEW_OUTPUT_LIMITS.textRows) {
          fail(
            `component ${JSON.stringify(item.id)} has ${source.length} text rows; ` +
              `limit is ${VIEW_OUTPUT_LIMITS.textRows}`,
          );
        }
        validateNumeric(
          source,
          item.xColumn,
          `component ${JSON.stringify(item.id)}`,
          true,
        );
        requireColumn(source, item.textColumn, `component ${JSON.stringify(item.id)}`, "utf8");
        addPresentedUtf8(source.columns[item.textColumn]!, "all");
        if (item.colorColumn !== undefined) {
          requireColumn(
            source,
            item.colorColumn,
            `component ${JSON.stringify(item.id)}`,
            "utf8",
          );
          addPresentedUtf8(source.columns[item.colorColumn]!, "all");
        }
      } else if (
        item.kind === "horizontal-rule" &&
        source.length > VIEW_OUTPUT_LIMITS.horizontalRules
      ) {
        fail(
          `component ${JSON.stringify(item.id)} has ${source.length} rules; ` +
            `limit is ${VIEW_OUTPUT_LIMITS.horizontalRules}`,
        );
      }
    }
    for (const item of panel.components) {
      if (item.kind === "tooltip") {
        displayItems += item.rows.length;
        const target = drawings.get(item.target);
        if (target === undefined) {
          fail(
            `tooltip ${JSON.stringify(item.id)} targets unknown drawing ` +
              JSON.stringify(item.target),
          );
        }
        if (
          (item.strategy.kind === "interval") !==
          (target.kind === "interval-area" || target.kind === "interval-line")
        ) {
          fail(`tooltip ${JSON.stringify(item.id)} strategy does not match its target`);
        }
        const source = requireTable(bundle, target.input, `tooltip ${JSON.stringify(item.id)}`);
        for (const row of item.rows) {
          addPresentedString(row.label);
          const field = source.columns[row.field];
          if (field === undefined) {
            fail(
              `tooltip ${JSON.stringify(item.id)} references unknown field ` +
                JSON.stringify(row.field),
            );
          }
          addPresentedUtf8(field, "one");
        }
      } else if (item.kind === "legend") {
        displayItems +=
          (item.items?.length ?? 0) + (item.atCursor?.length ?? 0);
        for (const staticItem of item.items ?? []) {
          addPresentedString(staticItem.label);
          addPresentedString(staticItem.value);
          addPresentedString(staticItem.color);
        }
        for (const cursor of item.atCursor ?? []) {
          addPresentedString(cursor.label);
          addPresentedString(cursor.color);
          const source = requireTable(
            bundle,
            cursor.input,
            `legend ${JSON.stringify(item.id)}`,
          );
          validateNumeric(
            source,
            cursor.xColumn,
            `legend ${JSON.stringify(item.id)}`,
            true,
          );
          const valueColumn = source.columns[cursor.valueColumn];
          if (valueColumn === undefined) {
            fail(
              `legend ${JSON.stringify(item.id)} references unknown value column ` +
                JSON.stringify(cursor.valueColumn),
            );
          }
          addPresentedUtf8(valueColumn, "one");
        }
      }
      if (displayItems > VIEW_OUTPUT_LIMITS.displayItems) {
        fail(
          `panels declare more than ${VIEW_OUTPUT_LIMITS.displayItems} ` +
            "tooltip and legend items",
        );
      }
    }
  }
}

/** Decode and validate an untrusted D9VO buffer before it reaches canvas/DOM. */
export function decodeViewerExtensionOutput(buffer: ArrayBuffer): ViewBundle {
  const reader = new Reader(buffer);
  const magic = reader.take(4, "magic");
  if (!MAGIC.every((byte, index) => magic[index] === byte)) fail("bad magic");
  const version = reader.u16("version");
  if (version !== VERSION) fail(`unsupported version ${version}`);
  const flags = reader.u16("flags");
  if (flags !== 0) fail(`unsupported flags 0x${flags.toString(16)}`);
  const manifestLength = reader.u32("manifest length");
  if (manifestLength > VIEW_OUTPUT_LIMITS.manifestBytes) {
    fail(
      `manifest is ${manifestLength} bytes; limit is ${VIEW_OUTPUT_LIMITS.manifestBytes}`,
    );
  }
  const tableCount = reader.u32("table count");
  if (tableCount > VIEW_OUTPUT_LIMITS.tables) {
    fail(`table count is ${tableCount}; limit is ${VIEW_OUTPUT_LIMITS.tables}`);
  }
  const panels = manifest(reader.take(manifestLength, "manifest"));
  const bundle: ViewBundle = { panels, tables: tables(reader, tableCount) };
  if (reader.remaining() !== 0) fail(`${reader.remaining()} trailing bytes`);
  validateReferences(bundle);
  return bundle;
}
