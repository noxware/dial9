(function (root, factory) {
  const engine = typeof module === "object" && module.exports
    ? require("./expression_engine.js")
    : root.Dial9Script;
  const api = factory(engine);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.Dial9CustomViews = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Dial9Script) {
  "use strict";

  if (!Dial9Script) throw new Error("custom_view_demo.js requires expression_engine.js");

  const { compile, ListView, MapView } = Dial9Script;
  const RESOURCE_USAGE = "ProcessResourceUsageEvent";

  const string = (value) => ["string.const", value];
  const variable = (name) => ["var.get", name];
  const field = (name) => ["map.get", variable("event"), string(name)];
  const integerField = (name) => ["integer.from", field(name)];
  const floatField = (name) => ["float.from", field(name)];

  const CPU_BUNDLE = {
    version: 1,
    computed_values: {
      cpu_time: {
        unit: "ns",
        expression: ["integer.add", integerField("user_cpu_ns"), integerField("system_cpu_ns")],
      },
    },
    outputs: {
      cpu_intervals: {
        units: { start: "ns", end: "ns", wall_delta: "ns", cpu_delta: "ns", cores: "cores" },
      },
    },
    script: [
      ["var.set", "has_previous", "bool.false"],
      [
        "for_each",
        "event",
        "index",
        "dial9.events",
        [
          "case",
          ["cmp.eq", field("kind"), string(RESOURCE_USAGE)],
          [
            ["var.set", "current_time", integerField("time")],
            ["var.set", "current_cpu_time", "computed.cpu_time"],
            [
              "case",
              variable("has_previous"),
              [
                ["var.set", "wall_delta", ["integer.subtract", variable("current_time"), variable("previous_time")]],
                ["var.set", "cpu_delta", ["integer.subtract", variable("current_cpu_time"), variable("previous_cpu_time")]],
                [
                  "case",
                  ["cmp.lte", variable("wall_delta"), "integer.zero"],
                  "null",
                  ["cmp.lt", variable("cpu_delta"), "integer.zero"],
                  ["diagnostic.warn", string("CPU counter decreased")],
                  "bool.true",
                  [
                    "dial9.output.emit",
                    "cpu_intervals",
                    [
                      "map.new",
                      string("start"), variable("previous_time"),
                      string("end"), variable("current_time"),
                      string("wall_delta"), variable("wall_delta"),
                      string("cpu_delta"), variable("cpu_delta"),
                      string("cores"), [
                        "float.divide",
                        ["float.from", variable("cpu_delta")],
                        ["float.from", variable("wall_delta")],
                      ],
                    ],
                  ],
                ],
              ],
              "bool.true",
              "null",
            ],
            ["var.set", "previous_time", variable("current_time")],
            ["var.set", "previous_cpu_time", variable("current_cpu_time")],
            ["var.set", "has_previous", "bool.true"],
          ],
          "bool.true",
          "null",
        ],
      ],
    ],
  };

  const CONTEXT_SWITCH_BUNDLE = {
    version: 1,
    computed_values: {},
    outputs: {
      context_switch_points: {
        units: { time: "ns", voluntary: "switches", involuntary: "switches" },
      },
    },
    script: [
      "for_each",
      "event",
      "index",
      "dial9.events",
      [
        "case",
        ["cmp.eq", field("kind"), string(RESOURCE_USAGE)],
        [
          "dial9.output.emit",
          "context_switch_points",
          [
            "map.new",
            string("time"), integerField("time"),
            string("voluntary"), floatField("voluntary_context_switches"),
            string("involuntary"), floatField("involuntary_context_switches"),
          ],
        ],
        "bool.true",
        "null",
      ],
    ],
  };

  const DINO_BODY = [
    [10, 3.0, "tail", "💩"], [18, 4.0, "tail", "💩"], [28, 5.8, "back", ""],
    [40, 7.0, "back", ""], [52, 6.8, "neck", ""], [59, 7.8, "head", "❤️"],
    [66, 8.4, "head", "❤️"], [76, 8.2, "head", "❤️"], [78, 7.0, "head", "❤️"],
    [69, 6.7, "head", "❤️"], [63, 5.4, "chest", ""], [68, 4.8, "arm", ""],
    [62, 5.1, "chest", ""], [56, 3.8, "belly", ""], [56, 1.2, "leg", ""],
    [50, 1.2, "foot", ""], [48, 3.5, "belly", ""], [38, 3.6, "belly", ""],
    [38, 1.1, "leg", ""], [32, 1.1, "foot", ""], [34, 4.1, "belly", ""],
    [25, 4.4, "tail", "💩"], [10, 3.0, "tail", "💩"],
  ];
  const DINO_FLAMES = [
    [78, 7.6, "flame", "🔥"], [84, 8.5, "flame", "🔥"], [82, 7.5, "flame", "🔥"],
    [90, 7.8, "flame", "🔥"], [84, 6.8, "flame", "🔥"], [78, 7.2, "flame", "🔥"],
  ];

  function dinoTime(percent) {
    return [
      "float.add",
      "dial9.trace.start",
      [
        "float.multiply",
        ["float.subtract", "dial9.trace.end", "dial9.trace.start"],
        ["float.const", String(percent / 100)],
      ],
    ];
  }

  function dinoEmit(output, point) {
    return [
      "dial9.output.emit",
      output,
      [
        "map.new",
        string("time"), dinoTime(point[0]),
        string("value"), ["float.const", String(point[1])],
        string("part"), string(point[2]),
        string("tooltip"), string(point[3]),
      ],
    ];
  }

  const DINO_BUNDLE = {
    version: 1,
    computed_values: {},
    outputs: { dino_points: {}, dino_flames: {} },
    script: [
      ...DINO_BODY.map((point) => dinoEmit("dino_points", point)),
      ...DINO_FLAMES.map((point) => dinoEmit("dino_flames", point)),
    ],
  };

  const PANEL_SPECS = Object.freeze([
    {
      id: "custom-cpu",
      elementId: "custom-cpu-panel",
      title: "Custom · CPU Usage",
      height: 104,
      yMin: 0,
      summary: "cpu",
      layers: [
        {
          renderer: "interval-area",
          output: "cpu_intervals",
          label: "CPU cores",
          color: "#4fc3f7",
          channels: { start: "start", end: "end", value: "cores" },
          tooltip: [
            { label: "Window", field: "wall_delta", format: "duration" },
            { label: "CPU time", field: "cpu_delta", format: "duration" },
            { label: "Cores", field: "cores", format: "decimal" },
          ],
        },
      ],
    },
    {
      id: "custom-context",
      elementId: "custom-context-panel",
      title: "Custom · Context Switches (Cumulative)",
      height: 112,
      yMin: 0,
      summary: "context",
      layers: [
        {
          renderer: "line",
          output: "context_switch_points",
          label: "Voluntary",
          color: "#81c784",
          channels: { time: "time", value: "voluntary" },
          tooltip: [
            { label: "Voluntary", field: "voluntary", format: "integer" },
            { label: "Time", field: "time", format: "time" },
          ],
        },
        {
          renderer: "line",
          output: "context_switch_points",
          label: "Involuntary",
          color: "#ffb74d",
          channels: { time: "time", value: "involuntary" },
          tooltip: [
            { label: "Involuntary", field: "involuntary", format: "integer" },
            { label: "Time", field: "time", format: "time" },
          ],
        },
      ],
    },
    {
      id: "custom-dino",
      elementId: "custom-dino-panel",
      title: "Custom · Extremely Scientific Dinosaur",
      height: 148,
      yMin: 0,
      yMax: 10,
      summary: "dino",
      layers: [
        {
          renderer: "line",
          output: "dino_points",
          label: "Dino 🦖",
          color: "#66d17a",
          width: 3,
          channels: { time: "time", value: "value" },
          tooltip: [{ label: "Dino says", field: "tooltip", format: "raw" }],
        },
        {
          renderer: "line",
          output: "dino_flames",
          label: "Flames 🔥",
          color: "#ff7043",
          width: 3,
          channels: { time: "time", value: "value" },
          tooltip: [{ label: "Science", field: "tooltip", format: "raw" }],
        },
      ],
    },
  ]);

  function mapValue(value, key) {
    if (value instanceof Map || value instanceof MapView) return value.get(key);
    return value?.[key];
  }

  function number(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function eventMapView(event) {
    const fields = event.fields || {};
    const read = (key) => {
      if (key === "kind") return event.name;
      if (key === "time") return event.timestamp;
      return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
    };
    const has = (key) => key === "kind" || key === "time" || Object.prototype.hasOwnProperty.call(fields, key);
    return new MapView(read, has);
  }

  function metadataView(metadata) {
    const map = metadata instanceof Map ? metadata : new Map(Object.entries(metadata || {}));
    return new MapView((key) => map.get(key), (key) => map.has(key));
  }

  function executeBundle(bundle, context, outputs, diagnostics) {
    const functions = {
      "dial9.events": () => context.events,
      "dial9.metadata": () => context.metadata,
      "dial9.viewport": () => context.viewport,
      "dial9.pointer": () => context.pointer,
      "dial9.trace.start": () => context.minTs,
      "dial9.trace.end": () => context.maxTs,
      "dial9.output.emit": (output, value) => { output.push(value); return value; },
    };
    for (const name of Object.keys(bundle.outputs || {})) {
      functions[name] = () => outputs[name];
    }
    const program = compile(bundle, {
      functions,
      onWarning: (message) => diagnostics.push({ level: "warning", message }),
    });
    program();
    return program;
  }

  function runDemoPrograms(trace, range) {
    const rawEvents = (trace.customEvents || []).slice().sort((a, b) => a.timestamp - b.timestamp);
    const eventViews = rawEvents.map(eventMapView);
    const diagnostics = [];
    const outputs = {
      cpu_intervals: [],
      context_switch_points: [],
      dino_points: [],
      dino_flames: [],
    };
    const context = {
      events: new ListView(eventViews.length, (index) => eventViews[index]),
      metadata: metadataView(trace.segmentMetadata),
      viewport: new MapView(() => undefined, () => false),
      pointer: null,
      minTs: Number(range.minTs),
      maxTs: Number(range.maxTs),
    };
    const programs = {};
    for (const [name, bundle] of [
      ["cpu", CPU_BUNDLE],
      ["context", CONTEXT_SWITCH_BUNDLE],
      ["dino", DINO_BUNDLE],
    ]) {
      try {
        programs[name] = executeBundle(bundle, context, outputs, diagnostics);
      } catch (error) {
        diagnostics.push({ level: "error", message: `${name}: ${error.message}` });
      }
    }
    return {
      outputs,
      diagnostics,
      programs,
      capacity: number(trace.segmentMetadata?.get?.("process.available_parallelism")),
      panels: PANEL_SPECS,
    };
  }

  function visibleRows(rows, layer, viewStart, viewEnd) {
    const channels = layer.channels;
    if (layer.renderer === "interval-area") {
      return rows.filter((row) => {
        const start = number(mapValue(row, channels.start));
        const end = number(mapValue(row, channels.end));
        return start != null && end != null && end >= viewStart && start <= viewEnd;
      });
    }
    return rows;
  }

  function layerValues(state, spec, viewStart, viewEnd) {
    const values = [];
    for (const layer of spec.layers) {
      const rows = visibleRows(state.outputs[layer.output] || [], layer, viewStart, viewEnd);
      for (const row of rows) {
        const value = number(mapValue(row, layer.channels.value));
        if (value != null) values.push(value);
      }
    }
    if (spec.id === "custom-cpu" && state.capacity != null) values.push(state.capacity);
    return values;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function alphaColor(color, alpha) {
    const match = /^#([0-9a-f]{6})$/i.exec(color);
    if (!match) return color;
    const hex = match[1];
    return `rgba(${parseInt(hex.slice(0, 2), 16)},${parseInt(hex.slice(2, 4), 16)},${parseInt(hex.slice(4, 6), 16)},${alpha})`;
  }

  function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return Math.hypot(px - x1, py - y1);
    const ratio = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + ratio * dx), py - (y1 + ratio * dy));
  }

  function summaryText(state, spec, viewStart, viewEnd) {
    if (spec.summary === "cpu") {
      let weighted = 0;
      let duration = 0;
      let max = 0;
      for (const row of state.outputs.cpu_intervals) {
        const start = number(mapValue(row, "start"));
        const end = number(mapValue(row, "end"));
        const cores = number(mapValue(row, "cores"));
        if (start == null || end == null || cores == null) continue;
        const overlap = Math.min(end, viewEnd) - Math.max(start, viewStart);
        if (!(overlap > 0)) continue;
        weighted += overlap * cores;
        duration += overlap;
        if (cores > max) max = cores;
      }
      const avg = duration > 0 ? weighted / duration : 0;
      return `avg ${avg.toFixed(2)} cores · max ${max.toFixed(2)}`;
    }
    if (spec.summary === "context") {
      const rows = state.outputs.context_switch_points;
      let latest = null;
      for (const row of rows) {
        const time = number(mapValue(row, "time"));
        if (time != null && time <= viewEnd) latest = row;
      }
      if (!latest) return "";
      return `vol ${Math.round(number(mapValue(latest, "voluntary")) || 0)} · invol ${Math.round(number(mapValue(latest, "involuntary")) || 0)}`;
    }
    if (spec.summary === "dino") return "compiled from the same IR, obviously";
    return "";
  }

  function legendHtml(spec) {
    return spec.layers.map((layer) =>
      `<span class="panel-expanded-label custom-view-legend"><span style="background:${escapeHtml(layer.color)}"></span>${escapeHtml(layer.label)}</span>`
    ).join("");
  }

  function renderPanel(state, spec, options) {
    const panel = document.getElementById(spec.elementId);
    if (!panel || panel.style.display === "none") return;
    const canvas = panel.querySelector("canvas");
    const label = panel.querySelector(".chart-label");
    const info = panel.querySelector(".custom-view-info");
    if (label) label.innerHTML = `${escapeHtml(spec.title)}${legendHtml(spec)}`;
    if (info) info.textContent = summaryText(state, spec, options.viewStart, options.viewEnd);
    if (panel.classList.contains("is-collapsed")) return;

    const layout = options.layoutFor(panel, options.scrollbarW);
    const ctx = layout.resizeCanvas(canvas, spec.height);
    const { pw, drawW, nsToPanelX, nsToPanelXClamped } = layout;
    ctx.clearRect(0, 0, pw, spec.height);
    ctx.fillStyle = spec.id === "custom-dino" ? "#102219" : "#111b2e";
    ctx.fillRect(0, 0, pw, spec.height);
    panel._dial9CustomHits = [];
    if (!(drawW > 0)) return;

    const chartTop = 24;
    const chartBottom = spec.height - 8;
    const chartHeight = chartBottom - chartTop;
    const values = layerValues(state, spec, options.viewStart, options.viewEnd);
    let yMin = spec.yMin ?? (values.length ? Math.min(...values) : 0);
    let yMax = spec.yMax ?? (values.length ? Math.max(...values) : 1);
    if (!(yMax > yMin)) yMax = yMin + 1;
    const valueToY = (value) => chartBottom - ((value - yMin) / (yMax - yMin)) * chartHeight;

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
      const y = chartTop + (chartHeight * i) / 3;
      ctx.beginPath();
      ctx.moveTo(100, y);
      ctx.lineTo(100 + drawW, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#667";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.fillText(yMax.toFixed(yMax < 10 ? 1 : 0), 94, chartTop + 9);
    ctx.fillText(yMin.toFixed(yMin < 10 ? 1 : 0), 94, chartBottom);

    ctx.save();
    ctx.beginPath();
    ctx.rect(100, chartTop - 4, drawW, chartHeight + 8);
    ctx.clip();

    if (spec.id === "custom-cpu" && state.capacity != null) {
      const y = valueToY(state.capacity);
      ctx.strokeStyle = "rgba(255,207,153,0.75)";
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(100, y);
      ctx.lineTo(100 + drawW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const layer of spec.layers) {
      const rows = visibleRows(state.outputs[layer.output] || [], layer, options.viewStart, options.viewEnd);
      if (layer.renderer === "interval-area") {
        for (const row of rows) {
          const start = number(mapValue(row, layer.channels.start));
          const end = number(mapValue(row, layer.channels.end));
          const value = number(mapValue(row, layer.channels.value));
          if (start == null || end == null || value == null) continue;
          const x1 = nsToPanelXClamped(start);
          const x2 = nsToPanelXClamped(end);
          const y = valueToY(value);
          const width = Math.max(1, x2 - x1);
          ctx.fillStyle = alphaColor(layer.color, 0.38);
          ctx.fillRect(x1, y, width, chartBottom - y);
          ctx.strokeStyle = layer.color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x1 + width, y);
          ctx.stroke();
          panel._dial9CustomHits.push({ kind: "interval", layer, row, x1, x2: x1 + width, y, bottom: chartBottom });
        }
        continue;
      }

      ctx.strokeStyle = layer.color;
      ctx.lineWidth = layer.width || 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let previous = null;
      for (const row of rows) {
        const time = number(mapValue(row, layer.channels.time));
        const value = number(mapValue(row, layer.channels.value));
        if (time == null || value == null) continue;
        const x = nsToPanelX(time);
        const y = valueToY(value);
        if (!previous) ctx.moveTo(x, y);
        else {
          ctx.lineTo(x, y);
          panel._dial9CustomHits.push({
            kind: "line",
            layer,
            row,
            previousRow: previous.row,
            x1: previous.x,
            y1: previous.y,
            x2: x,
            y2: y,
          });
        }
        previous = { row, x, y };
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function preparePanels(state) {
    for (const spec of PANEL_SPECS) {
      const panel = document.getElementById(spec.elementId);
      if (!panel) continue;
      const hasData = spec.layers.some((layer) => (state.outputs[layer.output] || []).length > 0);
      panel.style.display = hasData ? "block" : "none";
    }
  }

  function resetPanels() {
    if (typeof document === "undefined") return;
    for (const spec of PANEL_SPECS) {
      const panel = document.getElementById(spec.elementId);
      if (panel) panel.style.display = "none";
    }
  }

  function renderAll(state, options) {
    if (!state || typeof document === "undefined") return;
    for (const spec of PANEL_SPECS) renderPanel(state, spec, options);
  }

  function hitAt(panel, x, y) {
    let best = null;
    let score = Infinity;
    for (const hit of panel._dial9CustomHits || []) {
      if (hit.kind === "interval") {
        if (x >= hit.x1 && x <= hit.x2 && y >= Math.min(hit.y, hit.bottom) && y <= Math.max(hit.y, hit.bottom)) {
          return hit;
        }
        continue;
      }
      const distance = pointToSegmentDistance(x, y, hit.x1, hit.y1, hit.x2, hit.y2);
      if (distance <= 9 && distance < score) {
        score = distance;
        const firstDistance = Math.hypot(x - hit.x1, y - hit.y1);
        const secondDistance = Math.hypot(x - hit.x2, y - hit.y2);
        best = { ...hit, row: firstDistance < secondDistance ? hit.previousRow : hit.row };
      }
    }
    return best;
  }

  function simpleDuration(value) {
    const ns = number(value);
    if (ns == null) return String(value);
    if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
    if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
    if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
    return `${ns.toFixed(0)} ns`;
  }

  function formatTooltipValue(value, format, options) {
    if (format === "duration") return simpleDuration(value);
    if (format === "decimal") return number(value)?.toFixed(3) ?? String(value);
    if (format === "integer") return String(Math.round(number(value) || 0));
    if (format === "time") return options.formatTime ? options.formatTime(number(value)) : String(value);
    return String(value);
  }

  function tooltipHtml(hit, options) {
    let html = `<span class="label">Series:</span> <span class="value">${escapeHtml(hit.layer.label)}</span>`;
    for (const row of hit.layer.tooltip || []) {
      const value = mapValue(hit.row, row.field);
      if (value == null || value === "") continue;
      html += `<br><span class="label">${escapeHtml(row.label)}:</span> <span class="value">${escapeHtml(formatTooltipValue(value, row.format, options))}</span>`;
    }
    return html;
  }

  function mountInteractions(options) {
    if (typeof document === "undefined") return () => {};
    const cleanups = [];
    for (const spec of PANEL_SPECS) {
      const panel = document.getElementById(spec.elementId);
      const canvas = panel?.querySelector("canvas");
      if (!canvas) continue;
      const move = (event) => {
        const rect = canvas.getBoundingClientRect();
        const hit = hitAt(panel, event.clientX - rect.left, event.clientY - rect.top);
        if (!hit) {
          canvas.style.cursor = "default";
          options.hideTooltip();
          return;
        }
        const html = tooltipHtml(hit, options);
        if (!html.includes("<br>") && spec.id === "custom-dino") {
          canvas.style.cursor = "default";
          options.hideTooltip();
          return;
        }
        canvas.style.cursor = "crosshair";
        options.showTooltip(html, event);
      };
      const leave = () => {
        canvas.style.cursor = "default";
        options.hideTooltip();
      };
      canvas.addEventListener("mousemove", move);
      canvas.addEventListener("mouseleave", leave);
      cleanups.push(() => {
        canvas.removeEventListener("mousemove", move);
        canvas.removeEventListener("mouseleave", leave);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }

  return Object.freeze({
    bundles: Object.freeze({ cpu: CPU_BUNDLE, context: CONTEXT_SWITCH_BUNDLE, dino: DINO_BUNDLE }),
    panelSpecs: PANEL_SPECS,
    runDemoPrograms,
    preparePanels,
    resetPanels,
    renderAll,
    mountInteractions,
  });
});
