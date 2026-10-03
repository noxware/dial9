declare module "*/task_flamegraph.js" {
  import type { ParsedTrace } from "*/trace_parser.js";
  import type { PollSpan } from "*/trace_analysis.js";
  export interface TaskProfileNode {
    name: string;
    weight_ns: number;
    self_ns: number;
    children: Record<string, TaskProfileNode>;
    alternatives?: { name: string; file: string | null }[][];
  }
  export interface TaskProfile {
    unit: "nanoseconds";
    task_id: string;
    start_ns: number;
    end_ns: number;
    effective_start_ns: number | null;
    cpu_ns: number;
    idle_ns: number;
    cpu_samples: number;
    capture_groups: number;
    incomplete_capture_groups: number;
    invalid_capture_groups: number;
    tree: TaskProfileNode | null;
    unavailable_reason: string | null;
    limitations: string[];
  }
  export function localTaskProfile(trace: ParsedTrace, taskId: number, polls: readonly PollSpan[], startNs: number, endNs: number): TaskProfile;
}
