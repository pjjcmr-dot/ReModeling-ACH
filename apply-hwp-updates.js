/**
 * HWP 사업추진현황(34개) → sites.json 업데이트/추가
 * - 매칭: 4개 필드 업데이트 (households, built_year, constructor, stage)
 * - 신규: Kakao geocoding + SHP 경계 (fallback: 원형경계 80m)
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

const SITES_PATH = "public/sites.json";
const HWP_ROWS = JSON.parse(readFileSync(".claude/worktrees/sweet-hopper-df14bb/hwp_rows.json", "utf-8"));

// HWP 이름 → sites.json 내 기존 이름 매핑 (수동 확정)
const MATCH = {
  "이촌동 현대": "이촌 현대",
  "[수지]개포 대치 2단지": "개포 성원대치2",
  "[수직]송파 성지": "송파 성지",
  "평촌 목련3차": "평촌 목련3",
  "신정 쌍용": "신정 쌍용",
  "[수직]개포 대청": "개포 대청",
  "[수직]대치 현대1차": "대치 현대1",
  "분당 한솔마을5단지": "분당 한솔5",
  "분당매화마을 1단지": "분당 매화1",
  "분당 느티마을 4단지": "분당 느티4",
  "[수직]잠원 한신로열": "잠원 한신로얄",
  "분당 무지개 4단지": "분당 무지개4",
  "분당 느티마을 3단지": "분당 느티3",
  "[수직]옥수 극동": "옥수 극동",
  "청담 건영": "청담 건영",
  "신답 극동": "신답 극동",
  "[수직]잠원 롯데캐슬갤럭시1차": "잠원 롯데갤럭시1",
  "수지 초입마을(삼익,풍림,동아)": "수지 초입마을",
  "문정 시영": "문정 시영",
  "수지 신정마을 9단지 주공": "수지 신정9",
  "광교상현마을 현대": "광교상현마을 현대",
  "[수직]길동 우성2차": "길동 우성2차",
  "둔촌 현대3차": "둔촌 현대3",
  "철산한신아파트": "광명 철산한신",
  "안양 평촌 향촌현대4차": "평촌 향촌현대",
  "용인 수지 보원": "수지 보원",
  "이촌 강촌": "이촌 강촌",
};

// 신규 단지 주소/시공사 힌트
const NEW_ADDR = {
  "평촌 목련2차":        { name: "평촌 목련2",        address: "경기 안양시 동안구 평촌동", keyword: "평촌 목련2단지 아파트",        shp_keywords: ["목련2","목련 2"] },
  "의왕 목련풍림":       { name: "의왕 목련풍림",     address: "경기 의왕시 내손동",       keyword: "의왕 목련풍림 아파트",          shp_keywords: ["목련풍림","목련 풍림"] },
  "수원 매탄 엄광":      { name: "매탄 엄광",         address: "경기 수원시 영통구 매탄동", keyword: "매탄 엄광 아파트",              shp_keywords: ["엄광"] },
  "김포 북변산호":       { name: "김포 북변산호",     address: "경기 김포시 북변동",       keyword: "김포 북변 산호 아파트",         shp_keywords: ["산호","북변 산호"] },
  "등촌 부영":           { name: "등촌 부영",         address: "서울 강서구 등촌동",       keyword: "등촌 부영 아파트",              shp_keywords: ["등촌 부영","등촌부영","부영"] },
  "[수직]송파 삼천현대": { name: "송파 삼천현대",     address: "서울 송파구 삼전동",       keyword: "삼전 현대 아파트",              shp_keywords: ["삼전현대","삼전 현대","삼천현대"] },
  "잠원 훼미리":         { name: "잠원 훼미리",       address: "서울 서초구 잠원동",       keyword: "잠원 훼미리 아파트",            shp_keywords: ["훼미리","패밀리"] },
};

async function kakaoSearch(keyword, addressHint) {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(keyword)}&size=10`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const data = await res.json();
    if (!data.documents || data.documents.length === 0) return null;
    const hintParts = addressHint.split(" ");
    const best = data.documents.find(d => {
      const addr = (d.road_address_name || d.address_name || "");
      return hintParts.every(p => addr.includes(p) || (d.place_name || "").includes(p));
    }) || data.documents[0];
    return {
      lat: +best.y, lng: +best.x,
      place_name: best.place_name,
      address: best.road_address_name || best.address_name,
    };
  } catch (e) { console.error("Kakao search err:", e.message); return null; }
}
async function kakaoGeocode(address) {
  try {
    const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } });
    const data = await res.json();
    if (!data.documents || data.documents.length === 0) return null;
    return { lat: +data.documents[0].y, lng: +data.documents[0].x };
  } catch { return null; }
}

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
function circleBoundary(lat, lng, radiusM = 80) {
  const coords = [];
  const n = 24; const r = Math.PI / 180;
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
function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(" ")[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
    if (existsSync("F_FAC_BUILDING_서울.zip")) return "F_FAC_BUILDING_서울.zip";
  }
  if (/경기|성남|분당|수원|의왕|안양|용인|김포|광명|군포|부천|고양/.test(address)) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  return null;
}
async function findBuildings(shpPath, aptKeywords, centerLat, centerLng, maxDist = 0.005) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const pts = []; let matched = 0;
  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    if (!aptKeywords.some(k => nm.includes(k))) continue;
    const wgs = value.geometry.coordinates[0].map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;
    const cx = wgs.reduce((s, c) => s + c[0], 0) / wgs.length;
    const cy = wgs.reduce((s, c) => s + c[1], 0) / wgs.length;
    const d = Math.sqrt((cx - centerLng) ** 2 + (cy - centerLat) ** 2);
    if (d > maxDist) continue;
    wgs.forEach(c => pts.push(c));
    matched++;
  }
  return { pts, matched };
}

// ── MAIN ──
const sites = JSON.parse(readFileSync(SITES_PATH, "utf-8"));
const byName = new Map(sites.features.map(f => [f.properties.name, f]));

// 1) 기존 사이트 업데이트 (4개 필드)
let updated = 0;
const updateLog = [];
for (const row of HWP_ROWS) {
  const target = MATCH[row.name];
  if (!target) continue;
  const feat = byName.get(target);
  if (!feat) { console.log(`  매칭된 이름 없음: ${target}`); continue; }
  const p = feat.properties;
  const before = { households: p.households, built_year: p.built_year, constructor: p.constructor, stage: p.stage };
  if (row.households) p.households = row.households;
  if (row.built_year) p.built_year = row.built_year;
  if (row.constructor) p.constructor = row.constructor;
  if (row.stage) p.stage = row.stage;
  // legal 배열의 '준공연도' / '추진단계' 엔트리도 동기화
  if (Array.isArray(p.legal)) {
    const lyr = p.legal.find(l => l.title === "준공연도");
    if (lyr && row.built_year) lyr.content = `${row.built_year}년`;
    const lst = p.legal.find(l => l.title === "추진단계");
    if (lst && row.stage) lst.content = row.stage;
  }
  updated++;
  updateLog.push(`  ~ ${target}: ${before.households}→${p.households}세대, ${before.built_year}→${p.built_year}, ${before.stage}→${p.stage}, 시공사: ${before.constructor || "-"} → ${p.constructor || "-"}`);
}
console.log(`\n── 업데이트 완료 (${updated}개) ──`);
for (const l of updateLog) console.log(l);

// 2) 신규 추가
console.log(`\n── 신규 추가 (${Object.keys(NEW_ADDR).length}개) ──`);
const tmpDir = "shp_temp_hwp_new";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);
let nextIdNum = sites.features.length + 1;
const newId = () => `RM${String(nextIdNum++).padStart(3, "0")}`;

// SHP별 그룹핑
const newRows = HWP_ROWS.filter(r => NEW_ADDR[r.name]);
const groups = {};
for (const row of newRows) {
  const meta = NEW_ADDR[row.name];
  const zip = getShpZip(meta.address);
  const key = zip || "__noshp";
  if (!groups[key]) groups[key] = [];
  groups[key].push({ row, meta });
}

let added = 0, shpMatched = 0;
for (const [zipFile, list] of Object.entries(groups)) {
  const hasShp = zipFile !== "__noshp" && existsSync(zipFile);
  let shpFiles = [];
  if (hasShp) {
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => unlinkSync(join(tmpDir, f)));
    try { new AdmZip(zipFile).extractAllTo(tmpDir, true); } catch (e) { console.log(`압축 실패: ${zipFile} ${e.message}`); }
    shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));
  }
  for (const { row, meta } of list) {
    const kres = await kakaoSearch(meta.keyword, meta.address) || await kakaoGeocode(meta.address);
    if (!kres) { console.log(`  실패: ${meta.name} (Kakao 결과 없음)`); continue; }
    let boundary = null, source = "circle";
    if (hasShp) {
      for (const shp of shpFiles) {
        const { pts, matched } = await findBuildings(`${tmpDir}/${shp}`, meta.shp_keywords, kres.lat, kres.lng);
        if (matched >= 2 && pts.length > 0) {
          const h = convexHull(pts);
          if (h && h.length >= 4) { boundary = h; source = "shp"; shpMatched++; break; }
        }
      }
    }
    if (!boundary) boundary = circleBoundary(kres.lat, kres.lng, 80);

    const feat = {
      type: "Feature",
      properties: {
        id: newId(),
        name: meta.name,
        subtype: row.stage ? "세대수증가형" : "세대수증가형",
        address: kres.address || meta.address,
        stage: row.stage || "조합설립",
        expected_completion: "",
        households: row.households || 0,
        existing_households: row.households || 0,
        added_households: 0,
        increase_rate: 0,
        area: "",
        built_year: row.built_year || 0,
        max_floors: 0,
        developer: meta.name + " 리모델링조합",
        constructor: row.constructor || "-",
        price_per_pyeong: 0, price_change: 0, contribution: 0,
        sale_price: 0, sale_price_date: "-", premium: 0,
        legal: [
          { title: "근거법령", content: "주택법 제66조(리모델링의 허가)" },
          { title: "준공연도", content: `${row.built_year || "-"}년` },
          { title: "추진단계", content: row.stage || "조합설립" },
          { title: "조합설립인가", content: row.union_date || "-" },
        ],
        boundarySource: source === "shp" ? "hwp-shp" : "hwp-circle",
      },
      geometry: { type: "Polygon", coordinates: [boundary] },
    };
    sites.features.push(feat);
    added++;
    console.log(`  + ${meta.name} [${source}] ${kres.lat.toFixed(6)}, ${kres.lng.toFixed(6)} — ${row.households}세대 ${row.built_year} ${row.stage || "-"} ${row.constructor || ""}`);
  }
}

writeFileSync(SITES_PATH, JSON.stringify(sites, null, 2), "utf-8");
console.log(`\n✅ 완료: 업데이트 ${updated}개 / 신규 ${added}개 (SHP매칭 ${shpMatched}) / 총 ${sites.features.length}개`);
