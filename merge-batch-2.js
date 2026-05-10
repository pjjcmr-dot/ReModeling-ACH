/**
 * Append 2 new high-confidence sites from new-sites-2.json with cadastral lookup.
 * Skips low-confidence/검토단계 entries.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const candidates = JSON.parse(readFileSync(".claude/new-sites-2.json", "utf-8"));

// Filter: keep medium+ confidence, exclude likely duplicates and 검토 단계 미도달
const toAdd = candidates.filter(c => c.confidence === "medium");
console.log(`추가 후보: ${toAdd.length}건`);

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

async function lookup(name, address) {
  const dong = address.split(" ").pop();
  // Try direct keyword search
  const r = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name + " 아파트")}&size=15`,
    { headers }
  );
  const d = await r.json();
  for (const x of d.documents || []) {
    if (x.address_name?.includes(dong) && x.category_name?.includes("아파트") &&
        !x.place_name.match(/상가|관리동|주차장/)) {
      return { lat: +x.y, lng: +x.x, place: x.place_name, address: x.address_name };
    }
  }
  // Try without 아파트 suffix
  const r2 = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name)}&size=15`,
    { headers }
  );
  const d2 = await r2.json();
  for (const x of d2.documents || []) {
    if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
      return { lat: +x.y, lng: +x.x, place: x.place_name, address: x.address_name };
    }
  }
  return null;
}

async function fetchParcel(lat, lng, hh) {
  const dd = 0.003;
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=200&geomFilter=BOX(${lng-dd},${lat-dd},${lng+dd},${lat+dd})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (!parcels.length) return null;
  const meta = parcels.map(f => {
    const c = f.geometry.coordinates[0][0];
    return { coords: c, area: areaM2(c), isRes: (f.properties.jibun||'').includes('대'), contains: pip([lng, lat], c), jibun: f.properties.jibun };
  });
  const expectMin = hh ? Math.max(2000, hh * 18) : 2000;
  const expectMax = hh ? Math.max(20000, hh * 130) : 80000;
  // Best containing 대 in range
  const cand = meta.filter(m => m.contains && m.isRes && m.area >= expectMin && m.area <= expectMax)
    .sort((a,b) => b.area - a.area)[0]
    || meta.filter(m => m.isRes && m.area >= expectMin && m.area <= expectMax).sort((a,b) => b.area - a.area)[0]
    || meta.filter(m => m.isRes).sort((a,b) => b.area - a.area)[0];
  if (!cand) return null;
  const c = [...cand.coords];
  if (c[0][0] !== c[c.length-1][0] || c[0][1] !== c[c.length-1][1]) c.push(c[0]);
  return { coords: c, area: cand.area };
}

let maxNum = 0;
for (const f of sites.features) {
  const m = (f.properties.id || "").match(/^RM(\d+)$/);
  if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
}

for (const c of toAdd) {
  maxNum++;
  const id = "RM" + String(maxNum).padStart(3, "0");
  console.log(`\n[${id}] ${c.name}`);
  const center = await lookup(c.name, c.address);
  if (!center) {
    console.log("  ✗ Kakao 검색 실패 — 스킵");
    maxNum--;
    continue;
  }
  console.log(`  ${center.place} | ${center.address}`);
  await delay(150);

  const parcel = await fetchParcel(center.lat, center.lng, c.existing_households);
  await delay(180);

  let coords, source;
  if (parcel) {
    coords = parcel.coords;
    source = "cadastral-vworld-largest";
    console.log(`  ✓ ${Math.round(parcel.area)}㎡`);
  } else {
    // Estimated rectangle 50㎡/세대 fallback
    const est = (c.existing_households || 300) * 50;
    const r = Math.PI / 180;
    const mLat = 110540, mLng = 111320 * Math.cos(center.lat * r);
    const h = Math.sqrt(est / 1.3), w = h * 1.3;
    const dLat = (h/2) / mLat, dLng = (w/2) / mLng;
    coords = [
      [center.lng - dLng, center.lat - dLat],
      [center.lng + dLng, center.lat - dLat],
      [center.lng + dLng, center.lat + dLat],
      [center.lng - dLng, center.lat + dLat],
      [center.lng - dLng, center.lat - dLat],
    ];
    source = "estimated-by-households";
    console.log(`  ⚠ est ${est}㎡`);
  }

  const newFeat = {
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [coords] },
    properties: {
      id,
      name: c.name,
      subtype: c.subtype,
      address: c.address,
      stage: c.stage,
      expected_completion: "",
      households: (c.existing_households || 0) + (c.added_households || 0),
      existing_households: c.existing_households || 0,
      added_households: c.added_households || 0,
      increase_rate: 0,
      area: "",
      built_year: c.built_year || 0,
      max_floors: 0,
      developer: c.developer || "",
      constructor: c.constructor || "",
      price_per_pyeong: 0,
      price_change: 0,
      contribution: 0,
      sale_price: 0,
      sale_price_date: "-",
      premium: 0,
      legal: [
        { title: "근거법령", content: "주택법 제66조(리모델링의 허가 등)" },
        { title: "준공연도", content: (c.built_year || "미상") + "년" },
        { title: "추진단계", content: c.stage },
        { title: "2026 최신상태", content: c.status_note || "" },
      ],
      boundarySource: source,
    },
  };
  sites.features.push(newFeat);
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n총 features: ${sites.features.length}`);
