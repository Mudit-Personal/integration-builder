import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { highlight, type Token } from '../web/src/highlight.ts';

const kinds = (lines: Token[][], kind: string) => lines.flat().filter(t => t.kind === kind).map(t => t.text);
const text = (lines: Token[][]) => lines.map(l => l.map(t => t.text).join('')).join('\n');

test('TypeScript keeps every character and marks each kind', () => {
  const code = "/** const here\n * stays a comment */\nimport { run } from './run.ts';\nconst retries: Limits = 3; // 'quoted'\nconst msg = `a\nb`;";
  const lines = highlight(code, 'hubspot.connector.ts');
  assert.equal(text(lines), code);
  assert.deepEqual(kinds(lines, 'comment'), ['/** const here', ' * stays a comment */', "// 'quoted'"]);
  assert.deepEqual(kinds(lines, 'keyword'), ['import', 'from', 'const', 'const']);
  assert.deepEqual(kinds(lines, 'string'), ["'./run.ts'", '`a', 'b`']);
  assert.deepEqual(kinds(lines, 'type'), ['Limits']);
  assert.deepEqual(kinds(lines, 'number'), ['3']);
});

test('JSON tells keys from values', () => {
  const lines = highlight('{\n  "retries": 3,\n  "level": "info",\n  "on": true\n}', 'manifest.json');
  assert.deepEqual(kinds(lines, 'keyword'), ['"retries"', '"level"', '"on"', 'true']);
  assert.deepEqual(kinds(lines, 'string'), ['"info"']);
  assert.deepEqual(kinds(lines, 'number'), ['3']);
});

test('Markdown marks headings and inline code', () => {
  const lines = highlight('# Title\n\nKeep `manifest.json` here.', 'README.md');
  assert.deepEqual(kinds(lines, 'keyword'), ['# Title']);
  assert.deepEqual(kinds(lines, 'string'), ['`manifest.json`']);
  assert.deepEqual(kinds(highlight('```ts\nrun();\n```', 'README.md'), 'string'), ['```ts', 'run();', '```']);
});

test('an unknown file type stays plain, with blank lines kept', () => {
  const lines = highlight('const a = 1\n\nnext', 'Prompt');
  assert.equal(lines.length, 3);
  assert.deepEqual(kinds(lines, 'keyword'), []);
  assert.equal(text(lines), 'const a = 1\n\nnext');
});
