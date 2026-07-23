// custom_view_panels.js - Stackable canvas layers and interactive presenters.
// Renderers consume materialized bundle outputs and contain no trace-specific rules.

(function (exports) {
  "use strict";

  function getRuntime() {
    if (typeof require !== "undefined") return require("./custom_view_runtime.js");
    if (typeof Dial9CustomViewRuntime !== "undefined") return Dial9CustomViewRuntime;
    throw new Error("Dial9CustomViewRuntime not found");
  }

  const runtime = getRuntime();
  const RENDERERS = Object.freeze([
    "interval-area",
    "interval-line",
    "line",
    "step-line",
    "points",
    "horizontal-rule",
    "text",
  ]);
  const RENDERER_SET = new Set(RENDERERS);

  function field(row, name) {
    if (row instanceof Map || (row && typeof row.get === "function")) return row.get(name);
    return row == null ? undefined : row[name];
  }

  function number(value) {
    if (typeof value === "bigint") return Number(value);
    return typeof value === "number" ? value : Number(value);
  }

  function formatDuration(value) {
    const ns = number(value);
    if (!Number.isFinite(ns)) return "-";
    const absolute = Math.abs(ns);
    if (absolute >= 1e9) return `${(ns / 1e9).toFixed(2)}s`;
    if (absolute >= 1e6) return `${(ns / 1e6).toFixed(2)}ms`;
    if (absolute >= 1e3) return `${(ns / 1e3).toFixed(1)}µs`;
    return `${ns.toFixed(0)}ns`;
  }

  function formatValue(value, format) {
    if (value == null) return "-";
    switch (format) {
      case "duration": return formatDuration(value);
      case "integer": return typeof value === "bigint" ? value.toString() : Math.trunc(value).toString();
      case "cores": return `${number(value).toFixed(2)} cores`;
      case "rate": return `${number(value).toFixed(2)}/s`;
      case "percent": return `${(number(value) * 100).toFixed(1)}%`;
      case "text": return String(value);
      default:
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
        return String(value);
    }
  }

  function visibleRows(rows, layer, viewport) {
    if (!viewport) return rows;
    const channels = layer.channels || {};
    if (channels.start && channels.end) {
      return rows.filter((row) => number(field(row, channels.end)) >= viewport.start &&
        number(field(row, channels.start)) <= viewport.end);
    }
    if (channels.x) {
      let first = -1;
      let last = -1;
      for (let index = 0; index < rows.length; index++) {
        const x = number(field(rows[index], channels.x));
        if (x < viewport.start || x > viewport.end) continue;
        if (first < 0) first = index;
        last = index;
      }
      const connectsPoints = layer.renderer === "line" || layer.renderer === "step-line";
      if (first >= 0) {
        return rows.slice(
          connectsPoints ? Math.max(0, first - 1) : first,
          connectsPoints ? Math.min(rows.length, last + 2) : last + 1,
        );
      }
      if (connectsPoints) {
        for (let index = 1; index < rows.length; index++) {
          const previous = number(field(rows[index - 1], channels.x));
          const current = number(field(rows[index], channels.x));
          if ((previous < viewport.start && current > viewport.end) ||
              (current < viewport.start && previous > viewport.end)) {
            return rows.slice(index - 1, index + 1);
          }
        }
      }
      return [];
    }
    return rows;
  }

  function scalesFor(panel, bundle, viewport, geometry) {
    const xDomain = panel.x.type === "time"
      ? [viewport.start, viewport.end]
      : panel.x.domain;
    let yDomain = panel.y.domain ? [...panel.y.domain] : null;
    if (yDomain === null) {
      let minimum = panel.y.includeZero ? 0 : Infinity;
      let maximum = panel.y.includeZero ? 0 : -Infinity;
      for (const layer of panel.layers) {
        const yField = layer.channels && layer.channels.y;
        if (!yField) continue;
        for (const row of visibleRows(bundle.rows(layer.data), layer, panel.x.type === "time" ? viewport : null)) {
          const value = number(field(row, yField));
          if (!Number.isFinite(value)) continue;
          if (value < minimum) minimum = value;
          if (value > maximum) maximum = value;
        }
      }
      if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) [minimum, maximum] = [0, 1];
      if (minimum === maximum) maximum = minimum === 0 ? 1 : minimum * 1.1;
      yDomain = [minimum, maximum];
    }
    const [xMin, xMax] = xDomain;
    const [yMin, yMax] = yDomain;
    const xRange = xMax - xMin || 1;
    const yRange = yMax - yMin || 1;
    return {
      xDomain,
      yDomain,
      x(value) { return geometry.left + ((number(value) - xMin) / xRange) * geometry.width; },
      invertX(value) { return geometry.width > 0 ? xMin + ((value - geometry.left) / geometry.width) * xRange : xMin; },
      y(value) { return geometry.top + geometry.height - ((number(value) - yMin) / yRange) * geometry.height; },
      baseline: geometry.top + geometry.height - ((0 - yMin) / yRange) * geometry.height,
    };
  }

  function addHit(hits, layer, row, x, y, bounds) {
    if (!layer.tooltip || layer.tooltip.length === 0) return;
    hits.push({ layer, row, x, y, bounds: bounds || null });
  }

  function layerColor(layer, row) {
    const colorField = layer.channels && layer.channels.color;
    return (colorField ? field(row, colorField) : null) || layer.style.color || "#fff";
  }

  function drawIntervalArea(ctx, layer, rows, scales, geometry, hits, lineOnly) {
    const alpha = layer.style.fillAlpha == null ? 0.25 : layer.style.fillAlpha;
    for (const row of rows) {
      const color = layerColor(layer, row);
      const x1 = Math.max(geometry.left, scales.x(field(row, layer.channels.start)));
      const x2 = Math.min(geometry.left + geometry.width, scales.x(field(row, layer.channels.end)));
      const y = scales.y(field(row, layer.channels.y));
      const baseline = Math.max(geometry.top, Math.min(geometry.top + geometry.height, scales.baseline));
      if (!lineOnly) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(x1, Math.min(y, baseline), Math.max(1, x2 - x1), Math.abs(baseline - y));
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = layer.style.width || 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      addHit(hits, layer, row, (x1 + x2) / 2, y, { x1, x2, y1: Math.min(y, baseline), y2: Math.max(y, baseline) });
    }
  }

  function drawLine(ctx, layer, rows, scales, hits, stepped) {
    if (rows.length === 0) return;
    ctx.lineWidth = layer.style.width || 1.75;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (layer.style.fill && rows.length > 1) {
      ctx.beginPath();
      let previousY = null;
      for (const row of rows) {
        const x = scales.x(field(row, layer.channels.x));
        const y = scales.y(field(row, layer.channels.y));
        if (previousY === null) ctx.moveTo(x, y);
        else if (stepped) {
          ctx.lineTo(x, previousY);
          ctx.lineTo(x, y);
        } else ctx.lineTo(x, y);
        previousY = y;
      }
      const firstX = scales.x(field(rows[0], layer.channels.x));
      const lastX = scales.x(field(rows[rows.length - 1], layer.channels.x));
      ctx.lineTo(lastX, scales.baseline);
      ctx.lineTo(firstX, scales.baseline);
      ctx.closePath();
      ctx.fillStyle = layer.style.fill;
      ctx.fill();
    }

    const dynamicColor = layer.channels && layer.channels.color;
    if (dynamicColor) {
      let previous = null;
      for (const row of rows) {
        const x = scales.x(field(row, layer.channels.x));
        const y = scales.y(field(row, layer.channels.y));
        addHit(hits, layer, row, x, y);
        if (previous !== null) {
          ctx.strokeStyle = layerColor(layer, row);
          ctx.beginPath();
          ctx.moveTo(previous.x, previous.y);
          if (stepped) {
            ctx.lineTo(x, previous.y);
            ctx.lineTo(x, y);
          } else ctx.lineTo(x, y);
          ctx.stroke();
        }
        previous = { x, y };
      }
      return;
    }

    ctx.strokeStyle = layer.style.color;
    ctx.beginPath();
    let previous = null;
    for (const row of rows) {
      const x = scales.x(field(row, layer.channels.x));
      const y = scales.y(field(row, layer.channels.y));
      if (previous === null) ctx.moveTo(x, y);
      else if (stepped) {
        ctx.lineTo(x, previous.y);
        ctx.lineTo(x, y);
      } else ctx.lineTo(x, y);
      addHit(hits, layer, row, x, y);
      previous = { x, y };
    }
    ctx.stroke();
  }

  function drawPoints(ctx, layer, rows, scales, hits) {
    const radius = layer.style.radius || 3;
    for (const row of rows) {
      const x = scales.x(field(row, layer.channels.x));
      const y = scales.y(field(row, layer.channels.y));
      ctx.fillStyle = layerColor(layer, row);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      addHit(hits, layer, row, x, y, { x1: x - radius, x2: x + radius, y1: y - radius, y2: y + radius });
    }
  }

  function drawRule(ctx, layer, rows, scales, geometry) {
    ctx.lineWidth = layer.style.width || 1;
    ctx.setLineDash(layer.style.dash || []);
    for (const row of rows) {
      const color = layerColor(layer, row);
      ctx.strokeStyle = color;
      const y = scales.y(field(row, layer.channels.y));
      ctx.beginPath();
      ctx.moveTo(geometry.left, y);
      ctx.lineTo(geometry.left + geometry.width, y);
      ctx.stroke();
      if (layer.channels.label) {
        ctx.fillStyle = color;
        ctx.font = "10px sans-serif";
        ctx.fillText(String(field(row, layer.channels.label)), geometry.left + 5, Math.max(geometry.top + 10, y - 3));
      }
    }
    ctx.setLineDash([]);
  }

  function drawText(ctx, layer, rows, scales, hits) {
    ctx.font = layer.style.font || "12px sans-serif";
    ctx.fillStyle = layer.style.color || "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const row of rows) {
      ctx.fillStyle = layerColor(layer, row);
      const x = scales.x(field(row, layer.channels.x));
      const y = scales.y(field(row, layer.channels.y));
      const text = String(field(row, layer.channels.text));
      ctx.fillText(text, x, y);
      addHit(hits, layer, row, x, y, { x1: x - 18, x2: x + 18, y1: y - 14, y2: y + 14 });
    }
  }

  function renderPanel(ctx, panel, bundle, viewport, geometry) {
    const scales = scalesFor(panel, bundle, viewport, geometry);
    const hits = [];
    ctx.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
    ctx.fillStyle = "#111b2e";
    ctx.fillRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);

    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 1; i <= 3; i++) {
      const y = geometry.top + (geometry.height * i) / 4;
      ctx.beginPath();
      ctx.moveTo(geometry.left, y);
      ctx.lineTo(geometry.left + geometry.width, y);
      ctx.stroke();
    }
    ctx.fillStyle = "#667";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(formatValue(scales.yDomain[1], panel.y.format), geometry.left - 6, geometry.top + 9);
    ctx.fillText(formatValue(scales.yDomain[0], panel.y.format), geometry.left - 6, geometry.top + geometry.height);

    for (const layer of panel.layers) {
      const rows = visibleRows(bundle.rows(layer.data), layer, panel.x.type === "time" ? viewport : null);
      switch (layer.renderer) {
        case "interval-area": drawIntervalArea(ctx, layer, rows, scales, geometry, hits, false); break;
        case "interval-line": drawIntervalArea(ctx, layer, rows, scales, geometry, hits, true); break;
        case "line": drawLine(ctx, layer, rows, scales, hits, false); break;
        case "step-line": drawLine(ctx, layer, rows, scales, hits, true); break;
        case "points": drawPoints(ctx, layer, rows, scales, hits); break;
        case "horizontal-rule": drawRule(ctx, layer, rows, scales, geometry); break;
        case "text": drawText(ctx, layer, rows, scales, hits); break;
        default: throw new Error(`unknown custom view renderer ${JSON.stringify(layer.renderer)}`);
      }
    }
    return { scales, hits };
  }

  function hitDistance(hit, x, y) {
    if (hit.layer.hit === "x" && hit.bounds && x >= hit.bounds.x1 && x <= hit.bounds.x2) return 0;
    if (hit.bounds && x >= hit.bounds.x1 && x <= hit.bounds.x2 && y >= hit.bounds.y1 && y <= hit.bounds.y2) {
      return Math.abs(y - hit.y) * 0.25;
    }
    return Math.hypot(x - hit.x, y - hit.y);
  }

  function findHit(hits, x, y, maxDistance) {
    const limit = maxDistance == null ? 14 : maxDistance;
    let best = null;
    let distance = limit;
    for (const hit of hits) {
      const candidate = hitDistance(hit, x, y);
      if (candidate <= distance) {
        best = hit;
        distance = candidate;
      }
    }
    return best;
  }

  function tooltipRows(hit) {
    if (!hit) return [];
    const rows = [];
    for (const item of hit.layer.tooltip || []) {
      const value = field(hit.row, item.field);
      if (item.omitEmpty && (value == null || value === "")) continue;
      rows.push({ label: item.label || "", value: formatValue(value, item.format) });
    }
    return rows;
  }

  function legendEntries(items, bundle) {
    const entries = [];
    for (const item of items || []) {
      if (!item.data) {
        entries.push({ label: item.label, color: item.color });
        continue;
      }
      const rows = bundle.rows(item.data);
      if (!item.channels) {
        if (rows.length > 0) entries.push({ label: item.label, color: item.color });
        continue;
      }
      for (const row of rows) {
        entries.push({
          label: String(field(row, item.channels.label)),
          color: String(field(row, item.channels.color)),
        });
      }
    }
    return entries;
  }

  function panelKey(bundle, spec) {
    return `custom-view:${bundle.id}:${spec.id}`;
  }

  function createPanelElement(doc, bundle, spec) {
    const element = doc.createElement("div");
    element.className = "foldable-panel custom-view-panel";
    element.dataset.panelKey = panelKey(bundle, spec);
    element.style.display = "none";
    element.style.height = `${spec.height}px`;

    const label = doc.createElement("div");
    label.className = "chart-label";
    label.appendChild(doc.createTextNode(spec.title));
    const legend = doc.createElement("span");
    legend.className = "panel-expanded-label custom-view-legend";
    label.appendChild(legend);

    const summary = doc.createElement("span");
    summary.className = "custom-view-summary";
    const canvas = doc.createElement("canvas");
    element.append(label, summary, canvas);
    return { element, label, legend, summary, canvas };
  }

  function validateBundlePanels(bundle) {
    if (!bundle || typeof bundle.id !== "string" || bundle.id.length === 0) {
      throw new Error("bundle id must be a non-empty string");
    }
    const outputNames = new Set(Object.keys(bundle.outputs || {}));
    const dynamicNames = new Set((bundle.dynamic || []).map((definition) => definition.id));
    for (const definition of bundle.dynamic || []) {
      for (const output of definition.outputs || []) {
        if (!outputNames.has(output)) throw new Error(`dynamic program ${JSON.stringify(definition.id)} references unknown output ${JSON.stringify(output)}`);
      }
    }
    const panelIds = new Set();
    for (const panel of bundle.panels || []) {
      if (!panel || typeof panel.id !== "string" || panel.id.length === 0) throw new Error("panel id must be a non-empty string");
      if (panelIds.has(panel.id)) throw new Error(`duplicate panel id ${JSON.stringify(panel.id)}`);
      panelIds.add(panel.id);
      if (typeof panel.title !== "string") throw new Error(`panel ${JSON.stringify(panel.id)} title must be a string`);
      if (!Number.isFinite(panel.height) || panel.height <= 0) throw new Error(`panel ${JSON.stringify(panel.id)} height must be positive`);
      if (!panel.x || !["time", "linear"].includes(panel.x.type)) throw new Error(`panel ${JSON.stringify(panel.id)} has an invalid x scale`);
      if (panel.x.type === "linear" && (!Array.isArray(panel.x.domain) || panel.x.domain.length !== 2)) {
        throw new Error(`panel ${JSON.stringify(panel.id)} linear x scale requires a domain`);
      }
      if (!panel.y || !Array.isArray(panel.layers)) throw new Error(`panel ${JSON.stringify(panel.id)} requires y and layers`);
      for (const dynamic of [...(panel.dynamic || []), ...(panel.pointerDynamic || [])]) {
        if (!dynamicNames.has(dynamic)) throw new Error(`panel ${JSON.stringify(panel.id)} references unknown dynamic program ${JSON.stringify(dynamic)}`);
      }
      for (const layer of panel.layers) {
        if (!RENDERER_SET.has(layer.renderer)) throw new Error(`unknown custom view renderer ${JSON.stringify(layer.renderer)}`);
        if (!outputNames.has(layer.data)) throw new Error(`layer references unknown output ${JSON.stringify(layer.data)}`);
        if (!layer.channels || !layer.style) throw new Error(`renderer ${JSON.stringify(layer.renderer)} requires channels and style`);
      }
      for (const item of panel.legend || []) {
        if (item.data && !outputNames.has(item.data)) throw new Error(`legend references unknown output ${JSON.stringify(item.data)}`);
      }
      if (panel.summary && !outputNames.has(panel.summary.data)) {
        throw new Error(`summary references unknown output ${JSON.stringify(panel.summary.data)}`);
      }
    }
  }

  function compileBundles(definitions, host, onError) {
    const bundles = [];
    const errors = [];
    for (const definition of definitions) {
      try {
        validateBundlePanels(definition);
        bundles.push(runtime.compileBundle(definition, host));
      } catch (error) {
        const diagnostic = {
          severity: "error",
          bundle: definition && definition.id ? definition.id : null,
          message: error && error.message ? error.message : String(error),
        };
        errors.push(diagnostic);
        if (onError) onError(diagnostic);
      }
    }
    return { bundles, errors };
  }

  function createManager(options) {
    const doc = options.document;
    const viewport = () => options.getViewport();
    const bundleDefinitions = options.bundles || [runtime.resourceBundle(), runtime.dinoBundle()];
    const compilation = compileBundles(bundleDefinitions, { viewport }, options.onBundleError);
    const compiledBundles = compilation.bundles;
    const panels = [];
    let loaded = false;

    for (const bundle of compiledBundles) {
      for (const spec of bundle.bundle.panels) {
        const dom = createPanelElement(doc, bundle, spec);
        const { element, label, canvas, legend, summary } = dom;
        const key = element.dataset.panelKey;
        const collapsed = options.isPanelCollapsed ? options.isPanelCollapsed(key) : true;
        element.classList.toggle("is-collapsed", collapsed);
        label.setAttribute("role", "button");
        label.setAttribute("tabindex", "0");
        label.setAttribute("aria-expanded", collapsed ? "false" : "true");
        options.mountBefore.parentNode.insertBefore(element, options.mountBefore);

        const state = { bundle, spec, element, canvas, legend, summary, hits: [], scales: null };
        panels.push(state);
        const toggleCollapsed = () => {
          const next = !element.classList.contains("is-collapsed");
          if (options.setPanelCollapsed) options.setPanelCollapsed(key, next);
          else element.classList.toggle("is-collapsed", next);
          label.setAttribute("aria-expanded", next ? "false" : "true");
        };
        label.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          toggleCollapsed();
        });
        element.addEventListener("click", (event) => {
          if (event.target.closest(".kv-copy")) return;
          if (!element.classList.contains("is-collapsed") && !event.target.closest(".chart-label")) return;
          event.stopPropagation();
          toggleCollapsed();
        });
        canvas.addEventListener("mousemove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const hit = findHit(state.hits, x, y);
          canvas.style.cursor = hit ? "crosshair" : "default";
          const dataX = state.scales ? state.scales.invertX(x) : null;
          const pointer = new Map([
            ["canvas_x", x],
            ["canvas_y", y],
            ["x", spec.x.type === "time" && dataX != null ? BigInt(Math.round(dataX)) : dataX],
            ["datum", hit ? hit.row : null],
          ]);
          bundle.setPointer(pointer);
          for (const id of spec.pointerDynamic || []) bundle.runDynamic(id);
          renderLegend(state);
          renderSummary(state);
          showTooltip(hit, event);
        });
        canvas.addEventListener("mouseleave", () => {
          bundle.setPointer(null);
          for (const id of spec.pointerDynamic || []) bundle.runDynamic(id);
          renderLegend(state);
          renderSummary(state);
          canvas.style.cursor = "default";
          options.tooltip.style.display = "none";
        });
      }
    }

    function showTooltip(hit, event) {
      const rows = tooltipRows(hit);
      if (rows.length === 0) {
        options.tooltip.style.display = "none";
        return;
      }
      options.tooltip.replaceChildren();
      for (const row of rows) {
        const line = doc.createElement("div");
        if (row.label) {
          const label = doc.createElement("span");
          label.className = "label";
          label.textContent = `${row.label}: `;
          line.appendChild(label);
        }
        const value = doc.createElement("span");
        value.className = "value";
        value.textContent = row.value;
        line.appendChild(value);
        options.tooltip.appendChild(line);
      }
      options.tooltip.style.display = "block";
      options.placeTooltip(event);
    }

    function renderLegend(state) {
      state.legend.replaceChildren();
      const appendEntry = (label, color) => {
        const entry = doc.createElement("span");
        entry.className = "custom-view-legend-item";
        const swatch = doc.createElement("span");
        swatch.className = "custom-view-swatch";
        swatch.style.background = color;
        entry.appendChild(swatch);
        entry.appendChild(doc.createTextNode(label));
        state.legend.appendChild(entry);
      };
      for (const entry of legendEntries(state.spec.legend, state.bundle)) {
        appendEntry(entry.label, entry.color);
      }
    }

    function renderSummary(state) {
      const definition = state.spec.summary;
      const parts = [];
      if (definition) {
        const source = state.bundle.rows(definition.data)[0];
        if (source) {
          for (const item of definition.fields) {
            const value = field(source, item.field);
            if (item.omitEmpty && (value == null || value === "")) continue;
            parts.push(`${item.label} ${formatValue(value, item.format)}`);
          }
        }
      }
      if (state.bundle.diagnostics.length > 0) parts.push(`⚠ ${state.bundle.diagnostics.length}`);
      state.summary.textContent = parts.join(" · ");
    }

    return {
      loadTrace(trace) {
        const environment = runtime.traceEnvironment(trace);
        for (const bundle of compiledBundles) bundle.loadTrace(trace, environment);
        loaded = true;
        for (const state of panels) {
          const hasData = state.spec.layers.some((layer) => state.bundle.rows(layer.data).length > 0);
          state.element.style.display = hasData ? "block" : "none";
          renderLegend(state);
        }
      },
      render(scrollbarWidth) {
        if (!loaded) return;
        const currentViewport = viewport();
        const ranDynamic = new Set();
        for (const state of panels) {
          if (state.element.style.display === "none") continue;
          for (const id of state.spec.dynamic || []) {
            const key = `${state.bundle.id}:${id}`;
            if (!ranDynamic.has(key)) {
              state.bundle.runDynamic(id);
              ranDynamic.add(key);
            }
          }
          renderLegend(state);
          renderSummary(state);
          if (state.element.classList.contains("is-collapsed")) continue;
          const width = state.element.clientWidth;
          const height = state.spec.height;
          const dpr = window.devicePixelRatio || 1;
          state.canvas.width = Math.max(1, Math.floor(width * dpr));
          state.canvas.height = Math.max(1, Math.floor(height * dpr));
          state.canvas.style.width = `${width}px`;
          state.canvas.style.height = `${height}px`;
          const ctx = state.canvas.getContext("2d");
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const left = options.labelWidth;
          const geometry = {
            canvasWidth: width,
            canvasHeight: height,
            left,
            top: 22,
            width: Math.max(0, width - left - (scrollbarWidth || 0)),
            height: Math.max(0, height - 30),
          };
          const result = renderPanel(ctx, state.spec, state.bundle, currentViewport, geometry);
          state.hits = result.hits;
          state.scales = result.scales;
        }
      },
      reset() {
        loaded = false;
        for (const bundle of compiledBundles) bundle.reset();
        for (const state of panels) {
          state.hits = [];
          state.scales = null;
          state.element.style.display = "none";
          state.summary.textContent = "";
        }
      },
      panels,
      bundles: compiledBundles,
      errors: compilation.errors,
    };
  }

  const api = {
    createManager,
    compileBundles,
    renderers: RENDERERS,
    createPanelElement,
    field,
    formatValue,
    scalesFor,
    renderPanel,
    findHit,
    legendEntries,
    tooltipRows,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else exports.Dial9CustomViewPanels = api;
})(typeof exports === "undefined" ? this : exports);
