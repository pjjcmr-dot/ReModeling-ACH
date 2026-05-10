/**
 * 23 sites where Kakao keyword search failed even after multi-strategy retries.
 * Strategy: use known name corrections + address-based geocoding + VWORLD parcel pick.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY;
const KAKAO_KEY = process.env.KAKAO_REST_KEY;
const headers = { Authorization: `KakaoAK ${KAKAO_KEY}` };

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// Manual name corrections / search hints
const HINTS = {
  "둔촌 현대1": ["둔촌현대1차", "둔촌현대1차아파트"],
  "개포 우성9": ["개포우성9차", "개포 우성9차아파트", "우성9차"],
  "영통 8단영": ["영통8단지영남", "8단지영남", "영통영남아파트", "황골마을 영남"],
  "둔촌 부영": ["둔촌부영그린타운", "둔촌부영아파트", "부영그린타운"],
  "수지 죽전프리체": ["죽전프리체", "수지 프리체", "프리체 아파트"],
  "산본 캐나리13": ["산본 가야13", "가야13단지", "산본 13단지", "산본 캐나리"],
  "영통 5단영": ["영통5단지영남", "5단지영남", "황골마을 5단지", "영통 영남"],
  "잠원 패밀리": ["잠원파밀리에", "파밀리에 아파트", "잠원 파밀리"],
  "산본 울곡3": ["산본 율곡3", "율곡3단지", "율곡주공3단지"],
  "영통 삼성태야": ["영통 삼성태영", "삼성태영아파트", "벽적골9단지", "벽적골 삼성"],
  "권선 산천리2차": ["권선 산천리", "산천리2단지", "산천리2차아파트"],
  "평촌 조원대림2": ["평촌조원대림2단지", "조원대림2", "관양 대림2"],
  "평촌 조원한양": ["조원한양", "한양아파트 평촌", "관양한양"],
  "산본 우록7": ["산본 우륵7", "우륵7단지", "우륵주공7단지"],
  "개포 성원대치2": ["개포성원대치2차", "성원대치2", "대치성원"],
  "마포 서강GS": ["서강GS자이", "마포 서강자이", "서강 자이"],
  "창원 대동중앙": ["창원 대동중앙1차", "대동중앙아파트", "대동중앙맨션"],
  "상동 항아울1차": ["상동 한아름1차", "한아름마을1차", "상동한아름1차"],
  "현석 방성현대": ["현석 밤섬현대", "밤섬현대", "현석현대"],
  "잠원 현대채밀리": ["잠원 현대페밀리", "현대페밀리", "잠원 현대채련"],
  "산본 퇴계주공3": ["산본 4단지 퇴계주공", "퇴계주공3단지", "4단지 퇴계"],
  "목동한신청구": ["목동 청구한신", "청구한신아파트", "한신청구아파트"],
  "도곡 극동2차": ["도곡 극동스타클래스", "도곡극동2차", "도곡 극동스타"],
};

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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

async function trySearch(name, address) {
  const dong = address.split(" ").pop();
  const hints = HINTS[name] || [];
  for (const q of [...hints, name + " 아파트", name]) {
    try {
      const r = await fetch(
        `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=10`,
        { headers }
      );
      const d = await r.json();
      for (const x of d.documents || []) {
        if (x.address_name?.includes(dong) && x.category_name?.includes("아파트") &&
            !x.place_name.match(/상가|관리동|주차장|경로당|어린이집|놀이터|정문|후문/)) {
          return { lat: +x.y, lng: +x.x, place: x.place_name, query: q };
        }
      }
      // Looser: any match in 동
      for (const x of d.documents || []) {
        if (x.address_name?.includes(dong) && x.category_name?.includes("아파트")) {
          return { lat: +x.y, lng: +x.x, place: x.place_name, query: q };
        }
      }
      await delay(80);
    } catch {}
  }
  // Final: address geocoding
  try {
    const r = await fetch(
      `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`,
      { headers }
    );
    const d = await r.json();
    if (d.documents?.[0]) return { lat: +d.documents[0].y, lng: +d.documents[0].x, place: "주소중심", query: "address" };
  } catch {}
  return null;
}

async function fetchBestParcel(lat, lng, households) {
  const dd = 0.003;
  const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=300&geomFilter=BOX(${lng-dd},${lat-dd},${lng+dd},${lat+dd})&crs=EPSG:4326`;
  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features || [];
  if (!parcels.length) return null;

  const meta = parcels.map(f => {
    const c = f.geometry.coordinates[0][0];
    const cx = c.reduce((s,p) => s + p[0], 0) / c.length;
    const cy = c.reduce((s,p) => s + p[1], 0) / c.length;
    return {
      coords: c, cx, cy,
      area: areaM2(c),
      isRes: (f.properties.jibun||"").includes("대"),
      contains: pip([lng, lat], c),
      jibun: f.properties.jibun,
    };
  });

  const expectMin = households ? Math.max(2000, households * 18) : 2000;
  const expectMax = households ? Math.max(20000, households * 130) : 100000;

  // 1. Largest 대 containing point in range
  const c1 = meta.filter(m => m.contains && m.isRes && m.area >= expectMin && m.area <= expectMax)
    .sort((a,b) => b.area - a.area)[0];
  if (c1) return single(c1, "contain-range");

  // 2. Closest 대 in range
  const c3 = meta
    .filter(m => m.isRes && m.area >= expectMin && m.area <= expectMax)
    .map(m => ({ ...m, dist: Math.sqrt((m.cx-lng)**2 + (m.cy-lat)**2) }))
    .sort((a,b) => a.dist - b.dist)[0];
  if (c3) return single(c3, "nearest-range");

  // 3. Largest containing
  const c2 = meta.filter(m => m.contains && m.isRes).sort((a,b) => b.area - a.area)[0];
  if (c2 && c2.area >= 1500) return single(c2, "contain");

  // 4. Largest within 200m
  const c4 = meta
    .filter(m => m.isRes && Math.sqrt((m.cx-lng)**2 + (m.cy-lat)**2) < 0.002)
    .sort((a,b) => b.area - a.area)[0];
  if (c4 && c4.area >= 1500) return single(c4, "nearby-largest");

  return null;
}

function single(m, strategy) {
  const c = [...m.coords];
  if (c[0][0] !== c[c.length-1][0] || c[0][1] !== c[c.length-1][1]) c.push(c[0]);
  return { coords: c, area: m.area, strategy };
}

const failedIds = new Set([
  "RM002","RM004","RM016","RM019","RM020","RM022","RM027","RM034","RM045","RM046",
  "RM058","RM059","RM060","RM061","RM063","RM075","RM080","RM083","RM101","RM110",
  "RM121","RM147","RM164"
]);

let cad = 0, est = 0, fail = 0;
for (const f of sites.features) {
  if (!failedIds.has(f.properties.id)) continue;
  const p = f.properties;
  try {
    const center = await trySearch(p.name, p.address);
    if (!center) {
      console.log(`${p.id} ${p.name.padEnd(28)} ✗ 모든 검색 실패`);
      fail++;
      continue;
    }
    const parcel = await fetchBestParcel(center.lat, center.lng, p.households);
    await delay(150);
    if (parcel) {
      f.geometry.coordinates = [parcel.coords];
      p.boundarySource = "cadastral-fullaudit2";
      const newArea = Math.round(parcel.area);
      const perHH = p.households ? Math.round(newArea / p.households) : 0;
      console.log(`${p.id} ${p.name.padEnd(28)} → ${newArea}㎡ (${perHH}㎡/세대) [${parcel.strategy}] kakao="${center.place}" via "${center.query}"`);
      cad++;
    } else {
      const estA = (p.households || 200) * 50;
      const r = Math.PI / 180;
      const mLat = 110540, mLng = 111320 * Math.cos(center.lat * r);
      const h = Math.sqrt(estA / 1.3), w = h * 1.3;
      const dLat = (h/2)/mLat, dLng = (w/2)/mLng;
      f.geometry.coordinates = [[
        [center.lng - dLng, center.lat - dLat],
        [center.lng + dLng, center.lat - dLat],
        [center.lng + dLng, center.lat + dLat],
        [center.lng - dLng, center.lat + dLat],
        [center.lng - dLng, center.lat - dLat],
      ]];
      p.boundarySource = "estimated-by-households";
      console.log(`${p.id} ${p.name.padEnd(28)} → est ${estA}㎡ kakao="${center.place}" via "${center.query}"`);
      est++;
    }
  } catch (e) {
    console.log(`${p.id} ${p.name} ✗ ${e.message}`);
    fail++;
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");
console.log(`\n완료: cadastral ${cad}, estimated ${est}, fail ${fail}`);
