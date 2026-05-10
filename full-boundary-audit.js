/**
 * Full boundary audit for all 169 sites.
 * For each site:
 *   1. Compute current polygon centroid
 *   2. Look up the apartment via Kakao keyword search → expected center
 *   3. Distance between polygon centroid and Kakao center
 *   4. Flag if > 200m (likely wrong polygon)
 * Outputs a report .claude/boundary-audit.json. Does NOT modify sites.json.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function polygonCentroid(coords) {
  let cx = 0, cy = 0, n = coords.length - 1; // last == first
  for (let i = 0; i < n; i++) { cx += coords[i][0]; cy += coords[i][1]; }
  return [cx / n, cy / n];
}
function dist_m(p1, p2) {
  const r = Math.PI / 180;
  const dlat = (p2[1] - p1[1]) * 110540;
  const dlng = (p2[0] - p1[0]) * 111320 * Math.cos(((p1[1] + p2[1]) / 2) * r);
  return Math.sqrt(dlat*dlat + dlng*dlng);
}
function areaM2(coords) {
  let a = 0; const r = Math.PI / 180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const x1 = coords[i][0]*111320*Math.cos(coords[i][1]*r), y1 = coords[i][1]*110540;
    const x2 = coords[j][0]*111320*Math.cos(coords[j][1]*r), y2 = coords[j][1]*110540;
    a += x1*y2 - x2*y1;
  }
  return Math.abs(a)/2;
}

async function kakaoCenter(name, address) {
  const dong = address.split(" ").pop();
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  // Strategy 1: name + 아파트
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleaned + " 아파트")}&size=15`,
      { headers }
    );
    const d = await r.json();
    for (const x of d.documents || []) {
      if (x.address_name?.includes(dong) && x.category_name?.includes("아파트") &&
          !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)) {
        return { lat: +x.y, lng: +x.x, place: x.place_name };
      }
    }
    for (const x of d.documents || []) {
      if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
        return { lat: +x.y, lng: +x.x, place: x.place_name };
      }
    }
  } catch {}
  // Strategy 2: name only
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(cleaned)}&size=15`,
      { headers }
    );
    const d = await r.json();
    for (const x of d.documents || []) {
      if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
        return { lat: +x.y, lng: +x.x, place: x.place_name };
      }
    }
  } catch {}
  return null;
}

const results = [];
let i = 0;
for (const f of sites.features) {
  i++;
  const p = f.properties;
  const centroid = polygonCentroid(f.geometry.coordinates[0]);
  const area = Math.round(areaM2(f.geometry.coordinates[0]));
  const perHH = p.households ? Math.round(area / p.households) : 0;

  const kakao = await kakaoCenter(p.name, p.address);
  await delay(110);
  if (!kakao) {
    results.push({ id: p.id, name: p.name, kakao: null, centroidM_off: null, area, perHH, source: p.boundarySource, status: "kakao-fail" });
    process.stdout.write(`[${i}/${sites.features.length}] ${p.id} ${p.name.padEnd(30)} ✗ kakao\n`);
    continue;
  }
  const off = Math.round(dist_m(centroid, [kakao.lng, kakao.lat]));
  let status;
  if (off < 100) status = "OK";
  else if (off < 250) status = "near";
  else if (off < 600) status = "far";
  else status = "way-off";

  results.push({ id: p.id, name: p.name, kakaoPlace: kakao.place, centroidM_off: off, area, perHH, source: p.boundarySource, status });

  if (status !== "OK") {
    process.stdout.write(`[${i}/${sites.features.length}] ${p.id} ${p.name.padEnd(30)} off=${off}m [${status}] place=${kakao.place}\n`);
  }
}

writeFileSync(".claude/boundary-audit.json", JSON.stringify(results, null, 2));

const summary = { total: results.length, OK: 0, near: 0, far: 0, "way-off": 0, "kakao-fail": 0 };
for (const r of results) summary[r.status]++;
console.log("\n=== 요약 ===");
Object.entries(summary).forEach(([k,v]) => console.log(` ${k}: ${v}`));
console.log("\n조사 대상 (off ≥ 250m 또는 kakao-fail):");
const probs = results.filter(r => ["far","way-off","kakao-fail"].includes(r.status));
probs.forEach(r => console.log(` ${r.id} ${r.name.padEnd(30)} off=${r.centroidM_off||'-'}m ${r.status} src=${r.source}`));
