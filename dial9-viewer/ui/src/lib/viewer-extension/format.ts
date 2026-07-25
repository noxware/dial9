import type { Cell } from "./columnar.js";

export function formatDurationNs(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0ns";
  if (value < 1_000) return `${Math.round(value)}ns`;
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}µs`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}ms`;
  const seconds = value / 1e9;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${remainderSeconds.toFixed(1)}s`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes - hours * 60;
  if (hours < 24) {
    return `${hours}h ${remainderMinutes}m ${Math.floor(remainderSeconds)}s`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ${hours - days * 24}h ${remainderMinutes}m`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0 B";
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let scaled = value / 1024;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index += 1;
  }
  return `${scaled.toFixed(2)} ${units[index]}`;
}

export function formatExtensionValue(value: Cell, unit?: string): string {
  if (value === null) return "";
  if (unit === undefined || unit.length === 0) return String(value);
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  switch (unit) {
    case "ns":
      return formatDurationNs(numeric);
    case "us":
      return formatDurationNs(numeric * 1e3);
    case "ms":
      return formatDurationNs(numeric * 1e6);
    case "s":
      return formatDurationNs(numeric * 1e9);
    case "bytes":
      return formatBytes(numeric);
    case "%":
      return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : "-";
    default:
      return `${String(value)} ${unit}`;
  }
}

export function formatAxisValue(value: number): string {
  if (!Number.isFinite(value)) return "-";
  const magnitude = Math.abs(value);
  if (magnitude >= 1e9 || (magnitude > 0 && magnitude < 1e-3)) {
    return value.toExponential(1);
  }
  return value
    .toFixed(magnitude >= 10 ? 1 : 2)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}
