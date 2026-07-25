export const VIEWER_EXTENSION_MANIFEST_SECTION =
  "dial9.viewer.manifest";

export type ColumnType = "f64" | "i64" | "u64" | "u32" | "u8" | "utf8";
export type NumericColumnType = Exclude<ColumnType, "utf8">;

export interface ColumnSchema {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable: boolean;
}

export interface TableSchema {
  readonly name: string;
  readonly columns: readonly ColumnSchema[];
}

export interface ScalarReference {
  readonly table: string;
  readonly column: string;
}

export type NumericValue = number | ScalarReference;
export type ColorValue = string | ScalarReference;

export interface ColorStop {
  readonly at: number;
  readonly color: string;
}

export type SeriesColor =
  | string
  | {
      readonly column: string;
      readonly stops: readonly ColorStop[];
    };

export interface VisibleScaleDomain {
  readonly mode: "visible";
  readonly include: readonly NumericValue[];
}

export interface FixedScaleDomain {
  readonly mode: "fixed";
  readonly min: NumericValue;
  readonly max: NumericValue;
}

export interface ScaleSpec {
  readonly name: string;
  readonly domain: VisibleScaleDomain | FixedScaleDomain;
}

export type XAxisSpec =
  | { readonly type: "time" }
  | {
      readonly type: "linear";
      readonly domain?: readonly [number, number];
    };

export interface ComponentMatch {
  readonly x?: string;
  readonly start?: string;
  readonly end?: string;
  readonly y?: string;
}

export interface StrokeStyle {
  readonly line_width?: number;
  readonly dash?: readonly number[];
}

export interface DrawingStyle extends StrokeStyle {
  readonly opacity?: number;
}

export interface BackgroundComponent {
  readonly name: "background/v1";
  readonly color: ColorValue;
}

export interface IntervalAreaComponent {
  readonly name: "interval-area/v1";
  readonly table: string;
  readonly start: string;
  readonly end: string;
  readonly y: string;
  readonly scale: string;
  readonly color: SeriesColor;
  readonly baseline: NumericValue;
  readonly opacity?: number;
}

export interface IntervalLineComponent extends DrawingStyle {
  readonly name: "interval-line/v1";
  readonly table: string;
  readonly start: string;
  readonly end: string;
  readonly y: string;
  readonly scale: string;
  readonly color: SeriesColor;
}

export interface PointLineComponent extends DrawingStyle {
  readonly name: "line/v1" | "step-line/v1" | "polyline/v1";
  readonly table: string;
  readonly x: string;
  readonly y: string;
  readonly scale: string;
  readonly color: SeriesColor;
}

export interface HorizontalRuleComponent extends DrawingStyle {
  readonly name: "horizontal-rule/v1";
  readonly y: NumericValue;
  readonly scale: string;
  readonly color: string;
}

export interface DisplayItem {
  readonly label: string;
  readonly column: string;
  readonly unit?: string;
  readonly max_fraction_digits?: number;
}

export interface TooltipComponent {
  readonly name: "tooltip/v1";
  readonly table: string;
  readonly match?: ComponentMatch;
  readonly items: readonly DisplayItem[];
}

export type ReducerName = "min" | "max" | "sum" | "count" | "mean";

export type ReadoutReducer =
  | ReducerName
  | {
      readonly name: "time_weighted_mean";
      readonly start: string;
      readonly end: string;
    };

export interface ReadoutItem extends DisplayItem {
  readonly reduce?: ReadoutReducer;
}

export interface ReadoutComponent {
  readonly name: "readout/v1";
  readonly table: string;
  readonly match?: ComponentMatch;
  readonly items: readonly ReadoutItem[];
}

export interface SwatchValue extends ScalarReference {
  readonly unit?: string;
  readonly max_fraction_digits?: number;
}

export interface SwatchComponent extends StrokeStyle {
  readonly name: "swatch/v1";
  readonly label: string;
  readonly color: string;
  readonly sample: "line" | "area" | "rule";
  readonly value?: SwatchValue;
}

export interface UnknownComponent {
  readonly name: string;
  readonly unsupported: true;
}

export type DrawingComponent =
  | BackgroundComponent
  | IntervalAreaComponent
  | IntervalLineComponent
  | PointLineComponent
  | HorizontalRuleComponent;

export type PresentationComponent =
  | TooltipComponent
  | ReadoutComponent
  | SwatchComponent;

export type ComponentSpec =
  | DrawingComponent
  | PresentationComponent
  | UnknownComponent;

export interface PanelSpec {
  readonly title: string;
  readonly height?: number;
  readonly x_axis: XAxisSpec;
  readonly scales: readonly ScaleSpec[];
  readonly components: readonly ComponentSpec[];
}

export interface ExtensionManifest {
  readonly version: 1;
  readonly tables: readonly TableSchema[];
  readonly panels: readonly PanelSpec[];
}

export class ExtensionManifestError extends Error {
  constructor(message: string) {
    super(`Invalid viewer extension manifest: ${message}`);
    this.name = "ExtensionManifestError";
  }
}

type JsonObject = Record<string, unknown>;

const COLUMN_TYPES = new Set<ColumnType>([
  "f64",
  "i64",
  "u64",
  "u32",
  "u8",
  "utf8",
]);
const NUMERIC_COLUMN_TYPES = new Set<ColumnType>([
  "f64",
  "i64",
  "u64",
  "u32",
  "u8",
]);
const REDUCERS = new Set<ReducerName>([
  "min",
  "max",
  "sum",
  "count",
  "mean",
]);

function fail(message: string): never {
  throw new ExtensionManifestError(message);
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") fail(`${path} must be a string`);
  return value;
}

function nonemptyString(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0) fail(`${path} must not be empty`);
  return result;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) fail(`${path} must be greater than zero`);
  return result;
}

function opacity(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const result = finite(value, path);
  if (result < 0 || result > 1) fail(`${path} must be between zero and one`);
  return result;
}

function fractionDigits(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  const result = finite(value, path);
  if (!Number.isSafeInteger(result) || result < 0 || result > 100) {
    fail(`${path} must be an integer between zero and 100`);
  }
  return result;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function tableByName(
  tables: ReadonlyMap<string, TableSchema>,
  name: unknown,
  path: string,
): TableSchema {
  const tableName = nonemptyString(name, path);
  const table = tables.get(tableName);
  if (table === undefined) fail(`${path} references unknown table ${tableName}`);
  return table;
}

function columnByName(
  table: TableSchema,
  name: unknown,
  path: string,
): ColumnSchema {
  const columnName = nonemptyString(name, path);
  const column = table.columns.find((candidate) => candidate.name === columnName);
  if (column === undefined) {
    fail(`${path} references unknown column ${table.name}.${columnName}`);
  }
  return column;
}

function numericColumn(
  table: TableSchema,
  name: unknown,
  path: string,
): string {
  const column = columnByName(table, name, path);
  if (!NUMERIC_COLUMN_TYPES.has(column.type)) {
    fail(`${path} must reference a numeric column`);
  }
  return column.name;
}

function scalarReference(
  value: unknown,
  tables: ReadonlyMap<string, TableSchema>,
  path: string,
  numeric: boolean,
): ScalarReference {
  const source = object(value, path);
  const table = tableByName(tables, source["table"], `${path}.table`);
  const column = columnByName(table, source["column"], `${path}.column`);
  if (numeric && !NUMERIC_COLUMN_TYPES.has(column.type)) {
    fail(`${path}.column must reference a numeric column`);
  }
  return { table: table.name, column: column.name };
}

function numericValue(
  value: unknown,
  tables: ReadonlyMap<string, TableSchema>,
  path: string,
): NumericValue {
  return typeof value === "number"
    ? finite(value, path)
    : scalarReference(value, tables, path, true);
}

function colorValue(
  value: unknown,
  tables: ReadonlyMap<string, TableSchema>,
  path: string,
): ColorValue {
  return typeof value === "string"
    ? nonemptyString(value, path)
    : scalarReference(value, tables, path, false);
}

function seriesColor(
  value: unknown,
  table: TableSchema,
  path: string,
): SeriesColor {
  if (typeof value === "string") return nonemptyString(value, path);
  const source = object(value, path);
  const column = numericColumn(table, source["column"], `${path}.column`);
  const stops = array(source["stops"], `${path}.stops`).map((entry, index) => {
    const stop = object(entry, `${path}.stops[${index}]`);
    return {
      at: finite(stop["at"], `${path}.stops[${index}].at`),
      color: nonemptyString(
        stop["color"],
        `${path}.stops[${index}].color`,
      ),
    };
  });
  if (stops.length === 0) fail(`${path}.stops must not be empty`);
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index]!.at <= stops[index - 1]!.at) {
      fail(`${path}.stops must be strictly increasing`);
    }
  }
  return { column, stops };
}

function strokeStyle(
  source: JsonObject,
  path: string,
): StrokeStyle {
  const result: { line_width?: number; dash?: readonly number[] } = {};
  if (source["line_width"] !== undefined) {
    result.line_width = positive(source["line_width"], `${path}.line_width`);
  }
  if (source["dash"] !== undefined) {
    result.dash = array(source["dash"], `${path}.dash`).map((entry, index) => {
      const length = finite(entry, `${path}.dash[${index}]`);
      if (length < 0) fail(`${path}.dash[${index}] must not be negative`);
      return length;
    });
  }
  return result;
}

function drawingStyle(
  source: JsonObject,
  path: string,
): DrawingStyle {
  const result: {
    line_width?: number;
    dash?: readonly number[];
    opacity?: number;
  } = { ...strokeStyle(source, path) };
  const layerOpacity = opacity(source["opacity"], `${path}.opacity`);
  if (layerOpacity !== undefined) result.opacity = layerOpacity;
  return result;
}

function match(
  value: unknown,
  table: TableSchema,
  path: string,
): ComponentMatch | undefined {
  if (value === undefined) return undefined;
  const source = object(value, path);
  const result: {
    x?: string;
    start?: string;
    end?: string;
    y?: string;
  } = {};
  for (const channel of ["x", "start", "end", "y"] as const) {
    if (source[channel] !== undefined) {
      result[channel] = columnByName(
        table,
        source[channel],
        `${path}.${channel}`,
      ).name;
    }
  }
  if (Object.keys(result).length === 0) fail(`${path} must not be empty`);
  return result;
}

function displayItem(
  value: unknown,
  table: TableSchema,
  path: string,
): DisplayItem {
  const source = object(value, path);
  const result: {
    label: string;
    column: string;
    unit?: string;
    max_fraction_digits?: number;
  } = {
    label: string(source["label"], `${path}.label`),
    column: columnByName(table, source["column"], `${path}.column`).name,
  };
  const unit = optionalString(source["unit"], `${path}.unit`);
  if (unit !== undefined) result.unit = unit;
  const digits = fractionDigits(
    source["max_fraction_digits"],
    `${path}.max_fraction_digits`,
  );
  if (digits !== undefined) result.max_fraction_digits = digits;
  return result;
}

function component(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableSchema>,
  scales: ReadonlySet<string>,
): ComponentSpec {
  const source = object(value, path);
  const name = nonemptyString(source["name"], `${path}.name`);

  if (name === "background/v1") {
    return {
      name,
      color: colorValue(source["color"], tables, `${path}.color`),
    };
  }

  if (name === "horizontal-rule/v1") {
    const scale = nonemptyString(source["scale"], `${path}.scale`);
    if (!scales.has(scale)) fail(`${path}.scale references unknown scale ${scale}`);
    return {
      name,
      y: numericValue(source["y"], tables, `${path}.y`),
      scale,
      color: nonemptyString(source["color"], `${path}.color`),
      ...drawingStyle(source, path),
    };
  }

  if (name === "swatch/v1") {
    const sample = nonemptyString(source["sample"], `${path}.sample`);
    if (sample !== "line" && sample !== "area" && sample !== "rule") {
      fail(`${path}.sample must be line, area, or rule`);
    }
    const result: {
      name: "swatch/v1";
      label: string;
      color: string;
      sample: "line" | "area" | "rule";
      value?: SwatchValue;
      line_width?: number;
      dash?: readonly number[];
    } = {
      name,
      label: string(source["label"], `${path}.label`),
      color: nonemptyString(source["color"], `${path}.color`),
      sample,
      ...strokeStyle(source, path),
    };
    if (source["value"] !== undefined) {
      const valueSource = object(source["value"], `${path}.value`);
      const reference = scalarReference(
        valueSource,
        tables,
        `${path}.value`,
        false,
      );
      const unit = optionalString(valueSource["unit"], `${path}.value.unit`);
      const digits = fractionDigits(
        valueSource["max_fraction_digits"],
        `${path}.value.max_fraction_digits`,
      );
      result.value = {
        ...reference,
        ...(unit === undefined ? {} : { unit }),
        ...(digits === undefined ? {} : { max_fraction_digits: digits }),
      };
    }
    return result;
  }

  if (
    name === "interval-area/v1" ||
    name === "interval-line/v1" ||
    name === "line/v1" ||
    name === "step-line/v1" ||
    name === "polyline/v1" ||
    name === "tooltip/v1" ||
    name === "readout/v1"
  ) {
    const table = tableByName(tables, source["table"], `${path}.table`);

    if (name === "tooltip/v1") {
      const items = array(source["items"], `${path}.items`).map((item, index) =>
        displayItem(item, table, `${path}.items[${index}]`),
      );
      if (items.length === 0) fail(`${path}.items must not be empty`);
      const componentMatch = match(source["match"], table, `${path}.match`);
      return componentMatch === undefined
        ? { name, table: table.name, items }
        : { name, table: table.name, match: componentMatch, items };
    }

    if (name === "readout/v1") {
      const items = array(source["items"], `${path}.items`).map((item, index) => {
        const itemPath = `${path}.items[${index}]`;
        const itemSource = object(item, itemPath);
        const base = displayItem(item, table, itemPath);
        const reducerSource = itemSource["reduce"];
        if (reducerSource === undefined) return base;

        let reduce: ReadoutReducer;
        if (typeof reducerSource === "string") {
          if (!REDUCERS.has(reducerSource as ReducerName)) {
            fail(`${itemPath}.reduce is unsupported`);
          }
          if (
            reducerSource !== "count" &&
            !NUMERIC_COLUMN_TYPES.has(
              columnByName(table, base.column, `${itemPath}.column`).type,
            )
          ) {
            fail(`${itemPath}.column must be numeric for ${reducerSource}`);
          }
          reduce = reducerSource as ReducerName;
        } else {
          const reducer = object(reducerSource, `${itemPath}.reduce`);
          if (reducer["name"] !== "time_weighted_mean") {
            fail(`${itemPath}.reduce.name is unsupported`);
          }
          if (
            !NUMERIC_COLUMN_TYPES.has(
              columnByName(table, base.column, `${itemPath}.column`).type,
            )
          ) {
            fail(`${itemPath}.column must be numeric for time_weighted_mean`);
          }
          reduce = {
            name: "time_weighted_mean",
            start: numericColumn(
              table,
              reducer["start"],
              `${itemPath}.reduce.start`,
            ),
            end: numericColumn(
              table,
              reducer["end"],
              `${itemPath}.reduce.end`,
            ),
          };
        }
        return { ...base, reduce };
      });
      if (items.length === 0) fail(`${path}.items must not be empty`);
      const componentMatch = match(source["match"], table, `${path}.match`);
      return componentMatch === undefined
        ? { name, table: table.name, items }
        : { name, table: table.name, match: componentMatch, items };
    }

    const scale = nonemptyString(source["scale"], `${path}.scale`);
    if (!scales.has(scale)) fail(`${path}.scale references unknown scale ${scale}`);
    const color = seriesColor(source["color"], table, `${path}.color`);

    if (name === "interval-area/v1" || name === "interval-line/v1") {
      const base = {
        table: table.name,
        start: numericColumn(table, source["start"], `${path}.start`),
        end: numericColumn(table, source["end"], `${path}.end`),
        y: numericColumn(table, source["y"], `${path}.y`),
        scale,
        color,
      };
      if (name === "interval-area/v1") {
        const baseline =
          source["baseline"] === undefined
            ? 0
            : numericValue(source["baseline"], tables, `${path}.baseline`);
        const layerOpacity = opacity(source["opacity"], `${path}.opacity`);
        return layerOpacity === undefined
          ? { name, ...base, baseline }
          : { name, ...base, baseline, opacity: layerOpacity };
      }
      return { name, ...base, ...drawingStyle(source, path) };
    }

    return {
      name,
      table: table.name,
      x: numericColumn(table, source["x"], `${path}.x`),
      y: numericColumn(table, source["y"], `${path}.y`),
      scale,
      color,
      ...drawingStyle(source, path),
    };
  }

  return { name, unsupported: true };
}

function parseTables(value: unknown): {
  readonly tables: readonly TableSchema[];
  readonly byName: ReadonlyMap<string, TableSchema>;
} {
  const names = new Set<string>();
  const tables = array(value, "tables").map((entry, tableIndex) => {
    const path = `tables[${tableIndex}]`;
    const source = object(entry, path);
    const name = nonemptyString(source["name"], `${path}.name`);
    if (names.has(name)) fail(`${path}.name duplicates table ${name}`);
    names.add(name);

    const columnNames = new Set<string>();
    const columns = array(source["columns"], `${path}.columns`).map(
      (columnEntry, columnIndex): ColumnSchema => {
        const columnPath = `${path}.columns[${columnIndex}]`;
        const column = object(columnEntry, columnPath);
        const columnName = nonemptyString(
          column["name"],
          `${columnPath}.name`,
        );
        if (columnNames.has(columnName)) {
          fail(`${columnPath}.name duplicates column ${name}.${columnName}`);
        }
        columnNames.add(columnName);
        const type = nonemptyString(column["type"], `${columnPath}.type`);
        if (!COLUMN_TYPES.has(type as ColumnType)) {
          fail(`${columnPath}.type ${type} is unsupported`);
        }
        const nullable = column["nullable"];
        if (nullable !== undefined && typeof nullable !== "boolean") {
          fail(`${columnPath}.nullable must be a boolean`);
        }
        return {
          name: columnName,
          type: type as ColumnType,
          nullable: nullable ?? false,
        };
      },
    );
    if (columns.length === 0) fail(`${path}.columns must not be empty`);
    return { name, columns };
  });
  return { tables, byName: new Map(tables.map((table) => [table.name, table])) };
}

function parseScale(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableSchema>,
): ScaleSpec {
  const source = object(value, path);
  const name = nonemptyString(source["name"], `${path}.name`);
  const domainSource = object(source["domain"], `${path}.domain`);
  const mode = nonemptyString(domainSource["mode"], `${path}.domain.mode`);
  if (mode === "visible") {
    const include =
      domainSource["include"] === undefined
        ? []
        : array(domainSource["include"], `${path}.domain.include`).map(
            (entry, index) =>
              numericValue(
                entry,
                tables,
                `${path}.domain.include[${index}]`,
              ),
          );
    return { name, domain: { mode, include } };
  }
  if (mode === "fixed") {
    const min = numericValue(domainSource["min"], tables, `${path}.domain.min`);
    const max = numericValue(domainSource["max"], tables, `${path}.domain.max`);
    if (typeof min === "number" && typeof max === "number" && min >= max) {
      fail(`${path}.domain.min must be less than max`);
    }
    return { name, domain: { mode, min, max } };
  }
  return fail(`${path}.domain.mode is unsupported`);
}

function parsePanel(
  value: unknown,
  index: number,
  tables: ReadonlyMap<string, TableSchema>,
): PanelSpec {
  const path = `panels[${index}]`;
  const source = object(value, path);
  const title = nonemptyString(source["title"], `${path}.title`);

  let height: number | undefined;
  if (source["height"] !== undefined) {
    height = positive(source["height"], `${path}.height`);
  }

  let x_axis: XAxisSpec = { type: "time" };
  if (source["x_axis"] !== undefined) {
    const xSource = object(source["x_axis"], `${path}.x_axis`);
    const type = nonemptyString(xSource["type"], `${path}.x_axis.type`);
    if (type === "time") {
      x_axis = { type };
    } else if (type === "linear") {
      if (xSource["domain"] === undefined) {
        x_axis = { type };
      } else {
        const values = array(xSource["domain"], `${path}.x_axis.domain`);
        if (values.length !== 2) {
          fail(`${path}.x_axis.domain must contain [min, max]`);
        }
        const min = finite(values[0], `${path}.x_axis.domain[0]`);
        const max = finite(values[1], `${path}.x_axis.domain[1]`);
        if (min >= max) fail(`${path}.x_axis.domain min must be less than max`);
        x_axis = { type, domain: [min, max] };
      }
    } else {
      fail(`${path}.x_axis.type is unsupported`);
    }
  }

  const scales = (source["scales"] === undefined
    ? []
    : array(source["scales"], `${path}.scales`)
  ).map((entry, scaleIndex) =>
    parseScale(entry, `${path}.scales[${scaleIndex}]`, tables),
  );
  const scaleNames = new Set<string>();
  for (const [scaleIndex, scale] of scales.entries()) {
    if (scaleNames.has(scale.name)) {
      fail(`${path}.scales[${scaleIndex}].name duplicates scale ${scale.name}`);
    }
    scaleNames.add(scale.name);
  }

  const components = array(source["components"], `${path}.components`).map(
    (entry, componentIndex) =>
      component(
        entry,
        `${path}.components[${componentIndex}]`,
        tables,
        scaleNames,
      ),
  );

  const result: {
    title: string;
    height?: number;
    x_axis: XAxisSpec;
    scales: readonly ScaleSpec[];
    components: readonly ComponentSpec[];
  } = { title, x_axis, scales, components };
  if (height !== undefined) result.height = height;
  return result;
}

export function parseExtensionManifestJson(json: string): ExtensionManifest {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(`JSON parse failed: ${message}`);
  }
  const source = object(value, "manifest");
  if (source["version"] !== 1) {
    fail(`version must be 1`);
  }
  const { tables, byName } = parseTables(source["tables"]);
  const panels = array(source["panels"], "panels").map((panel, index) =>
    parsePanel(panel, index, byName),
  );
  return { version: 1, tables, panels };
}

export function parseExtensionManifestBytes(
  bytes: Uint8Array,
): ExtensionManifest {
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("custom section is not valid UTF-8");
  }
  return parseExtensionManifestJson(json);
}
