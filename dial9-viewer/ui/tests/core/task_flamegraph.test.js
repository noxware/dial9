import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { analyzeTaskProfile, selectRepresentative } = require("../../task_flamegraph.js");
const frame = (name, file = null) => ({ name, file });
const stack = (...names) => names.map((name) => frame(name));
function fixture() {
  return {
    taskId: 7, startNs: 0, endNs: 230, workers: [0],
    metadata: new Map([
      ["cpu.profile.frequency_hz", "100000000"],
      ["task_sampling.worker.0.sampling_started_at_ns", "50"],
    ]),
    cpu: [20, 60].map((timestamp) => ({ timestamp, stack: stack("service::work") })),
    captures: [{ timestamp: 210, idleStartNs: 100, idleEndNs: 200, inclusionProbability: 0.5, stack: stack("service::work") }],
  };
}

describe("time-weighted task profile", () => {
  it("weights one sibling group once and excludes calibration", () => {
    const input = fixture();
    input.captures.push({ ...input.captures[0] });
    expect(analyzeTaskProfile(input)).toMatchObject({
      effective_start_ns: 50, cpu_ns: 10, idle_ns: 200, cpu_samples: 1,
      capture_groups: 1, tree: { weight_ns: 210 }, unavailable_reason: null,
    });
  });
  it("clips completed waits even when the capture is after the visible range", () => {
    expect(analyzeTaskProfile({ ...fixture(), startNs: 120, endNs: 180 }))
      .toMatchObject({ cpu_ns: 0, idle_ns: 120, capture_groups: 1 });
  });
  it("requires coverage for every worker and clips to the latest activation", () => {
    const input = fixture();
    input.workers.push(1);
    expect(analyzeTaskProfile(input).unavailable_reason).toBe("missing_or_conflicting_activation");
    input.metadata.set("task_sampling.worker.1.sampling_started_at_ns", "150");
    expect(analyzeTaskProfile(input)).toMatchObject({ effective_start_ns: 150, idle_ns: 100, cpu_ns: 0 });
  });
  it.each([undefined, 0, -1, 1.1, NaN, Infinity])("rejects probability %s without a default weight", (p) => {
    const input = fixture();
    input.captures[0].inclusionProbability = p;
    expect(analyzeTaskProfile(input)).toMatchObject({ invalid_capture_groups: 1, tree: null });
  });
  it("rejects inconsistent siblings and does not infer old V2 idle intervals", () => {
    const input = fixture();
    input.captures.push({ ...input.captures[0], idleEndNs: 190 });
    expect(analyzeTaskProfile(input).invalid_capture_groups).toBe(1);
    input.captures = [{ timestamp: 210, inclusionProbability: 1, stack: stack("old") }];
    expect(analyzeTaskProfile(input)).toMatchObject({ unavailable_reason: "missing_idle_intervals", tree: null });
  });
  it("does not label CPU-only data or missing metadata as mixed", () => {
    expect(analyzeTaskProfile({ ...fixture(), captures: [] }).tree).toBeNull();
    const input = fixture();
    input.metadata.delete("cpu.profile.frequency_hz");
    expect(analyzeTaskProfile(input).unavailable_reason).toBe("missing_cpu_frequency");
  });
});

describe("representative async stack", () => {
  it("deduplicates peers, preserves alternatives and is independent of callback order", () => {
    const a = stack("root", "tokio::sync::notify::Notified");
    const b = stack("root", "tokio::time::sleep::Sleep");
    const first = selectRepresentative([a, b, a]);
    expect(first).toEqual(selectRepresentative([b, a]));
    expect(first.stack[1]).toMatch(/^\[awaiting any of 2\]/);
    expect(first.alternatives).toHaveLength(2);
  });
  it.each([
    ["tokio::time::timeout::Timeout::poll", "tokio::time::sleep::Sleep::poll"],
    ["hyper_util::server::graceful::Watcher::watch", "tokio::sync::notify::Notified"],
  ])("demotes a secondary leaf only under the shared wrapper %s", (wrapper, leaf) => {
    const secondary = stack("root", wrapper, leaf);
    expect(selectRepresentative([secondary, stack("root", wrapper, "work")]).stack.at(-1)).toBe("work");
    expect(selectRepresentative([secondary, stack("root", "other")]).stack.at(-1)).toMatch(/^\[awaiting any of 2\]/);
  });
  it("uses source provenance rather than unfamiliar names as ownership evidence", () => {
    const app = [frame("service::request", "src/main.rs")];
    const dep = [frame("client::request", "/home/build/.cargo/registry/src/client/src/lib.rs")];
    expect(selectRepresentative([dep, app]).stack).toEqual(["service::request"]);
    expect(selectRepresentative([stack("unknown::a"), stack("unknown::b")]).stack[0]).toMatch(/^\[awaiting any of 2\]/);
  });
});
