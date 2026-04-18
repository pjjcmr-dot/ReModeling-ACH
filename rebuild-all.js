/**
 * 전체 단지 실측경계 정교화
 * - 모든 Polygon(convex hull) → MultiPolygon(건물 개별 윤곽)으로 업그레이드
 * - SHP 건물통합정보에서 개별 건물 footprint 추출
 * - 기존 MultiPolygon(4개)은 건물수 더 늘어나면 갱신
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

// ── 지오메트리 유틸 ──

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

function polyCenter(coords) {
  let cx = 0, cy = 0; const n = coords.length - 1 || 1;
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
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

// 원형 폴백 감지
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

// ── 단지명 파싱 (개선: 복합명 분할, 띄어쓰기 없는 이름 처리) ──

// 알려진 아파트 브랜드명 (2~4글자)
const BRANDS = [
  "현대", "우성", "삼성", "대림", "한신", "한양", "극동", "건영", "신동아", "쌍용",
  "롯데", "대우", "한진", "동아", "동부", "금호", "벽산", "풍림", "청구", "코오롱",
  "선경", "경남", "부영", "주공", "세경", "태영", "무학", "삼익", "아남", "중앙",
  "라이프", "신라", "한솔", "공무원", "시영", "GS", "SK",
];

function parseRule(siteName) {
  const parts = siteName.split(/\s+/).filter(Boolean);
  let dong, rest;

  if (parts.length >= 2) {
    dong = parts[0];
    rest = parts.slice(1).join("");
  } else {
    // 띄어쓰기 없는 이름: "행당대림", "목동우성1차" 등
    // 알려진 동명 패턴으로 분리 시도
    const full = parts[0];
    let splitIdx = 0;
    // 2~3글자 동명 시도
    for (const len of [3, 2]) {
      if (full.length > len) {
        const candidate = full.substring(0, len);
        // 동명은 보통 한글 2~3자
        if (/^[가-힣]{2,3}$/.test(candidate)) {
          splitIdx = len;
          break;
        }
      }
    }
    if (splitIdx > 0) {
      dong = full.substring(0, splitIdx);
      rest = full.substring(splitIdx);
    } else {
      dong = "";
      rest = full;
    }
  }

  let dangji = null, dongPrefix = null, base = rest;

  // "N차", "N단지" 패턴 제거
  const m = rest.match(/^(.+?)(\d+)(차|단지)?$/);
  if (m) {
    base = m[1];
    dangji = parseInt(m[2]);
    if (dangji >= 1 && dangji <= 9) dongPrefix = String(dangji);
  }

  // 키워드 생성: 전체명, base, 브랜드별 분할
  const nameKeys = new Set();
  if (rest && rest.length >= 2) nameKeys.add(rest);
  if (base && base.length >= 2) nameKeys.add(base);
  nameKeys.add(siteName.replace(/\s+/g, ""));
  if (dong && rest) nameKeys.add(dong + rest);

  // 복합 브랜드명 분할: "향촌롯데" → "향촌" + "롯데", "느티경남선경" → "느티" + "경남" + "선경"
  const toSplit = base || rest;
  if (toSplit && toSplit.length >= 4) {
    for (const brand of BRANDS) {
      const idx = toSplit.indexOf(brand);
      if (idx >= 0) {
        const before = toSplit.substring(0, idx);
        const after = toSplit.substring(idx + brand.length);
        if (before.length >= 2) nameKeys.add(before);
        nameKeys.add(brand);
        if (after.length >= 2) nameKeys.add(after);
      }
    }
    // 앞 2~3글자도 시도 (동이름+브랜드: "향촌" from "향촌롯데")
    if (toSplit.length >= 4) {
      nameKeys.add(toSplit.substring(0, 2));
      nameKeys.add(toSplit.substring(0, 3));
    }
  }

  // dong이 있으면 dong+brand 조합도 추가
  if (dong) {
    nameKeys.add(dong);
    for (const brand of BRANDS) {
      if (toSplit.includes(brand)) {
        nameKeys.add(dong + brand);
      }
    }
  }

  // 1글자 키워드 제거
  const keys = [...nameKeys].filter(k => k && k.length >= 2);

  return { siteName, dong, nameKeys: keys, base, dangji, dongPrefix };
}

function matchBldName(bldNm, rule) {
  if (!bldNm) return false;
  // 정방향: 키워드가 건물명에 포함
  // 역방향: 건물명 핵심부가 키워드에 포함
  const cleanBld = bldNm.replace(/아파트|마을|연립|빌라|주택|단지/g, "").trim();
  return rule.nameKeys.some(k =>
    bldNm.includes(k) || (cleanBld.length >= 2 && k.includes(cleanBld))
  );
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
  return /상가|관리|근생|지하|주차|복지|경로|어린이|노인|커뮤니티|보일러|경비/.test(dongNm);
}

// ── SHP 파일 매핑 ──

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

// ── 카카오 좌표 검색 ──

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
        const regionOK = address.split(/\s+/).slice(0, 2).every(p => addr.includes(p));
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

// ── 건물 매칭 ──

function collectCandidates(buildings, rule, centerLat, centerLng, maxDistDeg = 0.006) {
  const bKey = (b) => b.name + "@" + b.cx + "," + b.cy;

  // 1차: 키워드 + 거리 + DONG 접두사 매칭
  const matched = [];
  const matchedPNUs = new Set();
  const matchedIds = new Set();
  for (const b of buildings) {
    const d = Math.sqrt((b.cx - centerLng) ** 2 + (b.cy - centerLat) ** 2);
    if (d > maxDistDeg) continue;
    if (!matchBldName(b.name, rule)) continue;
    if (!matchDongPrefix(b.dongNm, rule)) continue;
    matched.push({ ...b, dist: d });
    matchedIds.add(bKey(b));
    if (b.pnu) matchedPNUs.add(b.pnu);
  }

  // 2차: 같은 PNU인 건물 — 이름 매칭 + DONG 필터
  if (matchedPNUs.size > 0) {
    for (const b of buildings) {
      if (!b.pnu || !matchedPNUs.has(b.pnu)) continue;
      if (matchedIds.has(bKey(b))) continue;
      if (!matchBldName(b.name, rule)) continue;
      if (!matchDongPrefix(b.dongNm, rule)) continue;
      matched.push({ ...b, dist: Math.sqrt((b.cx - centerLng) ** 2 + (b.cy - centerLat) ** 2) });
      matchedIds.add(bKey(b));
    }
  }

  // 3차: 같은 PNU + 이름 무관 + 매우 근접 + 비부속 (같은 필지 내 주거동)
  // 단, 1차 매칭이 적을 때만 확장 (많으면 이미 충분)
  if (matched.length > 0 && matched.length < 5 && matchedPNUs.size > 0) {
    for (const b of buildings) {
      if (!b.pnu || !matchedPNUs.has(b.pnu)) continue;
      if (matchedIds.has(bKey(b))) continue;
      if (isAuxBuilding(b.dongNm)) continue;
      // 매칭된 건물 중심에서 가까운 것만
      const avgX = matched.reduce((s, m) => s + m.cx, 0) / matched.length;
      const avgY = matched.reduce((s, m) => s + m.cy, 0) / matched.length;
      const d = Math.sqrt((b.cx - avgX) ** 2 + (b.cy - avgY) ** 2);
      if (d < 0.002) {
        matched.push({ ...b, dist: d });
        matchedIds.add(bKey(b));
      }
    }
  }

  // 4차: 키워드 매칭 실패 시 — 최근접 PNU 클러스터 사용
  if (matched.length === 0) {
    // 중심좌표 근방 건물들의 PNU별 그룹
    const nearby = buildings
      .map(b => ({ ...b, dist: Math.sqrt((b.cx - centerLng) ** 2 + (b.cy - centerLat) ** 2) }))
      .filter(b => b.dist < 0.003 && !isAuxBuilding(b.dongNm));
    if (nearby.length >= 2) {
      // PNU별 그룹 중 가장 건물 많은 그룹
      const pnuGroups = {};
      nearby.forEach(b => { if (b.pnu) (pnuGroups[b.pnu] ||= []).push(b); });
      const bestPnu = Object.entries(pnuGroups)
        .filter(([, list]) => list.length >= 2)
        .sort((a, b) => b[1].length - a[1].length)[0];
      if (bestPnu) {
        bestPnu[1].forEach(b => {
          matched.push(b);
          matchedIds.add(bKey(b));
        });
      }
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
    const cx = list.reduce((s, b) => s + b.cx, 0) / list.length;
    const cy = list.reduce((s, b) => s + b.cy, 0) / list.length;
    const d = Math.sqrt((cx - centerLng) ** 2 + (cy - centerLat) ** 2);
    return { pnu, list, cx, cy, dist: d, score: list.length - d * 1000 };
  });
  groupArr.sort((a, b) => b.score - a.score);
  const best = groupArr[0];
  // 최적 그룹 근방 0.002도(~200m) 이내 그룹도 병합
  const nearBest = groupArr.filter(g => {
    const d = Math.sqrt((g.cx - best.cx) ** 2 + (g.cy - best.cy) ** 2);
    return d < 0.002;
  });
  return nearBest.flatMap(g => g.list);
}

// ── 경계 생성 ──

function buildMultiPolygon(buildings) {
  const main = buildings.filter(b => !isAuxBuilding(b.dongNm));
  const src = main.length >= 2 ? main : buildings;
  return src.map(b => {
    const ring = [...b.coords];
    if (ring.length > 0) {
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
    }
    return [ring];
  });
}

function buildConvexHull(buildings) {
  const main = buildings.filter(b => !isAuxBuilding(b.dongNm));
  const src = main.length >= 2 ? main : buildings;
  const pts = src.flatMap(b => b.coords);
  return convexHull(pts);
}

// ── 메인 ──

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;

console.log(`\n=== 전체 단지 실측경계 정교화 ===`);
console.log(`총 ${features.length}개 단지\n`);

// SHP zip별 그룹핑
const byZip = {};
for (const f of features) {
  const zip = getShpZip(f.properties.address);
  const key = zip || "__noshp";
  (byZip[key] ||= []).push(f);
}
for (const [k, v] of Object.entries(byZip)) {
  console.log(`${k}: ${v.length}개`);
}

const tmpDir = "shp_rebuild_all";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

let upgraded = 0, improved = 0, kept = 0, noShp = 0;
const results = { multi: [], hull: [], circle: [], failed: [] };

for (const [zip, list] of Object.entries(byZip)) {
  if (zip === "__noshp") {
    noShp += list.length;
    list.forEach(f => results.failed.push(`${f.properties.name} (SHP 없음)`));
    console.log(`\n── SHP 없음: ${list.length}개 스킵 ──`);
    continue;
  }

  console.log(`\n── ${zip} (${list.length}개 단지) ──`);

  // SHP 압축 해제
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => {
    try { unlinkSync(join(tmpDir, f)); } catch {}
  });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); }
  catch (e) { console.log(`  압축해제 실패: ${e.message}`); continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  // 건물 로드
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
      const geomCoords = value.geometry?.coordinates?.[0];
      if (!geomCoords) continue;
      const coords = geomCoords.map(c => toWGS84(c[0], c[1])).filter(Boolean);
      if (coords.length < 3) continue;
      const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      buildings.push({
        name: nm,
        dongNm: value.properties.DONG_NM,
        pnu: value.properties.PNU,
        coords, cx, cy
      });
    }
  }
  console.log(`  ${buildings.length.toLocaleString()}개 건물 로드 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 각 단지 처리
  for (const site of list) {
    const p = site.properties;
    const rule = parseRule(p.name);

    // 기존 경계 정보
    const isMulti = site.geometry.type === "MultiPolygon";
    const existingRings = isMulti ? site.geometry.coordinates.length : 1;
    const existingCoords = isMulti ? site.geometry.coordinates[0][0] : site.geometry.coordinates[0];
    const oldArea = areaM2(existingCoords);
    const wasCircle = !isMulti && isCircleFallback(site.geometry.coordinates[0]);

    // 카카오로 정확 좌표 확보
    let centerLat, centerLng, usedKakao = false;
    const kres = await kakaoFindApt(p.name, p.address);
    if (kres) {
      centerLat = kres.lat; centerLng = kres.lng; usedKakao = true;
    } else {
      const [cx, cy] = polyCenter(existingCoords);
      centerLat = cy; centerLng = cx;
    }

    // 건물 매칭
    const matched = collectCandidates(buildings, rule, centerLat, centerLng);
    const best = pickBestDangjiGroup(matched, centerLat, centerLng);

    // ── 결과 적용 ──

    if (best.length >= 2) {
      const multi = buildMultiPolygon(best);
      if (multi && multi.length >= 2) {
        const totalArea = multi.reduce((s, poly) => s + areaM2(poly[0]), 0);

        // 안전장치: 비상식적 면적 거부
        if (totalArea < 300 || totalArea > 300000) {
          console.log(`  ! ${p.name}: 면적 ${Math.round(totalArea).toLocaleString()}m² 비정상 → 유지`);
          kept++;
          results.failed.push(`${p.name} (면적 비정상: ${Math.round(totalArea)}m²)`);
          continue;
        }

        // 기존 MultiPolygon보다 건물수 늘었으면 갱신, 아니면 유지
        if (isMulti && multi.length <= existingRings) {
          console.log(`  = ${p.name}: 기존 ${existingRings}동 ≥ 신규 ${multi.length}동 → 유지`);
          kept++;
          continue;
        }

        site.geometry = { type: "MultiPolygon", coordinates: multi };
        if (isMulti) {
          improved++;
          console.log(`  ↑ ${p.name}: ${existingRings}동→${multi.length}동 (${Math.round(totalArea).toLocaleString()}m²)${usedKakao ? " [K]" : ""}`);
        } else {
          upgraded++;
          const tag = wasCircle ? "[원형→건물]" : "[hull→건물]";
          console.log(`  ✓ ${p.name}: ${multi.length}동 개별 (${Math.round(totalArea).toLocaleString()}m²) ${tag}${usedKakao ? " [K]" : ""}`);
        }
        results.multi.push(`${p.name}: ${multi.length}동`);
        continue;
      }
    }

    // 단일 건물 + PNU 확장 시도
    if (best.length === 1) {
      const b0 = best[0];
      const samePnu = buildings.filter(b =>
        b.pnu && b.pnu === b0.pnu &&
        Math.sqrt((b.cx - b0.cx) ** 2 + (b.cy - b0.cy) ** 2) < 0.0015 &&
        !isAuxBuilding(b.dongNm)
      );
      if (samePnu.length >= 2) {
        const filtered = rule.dongPrefix ? samePnu.filter(b => matchDongPrefix(b.dongNm, rule)) : samePnu;
        const useList = filtered.length >= 2 ? filtered : samePnu;
        const multi = buildMultiPolygon(useList);
        if (multi && multi.length >= 2) {
          const totalArea = multi.reduce((s, poly) => s + areaM2(poly[0]), 0);
          if (totalArea >= 300 && totalArea <= 300000) {
            site.geometry = { type: "MultiPolygon", coordinates: multi };
            upgraded++;
            console.log(`  ✓ ${p.name}: PNU확장 ${useList.length}동 (${Math.round(totalArea).toLocaleString()}m²)${usedKakao ? " [K]" : ""}`);
            results.multi.push(`${p.name}: PNU ${useList.length}동`);
            continue;
          }
        }
      }

      // 단일 건물이라도 기존 원형폴백보다는 나음
      if (wasCircle) {
        const ring = [...b0.coords];
        const first = ring[0], last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
        site.geometry = { type: "Polygon", coordinates: [ring] };
        upgraded++;
        console.log(`  ~ ${p.name}: 원형→단일건물`);
        results.hull.push(`${p.name}: 단일건물`);
        continue;
      }
    }

    // convex hull 경계가 너무 큰 경우 축소 시도
    if (!isMulti && best.length >= 1) {
      const hull = buildConvexHull(best);
      if (hull) {
        const hullArea = areaM2(hull);
        if (hullArea < oldArea * 0.8 && hullArea >= 300) {
          site.geometry = { type: "Polygon", coordinates: [hull] };
          improved++;
          console.log(`  ▽ ${p.name}: hull 축소 ${Math.round(oldArea).toLocaleString()}→${Math.round(hullArea).toLocaleString()}m²`);
          results.hull.push(`${p.name}: hull 축소`);
          continue;
        }
      }
    }

    // 변경 없음
    const label = wasCircle ? "(원형폴백)" : isMulti ? `(${existingRings}동)` : `(${existingCoords.length}점)`;
    console.log(`  - ${p.name}: 매칭 부족 ${label} → 유지`);
    kept++;
    if (wasCircle) results.circle.push(p.name);
    else results.failed.push(`${p.name} (매칭 부족)`);
  }

  // zip 단위로 중간 저장
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  [저장 완료]`);
}

// ── 최종 결과 ──
console.log(`\n${"=".repeat(50)}`);
console.log(`전체 단지 실측경계 정교화 결과`);
console.log(`${"=".repeat(50)}`);
console.log(`건물개별 업그레이드: ${upgraded}개`);
console.log(`기존 경계 개선:     ${improved}개`);
console.log(`변경 없음:          ${kept}개`);
console.log(`SHP 없음:           ${noShp}개`);
console.log(`합계:               ${upgraded + improved + kept + noShp}개`);

if (results.multi.length) {
  console.log(`\n[건물개별 MultiPolygon]`);
  results.multi.forEach(s => console.log(`  ${s}`));
}
if (results.hull.length) {
  console.log(`\n[Hull/단일건물]`);
  results.hull.forEach(s => console.log(`  ${s}`));
}
if (results.circle.length) {
  console.log(`\n[원형폴백 유지]`);
  results.circle.forEach(s => console.log(`  ${s}`));
}
if (results.failed.length) {
  console.log(`\n[미처리]`);
  results.failed.forEach(s => console.log(`  ${s}`));
}

// 정리
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log(`\n완료.`);
