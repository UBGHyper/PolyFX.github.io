# Third-party licenses

## three.js

Vendored in `src/vendor/three.module.js`, `src/vendor/three.core.js`, and `src/vendor/addons/`
(r181).

```
Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## N8AO

Vendored in `src/vendor/addons/N8AO.js`. Bundled from its original npm package with no license
header retained in the file — check the upstream N8AO project for its exact terms.

Patched from upstream (1.1.0): in the half-res compositor's bilateral-upsample branch, `vec4 texel;`
was declared without an initializer and then accumulated into with `+=` — undefined per the GLSL ES
spec, and a real source of garbage/black-halo pixels on backends that don't happen to zero-init
locals (ANGLE-on-Metal, notably). The same branch's background early-out also wrote `vec4(0.0, 0.0,
0.0, 1.0)` for sky pixels where every other AO code path (the AO-computation shader's own
`depth == 1.0` branch, and the non-half-res compositor path) treats background as fully-unoccluded
white — the mismatch composited a black tint onto any thin, sky-silhouetted geometry (warning signs,
in practice) whenever half-res AO was active. Both are now `vec4(0.0)` initialization and `vec4(1.0)`
for the early-out, matching the rest of the pass.

This was a real, independently-confirmed bug, but turned out not to be *the* warning-sign black-box
players kept reporting — user testing (turning Bloom off made it go away, not AO) pointed at
`UnrealBloomPass`/`LuminosityHighPassShader` instead. See that section below.

## three.js addons — UnrealBloomPass / LuminosityHighPassShader

Vendored in `src/vendor/addons/postprocessing/UnrealBloomPass.js` and
`src/vendor/addons/shaders/LuminosityHighPassShader.js` (r181, same license as three.js above).

Patched (1.1.1): `LuminosityHighPassShader` read the scene's raw linear HDR color with no bounds
checking at all — the very first step in bloom's pipeline. A single non-finite (NaN/Infinity) or
absurdly large pixel there survives five levels of Gaussian downsampling in `UnrealBloomPass`; at
the coarsest mip (roughly 1/32 resolution) one bad texel's blur kernel covers a large fraction of
the entire mip, and additive-composites back across a correspondingly large fraction of the final
frame — consistent with reports of a black rectangle flashing across half the screen specifically
near warning signs (thin, double-sided, grazing-angle-lit geometry is a plausible source of an
unstable one-frame shading spike). Added an explicit NaN guard (`c != c`, reliable in every GLSL
version, unlike `clamp()`/`min()` with a NaN operand which the spec leaves implementation-defined)
plus a magnitude clamp, and a `debugHighlightNonFinite` uniform (PolyFX panel: "Highlight Bloom
Overflow") that renders caught pixels as a large finite magenta value instead of zero, so the
bloom itself makes the culprit region visible on screen instead of merely suppressing it silently.
