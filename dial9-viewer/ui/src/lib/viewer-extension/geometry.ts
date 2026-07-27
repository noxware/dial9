export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Rectangle {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export function normalizeValue(
  value: number,
  start: number,
  end: number,
): number {
  const scale = Math.max(
    1,
    Math.abs(value),
    Math.abs(start),
    Math.abs(end),
  );
  return (
    (value / scale - start / scale) /
    (end / scale - start / scale)
  );
}

export function interpolateValue(
  start: number,
  end: number,
  ratio: number,
): number {
  return (1 - ratio) * start + ratio * end;
}

export function pointToSegmentDistance(
  x: number,
  y: number,
  segment: Segment,
): number {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  if (dx === 0 && dy === 0) {
    return Math.hypot(x - segment.x1, y - segment.y1);
  }
  const ratio = Math.max(
    0,
    Math.min(
      1,
      ((x - segment.x1) * dx + (y - segment.y1) * dy) /
        (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(
    x - (segment.x1 + ratio * dx),
    y - (segment.y1 + ratio * dy),
  );
}

export function clipSegment(
  segment: Segment,
  rectangle: Rectangle,
): Segment | undefined {
  let start = 0;
  let end = 1;
  const clipAxis = (
    first: number,
    second: number,
    minimum: number,
    maximum: number,
  ): boolean => {
    if (first === second) return first >= minimum && first <= maximum;
    let enter = normalizeValue(minimum, first, second);
    let leave = normalizeValue(maximum, first, second);
    if (enter > leave) [enter, leave] = [leave, enter];
    start = Math.max(start, enter);
    end = Math.min(end, leave);
    return start <= end;
  };
  if (
    !clipAxis(segment.x1, segment.x2, rectangle.left, rectangle.right) ||
    !clipAxis(segment.y1, segment.y2, rectangle.top, rectangle.bottom)
  ) {
    return undefined;
  }
  const clamp = (value: number, minimum: number, maximum: number): number => {
    const clamped = Math.max(minimum, Math.min(maximum, value));
    const tolerance =
      Number.EPSILON *
      8 *
      Math.max(1, Math.abs(minimum), Math.abs(maximum));
    if (Math.abs(clamped - minimum) <= tolerance) return minimum;
    if (Math.abs(clamped - maximum) <= tolerance) return maximum;
    return clamped;
  };
  return {
    x1: clamp(
      interpolateValue(segment.x1, segment.x2, start),
      rectangle.left,
      rectangle.right,
    ),
    y1: clamp(
      interpolateValue(segment.y1, segment.y2, start),
      rectangle.top,
      rectangle.bottom,
    ),
    x2: clamp(
      interpolateValue(segment.x1, segment.x2, end),
      rectangle.left,
      rectangle.right,
    ),
    y2: clamp(
      interpolateValue(segment.y1, segment.y2, end),
      rectangle.top,
      rectangle.bottom,
    ),
  };
}
