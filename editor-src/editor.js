// editor.js
// Copyright (C) 2026 Francesco Scolz
// License: AGPL-3.0 (see LICENSE)

// Entry point of the bundle served as static/editor.js (+ editor.css). Build: `npm run build`.
// Exposes window.RectoEditor with:
//   create(root, opts) -> Promise<{getMarkdown, focus, destroy}>   WYSIWYG Markdown editor (Milkdown/Crepe)
//   render(markdown)   -> HTML string                              read-only renderer for the study view
// Cards are plain Markdown (GFM tables, $inline$ and $$block$$ math, images). Raw HTML is never interpreted.

import '@milkdown/crepe/theme/common/style.css';

import { EditorView } from '@codemirror/view';
import { LanguageDescription } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { sql } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';
import { CrepeBuilder } from '@milkdown/crepe/builder';
import { blockEdit } from '@milkdown/crepe/feature/block-edit';
import { codeMirror } from '@milkdown/crepe/feature/code-mirror';
import { cursor } from '@milkdown/crepe/feature/cursor';
import { imageBlock } from '@milkdown/crepe/feature/image-block';
import { latex } from '@milkdown/crepe/feature/latex';
import { linkTooltip } from '@milkdown/crepe/feature/link-tooltip';
import { listItem } from '@milkdown/crepe/feature/list-item';
import { placeholder } from '@milkdown/crepe/feature/placeholder';
import { table } from '@milkdown/crepe/feature/table';
import { topBar } from '@milkdown/crepe/feature/top-bar';
import rehypeKatex from 'rehype-katex';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

// MathML only: KaTeX's HTML output relies on inline style="" attributes, which the CSP (style-src 'self') blocks,
// and its CSS would need font files. MathML needs neither.
const KATEX = { output: 'mathml', throwOnError: false };

// Cards reference uploaded images as "media/<32 hex>.<ext>"; the server serves them at api/media/<name>.
const MEDIA_RE = /^media\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))$/;
const mediaUrl = src => {
  const m = MEDIA_RE.exec(src);
  return m ? 'api/media/' + m[1] : src;
};

// CodeMirror injects <style> tags: the CSP allows them only with the per-response nonce the server puts in a <meta>.
const nonce = () => document.querySelector('meta[name="csp-nonce"]')?.content || '';

// A short list on purpose: @codemirror/language-data would pull every language into the bundle.
const LANGUAGES = [
  LanguageDescription.of({name: 'Python', alias: ['py'], extensions: ['py'], support: python()}),
  LanguageDescription.of({name: 'JavaScript', alias: ['js', 'ts', 'typescript'], extensions: ['js', 'ts'], support: javascript({typescript: true})}),
  LanguageDescription.of({name: 'SQL', extensions: ['sql'], support: sql()}),
  LanguageDescription.of({name: 'C++', alias: ['c', 'cpp'], extensions: ['c', 'cpp', 'h'], support: cpp()}),
  LanguageDescription.of({name: 'Java', extensions: ['java'], support: java()}),
];

async function create(root, {value = '', placeholder: hint = '', onUpload} = {}) {
  const b = new CrepeBuilder({root, defaultValue: value});

  b.addFeature(cursor)
    .addFeature(listItem)
    .addFeature(linkTooltip)
    .addFeature(imageBlock, {
      onUpload,
      proxyDomURL: mediaUrl,
      blockOnUpload: onUpload,
      inlineOnUpload: onUpload,
    })
    .addFeature(blockEdit)
    .addFeature(placeholder, {text: hint, mode: 'doc'})
    .addFeature(codeMirror, {
      theme: oneDark,
      languages: LANGUAGES,
      extensions: [EditorView.cspNonce.of(nonce())],
    })
    .addFeature(table)
    .addFeature(latex, {katexOptions: KATEX})
    .addFeature(topBar);

  await b.create();

  return {
    getMarkdown: () => b.getMarkdown().trim(),
    focus: () => root.querySelector('.ProseMirror')?.focus(),
    destroy: () => b.destroy(),
  };
}


// ---------- read-only renderer (study view) ----------

// Raw HTML in a card is shown as text, like the editor does, instead of being dropped or executed.
const htmlAsText = () => tree => visit(tree, 'html', n => { n.type = 'text'; });

// The default sanitize schema strips the classes remark-math uses to mark formulas.
const schema = structuredClone(defaultSchema);
schema.attributes.code = [...(schema.attributes.code || []),
  ['className', 'language-math', 'math-inline', 'math-display']];

// Applied after sanitising: media paths -> API urls, ratio-only alt text dropped, links open outside the app.
const finish = () => tree => visit(tree, 'element', n => {
  if (n.tagName === 'img') {
    n.properties.src = mediaUrl(String(n.properties.src || ''));
    if (/^\d+(\.\d+)?$/.test(n.properties.alt || '')) n.properties.alt = '';   // image-block stores its aspect ratio as alt text
  } else if (n.tagName === 'a') {
    n.properties.target = '_blank';
    n.properties.rel = 'noopener noreferrer';
  }
});

const renderer = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(htmlAsText)
  .use(remarkRehype)
  .use(rehypeSanitize, schema)
  .use(finish)
  .use(rehypeKatex, KATEX)
  .use(rehypeStringify);

const render = md => String(renderer.processSync(String(md)));

window.RectoEditor = {create, render};
