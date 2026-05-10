/**
 * 용어 정식명칭 전수 적용:
 *  1. 행정구역 시·도 정식명칭 (서울 → 서울특별시 등)
 *  2. 사업단계 띄어쓰기 통일 + 정식명칭
 *  3. 시공자 정식 사명 (포스코 → 포스코이앤씨 등)
 *  4. 조합명 표기 일관성
 */
import { readFileSync, writeFileSync } from "fs";

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));

// ── 1. 행정구역 시·도 정식명칭 매핑 ──
function normalizeAddress(addr) {
  if (!addr) return addr;
  let s = addr.trim();

  // 광역시도 정식명칭으로 (이미 광역시도가 들어가 있으면 그대로, 없으면 추가)
  // 정식명칭: 서울특별시·부산광역시·대구광역시·인천광역시·광주광역시·대전광역시·울산광역시
  //          · 세종특별자치시·경기도·강원특별자치도·충청북도·충청남도·전북특별자치도·전라남도
  //          · 경상북도·경상남도·제주특별자치도

  // 이미 정식명 포함시 변환만
  s = s.replace(/^서울 /, "서울특별시 ");
  s = s.replace(/^부산 /, "부산광역시 ");
  s = s.replace(/^대구 /, "대구광역시 ");
  s = s.replace(/^인천 /, "인천광역시 ");
  s = s.replace(/^광주 /, "광주광역시 ");
  s = s.replace(/^대전 /, "대전광역시 ");
  s = s.replace(/^울산 /, "울산광역시 ");
  s = s.replace(/^세종 /, "세종특별자치시 ");
  s = s.replace(/^경기 /, "경기도 ");
  s = s.replace(/^강원 /, "강원특별자치도 ");
  s = s.replace(/^충북 /, "충청북도 ");
  s = s.replace(/^충남 /, "충청남도 ");
  s = s.replace(/^전북 /, "전북특별자치도 ");
  s = s.replace(/^전남 /, "전라남도 ");
  s = s.replace(/^경북 /, "경상북도 ");
  s = s.replace(/^경남 /, "경상남도 ");
  s = s.replace(/^제주 /, "제주특별자치도 ");

  // 광역시도가 누락된 시·군 (시작이 시명) → 경기도 추가
  if (/^(부천시|광명시|고양시|성남시|수원시|안양시|용인시|군포시|의왕시|과천시|안산시|화성시|평택시|시흥시|김포시|구리시|남양주시|하남시|오산시|이천시|여주시|양주시|동두천시|포천시|연천군|가평군|양평군|파주시) /.test(s)) {
    s = "경기도 " + s;
  }

  return s;
}

// ── 2. 사업단계 정식명칭 매핑 ──
// 정식명칭 원칙:
//  - 띄어쓰기 일관 (xx심의 신청, xx심의 통과)
//  - 약어 풀어쓰기 (서울시 → 서울특별시)
const STAGE_MAP = {
  "리모델링검토": "리모델링 검토",
  "추진위원회": "추진위원회 구성",
  "조합설립준비": "조합설립 준비",
  "조합창립총회": "조합창립총회",
  "조합설립인가완료": "조합설립인가",
  "안전진단진행중": "안전진단 진행 중",
  "안전진단통과": "안전진단 통과",
  "시공사선정중": "시공자 선정 중",
  "시공사선정": "시공자 선정",
  "심의준비": "심의 준비",
  "심의신청": "심의 신청",
  "건축심의신청": "건축위원회 심의 신청",
  "건축심의통과": "건축위원회 심의 통과",
  "도시계획심의통과": "도시계획위원회 심의 통과",
  "교통영향평가통과": "교통영향평가 심의 통과",
  "지구단위계획통과": "지구단위계획 결정",
  "도시교통통과": "도시·교통 심의 통과",
  "서울시사전자문통과": "사전자문 통과(서울특별시)",
  "사업계획승인신청": "사업계획승인 신청",
  "허가준비": "리모델링허가 준비",
  "허가신청": "리모델링허가 신청",
  "허가완료": "리모델링허가 완료",
  "착공": "착공",
  "준공": "준공",
  "재건축전환": "재건축 전환",
};

// ── 3. 시공자 정식명칭 매핑 ──
// 사명 변경 이력:
//  - 포스코건설 → 포스코이앤씨 (POSCO E&C, 2022.3.2)
//  - 대림산업 → DL이앤씨 (2021.1.4)
//  - SK건설 → SK에코플랜트 (2021.5.21)
const CONSTRUCTOR_MAP = {
  "포스코": "포스코이앤씨",
  "쌍용": "쌍용건설",
  "현대": "현대건설",
  "삼성": "삼성물산",
  "GS": "GS건설",
  "SK": "SK에코플랜트",
  "DL": "DL이앤씨",
  "HDC": "HDC현대산업개발",
  "한양": "㈜한양",
  "대우": "대우건설",
  "롯데": "롯데건설",
  "한화": "한화건설",
  "대보": "대보건설",
  "금호": "금호건설",
  "효성": "효성중공업",
  "KCC": "KCC건설",
  // 이미 정식명
  "포스코이앤씨": "포스코이앤씨",
  "쌍용건설": "쌍용건설",
  "현대건설": "현대건설",
  "현대엔지니어링": "현대엔지니어링",
  "DL이앤씨": "DL이앤씨",
  "SK에코플랜트": "SK에코플랜트",
  "HDC현산": "HDC현대산업개발",
  "삼성물산": "삼성물산",
  "GS건설": "GS건설",
  "한양": "㈜한양",
  "대우건설": "대우건설",
  "롯데건설": "롯데건설",
  "한화건설": "한화건설",
  "대보건설": "대보건설",
  "금호건설": "금호건설",
  "효성": "효성중공업",
  // 약어
  "현연": "현대엔지니어링",
};

function normalizeConstructor(c) {
  if (!c || c === "-" || c.trim() === "") return c;
  // 컨소시엄 (슬래시 분리)
  if (c.includes("/")) {
    const parts = c.split("/").map(p => p.trim());
    const normed = parts.map(p => CONSTRUCTOR_MAP[p] || p);
    return normed.join("·") + " 컨소시엄";
  }
  // 괄호 메모 보존
  const m = c.match(/^([^\s(]+)\s*(\(.+\))?$/);
  if (m) {
    const base = m[1];
    const memo = m[2] || "";
    const normed = CONSTRUCTOR_MAP[base] || c;
    return memo ? `${normed} ${memo}` : normed;
  }
  return CONSTRUCTOR_MAP[c] || c;
}

// ── 적용 ──
let stats = { addr: 0, stage: 0, constr: 0, dev: 0 };

for (const f of sites.features) {
  const p = f.properties;

  // 1. Address
  const newAddr = normalizeAddress(p.address);
  if (newAddr !== p.address) {
    p.address = newAddr;
    stats.addr++;
  }

  // 2. Stage
  if (STAGE_MAP[p.stage] && STAGE_MAP[p.stage] !== p.stage) {
    p.stage = STAGE_MAP[p.stage];
    stats.stage++;
  }

  // 3. Constructor
  const newC = normalizeConstructor(p.constructor);
  if (newC !== p.constructor) {
    p.constructor = newC;
    stats.constr++;
  }

  // 4. Update legal entries that reference 추진단계 to use new value
  if (Array.isArray(p.legal)) {
    for (const l of p.legal) {
      if (l.title === "추진단계") l.content = p.stage;
    }
  }
}

writeFileSync("public/sites.json", JSON.stringify(sites), "utf-8");

console.log("=== 용어 정식명칭 전수 적용 ===");
console.log("주소 정정:        ", stats.addr);
console.log("사업단계 정정:    ", stats.stage);
console.log("시공자 정정:      ", stats.constr);

// Print unique results for verification
console.log("\n--- 정식 주소 (시도 prefix) ---");
const addrs = new Set();
for (const f of sites.features) addrs.add(f.properties.address.split(" ")[0]);
[...addrs].sort().forEach(a => console.log(" ", a));

console.log("\n--- 정식 사업단계 ---");
const stages = new Set();
for (const f of sites.features) stages.add(f.properties.stage);
[...stages].sort().forEach(s => console.log(" ", s));

console.log("\n--- 정식 시공자 (상위 20) ---");
const cs = {};
for (const f of sites.features) {
  const c = f.properties.constructor;
  if (c) cs[c] = (cs[c]||0) + 1;
}
Object.entries(cs).sort((a,b) => b[1] - a[1]).slice(0, 20).forEach(([k,v]) => console.log(`  ${v}× ${k}`));
