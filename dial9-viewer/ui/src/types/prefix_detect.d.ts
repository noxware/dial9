// Type declarations for the frozen-core file `prefix_detect.js`
// (S3 prefix-discovery heuristics). See src/types/decode.d.ts for the
// declaration-form rationale.

declare module "*/prefix_detect.js" {
  /**
   * Last non-empty path segment of an S3 prefix.
   * "traces/date=2026-06-12/" -> "date=2026-06-12".
   */
  export function lastSegment(prefix: string): string;

  /**
   * Whether a listing's children are date partitions (`date=YYYY-MM-DD/` or
   * historical `YYYY-MM-DD/`) rather than genuine key prefixes (issue #471).
   */
  export function isDateLayer(
    prefixes: readonly string[] | null | undefined
  ): boolean;

  /**
   * The prefix to pre-select from a discovered listing, or `undefined` when
   * the user should choose. Returns `dial9-traces` when the listing offers it
   * (the conventional default), otherwise the sole prefix when there is
   * exactly one. Trailing slashes are stripped from the result.
   */
  export function preferredPrefix(
    prefixes: readonly string[] | null | undefined
  ): string | undefined;
}
