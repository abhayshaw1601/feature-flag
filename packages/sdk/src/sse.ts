/** Incremental SSE framing, independent of fetch/UTF-8 decoding. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private size = 0;

  constructor(private readonly dispatch: (event: string, data: string) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let start = 0;
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (char !== "\r" && char !== "\n") continue;
      // A trailing CR may be the first half of CRLF in the next chunk.
      if (char === "\r" && index === this.buffer.length - 1) break;
      this.line(this.buffer.slice(start, index));
      if (char === "\r" && this.buffer[index + 1] === "\n") index++;
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.size > 65_536) throw new Error("SSE event too large");
  }

  end(): void {
    // Complete a final bare CR; an unterminated event must otherwise be discarded at EOF.
    if (this.buffer.endsWith("\r")) this.push("\n");
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.dispatch(this.event || "message", this.data.join("\n"));
      this.event = "";
      this.data = [];
      this.size = 0;
      return;
    }
    if (line.startsWith(":")) return;
    this.size += line.length;
    if (this.size > 65_536) throw new Error("SSE event too large");
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    if (field === "data") this.data.push(value);
  }
}
