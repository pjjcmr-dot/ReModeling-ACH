/**
 * 도곡 극동2차 + 문정 신동아5차 삭제 (실존 X)
 * → 사당 우극신 4개 단지 추가 (실제 리모델링 추진):
 *    1. 사당 우성2차
 *    2. 사당 우성3차
 *    3. 사당 극동
 *    4. 사당 신동아4차
 */
import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import shapefile from "shapefile";
import proj4 from "proj4";
import AdmZip from "adm-zip";

proj4.defs("EPSG:5186", "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs");

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
function circleBoundary(lat,lng,rM=55) {
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

// ── 삭제 대상 ──
const REMOVE = ["도곡 극동2차", "문정 신동아5차"];

// ── 추가 대상 (우극신 4개) ──
const NEW_SITES = [
  {
    name: "사당 우성2차",
    address: "서울 동작구 사당동",
    jibun: "서울 동작구 사당동 105",
    lat: 37.4873, lng: 126.9776,
    subtype: "세대수증가형",
    stage: "조합설립준비",
    households: 545,
    built_year: 1991,
    developer: "사당 우성2차 리모델링 추진위원회 (우극신 통합)",
    constructor: "포스코이앤씨 (2025.5 시공사 선정)",
    keywords: ["사당우성2","우성2단지","우성2차"],
    notes: "우극신(우성2·3차+극동+신동아4차) 통합 리모델링 사업장"
  },
  {
    name: "사당 우성3차",
    address: "서울 동작구 사당동",
    jibun: "서울 동작구 사당동 105",
    lat: 37.4900, lng: 126.9759,
    subtype: "세대수증가형",
    stage: "조합설립준비",
    households: 855,
    built_year: 1993,
    developer: "사당 우성3차 리모델링 추진위원회 (우극신 통합)",
    constructor: "포스코이앤씨 (2025.5 시공사 선정)",
    keywords: ["사당우성3","우성3단지","우성3차"],
    notes: "우극신(우성2·3차+극동+신동아4차) 통합 리모델링 사업장"
  },
  {
    name: "사당 극동",
    address: "서울 동작구 사당동",
    jibun: "서울 동작구 사당동 105",
    lat: 37.4915, lng: 126.9754,
    subtype: "세대수증가형",
    stage: "조합설립준비",
    households: 1988,
    built_year: 1993,
    developer: "사당 극동 리모델링 추진위원회 (우극신 통합)",
    constructor: "포스코이앤씨 (2025.5 시공사 선정)",
    keywords: ["극동","사당 극동","사당극동"],
    notes: "우극신(우성2·3차+극동+신동아4차) 통합 리모델링 사업장"
  },
  {
    name: "사당 신동아4차",
    address: "서울 동작구 사당동",
    jibun: "서울 동작구 사당동 105",
    lat: 37.4900, lng: 126.9780,
    subtype: "세대수증가형",
    stage: "조합설립준비",
    households: 912,
    built_year: 1993,
    developer: "사당 신동아4차 리모델링 추진위원회 (우극신 통합)",
    constructor: "포스코이앤씨 (2025.5 시공사 선정)",
    keywords: ["신동아4","신동아 4","사당 신동아4"],
    notes: "우극신(우성2·3차+극동+신동아4차) 통합 리모델링 사업장"
  },
];

// ── SHP 건물 찾기 ──
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
    if (keywords.some(k => nm.includes(k)) && d < 0.0025) {
      matched.push({pts: wgs, name: nm, dist: d});
    } else if (d < 0.0012) {
      const a = areaM2(wgs);
      if (a > 300 && wgs.length >= 6) nearby.push({pts: wgs, name: nm, dist: d, area: a});
    }
  }
  return {matched, nearby};
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// 1) 잘못된 사이트 삭제
const before = sites.features.length;
sites.features = sites.features.filter(f => !REMOVE.includes(f.properties.name));
console.log(`삭제: ${before - sites.features.length}개`);

// 2) SHP 준비
const tmpDir = "shp_sadang";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);
const zip = "F_FAC_BUILDING_서울_동작구.zip";
readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
new AdmZip(zip).extractAllTo(tmpDir, true);
const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

// 3) 다음 ID 계산
let nextId = 1;
sites.features.forEach(f => {
  const m = (f.properties.id || "").match(/RM(\d+)/);
  if (m) nextId = Math.max(nextId, parseInt(m[1]) + 1);
});

// 4) 각 신규 사이트 처리
for (const site of NEW_SITES) {
  let boundary = null;
  let info = "";

  for (const shp of shpFiles) {
    const {matched, nearby} = await findBuildings(`${tmpDir}/${shp}`, site.keywords, site.lat, site.lng);
    if (matched.length >= 2) {
      const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
      boundary = convexHull(allPts);
      info = `SHP키워드 ${matched.length}동`;
      break;
    } else if (matched.length === 1 && nearby.length >= 2) {
      const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
      nearby.slice(0,5).forEach(n => n.pts.forEach(p => allPts.push(p)));
      boundary = convexHull(allPts);
      info = `SHP키워드1+주변${Math.min(nearby.length,5)}동`;
      break;
    }
  }
  if (!boundary) {
    boundary = circleBoundary(site.lat, site.lng, 55);
    info = `원형경계 55m`;
  }

  const a = areaM2(boundary);
  const id = `RM${String(nextId++).padStart(3, "0")}`;
  console.log(`  + ${site.name}: ${info} (${Math.round(a)}㎡) @ ${site.lat},${site.lng}`);

  sites.features.push({
    type: "Feature",
    geometry: { type: "Polygon", coordinates: [boundary] },
    properties: {
      id, name: site.name, subtype: site.subtype, address: site.address,
      stage: site.stage, expected_completion: "",
      households: site.households, existing_households: site.households, added_households: 0, increase_rate: 0,
      area: "", built_year: site.built_year, max_floors: 0,
      developer: site.developer, constructor: site.constructor,
      price_per_pyeong: 0, price_change: 0, contribution: 0, sale_price: 0, sale_price_date: "-", premium: 0,
      legal: [
        { title: "근거법령", content: "주택법 제66조(리모델링의 허가)" },
        { title: "준공연도", content: `${site.built_year}년` },
        { title: "추진단계", content: site.stage },
        { title: "특이사항", content: site.notes },
      ],
    },
  });
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료. 총 ${sites.features.length}개 사이트.`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
