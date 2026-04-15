/**
 * 서울 원형 폴백 사이트만 SHP 실측경계로 업그레이드 (빠름)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

function toWGS84(x, y) {
  if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return null;
  try { const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]); return [Math.round(lng*1e13)/1e13, Math.round(lat*1e13)/1e13]; } catch { return null; }
}
function convexHull(points) {
  const pts = [...points].sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  if (pts.length < 3) return null;
  const cr = (O,A,B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
  const lo=[]; for (const p of pts) { while (lo.length>=2 && cr(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop(); lo.push(p); }
  const up=[]; for (const p of [...pts].reverse()) { while (up.length>=2 && cr(up[up.length-2],up[up.length-1],p)<=0) up.pop(); up.push(p); }
  const h = lo.slice(0,-1).concat(up.slice(0,-1)); h.push(h[0]); return h;
}
function areaM2(coords) {
  let a=0; const r=Math.PI/180;
  for (let i=0;i<coords.length;i++) {
    const j=(i+1)%coords.length;
    const x1=coords[i][0]*111320*Math.cos(coords[i][1]*r), y1=coords[i][1]*110540;
    const x2=coords[j][0]*111320*Math.cos(coords[j][1]*r), y2=coords[j][1]*110540;
    a+=x1*y2-x2*y1;
  }
  return Math.abs(a)/2;
}
function polyCenter(coords) {
  let cx=0, cy=0; const n=coords.length-1;
  for (let i=0;i<n;i++) { cx+=coords[i][0]; cy+=coords[i][1]; }
  return [cx/n, cy/n];
}
function isLikelyCircle(coords) {
  if (coords.length < 20 || coords.length > 30) return false;
  const [cx,cy] = polyCenter(coords);
  const dists = coords.slice(0,-1).map(c => Math.sqrt((c[0]-cx)**2+(c[1]-cy)**2));
  const avg = dists.reduce((a,b)=>a+b,0)/dists.length;
  const variance = dists.reduce((a,b)=>a+(b-avg)**2,0)/dists.length;
  return variance/avg < 0.01;
}
function deriveKeywords(name) {
  const parts = name.split(" ").filter(Boolean);
  const kws = new Set([name, name.replace(/\s+/g, "")]);
  parts.forEach(p => kws.add(p));
  if (parts.length > 1) {
    const brand = parts.slice(1).join("");
    kws.add(brand);
    kws.add(parts.slice(1).join(" "));
    if (/\d+$/.test(brand)) {
      const num = brand.match(/(\d+)$/)[1];
      const base = brand.replace(/\d+$/, "");
      kws.add(base + num + "차");
      kws.add(base + num + "단지");
    }
    if (/차$/.test(brand)) kws.add(brand.replace(/차$/, ""));
    if (/단지$/.test(brand)) kws.add(brand.replace(/단지$/, ""));
  }
  return [...kws].filter(k => k.length >= 2);
}

async function findBuildings(shpPath, keywords, centerLat, centerLng) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const matched=[], nearby=[];
  while (true) {
    const {done,value} = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;
    const cx = wgs.reduce((s,c)=>s+c[0],0)/wgs.length;
    const cy = wgs.reduce((s,c)=>s+c[1],0)/wgs.length;
    const d = Math.sqrt((cx-centerLng)**2+(cy-centerLat)**2);
    if (keywords.some(k => nm.includes(k)) && d < 0.003) matched.push({pts: wgs, name: nm, dist: d});
    else if (d < 0.001 && wgs.length >= 8 && areaM2(wgs) > 400) nearby.push({pts: wgs, name: nm, dist: d});
  }
  return {matched, nearby};
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const circleSites = sites.features.filter(f => isLikelyCircle(f.geometry.coordinates[0]));
console.log(`원형 폴백 총: ${circleSites.length}개`);

// 서울만 필터링
const seoulSites = circleSites.filter(f => f.properties.address.includes("서울"));
console.log(`서울 대상: ${seoulSites.length}개\n`);

const tmpDir = "shp_seoul_upgrade";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

const groups = {};
for (const f of seoulSites) {
  const gu = f.properties.address.split(" ")[1];
  const zip = `F_FAC_BUILDING_서울_${gu}.zip`;
  if (!existsSync(zip)) continue;
  if (!groups[zip]) groups[zip] = [];
  groups[zip].push(f);
}

let upgraded = 0;

for (const [zip, list] of Object.entries(groups)) {
  console.log(`── ${zip} (${list.length}개) ──`);
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); } catch (e) { console.log(` fail: ${e.message}`); continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  for (const site of list) {
    const p = site.properties;
    const [cx, cy] = polyCenter(site.geometry.coordinates[0]);
    const keywords = deriveKeywords(p.name);

    let best = null, info = "";
    for (const shp of shpFiles) {
      const {matched, nearby} = await findBuildings(`${tmpDir}/${shp}`, keywords, cy, cx);
      if (matched.length >= 2) {
        const pts = []; matched.forEach(m => m.pts.forEach(p => pts.push(p)));
        best = convexHull(pts); info = `키워드 ${matched.length}동`; break;
      } else if (matched.length === 1 && nearby.length >= 2) {
        const pts = []; matched.forEach(m => m.pts.forEach(p => pts.push(p)));
        nearby.slice(0, 5).forEach(n => n.pts.forEach(p => pts.push(p)));
        best = convexHull(pts); info = `키워드1+주변${Math.min(nearby.length,5)}동`; break;
      } else if (nearby.length >= 4) {
        const sorted = nearby.sort((a,b) => a.dist - b.dist).slice(0, 10);
        best = convexHull(sorted.flatMap(n => n.pts));
        info = `주변${sorted.length}동`; break;
      }
    }

    if (best) {
      site.geometry.coordinates = [best];
      console.log(`  ✓ ${p.name}: ${info} (${Math.round(areaM2(best)).toLocaleString()}㎡)`);
      upgraded++;
    } else {
      console.log(`  - ${p.name}: 매칭 실패`);
    }
  }
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
}

console.log(`\n── 완료 ── ${upgraded}/${seoulSites.length}개 업그레이드`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
