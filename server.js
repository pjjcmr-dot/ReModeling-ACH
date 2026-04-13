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

app.listen(PORT, () => {
  console.log(`\n  API 서버: http://localhost:${PORT}`);
  console.log(`  카카오 키: ${KAKAO_REST_KEY ? "✓ 설정됨" : "✗ 미설정"}`);
  console.log(`  서울시 키: ${SEOUL_API_KEY ? "✓ 설정됨" : "✗ 미설정"}`);
  console.log(`  공공데이터 키: ${DATA_GO_KR_KEY ? "✓ 설정됨" : "✗ 미설정"}\n`);
});
