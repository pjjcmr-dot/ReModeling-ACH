/**
 * Final boundary cleanup: for sites still showing implausible area,
 * either retry with single-parcel-only strategy (no hull) or fall back
 * to a household-based estimated rectangle.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

function areaM2(coords) {
  let a = 0; const r = Math.PI/180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i+1) % coords.length;
    const x1 = coords[i][0]*111320*Math.cos(coords[i][1]*r), y1 = coords[i][1]*110540;
    const x2 = coords[j][0]*111320*Math.cos(coords[j][1]*r), y2 = coords[j][1]*110540;
    a += x1*y2 - x2*y1;
  }
  return Math.abs(a)/2;
}
function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const delay = (ms) => new Promise(r => setTimeout(r, ms));

async function getCenter(name, address) {
  const dong = address.split(" ").pop();
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleaned + " 아파트")}&size=15`,
      { headers }
    );
    const d = await r.json();
    for (const x of d.documents || []) {
      if (x.address_name?.includes(dong) && x.category_name?.includes("아파트") &&
          !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|정문|후문/)) {
        return { lat: +x.y, lng: +x.x };
      }
    }
    for (const x of d.documents || []) {
      if (x.address_name?.includes(dong)) return { lat: +x.y, lng: +x.x };
    }
  } catch {}
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers });
    const d = await r.json();
    if (d.documents?.[0]) return { lat: +d.documents[0].y, lng: +d.documents[0].x };
  } catch {}
  return null;
}

async function fetchSingleLargest(lat, lng, households) {
  const d = 0.003;
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=200&geomFilter=BOX(${lng-d},${lat-d},${lng+d},${lat+d})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (!parcels.length) return null;
  const expectMin = Math.max(2000, households * 18);
  const expectMax = Math.max(20000, households * 130);

  const meta = parcels.map(f => {
    const coords = f.geometry.coordinates[0][0];
    return {
      coords,
      area: areaM2(coords),
      isRes: (f.properties.jibun||"").includes("대"),
      jibun: f.properties.jibun,
      contains: pip([lng, lat], coords),
    };
  });

  // Strategy: largest residential parcel containing the point that fits range
  const containingRes = meta.filter(m => m.contains && m.isRes && m.area >= expectMin && m.area <= expectMax)
    .sort((a,b) => b.area - a.area);
  if (containingRes.length) return single(containingRes[0]);

  // Or any 대 in range
  const cand = meta.filter(m => m.isRes && m.area >= expectMin && m.area <= expectMax)
    .sort((a,b) => b.area - a.area);
  if (cand.length) return single(cand[0]);

  // Largest 대 even if outside range (cap at expectMax)
  const anyRes = meta.filter(m => m.isRes).sort((a,b) => b.area - a.area)[0];
  if (anyRes && anyRes.area <= expectMax * 1.5 && anyRes.area >= expectMin * 0.5) return single(anyRes);

  return null;
}

function single(m) {
  const coords = [...m.coords];
  if (coords[0][0] !== coords[coords.length-1][0] || coords[0][1] !== coords[coords.length-1][1]) {
    coords.push(coords[0]);
  }
  return { coords, area: m.area };
}

function rect(lat, lng, areaM2v, ratio = 1.3) {
  const r = Math.PI / 180;
  const mLat = 110540;
  const mLng = 111320 * Math.cos(lat * r);
  const h = Math.sqrt(areaM2v / ratio), w = h * ratio;
  const dLat = (h/2)/mLat, dLng = (w/2)/mLng;
  return [[
    [lng - dLng, lat - dLat],
    [lng + dLng, lat - dLat],
    [lng + dLng, lat + dLat],
    [lng - dLng, lat + dLat],
    [lng - dLng, lat - dLat],
  ]];
}

const stillBad = [];
for (const f of sites.features) {
  const area = areaM2(f.geometry.coordinates[0]);
  const hh = f.properties.households || 0;
  const perHH = hh > 0 ? area/hh : 0;
  if (area < 1500) stillBad.push(f);
  else if (hh >= 100 && perHH < 12) stillBad.push(f);
  else if (hh >= 100 && perHH > 200) stillBad.push(f);
}
console.log(`${stillBad.length}개 재처리\n`);

let cad = 0, est = 0;
for (let i = 0; i < stillBad.length; i++) {
  const f = stillBad[i];
  const p = f.properties;
  const oldArea = Math.round(areaM2(f.geometry.coordinates[0]));
  try {
    const center = await getCenter(p.name, p.address);
    if (!center) {
      // Estimated, place near 동 center via address only — keep existing geometry as fallback
      console.log(`[${i+1}/${stillBad.length}] ${p.name.padEnd(28)} ${oldArea}㎡ ✗ Kakao fail, retain`);
      continue;
    }
    await delay(150);
    const result = await fetchSingleLargest(center.lat, center.lng, p.households);
    await delay(180);
    if (result) {
      f.geometry.coordinates = [result.coords];
      p.boundarySource = "cadastral-vworld-largest";
      const newArea = Math.round(result.area);
      const perHH = p.households ? Math.round(newArea / p.households) : 0;
      console.log(`[${i+1}/${stillBad.length}] ${p.name.padEnd(28)} ${oldArea}㎡ → ${newArea}㎡ (${perHH}㎡/세대)`);
      cad++;
    } else {
      const estArea = (p.households || 200) * 60;
      f.geometry.coordinates = rect(center.lat, center.lng, estArea);
      p.boundarySource = "estimated-by-households";
      console.log(`[${i+1}/${stillBad.length}] ${p.name.padEnd(28)} ${oldArea}㎡ → est ${estArea}㎡`);
      est++;
    }
  } catch (e) {
    console.log(`[${i+1}/${stillBad.length}] ${p.name} ✗ ${e.message}`);
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료: cadastral ${cad}, estimated ${est}`);
