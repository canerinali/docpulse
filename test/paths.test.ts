import { describe, expect, it } from 'vitest';
import {
  ARRAY_MARKER,
  escapeKey,
  isArrayElementPath,
  joinPath,
  unescapeKey,
  walkDocument,
  type PathEvent,
  type ValueEvent,
} from '../src/core/paths.js';

function values(events: PathEvent[]): ValueEvent[] {
  return events.filter((e): e is ValueEvent => e.kind === 'value');
}

function pathsOf(doc: Record<string, unknown>): string[] {
  return values(walkDocument(doc)).map((e) => e.path);
}

function valueAt(doc: Record<string, unknown>, path: string): ValueEvent[] {
  return values(walkDocument(doc)).filter((e) => e.path === path);
}

describe('walkDocument', () => {
  it('flattens a flat document', () => {
    const events = walkDocument({ a: 1, b: 'x', c: true });
    expect(pathsOf({ a: 1, b: 'x', c: true })).toEqual(['a', 'b', 'c']);
    expect(values(events).map((e) => [e.path, e.bsonType, e.denominator])).toEqual([
      ['a', 'int', 'documents'],
      ['b', 'string', 'documents'],
      ['c', 'bool', 'documents'],
    ]);
  });

  it('joins nested objects with a dot and emits the object itself', () => {
    expect(pathsOf({ customer: { taxId: 'x', address: { city: 'IST' } } })).toEqual([
      'customer',
      'customer.taxId',
      'customer.address',
      'customer.address.city',
    ]);
  });

  it('yields both the array and its elements for an array of scalars', () => {
    const events = walkDocument({ tags: ['a', 'b'] });
    expect(pathsOf({ tags: ['a', 'b'] })).toEqual([
      'tags',
      `tags.${ARRAY_MARKER}`,
      `tags.${ARRAY_MARKER}`,
    ]);
    expect(events).toContainEqual({ kind: 'arrayLength', path: 'tags', count: 2 });

    const elements = values(events).filter((e) => e.path === `tags.${ARRAY_MARKER}`);
    expect(elements).toHaveLength(2);
    for (const element of elements) {
      expect(element.denominator).toBe('arrayElements');
      expect(element.arrayParent).toBe('tags');
      expect(element.bsonType).toBe('string');
    }
  });

  it('descends into array elements that are objects', () => {
    const doc = { lines: [{ sku: 'A', qty: 2 }, { sku: 'B' }] };
    expect(pathsOf(doc)).toEqual([
      'lines',
      'lines.items[]',
      'lines.items[].sku',
      'lines.items[].qty',
      'lines.items[]',
      'lines.items[].sku',
    ]);
    const sku = valueAt(doc, 'lines.items[].sku');
    expect(sku).toHaveLength(2);
    expect(sku[0]?.denominator).toBe('arrayElements');
    expect(sku[0]?.arrayParent).toBe('lines');
  });

  it('marks nested arrays with a second items[] segment and the nearest parent', () => {
    const doc = { lines: [{ tags: ['x', 'y'] }] };
    expect(pathsOf(doc)).toEqual([
      'lines',
      'lines.items[]',
      'lines.items[].tags',
      'lines.items[].tags.items[]',
      'lines.items[].tags.items[]',
    ]);
    const leaves = valueAt(doc, 'lines.items[].tags.items[]');
    expect(leaves).toHaveLength(2);
    expect(leaves[0]?.arrayParent).toBe('lines.items[].tags');

    // The intermediate array is itself denominated in the *outer* array's elements.
    const tags = valueAt(doc, 'lines.items[].tags')[0];
    expect(tags?.denominator).toBe('arrayElements');
    expect(tags?.arrayParent).toBe('lines');
  });

  it('handles an array directly inside an array', () => {
    expect(pathsOf({ matrix: [[1, 2]] })).toEqual([
      'matrix',
      'matrix.items[]',
      'matrix.items[].items[]',
      'matrix.items[].items[]',
    ]);
  });

  it('adds zero child units for an empty array', () => {
    const events = walkDocument({ lines: [] });
    expect(events).toContainEqual({ kind: 'arrayLength', path: 'lines', count: 0 });
    expect(values(events).map((e) => e.path)).toEqual(['lines']);
    expect(values(events)[0]?.bsonType).toBe('array');
  });

  it('records null and empty string as present, and undefined as missing', () => {
    const events = values(walkDocument({ a: null, b: '', c: undefined, d: 0 }));
    expect(events.map((e) => e.path)).toEqual(['a', 'b', 'd']);
    expect(events[0]).toMatchObject({ bsonType: 'null', isNull: true, isEmptyString: false });
    expect(events[1]).toMatchObject({ bsonType: 'string', isNull: false, isEmptyString: true });
    expect(events[2]).toMatchObject({ bsonType: 'int', isNull: false, isEmptyString: false });
  });

  it('does not descend into Date or RegExp values', () => {
    expect(pathsOf({ at: new Date(0), re: /x/ })).toEqual(['at', 're']);
  });

  it('stops at maxDepth instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    const paths = values(walkDocument(cyclic, { maxDepth: 3 })).map((e) => e.path);
    expect(paths.length).toBeLessThan(20);
    expect(paths).toContain('self');
  });
});

describe('key escaping', () => {
  it('escapes a literal dot so the path stays unambiguous', () => {
    expect(escapeKey('a.b')).toBe('a\\.b');
    expect(pathsOf({ 'a.b': 1 })).toEqual(['a\\.b']);
    expect(pathsOf({ outer: { 'a.b': 1 } })).toEqual(['outer', 'outer.a\\.b']);
  });

  it('escapes backslashes and brackets too, so `items[]` can never collide', () => {
    expect(escapeKey('items[]')).toBe('items\\[]');
    expect(escapeKey('a\\b')).toBe('a\\\\b');
    expect(pathsOf({ 'items[]': 1 })).toEqual(['items\\[]']);
  });

  it('round-trips through unescapeKey', () => {
    for (const key of ['a.b', 'items[]', 'a\\b', 'plain']) {
      expect(unescapeKey(escapeKey(key))).toBe(key);
    }
  });

  it('joins onto an empty parent without a leading dot', () => {
    expect(joinPath('', 'a')).toBe('a');
    expect(joinPath('a', 'b')).toBe('a.b');
  });
});

describe('isArrayElementPath', () => {
  it('detects the items[] marker', () => {
    expect(isArrayElementPath('lines')).toBe(false);
    expect(isArrayElementPath('lines.items[]')).toBe(true);
    expect(isArrayElementPath('lines.items[].sku')).toBe(true);
    // An escaped literal key named `items[]` is not the marker.
    expect(isArrayElementPath('a.items\\[]')).toBe(false);
  });
});

describe('untrusted document keys', () => {
  it('treats __proto__, constructor and prototype as ordinary keys', () => {
    const doc = JSON.parse(
      '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"p2":"yes"}},"a":1}',
    ) as Record<string, unknown>;
    const paths = walkDocument(doc)
      .filter((e): e is ValueEvent => e.kind === 'value')
      .map((e) => e.path);

    expect(paths).toContain('__proto__');
    expect(paths).toContain('__proto__.polluted');
    expect(paths).toContain('constructor.prototype.p2');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p2).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
  });
});
