/**
 * 실측경계 전반 재생성 (DONG_NM 기반 정확한 단지 구분)
 *
 * 핵심 개선:
 * 1. BLD_NM + DONG_NM 동번호 앞자리로 단지 구분 (예: 우성2차 → 2xx동만)
 * 2. "N차"/"N단지" 키워드 자동 파싱
 * 3. PNU(지번) 그룹핑으로 같은 단지 판별
 * 4. 매칭된 건물 좌표만 → 타이트한 convex hull (주변 대형 건물 금지)
 * 5. 매칭 0건일 때만 50m 원형 폴백
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

// ── 기하 유틸 ──
function toWGS84(x, y) {
  if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return null;
  try { const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]); return [Math.round(lng*1e13)/1e13, Math.round(lat*1e13)/1e13]; } catch { return null; }
}
function convexHull(points) {
  const pts = [...points].sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  if (pts.length < 3) return null;
  const cr = (O,A,B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
  const lo=[]; for (const p of pts) { while (lo.length>=2 && cr(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop(); lo.push(p); }
  const up=[]; for (const p of [...pts].reverse()) { while (up.length>=2 && cr(up[up.length-2],up[up.length-1],p)<=0) up.pop(); up.push(p); }
  const h = lo.slice(0,-1).concat(up.slice(0,-1)); h.push(h[0]); return h;
}
function areaM2(coords) {
  let a=0; const r=Math.PI/180;
  for (let i=0;i<coords.length;i++) {
    const j=(i+1)%coords.length;
    const x1=coords[i][0]*111320*Math.cos(coords[i][1]*r), y1=coords[i][1]*110540;
    const x2=coords[j][0]*111320*Math.cos(coords[j][1]*r), y2=coords[j][1]*110540;
    a+=x1*y2-x2*y1;
  }
  return Math.abs(a)/2;
}
function polyCenter(coords) {
  let cx=0, cy=0; const n=coords.length-1;
  for (let i=0;i<n;i++) { cx+=coords[i][0]; cy+=coords[i][1]; }
  return [cx/n, cy/n];
}
function isLikelyCircle(coords) {
  if (coords.length < 20 || coords.length > 30) return false;
  const [cx,cy] = polyCenter(coords);
  const dists = coords.slice(0,-1).map(c => Math.sqrt((c[0]-cx)**2+(c[1]-cy)**2));
  const avg = dists.reduce((a,b)=>a+b,0)/dists.length;
  const variance = dists.reduce((a,b)=>a+(b-avg)**2,0)/dists.length;
  return variance/avg < 0.01;
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

// ── 단지명 → 매칭 규칙 파싱 ──
// 예: "사당 우성2차" → { nameKeys: ["우성"], dongPrefix: "2" }
//     "분당 매화1"   → { nameKeys: ["매화"], dongPrefix: "1", dangji: 1 }
//     "개포 우성9"   → { nameKeys: ["우성"], dangji: 9 }
//     "송파 성지"    → { nameKeys: ["성지"] }
function parseRule(siteName) {
  // "지역 브랜드+번호" 또는 "지역 브랜드" 형식
  const parts = siteName.split(/\s+/).filter(Boolean);
  const rest = parts.slice(1).join("");
  // 맨 끝 번호 추출 (1, 2, 2차, 5단지, 10단지 등)
  let dangji = null;
  let dongPrefix = null;
  let base = rest;
  const m = rest.match(/^(.+?)(\d+)(차|단지)?$/);
  if (m) {
    base = m[1];
    dangji = parseInt(m[2]);
    // 번호 1자리면 dongPrefix 사용 가능
    if (dangji >= 1 && dangji <= 9) dongPrefix = String(dangji);
  }
  // 브랜드 키워드 추출 (2글자 이상, 공백/숫자 제거)
  const nameKeys = [];
  // 전체 (공백 제거)
  nameKeys.push(rest);
  // 베이스 (숫자 제거)
  if (base && base !== rest && base.length >= 2) nameKeys.push(base);
  // 원본 단지명
  nameKeys.push(siteName.replace(/\s+/g, ""));
  return {
    siteName,
    nameKeys: [...new Set(nameKeys)].filter(k => k.length >= 2),
    base: base || rest,
    dangji,
    dongPrefix,
  };
}

// ── BLD_NM 매칭 (브랜드 + 선택적 차수 접미사) ──
function matchBldName(bldNm, rule) {
  if (!bldNm) return false;
  // base 키워드 포함 여부 (예: "우성", "극동", "신동아", "매화")
  return rule.nameKeys.some(k => bldNm.includes(k));
}

// ── DONG_NM 앞자리 매칭 (단지 구분) ──
function matchDongPrefix(dongNm, rule) {
  if (!rule.dongPrefix) return true; // 차수 정보 없으면 모두 통과
  if (!dongNm) return true;           // dongNm이 비어있으면 통과 (단독 단지)
  // "207동" / "207호" / "5단지 상가" 등에서 숫자 첫 자리
  const m = dongNm.match(/(\d+)/);
  if (!m) return true; // 숫자가 없으면 (상가, 관리동 등) 통과
  const n = m[1];
  // 1자리 → 숫자 그대로 비교 (101동 → 1xx, 207동 → 2xx, 5단지 → 5)
  if (n.length === 1) return n === rule.dongPrefix;
  return n[0] === rule.dongPrefix;
}

// ── DONG_NM 전용 무시 패턴 (상가/관리동/지하주차장 등은 경계 구성에서 제외) ──
function isAuxBuilding(dongNm) {
  if (!dongNm) return false;
  return /상가|관리|근생|지하|주차|복지|경로/.test(dongNm);
}

// ── SHP zip 경로 ──
function getShpZips(address) {
  const zips = [];
  if (address.includes("서울")) {
    const gu = address.split(/\s+/)[1];
    const gz = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(gz)) zips.push(gz);
    else if (existsSync("F_FAC_BUILDING_서울.zip")) zips.push("F_FAC_BUILDING_서울.zip");
  } else if (/성남|분당|수원|안양|용인|고양|광명|군포|부천|의왕|안산/.test(address)) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) zips.push("F_FAC_BUILDING_경기.zip");
  }
  return zips;
}

// ── Kakao로 정확 좌표 재탐색 ──
async function kakaoFindApt(siteName, address) {
  if (!KAKAO_KEY) return null;
  // 1) 주소로 동 기준점 확보
  let anchorX, anchorY;
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers });
    const d = await r.json();
    if (d.documents?.[0]) { anchorX = +d.documents[0].x; anchorY = +d.documents[0].y; }
  } catch {}
  await delay(60);

  const parts = siteName.split(/\s+/);
  const rest = parts.slice(1).join("");
  const dong = address.split(/\s+/).pop();
  const queries = [
    siteName + " 아파트",
    siteName,
    rest + " 아파트",
    rest,
    dong + " " + rest,
    siteName.replace(/\s+/g, "") + " 아파트",
  ];
  for (const q of queries) {
    try {
      const url = anchorX
        ? `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&x=${anchorX}&y=${anchorY}&radius=3000&size=15&sort=distance`
        : `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=15`;
      const r = await fetch(url, { headers });
      const d = await r.json();
      for (const doc of d.documents || []) {
        const addr = (doc.road_address_name || doc.address_name || "");
        const regionOK = address.split(/\s+/).slice(0,2).every(p => addr.includes(p));
        if (!regionOK) continue;
        if (!/아파트|주거|부동산/.test(doc.category_name || "")) continue;
        await delay(60);
        return { lat: +doc.y, lng: +doc.x, addr, name: doc.place_name };
      }
    } catch {}
    await delay(60);
  }
  return null;
}

// ── SHP 빌딩 풀에서 해당 단지 매칭 ──
function collectCandidates(buildings, rule, centerLat, centerLng, maxDistDeg = 0.004) {
  // 1) 키워드+동번호 매칭
  const matched = [];
  for (const b of buildings) {
    const d = Math.sqrt((b.cx - centerLng)**2 + (b.cy - centerLat)**2);
    if (d > maxDistDeg) continue;
    if (!matchBldName(b.name, rule)) continue;
    if (!matchDongPrefix(b.dongNm, rule)) continue;
    matched.push({...b, dist: d});
  }
  return matched;
}

// ── PNU별 그룹화 후 최대 집단 선택 ──
function pickBestDangjiGroup(matched, centerLat, centerLng) {
  if (matched.length === 0) return [];
  // 1) PNU별 그룹
  const groups = {};
  for (const b of matched) {
    const key = b.pnu || "__nopnu";
    (groups[key] ||= []).push(b);
  }
  const groupArr = Object.entries(groups).map(([pnu, list]) => {
    const cx = list.reduce((s,b)=>s+b.cx,0)/list.length;
    const cy = list.reduce((s,b)=>s+b.cy,0)/list.length;
    const d = Math.sqrt((cx-centerLng)**2+(cy-centerLat)**2);
    return { pnu, list, cx, cy, dist: d, score: list.length - d * 1000 };
  });
  // 중심에 가까운 큰 그룹 우선 (score = 건물수 - 거리 패널티)
  groupArr.sort((a,b) => b.score - a.score);
  // 최대 그룹 + 근접한 추가 그룹 (center 150m 이내만)
  const best = groupArr[0];
  const nearBest = groupArr.filter(g => {
    const d = Math.sqrt((g.cx-best.cx)**2+(g.cy-best.cy)**2);
    return d < 0.0015; // ~150m
  });
  return nearBest.flatMap(g => g.list);
}

// ── 경계 구성 ──
function buildBoundary(buildings) {
  // 주건물(상가/관리동 제외) 우선 → 없으면 전체
  const main = buildings.filter(b => !isAuxBuilding(b.dongNm));
  const src = main.length >= 2 ? main : buildings;
  const pts = src.flatMap(b => b.coords);
  return convexHull(pts);
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// 대상: 원형 폴백 + 면적 이상치 (너무 작거나 너무 큰)
const suspectSites = sites.features.filter(f => {
  const coords = f.geometry.coordinates[0];
  if (isLikelyCircle(coords)) return true;
  const a = areaM2(coords);
  const hh = f.properties.households || 0;
  if (hh >= 100 && a < Math.max(1500, hh * 8)) return true;  // 가구 대비 너무 작음
  if (hh > 0 && a / hh > 600) return true;                    // 가구 대비 너무 큼 (경계 과대)
  if (a > 150000) return true;                                 // 절대 면적이 너무 큼
  return false;
});

console.log(`처리 대상: ${suspectSites.length}/${sites.features.length}개`);

// Zip별 그룹핑
const byZip = {};
for (const f of suspectSites) {
  const zips = getShpZips(f.properties.address);
  const key = zips[0] || "__noshp";
  (byZip[key] ||= []).push(f);
}
console.log("── zip별 건수 ──");
for (const [k,v] of Object.entries(byZip)) console.log(` ${k}: ${v.length}개`);

const tmpDir = "shp_rebuild";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

let okKw = 0, okFallback = 0, okCircle = 0, skipped = 0;
const results = [];

for (const [zip, list] of Object.entries(byZip)) {
  if (zip === "__noshp") {
    console.log(`\n── SHP 없는 지역 (${list.length}개): Kakao 원형 폴백만 적용 ──`);
    for (const site of list) {
      const kres = await kakaoFindApt(site.properties.name, site.properties.address);
      if (!kres) { skipped++; results.push({name:site.properties.name, status:"kakao 실패"}); continue; }
      site.geometry.coordinates = [circleBoundary(kres.lat, kres.lng, 55)];
      okCircle++;
      results.push({name:site.properties.name, status:`원형 55m @ ${kres.lat.toFixed(5)},${kres.lng.toFixed(5)}`});
    }
    continue;
  }

  console.log(`\n── ${zip} (${list.length}개) ──`);
  // clean tmp
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); }
  catch (e) { console.log(` 압축해제 실패: ${e.message}`); skipped += list.length; continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  // 모든 SHP 한번 로드 (각 사이트 매칭 재사용)
  console.log(`  SHP 로드 중 (${shpFiles.length}파일)...`);
  const t0 = Date.now();
  const buildings = [];
  for (const shp of shpFiles) {
    const src = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
    while (true) {
      const { done, value } = await src.read();
      if (done) break;
      const nm = value.properties.BLD_NM || "";
      if (!nm) continue;
      const coords = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
      if (coords.length < 3) continue;
      const cx = coords.reduce((s,c)=>s+c[0],0)/coords.length;
      const cy = coords.reduce((s,c)=>s+c[1],0)/coords.length;
      buildings.push({
        name: nm,
        dongNm: value.properties.DONG_NM,
        pnu: value.properties.PNU,
        coords, cx, cy,
      });
    }
  }
  console.log(`  ${buildings.length.toLocaleString()}개 건물 로드 (${((Date.now()-t0)/1000).toFixed(1)}s)`);

  // 사이트별 처리
  for (const site of list) {
    const p = site.properties;
    const rule = parseRule(p.name);

    // 기존 사이트 중심 좌표 (폴백/이상치라도 중심은 의미있음)
    const [oldCx, oldCy] = polyCenter(site.geometry.coordinates[0]);
    let centerLat = oldCy, centerLng = oldCx;
    let usedKakao = false;

    // 키워드 매칭 시도 (기존 중심)
    let matched = collectCandidates(buildings, rule, centerLat, centerLng);
    let best = pickBestDangjiGroup(matched, centerLat, centerLng);

    // 기존 중심으로 매칭 실패 → Kakao 재탐색
    if (best.length < 2 && KAKAO_KEY) {
      const kres = await kakaoFindApt(p.name, p.address);
      if (kres) {
        centerLat = kres.lat; centerLng = kres.lng; usedKakao = true;
        matched = collectCandidates(buildings, rule, centerLat, centerLng);
        best = pickBestDangjiGroup(matched, centerLat, centerLng);
      }
    }

    if (best.length >= 2) {
      const boundary = buildBoundary(best);
      if (boundary) {
        const a = areaM2(boundary);
        site.geometry.coordinates = [boundary];
        okKw++;
        const suffix = usedKakao ? " (Kakao)" : "";
        results.push({name:p.name, status:`SHP ${best.length}동 (${Math.round(a).toLocaleString()}m²)${suffix}`});
        console.log(`  ✓ ${p.name}: ${best.length}동 매칭 → ${Math.round(a).toLocaleString()}m²${suffix}`);
        continue;
      }
    }

    if (best.length === 1) {
      // 단일 동은 너무 작음 → 주변 동일 키워드/PNU 건물 1동 이상만 추가 (다른 차수 제외)
      const b0 = best[0];
      // 같은 PNU인 것 중 DONG 제약 없이 추가
      const samePnu = buildings.filter(b => b.pnu && b.pnu === b0.pnu && Math.sqrt((b.cx-b0.cx)**2+(b.cy-b0.cy)**2) < 0.0012);
      if (samePnu.length >= 2) {
        const filtered = rule.dongPrefix
          ? samePnu.filter(b => matchDongPrefix(b.dongNm, rule))
          : samePnu;
        const bnd = buildBoundary(filtered.length >= 2 ? filtered : samePnu);
        if (bnd) {
          const a = areaM2(bnd);
          site.geometry.coordinates = [bnd];
          okKw++;
          results.push({name:p.name, status:`SHP PNU동일 ${samePnu.length}동 (${Math.round(a).toLocaleString()}m²)`});
          console.log(`  ✓ ${p.name}: PNU동일 ${samePnu.length}동 → ${Math.round(a).toLocaleString()}m²`);
          continue;
        }
      }
    }

    // 최종 폴백: Kakao 좌표 + 55m 원형
    if (KAKAO_KEY) {
      const kres = usedKakao ? { lat: centerLat, lng: centerLng } : await kakaoFindApt(p.name, p.address);
      if (kres) {
        site.geometry.coordinates = [circleBoundary(kres.lat, kres.lng, 55)];
        okCircle++;
        results.push({name:p.name, status:`원형 55m @ ${kres.lat.toFixed(5)},${kres.lng.toFixed(5)}`});
        console.log(`  - ${p.name}: 매칭 실패 → 원형 폴백`);
        continue;
      }
    }
    skipped++;
    results.push({name:p.name, status:"매칭 실패"});
    console.log(`  ✗ ${p.name}: 매칭 실패 (기존 유지)`);
  }

  // 각 zip 처리 후 저장 (중간 저장)
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  → 저장`);
}

console.log(`\n── 완료 ──`);
console.log(` SHP 매칭: ${okKw}개`);
console.log(` 원형 폴백: ${okCircle}개`);
console.log(` 실패/스킵: ${skipped}개`);

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
