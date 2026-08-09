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

// The renderer class ("V" in the 0.6.2 bundle) is NOT reachable as a bare
// identifier from PolyModLoader's own getFromPolyTrack eval() scope — it's
// declared inside its own isolated webpack module closure. What IS reachable
// from that scope is the shared webpack require function itself (bound to
// "i" there), which can reach any module by numeric id. Module 1507 exports
// the class under the alias "A" (`n.d(t,{A:()=>H})` where `H=V`), so
// `i(1507).A` is the exact same class object as `V`. See
// tools/game-bundle.mjs's findRendererAccessPath, which re-derives this
// from a pristine bundle so drift on a game update is caught, not silent.
export const RENDERER_ACCESS = {
  moduleId: 1507,
  exportName: 'A',
};
