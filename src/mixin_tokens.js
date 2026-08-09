// Single source of truth for the exact literal strings PolyModLoader's
// registerClassMixin matches against V.prototype.update's OWN toString()
// output (not the whole bundle file — see src/main.mod.js for why that
// distinction matters). Shared between src/main.mod.js (the real PML
// mixins), tools/game-bundle.mjs (the direct-patch dev flavor), and
// test/mixin-tokens.test.mjs, so the two patching mechanisms can't silently
// drift apart the way they did once already.
//
// Pure data, no Node APIs — safe to bundle into the browser build.
export const MIXIN_TOKENS = {
  sunInsert: 'getSunPosition());',
  renderTokenStart: '(0,i.gn)(this,k,"f").render(',
  // The exact tail of update()'s own render(...) call PLUS its closing
  // brace — the true end of the method, not a reference to any other one.
  renderTokenEnd: '(0,i.gn)(this,M,"f"))}',
};
