/**
 * Fetch real cadastral boundaries for placeholder sites only.
 * Reuses the same Kakao keyword search + VWORLD lookup as fetch-boundaries.js
 * but filters to features with boundarySource === 'placeholder'.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY || "";
const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
if (!VWORLD_KEY || !KAKAO_KEY) { console.error("API 키 미설정"); process.exit(1); }

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const placeholders = sites.features.filter(f => f.properties.boundarySource === "placeholder");
console.log(`placeholder 단지 ${placeholders.length}개 실측경계 조회\n`);

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
  let cx = 0, cy = 0;
  try {
    const ar = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers });
    const ad = await ar.json();
    if (ad.documents?.[0]) { cx = ad.documents[0].x; cy = ad.documents[0].y; }
  } catch {}
  if (!cx) return null;

  // Strip parenthetical brand suffix like "(넥스트리모델링)" for cleaner search
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const parts = cleaned.split(" ");
  const area = parts[0];
  const brand = parts.length > 1 ? parts.slice(1).join("") : parts[0];
  const brandC = /\d$/.test(brand) ? brand + "차" : brand;
  const dong = address.split(" ").pop();

  const queries = [
    `${area}${brand}아파트`,
    `${area}${brandC}아파트`,
    `${brand}아파트`,
    `${brandC}아파트`,
    `${cleaned.replace(/ /g,"")}아파트`,
    `${dong} ${brand}아파트`,
    `${brand}`,
    `${brand}단지`,
    `${brand}마을`,
    `${area}${brand}`,
  ];

  for (const q of queries) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&x=${cx}&y=${cy}&radius=3000&size=5&sort=distance`,
        { headers }
      );
      const data = await r.json();
      for (const d of data.documents || []) {
        if ((d.category_name?.includes("아파트") || d.category_name?.includes("주거")) &&
            d.address_name?.includes(dong)) {
          return { lat: +d.y, lng: +d.x, place: d.place_name };
        }
      }
    } catch {}
  }
  return { lat: +cy, lng: +cx, place: null };
}

async function fetchBoundary(lat, lng, households) {
  const d = 0.002;
  const bbox = [lng-d, lat-d, lng+d, lat+d].join(",");
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=100&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features;
  if (!parcels || parcels.length === 0) return null;

  const meta = parcels.map(f => {
    const coords = f.geometry.coordinates[0][0];
    const cx = coords.reduce((s,c) => s+c[0], 0) / coords.length;
    const cy = coords.reduce((s,c) => s+c[1], 0) / coords.length;
    const dist = Math.sqrt((cx-lng)**2 + (cy-lat)**2);
    const area = areaM2(coords);
    const isRes = (f.properties.jibun||"").includes("대");
    return { f, coords, dist, area, isRes, bonbun: f.properties.bonbun, addr: f.properties.addr };
  });

  const containing = meta.filter(m => pip([lng, lat], m.coords));
  if (containing.length > 0) {
    const resContaining = containing.filter(m => m.isRes);
    const best = (resContaining.length > 0 ? resContaining : containing)
      .sort((a,b) => b.area - a.area)[0];
    const merged = mergeSameBonbun(meta, best);
    if (merged) return merged;
    return singleParcel(best);
  }

  const h = households || 300;
  const minArea = Math.max(500, h * 5);
  const maxArea = Math.min(300000, h * 200);
  const candidates = meta
    .filter(m => m.isRes && m.area >= minArea && m.area <= maxArea)
    .sort((a,b) => a.dist - b.dist);
  if (candidates.length > 0) {
    const best = candidates[0];
    const merged = mergeSameBonbun(meta, best);
    if (merged) return merged;
    return singleParcel(best);
  }

  const anyRes = meta.filter(m => m.isRes).sort((a,b) => a.dist - b.dist);
  if (anyRes.length > 0) {
    const best = anyRes[0];
    const merged = mergeSameBonbun(meta, best);
    if (merged) return merged;
    return singleParcel(best);
  }

  meta.sort((a,b) => a.dist - b.dist);
  return singleParcel(meta[0]);
}

function mergeSameBonbun(meta, best) {
  const same = meta.filter(m =>
    m.bonbun === best.bonbun && m.isRes &&
    m.addr?.split(" ").slice(0,4).join(" ") === best.addr?.split(" ").slice(0,4).join(" ")
  );
  if (same.length <= 1) return null;
  const allPts = [];
  same.forEach(m => m.coords.forEach(c => allPts.push(c)));
  const h = hull(allPts);
  if (!h || h.length < 4) return null;
  return { coords: h, count: same.length, area: areaM2(h), bonbun: best.bonbun };
}

function singleParcel(m) {
  const coords = [...m.coords];
  if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
    coords.push(coords[0]);
  }
  return { coords, count: 1, area: m.area, bonbun: m.bonbun };
}

let ok = 0, fail = 0;
for (let i = 0; i < placeholders.length; i++) {
  const f = placeholders[i];
  const p = f.properties;
  try {
    const kakao = await kakaoFindApt(p.name, p.address);
    await delay(120);
    if (!kakao) {
      fail++;
      console.log(`[${i+1}/${placeholders.length}] ${p.name} ... 주소검색 실패`);
      continue;
    }
    const src = kakao.place ? `카카오:${kakao.place}` : "주소중심";
    const result = await fetchBoundary(kakao.lat, kakao.lng, p.households);
    await delay(150);
    if (result && result.coords.length >= 4) {
      f.geometry.coordinates = [result.coords];
      p.boundarySource = "cadastral-vworld";
      ok++;
      console.log(
        `[${i+1}/${placeholders.length}] ${p.name} ... ${result.coords.length-1}점 ${Math.round(result.area)}㎡ ${result.count}필지 [${src}]`
      );
    } else {
      fail++;
      console.log(`[${i+1}/${placeholders.length}] ${p.name} ... 유지 [${src}]`);
    }
  } catch (e) {
    fail++;
    console.log(`[${i+1}/${placeholders.length}] ${p.name} ... 에러: ${e.message}`);
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료: 성공 ${ok}개, 실패 ${fail}개`);
