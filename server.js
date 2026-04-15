import "dotenv/config";
import express from "express";
import cors from "cors";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());

// ── 환경변수 ──
const KAKAO_REST_KEY = process.env.KAKAO_REST_KEY || "";
const SEOUL_API_KEY = process.env.VITE_SEOUL_API_KEY || "";
const DATA_GO_KR_KEY = process.env.VITE_PUBLIC_DATA_API_KEY || "";
const VWORLD_KEY = process.env.VITE_VWORLD_API_KEY || "";

// ── 현장 데이터 ──
app.get("/api/sites", (req, res) => {
  try {
    const data = readFileSync(join(__dirname, "public", "sites.json"), "utf-8");
    res.json(JSON.parse(data));
  } catch {
    res.json({ type: "FeatureCollection", features: [] });
  }
});

app.get("/api/site/:id", (req, res) => {
  try {
    const data = JSON.parse(readFileSync(join(__dirname, "public", "sites.json"), "utf-8"));
    const feature = data.features.find((f) => f.properties.id === req.params.id);
    if (feature) return res.json(feature.properties);
    res.status(404).json({ error: "현장 정보를 찾을 수 없습니다" });
  } catch {
    res.status(500).json({ error: "데이터 로드 실패" });
  }
});

// ── 카카오 주소/키워드 검색 프록시 ──
app.get("/api/search", async (req, res) => {
  const { query } = req.query;
  if (!KAKAO_REST_KEY) return res.status(400).json({ error: "카카오 REST API 키 미설정" });
  if (!query) return res.status(400).json({ error: "검색어를 입력해주세요" });

  const headers = { Authorization: `KakaoAK ${KAKAO_REST_KEY}` };
  const results = [];
  const seen = new Set();

  try {
    // 주소 검색
    const addrRes = await fetch(
      `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=5`,
      { headers }
    );
    const addrData = await addrRes.json();
    for (const doc of addrData.documents || []) {
      const name = doc.address_name;
      if (!seen.has(name)) {
        seen.add(name);
        results.push({ name, lat: +doc.y, lng: +doc.x, type: "address" });
      }
    }

    // 키워드 검색 (역명, 건물명 등)
    const kwRes = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=5`,
      { headers }
    );
    const kwData = await kwRes.json();
    for (const doc of kwData.documents || []) {
      const name = doc.place_name || doc.address_name;
      if (!seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          address: doc.road_address_name || doc.address_name || "",
          lat: +doc.y,
          lng: +doc.x,
          type: "keyword",
        });
      }
    }

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 서울시 재개발·재건축 정비사업 현황 (OA-2253) ──
app.get("/api/seoul/redevelopment", async (req, res) => {
  if (!SEOUL_API_KEY) return res.status(400).json({ error: "서울시 API 키 미설정" });
  const { gu, start = 1, end = 100 } = req.query;
  try {
    const url = `http://openapi.seoul.go.kr:8088/${SEOUL_API_KEY}/json/TbCleanRedevelopment/${start}/${end}/`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.TbCleanRedevelopment) {
      let rows = data.TbCleanRedevelopment.row;
      if (gu) rows = rows.filter((r) => (r.CGG_NM || "").includes(gu));
      return res.json({ total: rows.length, data: rows });
    }
    res.status(404).json({ error: data?.RESULT?.MESSAGE || "데이터 없음" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 서울시 정비사업 추진 경과 (OA-2254) ──
app.get("/api/seoul/progress", async (req, res) => {
  if (!SEOUL_API_KEY) return res.status(400).json({ error: "서울시 API 키 미설정" });
  const { start = 1, end = 100 } = req.query;
  try {
    const url = `http://openapi.seoul.go.kr:8088/${SEOUL_API_KEY}/json/TbCleanProgress/${start}/${end}/`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.TbCleanProgress) {
      return res.json({ total: data.TbCleanProgress.row.length, data: data.TbCleanProgress.row });
    }
    res.status(404).json({ error: "데이터 없음" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 공동주택 단지 검색 ──
app.get("/api/apartment/search", async (req, res) => {
  if (!DATA_GO_KR_KEY) return res.status(400).json({ error: "공공데이터포털 API 키 미설정" });
  const { districtCode } = req.query;
  if (!districtCode) return res.status(400).json({ error: "법정동코드를 입력해주세요" });
  try {
    const url = `http://apis.data.go.kr/1613000/AptListServiceV3/getLegaldongAptListV3?ServiceKey=${DATA_GO_KR_KEY}&loadongCode=${districtCode}&numOfRows=100&pageNo=1`;
    const r = await fetch(url);
    const text = await r.text();
    res.type("xml").send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 관련 뉴스 (Google News RSS) ──
app.get("/api/news", async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: "검색어 필요" });
  try {
    const q = encodeURIComponent(`${query} 리모델링`);
    const url = `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`;
    const r = await fetch(url);
    const xml = await r.text();
    // 간단한 XML 파싱 (item 추출)
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) && items.length < 10) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || "";
      const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "";
      const desc = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) || [])[1] || "";
      items.push({
        title: title.replace(/<[^>]*>/g, "").trim(),
        link: link.trim(),
        source: source.trim(),
        date: pubDate.trim(),
        description: desc.replace(/<[^>]*>/g, "").trim().slice(0, 200),
      });
    }
    res.json({ items, total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 아파트 실거래가 (공공데이터포털 - 국토교통부) ──
// 법정동코드(5자리) + 연월(YYYYMM) 필요
app.get("/api/realprice", async (req, res) => {
  if (!DATA_GO_KR_KEY) return res.status(400).json({ error: "공공데이터 API 키 미설정" });
  const { lawdCd, dealYmd, aptName } = req.query;
  if (!lawdCd || !dealYmd) return res.status(400).json({ error: "lawdCd(법정동코드 5자리)와 dealYmd(YYYYMM) 필요" });
  try {
    const url = `http://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev?serviceKey=${DATA_GO_KR_KEY}&LAWD_CD=${lawdCd}&DEAL_YMD=${dealYmd}&numOfRows=100&pageNo=1`;
    const r = await fetch(url);
    const xml = await r.text();
    // XML에서 item 추출
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml))) {
      const block = match[1];
      const get = (tag) => {
        const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : "";
      };
      const name = get("aptNm");
      if (aptName && !name.includes(aptName)) continue;
      items.push({
        aptName: name,
        address: `${get("umdNm")} ${get("jibun")}`,
        dealAmount: get("dealAmount"),
        floor: get("floor"),
        excluArea: get("excluUseAr"),
        buildYear: get("buildYear"),
        dealDate: `${get("dealYear")}-${String(get("dealMonth")).padStart(2,"0")}-${String(get("dealDay")).padStart(2,"0")}`,
      });
    }
    items.sort((a, b) => b.dealDate.localeCompare(a.dealDate));
    res.json({ items: items.slice(0, 20), total: items.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 토지대장 (VWorld) ──
app.get("/api/landrecord", async (req, res) => {
  if (!VWORLD_KEY) return res.status(400).json({ error: "VWorld API 키 미설정" });
  const { pnu } = req.query;
  if (!pnu) return res.status(400).json({ error: "PNU(고유번호 19자리) 필요" });
  try {
    const url = `https://api.vworld.kr/ned/data/getLandCharacteristics?pnu=${pnu}&stdrYear=&numOfRows=10&pageNo=1&format=json&key=${VWORLD_KEY}`;
    const r = await fetch(url);
    const data = await r.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PNU 조회 (좌표→고유번호) ──
app.get("/api/pnu", async (req, res) => {
  if (!VWORLD_KEY) return res.status(400).json({ error: "VWorld API 키 미설정" });
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat, lng 필요" });
  try {
    const url = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LP_PA_CBND_BUBUN&geomFilter=POINT(${lng}%20${lat})&key=${VWORLD_KEY}&format=json&size=1`;
    const r = await fetch(url);
    const data = await r.json();
    const feature = data?.response?.result?.featureCollection?.features?.[0];
    if (feature) {
      res.json({
        pnu: feature.properties?.pnu,
        jibun: feature.properties?.jibun,
        bonbun: feature.properties?.bonbun,
        bubun: feature.properties?.bubun,
      });
    } else {
      res.status(404).json({ error: "필지 정보 없음" });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 법정동 코드 조회 (주소→법정동 5자리) ──
app.get("/api/lawdcd", async (req, res) => {
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: "address 필요" });
  // 간단한 매핑 (시군구까지)
  const LAWD = {
    "서울 강남구": "11680", "서울 강동구": "11740", "서울 강북구": "11305", "서울 강서구": "11500",
    "서울 관악구": "11620", "서울 광진구": "11215", "서울 구로구": "11530", "서울 금천구": "11545",
    "서울 노원구": "11350", "서울 도봉구": "11320", "서울 동대문구": "11230", "서울 동작구": "11590",
    "서울 마포구": "11440", "서울 서대문구": "11410", "서울 서초구": "11650", "서울 성동구": "11200",
    "서울 성북구": "11290", "서울 송파구": "11710", "서울 양천구": "11470", "서울 영등포구": "11560",
    "서울 용산구": "11170", "서울 은평구": "11380", "서울 종로구": "11110", "서울 중구": "11140",
    "서울 중랑구": "11260",
    "성남시 분당구": "41135", "성남시 수정구": "41131", "성남시 중원구": "41133",
    "수원시 영통구": "41117", "수원시 권선구": "41113", "수원시 팔달구": "41115", "수원시 장안구": "41111",
    "용인시 수지구": "41465", "용인시 기흥구": "41463", "용인시 처인구": "41461",
    "안양시 동안구": "41173", "안양시 만안구": "41171",
    "고양시 덕양구": "41281", "고양시 일산동구": "41285", "고양시 일산서구": "41287",
    "부천시 원미구": "41192", "부천시 소사구": "41194", "부천시 오정구": "41196", "부천시 상동": "41190",
    "광명시 철산동": "41210", "군포시 금정동": "41410", "군포시 산본동": "41410",
  };
  const parts = address.split(" ");
  const key1 = parts.slice(0, 2).join(" ");
  const key2 = parts.slice(0, 3).join(" ");
  const code = LAWD[key2] || LAWD[key1];
  if (code) return res.json({ code, matched: LAWD[key2] ? key2 : key1 });
  res.status(404).json({ error: "법정동코드 매핑 없음", address });
});

app.listen(PORT, () => {
  console.log(`\n  API 서버: http://localhost:${PORT}`);
  console.log(`  카카오 키: ${KAKAO_REST_KEY ? "✓ 설정됨" : "✗ 미설정"}`);
  console.log(`  서울시 키: ${SEOUL_API_KEY ? "✓ 설정됨" : "✗ 미설정"}`);
  console.log(`  공공데이터 키: ${DATA_GO_KR_KEY ? "✓ 설정됨" : "✗ 미설정"}\n`);
});
