/**
 * 원형 폴백(25점 폴리곤)을 실측 SHP 건물 경계로 업그레이드
 * 강화된 키워드 매칭 + 주변 대형 건물 매칭
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
function isLikelyCircle(coords) {
  if (coords.length < 20 || coords.length > 30) return false;
  const [cx,cy] = polyCenter(coords);
  const dists = coords.slice(0,-1).map(c => Math.sqrt((c[0]-cx)**2+(c[1]-cy)**2));
  const avg = dists.reduce((a,b)=>a+b,0)/dists.length;
  const variance = dists.reduce((a,b)=>a+(b-avg)**2,0)/dists.length;
  return variance/avg < 0.01;
}

// 아파트명에서 검색 키워드 파생
function deriveKeywords(name) {
  const parts = name.split(" ").filter(Boolean);
  const keywords = new Set();
  // 전체 이름
  keywords.add(name);
  keywords.add(name.replace(/\s+/g, ""));
  // 각 파트
  parts.forEach(p => keywords.add(p));
  // 브랜드만 (첫 단어 제외)
  if (parts.length > 1) {
    const brand = parts.slice(1).join("");
    keywords.add(brand);
    keywords.add(parts.slice(1).join(" "));
    // 숫자 변형
    if (/\d+$/.test(brand)) {
      const num = brand.match(/(\d+)$/)[1];
      const base = brand.replace(/\d+$/, "");
      keywords.add(base + num + "차");
      keywords.add(base + num + "단지");
      keywords.add(base + " " + num + "단지");
      keywords.add(base + " " + num + "차");
    }
    if (/차$/.test(brand)) {
      keywords.add(brand.replace(/차$/, ""));
      keywords.add(brand.replace(/차$/, "단지"));
    }
    if (/단지$/.test(brand)) {
      keywords.add(brand.replace(/단지$/, ""));
      keywords.add(brand.replace(/단지$/, "차"));
    }
  }
  return [...keywords].filter(k => k.length >= 2);
}

function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(" ")[1];
    const f = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(f)) return f;
  }
  if (address.includes("성남") || address.includes("분당")) {
    if (existsSync("F_FAC_BUILDING_경기.zip")) return "F_FAC_BUILDING_경기.zip";
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
    // 키워드 매칭 (300m 이내)
    if (keywords.some(k => nm.includes(k)) && d < 0.003) {
      matched.push({pts: wgs, name: nm, dist: d, area: areaM2(wgs)});
    }
    // 주변 대형 건물 (100m 이내, 400㎡ 이상, 많은 점)
    else if (d < 0.001 && wgs.length >= 8) {
      const a = areaM2(wgs);
      if (a > 400) nearby.push({pts: wgs, name: nm, dist: d, area: a});
    }
  }
  return {matched, nearby};
}

// ── 메인 ──
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// 원형 폴백 사이트 찾기
const circleSites = sites.features.filter(f => isLikelyCircle(f.geometry.coordinates[0]));
console.log(`원형 폴백 사이트: ${circleSites.length}개`);

const tmpDir = "shp_upgrade";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

// SHP 그룹핑
const groups = {};
for (const f of circleSites) {
  const zip = getShpZip(f.properties.address);
  if (!zip) continue;
  if (!groups[zip]) groups[zip] = [];
  groups[zip].push(f);
}

let totalUpgraded = 0;

for (const [zip, list] of Object.entries(groups)) {
  console.log(`\n── ${zip} (${list.length}개) ──`);
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); } catch (e) { console.log(` 압축해제 실패: ${e.message}`); continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  for (const site of list) {
    const p = site.properties;
    // 기존 circle의 center를 좌표로 사용
    const [cx, cy] = polyCenter(site.geometry.coordinates[0]);
    const keywords = deriveKeywords(p.name);

    let bestBoundary = null;
    let bestInfo = "";

    for (const shp of shpFiles) {
      const {matched, nearby} = await findBuildings(`${tmpDir}/${shp}`, keywords, cy, cx);

      if (matched.length >= 2) {
        const allPts = []; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        bestBoundary = convexHull(allPts);
        bestInfo = `SHP키워드 ${matched.length}동`;
        break;
      } else if (matched.length === 1 && nearby.length >= 2) {
        const allPts = []; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
        nearby.slice(0, 5).forEach(n => n.pts.forEach(p => allPts.push(p)));
        bestBoundary = convexHull(allPts);
        bestInfo = `SHP키워드1+주변${Math.min(nearby.length, 5)}동`;
        break;
      } else if (nearby.length >= 4) {
        // 키워드 없이도 주변 대형 건물이 많으면 아파트 단지로 추정
        const sortedNearby = nearby.sort((a, b) => a.dist - b.dist).slice(0, 10);
        bestBoundary = convexHull(sortedNearby.flatMap(n => n.pts));
        bestInfo = `SHP주변대형 ${sortedNearby.length}동`;
        break;
      }
    }

    if (bestBoundary) {
      const a = areaM2(bestBoundary);
      console.log(`  ✓ ${p.name}: ${bestInfo} (${Math.round(a).toLocaleString()}㎡)`);
      site.geometry.coordinates = [bestBoundary];
      totalUpgraded++;
    } else {
      console.log(`  - ${p.name}: SHP 매칭 실패 (원형 유지)`);
    }
  }
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`  → 저장`);
}

console.log(`\n── 완료 ── 업그레이드: ${totalUpgraded}/${circleSites.length}개`);
try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
