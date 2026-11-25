/** Bound both JS characters and UTF-8 bytes (GitHub comments also have a byte limit). */
export function capText(
  text: string,
  characters: number,
  bytes: number,
): string {
  let result = text.slice(0, characters);
  if (Buffer.byteLength(result, 'utf8') > bytes) {
    let low = 0;
    let high = result.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(result.slice(0, mid), 'utf8') <= bytes) low = mid;
      else high = mid - 1;
    }
    result = result.slice(0, low);
  }
  // Never leave half of a surrogate pair at the boundary.
  return result.replace(/[\uD800-\uDBFF]$/, '');
}
