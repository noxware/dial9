// S3 trace-key parsing. The parser returns an explicit
// `{ layout: "unknown", rawKey }` variant for keys whose component count
// matches no documented layout, rather than silently falling back to
// positional parsing and shifting columns (which mislabeled fields, e.g. a
// 6-segment demo key showing Service=host-0, Host=abcd). The positional
// fallback survives ONLY for keys with no date-shaped segment at all (custom
// prefix schemes), where it was genuinely best-effort rather than a mislabel
// of a documented layout.

/** A key that matched a documented layout (or the positional fallback). */
export interface KnownTraceKey {
  layout: "known";
  service: string;
  host: string;
  /**
   * Boot id from the current layout; "" for the legacy layout and the
   * positional fallback, which carry no boot id on the path.
   */
  bootId: string;
  /**
   * Segment start (unix seconds) from the `{epoch}-{index}.bin[.gz]`
   * filename; 0 when the filename does not match that pattern.
   */
  epoch: number;
  /** Segment index from the filename; "" when the filename doesn't match. */
  segIndex: string;
}

/**
 * A key whose directory layout is unrecognized. No DIRECTORY field is
 * guessed: positionally shifting columns for these keys is the defect this
 * variant fixes. Callers surface the raw key instead. The FILENAME
 * convention (`{epoch}-{index}.bin[.gz]`) is independent of the directory
 * layout, so epoch/segIndex are still parsed when the filename matches (they
 * drive time placement and sorting, never a Service/Host/Boot label).
 */
export interface UnknownTraceKey {
  layout: "unknown";
  rawKey: string;
  /**
   * Segment start (unix seconds) from the `{epoch}-{index}.bin[.gz]`
   * filename; 0 when the filename does not match that pattern.
   */
  epoch: number;
  /** Segment index from the filename; "" when the filename doesn't match. */
  segIndex: string;
}

export type ParsedTraceKey = KnownTraceKey | UnknownTraceKey;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^(\d+)-(\d+)\.bin(?:\.gz)?$/;

function known(
  service: string,
  host: string,
  bootId: string,
  epoch: number,
  segIndex: string
): KnownTraceKey {
  return { layout: "known", service, host, bootId, epoch, segIndex };
}

/**
 * Parse an S3 trace key into service / host / boot / segment metadata.
 *
 * Default layout:
 *   {prefix}/date={YYYY-MM-DD}/time={HHMM}/service={service}/instance={instance}/boot={boot_id}/{epoch}-{index}.bin[.gz]
 * Historical layout (with boot id):
 *   {prefix}/{YYYY-MM-DD}/{HHMM}/{service}/{instance}/{boot_id}/{epoch}-{index}.bin[.gz]
 * Older historical layout (no boot id):
 *   {prefix}/{YYYY-MM-DD}/{HHMM}/{service}/{instance}/{epoch}-{index}.bin[.gz]
 *
 * Documented layouts are recognized from the filename backwards, so an opaque
 * prefix cannot be mistaken for a partition. Keys with a date-like segment but
 * no recognized suffix are `layout: "unknown"` (see the defect-fix note
 * above). Keys with no date-like segment fall back to best-effort positional
 * parsing when they have enough components, and are otherwise `unknown` too.
 *
 * Parsing is pure: call `formatEpoch(key.epoch, { localTz })` at render time
 * rather than reading a page-global timezone toggle.
 */
export function parseKey(key: string): ParsedTraceKey {
  const parts = key.split("/");
  const file = parts[parts.length - 1] ?? "";
  const match = FILE_RE.exec(file);
  let epoch = 0;
  let segIndex = "";
  if (match) {
    epoch = parseInt(match[1]!, 10);
    segIndex = match[2]!;
  }
  if (parts.length >= 6) {
    const start = parts.length - 6;
    const date = partitionValue(parts[start]!, "date");
    const time = partitionValue(parts[start + 1]!, "time");
    const service = partitionValue(parts[start + 2]!, "service");
    const instance = partitionValue(parts[start + 3]!, "instance");
    const boot = partitionValue(parts[start + 4]!, "boot");
    if (date !== undefined && time !== undefined && service !== undefined &&
        instance !== undefined && boot !== undefined) {
      if (date !== null && DATE_RE.test(date) && time !== null && TIME_RE.test(time) &&
          service !== null && instance !== null && boot !== null) {
        return known(service, instance, boot, epoch, segIndex);
      }
      return { layout: "unknown", rawKey: key, epoch, segIndex };
    }
    if (DATE_RE.test(parts[start]!) && TIME_RE.test(parts[start + 1]!)) {
      return known(
        parts[start + 2]!,
        parts[start + 3]!,
        parts[start + 4]!,
        epoch,
        segIndex
      );
    }
  }
  if (parts.length >= 5) {
    const start = parts.length - 5;
    if (DATE_RE.test(parts[start]!) && TIME_RE.test(parts[start + 1]!)) {
      return known(parts[start + 2]!, parts[start + 3]!, "", epoch, segIndex);
    }
  }
  if (parts.some((part) => DATE_RE.test(part) || part.startsWith("date="))) {
    return { layout: "unknown", rawKey: key, epoch, segIndex };
  }
  // No date-shaped segment anywhere: positional, best-effort (custom prefix
  // schemes).
  if (parts.length >= 5) {
    return known(
      parts[parts.length - 3]!,
      parts[parts.length - 2]!,
      "",
      epoch,
      segIndex
    );
  }
  return { layout: "unknown", rawKey: key, epoch, segIndex };
}

/**
 * Everything before a recognized source-key suffix. This is the authoritative
 * key prefix handed to aggregation endpoints; "" when no suffix is found.
 */
export function extractPrefix(key: string): string {
  const parts = key.split("/");
  if (parts.length >= 6) {
    const start = parts.length - 6;
    if (["date", "time", "service", "instance", "boot"].every(
      (name, offset) => parts[start + offset]!.startsWith(`${name}=`),
    )) return parts.slice(0, start).join("/");
    if (DATE_RE.test(parts[start]!) && TIME_RE.test(parts[start + 1]!)) {
      return parts.slice(0, start).join("/");
    }
  }
  if (parts.length >= 5) {
    const start = parts.length - 5;
    if (DATE_RE.test(parts[start]!) && TIME_RE.test(parts[start + 1]!)) {
      return parts.slice(0, start).join("/");
    }
  }
  return "";
}

const TIME_RE = /^\d{4}$/;

/** `undefined` means wrong field name; `null` means malformed escaping. */
function partitionValue(segment: string, name: string): string | null | undefined {
  const prefix = `${name}=`;
  if (!segment.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(segment.slice(prefix.length));
  } catch {
    return null;
  }
}

/** Formatting options shared by `formatEpoch` / `traceTitleParams`. */
export interface EpochFormatOptions {
  /**
   * Render in the browser's local timezone instead of UTC (default false /
   * UTC). Pages pass their live preference here.
   */
  localTz?: boolean;
}

/**
 * Format a unix-seconds epoch as "YYYY-MM-DD HH:MM:SS" (UTC by default,
 * local time with `localTz`). Returns "" for 0/missing epochs - the
 * "filename didn't carry an epoch" case, not a hidden error.
 */
export function formatEpoch(epoch: number, opts: EpochFormatOptions = {}): string {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  if (opts.localTz) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  }
  return d.toISOString().replace("T", " ").slice(0, 19);
}
