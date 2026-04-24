/**
 * 경기 원형 폴백 사이트 → SHP 실측 (한번 읽고 모든 사이트 매칭 = 최적화)
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
      kws.add(base + num + "차"); kws.add(base + num + "단지");
      kws.add(base + "마을"); kws.add(base + " " + num + "단지");
    }
    if (/차$/.test(brand)) kws.add(brand.replace(/차$/, ""));
    if (/단지$/.test(brand)) kws.add(brand.replace(/단지$/, ""));
  }
  return [...kws].filter(k => k.length >= 2);
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const circleSites = sites.features.filter(f => isLikelyCircle(f.geometry.coordinates[0]));
const gyeonggiSites = circleSites.filter(f => {
  const a = f.properties.address;
  return a.includes("성남") || a.includes("분당") || a.includes("수원") || a.includes("안양") || a.includes("용인") || a.includes("고양") || a.includes("광명") || a.includes("군포") || a.includes("부천");
});
console.log(`경기 대상: ${gyeonggiSites.length}개`);

if (gyeonggiSites.length === 0) {
  console.log("처리할 사이트 없음.");
  process.exit(0);
}

// 각 사이트별 center + keywords 준비
const targets = gyeonggiSites.map(f => {
  const [cx, cy] = polyCenter(f.geometry.coordinates[0]);
  return {
    site: f,
    name: f.properties.name,
    lat: cy, lng: cx,
    keywords: deriveKeywords(f.properties.name),
    matched: [], nearby: [],
  };
});
targets.forEach(t => console.log(`  - ${t.name} @ ${t.lat.toFixed(4)},${t.lng.toFixed(4)} kws=[${t.keywords.slice(0,5).join(",")}...]`));

const tmpDir = "shp_gy_upgrade";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);
readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });

console.log("\nSHP 압축 해제 중... (~1분)");
const t0 = Date.now();
new AdmZip("F_FAC_BUILDING_경기.zip").extractAllTo(tmpDir, true);
console.log(`압축 해제 완료 (${((Date.now()-t0)/1000).toFixed(1)}s)`);

const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));
console.log(`SHP 파일: ${shpFiles.length}개`);

// 한 번만 읽고 모든 타겟에 대해 매칭
let recordCount = 0;
const t1 = Date.now();
for (const shp of shpFiles) {
  console.log(`\n스캔 중: ${shp}...`);
  const source = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
  while (true) {
    const {done, value} = await source.read();
    if (done) break;
    recordCount++;
    if (recordCount % 50000 === 0) console.log(`  ... ${recordCount.toLocaleString()}개 스캔`);

    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;
    const cx = wgs.reduce((s,c)=>s+c[0],0)/wgs.length;
    const cy = wgs.reduce((s,c)=>s+c[1],0)/wgs.length;

    for (const t of targets) {
      const d = Math.sqrt((cx - t.lng)**2 + (cy - t.lat)**2);
      if (d > 0.003) continue; // 300m 넘으면 skip
      if (t.keywords.some(k => nm.includes(k))) {
        t.matched.push({pts: wgs, name: nm, dist: d});
      } else if (d < 0.0012 && wgs.length >= 8 && areaM2(wgs) > 400) {
        t.nearby.push({pts: wgs, name: nm, dist: d});
      }
    }
  }
}
console.log(`스캔 완료: ${recordCount.toLocaleString()}개 건물 (${((Date.now()-t1)/1000).toFixed(0)}s)`);

// 결과 적용
let upgraded = 0;
for (const t of targets) {
  let best = null, info = "";
  if (t.matched.length >= 2) {
    const pts = []; t.matched.forEach(m => m.pts.forEach(p => pts.push(p)));
    best = convexHull(pts); info = `키워드 ${t.matched.length}동`;
  } else if (t.matched.length === 1 && t.nearby.length >= 2) {
    const pts = []; t.matched.forEach(m => m.pts.forEach(p => pts.push(p)));
    t.nearby.slice(0, 5).forEach(n => n.pts.forEach(p => pts.push(p)));
    best = convexHull(pts); info = `키워드1+주변${Math.min(t.nearby.length,5)}동`;
  } else if (t.nearby.length >= 4) {
    const sorted = t.nearby.sort((a,b) => a.dist - b.dist).slice(0, 10);
    best = convexHull(sorted.flatMap(n => n.pts));
    info = `주변${sorted.length}동`;
  }

  if (best) {
    t.site.geometry.coordinates = [best];
    console.log(`  ✓ ${t.name}: ${info} (${Math.round(areaM2(best)).toLocaleString()}㎡)`);
    upgraded++;
  } else {
    console.log(`  - ${t.name}: 매칭 실패 (키워드 ${t.matched.length}, 주변 ${t.nearby.length})`);
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n── 완료 ── ${upgraded}/${targets.length}개 업그레이드`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
