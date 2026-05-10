/**
 * Re-fetch boundaries for sites where the cadastral lookup picked a tiny parcel
 * (e.g. only a 상가동 or stair plot). Uses a wider BBOX, area-based filtering,
 * and aggressive same-본번 / same-동(legal) merging.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY || "";
const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const targets = ["청계벽산", "왕십리풍림아이원"]; // names of features to refetch

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

function areaM2(coords) {
  let a = 0; const r = Math.PI / 180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const x1 = coords[i][0]*111320*Math.cos(coords[i][1]*r), y1 = coords[i][1]*110540;
    const x2 = coords[j][0]*111320*Math.cos(coords[j][1]*r), y2 = coords[j][1]*110540;
    a += x1*y2 - x2*y1;
  }
  return Math.abs(a)/2;
}
function hull(points) {
  const pts = [...points].sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  if (pts.length < 3) return null;
  if (pts.length === 3) return [...pts, pts[0]];
  const cr = (O,A,B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
  const lo = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length-2],lo[lo.length-1],p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (const p of [...pts].reverse()) { while (up.length >= 2 && cr(up[up.length-2],up[up.length-1],p) <= 0) up.pop(); up.push(p); }
  return [...lo.slice(0,-1), ...up.slice(0,-1), lo[0]];
}

async function kakaoApt(name, address) {
  // Direct keyword search first (most accurate for known apartment complexes)
  const r = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name + " 아파트")}&size=10`,
    { headers }
  );
  const data = await r.json();
  const dong = address.split(" ").pop();
  for (const d of data.documents || []) {
    if (d.address_name?.includes(dong) && d.category_name?.includes("아파트")) {
      // Prefer non-상가동 entries
      if (!d.place_name.match(/상가|관리동|주차장/)) {
        return { lat: +d.y, lng: +d.x, place: d.place_name };
      }
    }
  }
  // Fallback to any matching apartment in 동
  for (const d of data.documents || []) {
    if (d.address_name?.includes(dong)) return { lat: +d.y, lng: +d.x, place: d.place_name };
  }
  return null;
}

async function fetchWideBoundary(lat, lng, name, expectedHouseholds) {
  // Wider BBOX (~400m radius)
  const d = 0.005;
  const bbox = [lng-d, lat-d, lng+d, lat+d].join(",");
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=300&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (parcels.length === 0) return null;

  const meta = parcels.map(f => {
    const coords = f.geometry.coordinates[0][0];
    const cx = coords.reduce((s,c) => s+c[0], 0) / coords.length;
    const cy = coords.reduce((s,c) => s+c[1], 0) / coords.length;
    const dist = Math.sqrt((cx-lng)**2 + (cy-lat)**2);
    return {
      coords,
      dist,
      area: areaM2(coords),
      isRes: (f.properties.jibun||"").includes("대"),
      bonbun: f.properties.bonbun,
      bubun: f.properties.bubun,
      addr: f.properties.addr,
      jibun: f.properties.jibun,
    };
  });

  // Goal: pick the apartment complex master parcel(s) — large 대 (residential) plots
  // For 1332-household site, expect 30,000~80,000㎡ range
  // We aggressively merge any 대 parcel within 100m of click point that shares 본번 prefix

  const minClusterArea = Math.max(5000, expectedHouseholds * 25); // ~25㎡ per household minimum
  console.log(`  bbox parcels=${parcels.length}, target min area=${Math.round(minClusterArea)}㎡`);

  // Strategy A: find a large 대 parcel near the point
  const largeNearby = meta
    .filter(m => m.isRes && m.area >= minClusterArea && m.dist < 0.003)
    .sort((a,b) => b.area - a.area);

  if (largeNearby.length > 0) {
    const best = largeNearby[0];
    console.log(`  Strategy A: 단일 대형 필지 ${Math.round(best.area)}㎡ jibun=${best.jibun}`);
    return single(best);
  }

  // Strategy B: same-동(addr prefix) 대 parcels within 200m → hull
  // Find nearest residential parcel to use as reference
  const nearestRes = meta.filter(m => m.isRes).sort((a,b) => a.dist - b.dist)[0];
  if (!nearestRes) return null;

  const addrPrefix = nearestRes.addr?.split(" ").slice(0,4).join(" ");
  const cluster = meta.filter(m =>
    m.isRes &&
    m.addr?.split(" ").slice(0,4).join(" ") === addrPrefix &&
    m.dist < 0.004
  );

  if (cluster.length === 0) return single(nearestRes);

  const totalArea = cluster.reduce((s,m) => s + m.area, 0);
  console.log(`  Strategy B: ${cluster.length}개 필지 병합 (총 ${Math.round(totalArea)}㎡)`);

  const allPts = [];
  cluster.forEach(m => m.coords.forEach(c => allPts.push(c)));
  const h = hull(allPts);
  if (!h || h.length < 4) return single(nearestRes);
  return { coords: h, area: areaM2(h), count: cluster.length };
}

function single(m) {
  const coords = [...m.coords];
  if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
    coords.push(coords[0]);
  }
  return { coords, area: m.area, count: 1 };
}

let ok = 0, fail = 0;
for (const f of sites.features) {
  if (!targets.includes(f.properties.name)) continue;
  const p = f.properties;
  console.log(`\n[${p.name}] ${p.address} (${p.households}가구)`);
  try {
    const kakao = await kakaoApt(p.name, p.address);
    if (!kakao) { console.log("  카카오 검색 실패"); fail++; continue; }
    console.log(`  카카오: ${kakao.place} (${kakao.lat.toFixed(5)}, ${kakao.lng.toFixed(5)})`);
    await delay(150);

    const result = await fetchWideBoundary(kakao.lat, kakao.lng, p.name, p.households);
    if (result && result.coords.length >= 4) {
      f.geometry.coordinates = [result.coords];
      p.boundarySource = "cadastral-vworld-wide";
      console.log(`  ✓ ${result.coords.length-1}점 ${Math.round(result.area)}㎡ ${result.count}필지`);
      ok++;
    } else {
      console.log("  ✗ 적합한 필지 없음");
      fail++;
    }
    await delay(200);
  } catch (e) {
    console.log("  에러:", e.message);
    fail++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료: 성공 ${ok}, 실패 ${fail}`);
