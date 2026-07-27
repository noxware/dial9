import {
  VIEWER_EXTENSION_MANIFEST_SECTION,
  type AxisManifest,
  type ColorSpec,
  type ColumnManifest,
  type ColumnType,
  type ComponentManifest,
  type DomainValue,
  type PanelManifest,
  type Reducer,
  type ScalarRef,
  type ScaleManifest,
  type TableManifest,
  type ViewerExtensionManifest,
} from "./types.js";

const COLUMN_TYPES = new Set<ColumnType>([
  "f64",
  "i64",
  "u64",
  "u32",
  "u8",
  "utf8",
]);
const NUMERIC_TYPES = new Set<ColumnType>(["f64", "i64", "u64", "u32", "u8"]);
const KNOWN_COMPONENTS = new Set([
  "background/v1",
  "interval-area/v1",
  "interval-line/v1",
  "line/v1",
  "step-line/v1",
  "polyline/v1",
  "horizontal-rule/v1",
  "tooltip/v1",
  "swatch/v1",
  "readout/v1",
]);

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestError";
  }
}

export function manifestFromModule(module: WebAssembly.Module): ViewerExtensionManifest {
  const sections = WebAssembly.Module.customSections(
    module,
    VIEWER_EXTENSION_MANIFEST_SECTION,
  );
  if (sections.length !== 1) {
    throw new ManifestError(
      `expected exactly one ${VIEWER_EXTENSION_MANIFEST_SECTION} custom section`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(sections[0]);
  } catch {
    throw new ManifestError("manifest custom section is not valid UTF-8");
  }
  return parseManifest(text);
}

export function parseManifest(json: string): ViewerExtensionManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new ManifestError(
      `manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = record(raw, "manifest");
  exactKeys(root, ["version", "tables", "panels"], "manifest");
  if (root.version !== 1) throw new ManifestError("manifest.version must be 1");

  const tableNames = new Set<string>();
  const tables = array(root.tables, "manifest.tables").map((value, index) => {
    const table = record(value, `manifest.tables[${index}]`);
    exactKeys(table, ["name", "columns"], `manifest.tables[${index}]`);
    const name = nonemptyString(table.name, `manifest.tables[${index}].name`);
    if (tableNames.has(name)) throw new ManifestError(`duplicate table ${JSON.stringify(name)}`);
    tableNames.add(name);
    const columnNames = new Set<string>();
    const columns = array(table.columns, `table ${name}.columns`).map((entry, columnIndex) => {
      const column = record(entry, `table ${name}.columns[${columnIndex}]`);
      exactKeys(column, ["name", "type", "nullable"], `table ${name}.columns[${columnIndex}]`, [
        "nullable",
      ]);
      const columnName = nonemptyString(
        column.name,
        `table ${name}.columns[${columnIndex}].name`,
      );
      if (columnNames.has(columnName)) {
        throw new ManifestError(`table ${name} has duplicate column ${JSON.stringify(columnName)}`);
      }
      columnNames.add(columnName);
      if (typeof column.type !== "string" || !COLUMN_TYPES.has(column.type as ColumnType)) {
        throw new ManifestError(`table ${name}.${columnName} has unsupported type`);
      }
      if (column.nullable !== undefined && typeof column.nullable !== "boolean") {
        throw new ManifestError(`table ${name}.${columnName}.nullable must be boolean`);
      }
      return Object.freeze({
        name: columnName,
        type: column.type as ColumnType,
        nullable: column.nullable === true,
      }) satisfies ColumnManifest;
    });
    if (columns.length === 0) throw new ManifestError(`table ${name} has no columns`);
    return Object.freeze({ name, columns: Object.freeze(columns) }) satisfies TableManifest;
  });

  const tableMap = new Map(tables.map((table) => [table.name, table]));
  const panels = array(root.panels, "manifest.panels").map((value, index) =>
    parsePanel(value, index, tableMap),
  );
  return Object.freeze({
    version: 1,
    tables: Object.freeze(tables),
    panels: Object.freeze(panels),
  });
}

function parsePanel(
  value: unknown,
  index: number,
  tables: ReadonlyMap<string, TableManifest>,
): PanelManifest {
  const path = `manifest.panels[${index}]`;
  const panel = record(value, path);
  exactKeys(panel, ["title", "x_axis", "y_scales", "components"], path, [
    "x_axis",
    "y_scales",
  ]);
  const title = nonemptyString(panel.title, `${path}.title`);
  const xAxis = parseAxis(panel.x_axis, `${path}.x_axis`);
  const yScales = parseScales(panel.y_scales, `${path}.y_scales`, tables);
  const scaleNames = new Set(yScales.map((scale) => scale.name));
  const components = array(panel.components, `${path}.components`).map((component, componentIndex) =>
    parseComponent(
      component,
      `${path}.components[${componentIndex}]`,
      tables,
      scaleNames,
    ),
  );
  return Object.freeze({
    title,
    x_axis: xAxis,
    y_scales: Object.freeze(yScales),
    components: Object.freeze(components),
  });
}

function parseAxis(value: unknown, path: string): AxisManifest {
  if (value === undefined) return Object.freeze({ kind: "time" });
  const axis = record(value, path);
  exactKeys(axis, ["kind"], path);
  if (axis.kind !== "time" && axis.kind !== "linear") {
    throw new ManifestError(`${path}.kind must be "time" or "linear"`);
  }
  return Object.freeze({ kind: axis.kind });
}

function parseScales(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
): ScaleManifest[] {
  if (value === undefined) return [Object.freeze({ name: "default", include_zero: true })];
  const names = new Set<string>();
  const scales = array(value, path).map((entry, index) => {
    const scalePath = `${path}[${index}]`;
    const scale = record(entry, scalePath);
    exactKeys(scale, ["name", "include_zero", "min", "max"], scalePath, [
      "include_zero",
      "min",
      "max",
    ]);
    const name = nonemptyString(scale.name, `${scalePath}.name`);
    if (names.has(name)) throw new ManifestError(`duplicate Y scale ${JSON.stringify(name)}`);
    names.add(name);
    if (scale.include_zero !== undefined && typeof scale.include_zero !== "boolean") {
      throw new ManifestError(`${scalePath}.include_zero must be boolean`);
    }
    const result: {
      name: string;
      include_zero?: boolean;
      min?: DomainValue;
      max?: DomainValue;
    } = { name };
    if (scale.include_zero !== undefined) result.include_zero = scale.include_zero;
    if (scale.min !== undefined) result.min = domainValue(scale.min, `${scalePath}.min`, tables);
    if (scale.max !== undefined) result.max = domainValue(scale.max, `${scalePath}.max`, tables);
    return Object.freeze(result);
  });
  if (scales.length === 0) throw new ManifestError(`${path} must not be empty`);
  return scales;
}

function parseComponent(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
  scales: ReadonlySet<string>,
): ComponentManifest {
  const component = record(value, path);
  const name = nonemptyString(component.name, `${path}.name`);
  if (!KNOWN_COMPONENTS.has(name)) return deepFreeze({ ...component, name });

  switch (name) {
    case "background/v1":
      exactKeys(component, ["name", "color"], path);
      colorValue(component.color, `${path}.color`, tables);
      break;
    case "interval-area/v1":
    case "interval-line/v1":
      exactKeys(component, ["name", "table", "start", "end", "y", "scale", "color"], path, [
        "scale",
        "color",
      ]);
      validateChannels(component, path, tables, ["start", "end", "y"]);
      validateScale(component.scale, path, scales);
      if (component.color !== undefined) {
        colorSpec(component.color, `${path}.color`, tableFor(component, path, tables));
      }
      break;
    case "line/v1":
    case "step-line/v1":
    case "polyline/v1":
      exactKeys(component, ["name", "table", "x", "y", "scale", "color"], path, [
        "scale",
        "color",
      ]);
      validateChannels(component, path, tables, ["x", "y"]);
      validateScale(component.scale, path, scales);
      if (component.color !== undefined) {
        colorSpec(component.color, `${path}.color`, tableFor(component, path, tables));
      }
      break;
    case "horizontal-rule/v1":
      exactKeys(component, ["name", "value", "scale", "color"], path, ["scale", "color"]);
      domainValue(component.value, `${path}.value`, tables);
      validateScale(component.scale, path, scales);
      if (component.color !== undefined) nonemptyString(component.color, `${path}.color`);
      break;
    case "tooltip/v1": {
      exactKeys(component, ["name", "table", "match", "items"], path, ["match"]);
      const table = tableFor(component, path, tables);
      if (component.match !== undefined) {
        const match = record(component.match, `${path}.match`);
        exactKeys(match, ["x", "start", "end", "y"], `${path}.match`, [
          "x",
          "start",
          "end",
          "y",
        ]);
        for (const [channel, column] of Object.entries(match)) {
          columnIn(table, column, `${path}.match.${channel}`, true);
        }
      }
      validateItems(component.items, `${path}.items`, table, false);
      break;
    }
    case "swatch/v1":
      exactKeys(component, ["name", "label", "color", "shape", "value"], path, ["value"]);
      nonemptyString(component.label, `${path}.label`);
      nonemptyString(component.color, `${path}.color`);
      if (!["line", "area", "reference"].includes(String(component.shape))) {
        throw new ManifestError(`${path}.shape must be line, area, or reference`);
      }
      if (component.value !== undefined) {
        const valueRef = record(component.value, `${path}.value`);
        exactKeys(
          valueRef,
          ["table", "column", "select", "reduce", "unit"],
          `${path}.value`,
          ["select", "reduce", "unit"],
        );
        const { unit: _unit, ...scalar } = valueRef;
        scalarRef(scalar, `${path}.value`, tables);
        if (valueRef.unit !== undefined) nonemptyString(valueRef.unit, `${path}.value.unit`);
      }
      break;
    case "readout/v1": {
      exactKeys(component, ["name", "table", "items"], path);
      const table = tableFor(component, path, tables);
      validateItems(component.items, `${path}.items`, table, true);
      break;
    }
  }
  return deepFreeze({ ...component, name });
}

function validateChannels(
  component: Readonly<Record<string, unknown>>,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
  channels: readonly string[],
): void {
  const table = tableFor(component, path, tables);
  for (const channel of channels) {
    columnIn(table, component[channel], `${path}.${channel}`, true);
  }
}

function validateItems(
  value: unknown,
  path: string,
  table: TableManifest,
  readout: boolean,
): void {
  const items = array(value, path);
  if (items.length === 0) throw new ManifestError(`${path} must not be empty`);
  for (const [index, entry] of items.entries()) {
    const itemPath = `${path}[${index}]`;
    const item = record(entry, itemPath);
    exactKeys(
      item,
      readout ? ["label", "column", "unit", "reduce", "sample"] : ["label", "column", "unit"],
      itemPath,
      readout ? ["unit", "reduce", "sample"] : ["unit"],
    );
    nonemptyString(item.label, `${itemPath}.label`);
    const column = columnIn(table, item.column, `${itemPath}.column`, false);
    if (item.unit !== undefined) nonemptyString(item.unit, `${itemPath}.unit`);
    if (!readout) continue;
    if (item.reduce !== undefined && item.sample !== undefined) {
      throw new ManifestError(`${itemPath} cannot specify both reduce and sample`);
    }
    if (item.sample !== undefined && item.sample !== "hit" && item.sample !== "cursor") {
      throw new ManifestError(`${itemPath}.sample must be "hit" or "cursor"`);
    }
    if (item.reduce !== undefined) validateReducer(item.reduce, `${itemPath}.reduce`, table, column);
  }
}

function validateReducer(
  value: unknown,
  path: string,
  table: TableManifest,
  column: ColumnManifest,
): Reducer {
  if (typeof value === "string") {
    if (!["min", "max", "sum", "count", "mean"].includes(value)) {
      throw new ManifestError(`${path} has an unsupported reducer`);
    }
    if (value !== "count" && !NUMERIC_TYPES.has(column.type)) {
      throw new ManifestError(`${path} needs a numeric column`);
    }
    return value as Reducer;
  }
  const reducer = record(value, path);
  exactKeys(reducer, ["name", "start", "end"], path);
  if (reducer.name !== "time_weighted_mean") {
    throw new ManifestError(`${path}.name must be "time_weighted_mean"`);
  }
  if (!NUMERIC_TYPES.has(column.type)) throw new ManifestError(`${path} needs a numeric column`);
  const start = columnIn(table, reducer.start, `${path}.start`, true).name;
  const end = columnIn(table, reducer.end, `${path}.end`, true).name;
  return Object.freeze({ name: "time_weighted_mean", start, end });
}

function colorValue(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
): void {
  if (typeof value === "string") {
    nonemptyString(value, path);
    return;
  }
  const ref = scalarRef(record(value, path), path, tables);
  const table = tables.get(ref.table)!;
  const column = table.columns.find((candidate) => candidate.name === ref.column)!;
  if (column.type !== "utf8") throw new ManifestError(`${path} must reference UTF-8 data`);
}

function colorSpec(value: unknown, path: string, table: TableManifest): ColorSpec {
  if (typeof value === "string") return nonemptyString(value, path);
  const ramp = record(value, path);
  exactKeys(ramp, ["column", "stops"], path);
  columnIn(table, ramp.column, `${path}.column`, true);
  const stops = array(ramp.stops, `${path}.stops`);
  if (stops.length < 2) throw new ManifestError(`${path}.stops needs at least two entries`);
  let previous = -Infinity;
  for (const [index, value] of stops.entries()) {
    const stop = record(value, `${path}.stops[${index}]`);
    exactKeys(stop, ["value", "color"], `${path}.stops[${index}]`);
    const numeric = finiteNumber(stop.value, `${path}.stops[${index}].value`);
    if (numeric < previous) throw new ManifestError(`${path}.stops must be sorted`);
    previous = numeric;
    nonemptyString(stop.color, `${path}.stops[${index}].color`);
  }
  return value as ColorSpec;
}

function domainValue(
  value: unknown,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
): DomainValue {
  if (typeof value === "number") return finiteNumber(value, path);
  const ref = scalarRef(record(value, path), path, tables);
  const table = tables.get(ref.table)!;
  columnIn(table, ref.column, `${path}.column`, true);
  return ref;
}

function scalarRef(
  value: Readonly<Record<string, unknown>>,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
): ScalarRef {
  exactKeys(value, ["table", "column", "select", "reduce"], path, ["select", "reduce"]);
  const tableName = nonemptyString(value.table, `${path}.table`);
  const table = tables.get(tableName);
  if (table === undefined) throw new ManifestError(`${path} references unknown table ${tableName}`);
  const column = columnIn(table, value.column, `${path}.column`, false);
  if (value.select !== undefined && value.select !== "first" && value.select !== "last") {
    throw new ManifestError(`${path}.select must be "first" or "last"`);
  }
  if (
    value.reduce !== undefined &&
    !["min", "max", "sum", "count", "mean"].includes(String(value.reduce))
  ) {
    throw new ManifestError(`${path}.reduce has an unsupported reducer`);
  }
  if (value.select !== undefined && value.reduce !== undefined) {
    throw new ManifestError(`${path} cannot specify both select and reduce`);
  }
  if (value.reduce !== undefined && value.reduce !== "count" && !NUMERIC_TYPES.has(column.type)) {
    throw new ManifestError(`${path}.reduce needs a numeric column`);
  }
  return value as unknown as ScalarRef;
}

function validateScale(value: unknown, path: string, scales: ReadonlySet<string>): void {
  if (value === undefined) return;
  const scale = nonemptyString(value, `${path}.scale`);
  if (!scales.has(scale)) throw new ManifestError(`${path} references unknown Y scale ${scale}`);
}

function tableFor(
  component: Readonly<Record<string, unknown>>,
  path: string,
  tables: ReadonlyMap<string, TableManifest>,
): TableManifest {
  const name = nonemptyString(component.table, `${path}.table`);
  const table = tables.get(name);
  if (table === undefined) throw new ManifestError(`${path} references unknown table ${name}`);
  return table;
}

function columnIn(
  table: TableManifest,
  value: unknown,
  path: string,
  numeric: boolean,
): ColumnManifest {
  const name = nonemptyString(value, path);
  const column = table.columns.find((candidate) => candidate.name === name);
  if (column === undefined) {
    throw new ManifestError(`${path} references unknown column ${table.name}.${name}`);
  }
  if (numeric && !NUMERIC_TYPES.has(column.type)) {
    throw new ManifestError(`${path} must reference a numeric column`);
  }
  return column;
}

function record(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ManifestError(`${path} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new ManifestError(`${path} must be an array`);
  return value;
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`${path} must be a non-empty string`);
  }
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ManifestError(`${path} must be a finite number`);
  }
  return value;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new ManifestError(`${path} has unknown property ${key}`);
  }
  const optionalSet = new Set(optional);
  for (const key of allowed) {
    if (!optionalSet.has(key) && !(key in value)) {
      throw new ManifestError(`${path} is missing ${key}`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
