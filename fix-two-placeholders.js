/**
 * 청계벽산 (1332가구), 왕십리풍림아이원 (758가구):
 * VWORLD 연속지적도에 단지 본필지 누락. Kakao 건물 검색으로 정확한 위치만 잡고,
 * 가구수에 비례한 합리적 크기의 사각 폴리곤을 생성한다.
 * boundarySource는 "estimated"로 표기 (cadastral 아닌 추정).
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

const targets = [
  { name: "청계벽산", houseHoldsM2PerHH: 85, ratio: 1.4 },         // ~113,000㎡
  { name: "왕십리풍림아이원", houseHoldsM2PerHH: 85, ratio: 1.2 }, // ~64,000㎡
];

async function getCenter(name, address) {
  const dong = address.split(" ").pop();
  const r = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(name + " 아파트")}&size=10`,
    { headers }
  );
  const d = await r.json();
  for (const x of d.documents || []) {
    if (x.address_name?.includes(dong) && x.place_name === `${name}아파트`) {
      return { lat: +x.y, lng: +x.x };
    }
  }
  // fallback first match in 동
  for (const x of d.documents || []) {
    if (x.address_name?.includes(dong)) return { lat: +x.y, lng: +x.x };
  }
  return null;
}

function rectPolygon(lat, lng, areaM2, ratio) {
  // ratio = width / height in lon/lat sense (longer east-west)
  const r = Math.PI / 180;
  const mPerDegLat = 110540;
  const mPerDegLng = 111320 * Math.cos(lat * r);
  // area = w * h, w = h * ratio  => h = sqrt(area / ratio)
  const h = Math.sqrt(areaM2 / ratio);
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

for (const t of targets) {
  const f = sites.features.find(x => x.properties.name === t.name);
  if (!f) { console.log("NOT FOUND:", t.name); continue; }
  const center = await getCenter(t.name, f.properties.address);
  if (!center) { console.log("center fail:", t.name); continue; }
  const area = f.properties.households * t.houseHoldsM2PerHH;
  f.geometry.coordinates = rectPolygon(center.lat, center.lng, area, t.ratio);
  f.properties.boundarySource = "estimated-by-households";
  console.log(`${t.name}: ${f.properties.households}가구 × ${t.houseHoldsM2PerHH}㎡ = ${area}㎡, center=(${center.lat.toFixed(5)}, ${center.lng.toFixed(5)})`);
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log("done");
