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
    if (!viewport || layer.renderer === "text" || layer.renderer === "step-line") return rows;
    const channels = layer.channels || {};
    if (channels.start && channels.end) {
      return rows.filter((row) => number(field(row, channels.end)) >= viewport.start &&
        number(field(row, channels.start)) <= viewport.end);
    }
    if (channels.x) {
      return rows.filter((row) => {
        const x = number(field(row, channels.x));
        return x >= viewport.start && x <= viewport.end;
      });
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
      y(value) { return geometry.top + geometry.height - ((number(value) - yMin) / yRange) * geometry.height; },
      baseline: geometry.top + geometry.height - ((0 - yMin) / yRange) * geometry.height,
    };
  }

  function addHit(hits, layer, row, x, y, bounds) {
    if (!layer.tooltip || layer.tooltip.length === 0) return;
    hits.push({ layer, row, x, y, bounds: bounds || null });
  }

  function drawIntervalArea(ctx, layer, rows, scales, geometry, hits, lineOnly) {
    const color = layer.style.color;
    const alpha = layer.style.fillAlpha == null ? 0.25 : layer.style.fillAlpha;
    for (const row of rows) {
      const x1 = scales.x(field(row, layer.channels.start));
      const x2 = scales.x(field(row, layer.channels.end));
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
    ctx.strokeStyle = layer.style.color;
    ctx.lineWidth = layer.style.width || 1.75;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
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
    if (layer.style.fill && rows.length > 1) {
      const firstX = scales.x(field(rows[0], layer.channels.x));
      const lastX = scales.x(field(rows[rows.length - 1], layer.channels.x));
      ctx.lineTo(lastX, scales.baseline);
      ctx.lineTo(firstX, scales.baseline);
      ctx.closePath();
      ctx.fillStyle = layer.style.fill;
      ctx.fill();
    }
  }

  function drawRule(ctx, layer, rows, scales, geometry) {
    ctx.strokeStyle = layer.style.color;
    ctx.lineWidth = layer.style.width || 1;
    ctx.setLineDash(layer.style.dash || []);
    for (const row of rows) {
      const y = scales.y(field(row, layer.channels.y));
      ctx.beginPath();
      ctx.moveTo(geometry.left, y);
      ctx.lineTo(geometry.left + geometry.width, y);
      ctx.stroke();
      if (layer.channels.label) {
        ctx.fillStyle = layer.style.color;
        ctx.font = "10px sans-serif";
        ctx.fillText(String(field(row, layer.channels.label)), geometry.left + 5, Math.max(10, y - 3));
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

    for (const layer of panel.layers) {
      const rows = visibleRows(bundle.rows(layer.data), layer, panel.x.type === "time" ? viewport : null);
      switch (layer.renderer) {
        case "interval-area": drawIntervalArea(ctx, layer, rows, scales, geometry, hits, false); break;
        case "interval-line": drawIntervalArea(ctx, layer, rows, scales, geometry, hits, true); break;
        case "line": drawLine(ctx, layer, rows, scales, hits, false); break;
        case "step-line": drawLine(ctx, layer, rows, scales, hits, true); break;
        case "horizontal-rule": drawRule(ctx, layer, rows, scales, geometry); break;
        case "text": drawText(ctx, layer, rows, scales, hits); break;
        default: throw new Error(`unknown custom view renderer ${JSON.stringify(layer.renderer)}`);
      }
    }
    return { scales, hits };
  }

  function hitDistance(hit, x, y) {
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

  function createManager(options) {
    const doc = options.document;
    const viewport = () => options.getViewport();
    const compiledBundles = [runtime.resourceBundle(), runtime.dinoBundle()]
      .map((bundle) => runtime.compileBundle(bundle, { viewport }));
    const panels = [];
    let loaded = false;

    for (const bundle of compiledBundles) {
      for (const spec of bundle.bundle.panels) {
        const elementId = spec.id === "cpu" ? "cpu-panel"
          : spec.id === "context-switch-steps" ? "context-switch-steps-panel"
            : spec.id === "context-switch-spikes" ? "context-switch-spikes-panel"
              : "dinosaur-panel";
        const element = doc.getElementById(elementId);
        if (!element) throw new Error(`missing custom view panel element #${elementId}`);
        const canvas = element.querySelector("canvas");
        const legend = element.querySelector(".custom-view-legend");
        const summary = element.querySelector(".custom-view-summary");
        const state = { bundle, spec, element, canvas, legend, summary, hits: [] };
        panels.push(state);
        canvas.addEventListener("mousemove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          const hit = findHit(state.hits, x, y);
          canvas.style.cursor = hit ? "crosshair" : "default";
          bundle.setPointer(new Map([["x", x], ["y", y], ["datum", hit ? hit.row : null]]));
          showTooltip(hit, event);
        });
        canvas.addEventListener("mouseleave", () => {
          bundle.setPointer(null);
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
      for (const item of state.spec.legend || []) {
        if (item.data && state.bundle.rows(item.data).length === 0) continue;
        const entry = doc.createElement("span");
        entry.className = "custom-view-legend-item";
        const swatch = doc.createElement("span");
        swatch.className = "custom-view-swatch";
        swatch.style.background = item.color;
        entry.appendChild(swatch);
        entry.appendChild(doc.createTextNode(item.label));
        state.legend.appendChild(entry);
      }
    }

    function renderSummary(state) {
      const definition = state.spec.summary;
      const parts = [];
      if (definition) {
        const source = state.bundle.rows(definition.data)[0];
        if (source) {
          for (const item of definition.fields) {
            parts.push(`${item.label} ${formatValue(field(source, item.field), item.format)}`);
          }
        }
      }
      if (state.bundle.diagnostics.length > 0) parts.push(`⚠ ${state.bundle.diagnostics.length}`);
      state.summary.textContent = parts.join(" · ");
    }

    return {
      loadTrace(trace) {
        for (const bundle of compiledBundles) bundle.loadTrace(trace);
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
            top: 8,
            width: Math.max(0, width - left - (scrollbarWidth || 0)),
            height: Math.max(0, height - 18),
          };
          state.hits = renderPanel(ctx, state.spec, state.bundle, currentViewport, geometry).hits;
        }
      },
      reset() {
        loaded = false;
        for (const bundle of compiledBundles) bundle.reset();
        for (const state of panels) {
          state.hits = [];
          state.element.style.display = "none";
          state.summary.textContent = "";
        }
      },
      panels,
      bundles: compiledBundles,
    };
  }

  const api = {
    createManager,
    field,
    formatValue,
    scalesFor,
    renderPanel,
    findHit,
    tooltipRows,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else exports.Dial9CustomViewPanels = api;
})(typeof exports === "undefined" ? this : exports);
