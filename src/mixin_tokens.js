// MIXIN_TOKENS: the exact literal strings the DEV FLAVOR's direct bundle
// patch (tools/game-bundle.mjs's patchBundle, used by app_src/main.bundle.js
// for `npm run dev` / `npm run shots`) splices into V.prototype.update's
// source text. That patch happens ONCE, directly on the file, before it's
// ever loaded — so the patched code becomes a completely normal part of the
// module's own source and keeps full closure access to its private fields.
//
// The real PolyModLoader flavor (src/main.mod.js) does NOT use these tokens
// — see that file's header comment for why: PML's registerClassMixin
// reconstructs the target method via `Function.prototype.toString()` +
// `eval()`, which rebinds the new function's closure to wherever that eval()
// runs (PML's own module), not V's — so any reference to V's own closure
// variables (the WeakMaps backing its private fields, e.g. "k", "M", "E") is
// silently unreachable there ("(0, i.gn) is not a function" at runtime, not
// at mixin-registration time). main.mod.js works around this by patching
// prototypes directly instead of going through registerClassMixin at all.
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

// Same idea, for the vendored three.js WebGLRenderer class ("Gt" in the
// 0.6.2 bundle, exported directly as "JeP" — no alias indirection). Reached
// the same way: `i(9437).JeP`. main.mod.js patches THIS class's own
// .prototype.render directly (a normal, closure-safe library class, unlike
// V.prototype.update) instead of trying to reconstruct V's method — see
// tools/game-bundle.mjs's findThreeRendererAccessPath.
export const THREE_RENDERER_ACCESS = {
  moduleId: 9437,
  exportName: 'JeP',
};
