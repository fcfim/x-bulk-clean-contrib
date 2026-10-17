// Extracts every GraphQL operation definition from an X web bundle (main.js), without any model:
// queryId, operationName, operationType, featureSwitches and fieldToggles, with the position of
// each definition in the file. Usage: node scripts/extract-x-operations.mjs main.js [out.json]
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input) {
  console.error('usage: node scripts/extract-x-operations.mjs <main.js> [out.json]');
  process.exit(1);
}
const src = fs.readFileSync(input, 'utf8');

// Line starts, to report line:column next to the character offset.
const lineStarts = [0];
for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineStarts.push(i + 1);
const lineColumn = (offset) => {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
};

// Find the object literal that contains a `queryId:"` key: walk back to its opening brace,
// then forward to the matching closing brace, skipping string contents.
function enclosingObject(at) {
  let start = src.lastIndexOf('{', at);
  if (start < 0) return null;
  let depth = 0, inString = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

// The literal uses unquoted keys and double-quoted strings only; quote the keys and parse as JSON
// instead of evaluating it.
function parseLiteral(text) {
  const json = text.replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  return JSON.parse(json);
}

const operations = [];
const problems = [];
const needle = /queryId\s*:\s*"/g;
let m;
while ((m = needle.exec(src))) {
  const obj = enclosingObject(m.index);
  if (!obj) { problems.push({ offset: m.index, reason: 'no enclosing object' }); continue; }
  const text = src.slice(obj.start, obj.end);
  const moduleId = src.slice(Math.max(0, obj.start - 40), obj.start).match(/(\d+)\(e\)\{e\.exports=$/)?.[1] || null;
  try {
    const def = parseLiteral(text);
    operations.push({
      operationName: def.operationName,
      operationType: def.operationType,
      queryId: def.queryId,
      featureSwitches: def.metadata?.featureSwitches ?? null,
      fieldToggles: def.metadata?.fieldToggles ?? null,
      otherKeys: Object.keys(def).filter(k => !['queryId', 'operationName', 'operationType', 'metadata'].includes(k)),
      moduleId,
      position: { offset: obj.start, length: obj.end - obj.start, ...lineColumn(obj.start) },
      literal: text.length > 400 ? `${text.slice(0, 400)}…` : text
    });
  } catch (error) {
    problems.push({ offset: obj.start, ...lineColumn(obj.start), reason: error.message, literal: text.slice(0, 300) });
  }
}

const bearer = [...src.matchAll(/Bearer (AAAA[A-Za-z0-9%]+)/g)].map(x => ({ token: x[1], offset: x.index, ...lineColumn(x.index) }));
const names = operations.map(o => o.operationName);
const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
const result = {
  source: input,
  bytes: Buffer.byteLength(src),
  queryIdOccurrences: (src.match(/queryId\s*:\s*"/g) || []).length,
  parsed: operations.length,
  byType: operations.reduce((acc, o) => ({ ...acc, [o.operationType]: (acc[o.operationType] || 0) + 1 }), {}),
  duplicates,
  problems,
  bearer,
  operations
};

const json = JSON.stringify(result, null, 2);
if (output) fs.writeFileSync(output, json); else process.stdout.write(json);
console.error(`${result.parsed}/${result.queryIdOccurrences} definitions parsed, ${problems.length} problems, ${duplicates.length} duplicate names, ${bearer.length} bearer occurrences`);
