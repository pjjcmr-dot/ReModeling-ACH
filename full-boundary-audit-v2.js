/**
 * Enhanced boundary audit with HINTS-aware Kakao search.
 * Uses comprehensive name variation strategies before declaring kakao-fail.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };
const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Per-site name corrections (compiled from all fix scripts)
const HINTS = {
  "RM002": ["둔촌현대1차"],
  "RM004": ["개포우성9차", "우성9차"],
  "RM016": ["영통8단지영남", "황골마을 영남"],
  "RM019": ["둔촌부영그린타운", "부영그린타운"],
  "RM020": ["수지 죽전프리체", "프리체"],
  "RM022": ["산본 13단지", "개나리주공13단지"],
  "RM023": ["목동2차우성"],
  "RM027": ["영통5단지영남", "5단지영남"],
  "RM034": ["잠원파밀리에", "파밀리에"],
  "RM045": ["율곡마을주공3단지", "율곡주공3단지"],
  "RM046": ["삼성태영아파트", "벽적골9단지"],
  "RM058": ["권선 산천리"],
  "RM059": ["관양 대림2", "인덕원대림2차"],
  "RM060": ["조원한양", "초원6단지한양"],
  "RM061": ["산본 우륵7", "우륵주공7단지"],
  "RM063": ["개포성원대치2차", "성원대치2"],
  "RM067": ["롯데캐슬갤럭시1차", "롯데갤럭시1차"],
  "RM075": ["서강GS자이"],
  "RM080": ["대동중앙아파트 창원"],
  "RM083": ["상동 한아름1차", "한아름마을1단지"],
  "RM099": ["초원마을8단지세경"],
  "RM101": ["밤섬현대"],
  "RM110": ["잠원 현대페밀리"],
  "RM121": ["퇴계주공3단지 군포"],
  "RM126": ["강변현대아파트"],
  "RM127": ["응봉신동아"],
  "RM147": ["청구한신아파트", "한신청구"],
  "RM164": ["도곡 극동스타클래스"],
  "RM168": ["잠실현대타워"],
  "RM169": ["서초아이파크아파트"],
};

function polygonCentroid(coords) {
  let cx = 0, cy = 0, n = coords.length - 1;
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

async function kakaoCenter(id, name, address, polygonCenter) {
  const dong = address.split(" ").pop();
  const cleaned = name.replace(/\s*\([^)]*\)\s*/g, "").trim();
  const hintQueries = HINTS[id] || [];
  const fallbackQueries = [
    cleaned + " 아파트",
    cleaned + "아파트",
    cleaned,
    cleaned.replace(/ /g, "") + "아파트",
  ];

  // For each query (hints first, then fallback), prefer the result closest to polygon centroid
  const allQueries = [...hintQueries, ...fallbackQueries];
  let bestCandidate = null;
  let bestDist = Infinity;

  for (const q of allQueries) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=15`,
        { headers }
      );
      const d = await r.json();
      for (const x of d.documents || []) {
        if (x.category_name?.includes("아파트") &&
            !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)) {
          const r0 = Math.PI / 180;
          const dlat = (+x.y - polygonCenter[1]) * 110540;
          const dlng = (+x.x - polygonCenter[0]) * 111320 * Math.cos(((polygonCenter[1] + +x.y) / 2) * r0);
          const dist = Math.sqrt(dlat*dlat + dlng*dlng);
          if (dist < bestDist) {
            bestDist = dist;
            bestCandidate = { lat: +x.y, lng: +x.x, place: x.place_name, viaQuery: q, dist };
          }
        }
      }
      await delay(70);
      // If we found a really close match, stop searching
      if (bestDist < 100) break;
    } catch {}
  }
  if (bestCandidate) return bestCandidate;

  // Fallback phase: strict dong filter (non-아파트 categories)
  for (const q of fallbackQueries) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=15`,
        { headers }
      );
      const d = await r.json();
      for (const x of d.documents || []) {
        if (x.address_name?.includes(dong) && x.category_name?.includes("아파트") &&
            !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)) {
          return { lat: +x.y, lng: +x.x, place: x.place_name, viaQuery: q };
        }
      }
      for (const x of d.documents || []) {
        if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
          return { lat: +x.y, lng: +x.x, place: x.place_name, viaQuery: q };
        }
      }
      await delay(70);
    } catch {}
  }
  // Final: address geocoding
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`,
      { headers }
    );
    const d = await r.json();
    if (d.documents?.[0]) return { lat: +d.documents[0].y, lng: +d.documents[0].x, place: "주소중심", viaQuery: "address-fallback" };
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

  const kakao = await kakaoCenter(p.id, p.name, p.address, centroid);
  await delay(70);
  if (!kakao) {
    results.push({ id: p.id, name: p.name, kakao: null, off: null, area, perHH, source: p.boundarySource, status: "kakao-fail" });
    continue;
  }
  const off = Math.round(dist_m(centroid, [kakao.lng, kakao.lat]));
  const isLargeComplex = area > 30000;

  let status;
  if (off < 100) status = "OK";
  else if (off < 250) status = "near";
  else if (off < 500 && isLargeComplex) status = "OK-large"; // 대형 단지: 입구 vs 중심점 차이 자연스러움
  else if (off < 600) status = "far";
  else status = "way-off";

  results.push({
    id: p.id, name: p.name, kakaoPlace: kakao.place,
    via: kakao.viaQuery, off, area, perHH,
    source: p.boundarySource, status,
  });
}

writeFileSync(".claude/boundary-audit-v2.json", JSON.stringify(results, null, 2));

const summary = { OK: 0, "OK-large": 0, near: 0, far: 0, "way-off": 0, "kakao-fail": 0 };
for (const r of results) summary[r.status]++;
console.log("\n=== v2 audit (HINTS + 대형단지 보정) ===");
console.log("Total:", results.length);
Object.entries(summary).forEach(([k,v]) => {
  const pct = (v / results.length * 100).toFixed(1);
  console.log(` ${k.padEnd(10)} ${String(v).padStart(3)} (${pct}%)`);
});

console.log("\n잔여 의심 (far/way-off/kakao-fail):");
const probs = results.filter(r => ["far","way-off","kakao-fail"].includes(r.status));
probs.forEach(r => console.log(` ${r.id} ${r.name.padEnd(30)} off=${r.off||'-'}m ${r.status} src=${r.source}`));
