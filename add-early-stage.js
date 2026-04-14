/**
 * 초기 단계 (안전진단 이전) 리모델링 단지 추가
 * - Kakao REST API로 geocoding
 * - SHP 건물 데이터로 실측경계 추출
 * - 13자리 정밀도
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
if (!KAKAO_KEY) { console.error("KAKAO_REST_KEY 없음"); process.exit(1); }

// ── 추가할 초창기 단계 단지 리스트 ──
// 출처: 뉴스 기사, 서울시 2025 공동주택 리모델링 기본계획, 성남시 정비사업 포털
// 제외: 1기 신도시 선도지구 재건축 전환 단지, 조합설립인가 완료 단지
const NEW_SITES = [
  // ── 서울 초기 단계 (17개) ──
  { name: "도곡 극동2차", address: "서울 강남구 도곡동", keyword: "도곡 극동2차 아파트", shp_keywords: ["극동2차","극동2"], households: 243, built_year: 1996, stage: "추진위원회", subtype: "세대수증가형", developer: "도곡 극동2차 리모델링 추진위원회", constructor: "-" },
  { name: "남산타운", address: "서울 중구 신당동", keyword: "남산타운 아파트", shp_keywords: ["남산타운"], households: 5150, built_year: 1994, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "마포 태영", address: "서울 마포구 도화동", keyword: "마포 태영 아파트", shp_keywords: ["마포태영","도화 태영","태영"], households: 1992, built_year: 1999, stage: "추진위원회", subtype: "세대수증가형", developer: "마포 태영 리모델링 추진위원회", constructor: "-" },
  { name: "도원삼성래미안", address: "서울 용산구 도원동", keyword: "도원동 삼성래미안", shp_keywords: ["도원삼성","도원래미안","삼성래미안"], households: 643, built_year: 2001, stage: "추진위원회", subtype: "세대수증가형", developer: "도원삼성래미안 리모델링 추진위원회", constructor: "-" },
  { name: "리버힐삼성", address: "서울 용산구 이촌동", keyword: "이촌 리버힐삼성 아파트", shp_keywords: ["리버힐삼성","리버힐"], households: 590, built_year: 1999, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "공덕삼성래미안1차", address: "서울 마포구 공덕동", keyword: "공덕 삼성래미안1차", shp_keywords: ["공덕삼성래미안1","공덕래미안1","공덕삼성1"], households: 651, built_year: 1999, stage: "추진위원회", subtype: "세대수증가형", developer: "공덕삼성래미안1차 리모델링 추진위원회", constructor: "-" },
  { name: "문정 신동아5차", address: "서울 송파구 문정동", keyword: "문정 신동아5차 아파트", shp_keywords: ["신동아5차","신동아 5차","신동아5"], households: 326, built_year: 1994, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "행당대림", address: "서울 성동구 행당동", keyword: "행당 대림 아파트", shp_keywords: ["행당대림","행당 대림","대림"], households: 3404, built_year: 2000, stage: "추진위원회", subtype: "세대수증가형", developer: "행당대림 리모델링 추진위원회", constructor: "-" },
  { name: "행당한진타운", address: "서울 성동구 행당동", keyword: "행당 한진타운", shp_keywords: ["행당한진","한진타운","한진"], households: 2123, built_year: 1999, stage: "조합설립준비", subtype: "세대수증가형", developer: "행당한진타운 리모델링 추진위원회", constructor: "-" },
  { name: "목동한신청구", address: "서울 양천구 신정동", keyword: "목동 한신청구 아파트", shp_keywords: ["한신청구","신정 한신","목동 한신청구"], households: 1512, built_year: 1997, stage: "조합설립준비", subtype: "세대수증가형", developer: "목동한신청구 리모델링 추진위원회", constructor: "-" },
  { name: "목동우성1차", address: "서울 양천구 신정동", keyword: "목동 우성1차 아파트", shp_keywords: ["목동우성1","신정 우성1","우성1차"], households: 476, built_year: 1996, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "목동우성2차", address: "서울 양천구 신정동", keyword: "목동 우성2차 아파트", shp_keywords: ["목동우성2","신정 우성2","우성2차"], households: 1140, built_year: 1997, stage: "추진위원회", subtype: "세대수증가형", developer: "목동우성2차 리모델링 추진위원회", constructor: "-" },
  { name: "신정쌍용", address: "서울 양천구 신정동", keyword: "신정 쌍용 아파트", shp_keywords: ["신정쌍용","신정 쌍용","쌍용"], households: 1272, built_year: 1992, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "강변현대", address: "서울 광진구 광장동", keyword: "광장 강변현대 아파트", shp_keywords: ["강변현대","광장 현대"], households: 210, built_year: 1999, stage: "추진위원회", subtype: "세대수증가형", developer: "강변현대 리모델링 추진위원회", constructor: "-" },
  { name: "광장극동1차", address: "서울 광진구 광장동", keyword: "광장 극동1차 아파트", shp_keywords: ["광장극동1","광장 극동1","극동1차"], households: 448, built_year: 1985, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "이촌강촌", address: "서울 용산구 이촌동", keyword: "이촌 강촌 아파트", shp_keywords: ["이촌강촌","강촌"], households: 1001, built_year: 1998, stage: "추진위원회", subtype: "세대수증가형", developer: "이촌강촌 리모델링 추진위원회", constructor: "-" },
  { name: "응봉대림1차", address: "서울 성동구 응봉동", keyword: "응봉 대림1차 아파트", shp_keywords: ["응봉대림1","응봉 대림1","대림1"], households: 855, built_year: 1986, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },

  // ── 분당 초기 단계 (4개) ──
  { name: "분당 느티경남선경", address: "성남시 분당구 정자동", keyword: "느티마을 경남 선경 연립", shp_keywords: ["느티 경남","느티 선경","경남선경","경남 선경"], households: 1776, built_year: 1994, stage: "조합설립준비", subtype: "세대수증가형", developer: "느티마을 경남·선경 리모델링 추진위원회", constructor: "-" },
  { name: "분당 정든한진7", address: "성남시 분당구 수내동", keyword: "정든마을 한진7단지", shp_keywords: ["정든 한진7","한진7단지","한진 7"], households: 410, built_year: 1994, stage: "추진위원회", subtype: "세대수증가형", developer: "정든마을 한진7단지 리모델링 추진위원회", constructor: "-" },
  { name: "분당 이매촌청구", address: "성남시 분당구 이매동", keyword: "이매촌 청구 아파트", shp_keywords: ["이매촌 청구","이매 청구","청구"], households: 710, built_year: 1992, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
  { name: "분당 매화공무원2", address: "성남시 분당구 이매동", keyword: "매화마을 공무원2단지", shp_keywords: ["매화 공무원2","매화 2단지","매화공무원"], households: 1185, built_year: 1995, stage: "리모델링검토", subtype: "세대수증가형", developer: "-", constructor: "-" },
];

// ── 카카오 keyword 검색 ──
async function kakaoSearch(keyword, addressHint) {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}&size=10`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const data = await res.json();
    if (!data.documents || data.documents.length === 0) return null;
    // 주소힌트 매칭 (구/동 포함)
    const hintParts = addressHint.split(" ");
    const bestMatch = data.documents.find(d => {
      const addr = (d.road_address_name || d.address_name || "");
      return hintParts.every(p => addr.includes(p) || (d.place_name || "").includes(p));
    }) || data.documents[0];
    return { lat: +bestMatch.y, lng: +bestMatch.x, place_name: bestMatch.place_name, address: bestMatch.road_address_name || bestMatch.address_name };
  } catch (e) {
    console.error("Kakao search error:", e.message);
    return null;
  }
}

// ── 주소 geocoding (fallback) ──
async function kakaoGeocode(address) {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const data = await res.json();
    if (!data.documents || data.documents.length === 0) return null;
    return { lat: +data.documents[0].y, lng: +data.documents[0].x };
  } catch { return null; }
}

// ── SHP 좌표 변환 ──
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
  const h = lo.slice(0, -1).concat(up.slice(0, -1));
  h.push(h[0]);
  return h;
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

// ── SHP 파일 경로 ──
function getShpZip(address) {
  if (address.includes("서울")) {
    const parts = address.split(" ");
    const gu = parts[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
    if (existsSync("F_FAC_BUILDING_서울.zip")) return "F_FAC_BUILDING_서울.zip";
  }
  if (address.includes("성남") || address.includes("분당")) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  return null;
}

// ── 기본 원형 경계 생성 (SHP 매칭 실패시) ──
function circleBoundary(lat, lng, radiusM = 60) {
  const coords = [];
  const n = 24;
  const r = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * 2 * Math.PI;
    const dlat = (radiusM * Math.cos(ang)) / 110540;
    const dlng = (radiusM * Math.sin(ang)) / (111320 * Math.cos(lat * r));
    coords.push([
      Math.round((lng + dlng) * 1e13) / 1e13,
      Math.round((lat + dlat) * 1e13) / 1e13,
    ]);
  }
  coords.push(coords[0]);
  return coords;
}

// ── SHP에서 아파트명으로 건물 찾기 ──
async function findBuildings(shpPath, aptKeywords, centerLat, centerLng, maxDist = 0.005) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const pts = [];
  let matched = 0;

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    if (!aptKeywords.some(k => nm.includes(k))) continue;

    const wgs = value.geometry.coordinates[0].map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;

    // centroid 거리 체크
    const cx = wgs.reduce((s, c) => s + c[0], 0) / wgs.length;
    const cy = wgs.reduce((s, c) => s + c[1], 0) / wgs.length;
    const d = Math.sqrt((cx - centerLng) ** 2 + (cy - centerLat) ** 2);
    if (d > maxDist) continue;

    wgs.forEach(c => pts.push(c));
    matched++;
  }
  return { pts, matched };
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const existingNames = new Set(sites.features.map(f => f.properties.name));

console.log(`현재 ${sites.features.length}개 사이트 / 신규 후보 ${NEW_SITES.length}개\n`);

const tmpDir = "shp_temp_new";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

// SHP 파일별 그룹핑
const groups = {};
const newList = [];
for (const site of NEW_SITES) {
  if (existingNames.has(site.name)) {
    console.log(`스킵 (이미 존재): ${site.name}`);
    continue;
  }
  newList.push(site);
  const zip = getShpZip(site.address);
  if (zip) {
    if (!groups[zip]) groups[zip] = [];
    groups[zip].push(site);
  } else {
    if (!groups.__nogshp) groups.__nogshp = [];
    groups.__nogshp.push(site);
  }
}

let nextId = sites.features.length + 1;
function newId() { return `RM${String(nextId++).padStart(3, "0")}`; }

let added = 0, shpMatched = 0;

for (const [zipFile, siteList] of Object.entries(groups)) {
  if (zipFile === "__nogshp") {
    console.log(`\n── SHP 없음 (${siteList.length}개) ──`);
    for (const s of siteList) {
      const kres = await kakaoSearch(s.keyword, s.address) || await kakaoGeocode(s.address);
      if (!kres) { console.log(`  실패: ${s.name}`); continue; }
      const boundary = circleBoundary(kres.lat, kres.lng, 80);
      sites.features.push({
        type: "Feature",
        properties: {
          id: newId(), name: s.name, subtype: s.subtype, address: s.address,
          stage: s.stage, expected_completion: "",
          households: s.households, existing_households: s.households, added_households: 0, increase_rate: 0,
          area: "", built_year: s.built_year, max_floors: 0,
          developer: s.developer, constructor: s.constructor,
          price_per_pyeong: 0, price_change: 0, contribution: 0, sale_price: 0, sale_price_date: "-", premium: 0,
          legal: [
            { title: "근거법령", content: "주택법 제66조(리모델링의 허가)" },
            { title: "준공연도", content: `${s.built_year}년` },
            { title: "추진단계", content: s.stage },
          ],
        },
        geometry: { type: "Polygon", coordinates: [boundary] },
      });
      added++;
      console.log(`  + ${s.name} (${kres.lat.toFixed(6)}, ${kres.lng.toFixed(6)}) 원형경계`);
    }
    continue;
  }

  console.log(`\n── ${zipFile} (${siteList.length}개) ──`);

  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => unlinkSync(join(tmpDir, f)));
  try {
    new AdmZip(zipFile).extractAllTo(tmpDir, true);
  } catch (e) { console.log(`  압축 해제 실패: ${e.message}`); continue; }

  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));
  if (shpFiles.length === 0) continue;

  for (const s of siteList) {
    // Kakao로 좌표 확보
    const kres = await kakaoSearch(s.keyword, s.address) || await kakaoGeocode(s.address);
    if (!kres) { console.log(`  실패 (Kakao): ${s.name}`); continue; }

    // 키워드 (explicit override + 파생)
    const parts = s.name.split(" ");
    const brand = parts.slice(1).join("");
    const derived = [brand, brand.replace(/\d+.*/, ""), s.name.replace(" ", "")].filter(Boolean);
    const keywords = [...(s.shp_keywords || []), ...derived];

    let boundary = null;
    for (const shp of shpFiles) {
      const { pts, matched } = await findBuildings(`${tmpDir}/${shp}`, keywords, kres.lat, kres.lng);
      if (matched >= 2 && pts.length > 0) {
        const h = convexHull(pts);
        if (h && h.length >= 4) {
          boundary = h;
          const a = areaM2(h);
          console.log(`  + ${s.name} (${matched}동) ${h.length - 1}점 ${Math.round(a)}㎡`);
          shpMatched++;
          break;
        }
      }
    }
    if (!boundary) {
      boundary = circleBoundary(kres.lat, kres.lng, 80);
      console.log(`  + ${s.name} (SHP매칭실패, 원형경계 사용)`);
    }

    sites.features.push({
      type: "Feature",
      properties: {
        id: newId(), name: s.name, subtype: s.subtype, address: s.address,
        stage: s.stage, expected_completion: "",
        households: s.households, existing_households: s.households, added_households: 0, increase_rate: 0,
        area: "", built_year: s.built_year, max_floors: 0,
        developer: s.developer, constructor: s.constructor,
        price_per_pyeong: 0, price_change: 0, contribution: 0, sale_price: 0, sale_price_date: "-", premium: 0,
        legal: [
          { title: "근거법령", content: "주택법 제66조(리모델링의 허가)" },
          { title: "준공연도", content: `${s.built_year}년` },
          { title: "추진단계", content: s.stage },
        ],
      },
      geometry: { type: "Polygon", coordinates: [boundary] },
    });
    added++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료! 추가된 단지: ${added}개 (SHP매칭: ${shpMatched}개)`);
console.log(`전체 사이트: ${sites.features.length}개`);
