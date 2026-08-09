// Generates report.html for a shotbench run (or a comparison between two
// runs) — a contact sheet of every captured preset plus a draggable
// before/after wipe slider. Self-contained (no external requests) so it
// opens fine straight off disk.
import fs from 'node:fs';
import path from 'node:path';

const CSS = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 32px 64px; background: #14171f; color: #e8ebf5; font: 15px/1.5 -apple-system, Segoe UI, Arial, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 36px 0 12px; border-top: 1px solid #2a2f3d; padding-top: 20px; }
  .meta { color: #8b93a8; font-size: 13px; margin-bottom: 20px; }
  .caveat { background: #3a2a12; border: 1px solid #7a5a1f; color: #f0cd8a; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 20px; max-width: 900px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 18px; }
  figure { margin: 0; background: #1c2028; border: 1px solid #2a2f3d; border-radius: 8px; overflow: hidden; }
  figure img { width: 100%; display: block; background: #000; }
  figcaption { padding: 8px 12px; font-size: 13px; display: flex; justify-content: space-between; gap: 8px; }
  figcaption .label { font-weight: 600; }
  figcaption .fps { color: #9fd0ff; font-variant-numeric: tabular-nums; }
  .guard { color: #e8d07f; font-size: 12px; }
  .wipe { position: relative; max-width: 1280px; border: 1px solid #2a2f3d; border-radius: 8px; overflow: hidden; user-select: none; background: #000; }
  .wipe img { display: block; width: 100%; }
  .wipe .overlay { position: absolute; inset: 0; overflow: hidden; }
  .wipe .overlay img { position: absolute; inset: 0; width: 100%; }
  .wipe input[type=range] { width: 100%; margin-top: 10px; }
  .wipe-labels { display: flex; justify-content: space-between; font-size: 13px; color: #9fb0e0; margin-top: 6px; }
  .divider { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 6px rgba(0,0,0,.6); pointer-events: none; }
`;

function wipeSlider(id, labelA, srcA, labelB, srcB) {
  return `
  <div class="wipe" id="${id}">
    <img src="${srcA}" alt="${labelA}">
    <div class="overlay" style="width:50%"><img src="${srcB}" alt="${labelB}"></div>
    <div class="divider" style="left:50%"></div>
  </div>
  <input type="range" min="0" max="100" value="50" data-wipe="${id}">
  <div class="wipe-labels"><span>${labelA}</span><span>${labelB}</span></div>`;
}

const WIPE_JS = `
  for (const input of document.querySelectorAll('input[data-wipe]')) {
    const wipe = document.getElementById(input.dataset.wipe);
    const overlay = wipe.querySelector('.overlay');
    const divider = wipe.querySelector('.divider');
    input.addEventListener('input', () => {
      overlay.style.width = input.value + '%';
      divider.style.left = input.value + '%';
    });
  }
`;

function fpsCell(r) {
  if (r.fps == null) return '';
  const color = r.fps >= 55 ? '#9fe0a0' : r.fps >= 30 ? '#e8d07f' : '#e88f8f';
  return `<span class="fps" style="color:${color}">${r.fps} fps</span>`;
}

function sweepReport(perf) {
  const byKey = Object.fromEntries(perf.results.map((r) => [r.key, r]));
  const cards = perf.results.map((r) => `
    <figure>
      <img src="${r.file}" alt="${r.label}" loading="lazy">
      <figcaption>
        <span class="label">${r.label}</span>
        ${fpsCell(r)}
      </figcaption>
      ${r.guardStep && r.guardStep !== 'full' ? `<div class="guard" style="padding:0 12px 8px">perf guard: ${r.guardStep}</div>` : ''}
    </figure>`).join('\n');

  const stock = byKey.stock, photoreal = byKey.photoreal;
  const wipe = stock && photoreal ? wipeSlider('wipe-main', 'Stock', stock.file, 'Photoreal', photoreal.file) : '';

  const underOff = byKey['underglow-off-night'], underOn = byKey['underglow-on-night'];
  const underWipe = underOff && underOn ? wipeSlider('wipe-underglow', 'Underglow off', underOff.file, 'Underglow on', underOn.file) : '';

  return `
  <h1>PolyFX shotbench — ${perf.label}</h1>
  <div class="meta">Captured ${perf.capturedAt} &middot; ${perf.headless ? 'headless' : 'headed'}${perf.forceGpu ? ' &middot; --force-gpu' : ''}</div>
  ${perf.caveat ? `<div class="caveat">${perf.caveat}</div>` : ''}
  ${perf.pageErrors && perf.pageErrors.length ? `<div class="caveat">${perf.pageErrors.length} page error(s) occurred during capture — see perf.json.</div>` : ''}

  <h2>Stock vs Photoreal</h2>
  ${wipe}

  ${underWipe ? `<h2>Underglow (night)</h2>${underWipe}` : ''}

  <h2>All presets</h2>
  <div class="grid">${cards}</div>
  `;
}

function compareReport(a, b) {
  const aByKey = Object.fromEntries(a.data.results.map((r) => [r.key, r]));
  const bByKey = Object.fromEntries(b.data.results.map((r) => [r.key, r]));
  const keys = [...new Set([...Object.keys(aByKey), ...Object.keys(bByKey)])];

  const wipes = keys.filter((k) => aByKey[k] && bByKey[k]).map((k) => {
    const ra = aByKey[k], rb = bByKey[k];
    const fpsNote = ra.fps != null && rb.fps != null ? `<div class="meta">${ra.fps} fps &rarr; ${rb.fps} fps</div>` : '';
    return `<h2>${ra.label}</h2>${fpsNote}${wipeSlider('wipe-' + k, a.dir, `${a.dir}/${ra.file}`, b.dir, `${b.dir}/${rb.file}`)}`;
  }).join('\n');

  return `
  <h1>PolyFX shotbench — comparison</h1>
  <div class="meta">${a.dir} (${a.data.capturedAt}) vs ${b.dir} (${b.data.capturedAt})</div>
  ${a.data.caveat || b.data.caveat ? `<div class="caveat">One or both runs were captured under a software rasterizer — frame-time deltas are not meaningful, look only at the images.</div>` : ''}
  ${wipes}
  `;
}

export function buildReport(outDir, data) {
  const body = data.mode === 'compare' ? compareReport(data.a, data.b) : sweepReport(data.perf);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PolyFX shotbench</title><style>${CSS}</style></head><body>${body}<script>${WIPE_JS}</script></body></html>`;
  const reportPath = path.join(outDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  return reportPath;
}
