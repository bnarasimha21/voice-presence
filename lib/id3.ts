// Issue 3: a minimal ID3v2.3 tag carrying a single COMM (comment) frame,
// prepended to the MP3 stream as a disclosure that the voice is
// AI-generated. This is strippable metadata, not a watermark: stated
// plainly in the README, and ElevenLabs's API reference documents no
// watermark parameter as of the date this was written.

function synchsafe(size: number): Uint8Array {
  // ID3v2 sizes are encoded as four 7-bit bytes (no byte may have its top
  // bit set), so the tag's own length never collides with a frame sync.
  // Used for the TAG header size in every ID3v2 version (2.2 through
  // 2.4). Frame sizes, below, are a different story: see uint32BE.
  return new Uint8Array([
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
  ]);
}

// Issue 14: the FRAME size field's encoding depends on the tag version.
// ID3v2.4 made frame sizes synchsafe, like the tag header size, but
// ID3v2.3 (the version this file declares in the tag header, 0x03 0x00)
// never did: a 2.3 frame size is a plain 32-bit big-endian integer. Using
// `synchsafe()` for the frame size while declaring version 2.3 (as an
// earlier version of this file did) only happens to produce the right
// bytes while the comment is short enough that every byte of the length
// is below 128; a long enough disclosure comment pushes the real length
// past what 4x7 synchsafe bits can represent without the plain and
// synchsafe encodings diverging, and a spec-correct 2.3 reader parsing
// those bytes as a plain integer then reads the wrong frame length and
// misparses (or truncates) the tag.
function uint32BE(size: number): Uint8Array {
  return new Uint8Array([
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
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
    uint32BE(frameBody.length), // plain 32-bit BE: correct for v2.3, see uint32BE above
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
