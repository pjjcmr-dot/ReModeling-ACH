/**
 * 이매촌 6단지 청구 정확 좌표 + SHP 매칭
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

const TARGET = {
  name: "분당 이매촌6 청구",
  lat: 37.3924,
  lng: 127.1270,
  keywords: ["이매촌6","이매촌 6","청구 6","이매 청구","이매촌청구"],
};

const tmpDir = "shp_imae";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

const zip = "F_FAC_BUILDING_경기.zip";
readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg)$/.test(f)).forEach(f => { try { unlinkSync(join(tmpDir, f)); } catch {} });
new AdmZip(zip).extractAllTo(tmpDir, true);
const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

console.log(`SHP 파일 ${shpFiles.length}개 검색...`);

let bestBoundary = null;
let bestInfo = "";

for (const shp of shpFiles) {
  const source = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
  const matched=[], nearby=[];
  while (true) {
    const {done,value} = await source.read();
    if (done) break;
    const nm = value.properties.BLD_NM || "";
    const wgs = (value.geometry.coordinates[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
    if (wgs.length < 3) continue;
    const cx = wgs.reduce((s,c)=>s+c[0],0)/wgs.length;
    const cy = wgs.reduce((s,c)=>s+c[1],0)/wgs.length;
    const d = Math.sqrt((cx-TARGET.lng)**2+(cy-TARGET.lat)**2);
    // 200m 이내 + 키워드 매칭
    if (TARGET.keywords.some(k => nm.includes(k)) && d < 0.002) {
      matched.push({pts: wgs, name: nm, dist: d});
    } else if (d < 0.0015) {
      const a = areaM2(wgs);
      if (a > 300 && wgs.length >= 6) nearby.push({pts: wgs, name: nm, dist: d, area: a});
    }
  }
  console.log(`  ${shp}: 키워드매칭 ${matched.length}개, 주변대형 ${nearby.length}개`);
  if (matched.length > 0) {
    console.log(`    매칭 BLD_NM:`, matched.map(m => m.name).slice(0, 10));
  }
  if (matched.length >= 2) {
    const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
    bestBoundary = convexHull(allPts);
    bestInfo = `SHP키워드 ${matched.length}동`;
    break;
  } else if (matched.length === 1 && nearby.length >= 3) {
    const allPts=[]; matched.forEach(m => m.pts.forEach(p => allPts.push(p)));
    nearby.slice(0, 5).forEach(n => n.pts.forEach(p => allPts.push(p)));
    bestBoundary = convexHull(allPts);
    bestInfo = `SHP키워드1+주변${Math.min(nearby.length, 5)}동`;
  } else if (nearby.length >= 5) {
    const allPts=[]; nearby.slice(0, 10).forEach(n => n.pts.forEach(p => allPts.push(p)));
    bestBoundary = convexHull(allPts);
    bestInfo = `SHP주변대형 ${Math.min(nearby.length, 10)}동`;
  }
}

if (!bestBoundary) {
  bestBoundary = circleBoundary(TARGET.lat, TARGET.lng, 55);
  bestInfo = "원형경계 55m";
}

const a = areaM2(bestBoundary);
console.log(`\n결과: ${bestInfo} (${Math.round(a)}㎡) @ ${TARGET.lat},${TARGET.lng}`);

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const f = sites.features.find(x => x.properties.name === TARGET.name);
if (f) {
  f.geometry.coordinates = [bestBoundary];
  writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
  console.log(`저장 완료: ${TARGET.name}`);
}

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
