#!/usr/bin/env nodejs
// restore.js
const fs = require('fs');
const path = require('path');

function usage() {
  console.error('Usage: restore.js <input.map|dir|glob> <output-dir> [--flat] [--verbose] [--dry-run] [--recursive]');
  console.error('  <input.map|dir|glob> can be:');
  console.error('    - a single .map file');
  console.error('    - a directory (all *.map files in it are processed)');
  console.error('    - a glob like "./maps/*.map" (simple * and ? wildcards only)');
  process.exit(1);
}

// Simple args
let input = null, outDir = null, flat = false, verbose = false, dryRun = false, recursive = false;
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--flat') flat = true;
  else if (a === '--verbose') verbose = true;
  else if (a === '--dry-run') dryRun = true;
  else if (a === '--recursive') recursive = true;
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

// --- New: resolve input (file, directory, or simple glob) into a list of .map files ---

function isGlob(str) {
  return /[*?]/.test(str);
}

function globToRegExp(glob) {
  // Escape regex special chars except * and ?
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + pattern + '$');
}

function walkDir(dir, recurse, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error(`❌ Cannot read directory ${dir}:`, err.message);
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) walkDir(full, recurse, acc);
    } else if (entry.isFile() && full.toLowerCase().endsWith('.map')) {
      acc.push(full);
    }
  }
  return acc;
}

function resolveInputFiles(inputArg, recurse) {
  // Directory case
  if (fs.existsSync(inputArg) && fs.statSync(inputArg).isDirectory()) {
    return walkDir(inputArg, recurse, []);
  }

  // Glob case: split into dir part + pattern part
  if (isGlob(inputArg)) {
    const dir = path.dirname(inputArg);
    const pattern = path.basename(inputArg);
    const baseDir = dir === '' ? '.' : dir;

    if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
      console.error('Glob base directory not found:', baseDir);
      return [];
    }

    const regex = globToRegExp(pattern);
    const matchDir = (d, acc) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (err) {
        console.error(`❌ Cannot read directory ${d}:`, err.message);
        return acc;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          if (recurse) matchDir(full, acc);
        } else if (entry.isFile() && regex.test(entry.name)) {
          acc.push(full);
        }
      }
      return acc;
    };
    return matchDir(baseDir, []);
  }

  // Single file case
  if (!fs.existsSync(inputArg)) {
    console.error('Input file not found:', inputArg);
    return [];
  }
  return [inputArg];
}

// --- Process a single .map file; never throws, returns per-file stats ---

function processMapFile(mapFile, outRoot, opts) {
  const stats = { restored: 0, skippedNoContent: 0, errors: 0, valid: true };

  let map;
  try {
    const raw = fs.readFileSync(mapFile, 'utf8');
    map = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ [${mapFile}] Failed to read/parse source map: ${err.message}`);
    stats.valid = false;
    stats.errors++;
    return stats;
  }

  if (!map.sources || !Array.isArray(map.sources)) {
    console.error(`❌ [${mapFile}] Invalid source map: missing "sources" array.`);
    stats.valid = false;
    stats.errors++;
    return stats;
  }

  if (!opts.dryRun) ensureDirSync(outRoot);

  map.sources.forEach((srcPath, i) => {
    const content = Array.isArray(map.sourcesContent) ? map.sourcesContent[i] : undefined;

    const cleanRel = sanitizeSourcePath(srcPath, map.sourceRoot);
    if (!cleanRel) {
      if (opts.verbose) console.warn(`[skip] [${mapFile}] empty/unsalvageable source path at index ${i}: "${srcPath}"`);
      return;
    }

    // Destination path
    let destPath = path.resolve(outRoot, cleanRel);
    // Ensure destPath is inside outRoot
    if (!destPath.startsWith(outRoot + path.sep) && destPath !== outRoot) {
      // sanitize by using only basename
      destPath = path.resolve(outRoot, path.basename(cleanRel));
    }

    if (opts.flat) {
      destPath = path.join(outRoot, path.basename(destPath));
    }

    if (opts.verbose) console.log(`[info] [${mapFile}] source[${i}] -> ${destPath}`);

    if (!content) {
      stats.skippedNoContent++;
      if (opts.verbose) console.warn(`[skip] [${mapFile}] no sourcesContent for "${srcPath}"`);
      return;
    }

    try {
      const dir = path.dirname(destPath);
      if (!opts.dryRun) ensureDirSync(dir);
      if (!opts.dryRun) fs.writeFileSync(destPath, content, 'utf8');
      stats.restored++;
      console.log(`✅ [${mapFile}] Restored: ${destPath}`);
    } catch (err) {
      stats.errors++;
      console.error(`❌ [${mapFile}] Failed to write ${destPath}: ${err.message}`);
    }
  });

  return stats;
}

// --- Main ---

const outRoot = path.resolve(outDir);
const mapFiles = resolveInputFiles(input, recursive);

if (mapFiles.length === 0) {
  console.error('No .map files found for input:', input);
  process.exit(2);
}

if (verbose || mapFiles.length > 1) {
  console.log(`Found ${mapFiles.length} map file(s) to process.`);
}

const opts = { flat, verbose, dryRun };

let totals = { files: 0, validFiles: 0, invalidFiles: 0, restored: 0, skippedNoContent: 0, errors: 0 };

for (const mapFile of mapFiles) {
  totals.files++;
  const stats = processMapFile(mapFile, outRoot, opts);
  if (!stats.valid) {
    totals.invalidFiles++;
    continue; // keep going with the next file
  }
  totals.validFiles++;
  totals.restored += stats.restored;
  totals.skippedNoContent += stats.skippedNoContent;
  totals.errors += stats.errors;
}

console.log(`\nSummary: files=${totals.files}, valid=${totals.validFiles}, invalid=${totals.invalidFiles}, restored=${totals.restored}, skippedNoContent=${totals.skippedNoContent}, errors=${totals.errors}`);
if (dryRun) console.log('Note: dry-run mode, no files were written.');
if (totals.invalidFiles > 0) process.exitCode = 5;
