/**
 * 리버힐삼성 위치 보정 (서울 용산구)
 * - 카카오: (126.95059, 37.53500) 효창원로 17
 * - SHP F_FAC_BUILDING_서울_용산구.zip 에서 "리버힐" 건물 PNU 식별
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

const VWORLD_KEYS = [
  process.env.VITE_VWORLD_API_KEY,
  "5E98DF37-2739-3211-97EA-B4D2F84FBEE8",
  "D2254EC7-AF49-32B2-BE63-1FC6B72F19DA",
  "5C4953A5-8A28-3F49-91FA-FC9F3C4108EC",
].filter(Boolean);
let kIdx = 0;
const nextKey = () => VWORLD_KEYS[kIdx++ % VWORLD_KEYS.length];
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function toWGS84(x, y) {
  if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return null;
  try { const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]); return [lng, lat]; } catch { return null; }
}
function areaM2(coords) {
  let a = 0; const r = Math.PI / 180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const x1 = coords[i][0] * 111320 * Math.cos(coords[i][1] * r), y1 = coords[i][1] * 110540;
    const x2 = coords[j][0] * 111320 * Math.cos(coords[j][1] * r), y2 = coords[j][1] * 110540;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cr = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  const lo = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (const p of [...pts].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1)); h.push(h[0]); return h;
}

async function fetchParcels(lat, lng, radiusDeg) {
  const bbox = [lng - radiusDeg, lat - radiusDeg, lng + radiusDeg, lat + radiusDeg].join(",");
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${nextKey()}&format=json&size=300&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
    try {
      const res = await fetch(url);
      if (!res.ok) { await delay(700 * (attempt + 1)); continue; }
      const data = await res.json();
      const parcels = data.response?.result?.featureCollection?.features;
      if (parcels && parcels.length > 0) return parcels;
      await delay(700 * (attempt + 1));
    } catch { await delay(700 * (attempt + 1)); }
  }
  return [];
}

const tmpDir = "shp_riverhill";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);
readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
new AdmZip("F_FAC_BUILDING_서울_용산구.zip").extractAllTo(tmpDir, true);
const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

console.log("SHP 로드 중...");
const buildings = [];
for (const shp of shpFiles) {
  const src = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
  while (true) {
    const { done, value } = await src.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    if (!/리버힐|삼성/.test(nm)) continue;
    const geomCoords = value.geometry?.coordinates?.[0];
    if (!geomCoords) continue;
    const coords = geomCoords.map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (coords.length < 3) continue;
    const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, coords, cx, cy });
  }
}
console.log(`리버힐/삼성 건물: ${buildings.length}개`);

const kLat = 37.535001, kLng = 126.950593;

// 카카오 좌표 200m 이내 + "리버힐" 매칭 우선
const matched = buildings
  .filter(b => /리버힐/.test(b.name))
  .map(b => ({ ...b, dist: Math.sqrt((b.cx - kLng) ** 2 + (b.cy - kLat) ** 2) }))
  .filter(b => b.dist < 0.0027)  // ~300m
  .sort((a, b) => a.dist - b.dist);

console.log(`\n리버힐 건물 (300m 이내): ${matched.length}개`);
const pnuCount = {};
matched.forEach(b => { if (b.pnu) pnuCount[b.pnu] = (pnuCount[b.pnu] || 0) + 1; });
const sortedPnu = Object.entries(pnuCount).sort((a, b) => b[1] - a[1]);
console.log("PNU 분포:");
sortedPnu.forEach(([pnu, cnt]) => console.log(`  ${pnu}: ${cnt}동`));

const targetPnus = new Set(sortedPnu.map(([p]) => p));
console.log(`타겟 PNU: ${[...targetPnus].join(", ")}`);

// VWORLD에서 PNU 필지
await delay(400);
const parcels = await fetchParcels(kLat, kLng, 0.004);
console.log(`VWORLD 필지: ${parcels.length}개`);

const selected = parcels.filter(f => targetPnus.has(f.properties.pnu || f.properties.PNU || ""));
console.log(`PNU 매칭 필지: ${selected.length}개`);
selected.forEach(s => {
  const r = s.geometry.coordinates[0]?.[0] || s.geometry.coordinates[0];
  console.log(`  - ${s.properties.pnu} | ${s.properties.addr} | ${s.properties.jibun} | ${Math.round(areaM2(r))}m²`);
});

let hull;
if (selected.length > 0) {
  const allPts = [];
  for (const p of selected) {
    const ring = p.geometry.coordinates[0]?.[0] || p.geometry.coordinates[0];
    if (ring) ring.forEach(c => allPts.push(c));
  }
  hull = convexHull(allPts);
} else {
  console.log("PNU 매칭 실패 → SHP hull 폴백");
  hull = convexHull(matched.flatMap(b => b.coords));
}

if (!hull) { console.log("hull 실패"); process.exit(1); }

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const target = sites.features.find(f => f.properties.name === "리버힐삼성");
const oldArea = areaM2(target.geometry.coordinates[0]);
const newArea = areaM2(hull);
const oldC = target.geometry.coordinates[0];
const oCx = oldC.reduce((s,p)=>s+p[0],0)/oldC.length;
const oCy = oldC.reduce((s,p)=>s+p[1],0)/oldC.length;
const nCx = hull.reduce((s,p)=>s+p[0],0)/hull.length;
const nCy = hull.reduce((s,p)=>s+p[1],0)/hull.length;

target.geometry = { type: "Polygon", coordinates: [hull] };
target.properties.boundarySource = selected.length > 0 ? "cadastral-manual" : "shp-hull-manual";
writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");

console.log(`\n✓ 리버힐삼성: ${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m² (가구당 ${Math.round(newArea/590)}m²)`);
console.log(`이동: (${oCx.toFixed(5)}, ${oCy.toFixed(5)}) → (${nCx.toFixed(5)}, ${nCy.toFixed(5)})`);
console.log(`이동거리: ${Math.round(Math.sqrt(((nCx-oCx)*111320*Math.cos(kLat*Math.PI/180))**2 + ((nCy-oCy)*110540)**2))}m`);

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log("저장 완료");
