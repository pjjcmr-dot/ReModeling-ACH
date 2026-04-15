/**
 * 사용자 지적 + 리서치로 확인된 잘못된 위치 정정
 * 1. 문정 신동아5차: 실존 단지 아님 → 제거
 * 2. 도곡 극동2차: 송파구 쪽 문제 확인 중 → 제거 (재확인 필요)
 * 3. 리버힐삼성: 산천동 193 → 37.5358, 126.9588
 * 4. 신정쌍용: 신정동 334, 신목로 9 → 37.5303, 126.8720
 * 5. 목동우성1차: 목동 200 (법정동 목동) → 37.5364, 126.8715
 * 6. 강변현대: 실제는 현대강변 (자양동 673) → 37.5368, 127.0720
 * 7. 응봉대림1차: 응봉동 100 → 37.5489, 127.0327
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

// ── 삭제할 단지 (실존하지 않음 확인) ──
const REMOVE_NAMES = [
  "문정 신동아5차",  // 1994/326세대 신동아 단지가 문정동에 없음
  "도곡 극동2차",    // 도곡동에 극동2차 단지가 없음 (극동스타클래스만 존재)
];

// ── 정확한 좌표/주소로 업데이트 ──
const UPDATES = [
  {
    name: "리버힐삼성",
    address: "서울 용산구 산천동",
    jibun: "서울 용산구 산천동 193",
    lat: 37.5358, lng: 126.9588,
    keywords: ["리버힐삼성","리버힐","산천 삼성"]
  },
  {
    name: "신정쌍용",
    address: "서울 양천구 신정동",
    jibun: "서울 양천구 신목로 9",
    lat: 37.5303, lng: 126.8720,
    keywords: ["신정쌍용","신정 쌍용","쌍용","신목쌍용"]
  },
  {
    name: "목동우성1차",
    address: "서울 양천구 목동",
    jibun: "서울 양천구 목동 200",
    lat: 37.5364, lng: 126.8715,
    keywords: ["목동우성1","목동1차우성","우성1","우성 1"]
  },
  {
    name: "강변현대",
    address: "서울 광진구 자양동",
    jibun: "서울 광진구 자양동 673",
    lat: 37.5368, lng: 127.0720,
    keywords: ["현대강변","강변현대","자양 현대"]
  },
  {
    name: "응봉대림1차",
    address: "서울 성동구 응봉동",
    jibun: "서울 성동구 독서당로62길 43",
    lat: 37.5489, lng: 127.0327,
    keywords: ["응봉대림1","응봉 대림1","응봉대림","대림1"]
  },
];

// ── 유틸 ──
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
function circleBoundary(lat,lng,rM=50) {
  const coords=[]; const n=24; const r=Math.PI/180;
  for (let i=0;i<n;i++) {
    const ang=(i/n)*2*Math.PI;
    const dlat=(rM*Math.cos(ang))/110540;
    const dlng=(rM*Math.sin(ang))/(111320*Math.cos(lat*r));
    coords.push([Math.round((lng+dlng)*1e13)/1e13, Math.round((lat+dlat)*1e13)/1e13]);
  }
  coords.push(coords[0]);
  return coords;
}

function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(" ")[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
  }
  return null;
}

async function findBuildings(shpPath, keywords, centerLat, centerLng) {
  const source = await shapefile.open(shpPath, undefined, { encoding: "euc-kr" });
  const matched=[], nearby=[];
  while (true) {
    const {done,value} = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;
    const cx = wgs.reduce((s,c)=>s+c[0],0)/wgs.length;
    const cy = wgs.reduce((s,c)=>s+c[1],0)/wgs.length;
    const d = Math.sqrt((cx-centerLng)**2+(cy-centerLat)**2);
    if (keywords.some(k => nm.includes(k)) && d < 0.002) {
      matched.push({pts: wgs, name: nm, dist: d});
    } else if (d < 0.0012) {
      const a = areaM2(wgs);
      if (a > 300 && wgs.length >= 6) nearby.push({pts: wgs, name: nm, dist: d, area: a});
    }
  }
  return {matched, nearby};
}

async function kakaoRefine(item) {
  try {
    const r = await fetch(`https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(item.jibun)}`, { headers });
    const d = await r.json();
    if (d.documents?.[0]) {
      return { lat: +d.documents[0].y, lng: +d.documents[0].x, source: "jibun" };
    }
  } catch {}
  return { lat: item.lat, lng: item.lng, source: "estimate" };
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// 1) 제거
const beforeCount = sites.features.length;
sites.features = sites.features.filter(f => !REMOVE_NAMES.includes(f.properties.name));
console.log(`제거: ${beforeCount - sites.features.length}개 (${REMOVE_NAMES.join(", ")})`);

// 2) 업데이트
const tmpDir = "shp_wrong_fix";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

const groups = {};
for (const u of UPDATES) {
  const f = sites.features.find(x => x.properties.name === u.name);
  if (!f) { console.log(`  skip: ${u.name} 사이트 없음`); continue; }
  const zip = getShpZip(u.address);
  if (!groups[zip || "__nogshp"]) groups[zip || "__nogshp"] = [];
  groups[zip || "__nogshp"].push({ site: f, update: u });
}

for (const [zip, list] of Object.entries(groups)) {
  console.log(`\n── ${zip} (${list.length}개) ──`);
  let shpFiles = [];
  if (zip !== "__nogshp") {
    readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => {
      try { unlinkSync(join(tmpDir, f)); } catch {}
    });
    try { new AdmZip(zip).extractAllTo(tmpDir, true); shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp")); }
    catch (e) { console.log(`  압축해제 실패: ${e.message}`); }
  }

  for (const { site, update } of list) {
    const refined = await kakaoRefine(update);
    await delay(100);
    let boundary=null, info="";

    for (const shp of shpFiles) {
      const {matched, nearby} = await findBuildings(`${tmpDir}/${shp}`, update.keywords, refined.lat, refined.lng);
      if (matched.length >= 2) {
        const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        const h = convexHull(allPts);
        if (h) { boundary=h; info=`SHP키워드 ${matched.length}동`; break; }
      } else if (matched.length === 1 && nearby.length >= 2) {
        const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        nearby.slice(0,4).forEach(n => n.pts.forEach(p => allPts.push(p)));
        const h = convexHull(allPts);
        if (h) { boundary=h; info=`SHP키워드1+주변${Math.min(nearby.length,4)}동`; break; }
      }
    }
    if (!boundary) {
      boundary = circleBoundary(refined.lat, refined.lng, 55);
      info = `원형경계 55m (${refined.source})`;
    }
    const a = areaM2(boundary);
    console.log(`  ${update.name}: ${info} (${Math.round(a)}㎡) @ ${refined.lat.toFixed(5)},${refined.lng.toFixed(5)} [${refined.source}]`);
    site.geometry.coordinates = [boundary];
    site.properties.address = update.address;
  }
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  → 저장 완료`);
}

console.log(`\n── 완료 ── 최종 사이트 수: ${sites.features.length}개`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
