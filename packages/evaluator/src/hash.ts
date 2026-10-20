function mixWord(word: number): number {
  word = Math.imul(word, 0xcc9e2d51);
  word = (word << 15) | (word >>> 17);
  return Math.imul(word, 0x1b873593);
}

/** MurmurHash3 x86_32, seed 0, unsigned result over UTF-8 bytes. */
export function murmur3(input: string): number {
  let hash = 0;
  let word = 0;
  let wordBytes = 0;
  let byteLength = 0;

  // Stream UTF-8 into little-endian words without Buffer or TextEncoder dependencies.
  function appendByte(byte: number): void {
    word |= byte << (wordBytes * 8);
    wordBytes += 1;
    byteLength += 1;
    if (wordBytes === 4) {
      hash ^= mixWord(word);
      hash = (hash << 13) | (hash >>> 19);
      hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
      word = 0;
      wordBytes = 0;
    }
  }

  for (let i = 0; i < input.length; i += 1) {
    let point = input.charCodeAt(i);
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      } else {
        point = 0xfffd;
      }
    } else if (point >= 0xdc00 && point <= 0xdfff) {
      point = 0xfffd;
    }

    if (point < 0x80) {
      appendByte(point);
    } else if (point < 0x800) {
      appendByte(0xc0 | (point >>> 6));
      appendByte(0x80 | (point & 0x3f));
    } else if (point < 0x10000) {
      appendByte(0xe0 | (point >>> 12));
      appendByte(0x80 | ((point >>> 6) & 0x3f));
      appendByte(0x80 | (point & 0x3f));
    } else {
      appendByte(0xf0 | (point >>> 18));
      appendByte(0x80 | ((point >>> 12) & 0x3f));
      appendByte(0x80 | ((point >>> 6) & 0x3f));
      appendByte(0x80 | (point & 0x3f));
    }
  }

  if (wordBytes !== 0) hash ^= mixWord(word);
  hash ^= byteLength;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** Stable bucket in [0, 9999]; neither rule IDs nor config versions affect it. */
export function bucket(flagKey: string, userId: string): number {
  return murmur3(`${flagKey}:${userId}`) % 10000;
}
