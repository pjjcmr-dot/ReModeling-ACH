/**
 * 과대 경계 보정 스크립트
 * - 가구당 면적 > 200m² 이상인 단지를 재조회
 * - VWORLD 지적도 조회를 더 작은 반경 + 엄격한 필지 선택으로 재시도
 * - SHP hull 폴백 단지는 VWORLD 재시도 (더 긴 딜레이)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
const VWORLD_KEYS = [
  process.env.VITE_VWORLD_API_KEY,
  "5E98DF37-2739-3211-97EA-B4D2F84FBEE8",
  "D2254EC7-AF49-32B2-BE63-1FC6B72F19DA",
  "5C4953A5-8A28-3F49-91FA-FC9F3C4108EC",
].filter(Boolean);
let vwKeyIdx = 0;
function nextVwKey() { const k = VWORLD_KEYS[vwKeyIdx % VWORLD_KEYS.length]; vwKeyIdx++; return k; }

const kHeaders = { Authorization: `KakaoAK ${KAKAO_KEY}` };
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

// 카카오 좌표 검색
async function kakaoCenter(siteName, address) {
  if (!KAKAO_KEY) return null;
  let anchorX, anchorY;
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers: kHeaders });
    const d = await r.json();
    if (d.documents?.[0]) { anchorX = +d.documents[0].x; anchorY = +d.documents[0].y; }
  } catch {}
  await delay(80);

  const parts = siteName.split(/\s+/);
  const rest = parts.slice(1).join("");
  const dong = address.split(/\s+/).pop();
  const queries = [siteName + " 아파트", siteName, rest + " 아파트", dong + " " + rest + " 아파트"];
  for (const q of queries) {
    try {
      const url = anchorX
        ? `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&x=${anchorX}&y=${anchorY}&radius=3000&size=15&sort=distance`
        : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=15`;
      const r = await fetch(url, { headers: kHeaders });
      const d = await r.json();
      for (const doc of d.documents || []) {
        const addr = (doc.road_address_name || doc.address_name || "");
        const regionOK = address.split(/\s+/).slice(0, 2).every(p => addr.includes(p));
        if (!regionOK) continue;
        if (!/아파트|주거|부동산/.test(doc.category_name || "")) continue;
        await delay(80);
        return { lat: +doc.y, lng: +doc.x };
      }
    } catch {}
    await delay(80);
  }
  return null;
}

// VWORLD 지적도 (강화된 재시도)
async function fetchParcels(lat, lng, radiusDeg) {
  const bbox = [lng - radiusDeg, lat - radiusDeg, lng + radiusDeg, lat + radiusDeg].join(",");
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = nextVwKey();
    const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${key}&format=json&size=100&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
    try {
      const res = await fetch(url);
      if (!res.ok) { await delay(800 * (attempt + 1)); continue; }
      const data = await res.json();
      const parcels = data.response?.result?.featureCollection?.features;
      if (parcels && parcels.length > 0) return parcels;
      if (attempt < 3) { await delay(800 * (attempt + 1)); continue; }
      return [];
    } catch {
      if (attempt < 3) { await delay(800 * (attempt + 1)); continue; }
      return [];
    }
  }
  return [];
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;

// 과대 경계 식별: 가구당 면적 > 200 m² 또는 shp-hull 중 > 80K m²
const targets = features.filter(f => {
  const c = f.geometry.coordinates[0];
  const area = areaM2(c);
  const hh = f.properties.households || 300;
  const perHH = area / hh;
  const src = f.properties.boundarySource;
  // shp-hull > 80K or cadastral with per-household > 200
  if (src === "shp-hull" && area > 80000) return true;
  if (area > 100000 && perHH > 200) return true;
  return false;
});

console.log(`\n=== 과대 경계 보정 (${targets.length}개) ===\n`);

let improved = 0, kept = 0;

for (const site of targets) {
  const p = site.properties;
  const oldCoords = site.geometry.coordinates[0];
  const oldArea = areaM2(oldCoords);
  const hh = p.households || 300;

  // 1. 카카오 정밀 좌표
  const kres = await kakaoCenter(p.name, p.address);
  let lat, lng;
  if (kres) { lat = kres.lat; lng = kres.lng; }
  else { const [cx, cy] = polyCenter(oldCoords); lng = cx; lat = cy; }

  // 2. VWORLD 조회 — 작은 반경부터 시도
  await delay(500);
  let parcels = await fetchParcels(lat, lng, 0.002);
  if (parcels.length === 0) {
    await delay(500);
    parcels = await fetchParcels(lat, lng, 0.003);
  }
  if (parcels.length === 0) {
    await delay(500);
    parcels = await fetchParcels(lat, lng, 0.004);
  }

  if (parcels.length === 0) {
    console.log(`  - ${p.name}: VWORLD 실패 → 유지 (${Math.round(oldArea).toLocaleString()}m²)`);
    kept++;
    continue;
  }

  // 3. 중심점 포함 필지 찾기
  const meta = parcels.map(f => {
    const ring = f.geometry.coordinates[0]?.[0] || f.geometry.coordinates[0] || [];
    const area = ring.length >= 3 ? areaM2(ring) : 0;
    const contains = ring.length >= 3 ? pip([lng, lat], ring) : false;
    return { f, ring, area, contains, bonbun: f.properties.bonbun, jibun: f.properties.jibun, addr: f.properties.addr };
  });

  const containing = meta.filter(m => m.contains);
  let selectedParcels = [];

  if (containing.length > 0) {
    // 가장 큰 주거("대") 필지 선택
    const resCont = containing.filter(m => (m.jibun || "").includes("대"));
    const best = (resCont.length > 0 ? resCont : containing).sort((a, b) => b.area - a.area)[0];

    // 같은 본번 + 같은 동 주소의 필지 병합
    const sameBonbun = meta.filter(m =>
      m.bonbun === best.bonbun &&
      (m.jibun || "").includes("대") &&
      (m.addr || "").split(" ").slice(0, 3).join(" ") === (best.addr || "").split(" ").slice(0, 3).join(" ")
    );
    selectedParcels = (sameBonbun.length > 1 ? sameBonbun : [best]).map(m => m.f);
  } else {
    // 가장 가까운 대형 주거 필지
    const resParcels = meta
      .filter(m => (m.jibun || "").includes("대") && m.area >= hh * 5 && m.area <= hh * 150)
      .sort((a, b) => {
        const ca = polyCenter(a.ring), cb = polyCenter(b.ring);
        const da = Math.sqrt((ca[0] - lng) ** 2 + (ca[1] - lat) ** 2);
        const db = Math.sqrt((cb[0] - lng) ** 2 + (cb[1] - lat) ** 2);
        return da - db;
      });
    if (resParcels.length > 0) {
      const best = resParcels[0];
      const sameBonbun = meta.filter(m => m.bonbun === best.bonbun && (m.jibun || "").includes("대"));
      selectedParcels = (sameBonbun.length > 1 ? sameBonbun : [best]).map(m => m.f);
    }
  }

  if (selectedParcels.length === 0) {
    console.log(`  - ${p.name}: 필지 매칭 실패 → 유지 (${Math.round(oldArea).toLocaleString()}m²)`);
    kept++;
    continue;
  }

  // 4. 병합
  const allPts = [];
  for (const sp of selectedParcels) {
    const ring = sp.geometry.coordinates[0]?.[0] || sp.geometry.coordinates[0];
    if (ring) ring.forEach(c => allPts.push(c));
  }
  const hull = convexHull(allPts);
  if (!hull) { kept++; continue; }

  const newArea = areaM2(hull);
  const perHH = newArea / hh;

  // 새 경계가 합리적인지 검증 (면적 300~가구당 150m² 이내)
  if (newArea < 300 || perHH > 200) {
    console.log(`  ? ${p.name}: 새 경계도 부적합 (${Math.round(newArea).toLocaleString()}m², ${Math.round(perHH)}m²/가구) → 유지`);
    kept++;
    continue;
  }

  // 기존보다 개선되었는지 (면적이 줄었거나 가구당 면적이 더 합리적)
  if (newArea >= oldArea * 0.95) {
    console.log(`  = ${p.name}: 개선 없음 (${Math.round(newArea).toLocaleString()} vs ${Math.round(oldArea).toLocaleString()}m²) → 유지`);
    kept++;
    continue;
  }

  site.geometry = { type: "Polygon", coordinates: [hull] };
  p.boundarySource = "cadastral-fix";
  improved++;
  const ratio = Math.round(newArea / oldArea * 100);
  console.log(`  ✓ ${p.name}: ${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m² (${ratio}%, ${selectedParcels.length}필지)`);
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n개선: ${improved}개 / 유지: ${kept}개`);
console.log("완료.");
