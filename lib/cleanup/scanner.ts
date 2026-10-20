export type RepositoryFile = { filePath: string; content: string };

export type ScannedReference = {
  flagKey: string;
  filePath: string;
  line: number;
  snippet: string;
};

type Token = {
  kind: "word" | "string" | "punctuation" | "opaque";
  text: string;
  start: number;
  end: number;
};

const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  ".vercel",
  ".netlify",
  ".svelte-kit",
  ".yarn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  "generated",
  "__generated__",
]);

function isSourceFile(filePath: string): boolean {
  const parts = filePath.replaceAll("\\", "/").toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    !parts.some((part) => ignoredDirectories.has(part) || part.startsWith("node_modules.")) &&
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(name) &&
    !/\.(?:d\.[cm]?ts|min\.[cm]?js|generated\.[jt]sx?)$/.test(name) &&
    !/(?:^|[.-])lock(?:file)?[.-]/.test(name)
  );
}

function startsExpression(previous: Token | undefined): boolean {
  if (!previous) return true;
  if (previous.kind === "word") {
    return /^(?:return|throw|case|delete|void|typeof|new|in|of|yield|await|else|do)$/.test(
      previous.text,
    );
  }
  return (
    previous.kind === "punctuation" &&
    ![")", "]", "}", ".", "?.", "++", "--"].includes(previous.text)
  );
}

/** A small lexer, deliberately independent of the TypeScript compiler/runtime. */
function tokenize(source: string, jsx: boolean): Token[] {
  let position = 0;
  const token = (
    kind: Token["kind"],
    start: number,
    text = source.slice(start, position),
  ): Token => ({
    kind,
    text,
    start,
    end: position,
  });

  function quoted(): Token {
    const start = position;
    const quote = source[position++];
    let escaped = false;
    while (position < source.length) {
      const character = source[position++];
      if (character === quote) {
        return token(escaped ? "opaque" : "string", start, source.slice(start + 1, position - 1));
      }
      if (character === "\\") {
        escaped = true;
        position += source[position] === "\r" && source[position + 1] === "\n" ? 2 : 1;
      } else if (/[\r\n\u2028\u2029]/.test(character)) {
        break;
      }
    }
    return token("opaque", start);
  }

  function template(): void {
    position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === "\\") position++;
      else if (character === "`") return;
      else if (character === "$" && source[position] === "{") {
        position++;
        code(true); // Interpolation is deliberately excluded along with template text.
      }
    }
  }

  function regexEnd(): number | undefined {
    let inClass = false;
    for (let index = position + 1; index < source.length; index++) {
      const character = source[index];
      if (/[\r\n\u2028\u2029]/.test(character)) return;
      if (character === "\\") index++;
      else if (character === "[") inClass = true;
      else if (character === "]") inClass = false;
      else if (character === "/" && !inClass) {
        index++;
        while (/[a-z]/i.test(source[index] ?? "")) index++;
        return index;
      }
    }
  }

  function jsxElement(): Token[] {
    const start = position++;
    const result: Token[] = [token("opaque", start)];
    const expression = () => {
      position++;
      result.push(...code(true), token("opaque", position));
    };
    // Only {...} expressions are code; JSX attributes and text are not.
    while (position < source.length) {
      if (source.startsWith("/>", position)) {
        position += 2;
        return result;
      }
      const character = source[position];
      if (character === ">") {
        position++;
        break;
      }
      if (character === "'" || character === '"') quoted();
      else if (character === "{") expression();
      else position++;
    }
    while (position < source.length) {
      if (source.startsWith("</", position)) {
        const end = source.indexOf(">", position + 2);
        position = end < 0 ? source.length : end + 1;
        break;
      }
      if (source[position] === "{") expression();
      else if (source[position] === "<") result.push(...jsxElement());
      else position++;
    }
    result.push(token("opaque", position));
    return result;
  }

  function code(stopAtBrace = false): Token[] {
    const result: Token[] = [];
    let braces = 0;
    while (position < source.length) {
      const start = position;
      const character = source[position];
      const previous = result.at(-1);
      if (/\s/.test(character)) {
        position++;
      } else if (source.startsWith("//", position) || (position === 0 && source.startsWith("#!"))) {
        while (position < source.length && !/[\r\n\u2028\u2029]/.test(source[position])) position++;
      } else if (source.startsWith("/*", position)) {
        const end = source.indexOf("*/", position + 2);
        position = end < 0 ? source.length : end + 2;
      } else if (character === "'" || character === '"') {
        result.push(quoted());
      } else if (character === "`") {
        template();
        result.push(token("opaque", start));
      } else if (
        character === "/" &&
        (startsExpression(previous) || previous?.text === ")" || previous?.text === "}") &&
        regexEnd() !== undefined
      ) {
        position = regexEnd()!;
        result.push(token("opaque", start));
      } else if (
        jsx &&
        character === "<" &&
        startsExpression(previous) &&
        /^<(?:[A-Za-z][\w.:-]*(?=[\s/>])|>)/.test(source.slice(position))
      ) {
        result.push(...jsxElement());
      } else if (/[\w$\u0080-\uffff]/.test(character)) {
        while (position < source.length && /[\w$\u0080-\uffff]/.test(source[position])) position++;
        result.push(token("word", start));
      } else {
        position++;
        if (character === "{") braces++;
        if (character === "}") {
          if (stopAtBrace && braces === 0) return result;
          braces--;
        }
        if (["?.", "=>", "++", "--"].includes(source.slice(start, position + 1))) position++;
        result.push(token("punctuation", start));
      }
    }
    return result;
  }

  return code();
}

function closingToken(tokens: readonly Token[], start: number, generic = false): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  if (generic) pairs["<"] = ">";
  const stack: string[] = [];
  for (let index = start; index < tokens.length; index++) {
    const current = tokens[index];
    if (current.kind !== "punctuation") continue;
    if (pairs[current.text]) stack.push(pairs[current.text]);
    else if (Object.values(pairs).includes(current.text)) {
      if (stack.pop() !== current.text) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/**
 * Pure, best-effort JS/TS-family reference discovery, in file/source order.
 * `line` is the 1-based method/function-name line; snippets include adjacent code.
 * Only direct or dot/optional-member isEnabled/getValue calls with an unescaped
 * single/double-quoted first argument are recognized, including TS type arguments.
 *
 * Limitations: no symbol/import resolution (same-named unrelated functions can
 * match), aliases, computed members, escaped keys, dynamic/concatenated keys,
 * templates (including interpolations), or non-JS/TS files. This is a lexer, not
 * a parser: ambiguous JSX/generics and regex/division may conservatively miss
 * references. Generated/minified/declaration/build/vendor/lock files are excluded.
 * Results are discovery evidence, not proof that removing a flag is safe.
 */
export function scanRepository(
  files: readonly RepositoryFile[],
  knownFlagKeys: readonly string[],
): ScannedReference[] {
  const known = new Set(knownFlagKeys);
  const references: ScannedReference[] = [];
  if (known.size === 0) return references;

  for (const file of files) {
    if (!isSourceFile(file.filePath)) continue;
    const tokens = tokenize(file.content, /\.[jt]sx$/i.test(file.filePath));
    const lines = file.content.split(/\r\n|[\r\n\u2028\u2029]/);
    const starts = [0];
    for (const match of file.content.matchAll(/\r\n|[\r\n\u2028\u2029]/g)) {
      starts.push(match.index + match[0].length);
    }
    const lineAt = (offset: number) => {
      let low = 0;
      let high = starts.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (starts[middle] <= offset) low = middle;
        else high = middle;
      }
      return low;
    };

    for (let index = 0; index < tokens.length; index++) {
      const name = tokens[index];
      if (name.kind !== "word" || !["isEnabled", "getValue"].includes(name.text)) continue;
      // A constructor/declaration is not an SDK call. Walk simple member receivers.
      let receiver = index;
      while (receiver >= 2 && [".", "?."].includes(tokens[receiver - 1].text)) receiver -= 2;
      if (["new", "function", "#"].includes(tokens[receiver - 1]?.text)) continue;
      if (tokens[receiver - 1]?.text === "*" && tokens[receiver - 2]?.text === "function") continue;

      let open = index + 1;
      if (tokens[open]?.text === "?.") open++;
      if (tokens[open]?.text === "<") {
        const close = closingToken(tokens, open, true);
        if (close < 0) continue;
        open = close + 1;
      }
      if (tokens[open]?.text !== "(") continue;
      const key = tokens[open + 1];
      if (key?.kind !== "string" || !known.has(key.text)) continue;
      if (![",", ")"].includes(tokens[open + 2]?.text)) continue;
      const close = closingToken(tokens, open);
      if (close < 0 || ["{", "=>"].includes(tokens[close + 1]?.text)) continue;

      const line = lineAt(name.start);
      const endLine = lineAt(tokens[close].end - 1);
      references.push({
        flagKey: key.text,
        filePath: file.filePath,
        line: line + 1,
        snippet: lines
          .slice(Math.max(0, line - 1), Math.min(endLine + 2, line + 8))
          .join("\n")
          .slice(0, 1600),
      });
    }
  }
  return references;
}
