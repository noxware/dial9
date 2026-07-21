(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Dial9Script = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class CompileError extends Error {
    constructor(message) {
      super(message);
      this.name = "Dial9ScriptCompileError";
    }
  }

  class ListView {
    constructor(length, get) {
      if (!Number.isSafeInteger(length) || length < 0 || typeof get !== "function") {
        throw new TypeError("ListView requires a non-negative length and get(index)");
      }
      this.length = length;
      this.get = get;
      Object.freeze(this);
    }
  }

  class MapView {
    constructor(get, has) {
      if (typeof get !== "function") throw new TypeError("MapView requires get(key)");
      this.get = get;
      this.has = typeof has === "function" ? has : (key) => get(key) !== undefined;
      Object.freeze(this);
    }
  }

  function fail(message) {
    throw new CompileError(message);
  }

  function atom(node, label) {
    if (typeof node !== "string") fail(`${label} must be an atom`);
    return node;
  }

  function arity(node, expected, name) {
    const actual = node.length - 1;
    if (actual !== expected) fail(`${name} expects ${expected} argument(s), got ${actual}`);
  }

  function atLeast(node, minimum, name) {
    const actual = node.length - 1;
    if (actual < minimum) fail(`${name} expects at least ${minimum} argument(s), got ${actual}`);
  }

  function binary(operator) {
    return (compiler, node) => {
      arity(node, 2, node[0]);
      return `(${compiler.expression(node[1])} ${operator} ${compiler.expression(node[2])})`;
    };
  }

  function runtimeBinary(helper) {
    return (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.${helper}(${compiler.expression(node[1])},${compiler.expression(node[2])})`;
    };
  }

  const OPERATIONS = Object.freeze({
    "integer.const": (compiler, node) => {
      arity(node, 1, node[0]);
      const raw = atom(node[1], "integer.const value");
      let value;
      try { value = BigInt(raw); } catch { fail(`invalid integer constant ${JSON.stringify(raw)}`); }
      return `${value.toString()}n`;
    },
    "float.const": (compiler, node) => {
      arity(node, 1, node[0]);
      const raw = atom(node[1], "float.const value");
      const value = Number(raw);
      if (!Number.isFinite(value)) fail(`invalid float constant ${JSON.stringify(raw)}`);
      return Object.is(value, -0) ? "-0" : String(value);
    },
    "string.const": (compiler, node) => {
      arity(node, 1, node[0]);
      return JSON.stringify(atom(node[1], "string.const value"));
    },
    "var.get": (compiler, node) => {
      arity(node, 1, node[0]);
      return compiler.variable(atom(node[1], "var.get name"));
    },
    "var.set": (compiler, node) => {
      arity(node, 2, node[0]);
      return `(${compiler.variable(atom(node[1], "var.set name"))}=${compiler.expression(node[2])})`;
    },
    "case": (compiler, node) => {
      if ((node.length - 1) % 2 !== 0 || node.length === 1) {
        fail("case expects condition/body pairs");
      }
      const branches = [];
      for (let i = 1; i < node.length; i += 2) {
        branches.push(`if($rt.boolean(${compiler.expression(node[i])}))return ${compiler.body(node[i + 1])};`);
      }
      return `(()=>{${branches.join("")}return null;})()`;
    },
    "for_each": (compiler, node) => {
      arity(node, 4, node[0]);
      const item = compiler.variable(atom(node[1], "for_each item name"));
      const index = compiler.variable(atom(node[2], "for_each index name"));
      const list = compiler.temp("list");
      const length = compiler.temp("length");
      const cursor = compiler.temp("index");
      const result = compiler.temp("result");
      return `(()=>{const ${list}=${compiler.expression(node[3])};const ${length}=$rt.listSize(${list});let ${result}=null;for(let ${cursor}=0;${cursor}<${length};${cursor}++){${item}=$rt.listGet(${list},${cursor});${index}=BigInt(${cursor});${result}=${compiler.body(node[4])};}return ${result};})()`;
    },
    "integer.from": (compiler, node) => {
      arity(node, 1, node[0]);
      return `$rt.integer(${compiler.expression(node[1])})`;
    },
    "float.from": (compiler, node) => {
      arity(node, 1, node[0]);
      return `$rt.float(${compiler.expression(node[1])})`;
    },
    "string.from": (compiler, node) => {
      arity(node, 1, node[0]);
      return `String(${compiler.expression(node[1])})`;
    },
    "type.of": (compiler, node) => {
      arity(node, 1, node[0]);
      return `$rt.typeOf(${compiler.expression(node[1])})`;
    },
    "integer.add": runtimeBinary("integerAdd"),
    "integer.subtract": runtimeBinary("integerSubtract"),
    "integer.multiply": runtimeBinary("integerMultiply"),
    "integer.divide": runtimeBinary("integerDivide"),
    "integer.pow": runtimeBinary("integerPow"),
    "float.add": runtimeBinary("floatAdd"),
    "float.subtract": runtimeBinary("floatSubtract"),
    "float.multiply": runtimeBinary("floatMultiply"),
    "float.divide": runtimeBinary("floatDivide"),
    "float.pow": runtimeBinary("floatPow"),
    "cmp.eq": binary("==="),
    "cmp.lt": runtimeBinary("lessThan"),
    "cmp.lte": runtimeBinary("lessThanOrEqual"),
    "cmp.gt": runtimeBinary("greaterThan"),
    "cmp.gte": runtimeBinary("greaterThanOrEqual"),
    "bool.not": (compiler, node) => {
      arity(node, 1, node[0]);
      return `(!$rt.boolean(${compiler.expression(node[1])}))`;
    },
    "bool.and": (compiler, node) => {
      atLeast(node, 1, node[0]);
      return `(${node.slice(1).map((arg) => `$rt.boolean(${compiler.expression(arg)})`).join("&&")})`;
    },
    "bool.or": (compiler, node) => {
      atLeast(node, 1, node[0]);
      return `(${node.slice(1).map((arg) => `$rt.boolean(${compiler.expression(arg)})`).join("||")})`;
    },
    "map.new": (compiler, node) => {
      if ((node.length - 1) % 2 !== 0) fail("map.new expects key/value pairs");
      return `$rt.mapNew([${node.slice(1).map((arg) => compiler.expression(arg)).join(",")}])`;
    },
    "map.get": (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.mapGet(${compiler.expression(node[1])},${compiler.expression(node[2])})`;
    },
    "map.has": (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.mapHas(${compiler.expression(node[1])},${compiler.expression(node[2])})`;
    },
    "map.set": (compiler, node) => {
      arity(node, 3, node[0]);
      return `$rt.mapSet(${compiler.expression(node[1])},${compiler.expression(node[2])},${compiler.expression(node[3])})`;
    },
    "map.remove": (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.mapRemove(${compiler.expression(node[1])},${compiler.expression(node[2])})`;
    },
    "list.new": (compiler, node) => `$rt.listNew([${node.slice(1).map((arg) => compiler.expression(arg)).join(",")}])`,
    "list.get": (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.listGet(${compiler.expression(node[1])},$rt.index(${compiler.expression(node[2])}))`;
    },
    "list.set": (compiler, node) => {
      arity(node, 3, node[0]);
      return `$rt.listSet(${compiler.expression(node[1])},$rt.index(${compiler.expression(node[2])}),${compiler.expression(node[3])})`;
    },
    "list.push": (compiler, node) => {
      arity(node, 2, node[0]);
      return `$rt.listPush(${compiler.expression(node[1])},${compiler.expression(node[2])})`;
    },
    "list.length": (compiler, node) => {
      arity(node, 1, node[0]);
      return `BigInt($rt.listSize(${compiler.expression(node[1])}))`;
    },
    "diagnostic.warn": (compiler, node) => {
      arity(node, 1, node[0]);
      return `$rt.warn(${compiler.expression(node[1])})`;
    },
  });

  const ZERO_ARGUMENT_OPERATIONS = Object.freeze({
    "null": "null",
    "bool.true": "true",
    "bool.false": "false",
    "integer.zero": "0n",
    "float.zero": "0",
    "map.new": "new Map()",
    "list.new": "[]",
  });

  function collectVariables(node, names) {
    if (!Array.isArray(node) || node.length === 0) return;
    const name = node[0];
    if (name === "var.get" || name === "var.set") {
      if (typeof node[1] === "string") names.add(node[1]);
    } else if (name === "for_each") {
      if (typeof node[1] === "string") names.add(node[1]);
      if (typeof node[2] === "string") names.add(node[2]);
    }
    for (const child of node) collectVariables(child, names);
  }

  function normalizeComputedValues(bundle, options) {
    const values = options.computedValues ?? bundle?.computed_values ?? {};
    const normalized = {};
    for (const [name, value] of Object.entries(values || {})) {
      normalized[name] = value && Object.prototype.hasOwnProperty.call(value, "expression")
        ? value.expression
        : value;
    }
    return normalized;
  }

  function createCompiler(script, computedValues, functions) {
    const variableNames = new Set();
    collectVariables(script, variableNames);
    for (const expression of Object.values(computedValues)) collectVariables(expression, variableNames);
    const variables = new Map([...variableNames].map((name, index) => [name, `$v${index}`]));
    const externalNames = Object.keys(functions);
    const externals = new Map(externalNames.map((name, index) => [name, `$f${index}`]));
    const computedStack = [];
    let temporary = 0;

    const compiler = {
      variable(name) {
        const value = variables.get(name);
        if (!value) fail(`unknown variable ${JSON.stringify(name)}`);
        return value;
      },
      temp(label) {
        return `$${label}${temporary++}`;
      },
      body(node) {
        if (Array.isArray(node) && (node.length === 0 || Array.isArray(node[0]))) {
          if (node.length === 0) return "null";
          return `(${node.map((entry) => compiler.expression(entry)).join(",")})`;
        }
        return compiler.expression(node);
      },
      expression(node) {
        if (typeof node === "string") {
          if (Object.prototype.hasOwnProperty.call(ZERO_ARGUMENT_OPERATIONS, node)) {
            return ZERO_ARGUMENT_OPERATIONS[node];
          }
          if (node.startsWith("computed.")) {
            const name = node.slice("computed.".length);
            if (!Object.prototype.hasOwnProperty.call(computedValues, name)) {
              fail(`unknown computed value ${JSON.stringify(name)}`);
            }
            if (computedStack.includes(name)) fail(`recursive computed value ${JSON.stringify(name)}`);
            computedStack.push(name);
            const result = compiler.expression(computedValues[name]);
            computedStack.pop();
            return result;
          }
          const external = externals.get(node);
          if (external) return `${external}()`;
          fail(`unknown zero-argument operation ${JSON.stringify(node)}`);
        }
        if (!Array.isArray(node) || node.length === 0) fail("expression must be an atom or non-empty list");
        if (node.length === 1) fail(`single-element invoke ${JSON.stringify(node)} is not canonical`);
        const name = atom(node[0], "operation name");
        const operation = OPERATIONS[name];
        if (operation) return operation(compiler, node);
        const external = externals.get(name);
        if (external) return `${external}(${node.slice(1).map((arg) => compiler.expression(arg)).join(",")})`;
        fail(`unknown operation ${JSON.stringify(name)}`);
      },
      variables,
      externalNames,
      externals,
    };
    return compiler;
  }

  const runtime = Object.freeze({
    integer(value) {
      if (typeof value === "bigint") return value;
      if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
      if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
      throw new TypeError(`cannot convert ${String(value)} to integer`);
    },
    float(value) {
      if (typeof value !== "number" && typeof value !== "bigint" && typeof value !== "string") {
        throw new TypeError(`cannot convert ${String(value)} to float`);
      }
      const result = Number(value);
      if (!Number.isFinite(result)) throw new TypeError(`float must be finite, got ${String(value)}`);
      return result;
    },
    floatOperand(value) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TypeError(`expected float, got ${runtime.typeOf(value)}`);
      }
      return value;
    },
    boolean(value) {
      if (typeof value !== "boolean") throw new TypeError(`expected bool, got ${runtime.typeOf(value)}`);
      return value;
    },
    index(value) {
      const result = typeof value === "bigint" ? Number(value) : value;
      if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("list index must be a non-negative integer");
      return result;
    },
    typeOf(value) {
      if (value === null) return "null";
      if (typeof value === "bigint") return "integer";
      if (typeof value === "number") return "float";
      if (typeof value === "string") return "string";
      if (typeof value === "boolean") return "bool";
      if (value instanceof Uint8Array) return "bytes";
      if (Array.isArray(value) || value instanceof ListView) return "list";
      if (value instanceof Map || value instanceof MapView) return "map";
      return "unknown";
    },
    integerAdd(a, b) { return runtime.integer(a) + runtime.integer(b); },
    integerSubtract(a, b) { return runtime.integer(a) - runtime.integer(b); },
    integerMultiply(a, b) { return runtime.integer(a) * runtime.integer(b); },
    integerDivide(a, b) {
      const divisor = runtime.integer(b);
      if (divisor === 0n) throw new RangeError("integer division by zero");
      return runtime.integer(a) / divisor;
    },
    integerPow(a, b) {
      const exponent = runtime.integer(b);
      if (exponent < 0n) throw new RangeError("integer exponent must be non-negative");
      return runtime.integer(a) ** exponent;
    },
    floatResult(value) {
      if (!Number.isFinite(value)) throw new RangeError("float result must be finite");
      return value;
    },
    floatAdd(a, b) { return runtime.floatResult(runtime.floatOperand(a) + runtime.floatOperand(b)); },
    floatSubtract(a, b) { return runtime.floatResult(runtime.floatOperand(a) - runtime.floatOperand(b)); },
    floatMultiply(a, b) { return runtime.floatResult(runtime.floatOperand(a) * runtime.floatOperand(b)); },
    floatDivide(a, b) {
      const divisor = runtime.floatOperand(b);
      if (divisor === 0) throw new RangeError("float division by zero");
      return runtime.floatResult(runtime.floatOperand(a) / divisor);
    },
    floatPow(a, b) { return runtime.floatResult(runtime.floatOperand(a) ** runtime.floatOperand(b)); },
    comparable(a, b) {
      if (typeof a !== typeof b) throw new TypeError("comparison operands must have the same type");
    },
    lessThan(a, b) { runtime.comparable(a, b); return a < b; },
    lessThanOrEqual(a, b) { runtime.comparable(a, b); return a <= b; },
    greaterThan(a, b) { runtime.comparable(a, b); return a > b; },
    greaterThanOrEqual(a, b) { runtime.comparable(a, b); return a >= b; },
    mapNew(entries) {
      const result = new Map();
      for (let i = 0; i < entries.length; i += 2) result.set(entries[i], entries[i + 1]);
      return result;
    },
    mapGet(map, key) {
      if (map instanceof Map || map instanceof MapView) return map.get(key);
      if (map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, key)) return map[key];
      return undefined;
    },
    mapHas(map, key) {
      if (map instanceof Map || map instanceof MapView) return map.has(key);
      return !!map && typeof map === "object" && Object.prototype.hasOwnProperty.call(map, key);
    },
    mapSet(map, key, value) {
      if (!(map instanceof Map)) throw new TypeError("map.set requires a mutable Map");
      map.set(key, value);
      return map;
    },
    mapRemove(map, key) {
      if (!(map instanceof Map)) throw new TypeError("map.remove requires a mutable Map");
      map.delete(key);
      return map;
    },
    listNew(values) { return values; },
    listSize(list) {
      if (Array.isArray(list) || list instanceof ListView) return list.length;
      throw new TypeError("expected List or ListView");
    },
    listGet(list, index) {
      if (Array.isArray(list)) return list[index];
      if (list instanceof ListView) return list.get(index);
      throw new TypeError("expected List or ListView");
    },
    listSet(list, index, value) {
      if (!Array.isArray(list)) throw new TypeError("list.set requires a mutable Array");
      list[index] = value;
      return list;
    },
    listPush(list, value) {
      if (!Array.isArray(list)) throw new TypeError("list.push requires a mutable Array");
      list.push(value);
      return list;
    },
    warn(value) {
      this.onWarning(String(value));
      return null;
    },
    onWarning(value) { console.warn(`[Dial9 Script] ${value}`); },
  });

  function compile(bundleOrScript, options = {}) {
    const bundle = bundleOrScript && !Array.isArray(bundleOrScript) && typeof bundleOrScript === "object"
      ? bundleOrScript
      : null;
    const script = bundle ? bundle.script : bundleOrScript;
    const computedValues = normalizeComputedValues(bundle, options);
    const functions = options.functions || {};
    for (const [name, fn] of Object.entries(functions)) {
      if (typeof fn !== "function") fail(`registered function ${JSON.stringify(name)} is not callable`);
    }
    const compiler = createCompiler(script, computedValues, functions);
    const expression = compiler.body(script);
    const imports = compiler.externalNames
      .map((name) => `const ${compiler.externals.get(name)}=$functions[${JSON.stringify(name)}];`)
      .join("");
    const declarations = compiler.variables.size > 0
      ? `let ${[...compiler.variables.values()].join(",")};`
      : "";
    const source = `"use strict";${imports}return function program(){${declarations}return ${expression};}`;
    const configuredRuntime = Object.create(runtime);
    if (typeof options.onWarning === "function") {
      Object.defineProperty(configuredRuntime, "onWarning", { value: options.onWarning });
    }
    const program = new Function("$functions", "$rt", source)(functions, configuredRuntime);
    Object.defineProperty(program, "source", { value: source, enumerable: true });
    return program;
  }

  return Object.freeze({
    compile,
    CompileError,
    ListView,
    MapView,
    operationNames: Object.freeze([...Object.keys(ZERO_ARGUMENT_OPERATIONS), ...Object.keys(OPERATIONS)]),
  });
});
