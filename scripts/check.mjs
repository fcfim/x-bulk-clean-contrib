// Syntax-checks every JavaScript file of the extension, scripts and tests (node --check).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['src', 'scripts', 'test'];
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); }
    else if (/\.(m?js)$/.test(entry.name)) files.push(full);
  }
};
roots.filter(r => fs.existsSync(r)).forEach(walk);
let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (error) { failed++; console.error(`✗ ${file}\n${error.stderr?.toString() || error.message}`); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
