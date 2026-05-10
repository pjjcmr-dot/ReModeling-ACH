/**
 * Replace estimated-by-households polygons with real cadastral via VWORLD attrFilter
 * (jibun:LIKE search). Works when Kakao keyword search returns the apartment center,
 * giving us the 본번 (jibun number).
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const targets = sites.features.filter(f => f.properties.boundarySource === "estimated-by-households");
console.log(`estimated 단지: ${targets.length}개\n`);

const HINTS = {
  "RM022": ["산본 13단지", "개나리주공13단지", "개나리13단지"],
  "RM045": ["산본 율곡3", "율곡주공3단지"],
  "RM059": ["관양 대림2", "인덕원대림2차"],
  "RM061": ["산본 우륵7", "우륵주공7단지"],
  "RM080": ["창원 대동중앙1차", "대동중앙맨션", "대동중앙아파트"],
  "RM083": ["상동 한아름1차", "한아름마을1단지"],
  "RM121": ["산본 4단지 퇴계주공", "퇴계주공4단지"],
  "RM160": ["청계벽산"],
  "RM161": ["왕십리풍림아이원"],
  "RM164": ["도곡 극동스타클래스"],
  "RM023": ["목동 우성2차", "목동우성2차"],
  "RM159": ["사당극동", "동작극동"],
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

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

async function findAptWithJibun(name, address, id) {
  const dong = address.split(" ").pop();
  const queries = [...(HINTS[id] || [name]), name + " 아파트", name];
  for (const q of queries) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=10`,
        { headers }
      );
      const d = await r.json();
      // Prefer non-상가 entries with 아파트 keyword in same 동
      const apts = (d.documents || []).filter(x =>
        x.address_name?.includes(dong) &&
        x.category_name?.includes("아파트") &&
        !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)
      );
      for (const x of apts) {
        const m = x.address_name.match(/(\d+(?:-\d+)?)$/);
        if (m) return { lat: +x.y, lng: +x.x, place: x.place_name, jibun: m[1], query: q };
      }
      // Loose: any aparment in 동
      for (const x of d.documents || []) {
        if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
          const m = x.address_name.match(/(\d+(?:-\d+)?)$/);
          if (m) return { lat: +x.y, lng: +x.x, place: x.place_name, jibun: m[1], query: q };
        }
      }
      await delay(80);
    } catch {}
  }
  return null;
}

async function fetchByJibun(lat, lng, jibun) {
  // First: master 본번 only (e.g. "258") via attrFilter:LIKE
  const bonbun = jibun.split("-")[0];
  const url1 = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=10&attrFilter=${encodeURIComponent("jibun:LIKE:" + bonbun)}&geomFilter=POINT(${lng}%20${lat})&crs=EPSG:4326`;
  try {
    const r = await fetch(url1);
    const d = await r.json();
    const feats = d.response?.result?.featureCollection?.features || [];
    // Pick the largest 대 (residential) parcel
    const cand = feats
      .map(f => ({ f, coords: f.geometry.coordinates[0][0], area: areaM2(f.geometry.coordinates[0][0]), isRes: (f.properties.jibun||"").includes("대") }))
      .filter(m => m.isRes)
      .sort((a,b) => b.area - a.area)[0];
    if (cand && cand.area >= 5000) {
      const c = [...cand.coords];
      if (c[0][0] !== c[c.length-1][0] || c[0][1] !== c[c.length-1][1]) c.push(c[0]);
      return { coords: c, area: cand.area, source: "attrFilter-bonbun" };
    }
  } catch {}
  return null;
}

let ok = 0, fail = 0;
for (let i = 0; i < targets.length; i++) {
  const f = targets[i];
  const p = f.properties;
  try {
    const apt = await findAptWithJibun(p.name, p.address, p.id);
    if (!apt) {
      console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(28)} ✗ Kakao 검색 실패`);
      fail++; continue;
    }
    const result = await fetchByJibun(apt.lat, apt.lng, apt.jibun);
    if (result) {
      const newArea = Math.round(result.area);
      const perHH = p.households ? Math.round(newArea / p.households) : 0;
      // Sanity check
      if (perHH >= 12 && perHH <= 200) {
        f.geometry.coordinates = [result.coords];
        p.boundarySource = "cadastral-attrfilter";
        console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(28)} → ${newArea}㎡ (${perHH}㎡/세대) jibun=${apt.jibun} apt=${apt.place}`);
        ok++;
      } else {
        console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(28)} → ${newArea}㎡ rejected (perHH=${perHH}) keep estimated`);
        fail++;
      }
    } else {
      console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name.padEnd(28)} → VWORLD 본번 검색 실패`);
      fail++;
    }
    await delay(150);
  } catch (e) {
    console.log(`[${i+1}/${targets.length}] ${p.id} ${p.name} ✗ ${e.message}`);
    fail++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료: 실측 적용 ${ok}건 / estimated 유지 ${fail}건`);
