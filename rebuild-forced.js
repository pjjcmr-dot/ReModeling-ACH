/**
 * 특정 문제 단지 강제 재처리 (DONG_NM 기반 매칭)
 * - 사당 극동/우성3차/신동아5차 등 경계 겹침 문제
 * - 기타 이상치 (원형폴백, 가구당 면적 > 150 m²이고 500가구 이상)
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

// ── 단지명 파싱 (DONG_NM 앞자리 규칙 추출) ──
function parseRule(siteName) {
  const parts = siteName.split(/\s+/).filter(Boolean);
  const rest = parts.slice(1).join("");
  let dangji = null, dongPrefix = null, base = rest;
  const m = rest.match(/^(.+?)(\d+)(차|단지)?$/);
  if (m) {
    base = m[1];
    dangji = parseInt(m[2]);
    if (dangji >= 1 && dangji <= 9) dongPrefix = String(dangji);
  }
  const nameKeys = [rest, base, siteName.replace(/\s+/g, "")].filter(k => k && k.length >= 2);
  return { siteName, nameKeys: [...new Set(nameKeys)], base, dangji, dongPrefix };
}

function matchBldName(bldNm, rule) {
  if (!bldNm) return false;
  return rule.nameKeys.some(k => bldNm.includes(k));
}
function matchDongPrefix(dongNm, rule) {
  if (!rule.dongPrefix) return true;
  if (!dongNm) return true;
  const m = dongNm.match(/(\d+)/);
  if (!m) return true;
  const n = m[1];
  if (n.length === 1) return n === rule.dongPrefix;
  return n[0] === rule.dongPrefix;
}
function isAuxBuilding(dongNm) {
  if (!dongNm) return false;
  return /상가|관리|근생|지하|주차|복지|경로/.test(dongNm);
}

function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(/\s+/)[1];
    const gz = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(gz)) return gz;
    if (existsSync("F_FAC_BUILDING_서울.zip")) return "F_FAC_BUILDING_서울.zip";
  } else if (/성남|분당|수원|안양|용인|고양|광명|군포|부천|의왕|안산/.test(address)) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
  }
  return null;
}

async function kakaoFindApt(siteName, address) {
  if (!KAKAO_KEY) return null;
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
  const queries = [siteName + " 아파트", siteName, rest + " 아파트", rest, dong + " " + rest];
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

function collectCandidates(buildings, rule, centerLat, centerLng, maxDistDeg = 0.005) {
  // 1차: 키워드 + 거리 + DONG 접두사 매칭
  const matched = [];
  const matchedPNUs = new Set();
  for (const b of buildings) {
    const d = Math.sqrt((b.cx - centerLng)**2 + (b.cy - centerLat)**2);
    if (d > maxDistDeg) continue;
    if (!matchBldName(b.name, rule)) continue;
    if (!matchDongPrefix(b.dongNm, rule)) continue;
    matched.push({...b, dist: d});
    if (b.pnu) matchedPNUs.add(b.pnu);
  }
  // 2차: 같은 PNU인 건물은 거리 제한 없이 모두 포함 (같은 단지 보장)
  if (matchedPNUs.size > 0) {
    const matchedIds = new Set(matched.map(m => m.name + "@" + m.cx + "," + m.cy));
    for (const b of buildings) {
      if (!b.pnu || !matchedPNUs.has(b.pnu)) continue;
      if (!matchBldName(b.name, rule)) continue;
      if (!matchDongPrefix(b.dongNm, rule)) continue;
      const key = b.name + "@" + b.cx + "," + b.cy;
      if (matchedIds.has(key)) continue;
      matched.push({...b, dist: Math.sqrt((b.cx - centerLng)**2 + (b.cy - centerLat)**2)});
      matchedIds.add(key);
    }
  }
  return matched;
}
function pickBestDangjiGroup(matched, centerLat, centerLng) {
  if (matched.length === 0) return [];
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
  groupArr.sort((a,b) => b.score - a.score);
  const best = groupArr[0];
  const nearBest = groupArr.filter(g => {
    const d = Math.sqrt((g.cx-best.cx)**2+(g.cy-best.cy)**2);
    return d < 0.0015;
  });
  return nearBest.flatMap(g => g.list);
}
function buildBoundary(buildings) {
  const main = buildings.filter(b => !isAuxBuilding(b.dongNm));
  const src = main.length >= 2 ? main : buildings;
  const pts = src.flatMap(b => b.coords);
  return convexHull(pts);
}

// 개별 건물 MultiPolygon 생성 (각 건물이 독립 폴리곤)
function buildMultiPolygon(buildings) {
  const main = buildings.filter(b => !isAuxBuilding(b.dongNm));
  const src = main.length >= 2 ? main : buildings;
  // GeoJSON MultiPolygon: [ [ [ring1] ], [ [ring2] ], ... ]
  return src.map(b => {
    // b.coords = [[lng,lat], ...] - 링이 닫혀있는지 확인
    const ring = [...b.coords];
    if (ring.length > 0) {
      const first = ring[0], last = ring[ring.length-1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    }
    return [ring]; // 폴리곤은 [외곽링, 홀1, 홀2...], 홀 없음
  });
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// 강제 재처리 대상 (이름 기준)
const FORCE_NAMES = [
  "사당 극동", "사당 우성3차", "사당 신동아5차", "사당 우성2차",
];

// + 추가 이상치: 가구당 면적 너무 큼 (200 m²/가구 이상 + 200가구 이상), 또는 총 면적 80,000 이상
const autoTargets = sites.features.filter(f => {
  const name = f.properties.name;
  if (FORCE_NAMES.includes(name)) return false; // 수동 목록은 따로
  const hh = f.properties.households || 0;
  const a = areaM2(f.geometry.coordinates[0]);
  if (hh >= 200 && a / hh > 200) return true;
  if (a > 80000 && hh < 2000) return true;
  return false;
});

const forced = sites.features.filter(f => FORCE_NAMES.includes(f.properties.name));
const targets = [...forced, ...autoTargets];
console.log(`강제 처리: ${forced.length}개, 자동 이상치 추가: ${autoTargets.length}개, 합계 ${targets.length}개`);

// zip별 그룹핑
const byZip = {};
for (const f of targets) {
  const zip = getShpZip(f.properties.address);
  const key = zip || "__noshp";
  (byZip[key] ||= []).push(f);
}
for (const [k,v] of Object.entries(byZip)) console.log(` ${k}: ${v.length}개 (${v.map(f=>f.properties.name).join(", ")})`);

const tmpDir = "shp_rebuild_force";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

let improved = 0, kept = 0;

for (const [zip, list] of Object.entries(byZip)) {
  if (zip === "__noshp") continue;
  console.log(`\n── ${zip} ──`);
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); }
  catch (e) { console.log(` 압축해제 실패: ${e.message}`); continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  console.log(`  SHP 로드 중...`);
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
      buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, coords, cx, cy });
    }
  }
  console.log(`  ${buildings.length.toLocaleString()}개 건물 (${((Date.now()-t0)/1000).toFixed(1)}s)`);

  for (const site of list) {
    const p = site.properties;
    const rule = parseRule(p.name);
    const oldArea = areaM2(site.geometry.coordinates[0]);

    // Kakao로 정확 좌표 확보
    let centerLat, centerLng, usedKakao = false;
    const kres = await kakaoFindApt(p.name, p.address);
    if (kres) { centerLat = kres.lat; centerLng = kres.lng; usedKakao = true; }
    else { const [cx,cy] = polyCenter(site.geometry.coordinates[0]); centerLat = cy; centerLng = cx; }

    // 매칭
    const matched = collectCandidates(buildings, rule, centerLat, centerLng);
    const best = pickBestDangjiGroup(matched, centerLat, centerLng);

    if (best.length >= 2) {
      const boundary = buildBoundary(best);
      if (boundary) {
        const newArea = areaM2(boundary);
        // 안전장치: 신규 면적이 너무 극단적이면 거부 (3,000 ~ 300,000)
        if (newArea < 3000 || newArea > 300000) {
          console.log(`  ! ${p.name}: 신규면적 ${Math.round(newArea).toLocaleString()}m² 거부 (기존 ${Math.round(oldArea).toLocaleString()}m² 유지)`);
          kept++;
          continue;
        }
        site.geometry.coordinates = [boundary];
        improved++;
        console.log(`  ✓ ${p.name}: ${best.length}동 매칭 (${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m²)${usedKakao?" [Kakao]":""}`);
        continue;
      }
    }

    if (best.length === 1) {
      // 단일 동 + 같은 PNU 추가
      const b0 = best[0];
      const samePnu = buildings.filter(b => b.pnu && b.pnu === b0.pnu && Math.sqrt((b.cx-b0.cx)**2+(b.cy-b0.cy)**2) < 0.0012);
      if (samePnu.length >= 2) {
        const filtered = rule.dongPrefix ? samePnu.filter(b => matchDongPrefix(b.dongNm, rule)) : samePnu;
        const bnd = buildBoundary(filtered.length >= 2 ? filtered : samePnu);
        if (bnd) {
          const newArea = areaM2(bnd);
          if (newArea >= 3000 && newArea <= 300000) {
            site.geometry.coordinates = [bnd];
            improved++;
            console.log(`  ✓ ${p.name}: PNU동일 ${samePnu.length}동 (${Math.round(oldArea).toLocaleString()} → ${Math.round(newArea).toLocaleString()}m²)`);
            continue;
          }
        }
      }
    }

    console.log(`  - ${p.name}: 매칭 실패 (기존 ${Math.round(oldArea).toLocaleString()}m² 유지)`);
    kept++;
  }
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
}

console.log(`\n── 완료 ── 개선: ${improved}개 / 유지: ${kept}개`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
