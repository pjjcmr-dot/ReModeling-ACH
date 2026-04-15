/**
 * 리서치 에이전트가 확인한 정확한 좌표/주소 데이터를 적용
 * 1) 검증된 좌표를 기준으로 카카오 지번주소 재검색 (더 정확한 실제 건물 좌표 확보)
 * 2) SHP 건물 데이터와 매칭하여 실측 경계 확보
 * 3) 매칭 실패 시 확정 좌표 기반 50m 원형 경계
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 리서치 에이전트가 확인한 21개 단지 정확 좌표 ──
const VERIFIED = [
  { name: "도곡 극동2차",        address: "서울 강남구 도곡동",  jibun: "서울 강남구 도곡동 541",   lat: 37.4845,   lng: 127.0485,   keywords: ["극동2차","극동아파트","도곡극동"] },
  { name: "남산타운",            address: "서울 중구 신당동",    jibun: "서울 중구 다산로 32",     lat: 37.5527,   lng: 127.0108,   keywords: ["남산타운"] },
  { name: "마포 태영",           address: "서울 마포구 대흥동",  jibun: "서울 마포구 독막로 266",  lat: 37.5455,   lng: 126.9459,   keywords: ["마포태영","태영","대흥태영"] },
  { name: "도원삼성래미안",      address: "서울 용산구 도원동",  jibun: "서울 용산구 새창로 70",   lat: 37.5402,   lng: 126.9587,   keywords: ["도원삼성래미안","도원래미안","삼성래미안"] },
  { name: "리버힐삼성",          address: "서울 용산구 산천동",  jibun: "서울 용산구 청파로47길", lat: 37.5364,   lng: 126.9571,   keywords: ["리버힐삼성","리버힐","산천 삼성"] },
  { name: "공덕삼성래미안1차",   address: "서울 마포구 신공덕동",jibun: "서울 마포구 백범로37길 12",lat: 37.5443, lng: 126.9537,   keywords: ["신공덕삼성래미안1","신공덕1차","신공덕삼성"] },
  { name: "문정 신동아5차",      address: "서울 송파구 문정동",  jibun: "서울 송파구 문정동",      lat: 37.4849,   lng: 127.1235,   keywords: ["신동아5","문정 신동아","신동아"] },
  { name: "행당대림",            address: "서울 성동구 행당동",  jibun: "서울 성동구 행당로 79",   lat: 37.5582,   lng: 127.0339,   keywords: ["행당대림","대림"] },
  { name: "행당한진타운",        address: "서울 성동구 행당동",  jibun: "서울 성동구 행당로 82",   lat: 37.5588,   lng: 127.0327,   keywords: ["행당한진","한진타운"] },
  { name: "목동한신청구",        address: "서울 양천구 신정동",  jibun: "서울 양천구 목동서로2길 22",lat: 37.5247, lng: 126.8605,   keywords: ["한신청구","목동 한신","목동한신청구"] },
  { name: "목동우성1차",         address: "서울 양천구 신정동",  jibun: "서울 양천구 목동남로",    lat: 37.5208,   lng: 126.8636,   keywords: ["목동 우성1","목동우성1","목동1차우성","우성1"] },
  { name: "목동우성2차",         address: "서울 양천구 신정동",  jibun: "서울 양천구 목동남로4길 6", lat: 37.5197, lng: 126.8642,   keywords: ["목동우성2","목동 우성2","목동2차우성","우성2"] },
  { name: "신정쌍용",            address: "서울 양천구 신정동",  jibun: "서울 양천구 신정동",      lat: 37.5210,   lng: 126.8580,   keywords: ["신정쌍용","신정 쌍용","쌍용"] },
  { name: "강변현대",            address: "서울 광진구 광장동",  jibun: "서울 광진구 광장동",      lat: 37.5460,   lng: 127.1020,   keywords: ["강변현대","광장현대","광장 현대"] },
  { name: "광장극동1차",         address: "서울 광진구 광장동",  jibun: "서울 광진구 광장동 218-1", lat: 37.5477,  lng: 127.0987,   keywords: ["광장극동1","광장 극동1","극동1"] },
  { name: "이촌강촌",            address: "서울 용산구 이촌동",  jibun: "서울 용산구 이촌로87길 13",lat: 37.5183,  lng: 126.9670,   keywords: ["이촌강촌","이촌 강촌","강촌"] },
  { name: "응봉대림1차",         address: "서울 성동구 응봉동",  jibun: "서울 성동구 독서당로62길 43",lat:37.5488, lng: 127.0291,   keywords: ["응봉대림1","응봉 대림1","대림1"] },
  { name: "분당 느티경남선경",   address: "성남시 분당구 정자동", jibun: "경기 성남시 분당구 정자동 88", lat:37.3664, lng: 127.1053,  keywords: ["느티 경남","느티 선경","경남","선경","느티3","느티4"] },
  { name: "분당 정든한진7",      address: "성남시 분당구 정자동", jibun: "경기 성남시 분당구 내정로 10", lat:37.3677, lng: 127.1075,  keywords: ["정든 한진7","한진7","정든한진"] },
  { name: "분당 이매촌청구",     address: "성남시 분당구 이매동", jibun: "경기 성남시 분당구 양현로94번길 29",lat:37.3949,lng:127.1291,keywords:["이매 청구","이매촌 청구","이매촌6","청구"] },
  { name: "분당 매화공무원2",    address: "성남시 분당구 야탑동", jibun: "경기 성남시 분당구 장미로 139", lat:37.4146, lng: 127.1358,  keywords: ["매화 공무원2","매화공무원2","매화 2단지","매화2단지"] },
];

// ── Kakao 지번/도로명 주소 재검색 (더 정확한 좌표 확보) ──
async function kakaoRefine(item) {
  // 1) jibun 주소로 검색
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(item.jibun)}`, { headers });
    const d = await r.json();
    if (d.documents?.[0]) {
      const doc = d.documents[0];
      return { lat: +doc.y, lng: +doc.x, addr: doc.address_name || doc.road_address?.address_name, source: "jibun" };
    }
  } catch {}
  await delay(80);

  // 2) 키워드 검색 (주소 힌트로 지역 확인)
  const addrParts = item.address.split(" ");
  for (const kw of item.keywords) {
    try {
      const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(kw)}&x=${item.lng}&y=${item.lat}&radius=1500&size=10&sort=distance`, { headers });
      const d = await r.json();
      for (const doc of d.documents || []) {
        const addr = (doc.road_address_name || doc.address_name || "");
        const hasRegion = addrParts.slice(0, 2).every(p => addr.includes(p));
        if (hasRegion && (doc.category_name || "").match(/아파트|주거/)) {
          return { lat: +doc.y, lng: +doc.x, addr, source: `kw:${kw}`, place: doc.place_name };
        }
      }
    } catch {}
    await delay(80);
  }

  // 3) 초기 추정 좌표 사용
  return { lat: item.lat, lng: item.lng, addr: item.jibun, source: "agent_estimate" };
}

// ── SHP 처리 유틸 ──
function toWGS84(x, y) {
  if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return null;
  try {
    const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]);
    return [Math.round(lng * 1e13) / 1e13, Math.round(lat * 1e13) / 1e13];
  } catch { return null; }
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cr = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  const lo = [];
  for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = [];
  for (const p of [...pts].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1)); h.push(h[0]); return h;
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

function circleBoundary(lat, lng, radiusM = 50) {
  const coords = []; const n = 24; const r = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * 2 * Math.PI;
    const dlat = (radiusM * Math.cos(ang)) / 110540;
    const dlng = (radiusM * Math.sin(ang)) / (111320 * Math.cos(lat * r));
    coords.push([Math.round((lng + dlng) * 1e13) / 1e13, Math.round((lat + dlat) * 1e13) / 1e13]);
  }
  coords.push(coords[0]);
  return coords;
}

// SHP 파일 선택
function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(" ")[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
  }
  if (address.includes("성남") || address.includes("분당")) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  return null;
}

// SHP에서 건물 찾기
async function findBuildings(shpPath, keywords, centerLat, centerLng) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const matched = [];
  const nearby = [];

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;

    const cx = wgs.reduce((s, c) => s + c[0], 0) / wgs.length;
    const cy = wgs.reduce((s, c) => s + c[1], 0) / wgs.length;
    const d = Math.sqrt((cx - centerLng) ** 2 + (cy - centerLat) ** 2);

    // 키워드 매칭 (200m 이내)
    if (keywords.some(k => nm.includes(k)) && d < 0.002) {
      matched.push({ pts: wgs, name: nm, dist: d });
    }
    // 주변 대형 건물 (120m 이내, 300㎡ 이상)
    else if (d < 0.0012) {
      const a = areaM2(wgs);
      if (a > 300 && wgs.length >= 6) {
        nearby.push({ pts: wgs, name: nm, dist: d, area: a });
      }
    }
  }
  return { matched, nearby };
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const nameMap = new Map();
sites.features.forEach(f => nameMap.set(f.properties.name, f));

const tmpDir = "shp_verified";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

// SHP zip별 그룹핑
const groups = {};
for (const v of VERIFIED) {
  if (!nameMap.has(v.name)) { console.log(`${v.name}: 사이트 없음`); continue; }
  const zip = getShpZip(v.address);
  const key = zip || "__nogshp";
  if (!groups[key]) groups[key] = [];
  groups[key].push(v);
}

let improved = 0, shpMatch = 0, circleFallback = 0;

for (const [zip, list] of Object.entries(groups)) {
  console.log(`\n── ${zip} (${list.length}개) ──`);

  let shpFiles = [];
  if (zip !== "__nogshp") {
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => {
      try { unlinkSync(join(tmpDir, f)); } catch {}
    });
    try {
      new AdmZip(zip).extractAllTo(tmpDir, true);
      shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));
    } catch (e) { console.log(`압축해제 실패: ${e.message}`); }
  }

  for (const v of list) {
    const site = nameMap.get(v.name);
    const refined = await kakaoRefine(v);
    await delay(100);

    let boundary = null;
    let info = "";

    for (const shp of shpFiles) {
      const { matched, nearby } = await findBuildings(`${tmpDir}/${shp}`, v.keywords, refined.lat, refined.lng);
      if (matched.length >= 2) {
        // 모든 매칭 건물의 좌표로 hull
        const allPts = []; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        const h = convexHull(allPts);
        if (h) { boundary = h; info = `SHP키워드 ${matched.length}동`; shpMatch++; break; }
      } else if (matched.length === 1 && nearby.length >= 2) {
        // 단일 키워드 + 주변 대형 건물 병합
        const allPts = []; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        nearby.slice(0, 4).forEach(n => n.pts.forEach(p => allPts.push(p)));
        const h = convexHull(allPts);
        if (h) { boundary = h; info = `SHP키워드1+주변${Math.min(nearby.length,4)}동`; shpMatch++; break; }
      }
    }

    if (!boundary) {
      boundary = circleBoundary(refined.lat, refined.lng, 55);
      info = `원형경계 55m (${refined.source})`;
      circleFallback++;
    }

    const a = areaM2(boundary);
    console.log(`  ${v.name}: ${info} (${Math.round(a)}㎡) @ ${refined.lat.toFixed(5)},${refined.lng.toFixed(5)} [${refined.source}]`);

    site.geometry.coordinates = [boundary];
    // 주소 업데이트
    site.properties.address = v.address;
    improved++;
  }
  // 각 SHP 파일 처리 후 저장 (timeout 방지)
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  → 저장 완료 (${zip})`);
}

console.log(`\n── 전체 완료 ── 업데이트: ${improved}개 (SHP: ${shpMatch}개 / 원형: ${circleFallback}개)`);

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
