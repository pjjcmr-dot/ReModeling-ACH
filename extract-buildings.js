/**
 * GIS건물통합정보 SHP → 아파트 단지 실측경계 추출
 * - 같은 BLD_NM(건물명)의 동들을 그룹핑 → convex hull
 * - EPSG:5186 → WGS84 좌표 변환 (소숫점 13자리)
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

// EPSG:5186 (Korea 2000 Central Belt) → WGS84
proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

function toWGS84(x, y) {
  const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]);
  return [
    Math.round(lng * 10000000000000) / 10000000000000,
    Math.round(lat * 10000000000000) / 10000000000000,
  ];
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  if (pts.length === 3) return [...pts, pts[0]];
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
  let a = 0;
  const r = Math.PI / 180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const x1 = coords[i][0] * 111320 * Math.cos(coords[i][1] * r), y1 = coords[i][1] * 110540;
    const x2 = coords[j][0] * 111320 * Math.cos(coords[j][1] * r), y2 = coords[j][1] * 110540;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ── 주소 → SHP 파일 매핑 ──
function getShpZip(address) {
  const parts = address.split(" ");
  if (parts[0] === "서울") {
    const gu = parts[1]; // 강남구, 서초구 등
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
    if (existsSync("F_FAC_BUILDING_서울.zip")) return "F_FAC_BUILDING_서울.zip";
  }
  // 경기도 시/군
  const gyeonggi = ["성남시", "수원시", "용인시", "안양시", "고양시", "광명시", "부천시", "군포시"];
  if (gyeonggi.some((g) => address.includes(g))) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  // 인천
  if (address.includes("인천") && existsSync("F_FAC_BUILDING_인천.zip")) return "F_FAC_BUILDING_인천.zip";
  return null;
}

// ── SHP에서 아파트 건물 인덱스 구축 ──
async function buildAptIndex(shpPath) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const index = {}; // { "아파트명": [{ coords, dong, pnu }] }

  while (true) {
    const { done, value } = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM;
    if (!nm) continue;
    // 아파트/맨션/빌라트 카테고리 또는 용도코드 02(공동주택)
    const isApt = nm.includes("아파트") || nm.includes("맨션") || nm.includes("맨숀") ||
                  (value.properties.USABILITY || "").startsWith("02");
    if (!isApt) continue;

    if (!index[nm]) index[nm] = [];
    // 좌표를 WGS84로 변환
    const wgsCoords = value.geometry.coordinates[0].map((c) => toWGS84(c[0], c[1]));
    index[nm].push({
      coords: wgsCoords,
      dong: value.properties.DONG_NM,
      pnu: value.properties.PNU,
    });
  }

  return index;
}

// ── 사이트와 아파트 매칭 ──
function findMatch(siteName, siteAddress, aptIndex) {
  const parts = siteName.split(" ");
  const area = parts[0];
  const brand = parts.length > 1 ? parts.slice(1).join("") : parts[0];
  const brandClean = brand.replace(/[0-9()（）]/g, "");
  const brandNum = /\d$/.test(brand) ? brand + "차" : brand;

  // 매칭 패턴 (우선순위순)
  const patterns = [
    `${area}${brand}아파트`,
    `${area}${brandNum}아파트`,
    `${brandClean}아파트`,
    `${brand}아파트`,
    `${brandNum}아파트`,
    `${area}${brandClean}`,
    `${brand}`,
    `${brandClean}`,
  ];

  const dong = siteAddress.split(" ").pop(); // 반포동, 둔촌동 등

  // 1차: 정확 매칭
  for (const p of patterns) {
    for (const [aptName, buildings] of Object.entries(aptIndex)) {
      if (aptName.includes(p) || p.includes(aptName.replace("아파트", ""))) {
        return { name: aptName, buildings };
      }
    }
  }

  // 2차: 부분 매칭 (브랜드명이 아파트명에 포함)
  for (const [aptName, buildings] of Object.entries(aptIndex)) {
    if (brandClean.length >= 2 && aptName.includes(brandClean)) {
      return { name: aptName, buildings };
    }
  }

  return null;
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;
console.log(`${features.length}개 사업장 건물통합정보 SHP 경계 추출\n`);

// SHP 파일별로 그룹핑
const fileGroups = {};
const noFile = [];

for (let i = 0; i < features.length; i++) {
  const addr = features[i].properties.address;
  const zipFile = getShpZip(addr);
  if (zipFile) {
    if (!fileGroups[zipFile]) fileGroups[zipFile] = [];
    fileGroups[zipFile].push(i);
  } else {
    noFile.push(i);
  }
}

console.log("SHP 파일별 사이트 수:");
for (const [f, indices] of Object.entries(fileGroups)) {
  console.log(`  ${f}: ${indices.length}개`);
}
if (noFile.length > 0) {
  console.log(`  SHP 없음: ${noFile.length}개 (기존 경계 유지)`);
}
console.log();

let matched = 0, unmatched = 0;
const tmpDir = "shp_temp";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

for (const [zipFile, siteIndices] of Object.entries(fileGroups)) {
  console.log(`── ${zipFile} 처리 중 (${siteIndices.length}개 사이트) ──`);

  // ZIP 압축 해제 (adm-zip)
  try {
    // 기존 SHP 파일 정리
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => unlinkSync(join(tmpDir, f)));
    const zip = new AdmZip(zipFile);
    zip.extractAllTo(tmpDir, true);
  } catch (e) {
    console.log(`  압축 해제 실패: ${zipFile} (${e.message})`);
    continue;
  }

  // SHP 파일 찾기
  const shpFiles = readdirSync(tmpDir).filter((f) => f.endsWith(".shp"));
  if (shpFiles.length === 0) { console.log("  SHP 파일 없음"); continue; }

  // 아파트 인덱스 구축 (대형 파일은 시간 소요)
  console.log(`  인덱스 구축 중...`);
  const fullIndex = {};
  for (const shpFile of shpFiles) {
    const idx = await buildAptIndex(`${tmpDir}/${shpFile}`);
    Object.assign(fullIndex, idx);
  }
  const aptCount = Object.keys(fullIndex).length;
  console.log(`  아파트 ${aptCount}개 발견\n`);

  // 각 사이트 매칭
  for (const i of siteIndices) {
    const p = features[i].properties;
    const match = findMatch(p.name, p.address, fullIndex);

    if (match && match.buildings.length > 0) {
      // 모든 동의 좌표 수집 → convex hull
      const allPts = [];
      match.buildings.forEach((b) => b.coords.forEach((c) => allPts.push(c)));

      const h = convexHull(allPts);
      if (h && h.length >= 4) {
        const area = areaM2(h);
        features[i].geometry.coordinates = [h];
        matched++;
        process.stdout.write(
          `  [${i + 1}] ${p.name} → ${match.name} (${match.buildings.length}동) ${h.length - 1}점 ${Math.round(area)}㎡\n`
        );
        continue;
      }
    }

    unmatched++;
    process.stdout.write(`  [${i + 1}] ${p.name} → 매칭실패 (기존유지)\n`);
  }
  console.log();
}

// SHP 없는 사이트 로그
if (noFile.length > 0) {
  console.log(`── SHP 없는 사이트 (${noFile.length}개, 기존 유지) ──`);
  noFile.forEach((i) => {
    const p = features[i].properties;
    process.stdout.write(`  [${i + 1}] ${p.name} (${p.address})\n`);
    unmatched++;
  });
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료! SHP매칭: ${matched}개 / 기존유지: ${unmatched}개`);
console.log("public/sites.json 저장됨");
