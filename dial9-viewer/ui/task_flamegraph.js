// Time-weighted analysis for one instrumented task. Keep the contract in sync
// with ingest/task_profile; tests compare local and aggregate results.
(function (exports) {
  "use strict";

  const sameFrame = (a, b) => a.name === b.name && a.file === b.file;
  const key = (stack) => JSON.stringify(stack);
  function compareStacks(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].name !== b[i].name) return a[i].name < b[i].name ? -1 : 1;
      if (a[i].file !== b[i].file) {
        if (a[i].file == null) return -1;
        if (b[i].file == null) return 1;
        return a[i].file < b[i].file ? -1 : 1;
      }
    }
    return a.length - b.length;
  }
  function application(frame) {
    return !!frame.file && !["/rustc/", "/rustlib/", "library/", "/registry/src/", "/git/checkouts/"]
      .some((s) => frame.file.includes(s)) && !["std::", "core::", "alloc::", "tokio::", "tokio_util::", "dial9", "<tokio::", "<dial9"]
      .some((s) => frame.name.startsWith(s));
  }
  const sleep = (f) => f.name.includes("tokio::time::sleep::Sleep");
  const notify = (f) => f.name.includes("tokio::sync::notify::") || f.name.includes("WaitForCancellationFuture");
  function secondary(branch, siblings) {
    return branch.some((frame, i) => {
      let leaf;
      if (frame.name.includes("tokio::time::timeout::Timeout")) leaf = sleep;
      else if (frame.name.includes("hyper_util::server::graceful::") ||
               frame.name.includes("tokio_util::sync::cancellation_token::")) leaf = notify;
      else return false;
      return branch.slice(i + 1).some(leaf) && siblings.some((other) =>
        other.length > i + 1 &&
        branch.slice(0, i + 1).every((f, j) => sameFrame(f, other[j])) &&
        !other.slice(i + 1).some(leaf));
    });
  }
  function selectRepresentative(stacks) {
    const alternatives = [...new Map(stacks.filter((s) => s.length).map((s) => [key(s), s])).values()]
      .sort(compareStacks);
    let common = alternatives[0]?.length || 0;
    for (const stack of alternatives.slice(1)) {
      let i = 0;
      while (i < common && i < stack.length && sameFrame(alternatives[0][i], stack[i])) i++;
      common = i;
    }
    let candidates = alternatives.filter((s) => !secondary(s, alternatives));
    if (!candidates.length) candidates = alternatives;
    const scores = candidates.map((s) => s.slice(common).filter(application).length);
    const best = Math.max(...scores);
    const winners = candidates.filter((_, i) => scores[i] === best);
    if (winners.length === 1) return { stack: winners[0].map((f) => f.name), alternatives };
    const labels = [...new Set(candidates.map((s) => s[s.length - 1].name))].sort();
    return {
      stack: [
        ...(alternatives[0] || []).slice(0, common).map((f) => f.name),
        `[awaiting any of ${candidates.length}] ${labels.join(" | ")}`,
      ],
      alternatives,
    };
  }

  function node(name) { return { name, weight_ns: 0, self_ns: 0, children: Object.create(null) }; }
  function add(root, stack, weight, alternatives = []) {
    root.weight_ns += weight;
    let current = root;
    for (const name of stack) {
      current = current.children[name] || (current.children[name] = node(name));
      current.weight_ns += weight;
    }
    current.self_ns += weight;
    if (alternatives.length) {
      current.alternatives = [...new Map([...(current.alternatives || []), ...alternatives].map((s) => [JSON.stringify(s), s])).values()]
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
    }
  }

  function analyzeTaskProfile({ taskId, startNs, endNs, metadata, workers, cpu, captures, metadataConflicts = [] }) {
    const result = {
      unit: "nanoseconds", task_id: String(taskId), start_ns: startNs, end_ns: endNs,
      effective_start_ns: null, cpu_ns: 0, idle_ns: 0, cpu_samples: 0, capture_groups: 0,
      incomplete_capture_groups: 0, invalid_capture_groups: 0, tree: null, unavailable_reason: null,
      limitations: [
        "Idle-at-await includes scheduler delay.",
        "Estimated total excludes synchronous off-CPU time inside polls.",
        "Only waits completed in the available trace are represented.",
      ],
    };
    const unavailable = (reason) => { result.unavailable_reason = reason; return result; };
    if (!(startNs < endNs)) return unavailable("invalid_range");
    if ([...metadataConflicts].some((k) => k === "boot_id" || k === "cpu.profile.frequency_hz" || k.startsWith("task_sampling.worker.")))
      return unavailable("conflicting_metadata");
    if (!workers.length) return unavailable("missing_poll_boundaries");
    let start = startNs;
    for (const worker of workers) {
      const raw = metadata.get(`task_sampling.worker.${worker}.sampling_started_at_ns`);
      const ts = raw === undefined ? NaN : Number(raw);
      if (!Number.isFinite(ts) || ts < 0) return unavailable("missing_or_conflicting_activation");
      start = Math.max(start, ts);
    }
    result.effective_start_ns = start;
    if (start >= endNs) return unavailable("outside_sampling_coverage");
    const hz = Number(metadata.get("cpu.profile.frequency_hz"));
    if (!Number.isFinite(hz) || hz <= 0) return unavailable("missing_cpu_frequency");
    const weight = 1e9 / hz;
    if (!Number.isFinite(weight)) return unavailable("invalid_cpu_frequency");
    const tree = node("[task]");
    for (const sample of cpu) {
      if (sample.timestamp < start || sample.timestamp >= endNs || !sample.stack.length) continue;
      add(tree, ["[on-cpu]", ...sample.stack.map((f) => f.name)], weight);
      result.cpu_ns += weight;
      result.cpu_samples++;
    }
    const groups = new Map();
    for (const capture of captures) {
      if (!groups.has(capture.timestamp)) groups.set(capture.timestamp, []);
      groups.get(capture.timestamp).push(capture);
    }
    for (const [timestamp, group] of [...groups].sort((a, b) => a[0] - b[0])) {
      const { idleStartNs: a, idleEndNs: b, inclusionProbability: p } = group[0];
      if (a == null || b == null) {
        result.incomplete_capture_groups++;
        continue;
      }
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || b > timestamp) {
        result.invalid_capture_groups++;
        continue;
      }
      const overlap = Math.min(b, endNs) - Math.max(a, start);
      if (overlap <= 0) continue;
      if (!Number.isFinite(p) || p <= 0 || p > 1 || group.some((c) =>
        c.inclusionProbability !== p || c.idleStartNs !== a || c.idleEndNs !== b || !c.stack.length)) {
        result.invalid_capture_groups++;
        continue;
      }
      const selected = selectRepresentative(group.map((c) => c.stack));
      const weight = overlap / p;
      if (!Number.isFinite(weight)) {
        result.invalid_capture_groups++;
        continue;
      }
      add(tree, ["[idle-at-await]", ...selected.stack], weight, selected.alternatives.map((s) => s.map((f) => f.name)));
      result.capture_groups++;
      result.idle_ns += weight;
    }
    if (!result.capture_groups) {
      return unavailable(result.incomplete_capture_groups ? "missing_idle_intervals" : "no_usable_task_samples");
    }
    if (!Number.isFinite(tree.weight_ns)) return unavailable("invalid_total_weight");
    if (result.incomplete_capture_groups) result.limitations.push("Older samples without completed idle intervals were excluded.");
    if (result.invalid_capture_groups) {
      result.limitations.push("Capture groups with invalid or inconsistent probabilities, intervals or stacks were excluded.");
    }
    result.tree = tree;
    return result;
  }

  const inputs = new WeakMap();
  function localTaskProfile(trace, taskId, polls, startNs, endNs) {
    let tasks = inputs.get(trace);
    if (!tasks) { tasks = new Map(); inputs.set(trace, tasks); }
    let input = tasks.get(taskId);
    if (!input) {
      const workers = new Set();
      for (const event of trace.events) {
        if (event.eventType === 0 && event.taskId === taskId) workers.add(event.workerId);
      }
      const cache = new Map();
      function stack(chain) {
        const id = chain.join(",");
        if (cache.has(id)) return cache.get(id);
        const frames = [...chain].reverse().flatMap((addr) => {
          const resolved = trace.callframeSymbols.get(addr);
          return (Array.isArray(resolved) ? resolved : [resolved]).filter((f) => f !== null).map((f) => ({
            name: f?.symbol || addr,
            file: f?.location?.replace(/:\d+(?::\d+)?$/, "") || null,
          }));
        });
        cache.set(id, frames);
        return frames;
      }
      input = {
        taskId, workers: [...workers], metadata: trace.segmentMetadata,
        metadataConflicts: trace.metadataConflicts,
        cpu: polls.flatMap((p) => (p.cpuSamples || [])
          .filter((s) => s.source === 0)
          .map((s) => ({ timestamp: s.timestamp, stack: stack(s.callchain) }))),
        captures: (trace.taskDumps.get(taskId) || [])
          .filter((c) => c.sampled === true)
          .map((c) => ({ ...c, stack: stack(c.callchain) })),
      };
      tasks.set(taskId, input);
    }
    return analyzeTaskProfile({ ...input, startNs, endNs });
  }

  exports.selectRepresentative = selectRepresentative;
  exports.analyzeTaskProfile = analyzeTaskProfile;
  exports.localTaskProfile = localTaskProfile;
})(typeof exports === "undefined" ? (globalThis.TaskFlamegraph = {}) : exports);
