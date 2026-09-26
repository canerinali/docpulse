import { describe, expect, it } from 'vitest';
import {
  SERVER_JS_OPERATORS,
  parseJsonObjectFlag,
  parseSamplingFlags,
  type SnapshotOptions,
} from '../src/commands/snapshot.js';
import { DocpulseError } from '../src/errors.js';

const BASE: SnapshotOptions = {
  sampleSize: 1000,
  filter: '{}',
  sort: '{"_id":-1}',
};

describe('--filter rejects server-side JavaScript by default', () => {
  it.each(SERVER_JS_OPERATORS)('rejects %s at the top level', (operator) => {
    const raw = JSON.stringify({ [operator]: 'function () { return true; }' });
    const error = (() => {
      try {
        parseJsonObjectFlag(raw, '--filter');
        return null;
      } catch (e) {
        return e as DocpulseError;
      }
    })();

    expect(error).toBeInstanceOf(DocpulseError);
    expect((error as DocpulseError).exitCode).toBe(2);
    expect((error as DocpulseError).message).toContain(operator);
    expect((error as DocpulseError).message).toContain('runs JavaScript on the MongoDB server');
    expect((error as DocpulseError).detail).toContain('--allow-server-js');
    expect((error as DocpulseError).detail).toContain('read');
  });

  it('finds the operator nested inside $or, $and and sub-documents', () => {
    const raw = JSON.stringify({
      status: 'paid',
      $or: [{ total: { $gt: 10 } }, { customer: { $where: 'sleep(10000)' } }],
    });
    expect(() => parseJsonObjectFlag(raw, '--filter')).toThrow(/\$where runs JavaScript/);
  });

  it('finds the operator as a value key deep in the tree', () => {
    const raw = JSON.stringify({ a: { b: { c: [{ d: { $function: { body: 'x' } } }] } } });
    expect(() => parseJsonObjectFlag(raw, '--filter')).toThrow(/\$function runs JavaScript/);
  });

  it('survives a deeply nested filter without blowing the stack', () => {
    let nested = '{"$where":"1"}';
    for (let i = 0; i < 20_000; i += 1) nested = `{"a":${nested}}`;
    expect(() => parseJsonObjectFlag(nested, '--filter')).toThrow(/\$where runs JavaScript/);

    let harmless = '{"a":1}';
    for (let i = 0; i < 20_000; i += 1) harmless = `{"a":${harmless}}`;
    expect(() => parseJsonObjectFlag(harmless, '--filter')).not.toThrow();
  });

  it('leaves an ordinary filter alone', () => {
    expect(parseJsonObjectFlag('{"status":{"$in":["paid","open"]}}', '--filter')).toEqual({
      status: { $in: ['paid', 'open'] },
    });
  });

  it('does not trip on a field that merely contains the operator name', () => {
    expect(parseJsonObjectFlag('{"notes":"$where is a string here","where":1}', '--filter')).toEqual({
      notes: '$where is a string here',
      where: 1,
    });
  });
});

describe('--allow-server-js is the escape hatch', () => {
  it('accepts $where when the flag is passed to parseJsonObjectFlag', () => {
    expect(parseJsonObjectFlag('{"$where":"this.a > 1"}', '--filter', true)).toEqual({
      $where: 'this.a > 1',
    });
  });

  it('is threaded through parseSamplingFlags', () => {
    const options: SnapshotOptions = { ...BASE, filter: '{"$where":"this.a > 1"}' };
    expect(() => parseSamplingFlags(options)).toThrow(/\$where runs JavaScript/);
    expect(parseSamplingFlags({ ...options, allowServerJs: true })).toEqual({
      filter: { $where: 'this.a > 1' },
      sort: { _id: -1 },
    });
  });

  it('guards --sort as well', () => {
    expect(() => parseSamplingFlags({ ...BASE, sort: '{"$where":"1"}' })).toThrow(
      /\$where runs JavaScript/,
    );
  });
});
