/**
 * 분당 느티 3/4 위치 보정
 * - SHP 건물 BLD_NM 매칭으로 정확한 PNU 가져옴
 * - VWORLD에서 해당 PNU 필지 가져와 병합
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

// SHP 건물 로드
const tmpDir = "shp_neuti";
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
    if (!/느티|한솔/.test(nm)) continue;
    const geomCoords = value.geometry?.coordinates?.[0];
    if (!geomCoords) continue;
    const coords = geomCoords.map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (coords.length < 3) continue;
    const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    // 분당 정자동 근처만
    if (cx < 127.10 || cx > 127.13 || cy < 37.35 || cy > 37.38) continue;
    buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, coords, cx, cy });
  }
}
console.log(`느티/한솔 건물: ${buildings.length}개`);

// 건물명별 PNU 그룹핑
const groups = {};
for (const b of buildings) {
  const key = b.name;
  (groups[key] ||= []).push(b);
}
for (const [name, bs] of Object.entries(groups)) {
  const pnus = [...new Set(bs.map(b => b.pnu).filter(Boolean))];
  const cx = bs.reduce((s, b) => s + b.cx, 0) / bs.length;
  const cy = bs.reduce((s, b) => s + b.cy, 0) / bs.length;
  console.log(`  ${name}: ${bs.length}동, PNU=[${pnus.join(",")}], 중심=(${cx.toFixed(5)},${cy.toFixed(5)})`);
}

// SHP 건물명 패턴별로 매핑
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// SHP에 단지구분 없음 → 카카오 좌표 기반으로 분류
// 느티마을공무원아파트 32동 중 카카오 좌표에 가까운 그룹 = 해당 단지
const neutiBlds = buildings.filter(b => /느티마을공무원아파트/.test(b.name));
console.log(`\n느티마을공무원아파트 ${neutiBlds.length}동 (PNU별):`);
const byPnu = {};
neutiBlds.forEach(b => { (byPnu[b.pnu] ||= []).push(b); });
for (const [pnu, bs] of Object.entries(byPnu)) {
  const cx = bs.reduce((s, b) => s + b.cx, 0) / bs.length;
  const cy = bs.reduce((s, b) => s + b.cy, 0) / bs.length;
  console.log(`  PNU ${pnu}: ${bs.length}동, 중심 (${cx.toFixed(5)}, ${cy.toFixed(5)})`);
}

const TARGETS = [
  { siteName: "분당 느티3", lat: 37.367597, lng: 127.111285 },
  { siteName: "분당 느티4", lat: 37.367347, lng: 127.113554 },
];

for (const { siteName, lat: kLat, lng: kLng } of TARGETS) {
  console.log(`\n=== ${siteName} (카카오: ${kLng}, ${kLat}) ===`);
  const target = sites.features.find(f => f.properties.name === siteName);
  if (!target) { console.log("타겟 없음"); continue; }
  const oldArea = areaM2(target.geometry.coordinates[0]);

  // 카카오 좌표에서 가장 가까운 PNU 그룹 선택
  const pnuDist = Object.entries(byPnu).map(([pnu, bs]) => {
    const cx = bs.reduce((s, b) => s + b.cx, 0) / bs.length;
    const cy = bs.reduce((s, b) => s + b.cy, 0) / bs.length;
    const d = Math.sqrt((cx - kLng) ** 2 + (cy - kLat) ** 2);
    return { pnu, bs, dist: d, cx, cy };
  }).sort((a, b) => a.dist - b.dist);
  const bestGroup = pnuDist[0];
  const matched = bestGroup.bs;
  console.log(`매칭: PNU ${bestGroup.pnu}, ${matched.length}동, 거리 ${Math.round(bestGroup.dist * 111320)}m`);
  if (matched.length === 0) continue;

  const pnus = [bestGroup.pnu];
  const cx = bestGroup.cx;
  const cy = bestGroup.cy;

  // VWORLD 조회 → PNU 매칭
  await delay(400);
  const parcels = await fetchParcels(cy, cx, 0.003);
  console.log(`VWORLD 필지: ${parcels.length}개`);

  let selected = parcels.filter(f => {
    const pnu = f.properties.pnu || f.properties.PNU || "";
    return pnus.includes(pnu);
  });
  console.log(`PNU 매칭 필지: ${selected.length}개`);

  // PNU 매칭 안되면 → 건물 hull로 폴백
  let hull;
  if (selected.length > 0) {
    const allPts = [];
    for (const p of selected) {
      const ring = p.geometry.coordinates[0]?.[0] || p.geometry.coordinates[0];
      if (ring) ring.forEach(c => allPts.push(c));
    }
    hull = convexHull(allPts);
  } else {
    console.log("PNU 매칭 실패 → SHP 건물 hull 사용");
    const allPts = matched.flatMap(b => b.coords);
    hull = convexHull(allPts);
  }

  if (!hull) { console.log("hull 실패"); continue; }
  const newArea = areaM2(hull);
  target.geometry = { type: "Polygon", coordinates: [hull] };
  target.properties.boundarySource = selected.length > 0 ? "cadastral-manual" : "shp-hull-manual";
  console.log(`✓ ${siteName}: ${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m²`);
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log("\n저장 완료");
