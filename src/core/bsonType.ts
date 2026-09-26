import type { BsonTypeName } from './types.js';

/** BSON wrapper classes carry a `_bsontype` tag that survives deserialization. */
const BSONTYPE_MAP: Record<string, BsonTypeName> = {
  ObjectId: 'objectId',
  ObjectID: 'objectId',
  Decimal128: 'decimal',
  Long: 'long',
  Int32: 'int',
  Double: 'double',
  Binary: 'binData',
  UUID: 'binData',
  Timestamp: 'timestamp',
  BSONRegExp: 'regex',
  Code: 'javascript',
  BSONSymbol: 'symbol',
  Symbol: 'symbol',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
};

/**
 * `_bsontype` is trusted only on a value that is *not* a plain object.
 *
 * A real BSON wrapper (ObjectId, Decimal128, …) is a class instance, so its
 * prototype is not `Object.prototype`. A document may legitimately store a
 * field literally named `_bsontype`, and honouring that would make docpulse
 * report the containing object as a scalar and stop walking into it — an
 * upstream producer could hide every field under it from the snapshot, which
 * is exactly the drift docpulse exists to catch.
 */
function hasBsonTag(value: object): string | undefined {
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === null || proto === Object.prototype) return undefined;
  const tag = (value as { _bsontype?: unknown })._bsontype;
  return typeof tag === 'string' && tag.length > 0 ? tag : undefined;
}

/** `DBRef` -> `dbRef`, so an unmapped wrapper still gets an honest name. */
function camelize(tag: string): string {
  if (tag.length > 1 && tag === tag.toUpperCase()) return tag.toLowerCase();
  return tag.charAt(0).toLowerCase() + tag.slice(1);
}

/**
 * Canonical BSON type name of `value`, or `undefined` when the value is
 * *missing* (`undefined`) — missing is not a type, it is the absence of one.
 *
 * Integral JS numbers are reported as `int` and non-integral ones as `double`:
 * after deserialization the driver genuinely cannot distinguish an `int32` from
 * an integral `double`, which is why the diff (not the snapshot) can collapse
 * numeric types via `treatNumericTypesAsEquivalent`.
 */
export function bsonTypeOf(value: unknown): BsonTypeName | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';

  const t = typeof value;

  if (t === 'string') return 'string';
  if (t === 'boolean') return 'bool';
  if (t === 'bigint') return 'long';
  if (t === 'symbol') return 'symbol';
  if (t === 'function') return 'javascript';
  if (t === 'number') {
    return Number.isInteger(value as number) ? 'int' : 'double';
  }

  // Objects: `_bsontype` first, so Timestamp (which extends Long) and UUID
  // (which extends Binary) are not mistaken for their base classes.
  const tag = hasBsonTag(value as object);
  if (tag !== undefined) return BSONTYPE_MAP[tag] ?? camelize(tag);

  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (value instanceof RegExp) return 'regex';
  if (value instanceof Uint8Array || ArrayBuffer.isView(value)) return 'binData';
  if (value instanceof ArrayBuffer) return 'binData';
  if (value instanceof Map || value instanceof Set) return 'object';

  return 'object';
}

/**
 * True when `type` is one of the four numeric BSON types the diff may collapse
 * to a single `number` bucket.
 */
export function isNumericBsonType(type: string): boolean {
  return type === 'int' || type === 'long' || type === 'double' || type === 'decimal';
}

/** Collapse numeric types to `number`; identity for everything else. */
export function collapseNumericType(type: string): string {
  return isNumericBsonType(type) ? 'number' : type;
}
