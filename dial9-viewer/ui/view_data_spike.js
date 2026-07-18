// Throwaway Arquero spike for issue #574. This is deliberately tiny: it lowers
// only the AST nodes used by the context-switch panel hardcoded below.
(function (global) {
  "use strict";

  const PROCESS_RESOURCE_USAGE_EVENT = "ProcessResourceUsageEvent";

  const CONTEXT_SWITCH_AST = {
    language: "dial9-data",
    version: 1,
    inputs: ["usage"],
    computed_fields: [
      {
        source: "usage",
        name: "total_context_switches",
        expr: {
          kind: "call",
          fn: "add",
          args: [
            { kind: "field", name: "voluntary_context_switches" },
            { kind: "field", name: "involuntary_context_switches" },
          ],
        },
      },
    ],
    relations: [
      {
        name: "ordered_usage",
        query: {
          kind: "order",
          input: { kind: "source", name: "usage" },
          by: [{ expr: { kind: "field", name: "timestamp" }, direction: "asc" }],
        },
      },
      {
        name: "with_previous",
        query: {
          kind: "window",
          input: { kind: "relation_ref", name: "ordered_usage" },
          partition_by: [],
          order_by: [{ expr: { kind: "field", name: "timestamp" }, direction: "asc" }],
          columns: [
            { name: "previous_timestamp", fn: "lag", value: { kind: "field", name: "timestamp" } },
            { name: "previous_voluntary", fn: "lag", value: { kind: "field", name: "voluntary_context_switches" } },
            { name: "previous_involuntary", fn: "lag", value: { kind: "field", name: "involuntary_context_switches" } },
          ],
        },
      },
      {
        name: "context_switch_deltas",
        query: {
          kind: "derive",
          input: { kind: "relation_ref", name: "with_previous" },
          columns: [
            {
              name: "start",
              expr: { kind: "field", name: "previous_timestamp" },
            },
            {
              name: "end",
              expr: { kind: "field", name: "timestamp" },
            },
            {
              name: "wall_delta_ns",
              expr: {
                kind: "call", fn: "sub", args: [
                  { kind: "field", name: "timestamp" },
                  { kind: "field", name: "previous_timestamp" },
                ],
              },
            },
            {
              name: "voluntary_delta",
              expr: {
                kind: "call", fn: "sub", args: [
                  { kind: "field", name: "voluntary_context_switches" },
                  { kind: "field", name: "previous_voluntary" },
                ],
              },
            },
            {
              name: "involuntary_delta",
              expr: {
                kind: "call", fn: "sub", args: [
                  { kind: "field", name: "involuntary_context_switches" },
                  { kind: "field", name: "previous_involuntary" },
                ],
              },
            },
          ],
        },
      },
      {
        name: "context_switch_rates",
        query: {
          kind: "derive",
          input: { kind: "relation_ref", name: "context_switch_deltas" },
          columns: [
            {
              name: "valid",
              expr: {
                kind: "call", fn: "and", args: [
                  { kind: "call", fn: "is_not_null", args: [{ kind: "field", name: "previous_timestamp" }] },
                  { kind: "call", fn: "gt", args: [{ kind: "field", name: "wall_delta_ns" }, { kind: "literal", value: 0 }] },
                  { kind: "call", fn: "gte", args: [{ kind: "field", name: "voluntary_delta" }, { kind: "literal", value: 0 }] },
                  { kind: "call", fn: "gte", args: [{ kind: "field", name: "involuntary_delta" }, { kind: "literal", value: 0 }] },
                ],
              },
            },
            {
              name: "voluntary_per_second",
              expr: {
                kind: "call", fn: "mul", args: [
                  {
                    kind: "call", fn: "div", args: [
                      { kind: "field", name: "voluntary_delta" },
                      { kind: "field", name: "wall_delta_ns" },
                    ],
                  },
                  { kind: "literal", value: 1000000000 },
                ],
              },
            },
            {
              name: "involuntary_per_second",
              expr: {
                kind: "call", fn: "mul", args: [
                  {
                    kind: "call", fn: "div", args: [
                      { kind: "field", name: "involuntary_delta" },
                      { kind: "field", name: "wall_delta_ns" },
                    ],
                  },
                  { kind: "literal", value: 1000000000 },
                ],
              },
            },
          ],
        },
      },
      {
        name: "context_switch_rates_valid",
        query: {
          kind: "filter",
          input: { kind: "relation_ref", name: "context_switch_rates" },
          predicate: { kind: "field", name: "valid" },
        },
      },
    ],
    outputs: {
      context_switch_rates: { relation: "context_switch_rates_valid" },
    },
  };

  // A deliberately whimsical proof that the data language is not tied to
  // telemetry-shaped values. `values` is part of the proposed public AST:
  // applications can bundle small static lookup/annotation tables with a view.
  // The viewer receives only ordinary mark tables below.
  const EXPRESSION_ART_AST = {
    language: "dial9-data",
    version: 1,
    inputs: [],
    computed_fields: [],
    relations: [
      {
        name: "dinosaur_source",
        query: {
          kind: "values",
          rows: [
            { part: "tail", left: 0.02, right: 0.12, bottom: 0.37, top: 0.45 },
            { part: "tail", left: 0.10, right: 0.21, bottom: 0.34, top: 0.51 },
            { part: "tail", left: 0.19, right: 0.31, bottom: 0.31, top: 0.56 },
            { part: "body", left: 0.28, right: 0.66, bottom: 0.29, top: 0.63 },
            { part: "spike", left: 0.35, right: 0.41, bottom: 0.62, top: 0.72 },
            { part: "spike", left: 0.43, right: 0.49, bottom: 0.62, top: 0.70 },
            { part: "spike", left: 0.51, right: 0.57, bottom: 0.62, top: 0.69 },
            { part: "neck", left: 0.62, right: 0.73, bottom: 0.39, top: 0.79 },
            { part: "head", left: 0.71, right: 0.88, bottom: 0.58, top: 0.89 },
            { part: "snout", left: 0.86, right: 0.98, bottom: 0.63, top: 0.79 },
            { part: "jaw", left: 0.82, right: 0.94, bottom: 0.54, top: 0.65 },
            { part: "leg", left: 0.38, right: 0.45, bottom: 0.12, top: 0.34 },
            { part: "foot", left: 0.32, right: 0.46, bottom: 0.07, top: 0.17 },
            { part: "leg", left: 0.54, right: 0.61, bottom: 0.11, top: 0.33 },
            { part: "foot", left: 0.53, right: 0.67, bottom: 0.07, top: 0.16 },
            { part: "leg", left: 0.70, right: 0.76, bottom: 0.11, top: 0.42 },
            { part: "foot", left: 0.70, right: 0.84, bottom: 0.07, top: 0.16 },
          ],
        },
      },
      {
        name: "dinosaur_bands",
        query: {
          kind: "derive",
          input: { kind: "relation_ref", name: "dinosaur_source" },
          columns: [
            { name: "x0", expr: { kind: "field", name: "left" } },
            { name: "x1", expr: { kind: "field", name: "right" } },
            { name: "y0", expr: { kind: "field", name: "bottom" } },
            { name: "y1", expr: { kind: "field", name: "top" } },
            {
              name: "color",
              expr: {
                kind: "case",
                branches: [{
                  when: {
                    kind: "call", fn: "eq", args: [
                      { kind: "field", name: "part" },
                      { kind: "literal", value: "spike" },
                    ],
                  },
                  then: { kind: "literal", value: "#66bb6a" },
                }],
                else: { kind: "literal", value: "#43a047" },
              },
            },
          ],
        },
      },
      {
        name: "heart_source",
        query: {
          kind: "values",
          rows: [
            { x: 0.50, y: 0.10 }, { x: 0.44, y: 0.18 },
            { x: 0.36, y: 0.29 }, { x: 0.27, y: 0.42 },
            { x: 0.17, y: 0.57 }, { x: 0.12, y: 0.69 },
            { x: 0.13, y: 0.81 }, { x: 0.20, y: 0.92 },
            { x: 0.30, y: 0.98 }, { x: 0.40, y: 0.96 },
            { x: 0.47, y: 0.88 }, { x: 0.50, y: 0.77 },
            { x: 0.53, y: 0.88 }, { x: 0.60, y: 0.96 },
            { x: 0.70, y: 0.98 }, { x: 0.80, y: 0.92 },
            { x: 0.87, y: 0.81 }, { x: 0.88, y: 0.69 },
            { x: 0.83, y: 0.57 }, { x: 0.73, y: 0.42 },
            { x: 0.64, y: 0.29 }, { x: 0.56, y: 0.18 },
            { x: 0.50, y: 0.10 },
          ],
        },
      },
      {
        name: "heart_line",
        query: {
          kind: "derive",
          input: { kind: "relation_ref", name: "heart_source" },
          columns: [
            { name: "plot_x", expr: { kind: "field", name: "x" } },
            { name: "plot_y", expr: { kind: "field", name: "y" } },
            { name: "color", expr: { kind: "literal", value: "#ff5c77" } },
          ],
        },
      },
    ],
    outputs: {
      dinosaur_bands: { relation: "dinosaur_bands" },
      heart_line: { relation: "heart_line" },
    },
  };

  function exprToArquero(expr) {
    if (expr.kind === "literal") return JSON.stringify(expr.value);
    if (expr.kind === "field") return `d[${JSON.stringify(expr.name)}]`;
    if (expr.kind === "case") {
      let source = expr.else ? exprToArquero(expr.else) : "null";
      for (let i = expr.branches.length - 1; i >= 0; i--) {
        const branch = expr.branches[i];
        source = `(${exprToArquero(branch.when)} ? ${exprToArquero(branch.then)} : ${source})`;
      }
      return source;
    }
    if (expr.kind !== "call") throw new Error(`unsupported expression ${expr.kind}`);

    const args = expr.args.map(exprToArquero);
    const binary = {
      add: "+", sub: "-", mul: "*", div: "/", eq: "===", ne: "!==",
      gt: ">", gte: ">=", lt: "<", lte: "<=", and: "&&", or: "||",
    };
    if (binary[expr.fn]) return `(${args.join(` ${binary[expr.fn]} `)})`;
    if (expr.fn === "is_not_null") return `(${args[0]} != null)`;
    if (expr.fn === "is_null") return `(${args[0]} == null)`;
    throw new Error(`unsupported function ${expr.fn}`);
  }

  function orderKeys(by) {
    return by.map((key) => {
      if (key.expr.kind !== "field") throw new Error("spike only orders fields");
      return key.direction === "desc" ? global.aq.desc(key.expr.name) : key.expr.name;
    });
  }

  function lowerProgram(program, tables) {
    if (!global.aq) throw new Error("Arquero CDN did not load");
    const named = new Map();
    const computedBySource = new Map();
    for (const field of program.computed_fields || []) {
      const fields = computedBySource.get(field.source) || [];
      fields.push(field);
      computedBySource.set(field.source, fields);
    }

    function lower(query) {
      if (query.kind === "source") {
        let table = global.aq.from(tables[query.name] || []);
        const fields = computedBySource.get(query.name) || [];
        if (fields.length) {
          table = table.derive(Object.fromEntries(fields.map((field) => [
            field.name,
            `d => ${exprToArquero(field.expr)}`,
          ])));
        }
        return table;
      }
      if (query.kind === "values") return global.aq.from(query.rows || []);
      if (query.kind === "relation_ref") return named.get(query.name);
      if (query.kind === "order") return lower(query.input).orderby(...orderKeys(query.by));
      if (query.kind === "derive") {
        return lower(query.input).derive(Object.fromEntries(query.columns.map((column) => [
          column.name,
          `d => ${exprToArquero(column.expr)}`,
        ])));
      }
      if (query.kind === "filter") {
        return lower(query.input).filter(`d => ${exprToArquero(query.predicate)}`);
      }
      if (query.kind === "window") {
        let table = lower(query.input).orderby(...orderKeys(query.order_by));
        const columns = {};
        for (const column of query.columns) {
          if (column.fn !== "lag") throw new Error(`unsupported window ${column.fn}`);
          columns[column.name] = `d => op.lag(${exprToArquero(column.value)})`;
        }
        return table.derive(columns);
      }
      throw new Error(`unsupported relation ${query.kind}`);
    }

    for (const relation of program.relations) named.set(relation.name, lower(relation.query));
    const outputs = {};
    for (const [name, output] of Object.entries(program.outputs)) {
      outputs[name] = named.get(output.relation).objects();
    }
    return outputs;
  }

  function usageRows(customEvents) {
    return (customEvents || [])
      .filter((event) => event.name === PROCESS_RESOURCE_USAGE_EVENT)
      .map((event) => ({
        timestamp: Number(event.timestamp),
        voluntary_context_switches: Number(event.fields?.voluntary_context_switches),
        involuntary_context_switches: Number(event.fields?.involuntary_context_switches),
      }))
      .filter((row) => Object.values(row).every(Number.isFinite));
  }

  function runContextSwitchSpike(customEvents) {
    const rows = usageRows(customEvents);
    const outputs = lowerProgram(CONTEXT_SWITCH_AST, { usage: rows });
    return { ast: CONTEXT_SWITCH_AST, inputRows: rows.length, rows: outputs.context_switch_rates };
  }

  function runExpressionArtSpike() {
    const outputs = lowerProgram(EXPRESSION_ART_AST, {});
    return {
      ast: EXPRESSION_ART_AST,
      dinosaurBands: outputs.dinosaur_bands,
      heartLine: outputs.heart_line,
    };
  }

  global.ViewDataSpike = {
    CONTEXT_SWITCH_AST,
    EXPRESSION_ART_AST,
    runContextSwitchSpike,
    runExpressionArtSpike,
  };
})(typeof window !== "undefined" ? window : globalThis);
