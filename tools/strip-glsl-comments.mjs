// esbuild's minifier only understands JS — it can't see inside template
// literal strings, so GLSL shader source (which we author as backtick
// strings) keeps every comment verbatim through minification. GLSL has no
// string literal type at all, so `//` and `/*` are unambiguous wherever they
// appear in a shader string — safe to strip with a plain character scan.
//
// Finding the template literals themselves needs a real parser, not a regex:
// a naive `` /`...`/g `` scan corrupted three.core.js's JSDoc comments, which
// use markdown-style single backticks (`` `ShaderMaterial` ``) — an odd
// backtick count inside a comment pairs up across completely unrelated code,
// and the "template literal" that scan finds isn't one.
//
// Only applied to the minified release build (see tools/build.mjs) — the
// dev build keeps shader comments for debuggability.
import fs from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const GLSL_MARKERS = /\bvoid\s+main\s*\(|gl_FragColor|gl_Position|#include\s*</;

export function stripGlslCommentsInSource(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    // Not parseable standalone (e.g. esbuild-specific syntax in some vendor
    // file) — leave it untouched rather than risk corrupting it blind.
    return source;
  }

  const edits = []; // { start, end, replacement }, collected then applied outside-in
  walk.simple(ast, {
    TemplateLiteral(node) {
      const raw = source.slice(node.start, node.end); // includes the backticks
      const inner = raw.slice(1, -1);
      if (!GLSL_MARKERS.test(inner)) return;
      edits.push({ start: node.start, end: node.end, replacement: '`' + stripGlslComments(inner) + '`' });
    },
  });

  if (!edits.length) return source;
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const { start, end, replacement } of edits) {
    out += source.slice(cursor, start) + replacement;
    cursor = end;
  }
  out += source.slice(cursor);
  return out;
}

// Line-preserving: GLSL's `#` preprocessor directives are newline-sensitive,
// so a stripped comment collapses to nothing but never eats a newline.
function stripGlslComments(glsl) {
  let out = '';
  let i = 0;
  const n = glsl.length;
  while (i < n) {
    if (glsl[i] === '/' && glsl[i + 1] === '/') {
      while (i < n && glsl[i] !== '\n') i++;
      continue;
    }
    if (glsl[i] === '/' && glsl[i + 1] === '*') {
      i += 2;
      while (i < n && !(glsl[i] === '*' && glsl[i + 1] === '/')) {
        if (glsl[i] === '\n') out += '\n';
        i++;
      }
      i += 2; // skip closing */
      continue;
    }
    out += glsl[i];
    i++;
  }
  return out;
}

export const stripGlslCommentsPlugin = {
  name: 'strip-glsl-comments',
  setup(build) {
    build.onLoad({ filter: /\.m?js$/ }, async (args) => {
      const contents = stripGlslCommentsInSource(await fs.promises.readFile(args.path, 'utf8'));
      return { contents, loader: 'js' };
    });
  },
};
