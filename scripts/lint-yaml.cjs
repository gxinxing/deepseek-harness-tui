#!/usr/bin/env node
// YAML lint: GitHub Actions structure validator using actionlint (WASM)
// Use .cjs extension for CommonJS compatibility with actionlint WASM loader
const { createLinter } = require('actionlint');
const { readFileSync } = require('node:fs');
const { resolve, extname } = require('node:path');

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/lint-yaml.cjs <yml-file> [<yml-file> ...]');
  process.exit(1);
}

let hadError = false;

async function lintFile(filePath) {
  const absPath = resolve(filePath);
  const content = readFileSync(absPath, 'utf8');
  // createLinter() returns RunActionlint = (input: string, path: string) => LintResult[]
  const lint = await createLinter();
  const results = lint(content, absPath);
  if (results.length > 0) {
    hadError = true;
    for (const msg of results) {
      const loc = `line ${msg.line} col ${msg.column}`;
      const prefix = `${absPath}:${loc}: `;
      const level = msg.kind === 'error' ? 'error' : msg.kind === 'warning' ? 'warning' : '';
      console.error(`${prefix}${level ? `[${level}] ` : ''}${msg.message}`);
    }
  }
}

(async () => {
  for (const f of files) {
    if (extname(f) !== '.yml' && extname(f) !== '.yaml') {
      console.warn(`Skipping non-YAML file: ${f}`);
      continue;
    }
    await lintFile(f);
  }
  process.exit(hadError ? 1 : 0);
})();
