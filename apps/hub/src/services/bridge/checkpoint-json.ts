/** Proposed owner ASCII canonical/lexical format. No authority follows from a digest.
 * Mirrors SuperPipeline checkpoint-json.ts; owner corpus is pinned in checkpoint-contract. */
function readCheckpointJSON(raw: Uint8Array): unknown {
  if (raw.byteLength > 65536) throw new Error("INVALID_CHECKPOINT");
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  let pos = 0;
  function whitespace(): void {
    while (/\s/.test(text[pos] ?? '') && pos < text.length) pos++;
  }
  function string(): string {
    const start = pos++;
    while (pos < text.length) {
      if (text[pos] === '\\') {
        pos += 2;
        continue;
      }
      if (text[pos++] === '"') {
        const parsed: unknown = JSON.parse(text.slice(start, pos));
        if (typeof parsed !== 'string') throw new Error("INVALID_CHECKPOINT");
        for (const scalar of parsed) {
          const code = scalar.codePointAt(0) ?? 0;
          if (code >= 0xd800 && code <= 0xdfff) throw new Error("INVALID_CHECKPOINT");
        }
        return parsed;
      }
    }
    throw new Error("INVALID_CHECKPOINT");
  }
  function value(depth: number): void {
    if (depth > 128) throw new Error("INVALID_CHECKPOINT");
    whitespace();
    const token = text[pos];
    if (token === '"') {
      string();
      return;
    }
    if (token === '{' || token === '[') {
      const object = token === '{';
      const close = object ? '}' : ']';
      const keys = new Set<string>();
      pos++;
      whitespace();
      if (text[pos] === close) {
        pos++;
        return;
      }
      while (pos < text.length) {
        if (object) {
          if (text[pos] !== '"') throw new Error("INVALID_CHECKPOINT");
          const key = string();
          if (keys.has(key)) throw new Error("INVALID_CHECKPOINT");
          keys.add(key);
          whitespace();
          if (text[pos++] !== ':') throw new Error("INVALID_CHECKPOINT");
        }
        value(depth + 1);
        whitespace();
        if (text[pos] === close) {
          pos++;
          return;
        }
        if (text[pos++] !== ',') throw new Error("INVALID_CHECKPOINT");
        whitespace();
      }
      throw new Error("INVALID_CHECKPOINT");
    }
    const rest = text.slice(pos);
    const atom = /^(true|false|0|[1-9][0-9]*)/.exec(rest)?.[0];
    if (!atom) throw new Error("INVALID_CHECKPOINT");
    pos += atom.length;
    if (atom !== 'true' && atom !== 'false' && !Number.isSafeInteger(Number(atom)))
      throw new Error("INVALID_CHECKPOINT");
  }
  value(0);
  whitespace();
  if (pos !== text.length) throw new Error("INVALID_CHECKPOINT");
  return JSON.parse(text);
}

function quote(text: string): string {
  let out = '"';
  for (const scalar of text) {
    const code = scalar.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error("INVALID_CHECKPOINT");
    if (scalar === '"' || scalar === '\\') out += '\\' + scalar;
    else if (code >= 32 && code <= 126) out += scalar;
    else for (const unit of scalar.split('')) out += '\\u' + unit.charCodeAt(0).toString(16).padStart(4, '0');
  }
  return out + '"';
}
export function canonicalCheckpoint(value: unknown): string {
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalCheckpoint).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => quote(key) + ':' + canonicalCheckpoint(item))
        .join(',') +
      '}'
    );
  throw new Error("INVALID_CHECKPOINT");
}
export async function checkpointDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCheckpoint(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

export function parseCheckpointJSON(raw: Uint8Array): unknown {
  try {
    return readCheckpointJSON(raw);
  } catch {
    throw new Error("INVALID_CHECKPOINT");
  }
}
