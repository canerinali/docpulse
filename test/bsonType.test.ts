import { describe, expect, it } from 'vitest';
import {
  BSONRegExp,
  BSONSymbol,
  Binary,
  Code,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
} from 'mongodb';
import {
  bsonTypeOf,
  collapseNumericType,
  isNumericBsonType,
} from '../src/core/bsonType.js';
import { CANONICAL_BSON_TYPES } from '../src/core/types.js';

describe('bsonTypeOf', () => {
  it('names all 16 canonical BSON types', () => {
    const cases: Array<[string, unknown]> = [
      ['array', [1, 2, 3]],
      ['binData', new Binary(Buffer.from('abc'))],
      ['bool', true],
      ['date', new Date('2026-09-26T00:00:00.000Z')],
      ['decimal', Decimal128.fromString('1.5')],
      ['double', new Double(1.5)],
      ['int', new Int32(3)],
      ['javascript', new Code('function () {}')],
      ['long', Long.fromString('9007199254740993')],
      ['null', null],
      ['object', { a: 1 }],
      ['objectId', new ObjectId()],
      ['regex', new BSONRegExp('^a', 'i')],
      ['string', 'hello'],
      ['symbol', new BSONSymbol('sym')],
      ['timestamp', new Timestamp({ t: 1, i: 1 })],
    ];

    expect(cases.map(([name]) => name)).toEqual([...CANONICAL_BSON_TYPES]);
    expect(cases).toHaveLength(16);

    for (const [expected, value] of cases) {
      expect(bsonTypeOf(value), `value for ${expected}`).toBe(expected);
    }
  });

  it('treats undefined as missing, not as a type', () => {
    expect(bsonTypeOf(undefined)).toBeUndefined();
  });

  it('splits plain JS numbers into int and double by integrality', () => {
    expect(bsonTypeOf(3)).toBe('int');
    expect(bsonTypeOf(-7)).toBe('int');
    expect(bsonTypeOf(0)).toBe('int');
    expect(bsonTypeOf(1.5)).toBe('double');
    expect(bsonTypeOf(Number.NaN)).toBe('double');
    expect(bsonTypeOf(Number.POSITIVE_INFINITY)).toBe('double');
  });

  it('maps native JS values that MongoDB round-trips', () => {
    expect(bsonTypeOf(new Date())).toBe('date');
    expect(bsonTypeOf(/x/g)).toBe('regex');
    expect(bsonTypeOf(Buffer.from('x'))).toBe('binData');
    expect(bsonTypeOf(new Uint8Array([1, 2]))).toBe('binData');
    expect(bsonTypeOf(10n)).toBe('long');
    expect(bsonTypeOf('')).toBe('string');
    expect(bsonTypeOf([])).toBe('array');
    expect(bsonTypeOf({})).toBe('object');
  });

  it('checks _bsontype before instanceof so subclasses are not mislabelled', () => {
    // Timestamp extends Long; UUID extends Binary.
    expect(bsonTypeOf(new Timestamp({ t: 2, i: 2 }))).toBe('timestamp');
    expect(bsonTypeOf(Long.fromString('12'))).toBe('long');
  });

  it('ignores a _bsontype field stored in a plain document object', () => {
    // A producer can legitimately store a field called `_bsontype`. Trusting it
    // would report the object as a scalar and hide every field under it.
    expect(bsonTypeOf({ _bsontype: 'ObjectId', hidden: 1 })).toBe('object');
    expect(bsonTypeOf({ _bsontype: 'Decimal128' })).toBe('object');
    expect(bsonTypeOf(Object.assign(Object.create(null), { _bsontype: 'ObjectId' }))).toBe('object');
  });

  it('gives exotic BSON wrappers an honest name instead of "unknown"', () => {
    expect(bsonTypeOf(new MinKey())).toBe('minKey');
    expect(bsonTypeOf(new MaxKey())).toBe('maxKey');
  });
});

describe('numeric collapsing', () => {
  it('recognises exactly the four numeric BSON types', () => {
    expect(['int', 'long', 'double', 'decimal'].every(isNumericBsonType)).toBe(true);
    expect(['string', 'bool', 'null', 'array', 'object'].some(isNumericBsonType)).toBe(false);
  });

  it('collapses numerics to `number` and leaves the rest alone', () => {
    expect(collapseNumericType('int')).toBe('number');
    expect(collapseNumericType('decimal')).toBe('number');
    expect(collapseNumericType('string')).toBe('string');
  });
});
