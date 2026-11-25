const token = /^[A-Za-z0-9._/-]+$/;
const keyPattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
export interface Marker {
  attrs: Record<string, string>;
  json?: unknown;
}

export function marker(
  kind: string,
  attrs: Record<string, string> = {},
  json?: unknown,
): string {
  if (!token.test(kind)) throw new Error('Invalid marker kind');
  const parts = [`ai-factory:${kind}`];
  for (const [key, value] of Object.entries(attrs)) {
    if (!keyPattern.test(key) || !token.test(value))
      throw new Error(`Invalid marker attribute: ${key}`);
    parts.push(`${key}=${value}`);
  }
  if (json !== undefined) {
    const serialized = JSON.stringify(json);
    if (serialized === undefined)
      throw new Error('Marker JSON is not serializable');
    parts.push(serialized.replace(/>/g, '\\u003e'));
  }
  return `<!-- ${parts.join(' ')} -->`;
}

export function findMarkers(body: string, kind: string): Marker[] {
  const found: Marker[] = [];
  for (const match of body.matchAll(
    /<!--\s*ai-factory:([A-Za-z0-9._/-]+)(?=\s|-->)([\s\S]*?)-->/g,
  )) {
    if (match[1] !== kind) continue;
    let rest = (match[2] ?? '').trim();
    const attrs: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    let invalid = false;
    while (rest) {
      const attr = /^([A-Za-z][A-Za-z0-9_-]*)=([A-Za-z0-9._/-]+)(?:\s+|$)/.exec(
        rest,
      );
      if (!attr) break;
      const key = attr[1]!;
      if (Object.hasOwn(attrs, key)) {
        invalid = true;
        break;
      }
      attrs[key] = attr[2]!;
      rest = rest.slice(attr[0].length).trim();
    }
    if (invalid) continue;
    try {
      found.push(
        rest ? { attrs, json: JSON.parse(rest) as unknown } : { attrs },
      );
    } catch {
      /* Malformed markers are not state. */
    }
  }
  return found;
}
