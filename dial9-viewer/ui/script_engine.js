// script_engine.js - Standalone compiler for the Dial9 S-expression language.
// The engine has no trace or viewer dependencies. Host capabilities are ordinary
// registered functions whose arguments are evaluated before invocation.

(function (exports) {
  "use strict";

  class ScriptCompileError extends Error {
    constructor(message) {
      super(message);
      this.name = "ScriptCompileError";
    }
  }

  class ScriptRuntimeError extends Error {
    constructor(message) {
      super(message);
      this.name = "ScriptRuntimeError";
    }
  }

  class ListView {
    constructor(length, get) {
      if (!Number.isSafeInteger(length) || length < 0 || typeof get !== "function") {
        throw new TypeError("ListView requires a non-negative safe length and get function");
      }
      this.length = length;
      this.get = get;
      Object.freeze(this);
    }
  }

  class MapView {
    constructor(get, has) {
      if (typeof get !== "function" || typeof has !== "function") {
        throw new TypeError("MapView requires get and has functions");
      }
      this.get = get;
      this.has = has;
      Object.freeze(this);
    }
  }

  const UNSET = Symbol("dial9-script-unset");

  function failRuntime(message) {
    throw new ScriptRuntimeError(message);
  }

  function integer(value, operation) {
    if (typeof value !== "bigint") {
      failRuntime(`${operation} expected Integer, got ${typeOf(value)}`);
    }
    return value;
  }

  function float(value, operation) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      failRuntime(`${operation} expected finite Float, got ${typeOf(value)}`);
    }
    return value;
  }

  function boolean(value, operation) {
    if (typeof value !== "boolean") {
      failRuntime(`${operation} expected Bool, got ${typeOf(value)}`);
    }
    return value;
  }

  function string(value, operation) {
    if (typeof value !== "string") {
      failRuntime(`${operation} expected String, got ${typeOf(value)}`);
    }
    return value;
  }

  function finiteResult(value, operation) {
    if (!Number.isFinite(value)) failRuntime(`${operation} produced a non-finite Float`);
    return value;
  }

  function typeOf(value) {
    if (value === null) return "null";
    if (typeof value === "bigint") return "integer";
    if (typeof value === "number" && Number.isFinite(value)) return "float";
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "bool";
    if (value instanceof Uint8Array) return "bytes";
    if (Array.isArray(value) || value instanceof ListView) return "list";
    if (value instanceof Map || value instanceof MapView) return "map";
    return "host";
  }

  function listLength(value) {
    if (Array.isArray(value) || value instanceof ListView) return value.length;
    failRuntime(`list operation expected List, got ${typeOf(value)}`);
  }

  function indexNumber(value, operation) {
    const index = integer(value, operation);
    if (index < 0n || index > BigInt(Number.MAX_SAFE_INTEGER)) {
      failRuntime(`${operation} index is out of range`);
    }
    return Number(index);
  }

  function listGet(value, index) {
    const i = indexNumber(index, "list.get");
    const length = listLength(value);
    if (i >= length) failRuntime(`list.get index ${i} is out of bounds`);
    return value instanceof ListView ? value.get(i) : value[i];
  }

  function mutableList(value, operation) {
    if (!Array.isArray(value)) failRuntime(`${operation} requires a mutable List`);
    return value;
  }

  function mapGet(value, key) {
    if (value instanceof Map || value instanceof MapView) return value.get(key);
    failRuntime(`map.get expected Map, got ${typeOf(value)}`);
  }

  function mapHas(value, key) {
    if (value instanceof Map || value instanceof MapView) return value.has(key);
    failRuntime(`map.has expected Map, got ${typeOf(value)}`);
  }

  function mutableMap(value, operation) {
    if (!(value instanceof Map)) failRuntime(`${operation} requires a mutable Map`);
    return value;
  }

  function mapNew(values) {
    const result = new Map();
    for (let i = 0; i < values.length; i += 2) result.set(values[i], values[i + 1]);
    return result;
  }

  function compare(left, right, operation) {
    const leftType = typeOf(left);
    if (leftType !== typeOf(right)) {
      failRuntime(`${operation} requires operands of the same type`);
    }
    if (leftType !== "integer" && leftType !== "float" && leftType !== "string") {
      failRuntime(`${operation} cannot order ${leftType}`);
    }
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  function equal(left, right) {
    if (typeOf(left) !== typeOf(right)) return false;
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((value, i) => equal(value, right[i]));
    }
    if (left instanceof Map && right instanceof Map) {
      if (left.size !== right.size) return false;
      for (const [key, value] of left) {
        if (!right.has(key) || !equal(value, right.get(key))) return false;
      }
      return true;
    }
    return left === right;
  }

  const runtime = {
    UNSET,
    read(value, name) {
      if (value === UNSET) failRuntime(`variable ${JSON.stringify(name)} was read before assignment`);
      return value;
    },
    integer,
    float,
    boolean,
    string,
    finiteResult,
    typeOf,
    listLength,
    listGet,
    mapGet,
    mapHas,
    mapNew,
    equal,
    compare,
  };

  function atom(node, description) {
    if (typeof node !== "string") {
      throw new ScriptCompileError(`${description} must be an Atom`);
    }
    return node;
  }

  function expectArity(operation, args, arity) {
    if (args.length !== arity) {
      throw new ScriptCompileError(`${operation} expects ${arity} argument(s), got ${args.length}`);
    }
  }

  function expectMinArity(operation, args, arity) {
    if (args.length < arity) {
      throw new ScriptCompileError(`${operation} expects at least ${arity} argument(s)`);
    }
  }

  function collectVariables(node, variables) {
    if (!Array.isArray(node) || node.length === 0) return;
    if (Array.isArray(node[0])) {
      for (const expression of node) collectVariables(expression, variables);
      return;
    }
    const operation = atom(node[0], "operation");
    if (operation === "var.set") {
      if (node.length >= 2 && typeof node[1] === "string") variables.add(node[1]);
    } else if (operation === "for_each") {
      if (node.length >= 3) {
        if (typeof node[1] === "string") variables.add(node[1]);
        if (typeof node[2] === "string") variables.add(node[2]);
      }
    }
    for (let i = 1; i < node.length; i++) collectVariables(node[i], variables);
  }

  function compile(source, options) {
    const opts = options || {};
    const registered = opts.functions || {};
    const computed = opts.computed || {};
    const diagnostics = typeof opts.onDiagnostic === "function" ? opts.onDiagnostic : () => {};
    const functionNames = Object.keys(registered);
    for (const name of functionNames) {
      if (typeof registered[name] !== "function") {
        throw new ScriptCompileError(`registered function ${JSON.stringify(name)} is not callable`);
      }
    }

    const variables = new Set();
    collectVariables(source, variables);
    for (const expression of Object.values(computed)) collectVariables(expression, variables);
    const slots = new Map([...variables].map((name, index) => [name, `_v${index}`]));
    const externalIndex = new Map(functionNames.map((name, index) => [name, index]));
    const computedStack = [];
    let temporary = 0;

    function temp(prefix) {
      return `_${prefix}${temporary++}`;
    }

    function emitBody(node) {
      if (Array.isArray(node) && node.length > 0 && Array.isArray(node[0])) {
        const expressions = node.map(emitExpression);
        return `(()=>{${expressions.slice(0, -1).map((code) => `${code};`).join("")}return ${expressions.at(-1)};})()`;
      }
      return emitExpression(node);
    }

    function emitExternal(operation, args) {
      const index = externalIndex.get(operation);
      if (index === undefined) return null;
      return `__functions[${index}](${args.map(emitExpression).join(",")})`;
    }

    function emitComputed(operation, args) {
      if (!Object.prototype.hasOwnProperty.call(computed, operation)) return null;
      expectArity(operation, args, 0);
      if (computedStack.includes(operation)) {
        throw new ScriptCompileError(`recursive computed value ${JSON.stringify(operation)}`);
      }
      computedStack.push(operation);
      const code = emitExpression(computed[operation]);
      computedStack.pop();
      return code;
    }

    function emitExpression(node) {
      if (typeof node === "string") return emitInvoke(node, []);
      if (!Array.isArray(node) || node.length === 0) {
        throw new ScriptCompileError("expression must be a non-empty Atom or List");
      }
      if (node.length === 1) {
        throw new ScriptCompileError("a zero-argument invoke must use its Atom form");
      }
      const operation = atom(node[0], "operation");
      return emitInvoke(operation, node.slice(1));
    }

    function binary(operation, args, left, operator, right) {
      expectArity(operation, args, 2);
      return `(${left}(${emitExpression(args[0])},${JSON.stringify(operation)})${operator}${right}(${emitExpression(args[1])},${JSON.stringify(operation)}))`;
    }

    function emitInvoke(operation, args) {
      switch (operation) {
        case "null":
          expectArity(operation, args, 0);
          return "null";
        case "bool.true":
          expectArity(operation, args, 0);
          return "true";
        case "bool.false":
          expectArity(operation, args, 0);
          return "false";
        case "integer.zero":
          expectArity(operation, args, 0);
          return "0n";
        case "float.zero":
          expectArity(operation, args, 0);
          return "0";
        case "integer.const": {
          expectArity(operation, args, 1);
          const value = atom(args[0], "integer.const value");
          if (!/^[+-]?\d+$/.test(value)) throw new ScriptCompileError(`invalid Integer ${JSON.stringify(value)}`);
          return `${BigInt(value)}n`;
        }
        case "float.const": {
          expectArity(operation, args, 1);
          const value = Number(atom(args[0], "float.const value"));
          if (!Number.isFinite(value)) throw new ScriptCompileError("float.const requires a finite number");
          return JSON.stringify(value);
        }
        case "string.const":
          expectArity(operation, args, 1);
          return JSON.stringify(atom(args[0], "string.const value"));
        case "var.get": {
          expectArity(operation, args, 1);
          const name = atom(args[0], "var.get name");
          const slot = slots.get(name);
          if (slot === undefined) throw new ScriptCompileError(`unknown variable ${JSON.stringify(name)}`);
          return `__rt.read(${slot},${JSON.stringify(name)})`;
        }
        case "var.set": {
          expectArity(operation, args, 2);
          const name = atom(args[0], "var.set name");
          const slot = slots.get(name);
          return `(${slot}=${emitExpression(args[1])})`;
        }
        case "case": {
          if (args.length === 0 || args.length % 2 !== 0) {
            throw new ScriptCompileError("case expects condition/body pairs");
          }
          let code = "(()=>{";
          for (let i = 0; i < args.length; i += 2) {
            code += `if(__rt.boolean(${emitExpression(args[i])},\"case\"))return ${emitBody(args[i + 1])};`;
          }
          return `${code}return null;})()`;
        }
        case "for_each": {
          expectArity(operation, args, 4);
          const valueName = atom(args[0], "for_each value binding");
          const indexName = atom(args[1], "for_each index binding");
          const valueSlot = slots.get(valueName);
          const indexSlot = slots.get(indexName);
          const list = temp("list");
          const length = temp("length");
          const index = temp("index");
          const oldValue = temp("old");
          const oldIndex = temp("old");
          return `(()=>{const ${list}=${emitExpression(args[2])};const ${length}=__rt.listLength(${list});const ${oldValue}=${valueSlot};const ${oldIndex}=${indexSlot};try{for(let ${index}=0;${index}<${length};${index}++){${valueSlot}=__rt.listGet(${list},BigInt(${index}));${indexSlot}=BigInt(${index});${emitBody(args[3])};}}finally{${valueSlot}=${oldValue};${indexSlot}=${oldIndex};}return null;})()`;
        }
        case "integer.add":
          return binary(operation, args, "__rt.integer", "+", "__rt.integer");
        case "integer.subtract":
          return binary(operation, args, "__rt.integer", "-", "__rt.integer");
        case "integer.multiply":
          return binary(operation, args, "__rt.integer", "*", "__rt.integer");
        case "integer.min":
        case "integer.max": {
          expectArity(operation, args, 2);
          const left = temp("left");
          const right = temp("right");
          const relation = operation === "integer.min" ? "<=" : ">=";
          return `(()=>{const ${left}=__rt.integer(${emitExpression(args[0])},${JSON.stringify(operation)});const ${right}=__rt.integer(${emitExpression(args[1])},${JSON.stringify(operation)});return ${left}${relation}${right}?${left}:${right};})()`;
        }
        case "integer.divide": {
          expectArity(operation, args, 2);
          const left = temp("left");
          const right = temp("right");
          return `(()=>{const ${left}=__rt.integer(${emitExpression(args[0])},\"integer.divide\");const ${right}=__rt.integer(${emitExpression(args[1])},\"integer.divide\");if(${right}===0n)throw new __RuntimeError(\"integer.divide division by zero\");return ${left}/${right};})()`;
        }
        case "integer.pow": {
          expectArity(operation, args, 2);
          const left = temp("left");
          const right = temp("right");
          return `(()=>{const ${left}=__rt.integer(${emitExpression(args[0])},\"integer.pow\");const ${right}=__rt.integer(${emitExpression(args[1])},\"integer.pow\");if(${right}<0n)throw new __RuntimeError(\"integer.pow requires a non-negative exponent\");return ${left}**${right};})()`;
        }
        case "float.add":
          return `__rt.finiteResult(${binary(operation, args, "__rt.float", "+", "__rt.float")},\"float.add\")`;
        case "float.subtract":
          return `__rt.finiteResult(${binary(operation, args, "__rt.float", "-", "__rt.float")},\"float.subtract\")`;
        case "float.multiply":
          return `__rt.finiteResult(${binary(operation, args, "__rt.float", "*", "__rt.float")},\"float.multiply\")`;
        case "float.min":
        case "float.max": {
          expectArity(operation, args, 2);
          const left = temp("left");
          const right = temp("right");
          const relation = operation === "float.min" ? "<=" : ">=";
          return `(()=>{const ${left}=__rt.float(${emitExpression(args[0])},${JSON.stringify(operation)});const ${right}=__rt.float(${emitExpression(args[1])},${JSON.stringify(operation)});return ${left}${relation}${right}?${left}:${right};})()`;
        }
        case "float.divide": {
          expectArity(operation, args, 2);
          const left = temp("left");
          const right = temp("right");
          return `(()=>{const ${left}=__rt.float(${emitExpression(args[0])},\"float.divide\");const ${right}=__rt.float(${emitExpression(args[1])},\"float.divide\");if(${right}===0)throw new __RuntimeError(\"float.divide division by zero\");return __rt.finiteResult(${left}/${right},\"float.divide\");})()`;
        }
        case "float.pow": {
          expectArity(operation, args, 2);
          return `__rt.finiteResult(Math.pow(__rt.float(${emitExpression(args[0])},\"float.pow\"),__rt.float(${emitExpression(args[1])},\"float.pow\")),\"float.pow\")`;
        }
        case "integer.from": {
          expectArity(operation, args, 1);
          const value = temp("value");
          return `(()=>{const ${value}=${emitExpression(args[0])};if(typeof ${value}===\"bigint\")return ${value};if(typeof ${value}===\"number\"&&Number.isSafeInteger(${value}))return BigInt(${value});if(typeof ${value}===\"string\"&&/^[+-]?\\d+$/.test(${value}))return BigInt(${value});throw new __RuntimeError(\"integer.from cannot convert \"+__rt.typeOf(${value}));})()`;
        }
        case "float.from": {
          expectArity(operation, args, 1);
          const value = temp("value");
          const result = temp("result");
          return `(()=>{const ${value}=${emitExpression(args[0])};const ${result}=typeof ${value}===\"bigint\"?Number(${value}):typeof ${value}===\"string\"?Number(${value}):${value};return __rt.float(${result},\"float.from\");})()`;
        }
        case "string.from": {
          expectArity(operation, args, 1);
          const value = temp("value");
          return `(()=>{const ${value}=${emitExpression(args[0])};if(${value}===null)return \"null\";if([\"bigint\",\"number\",\"string\",\"boolean\"].includes(typeof ${value}))return String(${value});throw new __RuntimeError(\"string.from cannot convert \"+__rt.typeOf(${value}));})()`;
        }
        case "type.of":
          expectArity(operation, args, 1);
          return `__rt.typeOf(${emitExpression(args[0])})`;
        case "cmp.eq":
          expectArity(operation, args, 2);
          return `__rt.equal(${emitExpression(args[0])},${emitExpression(args[1])})`;
        case "cmp.ne":
          expectArity(operation, args, 2);
          return `!__rt.equal(${emitExpression(args[0])},${emitExpression(args[1])})`;
        case "cmp.lt":
        case "cmp.lte":
        case "cmp.gt":
        case "cmp.gte": {
          expectArity(operation, args, 2);
          const relation = { "cmp.lt": "<0", "cmp.lte": "<=0", "cmp.gt": ">0", "cmp.gte": ">=0" }[operation];
          return `(__rt.compare(${emitExpression(args[0])},${emitExpression(args[1])},${JSON.stringify(operation)})${relation})`;
        }
        case "bool.not":
          expectArity(operation, args, 1);
          return `!__rt.boolean(${emitExpression(args[0])},\"bool.not\")`;
        case "bool.and":
          return binary(operation, args, "__rt.boolean", "&&", "__rt.boolean");
        case "bool.or":
          return binary(operation, args, "__rt.boolean", "||", "__rt.boolean");
        case "string.concat":
          expectMinArity(operation, args, 1);
          return `([${args.map((arg) => `__rt.string(${emitExpression(arg)},\"string.concat\")`).join(",")}].join(\"\"))`;
        case "map.new":
          if (args.length % 2 !== 0) throw new ScriptCompileError("map.new expects key/value pairs");
          return `__rt.mapNew([${args.map(emitExpression).join(",")}])`;
        case "map.get":
          expectArity(operation, args, 2);
          return `__rt.mapGet(${emitExpression(args[0])},${emitExpression(args[1])})`;
        case "map.has":
          expectArity(operation, args, 2);
          return `__rt.mapHas(${emitExpression(args[0])},${emitExpression(args[1])})`;
        case "map.set":
          expectArity(operation, args, 3);
          return `(()=>{const _map=(${emitExpression(args[0])});__mutableMap(_map,\"map.set\").set(${emitExpression(args[1])},${emitExpression(args[2])});return _map;})()`;
        case "map.remove":
          expectArity(operation, args, 2);
          return `(()=>{const _map=(${emitExpression(args[0])});__mutableMap(_map,\"map.remove\").delete(${emitExpression(args[1])});return _map;})()`;
        case "list.new":
          return `[${args.map(emitExpression).join(",")}]`;
        case "list.length":
          expectArity(operation, args, 1);
          return `BigInt(__rt.listLength(${emitExpression(args[0])}))`;
        case "list.get":
          expectArity(operation, args, 2);
          return `__rt.listGet(${emitExpression(args[0])},${emitExpression(args[1])})`;
        case "list.set":
          expectArity(operation, args, 3);
          return `(()=>{const _list=__mutableList(${emitExpression(args[0])},\"list.set\");const _index=__indexNumber(${emitExpression(args[1])},\"list.set\");if(_index>=_list.length)throw new __RuntimeError(\"list.set index is out of bounds\");_list[_index]=${emitExpression(args[2])};return _list;})()`;
        case "list.push":
          expectArity(operation, args, 2);
          return `(()=>{const _list=__mutableList(${emitExpression(args[0])},\"list.push\");_list.push(${emitExpression(args[1])});return _list;})()`;
        case "diagnostic.warn":
          expectArity(operation, args, 1);
          return `(__diagnostic({severity:\"warning\",message:__rt.string(${emitExpression(args[0])},\"diagnostic.warn\")}),null)`;
        default: {
          const external = emitExternal(operation, args);
          if (external !== null) return external;
          const computedValue = emitComputed(operation, args);
          if (computedValue !== null) return computedValue;
          throw new ScriptCompileError(`unknown operation ${JSON.stringify(operation)}`);
        }
      }
    }

    const body = emitBody(source);
    const declarations = [...slots.values()].map((slot) => `let ${slot}=__rt.UNSET;`).join("");
    let factory;
    try {
      factory = new Function(
        "__rt",
        "__functions",
        "__diagnostic",
        "__RuntimeError",
        "__mutableMap",
        "__mutableList",
        "__indexNumber",
        `"use strict";return function program(){${declarations}return ${body};};`,
      );
    } catch (error) {
      throw new ScriptCompileError(`failed to lower program: ${error.message}`);
    }
    return factory(runtime, functionNames.map((name) => registered[name]), diagnostics,
      ScriptRuntimeError, mutableMap, mutableList, indexNumber);
  }

  const api = {
    compile,
    ListView,
    MapView,
    ScriptCompileError,
    ScriptRuntimeError,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else exports.Dial9Script = api;
})(typeof exports === "undefined" ? this : exports);
