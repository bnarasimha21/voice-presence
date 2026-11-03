// Issue 3: a minimal ID3v2.3 tag carrying a single COMM (comment) frame,
// prepended to the MP3 stream as a disclosure that the voice is
// AI-generated. This is strippable metadata, not a watermark: stated
// plainly in the README, and ElevenLabs's API reference documents no
// watermark parameter as of the date this was written.

function synchsafe(size: number): Uint8Array {
  // ID3v2 sizes are encoded as four 7-bit bytes (no byte may have its top
  // bit set), so the tag's own length never collides with a frame sync.
  return new Uint8Array([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
}

export function id3CommentFrame(comment: string): Uint8Array {
  const lang = new TextEncoder().encode("eng"); // 3 bytes, required by COMM
  const textEncoding = new Uint8Array([0x00]); // ISO-8859-1
  const shortDescription = new Uint8Array([0x00]); // empty, null-terminated
  const commentBytes = new TextEncoder().encode(comment);

  const frameBody = concat([
    textEncoding,
    lang,
    shortDescription,
    commentBytes,
  ]);

  const frameHeader = concat([
    new TextEncoder().encode("COMM"),
    synchsafe(frameBody.length),
    new Uint8Array([0x00, 0x00]), // frame flags
  ]);

  const frame = concat([frameHeader, frameBody]);

  const tagHeader = concat([
    new TextEncoder().encode("ID3"),
    new Uint8Array([0x03, 0x00]), // version 2.3.0
    new Uint8Array([0x00]), // flags
    synchsafe(frame.length),
  ]);

  return concat([tagHeader, frame]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
