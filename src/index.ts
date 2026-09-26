/**
 * Library entry point. `docpulse` is primarily a CLI, but every piece of it is
 * usable from Node directly — which is also how the test suite drives it.
 */
export { bsonTypeOf, collapseNumericType, isNumericBsonType } from './core/bsonType.js';
export {
  ARRAY_MARKER,
  escapeKey,
  isArrayElementPath,
  joinPath,
  unescapeKey,
  walkDocument,
  type ArrayLengthEvent,
  type PathEvent,
  type ValueEvent,
} from './core/paths.js';
export {
  SNAPSHOT_FORMAT_VERSION,
  SnapshotAccumulator,
  TOOL_ID,
  inferFromDocuments,
  inferFromSource,
  type SnapshotMetaInput,
} from './core/infer.js';
export {
  canonicalStringify,
  parseSnapshot,
  snapshotSchema,
  stringifySnapshot,
  validateSnapshot,
} from './core/snapshotSchema.js';
export {
  diffSnapshots,
  hasActionableFindings,
  isIgnored,
  nullRatio,
  presenceRatio,
  significantTypes,
  type DiffOptions,
} from './core/diff.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG_FILE,
  loadConfig,
  mergeConfig,
  parseConfigText,
} from './config.js';
export {
  ArrayDocumentSource,
  MAX_BUFFERED_INPUT_BYTES,
  NdjsonDocumentSource,
  createFileSource,
  parseDocumentsText,
} from './source/arraySource.js';
export { MongoDocumentSource, type MongoSourceOptions } from './source/mongoSource.js';
export {
  REPORT_FORMATS,
  renderJson,
  renderMarkdown,
  renderReport,
  renderTable,
  type ReportFormat,
} from './report/index.js';
export { DocpulseError, UsageError } from './errors.js';
export { redactConnectionStrings } from './redact.js';
export { VERSION } from './version.js';
export * from './core/types.js';
