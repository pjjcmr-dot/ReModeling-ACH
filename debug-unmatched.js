/**
 * 미매칭 단지 디버그 - 주변 SHP 건물명 조사
 */
import "dotenv/config";
import { readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from "fs";
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
  try { const [lng, lat] = proj4("EPSG:5186", "EPSG:4326", [x, y]); return [lng, lat]; } catch { return null; }
}
function polyCenter(coords) {
  let cx = 0, cy = 0; const n = coords.length - 1 || 1;
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
}
function getShpZip(address) {
  if (address.includes("서울")) {
    const gu = address.split(/\s+/)[1];
    const gz = `F_FAC_BUILDING_서울_${gu}.zip`;
    if (existsSync(gz)) return gz;
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
  const queries = [siteName + " 아파트", rest + " 아파트", rest];
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
        return { lat: +doc.y, lng: +doc.x };
      }
    } catch {}
    await delay(60);
  }
  return null;
}

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// Polygon만 (미매칭 대상)
const unmatched = sites.features.filter(f => f.geometry.type === "Polygon");
console.log(`미매칭 Polygon: ${unmatched.length}개\n`);

const byZip = {};
for (const f of unmatched) {
  const zip = getShpZip(f.properties.address);
  const key = zip || "__noshp";
  (byZip[key] ||= []).push(f);
}

const tmpDir = "shp_debug";
if (!existsSync(tmpDir)) mkdirSync(tmpDir);

for (const [zip, list] of Object.entries(byZip)) {
  if (zip === "__noshp") continue;

  // SHP 로드
  readdirSync(tmpDir).filter(f => /\.(shp|shx|dbf|prj|cpg|fix)$/.test(f)).forEach(f => {
    try { unlinkSync(join(tmpDir, f)); } catch {}
  });
  try { new AdmZip(zip).extractAllTo(tmpDir, true); } catch { continue; }
  const shpFiles = readdirSync(tmpDir).filter(f => f.endsWith(".shp"));

  const buildings = [];
  for (const shp of shpFiles) {
    const src = await shapefile.open(`${tmpDir}/${shp}`, undefined, { encoding: "euc-kr" });
    while (true) {
      const { done, value } = await src.read();
      if (done) break;
      const nm = value.properties.BLD_NM || "";
      if (!nm) continue;
      const coords = (value.geometry?.coordinates?.[0] || []).map(c => toWGS84(c[0], c[1])).filter(Boolean);
      if (coords.length < 3) continue;
      const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      buildings.push({ name: nm, dongNm: value.properties.DONG_NM, pnu: value.properties.PNU, cx, cy, coords });
    }
  }

  for (const site of list) {
    const p = site.properties;
    // 좌표
    let cLat, cLng;
    const kres = await kakaoFindApt(p.name, p.address);
    if (kres) { cLat = kres.lat; cLng = kres.lng; }
    else {
      const [cx, cy] = polyCenter(site.geometry.coordinates[0]);
      cLat = cy; cLng = cx;
    }

    // 반경 0.004도(~400m) 이내 건물 수집
    const nearby = buildings
      .map(b => ({ ...b, dist: Math.sqrt((b.cx - cLng) ** 2 + (b.cy - cLat) ** 2) }))
      .filter(b => b.dist < 0.004)
      .sort((a, b) => a.dist - b.dist);

    // 건물명 빈도
    const nameCount = {};
    nearby.forEach(b => { nameCount[b.name] = (nameCount[b.name] || 0) + 1; });
    const topNames = Object.entries(nameCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

    console.log(`[${p.name}] (${p.address}) 근접건물 ${nearby.length}개`);
    console.log(`  단지명 키워드: ${p.name.split(/\s+/).slice(1).join("")}`);
    topNames.forEach(([nm, cnt]) => console.log(`  BLD_NM: "${nm}" x${cnt}`));
    if (nearby.length > 0) {
      const closestPnu = nearby[0].pnu;
      const samePnu = nearby.filter(b => b.pnu === closestPnu);
      console.log(`  최근접 PNU: ${closestPnu} (${samePnu.length}건)`);
      // 가장 가까운 건물의 동명
      const dongNames = [...new Set(nearby.slice(0, 10).map(b => b.dongNm).filter(Boolean))];
      console.log(`  동명: ${dongNames.join(", ")}`);
    }
    console.log();
  }
}

try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
