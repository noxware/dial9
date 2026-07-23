/**
 * Compiler and runtime for the capability-confined Dial9 Sub-JS IR.
 *
 * Trace-controlled programs only select fixed lowering templates. They never
 * provide JavaScript identifiers or source fragments.
 */

export type SExpr = string | readonly SExpr[];
export type ScriptBlock = readonly SExpr[];

const OBJECT = Symbol("dial9.sub-js.object");
const LIST = Symbol("dial9.sub-js.list");
const MAP_VIEW_ADAPTER = Symbol("dial9.sub-js.map-view.adapter");
const MAP_VIEW_GET = Symbol("dial9.sub-js.map-view.get");
const MAP_VIEW_HAS = Symbol("dial9.sub-js.map-view.has");
const LIST_VIEW_ADAPTER = Symbol("dial9.sub-js.list-view.adapter");
const LIST_VIEW_GET = Symbol("dial9.sub-js.list-view.get");
const LIST_VIEW_LENGTH = Symbol("dial9.sub-js.list-view.length");

type ObjectBacking = { [key: string]: ScriptValue };

export interface ScriptObject {
  readonly [OBJECT]: ObjectBacking;
}

export interface ScriptList {
  readonly [LIST]: ScriptValue[];
}

export interface MapViewAdapter {
  has(key: ScriptValue): boolean;
  get(key: ScriptValue): unknown;
}

export interface ListViewAdapter {
  readonly length: number;
  get(index: number): unknown;
}

export interface MapView {
  readonly [MAP_VIEW_ADAPTER]: MapViewAdapter;
  readonly [MAP_VIEW_GET]: (key: ScriptValue) => ScriptValue;
  readonly [MAP_VIEW_HAS]: (key: ScriptValue) => boolean;
}

export interface ListView {
  readonly [LIST_VIEW_ADAPTER]: ListViewAdapter;
  readonly [LIST_VIEW_GET]: (index: number) => ScriptValue;
  readonly [LIST_VIEW_LENGTH]: () => number;
}

export type ScriptPrimitive = undefined | null | boolean | bigint | number | string;
export type ScriptValue = ScriptPrimitive | ScriptObject | ScriptList | MapView | ListView;
export type ExternalFunction = (...args: ScriptValue[]) => unknown;
export type CompiledProgram = () => void;

export interface CompileOptions {
  readonly functions?: Readonly<Record<string, ExternalFunction>>;
}

export interface ScriptValueReader {
  isObject(value: ScriptValue): value is ScriptObject;
  isList(value: ScriptValue): value is ScriptList;
  isMapView(value: ScriptValue): value is MapView;
  isListView(value: ScriptValue): value is ListView;
  objectGet(value: ScriptObject, key: string): ScriptValue;
  objectHas(value: ScriptObject, key: string): boolean;
  objectKeys(value: ScriptObject): string[];
  listGet(value: ScriptList, index: number): ScriptValue;
  listLength(value: ScriptList): number;
  mapViewGet(value: MapView, key: ScriptValue): ScriptValue;
  mapViewHas(value: MapView, key: ScriptValue): boolean;
  listViewGet(value: ListView, index: number): ScriptValue;
  listViewLength(value: ListView): number;
}

export class ScriptCompileError extends Error {
  readonly path: string;

  constructor(message: string, path = "$") {
    super(`${path}: ${message}`);
    this.name = "ScriptCompileError";
    this.path = path;
  }
}

export class ScriptRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptRuntimeError";
  }
}

const hasOwn = Object.hasOwn;
const foreignCache = new WeakMap<object, MapView | ListView>();

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasSlot(value: unknown, slot: symbol): value is object {
  return isObjectLike(value) && hasOwn(value, slot);
}

function isScriptObject(value: unknown): value is ScriptObject {
  return hasSlot(value, OBJECT);
}

function isScriptList(value: unknown): value is ScriptList {
  return hasSlot(value, LIST);
}

function isMapView(value: unknown): value is MapView {
  return hasSlot(value, MAP_VIEW_ADAPTER);
}

function isListView(value: unknown): value is ListView {
  return hasSlot(value, LIST_VIEW_ADAPTER);
}

function mapViewGet(this: MapView, key: ScriptValue): ScriptValue {
  return normalizeForeign(this[MAP_VIEW_ADAPTER].get(key));
}

function mapViewHas(this: MapView, key: ScriptValue): boolean {
  return this[MAP_VIEW_ADAPTER].has(key);
}

function listViewGet(this: ListView, index: number): ScriptValue {
  return normalizeForeign(this[LIST_VIEW_ADAPTER].get(index));
}

function listViewLength(this: ListView): number {
  return this[LIST_VIEW_ADAPTER].length;
}

/** Wrap a trusted host adapter as an opaque, read-only logical map. */
export function createMapView(adapter: MapViewAdapter): MapView {
  if (!isObjectLike(adapter) || typeof adapter.has !== "function" || typeof adapter.get !== "function") {
    throw new TypeError("MapView adapters require has and get functions");
  }
  return {
    __proto__: null,
    [MAP_VIEW_ADAPTER]: adapter,
    [MAP_VIEW_GET]: mapViewGet,
    [MAP_VIEW_HAS]: mapViewHas,
  } as MapView;
}

/** Wrap a trusted host adapter as an opaque, read-only logical list. */
export function createListView(adapter: ListViewAdapter): ListView {
  if (!isObjectLike(adapter) || typeof adapter.get !== "function") {
    throw new TypeError("ListView adapters require a get function");
  }
  return {
    __proto__: null,
    [LIST_VIEW_ADAPTER]: adapter,
    [LIST_VIEW_GET]: listViewGet,
    [LIST_VIEW_LENGTH]: listViewLength,
  } as ListView;
}

function wrapForeignObject(input: object): MapView | ListView {
  const cached = foreignCache.get(input);
  if (cached !== undefined) return cached;

  let view: MapView | ListView;
  if (Array.isArray(input)) {
    view = createListView({
      get length() {
        return input.length;
      },
      get(index) {
        return hasOwn(input, index) ? input[index] : undefined;
      },
    });
  } else if (input instanceof Map) {
    view = createMapView({
      has: (key) => input.has(key),
      get: (key) => input.get(key),
    });
  } else {
    const record = input as Record<string, unknown>;
    view = createMapView({
      has: (key) => typeof key === "string" && hasOwn(record, key),
      get: (key) =>
        typeof key === "string" && hasOwn(record, key) ? record[key] : undefined,
    });
  }
  foreignCache.set(input, view);
  return view;
}

function normalizeForeign(input: unknown): ScriptValue {
  if (
    input === undefined ||
    input === null ||
    typeof input === "boolean" ||
    typeof input === "bigint" ||
    typeof input === "number" ||
    typeof input === "string"
  ) {
    return input;
  }
  if (isScriptObject(input) || isScriptList(input) || isMapView(input) || isListView(input)) {
    return input;
  }
  if (isObjectLike(input)) return wrapForeignObject(input);
  throw new ScriptRuntimeError(`unsupported foreign ${typeof input} value`);
}

export const scriptValueReader: ScriptValueReader = {
  isObject: isScriptObject,
  isList: isScriptList,
  isMapView,
  isListView,
  objectGet: (value, key) => value[OBJECT][key],
  objectHas: (value, key) => hasOwn(value[OBJECT], key),
  objectKeys: (value) => Object.keys(value[OBJECT]),
  listGet: (value, index) => value[LIST][index],
  listLength: (value) => value[LIST].length,
  mapViewGet: (value, key) => value[MAP_VIEW_GET](key),
  mapViewHas: (value, key) => value[MAP_VIEW_HAS](key),
  listViewGet: (value, index) => value[LIST_VIEW_GET](index),
  listViewLength: (value) => value[LIST_VIEW_LENGTH](),
};

interface CompileContext {
  readonly externalIds: ReadonlyMap<string, number>;
  readonly expressionTemporaries: string[];
  nextVariable: number;
  nextTemporary: number;
}

interface LexicalScope {
  readonly parent: LexicalScope | null;
  readonly bindings: Map<string, string>;
}

interface Frame {
  readonly path: string;
  readonly scope: LexicalScope;
  readonly loopDepth: number;
  readonly context: CompileContext;
}

type Compiled =
  | { readonly kind: "value"; readonly source: string }
  | { readonly kind: "statement"; readonly source: string };

interface RuntimeBindings {
  readonly OBJECT: typeof OBJECT;
  readonly LIST: typeof LIST;
  readonly MAP_VIEW_GET: typeof MAP_VIEW_GET;
  readonly MAP_VIEW_HAS: typeof MAP_VIEW_HAS;
  readonly LIST_VIEW_GET: typeof LIST_VIEW_GET;
  readonly LIST_VIEW_LENGTH: typeof LIST_VIEW_LENGTH;
  readonly newObject: () => ScriptObject;
  readonly hasOwn: typeof Object.hasOwn;
  readonly objectKeys: (value: ScriptObject) => ScriptList;
  readonly isObject: (value: unknown) => boolean;
  readonly isList: (value: unknown) => boolean;
  readonly isMapView: (value: unknown) => boolean;
  readonly isListView: (value: unknown) => boolean;
  readonly callExternal: (index: number, args: ScriptValue[]) => ScriptValue;
  readonly Number: NumberConstructor;
  readonly BigInt: BigIntConstructor;
  readonly String: StringConstructor;
  readonly Math: Math;
  readonly numberIsFinite: typeof Number.isFinite;
  readonly numberIsNaN: typeof Number.isNaN;
}

type GeneratedFactory = (runtime: RuntimeBindings) => CompiledProgram;

const BINARY_OPERATORS: Readonly<Record<string, string>> = {
  "op.add": "+",
  "op.subtract": "-",
  "op.multiply": "*",
  "op.divide": "/",
  "op.remainder": "%",
  "op.pow": "**",
  "op.eq": "===",
  "op.neq": "!==",
  "op.lt": "<",
  "op.lte": "<=",
  "op.gt": ">",
  "op.gte": ">=",
  "op.and": "&&",
  "op.or": "||",
};

const UNARY_OPERATORS: Readonly<Record<string, string>> = {
  "op.negate": "-",
  "op.not": "!",
};

const TYPE_PREDICATES: Readonly<Record<string, string>> = {
  "bool.is": "boolean",
  "number.is": "number",
  "bigint.is": "bigint",
  "string.is": "string",
};

const WRAPPER_PREDICATES: Readonly<Record<string, string>> = {
  "obj.is": "isObject",
  "list.is": "isList",
  "map_view.is": "isMapView",
  "list_view.is": "isListView",
};

const CONVERSIONS: Readonly<Record<string, string>> = {
  "number.from": "Number",
  "bigint.from": "BigInt",
  "string.from": "String",
};

const MATH: Readonly<Record<string, readonly [string, number]>> = {
  "math.abs": ["abs", 1],
  "math.floor": ["floor", 1],
  "math.ceil": ["ceil", 1],
  "math.round": ["round", 1],
  "math.trunc": ["trunc", 1],
  "math.min": ["min", 2],
  "math.max": ["max", 2],
};

const NUMBER_PREDICATES: Readonly<Record<string, string>> = {
  "number.is_finite": "numberIsFinite",
  "number.is_nan": "numberIsNaN",
};

const STRING_METHODS: Readonly<Record<string, readonly [string, number]>> = {
  "string.includes": ["includes", 2],
  "string.starts_with": ["startsWith", 2],
  "string.ends_with": ["endsWith", 2],
  "string.slice": ["slice", 3],
};

const SPECIAL_INSTRUCTIONS = [
  "undefined.const",
  "null.const",
  "bool.true",
  "bool.false",
  "number.const",
  "bigint.const",
  "string.const",
  "obj.new",
  "list.new",
  "undefined.is",
  "null.is",
  "string.length",
  "var.let",
  "var.get",
  "var.set",
  "case",
  "loop.for_each",
  "loop.break",
  "loop.continue",
  "obj.get",
  "obj.set",
  "obj.has",
  "obj.delete",
  "obj.keys",
  "list.get",
  "list.set",
  "list.push",
  "list.pop",
  "list.length",
  "map_view.get",
  "map_view.has",
  "list_view.get",
  "list_view.length",
] as const;

const BUILT_INS = new Set([
  ...SPECIAL_INSTRUCTIONS,
  ...Object.keys(BINARY_OPERATORS),
  ...Object.keys(UNARY_OPERATORS),
  ...Object.keys(TYPE_PREDICATES),
  ...Object.keys(WRAPPER_PREDICATES),
  ...Object.keys(CONVERSIONS),
  ...Object.keys(MATH),
  ...Object.keys(NUMBER_PREDICATES),
  ...Object.keys(STRING_METHODS),
]);

/** Compile a validated IR block into a reusable, capability-confined JavaScript function. */
export function compile(program: ScriptBlock, options: CompileOptions = {}): CompiledProgram {
  if (!Array.isArray(program)) throw new ScriptCompileError("program must be a block");

  const externalFunctions: ExternalFunction[] = [];
  const externalIds = new Map<string, number>();
  for (const [name, fn] of Object.entries(options.functions ?? {})) {
    if (name.length === 0) throw new ScriptCompileError("external invoke name cannot be empty");
    if (BUILT_INS.has(name)) {
      throw new ScriptCompileError(`external invoke ${quote(name)} uses a reserved name`);
    }
    if (typeof fn !== "function") {
      throw new ScriptCompileError(`external invoke ${quote(name)} is not a function`);
    }
    externalIds.set(name, externalFunctions.length);
    externalFunctions.push(fn);
  }

  const context: CompileContext = {
    externalIds,
    expressionTemporaries: [],
    nextVariable: 0,
    nextTemporary: 0,
  };
  const rootScope = createScope(null);
  const frame: Frame = { path: "$", scope: rootScope, loopDepth: 0, context };
  predeclareBlock(program, frame);
  const body = `${declareScope(rootScope)}${compileBlock(program, frame)}`;
  const temporaries =
    context.expressionTemporaries.length === 0
      ? ""
      : `let ${context.expressionTemporaries.join(",")};\n`;
  const source =
    `"use strict";\nreturn function compiledSubJsProgram(){\n` +
    indent(`"use strict";\n${temporaries}${body}`) +
    `\n};`;

  try {
    return (new Function("$", source) as GeneratedFactory)(createRuntime(externalFunctions));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScriptCompileError(`failed to generate JavaScript: ${message}`);
  }
}

function createRuntime(externals: readonly ExternalFunction[]): RuntimeBindings {
  return {
    OBJECT,
    LIST,
    MAP_VIEW_GET,
    MAP_VIEW_HAS,
    LIST_VIEW_GET,
    LIST_VIEW_LENGTH,
    newObject() {
      const object = Object.create(null) as ScriptObject;
      (object as { [OBJECT]: ScriptObject })[OBJECT] = object;
      return object;
    },
    hasOwn,
    objectKeys: (object) =>
      ({ __proto__: null, [LIST]: Object.keys(object[OBJECT]) }) as ScriptList,
    isObject: isScriptObject,
    isList: isScriptList,
    isMapView,
    isListView,
    callExternal(index, args) {
      const external = externals[index];
      if (external === undefined) throw new ScriptRuntimeError(`missing external ${index}`);
      return normalizeForeign(external(...args));
    },
    Number,
    BigInt,
    String,
    Math,
    numberIsFinite: Number.isFinite,
    numberIsNaN: Number.isNaN,
  };
}

function compileBlock(block: readonly SExpr[], frame: Frame): string {
  return block
    .map((node, index) => {
      const compiled = compileInvoke(node, at(frame, `[${index}]`));
      return compiled.kind === "value" ? `${compiled.source};` : compiled.source;
    })
    .join("\n");
}

function compileValue(node: SExpr, frame: Frame): string {
  const compiled = compileInvoke(node, frame);
  if (compiled.kind === "statement") {
    throw new ScriptCompileError("this instruction does not produce a value", frame.path);
  }
  return compiled.source;
}

function compileInvoke(node: SExpr, frame: Frame): Compiled {
  const { operation, operands } = splitInvoke(node, frame.path);

  const binary = tableEntry(BINARY_OPERATORS, operation);
  if (binary !== undefined) {
    const [left, right] = args(operation, operands, 2, frame);
    return expression(`((${left!})${binary}(${right!}))`);
  }
  const unary = tableEntry(UNARY_OPERATORS, operation);
  if (unary !== undefined) {
    const [input] = args(operation, operands, 1, frame);
    return expression(`(${unary}(${input!}))`);
  }
  const expectedType = tableEntry(TYPE_PREDICATES, operation);
  if (expectedType !== undefined) {
    const [input] = args(operation, operands, 1, frame);
    return expression(`(typeof ${input!}===${stringLiteral(expectedType)})`);
  }
  const wrapperPredicate = tableEntry(WRAPPER_PREDICATES, operation);
  if (wrapperPredicate !== undefined) {
    const [input] = args(operation, operands, 1, frame);
    return expression(`$.${wrapperPredicate}(${input!})`);
  }
  const conversion = tableEntry(CONVERSIONS, operation);
  if (conversion !== undefined) {
    const [input] = args(operation, operands, 1, frame);
    return expression(`$.${conversion}(${input!})`);
  }
  const math = tableEntry(MATH, operation);
  if (math !== undefined) {
    const [method, arity] = math;
    return expression(`$.Math.${method}(${args(operation, operands, arity, frame).join(",")})`);
  }
  const numberPredicate = tableEntry(NUMBER_PREDICATES, operation);
  if (numberPredicate !== undefined) {
    const [input] = args(operation, operands, 1, frame);
    return expression(`$.${numberPredicate}(${input!})`);
  }
  const stringMethod = tableEntry(STRING_METHODS, operation);
  if (stringMethod !== undefined) {
    const [method, arity] = stringMethod;
    const [receiver, ...parameters] = args(operation, operands, arity, frame);
    return expression(`(${receiver!}).${method}(${parameters.join(",")})`);
  }

  switch (operation) {
    case "undefined.const":
      exactArity(operation, operands, 0, frame.path);
      return expression("void 0");
    case "null.const":
      exactArity(operation, operands, 0, frame.path);
      return expression("null");
    case "bool.true":
      exactArity(operation, operands, 0, frame.path);
      return expression("true");
    case "bool.false":
      exactArity(operation, operands, 0, frame.path);
      return expression("false");
    case "number.const": {
      exactArity(operation, operands, 1, frame.path);
      return expression(
        parseNumberLiteral(atom(operands[0], at(frame, "[1]").path, "number literal"), at(frame, "[1]").path),
      );
    }
    case "bigint.const": {
      exactArity(operation, operands, 1, frame.path);
      return expression(
        parseBigIntLiteral(atom(operands[0], at(frame, "[1]").path, "bigint literal"), at(frame, "[1]").path),
      );
    }
    case "string.const":
      exactArity(operation, operands, 1, frame.path);
      return expression(
        stringLiteral(atom(operands[0], at(frame, "[1]").path, "string literal")),
      );
    case "obj.new":
      return compileObject(operands, frame);
    case "list.new":
      return expression(
        `({__proto__:null,[$.LIST]:[${values(operands, frame).join(",")}]})`,
      );
    case "undefined.is": {
      const [input] = args(operation, operands, 1, frame);
      return expression(`(typeof ${input!}==="undefined")`);
    }
    case "null.is": {
      const [input] = args(operation, operands, 1, frame);
      return expression(`(${input!}===null)`);
    }
    case "string.length": {
      const [input] = args(operation, operands, 1, frame);
      return expression(`((${input!}).length)`);
    }
    case "var.let": {
      exactArity(operation, operands, 2, frame.path);
      const name = atom(operands[0], at(frame, "[1]").path, "variable name");
      const binding = resolveOwnBinding(frame.scope, name, at(frame, "[1]").path);
      return statement(
        `${binding}=${compileValue(
          operands[1]!,
          at(frame, "[2]"),
        )};`,
      );
    }
    case "var.get": {
      exactArity(operation, operands, 1, frame.path);
      const name = atom(operands[0], at(frame, "[1]").path, "variable name");
      return expression(resolveBinding(frame.scope, name, at(frame, "[1]").path));
    }
    case "var.set": {
      exactArity(operation, operands, 2, frame.path);
      const name = atom(operands[0], at(frame, "[1]").path, "variable name");
      const binding = resolveBinding(frame.scope, name, at(frame, "[1]").path);
      return expression(
        `(${binding}=${compileValue(
          operands[1]!,
          at(frame, "[2]"),
        )})`,
      );
    }
    case "case":
      return compileCase(operands, frame);
    case "loop.for_each":
      return compileForEach(operands, frame);
    case "loop.break":
      exactArity(operation, operands, 0, frame.path);
      if (frame.loopDepth === 0) {
        throw new ScriptCompileError("loop.break is only valid in a loop", frame.path);
      }
      return statement("break;");
    case "loop.continue":
      exactArity(operation, operands, 0, frame.path);
      if (frame.loopDepth === 0) {
        throw new ScriptCompileError("loop.continue is only valid in a loop", frame.path);
      }
      return statement("continue;");
    case "obj.get": {
      const [object, key] = args(operation, operands, 2, frame);
      return expression(`(${object!})[$.OBJECT][${key!}]`);
    }
    case "obj.set": {
      const [object, key, newValue] = args(operation, operands, 3, frame);
      return expression(`((${object!})[$.OBJECT][${key!}]=${newValue!})`);
    }
    case "obj.has": {
      const [object, key] = args(operation, operands, 2, frame);
      return expression(`$.hasOwn((${object!})[$.OBJECT],${key!})`);
    }
    case "obj.delete": {
      const [object, key] = args(operation, operands, 2, frame);
      return expression(`(delete (${object!})[$.OBJECT][${key!}])`);
    }
    case "obj.keys": {
      const [object] = args(operation, operands, 1, frame);
      return expression(`$.objectKeys(${object!})`);
    }
    case "list.get": {
      const [list, index] = args(operation, operands, 2, frame);
      return expression(`(${list!})[$.LIST][+(${index!})]`);
    }
    case "list.set": {
      const [list, index, newValue] = args(operation, operands, 3, frame);
      return expression(`((${list!})[$.LIST][+(${index!})]=${newValue!})`);
    }
    case "list.push": {
      const [list, newValue] = args(operation, operands, 2, frame);
      return expression(`(${list!})[$.LIST].push(${newValue!})`);
    }
    case "list.pop": {
      const [list] = args(operation, operands, 1, frame);
      return expression(`(${list!})[$.LIST].pop()`);
    }
    case "list.length": {
      const [list] = args(operation, operands, 1, frame);
      return expression(`(${list!})[$.LIST].length`);
    }
    case "map_view.get": {
      const [view, key] = args(operation, operands, 2, frame);
      return expression(`(${view!})[$.MAP_VIEW_GET](${key!})`);
    }
    case "map_view.has": {
      const [view, key] = args(operation, operands, 2, frame);
      return expression(`(${view!})[$.MAP_VIEW_HAS](${key!})`);
    }
    case "list_view.get": {
      const [view, index] = args(operation, operands, 2, frame);
      return expression(`(${view!})[$.LIST_VIEW_GET](+(${index!}))`);
    }
    case "list_view.length": {
      const [view] = args(operation, operands, 1, frame);
      return expression(`(${view!})[$.LIST_VIEW_LENGTH]()`);
    }
  }

  const externalId = frame.context.externalIds.get(operation);
  if (externalId !== undefined) {
    return expression(`$.callExternal(${externalId},[${values(operands, frame).join(",")}])`);
  }
  throw new ScriptCompileError(`unknown instruction ${quote(operation)}`, frame.path);
}

function compileObject(operands: readonly SExpr[], frame: Frame): Compiled {
  if (operands.length % 2 !== 0) {
    throw new ScriptCompileError("obj.new expects key/value operand pairs", frame.path);
  }
  const object = nextTemporary(frame.context, "object");
  frame.context.expressionTemporaries.push(object);
  const assignments: string[] = [`${object}=$.newObject()`];
  for (let index = 0; index < operands.length; index += 2) {
    assignments.push(
      `${object}[${compileValue(operands[index]!, at(frame, `[${index + 1}]`))}]=` +
        compileValue(operands[index + 1]!, at(frame, `[${index + 2}]`)),
    );
  }
  assignments.push(object);
  return expression(`(${assignments.join(",")})`);
}

function compileCase(operands: readonly SExpr[], frame: Frame): Compiled {
  if (operands.length === 0 || operands.length % 2 !== 0) {
    throw new ScriptCompileError("case expects condition/body pairs", frame.path);
  }
  const branches: string[] = [];
  for (let index = 0; index < operands.length; index += 2) {
    const condition = compileValue(operands[index]!, at(frame, `[${index + 1}]`));
    const scope = createScope(frame.scope);
    const bodyNode = operands[index + 1]!;
    if (!Array.isArray(bodyNode)) {
      throw new ScriptCompileError("body must be a block", at(frame, `[${index + 2}]`).path);
    }
    const bodyFrame = {
      ...frame,
      path: at(frame, `[${index + 2}]`).path,
      scope,
    };
    predeclareBlock(bodyNode, bodyFrame);
    const body = compileBlock(bodyNode, bodyFrame);
    branches.push(
      `${index === 0 ? "if" : "else if"}(${condition}){\n` +
        indent(`${declareScope(scope)}${body}`) +
        `\n}`,
    );
  }
  return statement(branches.join(" "));
}

function compileForEach(operands: readonly SExpr[], frame: Frame): Compiled {
  exactArity("loop.for_each", operands, 4, frame.path);
  const itemName = atom(operands[0], at(frame, "[1]").path, "item variable name");
  const indexName = atom(operands[1], at(frame, "[2]").path, "index variable name");
  if (itemName === indexName) {
    throw new ScriptCompileError("loop item and index names must differ", frame.path);
  }

  const source = compileValue(operands[2]!, at(frame, "[3]"));
  const bodyNode = operands[3]!;
  if (!Array.isArray(bodyNode)) {
    throw new ScriptCompileError("body must be a block", at(frame, "[4]").path);
  }
  const iterationScope = createScope(frame.scope);
  const itemBinding = declareBinding(frame.context, iterationScope, itemName);
  const indexBinding = declareBinding(frame.context, iterationScope, indexName);
  const bodyFrame = {
    ...frame,
    path: at(frame, "[4]").path,
    scope: iterationScope,
    loopDepth: frame.loopDepth + 1,
  };
  predeclareBlock(bodyNode, bodyFrame);
  const body = compileBlock(bodyNode, bodyFrame);
  const sourceName = nextTemporary(frame.context, "source");
  const backingName = nextTemporary(frame.context, "backing");
  const lengthName = nextTemporary(frame.context, "length");
  const generatedIndex = nextTemporary(frame.context, "index");

  const loop = (item: string): string =>
    `for(let ${generatedIndex}=0;${generatedIndex}<${lengthName};${generatedIndex}++){\n` +
    indent(
      declareScope(
        iterationScope,
        new Map([
          [itemBinding, item],
          [indexBinding, generatedIndex],
        ]),
      ) +
        body,
    ) +
    `\n}`;

  return statement(
    `{\n` +
      indent(
        `const ${sourceName}=${source};\n` +
          `const ${backingName}=${sourceName}[$.LIST];\n` +
          `if(${backingName}!==void 0){\n` +
          indent(
            `const ${lengthName}=${backingName}.length;\n` +
              loop(`${backingName}[${generatedIndex}]`),
          ) +
          `\n}else{\n` +
          indent(
            `const ${lengthName}=${sourceName}[$.LIST_VIEW_LENGTH]();\n` +
              loop(`${sourceName}[$.LIST_VIEW_GET](${generatedIndex})`),
          ) +
          `\n}`,
      ) +
      `\n}`,
  );
}

function args(
  operation: string,
  operands: readonly SExpr[],
  arity: number,
  frame: Frame,
): string[] {
  exactArity(operation, operands, arity, frame.path);
  return values(operands, frame);
}

function values(operands: readonly SExpr[], frame: Frame): string[] {
  return operands.map((operand, index) =>
    compileValue(operand, at(frame, `[${index + 1}]`)),
  );
}

function splitInvoke(node: SExpr, path: string): {
  readonly operation: string;
  readonly operands: readonly SExpr[];
} {
  if (typeof node === "string") {
    if (node.length === 0) throw new ScriptCompileError("instruction name cannot be empty", path);
    return { operation: node, operands: [] };
  }
  if (!Array.isArray(node) || node.length === 0) {
    throw new ScriptCompileError("instruction cannot be empty", path);
  }
  if (node.length === 1) {
    throw new ScriptCompileError("zero-argument instructions must use their atom form", path);
  }
  const operation = node[0];
  if (typeof operation !== "string" || operation.length === 0) {
    throw new ScriptCompileError("instruction must start with a non-empty operation atom", path);
  }
  return { operation, operands: node.slice(1) };
}

function exactArity(
  operation: string,
  operands: readonly SExpr[],
  expected: number,
  path: string,
): void {
  if (operands.length !== expected) {
    throw new ScriptCompileError(
      `${operation} expects ${expected} operand${expected === 1 ? "" : "s"}, got ${operands.length}`,
      path,
    );
  }
}

function atom(node: SExpr | undefined, path: string, description: string): string {
  if (typeof node !== "string") {
    throw new ScriptCompileError(`${description} must be an atom`, path);
  }
  return node;
}

const NUMBER_LITERAL =
  /^-?(?:(?:0|[1-9][0-9]*)(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const BIGINT_LITERAL = /^-?(?:0|[1-9][0-9]*)$/;

function parseNumberLiteral(payload: string, path: string): string {
  if (!NUMBER_LITERAL.test(payload)) {
    throw new ScriptCompileError(`${quote(payload)} is not a number literal`, path);
  }
  const parsed = Number(payload);
  if (!Number.isFinite(parsed)) {
    throw new ScriptCompileError(`${quote(payload)} is not a finite number literal`, path);
  }
  return Object.is(parsed, -0) ? "-0" : String(parsed);
}

function parseBigIntLiteral(payload: string, path: string): string {
  if (!BIGINT_LITERAL.test(payload)) {
    throw new ScriptCompileError(`${quote(payload)} is not a bigint literal`, path);
  }
  return `${BigInt(payload).toString()}n`;
}

function expression(source: string): Compiled {
  return { kind: "value", source };
}

function statement(source: string): Compiled {
  return { kind: "statement", source };
}

function tableEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasOwn(table, key) ? table[key] : undefined;
}

function at(frame: Frame, path: string): Frame {
  return { ...frame, path: `${frame.path}${path}` };
}

function createScope(parent: LexicalScope | null): LexicalScope {
  return { parent, bindings: new Map() };
}

function predeclareBlock(block: readonly SExpr[], frame: Frame): void {
  for (let index = 0; index < block.length; index++) {
    const invokeFrame = at(frame, `[${index}]`);
    const { operation, operands } = splitInvoke(block[index]!, invokeFrame.path);
    if (operation !== "var.let") continue;
    exactArity(operation, operands, 2, invokeFrame.path);
    const name = atom(operands[0], at(invokeFrame, "[1]").path, "variable name");
    declareBinding(frame.context, frame.scope, name);
  }
}

function declareBinding(
  context: CompileContext,
  scope: LexicalScope,
  name: string,
): string {
  const existing = scope.bindings.get(name);
  if (existing !== undefined) return existing;
  const binding = `$v${context.nextVariable++}`;
  scope.bindings.set(name, binding);
  return binding;
}

function resolveOwnBinding(scope: LexicalScope, name: string, path: string): string {
  const binding = scope.bindings.get(name);
  if (binding === undefined) {
    throw new ScriptCompileError(`variable ${quote(name)} is not declared in this scope`, path);
  }
  return binding;
}

function resolveBinding(scope: LexicalScope, name: string, path: string): string {
  for (let current: LexicalScope | null = scope; current !== null; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  throw new ScriptCompileError(`variable ${quote(name)} is not declared`, path);
}

function declareScope(
  scope: LexicalScope,
  initializers: ReadonlyMap<string, string> = new Map(),
): string {
  return [...scope.bindings.values()]
    .map((binding) => {
      const initializer = initializers.get(binding);
      return initializer === undefined ? `let ${binding};\n` : `let ${binding}=${initializer};\n`;
    })
    .join("");
}

function nextTemporary(context: CompileContext, hint: string): string {
  return `$${hint}${context.nextTemporary++}`;
}

function stringLiteral(input: string): string {
  return JSON.stringify(input).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function quote(input: string): string {
  return JSON.stringify(input);
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
