/**
 * 분당 한솔6 보정
 * - SHP "한솔마을" 96동 중 카카오 좌표(내정로54) 200m 이내 건물의 PNU 클러스터 식별
 * - 가장 많이 매칭된 PNU 그룹 = 한솔6단지
 * - VWORLD에서 그 PNU 필지 가져와 병합
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

const tmpDir = "shp_hansol6";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);
readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
new AdmZip("F_FAC_BUILDING_경기.zip").extractAllTo(tmpDir, true);
const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

console.log("SHP 로드 중...");
const buildings = [];
for (const shp of shpFiles) {
  const src = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
  while (true) {
    const { done, value } = await src.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    if (!/한솔/.test(nm)) continue;
    const geomCoords = value.geometry?.coordinates?.[0];
    if (!geomCoords) continue;
    const coords = geomCoords.map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (coords.length < 3) continue;
    const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    if (cx < 127.10 || cx > 127.13 || cy < 37.35 || cy > 37.38) continue;
    buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, coords, cx, cy });
  }
}
console.log(`한솔 건물: ${buildings.length}개`);

// 카카오 한솔6 좌표
const kLat = 37.364818, kLng = 127.115921;

// 좌표 200m 이내 한솔마을 건물의 PNU 빈도
const nearby = buildings
  .filter(b => /한솔마을/.test(b.name) && !/상가|관리|경로|어린이|초|중|고/.test(b.name))
  .map(b => ({ ...b, dist: Math.sqrt((b.cx - kLng) ** 2 + (b.cy - kLat) ** 2) }))
  .filter(b => b.dist < 0.0018);  // 약 200m

console.log(`\n카카오 좌표 200m 이내 한솔마을 건물: ${nearby.length}개`);
const pnuCount = {};
nearby.forEach(b => { if (b.pnu) pnuCount[b.pnu] = (pnuCount[b.pnu] || 0) + 1; });
const sortedPnu = Object.entries(pnuCount).sort((a, b) => b[1] - a[1]);
console.log("PNU 분포:");
sortedPnu.forEach(([pnu, cnt]) => console.log(`  ${pnu}: ${cnt}동`));

// 가장 많은 PNU = 한솔6단지의 PNU
const mainPnu = sortedPnu[0]?.[0];
if (!mainPnu) { console.log("PNU 식별 실패"); process.exit(1); }

// 같은 PNU + 가까이 (300m) 있는 보조 PNU도 포함
const mainBlds = nearby.filter(b => b.pnu === mainPnu);
const mainCx = mainBlds.reduce((s, b) => s + b.cx, 0) / mainBlds.length;
const mainCy = mainBlds.reduce((s, b) => s + b.cy, 0) / mainBlds.length;
console.log(`\n주 PNU ${mainPnu}: ${mainBlds.length}동, 중심 (${mainCx.toFixed(5)}, ${mainCy.toFixed(5)})`);

const targetPnus = new Set([mainPnu]);

// VWORLD에서 PNU 필지 가져옴
await delay(400);
const parcels = await fetchParcels(kLat, kLng, 0.003);
console.log(`VWORLD 필지: ${parcels.length}개`);

const selected = parcels.filter(f => targetPnus.has(f.properties.pnu || f.properties.PNU || ""));
console.log(`PNU 매칭 필지: ${selected.length}개`);

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
  hull = convexHull(mainBlds.flatMap(b => b.coords));
}

if (!hull) { console.log("hull 실패"); process.exit(1); }

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const target = sites.features.find(f => f.properties.name === "분당 한솔6");
const oldArea = areaM2(target.geometry.coordinates[0]);
const newArea = areaM2(hull);

target.geometry = { type: "Polygon", coordinates: [hull] };
target.properties.boundarySource = selected.length > 0 ? "cadastral-manual" : "shp-hull-manual";
writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");

console.log(`\n✓ 분당 한솔6: ${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m² (가구당 ${Math.round(newArea/1039)}m²)`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log("저장 완료");
