/**
 * Fix all sites with off ≥ 250m using multi-strategy Kakao lookup + VWORLD parcel pick.
 * - way-off (>600m): definitely wrong, must fix
 * - far (250-600m): probably wrong, attempt fix
 * - kakao-fail: try address-based search with name variations
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const audit = JSON.parse(readFileSync(".claude/boundary-audit.json", "utf-8"));

const targetIds = new Set(
  audit.filter(r => ["way-off", "far", "kakao-fail"].includes(r.status)).map(r => r.id)
);
console.log(`재처리 대상: ${targetIds.size}개`);

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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
function dist_m(p1, p2) {
  const r = Math.PI / 180;
  const dlat = (p2[1] - p1[1]) * 110540;
  const dlng = (p2[0] - p1[0]) * 111320 * Math.cos(((p1[1] + p2[1]) / 2) * r);
  return Math.sqrt(dlat*dlat + dlng*dlng);
}

// Generate search query variations from name + address
function queryVariations(name, address) {
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = cleaned.split(" ");
  const dong = address.split(" ").pop();
  const gu = address.match(/[가-힣]+(?:구|시|군)/g)?.[0] || "";
  const queries = new Set();

  queries.add(`${cleaned} 아파트`);
  queries.add(`${cleaned}아파트`);
  queries.add(cleaned);
  queries.add(cleaned.replace(/ /g, ""));

  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const rest = parts.slice(0, -1).join("");
    // "이촌 현대" → "이촌현대", "현대 이촌"
    queries.add(`${rest}${last}`);
    queries.add(`${last}${rest}`);
    queries.add(`${dong}${last}`);
    queries.add(`${dong} ${last}`);
    queries.add(`${last} 아파트`);
    queries.add(`${last}아파트`);

    // numbers: "이촌 현대1" → "이촌 현대 1차"
    const m = cleaned.match(/^(.+?)(\d+)$/);
    if (m) {
      queries.add(`${m[1]}${m[2]}차`);
      queries.add(`${m[1]} ${m[2]}차`);
      queries.add(`${m[1]}${m[2]}차아파트`);
    }
  }
  // 동 + 이름
  queries.add(`${dong} ${cleaned}`);
  queries.add(`${gu} ${cleaned}`);
  return [...queries];
}

async function findApartmentCenter(name, address) {
  const dong = address.split(" ").pop();
  const queries = queryVariations(name, address);
  const candidates = [];

  for (const q of queries) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=10`,
        { headers }
      );
      const d = await r.json();
      for (const x of d.documents || []) {
        if (!x.address_name?.includes(dong)) continue;
        if (!x.category_name?.includes("아파트")) continue;
        if (x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)) continue;
        candidates.push({ lat: +x.y, lng: +x.x, place: x.place_name, query: q });
      }
      await delay(80);
      if (candidates.length >= 3) break;
    } catch {}
  }
  if (candidates.length === 0) {
    // Loose: any 아파트 in 동
    for (const q of queries.slice(0, 4)) {
      try {
        const r = await fetch(
          `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=15`,
          { headers }
        );
        const d = await r.json();
        for (const x of d.documents || []) {
          if (x.address_name?.includes(dong)) {
            candidates.push({ lat: +x.y, lng: +x.x, place: x.place_name, query: q });
          }
        }
        if (candidates.length) break;
        await delay(80);
      } catch {}
    }
  }
  if (candidates.length === 0) return null;

  // Prefer the one whose place_name is closest to 'name'
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").replace(/ /g, "").trim();
  candidates.sort((a, b) => {
    const sa = a.place.replace(/ /g, "").includes(cleaned) ? 0 : 1;
    const sb = b.place.replace(/ /g, "").includes(cleaned) ? 0 : 1;
    return sa - sb;
  });
  return candidates[0];
}

async function fetchBestParcel(lat, lng, households) {
  const dd = 0.003;
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=300&geomFilter=BOX(${lng-dd},${lat-dd},${lng+dd},${lat+dd})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (!parcels.length) return null;

  const meta = parcels.map(f => {
    const c = f.geometry.coordinates[0][0];
    const cx = c.reduce((s,p) => s + p[0], 0) / c.length;
    const cy = c.reduce((s,p) => s + p[1], 0) / c.length;
    return {
      coords: c,
      cx, cy,
      area: areaM2(c),
      isRes: (f.properties.jibun||"").includes("대"),
      contains: pip([lng, lat], c),
      jibun: f.properties.jibun,
      bonbun: f.properties.bonbun,
      addr: f.properties.addr,
    };
  });

  const expectMin = households ? Math.max(2000, households * 18) : 2000;
  const expectMax = households ? Math.max(20000, households * 130) : 100000;

  // 1. Largest 대 containing point in range
  const c1 = meta.filter(m => m.contains && m.isRes && m.area >= expectMin && m.area <= expectMax)
    .sort((a,b) => b.area - a.area)[0];
  if (c1) return single(c1, "contain-range");

  // 2. Largest 대 containing point (any size)
  const c2 = meta.filter(m => m.contains && m.isRes).sort((a,b) => b.area - a.area)[0];
  if (c2 && c2.area >= expectMin / 2 && c2.area <= expectMax * 1.5) return single(c2, "contain");

  // 3. Closest 대 in range
  const c3 = meta
    .filter(m => m.isRes && m.area >= expectMin && m.area <= expectMax)
    .map(m => ({ ...m, dist: Math.sqrt((m.cx-lng)**2 + (m.cy-lat)**2) }))
    .sort((a,b) => a.dist - b.dist)[0];
  if (c3) return single(c3, "nearest-range");

  // 4. Largest 대 within 200m
  const c4 = meta
    .filter(m => m.isRes && Math.sqrt((m.cx-lng)**2 + (m.cy-lat)**2) < 0.002)
    .sort((a,b) => b.area - a.area)[0];
  if (c4 && c4.area >= 1500) return single(c4, "nearby-largest");

  return null;
}

function single(m, strategy) {
  const c = [...m.coords];
  if (c[0][0] !== c[c.length-1][0] || c[0][1] !== c[c.length-1][1]) c.push(c[0]);
  return { coords: c, area: m.area, strategy };
}

const targets = sites.features.filter(f => targetIds.has(f.properties.id));
let fixed = 0, partial = 0, fail = 0;
const log = [];

for (let i = 0; i < targets.length; i++) {
  const f = targets[i];
  const p = f.properties;
  const oldCentroid = (() => {
    const c = f.geometry.coordinates[0];
    let cx = 0, cy = 0, n = c.length - 1;
    for (let k = 0; k < n; k++) { cx += c[k][0]; cy += c[k][1]; }
    return [cx/n, cy/n];
  })();

  try {
    const center = await findApartmentCenter(p.name, p.address);
    if (!center) {
      console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(30)} ✗ kakao 모든 검색 실패`);
      log.push({ id: p.id, status: "kakao-fail" });
      fail++;
      continue;
    }
    const oldOff = Math.round(dist_m(oldCentroid, [center.lng, center.lat]));
    const parcel = await fetchBestParcel(center.lat, center.lng, p.households);
    await delay(150);

    if (parcel) {
      f.geometry.coordinates = [parcel.coords];
      p.boundarySource = "cadastral-fullaudit";
      const newArea = Math.round(parcel.area);
      const perHH = p.households ? Math.round(newArea / p.households) : 0;
      console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(30)} oldOff=${oldOff}m → ${newArea}㎡ (${perHH}㎡/세대) [${parcel.strategy}] kakao="${center.place}"`);
      log.push({ id: p.id, oldOff, newArea, strategy: parcel.strategy, kakao: center.place });
      fixed++;
    } else {
      // Fallback: estimate rectangle around Kakao center
      const est = (p.households || 200) * 50;
      const r = Math.PI / 180;
      const mLat = 110540, mLng = 111320 * Math.cos(center.lat * r);
      const h = Math.sqrt(est / 1.3), w = h * 1.3;
      const dLat = (h/2)/mLat, dLng = (w/2)/mLng;
      f.geometry.coordinates = [[
        [center.lng - dLng, center.lat - dLat],
        [center.lng + dLng, center.lat - dLat],
        [center.lng + dLng, center.lat + dLat],
        [center.lng - dLng, center.lat + dLat],
        [center.lng - dLng, center.lat - dLat],
      ]];
      p.boundarySource = "estimated-by-households";
      console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(30)} oldOff=${oldOff}m → est ${est}㎡ kakao="${center.place}"`);
      log.push({ id: p.id, oldOff, newArea: est, strategy: "estimated", kakao: center.place });
      partial++;
    }
  } catch (e) {
    console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name} ✗ ${e.message}`);
    log.push({ id: p.id, status: "error", error: e.message });
    fail++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
writeFileSync(".claude/full-audit-log.json", JSON.stringify(log, null, 2));
console.log(`\n완료: cadastral ${fixed}, estimated ${partial}, fail ${fail}`);
