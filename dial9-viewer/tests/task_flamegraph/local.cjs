// Exercise the same parser, poll attribution and profile builder as task detail.
const fs = require("node:fs");
const zlib = require("node:zlib");
const { parseTrace, EVENT_TYPES } = require("../../ui/trace_parser.js");
const { buildWorkerSpans, attachCpuSamples } = require("../../ui/trace_analysis.js");
const { localTaskProfile } = require("../../ui/task_flamegraph.js");

async function main() {
  const [task, start, end, ...paths] = process.argv.slice(2);
  const bytes = paths.map((path) => {
    const data = fs.readFileSync(path);
    return data[0] === 0x1f && data[1] === 0x8b ? zlib.gunzipSync(data) : data;
  });
  const trace = await parseTrace(Buffer.concat(bytes));
  const workers = [...new Set(trace.events.filter((e) => e.eventType === EVENT_TYPES.PollStart).map((e) => e.workerId))];
  const { workerSpans } = buildWorkerSpans(trace.events, workers, trace.maxTs, trace.blockInPlaceGaps);
  attachCpuSamples(trace.cpuSamples, workerSpans);
  const polls = Object.values(workerSpans).flatMap((w) => w.polls).filter((p) => p.taskId === Number(task));
  process.stdout.write(JSON.stringify(localTaskProfile(trace, Number(task), polls, Number(start), Number(end))));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
