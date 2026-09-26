/**
 * The userinfo part of a MongoDB connection string: everything between the
 * scheme and the `@`. `[^@\s/]*` cannot cross a `/`, a space or a second `@`,
 * so it can only ever match the credentials of one URI. Single-character
 * classes only — linear time on any input.
 */
const CONNECTION_STRING_USERINFO = /(mongodb(?:\+srv)?:\/\/)[^@\s/]*@/gi;

/**
 * Replace `mongodb://user:password@…` with `mongodb://<redacted>@…`.
 *
 * docpulse never prints the URI itself, and the `mongodb` driver redacts its
 * own error messages — but that is the driver's behaviour, not docpulse's
 * guarantee, and the dependency is a caret range. Every string that comes back
 * from the driver, or from an unexpected crash, goes through here before it
 * reaches stderr, because the place these messages end up is a CI log.
 */
export function redactConnectionStrings(text: string): string {
  return text.replace(CONNECTION_STRING_USERINFO, '$1<redacted>@');
}
