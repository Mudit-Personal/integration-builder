export type Token = { kind: string; text: string };

const WORDS = 'as|async|await|break|case|catch|class|const|continue|default|else|export|extends|false|finally|for|from|function|if|import|in|instanceof|interface|let|new|null|of|return|switch|throw|true|try|type|typeof|undefined|void|while';
const QUOTED = /"(?:\\.|[^"\\\n])*"/.source;

// Earlier kinds win, so a keyword inside a comment or string stays part of it.
// shortcut: regex literals aren't recognised, so a quote inside one can colour the rest of its line. Move to a real parser if that shows up.
const RULES: Record<string, Record<string, string>> = {
  ts: {
    comment: /\/\*[\s\S]*?\*\/|\/\/[^\n]*/.source,
    string: `${QUOTED}|${/'(?:\\.|[^'\\\n])*'|`(?:\\[\s\S]|[^`\\])*`/.source}`,
    keyword: `\\b(?:${WORDS})\\b`,
    number: /\b\d[\d_.]*\b/.source,
    type: /\b[A-Z]\w*\b/.source,
  },
  json: {
    keyword: `${QUOTED}(?=\\s*:)|\\b(?:true|false|null)\\b`,
    string: QUOTED,
    number: /-?\b\d[\d.eE+-]*\b/.source,
  },
  md: {
    keyword: /^#{1,6} .*$/.source,
    string: /```[\s\S]*?```|`[^`\n]*`/.source,
  },
};

const PATTERNS = Object.fromEntries(Object.entries(RULES).map(([lang, rules]) => [lang, new RegExp(Object.entries(rules).map(([kind, source]) => `(?<${kind}>${source})`).join('|'), 'gm')]));

const tokens = (code: string, pattern?: RegExp) => {
  if (!pattern) return [{ kind: 'plain', text: code }];
  const out: Token[] = [];
  let at = 0;
  for (const m of code.matchAll(pattern)) {
    out.push({ kind: 'plain', text: code.slice(at, m.index) }, { kind: Object.keys(m.groups!).find(k => m.groups![k] !== undefined)!, text: m[0] });
    at = m.index + m[0].length;
  }
  out.push({ kind: 'plain', text: code.slice(at) });
  return out;
};

/** One list of tokens per line. A token that spans lines, like a block comment, is split so each line stays whole. An unknown file type comes back plain. */
export const highlight = (code: string, name = ''): Token[][] => {
  const lines: Token[][] = [[]];
  for (const { kind, text } of tokens(code, PATTERNS[name.split('.').pop()!])) {
    text.split('\n').forEach((part, i) => {
      if (i) lines.push([]);
      if (part) lines.at(-1)!.push({ kind, text: part });
    });
  }
  return lines;
};
