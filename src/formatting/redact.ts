/**
 * SecretRedaction — nothing that looks like a credential leaves a step.
 *
 * Verification output is fed straight back into the model's context, and
 * command environments routinely carry tokens (`NPM_TOKEN`, `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY`). A test that prints its environment, or a `curl`
 * that echoes an `Authorization` header, would otherwise persist a live
 * credential into the conversation and into the spill files on disk.
 *
 * Pure string-in / string-out. Two mechanisms, deliberately conservative:
 *   1. exact values of secret-looking environment variables,
 *   2. well-known credential shapes (bearer tokens, `key=value` pairs, JWTs).
 *
 * Values shorter than `MIN_SECRET_LENGTH` are ignored: replacing every "1"
 * because a variable is called `API_KEY_COUNT` would destroy the output.
 */

/** Environment variable names that hold credentials. */
const SECRET_NAME =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|auth|bearer|session[_-]?id)/i;

/** Values shorter than this are too generic to redact safely. */
export const MIN_SECRET_LENGTH = 8;

export const REDACTED = "[redacted]";

/**
 * Credential shapes whose *value* is the whole match: nothing of it survives.
 */
const WHOLE_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bAKIA[0-9A-Z]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
];

/**
 * Credential shapes with an informative prefix worth keeping: group 1 is the
 * prefix, the rest of the match is the value.
 */
const PREFIXED_VALUE_PATTERNS: RegExp[] = [
  /\b((?:Bearer|Basic|Token)\s+)[A-Za-z0-9._+/=-]{8,}/gi,
  /\b([A-Za-z0-9_]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_]*\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
];

export type EnvLike = Record<string, string | undefined>;

/**
 * Values from the given environment that are safe to treat as secrets.
 * Exported so callers can test the predicate without touching a process.
 */
export function secretValues(env: EnvLike = process.env): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_NAME.test(name)) continue;
    out.push(value);
  }
  // Longest first: redacting a value that contains another one must not leave
  // a fragment of the longer secret behind.
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Replace credentials found in `text` with `[redacted]`.
 *
 * @param text Text to sanitise (process output, config dump, ...).
 * @param env  Environment to take secret values from.
 */
export function redactSecrets(text: string, env: EnvLike = process.env): string {
  if (!text) return text;
  let out = text;

  for (const value of secretValues(env)) {
    out = out.split(value).join(REDACTED);
  }

  for (const pattern of WHOLE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }

  for (const pattern of PREFIXED_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (_match, prefix: string) => `${prefix}${REDACTED}`);
  }

  return out;
}

/**
 * Redact the values of a step's configured environment, for config dumps.
 * The keys stay visible — they are part of the configuration — but a token
 * pasted into `sentinel.config.ts` never reaches the model.
 */
export function redactEnv(env: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!env) return env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = SECRET_NAME.test(key) ? REDACTED : value;
  }
  return out;
}

/** Exported for tests: whether a variable name looks like a credential. */
export function looksSecret(name: string): boolean {
  return SECRET_NAME.test(name);
}
