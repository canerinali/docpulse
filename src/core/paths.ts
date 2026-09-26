import { bsonTypeOf } from './bsonType.js';
import type { BsonTypeName, Denominator } from './types.js';

/** The segment that marks "the elements of the array named by the prefix". */
export const ARRAY_MARKER = 'items[]';

/** Guard against pathological nesting (and any accidental cycle). */
export const DEFAULT_MAX_DEPTH = 24;

/** One observation of a value at a path. */
export interface ValueEvent {
  kind: 'value';
  path: string;
  denominator: Denominator;
  /** Path of the nearest enclosing array; set iff `denominator` is `arrayElements`. */
  arrayParent?: string;
  bsonType: BsonTypeName;
  isNull: boolean;
  isEmptyString: boolean;
}

/**
 * One array observation, carrying the number of elements it contributes to its
 * children's denominator. An empty array emits `count: 0`.
 */
export interface ArrayLengthEvent {
  kind: 'arrayLength';
  /** The array's own path, e.g. `lines`. */
  path: string;
  count: number;
}

export type PathEvent = ValueEvent | ArrayLengthEvent;

export interface WalkOptions {
  maxDepth?: number;
}

/**
 * Escape a real document key so a path segment can never be confused with
 * docpulse's own syntax: `.` separates segments and `items[]` marks array
 * elements, so a literal `.`, `[` or `\` inside a key is backslash-escaped.
 */
export function escapeKey(key: string): string {
  return key.replace(/\\/g, '\\\\').replace(/\./g, '\\.').replace(/\[/g, '\\[');
}

/** Inverse of {@link escapeKey}. */
export function unescapeKey(segment: string): string {
  return segment.replace(/\\(.)/g, '$1');
}

/** Join a parent path with an already-unescaped key. */
export function joinPath(parent: string, key: string): string {
  const escaped = escapeKey(key);
  return parent === '' ? escaped : `${parent}.${escaped}`;
}

/** True when `path` is denominated in array elements. */
export function isArrayElementPath(path: string): boolean {
  return path === ARRAY_MARKER || path.includes(`.${ARRAY_MARKER}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Flatten one document into path observations.
 *
 * Object nesting joins with `.`. An array at path `lines` yields both `lines`
 * itself (BSON type `array`, denominated in documents) and `lines.items[]` for
 * its elements; anything under an element continues from there, so nested
 * arrays give `lines.items[].tags.items[]`.
 */
export function walkDocument(
  doc: Record<string, unknown>,
  options: WalkOptions = {},
): PathEvent[] {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const events: PathEvent[] = [];

  const visit = (
    path: string,
    value: unknown,
    denominator: Denominator,
    arrayParent: string | undefined,
    depth: number,
  ): void => {
    const bsonType = bsonTypeOf(value);
    // `undefined` is *missing*: it increments nothing at all.
    if (bsonType === undefined) return;

    const event: ValueEvent = {
      kind: 'value',
      path,
      denominator,
      bsonType,
      isNull: bsonType === 'null',
      isEmptyString: value === '',
    };
    if (arrayParent !== undefined) event.arrayParent = arrayParent;
    events.push(event);

    if (depth >= maxDepth) return;

    if (bsonType === 'array') {
      const arr = value as unknown[];
      events.push({ kind: 'arrayLength', path, count: arr.length });
      const elementPath = `${path}.${ARRAY_MARKER}`;
      for (const element of arr) {
        visit(elementPath, element, 'arrayElements', path, depth + 1);
      }
      return;
    }

    if (bsonType === 'object' && isPlainRecord(value)) {
      for (const key of Object.keys(value)) {
        visit(joinPath(path, key), value[key], denominator, arrayParent, depth + 1);
      }
    }
  };

  for (const key of Object.keys(doc)) {
    visit(escapeKey(key), doc[key], 'documents', undefined, 0);
  }

  return events;
}
