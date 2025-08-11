#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

if (process.argv.length < 4) {
  console.error('Usage: restore-sourcemap <input.map> <output-folder>');
  process.exit(1);
}

const inputMapPath = process.argv[2];
const outputDir = process.argv[3];

// Load and parse source map
let map;
try {
  map = JSON.parse(fs.readFileSync(inputMapPath, 'utf8'));
} catch (err) {
  console.error(`❌ Failed to read or parse ${inputMapPath}:`, err.message);
  process.exit(1);
}

if (!map.sources || !map.sourcesContent) {
  console.error('❌ Source map does not contain sources or sourcesContent.');
  process.exit(1);
}

map.sources.forEach((sourcePath, i) => {
  const content = map.sourcesContent[i];
  if (!content) return; // skip if no source content

  // Clean up Webpack and relative prefixes
  let cleanPath = sourcePath
    .replace(/^webpack:\/\/\//, '')
    .replace(/^webpack:\/\//, '')
    .replace(/^\.\//, '');

  // Final output path
  const filePath = path.join(outputDir, cleanPath);

  // Ensure directory exists
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  // Write file
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`✅ Restored: ${filePath}`);
});

console.log(`🎉 All files restored to: ${outputDir}`);
