/** Width / height (and format) from the first bytes of a PNG, JPEG, GIF or WebP file. null when unknown. */
export function imageSize(b: Buffer): { width: number; height: number; format: string } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), format: 'png' };
  }
  if (b.length >= 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8), format: 'gif' };
  if (b.length >= 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), format: 'webp' };
    if (kind === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, format: 'webp' };
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7), format: 'jpg' };
      }
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** Format from a file name / content type ("photo.JPG" → "jpg"). */
export function formatOf(name: string | null | undefined, contentType?: string | null): string | null {
  const m = /\.([a-z0-9]{1,8})$/i.exec(name ?? '');
  if (m) return m[1].toLowerCase();
  const t = (contentType ?? '').toLowerCase();
  const map: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'video/mp4': 'mp4', 'text/plain': 'txt', 'application/json': 'json' };
  return map[t] ?? null;
}

export function mimeOf(format: string | null | undefined): string | null {
  const map: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', txt: 'text/plain', json: 'application/json', csv: 'text/csv', html: 'text/html' };
  return map[(format ?? '').toLowerCase()] ?? null;
}
