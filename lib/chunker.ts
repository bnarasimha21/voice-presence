// Issue 4: groups streamed LLM text deltas into sentence-sized chunks so
// TTS can start on the first sentence instead of waiting for the whole
// reply. Pure function, no I/O, easy to unit test.

// Matches sentence-ending punctuation (optionally followed by a closing
// quote/paren/bracket) followed by whitespace, anywhere in the buffer.
// Everything up to and including that whitespace is a complete sentence;
// anything after the last such match is a trailing partial sentence held
// until the next delta or `flush()`.
const SENTENCE_BOUNDARY = /[.!?]["')\]]*\s+/g;

export class SentenceChunker {
  private buffer = "";

  /** Feed one text delta; returns any complete sentences it completed. */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];

    let lastEnd = 0;
    SENTENCE_BOUNDARY.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SENTENCE_BOUNDARY.exec(this.buffer)) !== null) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(lastEnd, end).trim();
      if (sentence) out.push(sentence);
      lastEnd = end;
    }
    this.buffer = this.buffer.slice(lastEnd);
    return out;
  }

  /** Call once the stream ends; returns the trailing partial sentence, if any. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest.length > 0 ? rest : null;
  }
}
