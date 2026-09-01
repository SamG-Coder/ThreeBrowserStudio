import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';

const root = path.resolve('dist-pages');
const seen = new Set();
const invalid = [];

function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  if (path.extname(file) === '.json') return;
  const source = readFileSync(file, 'utf8');
  let program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (error) {
    throw new Error(`Could not parse ${path.relative(root, file)}: ${error.message}`, { cause: error });
  }
  for (const statement of program.body) {
    if (!['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type) || !statement.source) continue;
    const specifier = statement.source.value.split('?')[0];
    if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!existsSync(resolved)) invalid.push({ importer: path.relative(root, file), specifier, reason: 'missing' });
      else walk(resolved);
    } else if (specifier.startsWith('node:')) {
      invalid.push({ importer: path.relative(root, file), specifier, reason: 'node-builtin' });
    }
  }
}

walk(path.join(root, 'src', 'viewport', 'main.mjs'));
console.log(JSON.stringify({ modules: seen.size, invalid }, null, 2));
if (invalid.length > 0) process.exitCode = 1;
