/**
 * 현장 위치 정확도 개선 스크립트
 * 1) 카카오 keyword search (강화: 아파트명 변형 다수 시도)
 * 2) SHP에서 정확한 좌표 주변 건물 찾기 (키워드 + 대형 주거건물)
 * 3) 실패 시 Kakao 정확 좌표에 50m 원형 경계 (동 중심이 아닌 단지 좌표)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
if (!KAKAO_KEY) { console.error("KAKAO_REST_KEY 없음"); process.exit(1); }
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 원형 경계(폴백) 탐지 ──
function calcCenter(coords) {
  let cx = 0, cy = 0; const n = coords.length - 1;
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
}
function isLikelyCircle(coords) {
  if (coords.length < 20 || coords.length > 30) return false;
  const [cx, cy] = calcCenter(coords);
  const dists = coords.slice(0, -1).map(c => Math.sqrt((c[0] - cx) ** 2 + (c[1] - cy) ** 2));
  const avg = dists.reduce((a, b) => a + b, 0) / dists.length;
  const variance = dists.reduce((a, b) => a + (b - avg) ** 2, 0) / dists.length;
  return variance / avg < 0.01;
}

// ── 카카오 keyword 검색 (다양한 패턴 강화) ──
async function kakaoSearch(aptName, address) {
  const dong = address.split(" ").pop();
  const cleanName = aptName.replace(/^(서울|분당|이촌|오금|잠원|방배|개포|둔촌|문정|사당|신답|이수|상계|방학|월계|도곡|공덕|도원|리버힐|행당|목동|남산|마포|광장|이매|정든|매화|느티)\s*/, "");

  const patterns = [
    aptName + " 아파트",
    aptName,
    aptName.replace(/\s+/g, "") + " 아파트",
    aptName.replace(/\s+/g, ""),
    dong + " " + cleanName + " 아파트",
    dong + " " + cleanName,
    cleanName + " 아파트",
    cleanName + "아파트",
    cleanName + "마을",
    cleanName + "단지",
  ];

  // 먼저 주소로 동 중심 좌표 구하기 (검색 반경 기준점)
  let anchorX, anchorY;
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers });
    const d = await r.json();
    if (d.documents?.[0]) { anchorX = d.documents[0].x; anchorY = d.documents[0].y; }
  } catch {}

  for (const q of patterns) {
    try {
      const url = anchorX
        ? `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&x=${anchorX}&y=${anchorY}&radius=3000&size=10&sort=distance`
        : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=10`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      for (const doc of data.documents || []) {
        const addr = (doc.road_address_name || doc.address_name || "");
        const placeName = doc.place_name || "";
        // 구/동 매칭 확인
        const addressParts = address.split(" ");
        const hasRegion = addressParts.slice(0, 2).every(p => addr.includes(p) || placeName.includes(p));
        if (!hasRegion) continue;
        // 아파트/주거시설만 선호
        const isResidential = (doc.category_name || "").match(/아파트|주거|부동산/);
        if (!isResidential) continue;
        await delay(50);
        return { lat: +doc.y, lng: +doc.x, place_name: placeName, address: addr, pattern: q };
      }
    } catch {}
    await delay(50);
  }
  return null;
}

// ── SHP 파일 경로 ──
function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(" ")[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
    if (existsSync("F_FAC_BUILDING_서울.zip")) return "F_FAC_BUILDING_서울.zip";
  }
  if (address.includes("성남") || address.includes("분당")) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  return null;
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

// ── SHP에서 정확한 좌표 주변 아파트 건물 찾기 ──
async function findBuildings(shpPath, keywords, centerLat, centerLng) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const matchedBuildings = [];
  const nearbyLarge = []; // 키워드 매칭 실패시 폴백용 (주변 대형 건물)

  const MAX_DIST_KEYWORD = 0.003; // 약 300m (키워드 매칭)
  const MAX_DIST_LARGE = 0.0012;  // 약 120m (키워드 없이 대형 건물)

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;

    const cx = wgs.reduce((s, c) => s + c[0], 0) / wgs.length;
    const cy = wgs.reduce((s, c) => s + c[1], 0) / wgs.length;
    const dist = Math.sqrt((cx - centerLng) ** 2 + (cy - centerLat) ** 2);

    // 1) 키워드 매칭
    if (keywords.some(k => nm.includes(k)) && dist < MAX_DIST_KEYWORD) {
      matchedBuildings.push({ pts: wgs, name: nm, dist });
    }
    // 2) 주변 대형 건물 (폴백)
    else if (dist < MAX_DIST_LARGE && wgs.length >= 6) {
      const a = areaM2(wgs);
      if (a > 300) { // 300㎡ 이상
        nearbyLarge.push({ pts: wgs, name: nm, dist, area: a });
      }
    }
  }

  return { matchedBuildings, nearbyLarge };
}

// ── 건물들을 같은 좌표 그룹으로 병합 후 convex hull ──
function buildBoundary(buildings) {
  if (buildings.length === 0) return null;
  const pts = [];
  buildings.forEach(b => b.pts.forEach(p => pts.push(p)));
  return convexHull(pts);
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;

// 원형 폴백으로 추정되는 사이트 + 사용자가 부정확하다고 느끼는 모든 사이트 대상
const targets = features.filter(f => isLikelyCircle(f.geometry.coordinates[0]));
console.log(`원형 폴백 추정 사이트: ${targets.length}개`);

const tmpDir = "shp_temp_fix";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

// SHP 파일별 그룹핑
const groups = {};
for (const f of targets) {
  const zip = getShpZip(f.properties.address);
  if (zip) {
    if (!groups[zip]) groups[zip] = [];
    groups[zip].push(f);
  } else {
    if (!groups.__nogshp) groups.__nogshp = [];
    groups.__nogshp.push(f);
  }
}

let improved = 0, shpMatched = 0, preciseOnly = 0;

for (const [zipFile, siteList] of Object.entries(groups)) {
  console.log(`\n── ${zipFile} (${siteList.length}개) ──`);

  if (zipFile !== "__nogshp") {
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => {
      try { unlinkSync(join(tmpDir, f)); } catch {}
    });
    try { new AdmZip(zipFile).extractAllTo(tmpDir, true); }
    catch (e) { console.log(`  압축해제 실패: ${e.message}`); continue; }
  }

  const shpFiles = zipFile !== "__nogshp" ? readdirSync(tmpDir).filter(f => f.endsWith(".shp")) : [];

  for (const f of siteList) {
    const p = f.properties;
    const kres = await kakaoSearch(p.name, p.address);
    if (!kres) {
      console.log(`  ${p.name}: Kakao 검색 실패`);
      continue;
    }

    // 아파트명에서 검색 키워드 생성
    const parts = p.name.split(" ");
    const brand = parts.slice(1).join("");
    const derived = [
      p.name, p.name.replace(/\s+/g, ""), brand,
      brand.replace(/(\d+)$/, "$1차"),
      brand.replace(/1차/, "1"), brand.replace(/2차/, "2"),
      brand.replace(/1$/, "1차"), brand.replace(/2$/, "2차"),
    ].filter(Boolean);
    const keywords = [...new Set(derived)];

    let boundary = null;
    let source = "";

    if (shpFiles.length > 0) {
      for (const shp of shpFiles) {
        const { matchedBuildings, nearbyLarge } = await findBuildings(`${tmpDir}/${shp}`, keywords, kres.lat, kres.lng);
        if (matchedBuildings.length >= 2) {
          boundary = buildBoundary(matchedBuildings);
          source = `SHP(키워드 ${matchedBuildings.length}동)`;
          shpMatched++;
          break;
        } else if (matchedBuildings.length === 1) {
          // 1개만 매칭되면 주변 대형 건물과 병합
          boundary = buildBoundary([...matchedBuildings, ...nearbyLarge.slice(0, 5)]);
          source = `SHP(단일+주변 ${matchedBuildings.length + Math.min(nearbyLarge.length, 5)}동)`;
          shpMatched++;
          break;
        } else if (nearbyLarge.length >= 3) {
          // 키워드 없이 주변 대형 건물만 (단지로 추정)
          const sortedLarge = nearbyLarge.sort((a, b) => a.dist - b.dist).slice(0, 8);
          boundary = buildBoundary(sortedLarge);
          source = `SHP(주변대형 ${sortedLarge.length}동)`;
          shpMatched++;
          break;
        }
      }
    }

    if (!boundary) {
      boundary = circleBoundary(kres.lat, kres.lng, 60);
      source = "카카오정확좌표+60m원";
      preciseOnly++;
    }

    // 면적 체크
    const a = boundary.length > 3 ? areaM2(boundary) : 0;
    console.log(`  ${p.name}: ${source} (${Math.round(a)}㎡) @ ${kres.lat.toFixed(6)},${kres.lng.toFixed(6)}`);

    f.geometry.coordinates = [boundary];
    improved++;
    await delay(100);
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n── 완료 ──`);
console.log(`개선: ${improved}개 / SHP매칭: ${shpMatched}개 / 카카오정확좌표만: ${preciseOnly}개`);

// 임시 폴더 정리
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
