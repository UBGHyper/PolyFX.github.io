import fs from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const GLSL_MARKERS = /\bvoid\s+main\s*\(|gl_FragColor|gl_Position|#include\s*</;

export function stripGlslCommentsInSource(source) {
  let ast;
  try {
    ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return source;
  }

  const edits = [];
  walk.simple(ast, {
    TemplateLiteral(node) {
      const raw = source.slice(node.start, node.end);
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
      i += 2;
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
