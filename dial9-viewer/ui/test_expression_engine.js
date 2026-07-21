#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  compile,
  CompileError,
  ListView,
  MapView,
} = require("./expression_engine.js");

function testTypedMathAndConversions() {
  const result = compile([
    ["var.set", "integer", ["integer.pow", ["integer.const", "3"], ["integer.const", "4"]]],
    ["var.set", "quotient", ["integer.divide", ["var.get", "integer"], ["integer.const", "10"]]],
    ["var.set", "float", ["float.pow", ["float.const", "2.5"], ["float.const", "2"]]],
    [
      "map.new",
      ["string.const", "integer"], ["var.get", "integer"],
      ["string.const", "quotient"], ["var.get", "quotient"],
      ["string.const", "float"], ["var.get", "float"],
      ["string.const", "type"], ["type.of", ["var.get", "integer"]]
    ]
  ])();
  assert.strictEqual(result.get("integer"), 81n);
  assert.strictEqual(result.get("quotient"), 8n);
  assert.strictEqual(result.get("float"), 6.25);
  assert.strictEqual(result.get("type"), "integer");
}

function testViewsLoopComputedValuesAndEagerFunctions() {
  const values = [2n, 4n, 7n];
  const list = new ListView(values.length, (index) => values[index]);
  const metadata = new MapView(
    (key) => key === "minimum" ? 3n : undefined,
    (key) => key === "minimum",
  );
  const calls = [];
  const bundle = {
    computed_values: {
      doubled: {
        expression: ["integer.multiply", ["var.get", "item"], ["integer.const", "2"]],
      },
    },
    script: [
      ["var.set", "sum", "integer.zero"],
      [
        "for_each",
        "item",
        "index",
        "test.values",
        [
          "case",
          ["cmp.gte", ["var.get", "item"], ["map.get", "test.metadata", ["string.const", "minimum"]]],
          ["var.set", "sum", ["integer.add", ["var.get", "sum"], "computed.doubled"]],
          "bool.true",
          "null"
        ]
      ],
      ["test.capture", ["var.get", "sum"]]
    ],
  };
  const program = compile(bundle, {
    functions: {
      "test.values": () => list,
      "test.metadata": () => metadata,
      "test.capture": (value) => { calls.push(value); return value; },
    },
  });
  assert.strictEqual(program(), 22n);
  assert.deepStrictEqual(calls, [22n]);
  assert.match(program.source, /function program/);
}

function testMutableCollectionsAndDiagnostics() {
  const warnings = [];
  const result = compile([
    ["var.set", "map", "map.new"],
    ["map.set", ["var.get", "map"], ["string.const", "answer"], ["integer.const", "42"]],
    ["var.set", "list", ["list.new", ["string.const", "a"]]],
    ["list.push", ["var.get", "list"], ["string.const", "b"]],
    ["list.set", ["var.get", "list"], ["integer.const", "0"], ["string.const", "A"]],
    ["diagnostic.warn", ["string.const", "demonstration warning"]],
    [
      "map.new",
      ["string.const", "answer"], ["map.get", ["var.get", "map"], ["string.const", "answer"]],
      ["string.const", "has"], ["map.has", ["var.get", "map"], ["string.const", "answer"]],
      ["string.const", "first"], ["list.get", ["var.get", "list"], "integer.zero"],
      ["string.const", "length"], ["list.length", ["var.get", "list"]]
    ]
  ], { onWarning: (warning) => warnings.push(warning) })();
  assert.strictEqual(result.get("answer"), 42n);
  assert.strictEqual(result.get("has"), true);
  assert.strictEqual(result.get("first"), "A");
  assert.strictEqual(result.get("length"), 2n);
  assert.deepStrictEqual(warnings, ["demonstration warning"]);
}

function testValidationAndRuntimeErrors() {
  assert.throws(() => compile(["bool.true"]), CompileError);
  assert.throws(() => compile("missing.operation"), CompileError);
  assert.throws(
    () => compile(["integer.divide", ["integer.const", "1"], "integer.zero"])(),
    /division by zero/,
  );
  assert.throws(
    () => compile(["float.add", ["float.const", "1"], ["integer.const", "2"]])(),
    /cannot convert|float/,
  );
}

testTypedMathAndConversions();
testViewsLoopComputedValuesAndEagerFunctions();
testMutableCollectionsAndDiagnostics();
testValidationAndRuntimeErrors();
console.log("expression engine tests passed");
