import { createReadStream } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { DocpulseError, UsageError } from '../errors.js';
import type { DocumentSource, SamplingInfo } from '../core/types.js';

export interface ArraySourceOptions {
  /** Reported as the snapshot's `collection`. */
  collection: string;
  /** Max documents to yield. */
  sampleSize: number;
  /** Override the recorded sampling metadata (defaults to `input-file`). */
  sampling?: Partial<SamplingInfo>;
}

/**
 * A {@link DocumentSource} over documents already in memory. This is what makes
 * the entire test suite (and `docpulse snapshot --input-json` over a JSON array)
 * run with no database at all.
 */
export class ArrayDocumentSource implements DocumentSource {
  readonly collection: string;
  readonly sampling: SamplingInfo;
  readonly #docs: ReadonlyArray<Record<string, unknown>>;

  constructor(
    docs: ReadonlyArray<Record<string, unknown>>,
    options: ArraySourceOptions,
  ) {
    this.#docs = docs;
    this.collection = options.collection;
    this.sampling = {
      mode: 'input-file',
      sampleSize: options.sampleSize,
      filter: {},
      sort: null,
      ...options.sampling,
    };
  }

  async *documents(): AsyncIterable<Record<string, unknown>> {
    const limit = Math.max(0, this.sampling.sampleSize);
    for (let i = 0; i < this.#docs.length && i < limit; i += 1) {
      yield this.#docs[i] as Record<string, unknown>;
    }
  }

  async estimatedTotal(): Promise<{ count: number | null; method: string }> {
    return { count: this.#docs.length, method: 'inputLength' };
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}

function asDocument(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(
      `${where} is not a JSON object`,
      'Each document must be a JSON object; arrays and scalars are not documents.',
    );
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a JSON array, a single JSON object, or NDJSON (one JSON object per
 * line). The format is detected from the first non-whitespace character, so no
 * flag is needed.
 *
 * This parses the whole text at once. `createFileSource` uses it only for the
 * forms that cannot be streamed; an NDJSON file goes through
 * {@link NdjsonDocumentSource} instead.
 */
export function parseDocumentsText(
  text: string,
  origin: string,
): Array<Record<string, unknown>> {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      // A `{`-leading file may still be NDJSON; fall through to line parsing.
      if (trimmed.startsWith('[')) {
        throw new UsageError(
          `${origin} is not valid JSON`,
          error instanceof Error ? error.message : String(error),
        );
      }
      parsed = undefined;
    }
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) {
        return parsed.map((doc, i) => asDocument(doc, `${origin}: element ${i}`));
      }
      return [asDocument(parsed, origin)];
    }
  }

  const docs: Array<Record<string, unknown>> = [];
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new UsageError(
        `${origin}: line ${i + 1} is not valid JSON`,
        error instanceof Error ? error.message : String(error),
      );
    }
    docs.push(asDocument(parsed, `${origin}: line ${i + 1}`));
  }
  return docs;
}

/**
 * A {@link DocumentSource} that streams NDJSON off disk one line at a time and
 * stops reading the moment `sampleSize` documents have been yielded.
 *
 * Nothing but the current line is ever held in memory, so `--sample-size 1`
 * against a 100 GB export costs one line, not 100 GB: the file handle is
 * destroyed as soon as the limit is reached. That is the difference between
 * `--sample-size` bounding the *result* and bounding the *work*.
 */
export class NdjsonDocumentSource implements DocumentSource {
  readonly collection: string;
  readonly sampling: SamplingInfo;

  readonly #file: string;
  #yielded = 0;
  /** True once a read has run all the way to end-of-file. */
  #readToEnd = false;

  constructor(file: string, options: ArraySourceOptions) {
    this.#file = file;
    this.collection = options.collection;
    this.sampling = {
      mode: 'input-file',
      sampleSize: options.sampleSize,
      filter: {},
      sort: null,
      ...options.sampling,
    };
  }

  async *documents(): AsyncIterable<Record<string, unknown>> {
    const limit = Math.max(0, this.sampling.sampleSize);
    this.#yielded = 0;
    this.#readToEnd = false;
    if (limit === 0) return;

    const stream = createReadStream(this.#file, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const raw of lines) {
        lineNumber += 1;
        const line = raw.trim();
        if (line === '') continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (error) {
          throw new UsageError(
            `${this.#file}: line ${lineNumber} is not valid JSON`,
            error instanceof Error ? error.message : String(error),
          );
        }

        yield asDocument(parsed, `${this.#file}: line ${lineNumber}`);
        this.#yielded += 1;
        // Everything after this line stays unread: `return` runs the `finally`
        // below, which destroys the underlying file handle.
        if (this.#yielded >= limit) return;
      }
      this.#readToEnd = true;
    } catch (error) {
      if (error instanceof DocpulseError) throw error;
      throw new UsageError(
        `cannot read --input-json file: ${this.#file}`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  /**
   * Exact when the whole file was read, and honestly unknown when it was not:
   * counting the rest of the file would mean reading the rest of the file,
   * which is the one thing `--sample-size` is here to avoid.
   */
  async estimatedTotal(): Promise<{ count: number | null; method: string }> {
    if (this.#readToEnd) return { count: this.#yielded, method: 'inputLength' };
    return { count: null, method: 'inputTruncated' };
  }

  async close(): Promise<void> {
    /* the read stream is destroyed by documents() itself */
  }
}

/**
 * Largest `[ … ]`-array input `--input-json` will accept, in bytes.
 *
 * A JSON array is one JSON value: it cannot be parsed incrementally without a
 * streaming JSON parser, and docpulse has three runtime dependencies on
 * purpose. So the array form is read in one piece and capped, and the error
 * points at NDJSON — which is streamed and has no ceiling at all.
 *
 * 128 MiB of JSON expands to several hundred MB of heap once parsed, which
 * still fits a default CI runner. V8 also refuses any string over ~512 MB, so
 * without this ceiling the failure above it is not "slow", it is
 * `Invalid string length` with nothing to act on.
 */
export const MAX_BUFFERED_INPUT_BYTES = 128 * 1024 * 1024;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The first 64 KiB is plenty to tell a JSON array from NDJSON. */
const SNIFF_BYTES = 64 * 1024;

type InputForm = 'array' | 'ndjson';

/**
 * Decide how to read the file from its first chunk, reaching the same verdict
 * `parseDocumentsText` would have reached from the whole of it:
 *
 * - a leading `[` is the JSON-array form;
 * - a first non-blank line that parses on its own is NDJSON (which covers both
 *   one-object-per-line files and a single object written on one line);
 * - a complete first line that does *not* parse, in a `{`-leading file, is a
 *   pretty-printed single JSON object, and has to be buffered.
 *
 * Anything else — a corrupt first line, an empty file — is treated as NDJSON,
 * which produces the same `line N is not valid JSON` message it always did.
 */
async function sniffForm(file: string): Promise<InputForm> {
  let chunk: string;
  let atEof: boolean;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    chunk = buffer.subarray(0, bytesRead).toString('utf8');
    atEof = bytesRead < SNIFF_BYTES;
  } finally {
    await handle.close();
  }

  const firstNonSpace = chunk.trimStart().slice(0, 1);
  if (firstNonSpace === '[') return 'array';
  if (firstNonSpace !== '{') return 'ndjson';

  const newlineAt = chunk.indexOf('\n');
  // A first line longer than the sniff window is a single-line document, not a
  // pretty-printed one: stream it.
  if (newlineAt === -1 && !atEof) return 'ndjson';

  const firstLine = (newlineAt === -1 ? chunk : chunk.slice(0, newlineAt)).trim();
  try {
    JSON.parse(firstLine);
    return 'ndjson';
  } catch {
    return 'array';
  }
}

/**
 * Build a {@link DocumentSource} from a JSON-array or NDJSON file on disk.
 *
 * NDJSON is streamed and stops reading at `sampleSize`; the JSON-array form is
 * read in one piece and refused above {@link MAX_BUFFERED_INPUT_BYTES}.
 *
 * `collection` names the logical collection the documents belong to. Two
 * snapshots can only be diffed when their `collection` matches, so pass the
 * same name (via `-d`/`-c`) for the two files you intend to compare; it
 * defaults to `input:<basename>`, which is right for a one-off look.
 */
export async function createFileSource(
  file: string,
  sampleSize: number,
  collection?: string,
  maxBufferedBytes: number = MAX_BUFFERED_INPUT_BYTES,
): Promise<DocumentSource> {
  const options: ArraySourceOptions = {
    collection: collection ?? `input:${basename(file)}`,
    sampleSize,
  };

  let size: number;
  let form: InputForm;
  try {
    size = (await stat(file)).size;
    form = await sniffForm(file);
  } catch (error) {
    throw new UsageError(
      `cannot read --input-json file: ${file}`,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (form === 'ndjson') return new NdjsonDocumentSource(file, options);

  if (size > maxBufferedBytes) {
    throw new UsageError(
      `--input-json file is too large to read as a JSON array: ${file} ` +
        `(${formatBytes(size)}, limit ${formatBytes(maxBufferedBytes)})`,
      'A JSON array is a single JSON value, so docpulse has to hold all of it in memory at once and ' +
        '--sample-size cannot bound the read.\n' +
        'Convert the file to NDJSON — one JSON object per line — which docpulse streams and stops ' +
        'reading as soon as --sample-size documents have been read:\n' +
        `  jq -c '.[]' ${file} > documents.ndjson`,
    );
  }

  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new UsageError(
      `cannot read --input-json file: ${file}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  return new ArrayDocumentSource(parseDocumentsText(text, file), options);
}
