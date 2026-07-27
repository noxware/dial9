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
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const tests: readonly (readonly [number, number])[] = [
    [-dx, segment.x1 - rectangle.left],
    [dx, rectangle.right - segment.x1],
    [-dy, segment.y1 - rectangle.top],
    [dy, rectangle.bottom - segment.y1],
  ];
  for (const [direction, distance] of tests) {
    if (direction === 0) {
      if (distance < 0) return undefined;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) {
      if (ratio > end) return undefined;
      start = Math.max(start, ratio);
    } else {
      if (ratio < start) return undefined;
      end = Math.min(end, ratio);
    }
  }
  return {
    x1: segment.x1 + start * dx,
    y1: segment.y1 + start * dy,
    x2: segment.x1 + end * dx,
    y2: segment.y1 + end * dy,
  };
}
