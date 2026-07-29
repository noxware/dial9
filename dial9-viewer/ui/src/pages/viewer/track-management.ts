// Per-track collapse + drag-reorder for the unified track column. This module
// owns:
//
//   - which tracks are user-manageable (collapse + reorder). Structural and
//     selection-only tracks remain fixed.
//   - the ordering resolution (uiPrefs.trackOrder -> the ordered TrackSpec
//     list), robust to unknown/missing ids so a stored order predating a new
//     track still resolves.
//   - the reorder swap (drop = swap position).
//   - the collapse predicate + label-only height.
//   - the store actions (toggle collapse / reorder) the shell's caret + grip
//     handlers dispatch.
//   - localStorage persistence. Field-chart layout is URL-owned and excluded.
//
// Track pinning is out of scope. This operates on the track list/order +
// per-track height only; it does not touch the per-track render delegation.

import type { ViewerStore } from "../../store/store.js";
import { TRACKS } from "../../lib/canvas/track-layout.js";
import type { TrackId, TrackSpec } from "../../lib/canvas/track-layout.js";
import {
  compareFieldChartIds,
  isFieldChartId,
} from "./field-chart-model.js";

/** Collapsed (label-only) track height in CSS px. */
export const COLLAPSED_TRACK_H = 36;

/**
 * The tracks the user can collapse + reorder: the foldable analysis surfaces
 * (spans/events/cpu/queue; task-detail is NOT foldable). The structural tracks
 * (timeline/lanes) host the shared axis + worker rows and stay pinned at the
 * top. Order here is irrelevant (membership only).
 */
export const MANAGEABLE_TRACK_IDS: readonly TrackId[] = [
  "cpu",
  "queue",
  "spans",
  "events",
];

const STATIC_MANAGEABLE = new Set<string>(MANAGEABLE_TRACK_IDS);

function isLocallyPersistedTrackId(id: string): boolean {
  return !isFieldChartId(id);
}

/** True when a currently-present track can be collapsed and reordered. */
export function isManageableTrack(
  id: string,
  dynamicIds: readonly string[] = [],
): boolean {
  return (
    STATIC_MANAGEABLE.has(id) ||
    (isFieldChartId(id) && dynamicIds.includes(id))
  );
}

/**
 * True when track `id` is currently collapsed: manageable AND explicitly
 * flagged in the collapse map. Non-manageable tracks (timeline/lanes/
 * task-detail) are never collapsed, whatever the map says.
 */
export function isCollapsed(
  collapsed: Readonly<Record<string, boolean>>,
  id: string,
  dynamicIds: readonly string[] = [],
): boolean {
  return isManageableTrack(id, dynamicIds) && collapsed[id] === true;
}

/**
 * Resolve the order of the manageable block. URL order wins; missing static
 * tracks follow in catalogue order and missing field charts in numeric id
 * order. Unknown, pinned and duplicate ids are ignored.
 */
export function orderedManagedTrackIds(
  trackOrder: readonly string[],
  dynamicIds: readonly string[] = [],
): string[] {
  const dynamic = [...new Set(dynamicIds)]
    .filter(
      (id) => isFieldChartId(id) && !STATIC_MANAGEABLE.has(id),
    )
    .sort(compareFieldChartIds);
  const candidates = [...MANAGEABLE_TRACK_IDS, ...dynamic];
  const allowed = new Set(candidates);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of trackOrder) {
    if (allowed.has(id) && !seen.has(id)) {
      ordered.push(id);
      seen.add(id);
    }
  }
  for (const id of candidates) {
    if (!seen.has(id)) ordered.push(id);
  }
  return ordered;
}

/**
 * Resolve `uiPrefs.trackOrder` into the full ordered TrackSpec list. The
 * structural tracks (timeline/lanes) and task-detail keep their catalogue
 * positions; only the manageable analysis tracks are permuted, in the stored
 * order. Robust to a stale/partial/dirty stored order:
 *   - unknown ids and non-manageable ids in `trackOrder` are ignored;
 *   - duplicates are de-duped (first occurrence wins);
 *   - manageable tracks not named in `trackOrder` are appended in catalogue
 *     order (so a stored order predating a newly added track still shows it).
 * The manageable tracks fill their catalogue SLOTS in the resolved order, so
 * the fixed tracks never move.
 */
export function orderedTracks(
  trackOrder: readonly string[],
): readonly TrackSpec[] {
  const catalogueManageable = TRACKS.filter((t) => isManageableTrack(t.id));
  const byId = new Map(catalogueManageable.map((t) => [t.id, t] as const));
  const managed = orderedManagedTrackIds(trackOrder)
    .map((id) => byId.get(id as TrackId))
    .filter((track): track is TrackSpec => track !== undefined);
  // Re-lay the catalogue, drawing manageable slots from `managed` in order.
  let mi = 0;
  return TRACKS.map((t) =>
    isManageableTrack(t.id) ? (managed[mi++] as TrackSpec) : t,
  );
}

/**
 * Compute the new trackOrder after dropping `dragged` onto `target`: swap the
 * two tracks' positions. A no-op (returns the current manageable order) when
 * either id is not manageable or they are the same track.
 */
export function computeReorder(
  trackOrder: readonly string[],
  dragged: string,
  target: string,
  dynamicIds: readonly string[] = [],
): string[] {
  const order = orderedManagedTrackIds(trackOrder, dynamicIds);
  if (
    dragged === target ||
    !isManageableTrack(dragged, dynamicIds) ||
    !isManageableTrack(target, dynamicIds)
  ) {
    return order;
  }
  const i = order.indexOf(dragged);
  const j = order.indexOf(target);
  if (i < 0 || j < 0) return order;
  const swapped = order.slice();
  [swapped[i], swapped[j]] = [swapped[j]!, swapped[i]!];
  return swapped;
}

/** Remove deleted dynamic tracks from both layout channels. */
export function removeTrackIdsFromLayout(
  trackOrder: readonly string[],
  collapsed: Readonly<Record<string, boolean>>,
  removedIds: readonly string[],
): { trackOrder: string[]; collapsed: Record<string, boolean> } {
  const removed = new Set(removedIds);
  return {
    trackOrder: trackOrder.filter((id) => !removed.has(id)),
    collapsed: Object.fromEntries(
      Object.entries(collapsed).filter(([id]) => !removed.has(id)),
    ),
  };
}

// ── Store actions ────────────────────────────────────────────────────────

/** The collapse/reorder dispatchers the shell's caret + grip handlers call. */
export interface TrackManageActions {
  /** Toggle a track's collapsed state (caret click / Enter / Space). */
  toggleCollapse(id: string): void;
  /** Reorder: drop `dragged` onto `target`, swapping their positions. */
  reorder(dragged: string, target: string): void;
}

/** Bind the track-management actions to a store (dispatch uiPrefs updates). */
export function createTrackManageActions(store: ViewerStore): TrackManageActions {
  return {
    toggleCollapse(id: string): void {
      const dynamicIds = store.getState().view.fieldCharts.map(
        (chart) => chart.id,
      );
      if (!isManageableTrack(id, dynamicIds)) return;
      const cur = store.getState().uiPrefs.collapsed;
      store.update("uiPrefs", {
        collapsed: { ...cur, [id]: !(cur[id] === true) },
      });
    },
    reorder(dragged: string, target: string): void {
      const dynamicIds = store.getState().view.fieldCharts.map(
        (chart) => chart.id,
      );
      const cur = store.getState().uiPrefs.trackOrder;
      const next = computeReorder(cur, dragged, target, dynamicIds);
      // Only write on an actual change (no store thrash / needless render).
      // Compare against the RESOLVED current order, not the raw stored value:
      // a same-track drop with an empty stored order must not normalize-write.
      if (sameOrder(orderedManagedTrackIds(cur, dynamicIds), next)) return;
      store.update("uiPrefs", { trackOrder: next });
    },
  };
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Toggle a runtime group's folded state by NAME (a click on its lanes header
 * band). Folding drops that runtime's worker rows from the lanes stack (its
 * header stays, so it can be unfolded); the change persists via the uiPrefs ->
 * trackPrefs subscriber. Standalone (not on TrackManageActions) because the
 * lanes interaction layer dispatches it directly, without the track strip.
 */
export function toggleRuntimeCollapsed(store: ViewerStore, name: string): void {
  const cur = store.getState().uiPrefs.collapsedRuntimes;
  store.update("uiPrefs", {
    collapsedRuntimes: { ...cur, [name]: !(cur[name] === true) },
  });
}

// ── localStorage persistence (survives reload) ─────────────────────────────
//
// A try/catch around localStorage with an in-memory fallback map, so a
// storage-blocked context (private mode, disabled storage) degrades to
// session-scoped prefs instead of throwing. Stored as ONE JSON blob under a
// single key.

/** localStorage key for the serialized track prefs. */
export const TRACK_PREFS_STORAGE_KEY = "dial9.viewer.trackPrefs";

/** The persisted shape: the manageable order + the collapse map + the per-runtime
 *  fold map + the lanes box height. `lanesHeight` and `collapsedRuntimes` are
 *  optional so prefs written before they existed still parse (the store keeps its
 *  default when absent). */
export interface TrackPrefs {
  trackOrder: readonly string[];
  collapsed: Readonly<Record<string, boolean>>;
  collapsedRuntimes?: Readonly<Record<string, boolean>>;
  lanesHeight?: number;
}

/** Coerce an unknown value into a `Record<string, boolean>`, keeping only the
 *  boolean-valued entries. A non-object yields an empty map. Shared by the
 *  `collapsed` (track) + `collapsedRuntimes` (runtime) fold maps. */
function parseBoolMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

const memoryFallback = new Map<string, string>();

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return memoryFallback.has(key) ? (memoryFallback.get(key) ?? null) : null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {
    memoryFallback.set(key, value);
  }
}

/**
 * Read persisted track prefs, excluding URL-owned field-chart ids.
 */
export function loadTrackPrefs(): TrackPrefs | null {
  const raw = storageGet(TRACK_PREFS_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const obj = parsed as { trackOrder?: unknown; collapsed?: unknown };
    const trackOrder = Array.isArray(obj.trackOrder)
      ? obj.trackOrder.filter(
          (value): value is string =>
            typeof value === "string" && isLocallyPersistedTrackId(value),
        )
      : [];
    const collapsed = Object.fromEntries(
      Object.entries(parseBoolMap(obj.collapsed)).filter(([id]) =>
        isLocallyPersistedTrackId(id),
      ),
    );
    const cr = (obj as { collapsedRuntimes?: unknown }).collapsedRuntimes;
    const collapsedRuntimes = cr !== undefined ? parseBoolMap(cr) : undefined;
    const lh = (obj as { lanesHeight?: unknown }).lanesHeight;
    const lanesHeight =
      typeof lh === "number" && Number.isFinite(lh) && lh > 0
        ? lh
        : undefined;
    return {
      trackOrder,
      collapsed,
      ...(collapsedRuntimes !== undefined ? { collapsedRuntimes } : {}),
      ...(lanesHeight !== undefined ? { lanesHeight } : {}),
    };
  } catch {
    return null;
  }
}

/** Persist track prefs, excluding URL-owned field-chart ids. */
export function saveTrackPrefs(prefs: TrackPrefs): void {
  const trackOrder = prefs.trackOrder.filter((id) =>
    isLocallyPersistedTrackId(id),
  );
  const collapsed = Object.fromEntries(
    Object.entries(prefs.collapsed).filter(([id]) =>
      isLocallyPersistedTrackId(id),
    ),
  );
  storageSet(
    TRACK_PREFS_STORAGE_KEY,
    JSON.stringify({
      trackOrder,
      collapsed,
      ...(prefs.collapsedRuntimes !== undefined
        ? { collapsedRuntimes: prefs.collapsedRuntimes }
        : {}),
      ...(prefs.lanesHeight !== undefined
        ? { lanesHeight: prefs.lanesHeight }
        : {}),
    }),
  );
}

/**
 * Seed the store's uiPrefs from persisted track prefs (call once on boot,
 * BEFORE the shell's first render, so the initial paint reflects the saved
 * order/collapse). A no-op when nothing is stored (the store keeps its resting
 * defaults). Dispatches a single uiPrefs update.
 */
export function hydrateTrackPrefs(store: ViewerStore): void {
  const prefs = loadTrackPrefs();
  if (prefs === null) return;
  store.update("uiPrefs", {
    trackOrder: prefs.trackOrder,
    collapsed: prefs.collapsed,
    // Only override the store defaults when the field was actually stored (prefs
    // written before these existed keep the resting default).
    ...(prefs.collapsedRuntimes !== undefined
      ? { collapsedRuntimes: prefs.collapsedRuntimes }
      : {}),
    ...(prefs.lanesHeight !== undefined
      ? { lanesViewportHeight: prefs.lanesHeight }
      : {}),
  });
}

/**
 * Persist trackOrder/collapsed whenever they change. Subscribes to the
 * uiPrefs slice and writes the two fields on every uiPrefs update (cheap - a
 * small JSON blob). Returns an unsubscribe for teardown/HMR. Pair with
 * hydrateTrackPrefs (hydrate first, then mount this) so the reload round-trip
 * is closed: hydrate reads what a previous session's subscriber wrote.
 */
export function mountTrackPrefsPersistence(store: ViewerStore): () => void {
  return store.subscribe(["uiPrefs"], (state) => {
    const {
      trackOrder,
      collapsed,
      collapsedRuntimes,
      lanesViewportHeight,
    } = state.uiPrefs;
    saveTrackPrefs({
      trackOrder,
      collapsed,
      collapsedRuntimes,
      lanesHeight: lanesViewportHeight,
    });
  });
}
