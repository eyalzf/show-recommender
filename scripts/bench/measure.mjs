// Pre-flight cost estimate for the bench suite. Prints JSON:
// { steps, modeled, perModel, total, cap, fits, margin }. No network,
// no AI calls.
// Usage: node scripts/bench/measure.mjs [cases.json] [models.json] [--cap N]
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureSuite } from './lib.mjs';

const dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const positionals = [];
let cap = 2000;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--cap') {
    cap = Number(argv[++i]);
  } else {
    positionals.push(argv[i]);
  }
}
const cases = JSON.parse(await readFile(positionals[0] ?? join(dir, 'cases.json'), 'utf-8'));
const modelsDoc = JSON.parse(await readFile(positionals[1] ?? join(dir, 'models.json'), 'utf-8'));
const estimate = await measureSuite(cases, modelsDoc);
estimate.cap = cap;
estimate.fits = estimate.total <= cap;
estimate.margin = cap - estimate.total;
console.log(JSON.stringify(estimate, null, 2));
if (!estimate.fits) process.exitCode = 2;
