/**
 * Dial9 Script IR compiler and runtime.
 *
 * This module deliberately has no Dial9 or browser dependencies. It validates
 * an S-expression once, lowers it to JavaScript, and returns a reusable
 * function whose hot path does not walk the IR or resolve invoke names.
 */

export type SExpr = string | readonly SExpr[];

export type ScriptPrimitive = null | boolean | bigint | number | string;
export type ScriptValue =
  | ScriptPrimitive
  | ScriptValue[]
  | Map<ScriptValue, ScriptValue>
  | ListView
  | MapView;

export interface ListView {
  readonly length: number;
  get(index: number): unknown;
}

export interface MapView {
  has(key: ScriptValue): boolean;
  get(key: ScriptValue): unknown;
}

export interface ScriptDiagnostic {
  readonly level: "warning";
  readonly message: string;
}

export type ExternalFunction = (...args: ScriptValue[]) => unknown;

export interface CompileOptions {
  readonly functions?: Readonly<Record<string, ExternalFunction>>;
  readonly onDiagnostic?: (diagnostic: ScriptDiagnostic) => void;
}

export type CompiledProgram = () => ScriptValue | undefined;

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

const listViews = new WeakSet<object>();
const mapViews = new WeakSet<object>();

/** Mark a host adapter as a read-only logical list exposed to scripts. */
export function createListView(view: ListView): ListView {
  if (typeof view !== "object" || view === null) {
    throw new TypeError("createListView expects an object");
  }
  if (typeof view.get !== "function") {
    throw new TypeError("ListView.get must be a function");
  }
  if (mapViews.has(view)) {
    throw new TypeError("a view cannot be both a ListView and a MapView");
  }
  listViews.add(view);
  return view;
}

/** Mark a host adapter as a read-only logical map exposed to scripts. */
export function createMapView(view: MapView): MapView {
  if (typeof view !== "object" || view === null) {
    throw new TypeError("createMapView expects an object");
  }
  if (typeof view.has !== "function" || typeof view.get !== "function") {
    throw new TypeError("MapView.has and MapView.get must be functions");
  }
  if (listViews.has(view)) {
    throw new TypeError("a view cannot be both a ListView and a MapView");
  }
  mapViews.add(view);
  return view;
}

function isListView(value: unknown): value is ListView {
  return typeof value === "object" && value !== null && listViews.has(value);
}

function isMapView(value: unknown): value is MapView {
  return typeof value === "object" && value !== null && mapViews.has(value);
}

type GeneratedProgram = (runtime: Runtime) => CompiledProgram;

interface Scope {
  readonly parent: Scope | null;
  readonly bindings: Map<string, string>;
}

interface CompileContext {
  readonly externalIds: ReadonlyMap<string, number>;
  readonly expressionTemporaries: string[];
  nextVariable: number;
  nextTemporary: number;
}

interface CompiledValue {
  readonly kind: "value";
  readonly expression: string;
}

interface CompiledNone {
  readonly kind: "none";
  readonly statement: string;
}

type CompiledInvoke = CompiledValue | CompiledNone;

const value = (expression: string): CompiledValue => ({ kind: "value", expression });
const none = (statement: string): CompiledNone => ({ kind: "none", statement });

const EAGER_RUNTIME_OPERATIONS: Readonly<
  Record<string, readonly [keyof Runtime & string, number]>
> = {
  "integer.from": ["integerFrom", 1],
  "float.from": ["floatFrom", 1],
  "string.from": ["stringFrom", 1],
  "string.concat": ["stringConcat", 2],
  "null.is": ["nullIs", 1],
  "bool.is": ["boolIs", 1],
  "integer.is": ["integerIs", 1],
  "float.is": ["floatIs", 1],
  "string.is": ["stringIs", 1],
  "list.is": ["listIs", 1],
  "map.is": ["mapIs", 1],
  "integer.add": ["integerAdd", 2],
  "integer.subtract": ["integerSubtract", 2],
  "integer.multiply": ["integerMultiply", 2],
  "integer.divide": ["integerDivide", 2],
  "integer.pow": ["integerPow", 2],
  "float.add": ["floatAdd", 2],
  "float.subtract": ["floatSubtract", 2],
  "float.multiply": ["floatMultiply", 2],
  "float.divide": ["floatDivide", 2],
  "float.pow": ["floatPow", 2],
  "cmp.eq": ["compareEqual", 2],
  "cmp.lt": ["compareLess", 2],
  "cmp.lte": ["compareLessEqual", 2],
  "cmp.gt": ["compareGreater", 2],
  "cmp.gte": ["compareGreaterEqual", 2],
  "bool.not": ["boolNot", 1],
  "map.get": ["mapGet", 2],
  "map.has": ["mapHas", 2],
  "map.remove": ["mapRemove", 2],
  "list.get": ["listGet", 2],
  "list.length": ["listLength", 1],
  "diagnostic.warn": ["diagnosticWarn", 1],
  "diagnostic.type_name": ["diagnosticTypeName", 1],
};

const BUILT_INS = new Set([
  ...Object.keys(EAGER_RUNTIME_OPERATIONS),
  "null.const",
  "bool.true",
  "bool.false",
  "integer.zero",
  "integer.const",
  "float.zero",
  "float.const",
  "string.const",
  "var.let",
  "var.get",
  "var.set",
  "case",
  "for_each",
  "loop.break",
  "loop.continue",
  "bool.and",
  "bool.or",
  "map.new",
  "map.set",
  "list.new",
  "list.set",
  "list.push",
]);

/** Validate and compile a Script IR program into a reusable native JS function. */
export function compile(sexpr: SExpr, options: CompileOptions = {}): CompiledProgram {
  const externalEntries = Object.entries(options.functions ?? {});
  const externalIds = new Map<string, number>();
  const externalFunctions: ExternalFunction[] = [];

  for (const [name, fn] of externalEntries) {
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
  const root: Scope = { parent: null, bindings: new Map() };
  const body = compileRoot(sexpr, "$", root, 0, context);
  const temporaryDeclarations =
    context.expressionTemporaries.length === 0
      ? ""
      : `let ${context.expressionTemporaries.join(",")};\n`;
  const source =
    `"use strict";\nreturn function compiledScriptProgram() {\n` +
    `${indent(temporaryDeclarations + body)}\n};`;
  const runtime = new Runtime(externalFunctions, options.onDiagnostic);

  try {
    return (new Function("runtime", source) as GeneratedProgram)(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ScriptCompileError(`failed to generate JavaScript: ${message}`);
  }
}

function compileRoot(
  node: SExpr,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string {
  if (isBlock(node)) return compileBlock(node, path, scope, loopDepth, context);
  const compiled = compileInvoke(node, path, scope, loopDepth, context);
  return compiled.kind === "value"
    ? `return ${compiled.expression};`
    : `${compiled.statement}\nreturn undefined;`;
}

function compileBlock(
  node: readonly SExpr[],
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string {
  if (node.length === 0) throw new ScriptCompileError("block cannot be empty", path);
  return node
    .map((child, index) => {
      const compiled = compileInvoke(child, `${path}[${index}]`, scope, loopDepth, context);
      return compiled.kind === "value" ? `${compiled.expression};` : compiled.statement;
    })
    .join("\n");
}

function compileBody(
  node: SExpr,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string {
  return isBlock(node)
    ? compileBlock(node, path, scope, loopDepth, context)
    : compileStatement(node, path, scope, loopDepth, context);
}

function compileStatement(
  node: SExpr,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string {
  const compiled = compileInvoke(node, path, scope, loopDepth, context);
  return compiled.kind === "value" ? `${compiled.expression};` : compiled.statement;
}

function compileValue(
  node: SExpr,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string {
  if (isBlock(node)) throw new ScriptCompileError("a block cannot be used as a value", path);
  const compiled = compileInvoke(node, path, scope, loopDepth, context);
  if (compiled.kind === "none") {
    throw new ScriptCompileError("this invoke does not produce a value", path);
  }
  return compiled.expression;
}

function compileInvoke(
  node: SExpr,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): CompiledInvoke {
  const { operation, operands } = splitInvoke(node, path);

  switch (operation) {
    case "null.const":
      exactArity(operation, operands, 0, path);
      return value("null");
    case "bool.true":
      exactArity(operation, operands, 0, path);
      return value("true");
    case "bool.false":
      exactArity(operation, operands, 0, path);
      return value("false");
    case "integer.zero":
      exactArity(operation, operands, 0, path);
      return value("0n");
    case "float.zero":
      exactArity(operation, operands, 0, path);
      return value("0");
    case "integer.const": {
      exactArity(operation, operands, 1, path);
      const payload = atom(operands[0], `${path}[1]`, "integer literal");
      try {
        return value(`${BigInt(payload).toString()}n`);
      } catch {
        throw new ScriptCompileError(`${quote(payload)} is not an integer literal`, `${path}[1]`);
      }
    }
    case "float.const": {
      exactArity(operation, operands, 1, path);
      const payload = atom(operands[0], `${path}[1]`, "float literal");
      const parsed = parseFloatLiteral(payload);
      if (parsed === null) {
        throw new ScriptCompileError(`${quote(payload)} is not a finite float literal`, `${path}[1]`);
      }
      return value(Object.is(parsed, -0) ? "-0" : String(parsed));
    }
    case "string.const":
      exactArity(operation, operands, 1, path);
      return value(JSON.stringify(atom(operands[0], `${path}[1]`, "string literal")));
    case "var.get": {
      exactArity(operation, operands, 1, path);
      const name = atom(operands[0], `${path}[1]`, "variable name");
      return value(resolveBinding(scope, name, `${path}[1]`));
    }
    case "var.let": {
      exactArity(operation, operands, 2, path);
      const name = atom(operands[0], `${path}[1]`, "variable name");
      if (scope.bindings.has(name)) {
        throw new ScriptCompileError(
          `variable ${quote(name)} is already declared in this scope`,
          `${path}[1]`,
        );
      }
      const initializer = compileValue(operands[1]!, `${path}[2]`, scope, loopDepth, context);
      const generated = nextVariable(context);
      scope.bindings.set(name, generated);
      return none(`let ${generated} = ${initializer};`);
    }
    case "var.set": {
      exactArity(operation, operands, 2, path);
      const name = atom(operands[0], `${path}[1]`, "variable name");
      const binding = resolveBinding(scope, name, `${path}[1]`);
      const expression = compileValue(operands[1]!, `${path}[2]`, scope, loopDepth, context);
      return none(`${binding} = ${expression};`);
    }
    case "case":
      return compileCase(operands, path, scope, loopDepth, context);
    case "for_each":
      return compileForEach(operands, path, scope, loopDepth, context);
    case "loop.break":
      exactArity(operation, operands, 0, path);
      if (loopDepth === 0) throw new ScriptCompileError("loop.break is only valid in a loop", path);
      return none("break;");
    case "loop.continue":
      exactArity(operation, operands, 0, path);
      if (loopDepth === 0) throw new ScriptCompileError("loop.continue is only valid in a loop", path);
      return none("continue;");
    case "bool.and":
      return compileLazyBoolean("and", operation, operands, path, scope, loopDepth, context);
    case "bool.or":
      return compileLazyBoolean("or", operation, operands, path, scope, loopDepth, context);
    case "map.new": {
      if (operands.length % 2 !== 0) {
        throw new ScriptCompileError("map.new expects key/value operand pairs", path);
      }
      const args = compileValues(operands, path, scope, loopDepth, context);
      return value(`runtime.mapNew([${args.join(",")}])`);
    }
    case "list.new": {
      const args = compileValues(operands, path, scope, loopDepth, context);
      return value(`runtime.listNew([${args.join(",")}])`);
    }
    case "map.set":
      return compileMutation("mapSet", operation, operands, 3, path, scope, loopDepth, context);
    case "list.set":
      return compileMutation("listSet", operation, operands, 3, path, scope, loopDepth, context);
    case "list.push":
      return compileMutation("listPush", operation, operands, 2, path, scope, loopDepth, context);
  }

  const eager = EAGER_RUNTIME_OPERATIONS[operation];
  if (eager !== undefined) {
    const [method, arity] = eager;
    exactArity(operation, operands, arity, path);
    const args = compileValues(operands, path, scope, loopDepth, context);
    return value(`runtime.${method}(${args.join(",")})`);
  }

  const externalId = context.externalIds.get(operation);
  if (externalId !== undefined) {
    const args = compileValues(operands, path, scope, loopDepth, context);
    return value(`runtime.callExternal(${externalId},[${args.join(",")}])`);
  }

  throw new ScriptCompileError(`unknown invoke ${quote(operation)}`, path);
}

function compileCase(
  operands: readonly SExpr[],
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): CompiledNone {
  if (operands.length === 0 || operands.length % 2 !== 0) {
    throw new ScriptCompileError("case expects one or more condition/body pairs", path);
  }
  const branches: string[] = [];
  for (let index = 0; index < operands.length; index += 2) {
    const condition = compileValue(
      operands[index]!,
      `${path}[${index + 1}]`,
      scope,
      loopDepth,
      context,
    );
    const branchScope: Scope = { parent: scope, bindings: new Map() };
    const body = compileBody(
      operands[index + 1]!,
      `${path}[${index + 2}]`,
      branchScope,
      loopDepth,
      context,
    );
    branches.push(
      `${index === 0 ? "if" : "else if"} (runtime.caseCondition(${condition})) {\n${indent(body)}\n}`,
    );
  }
  return none(branches.join(" "));
}

function compileForEach(
  operands: readonly SExpr[],
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): CompiledNone {
  exactArity("for_each", operands, 4, path);
  const itemName = atom(operands[0], `${path}[1]`, "item binding name");
  const indexName = atom(operands[1], `${path}[2]`, "index binding name");
  if (itemName === indexName) {
    throw new ScriptCompileError("for_each item and index bindings must have different names", path);
  }
  const source = compileValue(operands[2]!, `${path}[3]`, scope, loopDepth, context);
  const sourceTemporary = nextTemporary(context, "list");
  const lengthTemporary = nextTemporary(context, "length");
  const indexTemporary = nextTemporary(context, "index");
  const itemVariable = nextVariable(context);
  const indexVariable = nextVariable(context);
  const iterationScope: Scope = { parent: scope, bindings: new Map() };
  iterationScope.bindings.set(itemName, itemVariable);
  iterationScope.bindings.set(indexName, indexVariable);
  const body = compileBody(
    operands[3]!,
    `${path}[4]`,
    iterationScope,
    loopDepth + 1,
    context,
  );
  return none(
    `const ${sourceTemporary} = ${source};\n` +
      `const ${lengthTemporary} = runtime.iterableLength(${sourceTemporary});\n` +
      `if (${lengthTemporary} !== null) {\n` +
      indent(
        `for (let ${indexTemporary} = 0; ${indexTemporary} < ${lengthTemporary}; ${indexTemporary}++) {\n` +
          indent(
            `let ${itemVariable} = runtime.listGetAt(${sourceTemporary}, ${indexTemporary});\n` +
              `let ${indexVariable} = BigInt(${indexTemporary});\n` +
              body,
          ) +
          `\n}`,
      ) +
      `\n}`,
  );
}

function compileLazyBoolean(
  operator: "and" | "or",
  operation: string,
  operands: readonly SExpr[],
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): CompiledValue {
  exactArity(operation, operands, 2, path);
  const left = compileValue(operands[0]!, `${path}[1]`, scope, loopDepth, context);
  const right = compileValue(operands[1]!, `${path}[2]`, scope, loopDepth, context);
  const temporary = nextTemporary(context, "bool");
  context.expressionTemporaries.push(temporary);
  if (operator === "and") {
    return value(
      `(${temporary}=${left},${temporary}===false?false:` +
        `${temporary}===true?runtime.boolValue(${right}):null)`,
    );
  }
  return value(
    `(${temporary}=${left},${temporary}===true?true:` +
      `${temporary}===false?runtime.boolValue(${right}):null)`,
  );
}

function compileMutation(
  method: "mapSet" | "listSet" | "listPush",
  operation: string,
  operands: readonly SExpr[],
  arity: number,
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): CompiledNone {
  exactArity(operation, operands, arity, path);
  const args = compileValues(operands, path, scope, loopDepth, context);
  return none(`runtime.${method}(${args.join(",")});`);
}

function compileValues(
  operands: readonly SExpr[],
  path: string,
  scope: Scope,
  loopDepth: number,
  context: CompileContext,
): string[] {
  return operands.map((operand, index) =>
    compileValue(operand, `${path}[${index + 1}]`, scope, loopDepth, context),
  );
}

function splitInvoke(node: SExpr, path: string): { operation: string; operands: readonly SExpr[] } {
  if (typeof node === "string") {
    if (node.length === 0) throw new ScriptCompileError("invoke name cannot be empty", path);
    return { operation: node, operands: [] };
  }
  if (!Array.isArray(node)) throw new ScriptCompileError("expected an invoke", path);
  if (node.length === 0) throw new ScriptCompileError("invoke cannot be empty", path);
  if (node.length === 1) {
    throw new ScriptCompileError("zero-argument invokes must use their atom form", path);
  }
  const operation = node[0];
  if (typeof operation !== "string" || operation.length === 0) {
    throw new ScriptCompileError("invoke must start with a non-empty operation atom", path);
  }
  return { operation, operands: node.slice(1) };
}

function isBlock(node: SExpr): node is readonly SExpr[] {
  return Array.isArray(node) && node.length > 0 && typeof node[0] !== "string";
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

function resolveBinding(scope: Scope, name: string, path: string): string {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    const binding = current.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  throw new ScriptCompileError(`unknown variable ${quote(name)}`, path);
}

function nextVariable(context: CompileContext): string {
  return `v${context.nextVariable++}`;
}

function nextTemporary(context: CompileContext, hint: string): string {
  return `_${hint}${context.nextTemporary++}`;
}

function indent(source: string): string {
  return source
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function parseFloatLiteral(value: string): number | null {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

class Runtime {
  readonly external: readonly ExternalFunction[];
  readonly onDiagnostic: ((diagnostic: ScriptDiagnostic) => void) | undefined;
  readonly ownedLists = new WeakSet<object>();
  readonly ownedMaps = new WeakSet<object>();
  readonly foreignCache = new WeakMap<object, ListView | MapView>();

  constructor(
    external: readonly ExternalFunction[],
    onDiagnostic: ((diagnostic: ScriptDiagnostic) => void) | undefined,
  ) {
    this.external = external;
    this.onDiagnostic = onDiagnostic;
  }

  callExternal(index: number, args: ScriptValue[]): ScriptValue {
    const fn = this.external[index];
    if (fn === undefined) throw new ScriptRuntimeError(`missing external function ${index}`);
    return this.normalizeForeign(fn(...args));
  }

  normalizeForeign(input: unknown): ScriptValue {
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "bigint" ||
      typeof input === "string"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        throw new ScriptRuntimeError("foreign functions cannot expose non-finite numbers");
      }
      return input;
    }
    if (typeof input !== "object") {
      throw new ScriptRuntimeError(`foreign function exposed unsupported ${typeof input} value`);
    }

    if (this.ownedLists.has(input) || this.ownedMaps.has(input)) {
      return input as ScriptValue;
    }
    if (isListView(input) || isMapView(input)) return input;

    const cached = this.foreignCache.get(input);
    if (cached !== undefined) return cached;

    if (Array.isArray(input)) {
      const view = createListView({
        get length() {
          return input.length;
        },
        get(index: number) {
          return Object.hasOwn(input, index) ? input[index] : null;
        },
      });
      this.foreignCache.set(input, view);
      return view;
    }
    if (input instanceof Map) {
      const view = createMapView({
        has(key: ScriptValue) {
          return input.has(key);
        },
        get(key: ScriptValue) {
          return input.get(key);
        },
      });
      this.foreignCache.set(input, view);
      return view;
    }

    const object = input as Record<string, unknown>;
    const view = createMapView({
      has(key: ScriptValue) {
        return typeof key === "string" && Object.hasOwn(object, key);
      },
      get(key: ScriptValue) {
        return typeof key === "string" && Object.hasOwn(object, key) ? object[key] : null;
      },
    });
    this.foreignCache.set(input, view);
    return view;
  }

  nullIs(input: ScriptValue): boolean {
    return input === null;
  }

  boolIs(input: ScriptValue): boolean {
    return typeof input === "boolean";
  }

  integerIs(input: ScriptValue): boolean {
    return typeof input === "bigint";
  }

  floatIs(input: ScriptValue): boolean {
    return typeof input === "number";
  }

  stringIs(input: ScriptValue): boolean {
    return typeof input === "string";
  }

  listIs(input: ScriptValue): boolean {
    return Array.isArray(input) || isListView(input);
  }

  mapIs(input: ScriptValue): boolean {
    return input instanceof Map || isMapView(input);
  }

  integerFrom(input: ScriptValue): bigint | null {
    try {
      if (typeof input === "bigint") return input;
      if (typeof input === "number") return BigInt(Math.trunc(input));
      if (typeof input === "string" && input.trim() !== "") return BigInt(input);
      return null;
    } catch {
      return null;
    }
  }

  floatFrom(input: ScriptValue): number | null {
    let converted: number;
    if (typeof input === "number") return input;
    if (typeof input === "bigint") converted = Number(input);
    else if (typeof input === "string" && input.trim() !== "") converted = Number(input);
    else return null;
    return Number.isFinite(converted) ? converted : null;
  }

  stringFrom(input: ScriptValue): string | null {
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "bigint" ||
      typeof input === "number" ||
      typeof input === "string"
    ) {
      return String(input);
    }
    return null;
  }

  stringConcat(left: ScriptValue, right: ScriptValue): string | null {
    return typeof left === "string" && typeof right === "string" ? left + right : null;
  }

  integerAdd(left: ScriptValue, right: ScriptValue): bigint | null {
    return integerBinary(left, right, (a, b) => a + b);
  }

  integerSubtract(left: ScriptValue, right: ScriptValue): bigint | null {
    return integerBinary(left, right, (a, b) => a - b);
  }

  integerMultiply(left: ScriptValue, right: ScriptValue): bigint | null {
    return integerBinary(left, right, (a, b) => a * b);
  }

  integerDivide(left: ScriptValue, right: ScriptValue): bigint | null {
    if (typeof left !== "bigint" || typeof right !== "bigint" || right === 0n) return null;
    try {
      return left / right;
    } catch {
      return null;
    }
  }

  integerPow(left: ScriptValue, right: ScriptValue): bigint | null {
    if (typeof left !== "bigint" || typeof right !== "bigint" || right < 0n) return null;
    try {
      return left ** right;
    } catch {
      return null;
    }
  }

  floatAdd(left: ScriptValue, right: ScriptValue): number | null {
    return floatBinary(left, right, (a, b) => a + b);
  }

  floatSubtract(left: ScriptValue, right: ScriptValue): number | null {
    return floatBinary(left, right, (a, b) => a - b);
  }

  floatMultiply(left: ScriptValue, right: ScriptValue): number | null {
    return floatBinary(left, right, (a, b) => a * b);
  }

  floatDivide(left: ScriptValue, right: ScriptValue): number | null {
    if (typeof left !== "number" || typeof right !== "number" || right === 0) return null;
    const result = left / right;
    return Number.isFinite(result) ? result : null;
  }

  floatPow(left: ScriptValue, right: ScriptValue): number | null {
    return floatBinary(left, right, (a, b) => a ** b);
  }

  compareEqual(left: ScriptValue, right: ScriptValue): boolean {
    return left === right;
  }

  compareLess(left: ScriptValue, right: ScriptValue): boolean | null {
    return compareOrdered(left, right, (a, b) => a < b);
  }

  compareLessEqual(left: ScriptValue, right: ScriptValue): boolean | null {
    return compareOrdered(left, right, (a, b) => a <= b);
  }

  compareGreater(left: ScriptValue, right: ScriptValue): boolean | null {
    return compareOrdered(left, right, (a, b) => a > b);
  }

  compareGreaterEqual(left: ScriptValue, right: ScriptValue): boolean | null {
    return compareOrdered(left, right, (a, b) => a >= b);
  }

  boolNot(input: ScriptValue): boolean | null {
    return typeof input === "boolean" ? !input : null;
  }

  boolValue(input: ScriptValue): boolean | null {
    return typeof input === "boolean" ? input : null;
  }

  caseCondition(input: ScriptValue): boolean {
    return input === true;
  }

  mapNew(entries: ScriptValue[]): Map<ScriptValue, ScriptValue> {
    const map = new Map<ScriptValue, ScriptValue>();
    this.ownedMaps.add(map);
    for (let index = 0; index < entries.length; index += 2) {
      map.set(entries[index]!, entries[index + 1]!);
    }
    return map;
  }

  listNew(entries: ScriptValue[]): ScriptValue[] {
    this.ownedLists.add(entries);
    return entries;
  }

  mapGet(input: ScriptValue, key: ScriptValue): ScriptValue | null {
    if (input instanceof Map) {
      if (!input.has(key)) return null;
      return this.normalizeForeign(input.get(key));
    }
    if (!isMapView(input)) return null;
    if (!this.viewHas(input, key)) return null;
    return this.normalizeForeign(input.get(key));
  }

  mapHas(input: ScriptValue, key: ScriptValue): boolean | null {
    if (input instanceof Map) return input.has(key);
    return isMapView(input) ? this.viewHas(input, key) : null;
  }

  mapSet(input: ScriptValue, key: ScriptValue, entry: ScriptValue): void {
    if (isMapView(input)) throw new ScriptRuntimeError("cannot mutate a MapView");
    if (!(input instanceof Map) || !this.ownedMaps.has(input)) {
      throw new ScriptRuntimeError("map.set requires a map owned by the script");
    }
    input.set(key, entry);
  }

  mapRemove(input: ScriptValue, key: ScriptValue): boolean | null {
    if (isMapView(input)) throw new ScriptRuntimeError("cannot mutate a MapView");
    if (!(input instanceof Map) || !this.ownedMaps.has(input)) return null;
    return input.delete(key);
  }

  listGet(input: ScriptValue, index: ScriptValue): ScriptValue | null {
    if (typeof index !== "bigint" || index < 0n || index > BigInt(Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    return this.listGetAt(input, Number(index));
  }

  listGetAt(input: ScriptValue, index: number): ScriptValue | null {
    if (Array.isArray(input)) {
      return Object.hasOwn(input, index) ? this.normalizeForeign(input[index]) : null;
    }
    if (!isListView(input)) return null;
    const length = this.checkedViewLength(input);
    if (index < 0 || index >= length) return null;
    return this.normalizeForeign(input.get(index));
  }

  listSet(input: ScriptValue, index: ScriptValue, entry: ScriptValue): void {
    if (isListView(input)) throw new ScriptRuntimeError("cannot mutate a ListView");
    if (!Array.isArray(input) || !this.ownedLists.has(input)) {
      throw new ScriptRuntimeError("list.set requires a list owned by the script");
    }
    const nativeIndex = listIndex(index);
    if (nativeIndex === null || nativeIndex >= input.length) {
      throw new ScriptRuntimeError("list.set requires an existing integer index");
    }
    input[nativeIndex] = entry;
  }

  listPush(input: ScriptValue, entry: ScriptValue): void {
    if (isListView(input)) throw new ScriptRuntimeError("cannot mutate a ListView");
    if (!Array.isArray(input) || !this.ownedLists.has(input)) {
      throw new ScriptRuntimeError("list.push requires a list owned by the script");
    }
    input.push(entry);
  }

  listLength(input: ScriptValue): bigint | null {
    if (Array.isArray(input)) return BigInt(input.length);
    return isListView(input) ? BigInt(this.checkedViewLength(input)) : null;
  }

  iterableLength(input: ScriptValue): number | null {
    if (Array.isArray(input)) return input.length;
    return isListView(input) ? this.checkedViewLength(input) : null;
  }

  diagnosticWarn(input: ScriptValue): null {
    if (typeof input === "string") {
      this.onDiagnostic?.({ level: "warning", message: input });
    }
    return null;
  }

  diagnosticTypeName(input: ScriptValue): string {
    if (input === null) return "null";
    if (typeof input === "boolean") return "bool";
    if (typeof input === "bigint") return "integer";
    if (typeof input === "number") return "float";
    if (typeof input === "string") return "string";
    if (Array.isArray(input) || isListView(input)) return "list";
    return "map";
  }

  private checkedViewLength(view: ListView): number {
    const length = view.length;
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new ScriptRuntimeError("ListView.length must be a non-negative safe integer");
    }
    return length;
  }

  private viewHas(view: MapView, key: ScriptValue): boolean {
    const result = view.has(key);
    if (typeof result !== "boolean") {
      throw new ScriptRuntimeError("MapView.has must return a boolean");
    }
    return result;
  }
}

function integerBinary(
  left: ScriptValue,
  right: ScriptValue,
  operation: (left: bigint, right: bigint) => bigint,
): bigint | null {
  if (typeof left !== "bigint" || typeof right !== "bigint") return null;
  try {
    return operation(left, right);
  } catch {
    return null;
  }
}

function floatBinary(
  left: ScriptValue,
  right: ScriptValue,
  operation: (left: number, right: number) => number,
): number | null {
  if (typeof left !== "number" || typeof right !== "number") return null;
  const result = operation(left, right);
  return Number.isFinite(result) ? result : null;
}

type OrderedValue = bigint | number | string;

function compareOrdered(
  left: ScriptValue,
  right: ScriptValue,
  operation: (left: OrderedValue, right: OrderedValue) => boolean,
): boolean | null {
  if (typeof left !== typeof right) return null;
  if (typeof left !== "bigint" && typeof left !== "number" && typeof left !== "string") return null;
  return operation(left, right as OrderedValue);
}

function listIndex(input: ScriptValue): number | null {
  if (typeof input !== "bigint" || input < 0n || input > BigInt(0xffff_ffff - 1)) return null;
  return Number(input);
}
