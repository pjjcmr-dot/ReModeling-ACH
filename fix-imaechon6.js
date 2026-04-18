/**
 * 분당 이매촌6 청구 위치 수동 보정
 * - 카카오 정확 좌표: 127.12698, 37.39237
 * - 양현로94번길 29 (이매촌6단지 청구아파트, 710세대)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEYS = [
  process.env.VITE_VWORLD_API_KEY,
  "5E98DF37-2739-3211-97EA-B4D2F84FBEE8",
  "D2254EC7-AF49-32B2-BE63-1FC6B72F19DA",
  "5C4953A5-8A28-3F49-91FA-FC9F3C4108EC",
].filter(Boolean);
let kIdx = 0;
const nextKey = () => VWORLD_KEYS[kIdx++ % VWORLD_KEYS.length];
const delay = (ms) => new Promise(r => setTimeout(r, ms));

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
function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
function polyCenter(coords) {
  let cx = 0, cy = 0; const n = coords.length - 1 || 1;
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
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
    const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${nextKey()}&format=json&size=200&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
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

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const target = sites.features.find(f => f.properties.name === "분당 이매촌6 청구");
if (!target) { console.log("타겟 없음"); process.exit(1); }

// 카카오에서 찾은 정확한 좌표
const lat = 37.392371, lng = 127.126985;

console.log(`이매촌6 청구 보정: 정확좌표 (${lng}, ${lat})`);

// 넓은 반경으로 필지 수집 (단지가 600x300m 정도)
const parcels = await fetchParcels(lat, lng, 0.005);
console.log(`VWORLD 필지: ${parcels.length}개`);

const meta = parcels.map(f => {
  const ring = f.geometry.coordinates[0]?.[0] || f.geometry.coordinates[0] || [];
  const area = ring.length >= 3 ? areaM2(ring) : 0;
  const contains = ring.length >= 3 ? pip([lng, lat], ring) : false;
  return { f, ring, area, contains, bonbun: f.properties.bonbun, jibun: f.properties.jibun, addr: f.properties.addr };
});

// 중심점 포함 필지
const containing = meta.filter(m => m.contains);
console.log(`중심점 포함 필지: ${containing.length}개`);
containing.forEach(m => console.log(`  - ${m.addr} | ${m.jibun} | ${Math.round(m.area)}m² | bonbun=${m.bonbun}`));

let selected = [];
if (containing.length > 0) {
  const best = containing.filter(m => (m.jibun||"").includes("대")).sort((a,b)=>b.area-a.area)[0] || containing[0];
  // 같은 본번 + "대" 필지 병합
  selected = meta.filter(m =>
    m.bonbun === best.bonbun &&
    (m.jibun || "").includes("대") &&
    (m.addr || "").split(" ").slice(0, 3).join(" ") === (best.addr || "").split(" ").slice(0, 3).join(" ")
  );
  console.log(`\n선택: 본번 ${best.bonbun}, ${selected.length}필지`);
  selected.forEach(m => console.log(`  - ${m.addr} | ${m.jibun} | ${Math.round(m.area)}m²`));
}

if (selected.length === 0) {
  console.log("필지 매칭 실패");
  process.exit(1);
}

// 병합
const allPts = [];
selected.forEach(m => m.ring.forEach(c => allPts.push(c)));
const hull = convexHull(allPts);
if (!hull) { console.log("hull 실패"); process.exit(1); }

const newArea = areaM2(hull);
const oldCoords = target.geometry.coordinates[0];
const oldArea = areaM2(oldCoords);
const [oldCx, oldCy] = polyCenter(oldCoords);
const [newCx, newCy] = polyCenter(hull);

console.log(`\n기존: 중심 (${oldCx.toFixed(6)}, ${oldCy.toFixed(6)}) / ${Math.round(oldArea).toLocaleString()}m²`);
console.log(`신규: 중심 (${newCx.toFixed(6)}, ${newCy.toFixed(6)}) / ${Math.round(newArea).toLocaleString()}m²`);
console.log(`이동거리: ${Math.round(Math.sqrt(((newCx-oldCx)*111320*Math.cos(lat*Math.PI/180))**2 + ((newCy-oldCy)*110540)**2))}m`);

target.geometry = { type: "Polygon", coordinates: [hull] };
target.properties.boundarySource = "cadastral-manual";
writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log("\n✓ 저장 완료");
