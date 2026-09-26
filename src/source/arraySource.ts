import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { UsageError } from '../errors.js';
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
 * the entire test suite (and `docpulse snapshot --input-json`) run with no
 * database at all.
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

/** Build a {@link DocumentSource} from a JSON-array or NDJSON file on disk. */
export async function createFileSource(
  file: string,
  sampleSize: number,
): Promise<ArrayDocumentSource> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new UsageError(
      `cannot read --input-json file: ${file}`,
      error instanceof Error ? error.message : String(error),
    );
  }
  const docs = parseDocumentsText(text, file);
  return new ArrayDocumentSource(docs, {
    collection: `input:${basename(file)}`,
    sampleSize,
  });
}
