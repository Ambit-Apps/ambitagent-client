/**
 * What may be written to the log file about a frame that would not parse.
 *
 * ── THE LEAK THIS CLOSES ──
 * `connection.ts` logged the whole unparseable frame: `log.warn({ text },
 * 'unparseable admin message')`. A `run_task` frame carries `credentials` —
 * the customer's DECRYPTED secrets, their eCW password, their Amazon login —
 * so a single truncated or protocol-drifted frame wrote those into a plain
 * text log on their machine, where they stay until the file rotates. Nobody
 * had to be attacked for it to happen; a dropped packet was enough.
 *
 * Logging nothing is not the answer either, because then a protocol
 * mismatch is undiagnosable from the one place it is visible. So this keeps
 * what a diagnosis needs — how long the frame was, how it started, whether
 * it was JSON at all, what `type` it claimed — and nothing else.
 */

/** How much of the frame's opening may be quoted. Enough to see shape. */
const PREVIEW_CHARS = 120;

/**
 * Key names whose values never appear in a log, at any depth.
 *
 * Matched case-insensitively and as a SUBSTRING of the key, so
 * `enrollmentToken`, `token_hash` and `AWS_SECRET` are all caught by the
 * entries below. Deliberately broad: the cost of masking something harmless
 * is a less useful log line, and the cost of missing something is a
 * credential on disk.
 */
const SECRET_KEY_PARTS = [
  'credential',
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'private',
  'authorization',
  'cookie',
  'session',
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

/**
 * A frame summary that is safe to write down.
 *
 * Takes the raw text, because by the time this is called parsing has already
 * failed — there is no object to walk. It tries once more to parse, since
 * MOST "unparseable" frames are really "parsed but did not match the
 * protocol", and a structured summary is far more useful than a prefix. If
 * it genuinely is not JSON, the bounded preview is all that is left.
 */
export function summarizeFrame(text: string): Record<string, unknown> {
  const raw = text ?? '';
  const base = {
    bytes: Buffer.byteLength(raw, 'utf8'),
    chars: raw.length,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all: an HTML error page from a proxy, a truncated frame, a
    // TLS-terminator's complaint. The opening is what identifies which.
    return {
      ...base,
      json: false,
      preview: preview(raw),
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ...base, json: true, shape: typeof parsed, preview: preview(raw) };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    ...base,
    json: true,
    // The two fields that identify WHICH frame this was, and neither is a
    // secret: the admin's own message type and the run it concerns.
    claimedType: typeof obj.type === 'string' ? obj.type : null,
    claimedRunId: typeof obj.runId === 'string' || typeof obj.runId === 'number' ? obj.runId : null,
    // The key names, which is what a protocol mismatch is actually about —
    // a field renamed, a field missing. Names only, never values.
    keys: Object.keys(obj).slice(0, 40),
    redactedKeys: Object.keys(obj).filter(isSecretKey),
  };
}

/**
 * A bounded, masked slice of the frame's opening.
 *
 * Masks anything that LOOKS like a secret even outside a JSON key, because
 * this path runs when the frame did not parse — so there are no keys to go
 * by, and a truncated `run_task` can still have half a password in it.
 */
function preview(raw: string): string {
  const head = raw.slice(0, PREVIEW_CHARS);
  const masked = head
    // "password": "..."  →  "password": "[redacted]"
    .replace(
      new RegExp(`"([^"]*(?:${SECRET_KEY_PARTS.join('|')})[^"]*)"\\s*:\\s*"[^"]*"`, 'gi'),
      '"$1":"[redacted]"',
    )
    // A bearer token or a JWT loose in the text.
    .replace(/\beyJ[A-Za-z0-9_-]{8,}/g, '[jwt]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    // A 64-char hex string is an enrollment token's exact shape.
    .replace(/\b[0-9a-f]{64}\b/gi, '[hex-token]');
  return raw.length > PREVIEW_CHARS ? `${masked}…` : masked;
}
