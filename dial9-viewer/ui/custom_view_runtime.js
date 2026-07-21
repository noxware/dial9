// custom_view_runtime.js - Dial9 adapter and validation bundles for ScriptEngine.
// Data computation lives here; canvas rendering lives in custom_view_panels.js.

(function (exports) {
  "use strict";

  function getEngine() {
    if (typeof require !== "undefined") return require("./script_engine.js");
    if (typeof Dial9Script !== "undefined") return Dial9Script;
    throw new Error("Dial9Script not found; load script_engine.js first");
  }

  const { compile, ListView, MapView } = getEngine();
  const RESOURCE_EVENT = "ProcessResourceUsageEvent";
  const RESOURCE_INTEGER_FIELDS = new Set([
    "user_cpu_ns",
    "system_cpu_ns",
    "max_rss_bytes",
    "minor_faults",
    "major_faults",
    "block_input_ops",
    "block_output_ops",
    "voluntary_context_switches",
    "involuntary_context_switches",
  ]);

  const s = (value) => ["string.const", String(value)];
  const i = (value) => ["integer.const", String(value)];
  const f = (value) => ["float.const", String(value)];
  const get = (name) => ["var.get", name];
  const set = (name, value) => ["var.set", name, value];
  const field = (name, event) => ["map.get", event || get("event"), s(name)];
  const record = (entries) => ["map.new", ...entries.flatMap(([key, value]) => [s(key), value])];

  function asInteger(value, fieldName) {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
    if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
    throw new TypeError(`${fieldName} is not an exact integer`);
  }

  function eventView(event) {
    const getValue = (key) => {
      if (key === "kind") return event.name;
      if (key === "time") return asInteger(event.timestamp, "event.time");
      const value = event.fields ? event.fields[key] : undefined;
      if (event.name === RESOURCE_EVENT && RESOURCE_INTEGER_FIELDS.has(key) && value != null) {
        return asInteger(value, `${event.name}.${key}`);
      }
      return value;
    };
    const hasValue = (key) => key === "kind" || key === "time" ||
      (event.fields != null && Object.prototype.hasOwnProperty.call(event.fields, key));
    return new MapView(getValue, hasValue);
  }

  function traceEventsView(trace) {
    const events = [...(trace && trace.customEvents ? trace.customEvents : [])]
      .sort((left, right) => left.timestamp - right.timestamp);
    const views = new Array(events.length);
    return new ListView(events.length, (index) => views[index] || (views[index] = eventView(events[index])));
  }

  function readonlyMapView(map) {
    const source = map || new Map();
    return new MapView((key) => source.get(key), (key) => source.has(key));
  }

  function rowsView(handle) {
    return new ListView(handle.rows.length, (index) => handle.rows[index]);
  }

  function compileBundle(bundle, host) {
    const handles = new Map();
    for (const name of Object.keys(bundle.outputs || {})) handles.set(name, { name, rows: [] });
    const diagnostics = [];
    const runtimeHost = host || {};
    let events = new ListView(0, () => undefined);
    let metadata = readonlyMapView(new Map());
    let pointer = null;

    const functions = {
      "dial9.events": () => events,
      "dial9.metadata": () => metadata,
      "dial9.viewport": () => {
        const viewport = runtimeHost.viewport ? runtimeHost.viewport() : { start: 0, end: 0 };
        return new MapView(
          (key) => key === "start" ? asInteger(viewport.start, "viewport.start")
            : key === "end" ? asInteger(viewport.end, "viewport.end") : undefined,
          (key) => key === "start" || key === "end",
        );
      },
      "dial9.pointer": () => pointer,
      "dial9.output.emit": (handle, value) => {
        if (!handle || !handles.has(handle.name) || handles.get(handle.name) !== handle) {
          throw new TypeError("dial9.output.emit received an unknown output");
        }
        handle.rows.push(value);
        return value;
      },
      "dial9.output.rows": (handle) => rowsView(handle),
    };
    for (const [name, handle] of handles) functions[name] = () => handle;
    Object.assign(functions, runtimeHost.functions || {});

    const computed = {};
    for (const [name, definition] of Object.entries(bundle.computed_values || {})) {
      computed[`computed.${name}`] = definition.expression;
    }
    const onDiagnostic = (diagnostic) => diagnostics.push(diagnostic);
    const traceProgram = compile(bundle.script, { functions, computed, onDiagnostic });
    const dynamicPrograms = new Map();
    for (const definition of bundle.dynamic || []) {
      const program = compile(definition.script, { functions, computed, onDiagnostic });
      dynamicPrograms.set(definition.id, { ...definition, program });
    }

    function clearOutputs(names) {
      for (const name of names) {
        const handle = handles.get(name);
        if (!handle) throw new Error(`unknown bundle output ${JSON.stringify(name)}`);
        handle.rows.length = 0;
      }
    }

    return {
      id: bundle.id,
      bundle,
      diagnostics,
      loadTrace(trace) {
        events = traceEventsView(trace);
        metadata = readonlyMapView(trace && trace.segmentMetadata);
        diagnostics.length = 0;
        clearOutputs(Object.keys(bundle.outputs || {}));
        traceProgram();
      },
      runDynamic(id) {
        const definition = dynamicPrograms.get(id);
        if (!definition) throw new Error(`unknown dynamic program ${JSON.stringify(id)}`);
        clearOutputs(definition.outputs);
        definition.program();
      },
      setPointer(value) {
        pointer = value == null ? null : readonlyMapView(value);
      },
      rows(name) {
        const handle = handles.get(name);
        if (!handle) throw new Error(`unknown bundle output ${JSON.stringify(name)}`);
        return handle.rows;
      },
      reset() {
        events = new ListView(0, () => undefined);
        metadata = readonlyMapView(new Map());
        pointer = null;
        diagnostics.length = 0;
        clearOutputs([...handles.keys()]);
      },
    };
  }

  function invalidDeltaCondition() {
    return [
      "bool.or",
      ["cmp.lte", get("wall_delta"), "integer.zero"],
      [
        "bool.or",
        ["cmp.lt", get("user_delta"), "integer.zero"],
        ["cmp.lt", get("system_delta"), "integer.zero"],
      ],
    ];
  }

  function resourceBundle() {
    const capacity = "process.available_parallelism";
    return {
      id: "process-resource",
      version: 1,
      computed_values: {
        cpu_time: {
          unit: "ns",
          expression: ["integer.add", field("user_cpu_ns"), field("system_cpu_ns")],
        },
      },
      outputs: {
        cpu_intervals: {},
        cpu_guides: {},
        cpu_summary: {},
        context_intervals: {},
      },
      script: [
        set("has_previous", "bool.false"),
        set("metadata", "dial9.metadata"),
        [
          "case",
          ["map.has", get("metadata"), s(capacity)],
          [
            "dial9.output.emit",
            "cpu_guides",
            record([
              ["value", ["float.from", ["map.get", get("metadata"), s(capacity)]]],
              ["label", s("available parallelism")],
            ]),
          ],
          "bool.true",
          "null",
        ],
        [
          "for_each", "event", "index", "dial9.events",
          [
            "case",
            ["cmp.eq", field("kind"), s(RESOURCE_EVENT)],
            [
              set("current_time", field("time")),
              set("current_user", field("user_cpu_ns")),
              set("current_system", field("system_cpu_ns")),
              set("current_cpu", "computed.cpu_time"),
              set("current_has_context", [
                "bool.and",
                ["map.has", get("event"), s("voluntary_context_switches")],
                ["map.has", get("event"), s("involuntary_context_switches")],
              ]),
              [
                "case", get("current_has_context"),
                [
                  set("current_voluntary", field("voluntary_context_switches")),
                  set("current_involuntary", field("involuntary_context_switches")),
                ],
                "bool.true", "null",
              ],
              [
                "case", get("has_previous"),
                [
                  set("wall_delta", ["integer.subtract", get("current_time"), get("previous_time")]),
                  set("user_delta", ["integer.subtract", get("current_user"), get("previous_user")]),
                  set("system_delta", ["integer.subtract", get("current_system"), get("previous_system")]),
                  set("cpu_delta", ["integer.subtract", get("current_cpu"), get("previous_cpu")]),
                  [
                    "case",
                    invalidDeltaCondition(),
                    ["diagnostic.warn", s("CPU counter decreased or time did not advance")],
                    "bool.true",
                    [
                      "dial9.output.emit", "cpu_intervals",
                      record([
                        ["start", get("previous_time")],
                        ["end", get("current_time")],
                        ["wall_delta", get("wall_delta")],
                        ["cpu_delta", get("cpu_delta")],
                        ["cores", ["float.divide", ["float.from", get("cpu_delta")], ["float.from", get("wall_delta")]]],
                      ]),
                    ],
                  ],
                  [
                    "case",
                    ["bool.and", get("current_has_context"), get("previous_has_context")],
                    [
                      set("voluntary_delta", ["integer.subtract", get("current_voluntary"), get("previous_voluntary")]),
                      set("involuntary_delta", ["integer.subtract", get("current_involuntary"), get("previous_involuntary")]),
                      [
                        "case",
                        [
                          "bool.or",
                          ["cmp.lte", get("wall_delta"), "integer.zero"],
                          [
                            "bool.or",
                            ["cmp.lt", get("voluntary_delta"), "integer.zero"],
                            ["cmp.lt", get("involuntary_delta"), "integer.zero"],
                          ],
                        ],
                        ["diagnostic.warn", s("context switch counter decreased or time did not advance")],
                        "bool.true",
                        [
                          "dial9.output.emit", "context_intervals",
                          record([
                            ["start", get("previous_time")],
                            ["end", get("current_time")],
                            ["voluntary_delta", get("voluntary_delta")],
                            ["involuntary_delta", get("involuntary_delta")],
                            ["voluntary_rate", ["float.divide", ["float.multiply", ["float.from", get("voluntary_delta")], f(1e9)], ["float.from", get("wall_delta")]]],
                            ["involuntary_rate", ["float.divide", ["float.multiply", ["float.from", get("involuntary_delta")], f(1e9)], ["float.from", get("wall_delta")]]],
                          ]),
                        ],
                      ],
                    ],
                    "bool.true", "null",
                  ],
                ],
                "bool.true", "null",
              ],
              set("previous_time", get("current_time")),
              set("previous_user", get("current_user")),
              set("previous_system", get("current_system")),
              set("previous_cpu", get("current_cpu")),
              [
                "case", get("current_has_context"),
                [
                  set("previous_voluntary", get("current_voluntary")),
                  set("previous_involuntary", get("current_involuntary")),
                ],
                "bool.true", "null",
              ],
              set("previous_has_context", get("current_has_context")),
              set("has_previous", "bool.true"),
            ],
            "bool.true", "null",
          ],
        ],
      ],
      dynamic: [
        {
          id: "cpu-visible-summary",
          outputs: ["cpu_summary"],
          script: [
            set("total_overlap", "integer.zero"),
            set("weighted_cores", "float.zero"),
            set("max_cores", "float.zero"),
            set("viewport", "dial9.viewport"),
            set("view_start", ["map.get", get("viewport"), s("start")]),
            set("view_end", ["map.get", get("viewport"), s("end")]),
            [
              "for_each", "interval", "index", ["dial9.output.rows", "cpu_intervals"],
              [
                set("overlap_start", ["integer.max", field("start", get("interval")), get("view_start")]),
                set("overlap_end", ["integer.min", field("end", get("interval")), get("view_end")]),
                set("overlap", ["integer.subtract", get("overlap_end"), get("overlap_start")]),
                [
                  "case",
                  ["cmp.gt", get("overlap"), "integer.zero"],
                  [
                    set("total_overlap", ["integer.add", get("total_overlap"), get("overlap")]),
                    set("weighted_cores", [
                      "float.add", get("weighted_cores"),
                      ["float.multiply", field("cores", get("interval")), ["float.from", get("overlap")]],
                    ]),
                    set("max_cores", ["float.max", get("max_cores"), field("cores", get("interval"))]),
                  ],
                  "bool.true", "null",
                ],
              ],
            ],
            [
              "dial9.output.emit", "cpu_summary",
              record([
                ["avg", [
                  "case", ["cmp.gt", get("total_overlap"), "integer.zero"],
                  ["float.divide", get("weighted_cores"), ["float.from", get("total_overlap")]],
                  "bool.true", "float.zero",
                ]],
                ["max", get("max_cores")],
              ]),
            ],
          ],
        },
      ],
      panels: [
        {
          id: "cpu",
          title: "CPU Usage",
          height: 92,
          x: { type: "time" },
          y: { includeZero: true },
          dynamic: ["cpu-visible-summary"],
          legend: [
            { label: "CPU cores", color: "#4fc3f7" },
            { label: "Capacity", color: "#ffcf99", data: "cpu_guides" },
          ],
          summary: {
            data: "cpu_summary",
            fields: [
              { label: "avg", field: "avg", format: "cores" },
              { label: "max", field: "max", format: "cores" },
            ],
          },
          layers: [
            {
              renderer: "interval-area",
              data: "cpu_intervals",
              channels: { start: "start", end: "end", y: "cores" },
              style: { color: "#4fc3f7", fillAlpha: 0.35 },
              tooltip: [
                { label: "Window", field: "wall_delta", format: "duration" },
                { label: "CPU time", field: "cpu_delta", format: "duration" },
                { label: "Cores", field: "cores", format: "cores" },
              ],
            },
            {
              renderer: "horizontal-rule",
              data: "cpu_guides",
              channels: { y: "value", label: "label" },
              style: { color: "#ffcf99", dash: [4, 3] },
            },
          ],
        },
        {
          id: "context-switch-steps",
          title: "Context Switches · Steps",
          height: 92,
          x: { type: "time" },
          y: { includeZero: true },
          legend: [
            { label: "Voluntary/s", color: "#81c784" },
            { label: "Involuntary/s", color: "#ff8a65" },
          ],
          layers: [
            {
              renderer: "interval-area", data: "context_intervals",
              channels: { start: "start", end: "end", y: "voluntary_rate" },
              style: { color: "#81c784", fillAlpha: 0.18 },
              tooltip: [
                { label: "Voluntary", field: "voluntary_delta", format: "integer" },
                { label: "Rate", field: "voluntary_rate", format: "rate" },
              ],
            },
            {
              renderer: "interval-line", data: "context_intervals",
              channels: { start: "start", end: "end", y: "involuntary_rate" },
              style: { color: "#ff8a65" },
              tooltip: [
                { label: "Involuntary", field: "involuntary_delta", format: "integer" },
                { label: "Rate", field: "involuntary_rate", format: "rate" },
              ],
            },
          ],
        },
        {
          id: "context-switch-spikes",
          title: "Context Switches · Spikes",
          height: 92,
          x: { type: "time" },
          y: { includeZero: true },
          legend: [
            { label: "Voluntary/s", color: "#81c784" },
            { label: "Involuntary/s", color: "#ff8a65" },
          ],
          layers: [
            {
              renderer: "line", data: "context_intervals",
              channels: { x: "end", y: "voluntary_rate" },
              style: { color: "#81c784" },
              tooltip: [
                { label: "Voluntary", field: "voluntary_delta", format: "integer" },
                { label: "Rate", field: "voluntary_rate", format: "rate" },
              ],
            },
            {
              renderer: "line", data: "context_intervals",
              channels: { x: "end", y: "involuntary_rate" },
              style: { color: "#ff8a65" },
              tooltip: [
                { label: "Involuntary", field: "involuntary_delta", format: "integer" },
                { label: "Rate", field: "involuntary_rate", format: "rate" },
              ],
            },
          ],
        },
      ],
    };
  }

  function dinoBundle() {
    const points = [
      [4, 28, "tail", "💩"], [10, 34, "tail", "💩"], [16, 40, "tail", "💩"],
      [22, 40, "body", ""], [22, 62, "body", ""], [32, 62, "body", ""],
      [32, 72, "body", ""], [48, 72, "body", ""], [48, 64, "body", ""],
      [58, 64, "neck", ""], [58, 76, "head", "❤️"], [72, 76, "head", "❤️"],
      [72, 64, "head", "❤️"], [64, 64, "head", "❤️"], [64, 48, "body", ""],
      [54, 48, "body", ""], [54, 30, "leg", ""], [46, 30, "leg", ""],
      [46, 48, "body", ""], [32, 48, "body", ""], [32, 28, "leg", ""],
      [24, 28, "leg", ""], [24, 48, "body", ""], [16, 40, "tail", "💩"],
    ];
    const emits = points.map(([x, y, part, tooltip]) => [
      "dial9.output.emit", "dino_points",
      record([["x", f(x)], ["y", f(y)], ["part", s(part)], ["tooltip", s(tooltip)]]),
    ]);
    return {
      id: "green-dinosaur",
      version: 1,
      computed_values: {},
      outputs: { dino_points: {}, dino_labels: {} },
      script: [
        ...emits,
        ["dial9.output.emit", "dino_labels", record([["x", f(77)], ["y", f(72)], ["text", s("🔥🔥🔥")], ["tooltip", s("hot breath")]])],
      ],
      panels: [
        {
          id: "dinosaur",
          title: "A Completely Reasonable Dinosaur",
          height: 150,
          x: { type: "linear", domain: [0, 100] },
          y: { domain: [0, 100], includeZero: true },
          legend: [{ label: "Definitely production data", color: "#66bb6a" }],
          layers: [
            {
              renderer: "step-line", data: "dino_points",
              channels: { x: "x", y: "y" },
              style: { color: "#66bb6a", width: 8, fill: "rgba(102,187,106,0.15)" },
              tooltip: [{ label: "", field: "tooltip", format: "text", omitEmpty: true }],
            },
            {
              renderer: "text", data: "dino_labels",
              channels: { x: "x", y: "y", text: "text" },
              style: { font: "20px sans-serif" },
              tooltip: [{ label: "", field: "tooltip", format: "text" }],
            },
          ],
        },
      ],
    };
  }

  const api = {
    compileBundle,
    eventView,
    traceEventsView,
    resourceBundle,
    dinoBundle,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else exports.Dial9CustomViewRuntime = api;
})(typeof exports === "undefined" ? this : exports);
