/**
 * docpulse maps every failure onto one of three process exit codes:
 * 0 = clean, 1 = drift with `--fail-on-drift`, 2 = anything the operator must fix.
 */
export class DocpulseError extends Error {
  /** Process exit code to use for this failure. */
  readonly exitCode: number;
  /** Optional multi-line evidence printed under the message. */
  readonly detail: string | undefined;

  constructor(message: string, exitCode = 2, detail?: string) {
    super(message);
    this.name = 'DocpulseError';
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

/** Bad flags, unreadable files, malformed snapshots: always exit 2. */
export class UsageError extends DocpulseError {
  constructor(message: string, detail?: string) {
    super(message, 2, detail);
    this.name = 'UsageError';
  }
}
