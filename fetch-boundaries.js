/**
 * VWORLD 연속지적도 API로 실제 필지 경계를 가져와
 * 아파트 단지 경계(convex hull) 생성
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";

const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY || "";
if (!VWORLD_KEY) { console.error("VITE_VWORLD_API_KEY 미설정"); process.exit(1); }

const sites = JSON.parse(readFileSync("public/sites.json", "utf-8"));
const features = sites.features;
console.log(`${features.length}개 사업장 실측경계 가져오기 시작\n`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Convex Hull 알고리즘
function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 3) return [...pts, pts[0]]; // 닫힌 폴리곤
  const cross = (O, A, B) => (A[0] - O[0]) * (B[1] - O[1]) - (A[1] - O[1]) * (B[0] - O[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  hull.push(hull[0]); // 닫기
  return hull;
}

// 면적 계산 (㎡ 근사)
function areaM2(coords) {
  let area = 0;
  const toRad = Math.PI / 180;
  for (let i = 0; i < coords.length; i++) {
    const j = (i + 1) % coords.length;
    const xi = coords[i][0] * 111320 * Math.cos(coords[i][1] * toRad);
    const yi = coords[i][1] * 110540;
    const xj = coords[j][0] * 111320 * Math.cos(coords[j][1] * toRad);
    const yj = coords[j][1] * 110540;
    area += xi * yj - xj * yi;
  }
  return Math.abs(area) / 2;
}

async function fetchBoundary(lat, lng, households) {
  // 세대수에 따라 검색 범위 조정 (큰 단지 = 넓은 범위)
  const h = households || 300;
  const d = Math.min(0.003, Math.max(0.001, h * 0.000002));
  const bbox = [lng - d, lat - d, lng + d, lat + d].join(",");

  const url =
    `https://api.vworld.kr/req/data?service=data&request=GetFeature` +
    `&data=LP_PA_CBND_BUBUN&key=${VWORLD_KEY}&format=json&size=100` +
    `&geomFilter=BOX(${bbox})&crs=EPSG:4326`;

  const res = await fetch(url);
  const data = await res.json();
  const parcels = data.response?.result?.featureCollection?.features;
  if (!parcels || parcels.length === 0) return null;

  // '대'(주거지) 필지 우선 + 중심점 거리순 정렬
  const withMeta = parcels.map((f) => {
    const coords = f.geometry.coordinates[0][0];
    const cx = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const cy = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const dist = Math.sqrt((cx - lng) ** 2 + (cy - lat) ** 2);
    const isResidential = (f.properties.jibun || "").includes("대");
    return { coords, dist, isResidential };
  });

  // 주거지 필터 → 거리순 정렬
  let candidates = withMeta.filter((f) => f.isResidential);
  if (candidates.length < 5) candidates = withMeta; // 주거지 부족하면 전부 사용
  candidates.sort((a, b) => a.dist - b.dist);

  // 세대수에 비례하여 필지 수 결정 (최소 5, 최대 40)
  const takeCount = Math.min(40, Math.max(5, Math.round(h / 30)));
  const selected = candidates.slice(0, takeCount);

  // 모든 좌표로 convex hull 생성
  const allPoints = [];
  selected.forEach((f) => f.coords.forEach((c) => allPoints.push(c)));

  if (allPoints.length < 3) return null;
  return convexHull(allPoints);
}

let success = 0, fail = 0;

for (let i = 0; i < features.length; i++) {
  const f = features[i];
  const p = f.properties;
  const oldCoords = f.geometry.coordinates[0];
  const cx = oldCoords.reduce((s, c) => s + c[0], 0) / oldCoords.length;
  const cy = oldCoords.reduce((s, c) => s + c[1], 0) / oldCoords.length;

  try {
    const hull = await fetchBoundary(cy, cx, p.households);
    if (hull && hull.length >= 4) {
      const area = areaM2(hull);
      f.geometry.coordinates = [hull];
      success++;
      process.stdout.write(`[${i + 1}/${features.length}] ${p.name} ... ${hull.length - 1}점 ${Math.round(area)}㎡\n`);
    } else {
      fail++;
      process.stdout.write(`[${i + 1}/${features.length}] ${p.name} ... 유지(데이터 부족)\n`);
    }
  } catch (e) {
    fail++;
    process.stdout.write(`[${i + 1}/${features.length}] ${p.name} ... 실패: ${e.message}\n`);
  }

  await delay(150); // rate limiting
}

writeFileSync("public/sites.json", JSON.stringify(sites, null, 2), "utf-8");
console.log(`\n완료! 성공: ${success}개 / 유지: ${fail}개`);
console.log("public/sites.json 저장됨");
