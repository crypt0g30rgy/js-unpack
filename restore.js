#!/usr/bin/env node
// restore.js
const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: restore.js <input.map> <output-dir> [--flat] [--verbose] [--dry-run]');
  process.exit(1);
}

// Simple args
let input = null, outDir = null, flat = false, verbose = false, dryRun = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--flat') flat = true;
  else if (a === '--verbose') verbose = true;
  else if (a === '--dry-run') dryRun = true;
  else if (!input) input = a;
  else if (!outDir) outDir = a;
  else { console.error('Unknown arg:', a); usage(); }
}
if (!input || !outDir) usage();

function ensureDirSync(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return;
  } catch (err) {
    // fallback manual mkdir for very old Node versions
    if (fs.existsSync(dir)) return;
    const parts = path.normalize(dir).split(path.sep);
    let cur = parts[0] === '' ? path.sep : parts[0];
    for (let i = (cur === path.sep ? 1 : 1); i < parts.length; i++) {
      cur = path.join(cur, parts[i]);
      if (!fs.existsSync(cur)) fs.mkdirSync(cur);
    }
  }
}

function sanitizeSourcePath(src, sourceRoot) {
  if (!src) return null;

  // remove common protocols and prefixes
  src = src.replace(/^webpack-internal:\/+/, '')
           .replace(/^webpack:\/+/, '')
           .replace(/^file:\/+/, '')
           .replace(/^\/+/, ''); // drop leading slashes

  // drop loader/inline prefixes (e.g. "!!./file.js")
  src = src.replace(/^!+/, '');

  // drop surrounding ./ if present
  src = src.replace(/^\.\//, '');

  // drop query/hash
  src = src.split('?')[0].split('#')[0];

  // if there's a sourceRoot, prepend it (use posix to avoid mixing)
  if (sourceRoot) {
    // handle if sourceRoot is absolute or relative; keep posix join and normalize later
    src = path.posix.join(sourceRoot, src);
  }

  // Normalize to OS-specific path separators
  src = src.split('/').join(path.sep);

  // Remove any leading ../ segments so it cannot escape output dir
  while (src.indexOf('..' + path.sep) === 0) {
    src = src.slice(3);
  }

  return src || null;
}

// Read map
if (!fs.existsSync(input)) {
  console.error('Input file not found:', input);
  process.exit(2);
}

let map;
try {
  const raw = fs.readFileSync(input, 'utf8');
  map = JSON.parse(raw);
} catch (err) {
  console.error('Failed to read/parse source map:', err.message);
  process.exit(3);
}

if (!map.sources || !Array.isArray(map.sources)) {
  console.error('Source map missing "sources" array.');
  process.exit(4);
}

const outRoot = path.resolve(outDir);
if (!dryRun) ensureDirSync(outRoot);

let restored = 0, skippedNoContent = 0, errors = 0;

map.sources.forEach((srcPath, i) => {
  const content = Array.isArray(map.sourcesContent) ? map.sourcesContent[i] : undefined;

  const cleanRel = sanitizeSourcePath(srcPath, map.sourceRoot);
  if (!cleanRel) {
    if (verbose) console.warn(`[skip] empty/unsalvageable source path at index ${i}: "${srcPath}"`);
    return;
  }

  // Destination path
  let destPath = path.resolve(outRoot, cleanRel);
  // Ensure destPath is inside outRoot
  if (!destPath.startsWith(outRoot + path.sep) && destPath !== outRoot) {
    // sanitize by using only basename
    destPath = path.resolve(outRoot, path.basename(cleanRel));
  }

  if (flat) {
    destPath = path.join(outRoot, path.basename(destPath));
  }

  if (verbose) console.log(`[info] source[${i}] -> ${destPath}`);

  if (!content) {
    skippedNoContent++;
    if (verbose) console.warn(`[skip] no sourcesContent for "${srcPath}"`);
    return;
  }

  try {
    const dir = path.dirname(destPath);
    if (!dryRun) ensureDirSync(dir);
    if (!dryRun) fs.writeFileSync(destPath, content, 'utf8');
    restored++;
    console.log(`✅ Restored: ${destPath}`);
  } catch (err) {
    errors++;
    console.error(`❌ Failed to write ${destPath}:`, err.message);
  }
});

console.log(`\nSummary: restored=${restored}, skippedNoContent=${skippedNoContent}, errors=${errors}`);
if (dryRun) console.log('Note: dry-run mode, no files were written.');