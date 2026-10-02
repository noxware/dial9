import { formatFrame, type FlamegraphNode, type TaskProfileNode } from "../../lib/trace/index.js";

export function mixedDisplayTree(node: TaskProfileNode, domain?: "cpu" | "idle"): FlamegraphNode {
  if (node.name === "[on-cpu]") domain = "cpu";
  if (node.name === "[idle-at-await]") domain = "idle";
  return {
    name: formatFrame({ symbol: node.name, location: null }).text,
    fullName: node.name,
    count: node.weight_ns,
    self: node.self_ns,
    ...(domain ? { domain } : {}),
    children: new Map(Object.entries(node.children).map(([key, child]) => [key, mixedDisplayTree(child, domain)])),
  };
}

export function captureAlternatives(root: TaskProfileNode): TaskProfileNode[] {
  const result: TaskProfileNode[] = [];
  function visit(node: TaskProfileNode): void {
    if ((node.alternatives?.length ?? 0) > 1) result.push(node);
    for (const child of Object.values(node.children)) visit(child);
  }
  visit(root);
  return result;
}

export function mixedUnavailable(reason: string): string {
  switch (reason) {
    case "time_filtered_trace": return "Set Range discarded poll context needed to compare CPU and waits. Clear the range filter, then zoom to the desired interval.";
    case "truncated_trace": return "The event limit discarded poll context needed to compare CPU and waits. Reload with a higher event limit.";
    case "missing_idle_intervals": return "This older experimental trace has no completed wait intervals.";
    case "missing_cpu_frequency": return "CPU sampling frequency is missing; CPU and waits cannot be compared in time units.";
    case "missing_or_conflicting_activation": return "Sampling coverage is unknown for a worker that ran this task.";
    case "outside_sampling_coverage": return "The visible range is before sampling began.";
    case "conflicting_metadata": return "This trace combines conflicting recording or sampling metadata.";
    case "missing_poll_boundaries": return "Poll boundaries are missing for this task.";
    case "missing_clock_sync": return "Clock synchronization is missing from this trace.";
    default: return "No usable experimental task samples overlap the visible range.";
  }
}
