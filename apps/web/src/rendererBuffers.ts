export const SHELL_MAX_STREAM_CODE_UNITS = 256_000;
export const SHELL_MAX_EVENT_ROWS = 500;
export const SHELL_STREAM_TRUNCATION_MARKER = "[Earlier output truncated]\n";

export function appendBoundedStreamText(
  current: string,
  addition: string,
  maxCodeUnits = SHELL_MAX_STREAM_CODE_UNITS
): string {
  assertPositiveSafeInteger(maxCodeUnits, "Stream limit");
  if (maxCodeUnits <= SHELL_STREAM_TRUNCATION_MARKER.length) {
    throw new RangeError("Stream limit must leave room for truncated output");
  }

  if (current.length + addition.length <= maxCodeUnits) {
    return current + addition;
  }

  const tailLimit = maxCodeUnits - SHELL_STREAM_TRUNCATION_MARKER.length;
  let tail: string;
  if (addition.length >= tailLimit) {
    tail = takeWholeUnicodeTail(addition, tailLimit);
  } else {
    const currentTailLimit = tailLimit - addition.length;
    tail = takeWholeUnicodeTail(current, currentTailLimit) + addition;
  }

  return SHELL_STREAM_TRUNCATION_MARKER + tail;
}

export function appendBoundedItem<T>(
  current: readonly T[],
  item: T,
  maxItems = SHELL_MAX_EVENT_ROWS
): T[] {
  assertPositiveSafeInteger(maxItems, "Item limit");
  if (maxItems === 1) return [item];
  if (current.length < maxItems) return [...current, item];
  return [...current.slice(-(maxItems - 1)), item];
}

function takeWholeUnicodeTail(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) return value;

  let start = value.length - maxCodeUnits;
  if (
    start > 0 &&
    isLowSurrogate(value.charCodeAt(start)) &&
    isHighSurrogate(value.charCodeAt(start - 1))
  ) {
    start += 1;
  }
  return value.slice(start);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
