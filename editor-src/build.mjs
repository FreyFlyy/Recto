// build.mjs
// Copyright (C) 2026 Francesco Scolz
// License: AGPL-3.0 (see LICENSE)

// Bundles editor.js into ../static/editor.js and ../static/editor.css (committed, so running Recto needs no Node).
// The output is readable (indented, one comment per bundled module naming its source file).
// `node build.mjs --minify` writes the compact version instead (about a third of the size).
import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const minify = process.argv.includes('--minify');
const out = fileURLToPath(new URL('../static/', import.meta.url));   // .pathname stays %-encoded (spaces, Windows)

const res = await build({
  entryPoints: ['editor.js'],
  outfile: out + 'editor.js',
  bundle: true,
  minify,
  format: 'iife',
  target: ['chrome109', 'firefox100', 'safari15.4'],
  legalComments: 'external',     // third-party licence headers -> static/editor.js.LEGAL.txt
  loader: {'.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty'},
  define: {
    'process.env.NODE_ENV': '"production"',
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  metafile: true,
  logLevel: 'info',
});

// KaTeX's stylesheet declares ~20 font files; the editor renders MathML, so the fonts are never used.
// Drop the @font-face rules so the browser does not try (and the whitelist does not need) to fetch them.
const cssPath = out + 'editor.css';
let css = await readFile(cssPath, 'utf8');
const before = css.length;
css = css.replace(/@font-face\s*\{[^}]*\}/g, '');
await writeFile(cssPath, css);
console.log(`editor.css: removed ${before - css.length} bytes of @font-face rules`);
