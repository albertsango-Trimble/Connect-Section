// Builds src/data/epsg-projected.json: every projected coordinate system in the EPSG registry that proj4 can use,
// from the epsg-index package. Run with: node scripts/build-epsg-registry.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const all = JSON.parse(readFileSync(new URL('../node_modules/epsg-index/all.json', import.meta.url), 'utf8'));
const rows = [];
for (const entry of Object.values(all)) {
  if (entry.kind !== 'CRS-PROJCRS' || !entry.proj4) continue;
  let proj4 = entry.proj4.replace(/\s*\+type=crs/, '').trim();
  let approx = 0;
  // proj4js can't read datum shift grids; use the seven-parameter shift from the definition where it has one, else go without.
  const grid = /\s\+nadgrids=(?!@null)\S+/.exec(proj4);
  if (grid) {
    const towgs = entry.wkt && /TOWGS84\[([^\]]+)\]/.exec(entry.wkt);
    // Well-known seven-parameter approximations (good to a few metres) for datums whose registry shift is a grid.
    const known = /^DHDN \//.test(entry.name) ? '598.1,73.7,418.2,0.202,0.045,-2.455,6.7' : /^OSGB(36| 1936)? ?\//.test(entry.name) ? '446.448,-125.157,542.06,0.15,0.247,0.842,-20.489' : null;
    const shift = towgs ? towgs[1] : known;
    proj4 = proj4.replace(grid[0], shift ? ` +towgs84=${shift}` : '');
    if (!shift) approx = 1;
  }
  const country = (entry.area ?? '').split(/ - |, /)[0].slice(0, 40);
  const bbox = Array.isArray(entry.bbox) ? entry.bbox.map((v) => Math.round(v * 100) / 100) : null;
  // [code, name, proj4, country, bbox (north, west, south, east), approximate]
  rows.push([Number(entry.code), entry.name, proj4, country, bbox, approx]);
}
rows.sort((a, b) => a[0] - b[0]);
writeFileSync(new URL('../src/data/epsg-projected.json', import.meta.url), JSON.stringify(rows));
console.log(`${rows.length} coordinate systems`);
