/**
 * 지적도(VWORLD) 기반 사업지 실측경계 생성
 * - SHP 건물 PNU로 해당 단지 필지 식별
 * - VWORLD LP_PA_CBND_BUBUN에서 필지 경계 취득
 * - 동일 단지 필지 병합 → 사업지 외곽 경계 1개 Polygon
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

const KAKAO_KEY = process.env.KAKAO_REST_KEY || "";
const VWORLD_KEYS = [
  process.env.VITE_VWORLD_API_KEY,
  "5E98DF37-2739-3211-97EA-B4D2F84FBEE8",
  "D2254EC7-AF49-32B2-BE63-1FC6B72F19DA",
  "5C4953A5-8A28-3F49-91FA-FC9F3C4108EC",
].filter(Boolean);
let vwKeyIdx = 0;
function nextVwKey() { const k = VWORLD_KEYS[vwKeyIdx % VWORLD_KEYS.length]; vwKeyIdx++; return k; }

const kHeaders = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// ── 지오메트리 유틸 ──

function toWGS84(x, y) {
  if (!isFinite(x) || !isFinite(y) || x === 0 || y === 0) return null;
  try { const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]); return [Math.round(lng * 1e13) / 1e13, Math.round(lat * 1e13) / 1e13]; } catch { return null; }
}

function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return null;
  const cr = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  const lo = []; for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  const up = []; for (const p of [...pts].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
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

function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function polyCenter(coords) {
  let cx = 0, cy = 0; const n = coords.length - 1 || 1;
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
}

function isCircleFallback(coords) {
  const n = coords.length;
  if (n < 20 || n > 30) return false;
  const cx = coords.reduce((s, c) => s + c[0], 0) / n;
  const cy = coords.reduce((s, c) => s + c[1], 0) / n;
  const dists = coords.map(c => Math.sqrt((c[0] - cx) ** 2 + (c[1] - cy) ** 2));
  const avg = dists.reduce((s, d) => s + d, 0) / dists.length;
  if (avg === 0) return true;
  const variance = dists.reduce((s, d) => s + (d - avg) ** 2, 0) / dists.length;
  return variance / avg < 0.00001;
}

// ── 단지명 파싱 + 건물 매칭 (rebuild-all.js에서 가져옴) ──

const BRANDS = [
  "현대", "우성", "삼성", "대림", "한신", "한양", "극동", "건영", "신동아", "쌍용",
  "롯데", "대우", "한진", "동아", "동부", "금호", "벽산", "풍림", "청구", "코오롱",
  "선경", "경남", "부영", "주공", "세경", "태영", "무학", "삼익", "아남", "중앙",
  "라이프", "신라", "한솔", "공무원", "시영", "GS", "SK",
];

function parseRule(siteName) {
  const parts = siteName.split(/\s+/).filter(Boolean);
  let dong, rest;
  if (parts.length >= 2) { dong = parts[0]; rest = parts.slice(1).join(""); }
  else {
    const full = parts[0];
    let splitIdx = 0;
    for (const len of [3, 2]) {
      if (full.length > len && /^[가-힣]{2,3}$/.test(full.substring(0, len))) { splitIdx = len; break; }
    }
    dong = splitIdx > 0 ? full.substring(0, splitIdx) : "";
    rest = splitIdx > 0 ? full.substring(splitIdx) : full;
  }
  let dangji = null, dongPrefix = null, base = rest;
  const m = rest.match(/^(.+?)(\d+)(차|단지)?$/);
  if (m) { base = m[1]; dangji = parseInt(m[2]); if (dangji >= 1 && dangji <= 9) dongPrefix = String(dangji); }

  const nameKeys = new Set();
  if (rest && rest.length >= 2) nameKeys.add(rest);
  if (base && base.length >= 2) nameKeys.add(base);
  nameKeys.add(siteName.replace(/\s+/g, ""));
  if (dong && rest) nameKeys.add(dong + rest);
  const toSplit = base || rest;
  if (toSplit && toSplit.length >= 4) {
    for (const brand of BRANDS) {
      const idx = toSplit.indexOf(brand);
      if (idx >= 0) {
        const before = toSplit.substring(0, idx);
        if (before.length >= 2) nameKeys.add(before);
        nameKeys.add(brand);
        const after = toSplit.substring(idx + brand.length);
        if (after.length >= 2) nameKeys.add(after);
      }
    }
    if (toSplit.length >= 4) { nameKeys.add(toSplit.substring(0, 2)); nameKeys.add(toSplit.substring(0, 3)); }
  }
  if (dong) {
    nameKeys.add(dong);
    for (const brand of BRANDS) { if (toSplit.includes(brand)) nameKeys.add(dong + brand); }
  }
  return { siteName, dong, nameKeys: [...nameKeys].filter(k => k && k.length >= 2), base, dangji, dongPrefix };
}

function matchBldName(bldNm, rule) {
  if (!bldNm) return false;
  const cleanBld = bldNm.replace(/아파트|마을|연립|빌라|주택|단지/g, "").trim();
  return rule.nameKeys.some(k => bldNm.includes(k) || (cleanBld.length >= 2 && k.includes(cleanBld)));
}
function matchDongPrefix(dongNm, rule) {
  if (!rule.dongPrefix) return true;
  if (!dongNm) return true;
  const m = dongNm.match(/(\d+)/);
  if (!m) return true;
  const n = m[1];
  return n.length === 1 ? n === rule.dongPrefix : n[0] === rule.dongPrefix;
}
function isAuxBuilding(dongNm) {
  if (!dongNm) return false;
  return /상가|관리|근생|지하|주차|복지|경로|어린이|노인|커뮤니티|보일러|경비/.test(dongNm);
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

// SHP에서 단지에 해당하는 건물 PNU 수집
function findBuildingPNUs(buildings, rule, centerLat, centerLng) {
  const matched = [];
  for (const b of buildings) {
    const d = Math.sqrt((b.cx - centerLng) ** 2 + (b.cy - centerLat) ** 2);
    if (d > 0.006) continue;
    if (!matchBldName(b.name, rule)) continue;
    if (!matchDongPrefix(b.dongNm, rule)) continue;
    matched.push(b);
  }
  // PNU 그룹별 점수 → 최적 PNU 클러스터 선택
  const pnuCount = {};
  matched.forEach(b => { if (b.pnu) pnuCount[b.pnu] = (pnuCount[b.pnu] || 0) + 1; });
  const bestPNUs = Object.entries(pnuCount)
    .filter(([, cnt]) => cnt >= 1)
    .sort((a, b) => b[1] - a[1]);

  if (bestPNUs.length === 0 && matched.length === 0) {
    // 키워드 매칭 실패 시 근접 PNU 클러스터
    const nearby = buildings
      .filter(b => Math.sqrt((b.cx - centerLng) ** 2 + (b.cy - centerLat) ** 2) < 0.003 && !isAuxBuilding(b.dongNm));
    const nc = {};
    nearby.forEach(b => { if (b.pnu) nc[b.pnu] = (nc[b.pnu] || 0) + 1; });
    const top = Object.entries(nc).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
    if (top.length > 0) return { pnus: new Set([top[0][0]]), buildings: nearby.filter(b => b.pnu === top[0][0]) };
    return { pnus: new Set(), buildings: [] };
  }

  // 최적 그룹 + 근접 PNU 그룹
  const topPnu = bestPNUs[0]?.[0];
  const topBuildings = matched.filter(b => b.pnu === topPnu);
  const avgX = topBuildings.reduce((s, b) => s + b.cx, 0) / topBuildings.length;
  const avgY = topBuildings.reduce((s, b) => s + b.cy, 0) / topBuildings.length;

  const nearPNUs = new Set([topPnu]);
  for (const [pnu] of bestPNUs.slice(1)) {
    const pBuilds = matched.filter(b => b.pnu === pnu);
    const px = pBuilds.reduce((s, b) => s + b.cx, 0) / pBuilds.length;
    const py = pBuilds.reduce((s, b) => s + b.cy, 0) / pBuilds.length;
    if (Math.sqrt((px - avgX) ** 2 + (py - avgY) ** 2) < 0.003) nearPNUs.add(pnu);
  }

  return { pnus: nearPNUs, buildings: matched.filter(b => nearPNUs.has(b.pnu)) };
}

// ── 카카오 좌표 검색 ──

async function kakaoFindApt(siteName, address) {
  if (!KAKAO_KEY) return null;
  let anchorX, anchorY;
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`, { headers: kHeaders });
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
      const r = await fetch(url, { headers: kHeaders });
      const d = await r.json();
      for (const doc of d.documents || []) {
        const addr = (doc.road_address_name || doc.address_name || "");
        const regionOK = address.split(/\s+/).slice(0, 2).every(p => addr.includes(p));
        if (!regionOK) continue;
        if (!/아파트|주거|부동산/.test(doc.category_name || "")) continue;
        await delay(60);
        return { lat: +doc.y, lng: +doc.x };
      }
    } catch {}
    await delay(60);
  }
  return null;
}

// ── VWORLD 지적도 필지 경계 조회 ──

async function fetchCadastralParcels(lat, lng, radiusDeg = 0.003) {
  const bbox = [lng - radiusDeg, lat - radiusDeg, lng + radiusDeg, lat + radiusDeg].join(",");
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key = nextVwKey();
    const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${key}&format=json&size=100&geomFilter=BOX(${bbox})&crs=EPSG:4326`;
    try {
      const res = await fetch(url);
      if (!res.ok) { await delay(500 * (attempt + 1)); continue; }
      const data = await res.json();
      const parcels = data.response?.result?.featureCollection?.features;
      if (parcels && parcels.length > 0) return parcels;
      // empty result — might be rate-limited, retry with different key
      if (attempt < maxRetries - 1) { await delay(600 * (attempt + 1)); continue; }
      return [];
    } catch (e) {
      if (attempt < maxRetries - 1) { await delay(600 * (attempt + 1)); continue; }
      console.log(`    VWORLD 오류: ${e.message}`);
      return [];
    }
  }
  return [];
}

// 필지들을 병합하여 사업지 경계 생성
function mergeParcels(parcels) {
  if (parcels.length === 0) return null;
  const allPts = [];
  for (const p of parcels) {
    const ring = p.geometry.coordinates[0]?.[0] || p.geometry.coordinates[0];
    if (ring) ring.forEach(c => allPts.push(c));
  }
  if (allPts.length < 3) return null;
  const hull = convexHull(allPts);
  if (!hull) return null;
  return hull;
}

// ── 메인 ──

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;
console.log(`\n=== 지적도 기반 사업지 실측경계 생성 ===`);
console.log(`총 ${features.length}개 단지\n`);

// SHP zip별 그룹핑
const byZip = {};
for (const f of features) {
  const zip = getShpZip(f.properties.address);
  const key = zip || "__noshp";
  (byZip[key] ||= []).push(f);
}

const tmpDir = "shp_cadastral";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

let upgraded = 0, kept = 0, noShp = 0;

for (const [zip, list] of Object.entries(byZip)) {
  // SHP 건물 로드 (PNU 식별용)
  let buildings = [];
  if (zip !== "__noshp") {
    console.log(`\n── ${zip} (${list.length}개) ──`);
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
    try { new AdmZip(zip).extractAllTo(tmpDir, true); } catch (e) { console.log(`  압축해제 실패: ${e.message}`); continue; }
    const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));
    const t0 = Date.now();
    for (const shp of shpFiles) {
      const src = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
      while (true) {
        const { done, value } = await src.read();
        if (done) break;
        const nm = value.properties.BLD_NM || "";
        if (!nm) continue;
        const geomCoords = value.geometry?.coordinates?.[0];
        if (!geomCoords) continue;
        const coords = geomCoords.map(c => toWGS84(c[0], c[1])).filter(Boolean);
        if (coords.length < 3) continue;
        const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
        const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
        buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, coords, cx, cy });
      }
    }
    console.log(`  ${buildings.length.toLocaleString()}개 건물 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } else {
    console.log(`\n── SHP 없음 (${list.length}개) ──`);
  }

  for (const site of list) {
    const p = site.properties;
    const rule = parseRule(p.name);

    // 1. 카카오 중심좌표
    let centerLat, centerLng;
    const kres = await kakaoFindApt(p.name, p.address);
    if (kres) { centerLat = kres.lat; centerLng = kres.lng; }
    else {
      const existCoords = site.geometry.type === "MultiPolygon" ? site.geometry.coordinates[0][0] : site.geometry.coordinates[0];
      const [cx, cy] = polyCenter(existCoords);
      centerLat = cy; centerLng = cx;
    }

    // 2. SHP에서 PNU 식별
    const { pnus, buildings: matchedBlds } = zip !== "__noshp"
      ? findBuildingPNUs(buildings, rule, centerLat, centerLng)
      : { pnus: new Set(), buildings: [] };

    // 3. VWORLD 지적도 조회 (넓은 범위)
    await delay(300);
    const parcels = await fetchCadastralParcels(centerLat, centerLng, 0.004);
    await delay(300);

    if (parcels.length === 0) {
      // VWORLD 실패 → SHP 건물 convex hull 폴백
      if (matchedBlds.length >= 2) {
        const pts = matchedBlds.flatMap(b => b.coords);
        const hull = convexHull(pts);
        if (hull && areaM2(hull) >= 300) {
          site.geometry = { type: "Polygon", coordinates: [hull] };
          p.boundarySource = "shp-hull";
          upgraded++;
          console.log(`  ✓ ${p.name}: SHP hull (VWORLD실패) ${Math.round(areaM2(hull)).toLocaleString()}m²`);
          continue;
        }
      }
      console.log(`  - ${p.name}: VWORLD+SHP 실패 → 유지`);
      p.boundarySource = "original";
      kept++;
      continue;
    }

    // 4. PNU 매칭으로 해당 단지 필지 선택
    let selectedParcels = [];

    if (pnus.size > 0) {
      // SHP PNU와 VWORLD 필지 PNU 매칭
      selectedParcels = parcels.filter(f => {
        const parcelPnu = f.properties.pnu || f.properties.PNU || "";
        return pnus.has(parcelPnu);
      });
    }

    // PNU 매칭 안되면 → 중심점 포함 필지 + 같은 본번 병합
    if (selectedParcels.length === 0) {
      const meta = parcels.map(f => {
        const ring = f.geometry.coordinates[0]?.[0] || f.geometry.coordinates[0] || [];
        const area = ring.length >= 3 ? areaM2(ring) : 0;
        const contains = ring.length >= 3 ? pip([centerLng, centerLat], ring) : false;
        return { f, ring, area, contains, bonbun: f.properties.bonbun, addr: f.properties.addr, jibun: f.properties.jibun };
      });

      // 중심점 포함 필지
      const containing = meta.filter(m => m.contains);
      if (containing.length > 0) {
        const best = containing.sort((a, b) => b.area - a.area)[0];
        // 같은 본번 + 주거("대") 필지 병합
        const sameBonbun = meta.filter(m =>
          m.bonbun === best.bonbun &&
          (m.jibun || "").includes("대") &&
          (m.addr || "").split(" ").slice(0, 3).join(" ") === (best.addr || "").split(" ").slice(0, 3).join(" ")
        );
        selectedParcels = (sameBonbun.length > 1 ? sameBonbun : [best]).map(m => m.f);
      } else {
        // 가장 가까운 주거 필지
        const h = p.households || 300;
        const resParcels = meta
          .filter(m => (m.jibun || "").includes("대") && m.area >= h * 3 && m.area <= h * 200)
          .sort((a, b) => {
            const ca = polyCenter(a.ring), cb = polyCenter(b.ring);
            const da = Math.sqrt((ca[0] - centerLng) ** 2 + (ca[1] - centerLat) ** 2);
            const db = Math.sqrt((cb[0] - centerLng) ** 2 + (cb[1] - centerLat) ** 2);
            return da - db;
          });
        if (resParcels.length > 0) {
          const best = resParcels[0];
          const sameBonbun = meta.filter(m =>
            m.bonbun === best.bonbun && (m.jibun || "").includes("대")
          );
          selectedParcels = (sameBonbun.length > 1 ? sameBonbun : [best]).map(m => m.f);
        }
      }
    }

    // 5. 필지 경계 병합
    if (selectedParcels.length > 0) {
      const hull = mergeParcels(selectedParcels);
      if (hull) {
        const area = areaM2(hull);
        if (area >= 300 && area <= 500000) {
          site.geometry = { type: "Polygon", coordinates: [hull] };
          p.boundarySource = pnus.size > 0 ? "cadastral-pnu" : "cadastral-pip";
          upgraded++;
          const tag = pnus.size > 0 ? "[PNU]" : "[지적]";
          console.log(`  ✓ ${p.name}: ${selectedParcels.length}필지 ${tag} ${Math.round(area).toLocaleString()}m² ${kres ? "[K]" : ""}`);
          continue;
        }
      }
    }

    // 6. 최종 폴백: SHP 건물 convex hull
    if (matchedBlds.length >= 2) {
      const pts = matchedBlds.flatMap(b => b.coords);
      const hull = convexHull(pts);
      if (hull && areaM2(hull) >= 300) {
        site.geometry = { type: "Polygon", coordinates: [hull] };
        p.boundarySource = "shp-hull";
        upgraded++;
        console.log(`  ~ ${p.name}: SHP hull ${Math.round(areaM2(hull)).toLocaleString()}m²`);
        continue;
      }
    }

    console.log(`  - ${p.name}: 매칭 실패 → 유지`);
    p.boundarySource = "original";
    kept++;
  }

  // zip 단위 저장
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  [저장]`);
}

console.log(`\n${"=".repeat(40)}`);
console.log(`지적도 사업지 경계: ${upgraded}개`);
console.log(`유지: ${kept}개`);
console.log(`합계: ${upgraded + kept}개`);

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`완료.`);
