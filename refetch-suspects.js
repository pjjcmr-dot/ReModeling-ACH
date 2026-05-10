/**
 * Re-fetch boundaries for 44 suspect sites where current cadastral data is wrong.
 * Strategy:
 *   1. Kakao keyword search (apartment-specific) for accurate complex center
 *   2. VWORLD wide BBOX (0.005°) → collect all 대(주거) parcels
 *   3. Cluster same-본번 + same-동(addr prefix) → hull
 *   4. Validate area is in plausible range for household count
 *   5. If validation fails, fall back to estimated rectangle
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY || "";
const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
if (!VWORLD_KEY || !KAKAO_KEY) { console.error("API 키 미설정"); process.exit(1); }

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const suspects = JSON.parse(readFileSync(".claude/suspect-boundaries.json", "utf-8"));
const suspectIds = new Set(suspects.map(s => s.id));
console.log(`재처리 대상: ${suspectIds.size}개\n`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
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

async function kakaoFindApt(name, address) {
  const dong = address.split(" ").pop();
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  // Direct keyword search first
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleaned + " 아파트")}&size=15`,
      { headers }
    );
    const data = await r.json();
    // Prefer non-상가/관리/주차 entries in matching 동
    for (const d of data.documents || []) {
      if (d.address_name?.includes(dong) && d.category_name?.includes("아파트") &&
          !d.place_name.match(/상가|관리동|주차장|경로당|놀이터|어린이집|정문|후문|놀이터/)) {
        return { lat: +d.y, lng: +d.x, place: d.place_name };
      }
    }
    // Fallback: any apartment in 동
    for (const d of data.documents || []) {
      if (d.address_name?.includes(dong) && d.category_name?.includes("아파트")) {
        return { lat: +d.y, lng: +d.x, place: d.place_name };
      }
    }
    // Looser: 동 match without 아파트 category
    for (const d of data.documents || []) {
      if (d.address_name?.includes(dong)) return { lat: +d.y, lng: +d.x, place: d.place_name };
    }
  } catch {}

  // 주소 기반 fallback
  try {
    const ar = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers });
    const ad = await ar.json();
    if (ad.documents?.[0]) return { lat: +ad.documents[0].y, lng: +ad.documents[0].x, place: null };
  } catch {}
  return null;
}

async function fetchSmartBoundary(lat, lng, name, households) {
  // Wide BBOX (~500m radius)
  const d = 0.005;
  const bbox = [lng-d, lat-d, lng+d, lat+d].join(",");
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=500&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (parcels.length === 0) return null;

  const meta = parcels.map(f => {
    const coords = f.geometry.coordinates[0][0];
    const cx = coords.reduce((s,c) => s+c[0], 0) / coords.length;
    const cy = coords.reduce((s,c) => s+c[1], 0) / coords.length;
    return {
      coords,
      cx, cy,
      dist: Math.sqrt((cx-lng)**2 + (cy-lat)**2),
      area: areaM2(coords),
      isRes: (f.properties.jibun||"").includes("대"),
      bonbun: f.properties.bonbun,
      addr: f.properties.addr || "",
      jibun: f.properties.jibun,
    };
  });

  // Plausible total area for the complex
  const expectMin = Math.max(2000, households * 20);  // ≥20㎡/세대
  const expectMax = Math.max(20000, households * 120); // ≤120㎡/세대

  // Strategy 1: containing parcel(s)
  const containing = meta.filter(m => pip([lng, lat], m.coords));
  if (containing.length > 0) {
    const resContaining = containing.filter(m => m.isRes);
    const seedCandidates = resContaining.length > 0 ? resContaining : containing;
    for (const seed of seedCandidates.sort((a,b) => b.area - a.area)) {
      const merged = clusterAround(meta, seed);
      if (merged && merged.area >= expectMin) return { ...merged, strategy: "contain+cluster" };
    }
    // Fallback: largest containing
    const best = seedCandidates.sort((a,b) => b.area - a.area)[0];
    if (best.area >= expectMin) return { ...singleParcel(best), strategy: "contain-large" };
  }

  // Strategy 2: nearest 대 parcel that has plausible area when clustered with same 본번
  const resCandidates = meta.filter(m => m.isRes).sort((a,b) => a.dist - b.dist);
  for (const seed of resCandidates.slice(0, 30)) {
    if (seed.dist > 0.004) break;
    const merged = clusterAround(meta, seed);
    if (merged && merged.area >= expectMin && merged.area <= expectMax) {
      return { ...merged, strategy: "nearest-cluster" };
    }
  }

  // Strategy 3: build hull from all 대 parcels within 250m of click point
  const nearbyRes = meta.filter(m => m.isRes && m.dist < 0.0025);
  if (nearbyRes.length >= 2) {
    const totalArea = nearbyRes.reduce((s,m) => s + m.area, 0);
    if (totalArea >= expectMin) {
      const allPts = [];
      nearbyRes.forEach(m => m.coords.forEach(c => allPts.push(c)));
      const h = hull(allPts);
      if (h && h.length >= 4) {
        return { coords: h, area: areaM2(h), count: nearbyRes.length, strategy: "all-nearby-hull" };
      }
    }
  }

  // Strategy 4: largest 대 parcel within 400m
  const largestRes = meta.filter(m => m.isRes && m.dist < 0.004).sort((a,b) => b.area - a.area)[0];
  if (largestRes && largestRes.area >= expectMin / 3) {
    const merged = clusterAround(meta, largestRes);
    if (merged) return { ...merged, strategy: "largest-cluster" };
    return { ...singleParcel(largestRes), strategy: "largest-single" };
  }

  return null;
}

function clusterAround(meta, seed) {
  const seedAddrPrefix = seed.addr?.split(" ").slice(0,4).join(" ") || "";
  const cluster = meta.filter(m =>
    m.isRes &&
    m.bonbun === seed.bonbun &&
    m.addr?.split(" ").slice(0,4).join(" ") === seedAddrPrefix
  );
  if (cluster.length === 0) return null;
  if (cluster.length === 1) return singleParcel(cluster[0]);
  const allPts = [];
  cluster.forEach(m => m.coords.forEach(c => allPts.push(c)));
  const h = hull(allPts);
  if (!h || h.length < 4) return singleParcel(seed);
  return { coords: h, area: areaM2(h), count: cluster.length, bonbun: seed.bonbun };
}

function singleParcel(m) {
  const coords = [...m.coords];
  if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
    coords.push(coords[0]);
  }
  return { coords, area: m.area, count: 1, bonbun: m.bonbun };
}

function rectFallback(lat, lng, areaM2v, ratio = 1.3) {
  const r = Math.PI / 180;
  const mPerDegLat = 110540;
  const mPerDegLng = 111320 * Math.cos(lat * r);
  const h = Math.sqrt(areaM2v / ratio);
  const w = h * ratio;
  const dLat = (h / 2) / mPerDegLat;
  const dLng = (w / 2) / mPerDegLng;
  return [[
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ]];
}

let ok = 0, estimated = 0, fail = 0;
const log = [];
const targets = sites.features.filter(f => suspectIds.has(f.properties.id));
for (let i = 0; i < targets.length; i++) {
  const f = targets[i];
  const p = f.properties;
  const oldArea = Math.round(areaM2(f.geometry.coordinates[0]));
  try {
    const kakao = await kakaoFindApt(p.name, p.address);
    await delay(120);
    if (!kakao) {
      console.log(`[${i+1}/${targets.length}] ${p.name} ✗ 주소검색 실패`);
      log.push({ id: p.id, name: p.name, status: "kakao-fail" });
      fail++;
      continue;
    }
    const result = await fetchSmartBoundary(kakao.lat, kakao.lng, p.name, p.households);
    await delay(180);
    if (result && result.coords.length >= 4) {
      f.geometry.coordinates = [result.coords];
      p.boundarySource = "cadastral-vworld-refetch";
      const newArea = Math.round(result.area);
      const perHH = p.households ? Math.round(newArea / p.households) : 0;
      console.log(`[${i+1}/${targets.length}] ${p.name.padEnd(28)} ${oldArea}㎡ → ${newArea}㎡ (${perHH}㎡/세대) [${result.strategy}]`);
      log.push({ id: p.id, name: p.name, oldArea, newArea, perHH, strategy: result.strategy });
      ok++;
    } else {
      // Estimated rectangle fallback
      const estArea = (p.households || 200) * 60;
      f.geometry.coordinates = rectFallback(kakao.lat, kakao.lng, estArea);
      p.boundarySource = "estimated-by-households";
      console.log(`[${i+1}/${targets.length}] ${p.name.padEnd(28)} ${oldArea}㎡ → est ${estArea}㎡ (placeholder)`);
      log.push({ id: p.id, name: p.name, oldArea, newArea: estArea, strategy: "estimated" });
      estimated++;
    }
  } catch (e) {
    console.log(`[${i+1}/${targets.length}] ${p.name} ✗ ${e.message}`);
    log.push({ id: p.id, name: p.name, status: "error", error: e.message });
    fail++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
writeFileSync(".claude/refetch-log.json", JSON.stringify(log, null, 2));
console.log(`\n완료: cadastral ${ok}, estimated ${estimated}, fail ${fail}`);
