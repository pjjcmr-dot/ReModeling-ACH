import { useState, useEffect, useRef, useCallback } from "react";

// 리모델링 사업 추진 단계 (진행도 표시용)
const STAGES = ["추진준비", "안전진단", "조합설립", "각종심의", "시공사선정", "허가", "착공"];

// 조합설립 이전 초창기 단계 판별 (영업 진입 가능 단계)
const EARLY_STAGE_LABELS = ["리모델링검토", "리모델링추진준비", "추진위원회", "추진위원회구성", "조합설립준비", "조합설립추진"];
function isEarlyStage(s) {
  if (!s) return false;
  if (EARLY_STAGE_LABELS.includes(s)) return true;
  return s.includes("검토") || s.includes("추진위") || (s.includes("조합설립") && s.includes("준비"));
}

// 사업단계 그룹 (필터용) - 초창기부터 순서대로
const STAGE_GROUPS = [
  { label: "추진준비", match: isEarlyStage },
  { label: "안전진단", match: (s) => s.includes("안전진단") },
  { label: "조합설립", match: (s) => !isEarlyStage(s) && (s.includes("조합") || s.includes("창립")) },
  { label: "각종심의", match: (s) => s.includes("심의") || s.includes("교통") || s.includes("도시") || s.includes("사전자문") || s.includes("지구단위") },
  { label: "시공사선정", match: (s) => s.includes("시공사") },
  { label: "허가/승인", match: (s) => s.includes("사업계획") || s.includes("허가") },
  { label: "착공", match: (s) => s === "착공" },
];

function getProgressIndex(stage) {
  if (!stage) return -1;
  if (isEarlyStage(stage)) return 0;
  if (stage.includes("안전진단")) return 1;
  if (stage.includes("조합") || stage.includes("창립")) return 2;
  if (stage.includes("심의") || stage.includes("교통") || stage.includes("도시") || stage.includes("사전자문") || stage.includes("지구단위")) return 3;
  if (stage.includes("시공사")) return 4;
  if (stage.includes("사업계획") || stage.includes("허가")) return 5;
  if (stage === "착공") return 6;
  return -1;
}

// 리모델링 유형별 색상
const TYPE_COLORS = {
  "세대수증가형": { fill: "rgba(46,204,113,0.3)", stroke: "#27ae60" },
  "별동증축형":   { fill: "rgba(52,152,219,0.3)", stroke: "#2980b9" },
  "대수선형":     { fill: "rgba(155,89,182,0.3)", stroke: "#8e44ad" },
  "맞벽건축형":   { fill: "rgba(241,196,15,0.3)", stroke: "#f39c12" },
};

function typeClass(type) {
  if (type === "세대수증가형") return "type-increase";
  if (type === "별동증축형") return "type-annex";
  if (type === "대수선형") return "type-repair";
  return "type-wall";
}

function centroid(coords) {
  let x = 0, y = 0;
  coords.forEach((c) => { x += c[0]; y += c[1]; });
  return [x / coords.length, y / coords.length];
}

export default function App() {
  const mapRef = useRef(null);
  const mapObjRef = useRef(null);
  const mapReady = useRef(false);
  const drawRef = useRef({ polygons: [], overlays: [] });

  const [sites, setSites] = useState([]);
  const [filter, setFilter] = useState("all");
  const [stageFilters, setStageFilters] = useState([]);
  const [regionFilters, setRegionFilters] = useState([]);
  const [stageOpen, setStageOpen] = useState(true);
  const [regionOpen, setRegionOpen] = useState(false);
  const [showFlow, setShowFlow] = useState(false);
  const [selected, setSelected] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  // ── 카카오맵 초기화 (SDK 로드 대기 후 초기화) ──
  const [mapLoaded, setMapLoaded] = useState(false);

  useEffect(() => {
    let attempts = 0;
    const maxAttempts = 50; // 최대 15초 대기

    function tryInit() {
      attempts++;
      if (!window.kakao || !window.kakao.maps) {
        if (attempts < maxAttempts) setTimeout(tryInit, 300);
        else console.error("카카오맵 SDK 로드 실패 — kakao.com 도메인 등록을 확인하세요");
        return;
      }
      window.kakao.maps.load(() => {
        if (mapReady.current) return;
        const container = mapRef.current;
        if (!container) return;
        const map = new window.kakao.maps.Map(container, {
          center: new window.kakao.maps.LatLng(37.5400, 127.0000),
          level: 8,
        });
        map.addControl(new window.kakao.maps.ZoomControl(), window.kakao.maps.ControlPosition.RIGHT);
        map.addControl(new window.kakao.maps.MapTypeControl(), window.kakao.maps.ControlPosition.TOPRIGHT);
        mapObjRef.current = map;
        mapReady.current = true;
        setMapLoaded(true);
      });
    }
    tryInit();
  }, []);

  // ── 현장 데이터 로드 ──
  useEffect(() => {
    fetch("/api/sites")
      .then((r) => r.json())
      .then((geo) => setSites(geo.features || []))
      .catch(() => {});
  }, []);

  // ── 고유 지역 목록 + 단계별 건수 ──
  const uniqueRegions = [...new Set(sites.map((s) => {
    const parts = (s.properties.address || "").split(" ");
    return parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
  }).filter(Boolean))].sort();

  const stageGroupCounts = STAGE_GROUPS.map((g) => ({
    ...g,
    count: sites.filter((s) => g.match(s.properties.stage || "")).length,
  }));

  // ── 필터링 (유형 + 단계 + 지역, 중복선택) ──
  const filtered = sites.filter((s) => {
    const p = s.properties;
    if (filter !== "all" && p.subtype !== filter) return false;
    if (stageFilters.length > 0) {
      const ok = stageFilters.some((sf) => {
        const g = STAGE_GROUPS.find((g) => g.label === sf);
        return g && g.match(p.stage || "");
      });
      if (!ok) return false;
    }
    if (regionFilters.length > 0) {
      const parts = (p.address || "").split(" ");
      const region = parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
      if (!regionFilters.includes(region)) return false;
    }
    return true;
  });

  // ── 폴리곤 그리기 ──
  useEffect(() => {
    const map = mapObjRef.current;
    if (!map || !window.kakao?.maps) return;

    drawRef.current.polygons.forEach((p) => p.setMap(null));
    drawRef.current.overlays.forEach((o) => o.setMap(null));
    drawRef.current = { polygons: [], overlays: [] };

    filtered.forEach((feature) => {
      const p = feature.properties;
      const coords = feature.geometry.coordinates[0];
      const color = TYPE_COLORS[p.subtype] || TYPE_COLORS["세대수증가형"];

      const path = coords.map((c) => new window.kakao.maps.LatLng(c[1], c[0]));
      const polygon = new window.kakao.maps.Polygon({
        path,
        strokeWeight: 2,
        strokeColor: color.stroke,
        strokeOpacity: 0.9,
        fillColor: color.fill,
        fillOpacity: 1,
      });
      polygon.setMap(map);
      drawRef.current.polygons.push(polygon);

      const center = centroid(coords);
      const content = document.createElement("div");
      content.style.cssText = `
        background:${color.stroke};color:#fff;padding:4px 10px;border-radius:4px;
        font-size:12px;font-weight:bold;cursor:pointer;white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,0.3);
      `;
      content.textContent = p.name;
      content.onclick = () => selectSite(p.id);

      const overlay = new window.kakao.maps.CustomOverlay({
        position: new window.kakao.maps.LatLng(center[1], center[0]),
        content,
        yAnchor: 1.3,
      });
      overlay.setMap(map);
      drawRef.current.overlays.push(overlay);

      window.kakao.maps.event.addListener(polygon, "click", () => selectSite(p.id));
      window.kakao.maps.event.addListener(polygon, "mouseover", () =>
        polygon.setOptions({ strokeWeight: 4 })
      );
      window.kakao.maps.event.addListener(polygon, "mouseout", () =>
        polygon.setOptions({ strokeWeight: 2 })
      );
    });
  }, [filtered, mapLoaded]);

  // ── 현장 선택 ──
  const selectSite = useCallback(
    (id) => {
      const feature = sites.find((f) => f.properties.id === id);
      if (!feature) return;
      setSelected(feature.properties);

      const map = mapObjRef.current;
      if (map) {
        const center = centroid(feature.geometry.coordinates[0]);
        map.setCenter(new window.kakao.maps.LatLng(center[1], center[0]));
        map.setLevel(3);
      }
    },
    [sites]
  );

  // ── 검색 ──
  const doSearch = useCallback(() => {
    if (!searchQuery.trim()) return;
    fetch(`/api/search?query=${encodeURIComponent(searchQuery)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.results) setSearchResults(data.results);
        else sdkSearch(searchQuery);
      })
      .catch(() => sdkSearch(searchQuery));
  }, [searchQuery]);

  const sdkSearch = (query) => {
    if (!window.kakao?.maps?.services) return;
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.addressSearch(query, (result, status) => {
      if (status === window.kakao.maps.services.Status.OK) {
        setSearchResults(result.slice(0, 5).map((r) => ({
          name: r.address_name, lat: +r.y, lng: +r.x,
        })));
      } else {
        const ps = new window.kakao.maps.services.Places();
        ps.keywordSearch(query, (data, s2) => {
          if (s2 === window.kakao.maps.services.Status.OK) {
            setSearchResults(data.slice(0, 5).map((d) => ({
              name: d.place_name, address: d.road_address_name || d.address_name,
              lat: +d.y, lng: +d.x,
            })));
          } else {
            setSearchResults([]);
          }
        });
      }
    });
  };

  const moveToLocation = (lat, lng, name) => {
    const map = mapObjRef.current;
    if (map) {
      map.setCenter(new window.kakao.maps.LatLng(lat, lng));
      map.setLevel(3);
    }
    setSearchQuery(name);
    setSearchResults([]);
  };

  // ── 통계 ──
  const stats = {
    total: sites.length,
    increase: sites.filter((s) => s.properties.subtype === "세대수증가형").length,
    annex: sites.filter((s) => s.properties.subtype === "별동증축형").length,
    repair: sites.filter((s) => s.properties.subtype === "대수선형").length,
  };

  return (
    <div className="wrap">
      {/* ===== 사이드바 ===== */}
      <div className="sidebar">
        <div className="header">
          <h1>리모델링 현장 지도</h1>
          <p>아파트 리모델링 사업 추진 현황</p>
          <button className="flow-btn" onClick={() => setShowFlow(true)}>📋 사업단계 절차도</button>
        </div>

        <div className="search-box">
          <div className="input-wrap">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
              placeholder="주소, 지번, 도로명, 역명 검색..."
            />
            <button onClick={doSearch}>검색</button>
          </div>
          {searchResults.length > 0 && (
            <div className="search-results">
              {searchResults.map((r, i) => (
                <div key={i} className="sr-item" onClick={() => moveToLocation(r.lat, r.lng, r.name)}>
                  <div>{r.name}</div>
                  {r.address && <div className="sr-addr">{r.address}</div>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="stats-bar">
          <div className="stat"><div className="stat-num">{stats.total}</div><div className="stat-label">전체</div></div>
          <div className="stat"><div className="stat-num">{stats.increase}</div><div className="stat-label">세대수증가</div></div>
          <div className="stat"><div className="stat-num">{stats.annex}</div><div className="stat-label">별동증축</div></div>
          <div className="stat"><div className="stat-num">{stats.repair}</div><div className="stat-label">대수선</div></div>
          {filtered.length !== stats.total && (
            <div className="stat"><div className="stat-num" style={{color:"#e74c3c"}}>{filtered.length}</div><div className="stat-label">필터결과</div></div>
          )}
        </div>

        <div className="filter-tabs">
          {["all", "세대수증가형", "별동증축형", "대수선형"].map((t) => (
            <button key={t} className={filter === t ? "active" : ""} onClick={() => setFilter(t)}>
              {t === "all" ? "전체" : t.replace("형", "")}
            </button>
          ))}
        </div>

        <div className="filter-multi">
          <div className="filter-dropdown">
            <button className={`dropdown-btn ${stageOpen ? "open" : ""}`} onClick={() => setStageOpen((v) => !v)}>
              <span className="dropdown-label">사업단계</span>
              <span className="dropdown-value">
                {stageFilters.length === 0 ? "전체" : `${stageFilters.length}개 선택`}
              </span>
              <span className="dropdown-caret">{stageOpen ? "▲" : "▼"}</span>
            </button>
            {stageOpen && (
              <div className="dropdown-list">
                {stageFilters.length > 0 && (
                  <div className="dropdown-item clear-item" onClick={() => setStageFilters([])}>
                    <span>✕ 선택 해제</span>
                  </div>
                )}
                {stageGroupCounts.filter((g) => g.count > 0).map((g) => {
                  const sel = stageFilters.includes(g.label);
                  return (
                    <div key={g.label}
                      className={`dropdown-item ${g.label === "추진준비" ? "early" : ""} ${sel ? "selected" : ""}`}
                      onClick={() => setStageFilters((prev) =>
                        prev.includes(g.label) ? prev.filter((v) => v !== g.label) : [...prev, g.label]
                      )}>
                      <span className="dropdown-check">{sel ? "✓" : ""}</span>
                      <span className="dropdown-name">{g.label === "추진준비" ? "🔥 " : ""}{g.label}</span>
                      <span className="dropdown-count">{g.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="filter-dropdown">
            <button className={`dropdown-btn ${regionOpen ? "open" : ""}`} onClick={() => setRegionOpen((v) => !v)}>
              <span className="dropdown-label">지역</span>
              <span className="dropdown-value">
                {regionFilters.length === 0 ? "전체" : `${regionFilters.length}개 선택`}
              </span>
              <span className="dropdown-caret">{regionOpen ? "▲" : "▼"}</span>
            </button>
            {regionOpen && (
              <div className="dropdown-list dropdown-list-scroll">
                {regionFilters.length > 0 && (
                  <div className="dropdown-item clear-item" onClick={() => setRegionFilters([])}>
                    <span>✕ 선택 해제</span>
                  </div>
                )}
                {uniqueRegions.map((r) => {
                  const sel = regionFilters.includes(r);
                  return (
                    <div key={r}
                      className={`dropdown-item ${sel ? "selected" : ""}`}
                      onClick={() => setRegionFilters((prev) =>
                        prev.includes(r) ? prev.filter((v) => v !== r) : [...prev, r]
                      )}>
                      <span className="dropdown-check">{sel ? "✓" : ""}</span>
                      <span className="dropdown-name">{r}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {(stageFilters.length > 0 || regionFilters.length > 0 || filter !== "all") && (
            <button className="filter-reset" onClick={() => { setStageFilters([]); setRegionFilters([]); setFilter("all"); }}>
              전체 초기화
            </button>
          )}
        </div>

        <div className="site-list">
          {filtered.length === 0 ? (
            <div className="loading">등록된 현장이 없습니다.</div>
          ) : (
            filtered.map((f) => {
              const p = f.properties;
              const early = isEarlyStage(p.stage);
              return (
                <div key={p.id} className="site-card" onClick={() => selectSite(p.id)}>
                  <span className={`sc-type ${typeClass(p.subtype)}`}>{p.subtype}</span>
                  <div className="sc-name">{p.name}</div>
                  <div className="sc-addr">{p.address}</div>
                  <div className="sc-tags">
                    <span className={`sc-tag ${early ? "early-stage" : ""}`}>{early ? "🔥 " : ""}{p.stage || "-"}</span>
                    <span className="sc-tag">{p.households || "-"}세대</span>
                    <span className="sc-tag">{p.price_per_pyeong || "-"}만원/평</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ===== 지도 ===== */}
      <div className="map-container">
        <div id="kakao-map" ref={mapRef} style={{ width: "100%", height: "100%" }} />

        <div className="map-legend">
          <h4>리모델링 유형</h4>
          <div className="legend-item">
            <div className="legend-color" style={{ background: "rgba(46,204,113,0.4)", borderColor: "#27ae60" }} />
            <span>세대수증가형</span>
          </div>
          <div className="legend-item">
            <div className="legend-color" style={{ background: "rgba(52,152,219,0.4)", borderColor: "#2980b9" }} />
            <span>별동증축형</span>
          </div>
          <div className="legend-item">
            <div className="legend-color" style={{ background: "rgba(155,89,182,0.4)", borderColor: "#8e44ad" }} />
            <span>대수선형</span>
          </div>
        </div>

        {selected && <DetailPanel site={selected} onClose={() => setSelected(null)} />}
      </div>

      {showFlow && (
        <FlowModal
          sites={sites}
          stageFilters={stageFilters}
          setStageFilters={setStageFilters}
          regionFilters={regionFilters}
          setRegionFilters={setRegionFilters}
          uniqueRegions={uniqueRegions}
          onClose={() => setShowFlow(false)}
        />
      )}
    </div>
  );
}

/* ===== 사업단계 절차도 모달 ===== */
const FLOW_STEPS = [
  {
    key: "추진준비",
    icon: "🔥",
    name: "추진준비",
    subtitle: "리모델링 검토 · 추진위원회 결성",
    duration: "6개월~1년",
    early: true,
    tasks: [
      "주민 의견 수렴 및 리모델링 설명회 개최",
      "타당성 검토 및 개략 사업계획 수립",
      "추진위원회 결성 (주민 1/10 이상 동의)",
      "정비업체 · 설계업체 접촉",
    ],
    docs: ["리모델링 설명회 자료", "추진위원회 설립 동의서"],
  },
  {
    key: "조합설립",
    icon: "📝",
    name: "조합설립",
    subtitle: "조합 설립 동의서 징구 및 인가",
    duration: "6개월~1년",
    tasks: [
      "조합설립 동의서 징구 (구분소유자 2/3 + 각 동 과반수)",
      "창립총회 개최 및 조합장 선임",
      "조합설립 인가 신청 (관할 구청)",
      "조합 등기 · 사업자등록",
    ],
    docs: ["조합설립 인가서", "조합 정관", "창립총회 회의록"],
  },
  {
    key: "안전진단",
    icon: "🏗️",
    name: "안전진단",
    subtitle: "건축물 안전진단 시행",
    duration: "3~6개월",
    tasks: [
      "안전진단 전문기관 선정",
      "1차 현지조사 · 2차 정밀조사",
      "수직증축: B등급 이상 / 수평증축: C등급 이상 요구",
      "결과 보고서 제출",
    ],
    docs: ["안전진단 결과보고서"],
  },
  {
    key: "각종심의",
    icon: "🔍",
    name: "각종심의",
    subtitle: "건축 · 도시계획 · 교통 · 환경",
    duration: "1년 내외",
    tasks: [
      "건축위원회 심의 (서울시 · 성남시 등)",
      "도시계획위원회 심의 (지구단위계획)",
      "교통영향평가 · 환경영향평가",
      "서울시 사전자문 (해당 시)",
    ],
    docs: ["심의 의결서", "교통평가 보고서", "환경평가 보고서"],
  },
  {
    key: "시공사선정",
    icon: "🏢",
    name: "시공사선정",
    subtitle: "시공자 선정 및 계약",
    duration: "3~6개월",
    tasks: [
      "시공사 입찰 공고",
      "현장 설명회 및 입찰서 접수",
      "조합원 총회 의결로 시공사 선정",
      "공사도급 가계약 체결",
    ],
    docs: ["시공사 선정 총회 의결서", "공사도급 계약서"],
  },
  {
    key: "허가/승인",
    icon: "📑",
    name: "허가/승인",
    subtitle: "사업계획 승인 · 리모델링 허가",
    duration: "6개월~1년",
    tasks: [
      "사업계획 승인 신청",
      "리모델링 허가 (주택법 제66조)",
      "관리처분계획 수립 및 인가",
      "이주 준비 및 이주비 대출 실행",
    ],
    docs: ["사업계획 승인서", "리모델링 허가서", "관리처분 계획"],
  },
  {
    key: "착공",
    icon: "🔨",
    name: "착공",
    subtitle: "이주 · 철거 · 공사 · 준공",
    duration: "3~5년",
    tasks: [
      "조합원 이주 및 기존 건물 일부 철거",
      "본 공사 착공 (내력벽 철거, 수평/별동/수직 증축)",
      "시설 공사 및 준공 검사",
      "조합원 재입주 · 일반분양",
    ],
    docs: ["착공 신고서", "준공 검사서", "분양 공고"],
  },
];

function FlowModal({ sites, stageFilters, setStageFilters, regionFilters, setRegionFilters, uniqueRegions, onClose }) {
  const filteredBySeq = (match) => sites.filter((s) => {
    if (regionFilters.length > 0) {
      const parts = (s.properties.address || "").split(" ");
      const region = parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
      if (!regionFilters.includes(region)) return false;
    }
    return match(s.properties.stage || "");
  });

  const toggleStage = (label) => {
    setStageFilters((prev) =>
      prev.includes(label) ? prev.filter((v) => v !== label) : [...prev, label]
    );
  };

  const toggleRegion = (region) => {
    setRegionFilters((prev) =>
      prev.includes(region) ? prev.filter((v) => v !== region) : [...prev, region]
    );
  };

  const totalFiltered = sites.filter((s) => {
    const p = s.properties;
    if (stageFilters.length > 0) {
      const ok = stageFilters.some((sf) => {
        const g = STAGE_GROUPS.find((g) => g.label === sf);
        return g && g.match(p.stage || "");
      });
      if (!ok) return false;
    }
    if (regionFilters.length > 0) {
      const parts = (p.address || "").split(" ");
      const region = parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
      if (!regionFilters.includes(region)) return false;
    }
    return true;
  });

  return (
    <div className="flow-modal-backdrop" onClick={onClose}>
      <div className="flow-modal" onClick={(e) => e.stopPropagation()}>
        <button className="flow-close" onClick={onClose}>&times;</button>
        <div className="flow-header">
          <h2>리모델링 사업단계 절차도</h2>
          <p>단계 카드를 클릭해 해당 단계 현장을 지도에서 필터링할 수 있습니다.</p>
        </div>

        {/* 지역 필터 */}
        <div className="flow-filter-bar">
          <div className="flow-filter-row">
            <span className="flow-filter-label">지역</span>
            <div className="flow-chips">
              {uniqueRegions.map((r) => (
                <button key={r}
                  className={`flow-chip ${regionFilters.includes(r) ? "active" : ""}`}
                  onClick={() => toggleRegion(r)}>{r}</button>
              ))}
              {regionFilters.length > 0 && (
                <button className="flow-chip clear" onClick={() => setRegionFilters([])}>해제</button>
              )}
            </div>
          </div>
          <div className="flow-filter-row">
            <span className="flow-filter-label">사업단계</span>
            <div className="flow-chips">
              {STAGE_GROUPS.map((g) => {
                const ct = filteredBySeq(g.match).length;
                return (
                  <button key={g.label}
                    className={`flow-chip ${g.label === "추진준비" ? "early" : ""} ${stageFilters.includes(g.label) ? "active" : ""}`}
                    onClick={() => toggleStage(g.label)}>
                    {g.label} <span className="flow-chip-ct">{ct}</span>
                  </button>
                );
              })}
              {stageFilters.length > 0 && (
                <button className="flow-chip clear" onClick={() => setStageFilters([])}>해제</button>
              )}
            </div>
          </div>
          <div className="flow-result">
            필터 결과: <strong>{totalFiltered.length}</strong>개 현장
            {(stageFilters.length > 0 || regionFilters.length > 0) && (
              <button className="flow-reset" onClick={() => { setStageFilters([]); setRegionFilters([]); }}>초기화</button>
            )}
          </div>
        </div>

        {/* 단계 카드 리스트 */}
        <div className="flow-steps">
          {FLOW_STEPS.map((step, idx) => {
            const group = STAGE_GROUPS.find((g) => g.label === step.key);
            const count = group ? filteredBySeq(group.match).length : 0;
            const active = stageFilters.includes(step.key);
            return (
              <div key={step.key}>
                <div
                  className={`flow-step ${step.early ? "early" : ""} ${active ? "active" : ""}`}
                  onClick={() => toggleStage(step.key)}
                >
                  <div className="flow-step-num">{idx === 0 ? "0" : idx}</div>
                  <div className="flow-step-body">
                    <div className="flow-step-title">
                      <span className="flow-step-icon">{step.icon}</span>
                      <span className="flow-step-name">{step.name}</span>
                      <span className="flow-step-duration">{step.duration}</span>
                      <span className="flow-step-count">{count}개 현장</span>
                    </div>
                    <div className="flow-step-sub">{step.subtitle}</div>
                    <ul className="flow-step-tasks">
                      {step.tasks.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                    <div className="flow-step-docs">
                      <strong>주요 서류:</strong> {step.docs.join(" · ")}
                    </div>
                    {step.early && (
                      <div className="flow-step-early-tag">🔥 영업 진입 가능 단계 (경쟁사업자 미진입)</div>
                    )}
                  </div>
                </div>
                {idx < FLOW_STEPS.length - 1 && <div className="flow-arrow">▼</div>}
              </div>
            );
          })}
        </div>

        <div className="flow-footer">
          <strong>총 소요기간:</strong> 약 8~12년 · <strong>근거 법령:</strong> 주택법 제66조 (리모델링의 허가)
        </div>
      </div>
    </div>
  );
}

/* ===== 상세 패널 ===== */
function DetailPanel({ site, onClose }) {
  const stageIdx = getProgressIndex(site.stage);
  const legals = site.legal || [];

  return (
    <div className="detail-panel">
      <div className="dp-header">
        <button className="dp-close" onClick={onClose}>&times;</button>
        <span className={`dp-type-badge ${typeClass(site.subtype)}`}>{site.subtype}</span>
        <h2>{site.name}</h2>
        <div className="dp-addr">{site.address}</div>
      </div>

      <div className="dp-body">
        <div className="dp-section">
          <h3>리모델링 추진 단계</h3>
          <div className="progress-bar">
            {STAGES.map((s, i) => {
              const isCurrent = i === stageIdx;
              const isEarly = i === 0 && isCurrent; // 추진준비 단계에 주황 강조
              return (
                <div key={s} className={`step${i < stageIdx ? " done" : ""}${isEarly ? " early" : isCurrent ? " current" : ""}`}>
                  {s}
                </div>
              );
            })}
          </div>
          <table className="info-table"><tbody>
            <tr><th>현재 단계</th><td><strong style={isEarlyStage(site.stage) ? {color:"#d35400"} : null}>{isEarlyStage(site.stage) ? "🔥 " : ""}{site.stage || "-"}</strong></td></tr>
            <tr><th>다음 단계</th><td>{stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : "-"}</td></tr>
            {isEarlyStage(site.stage) && (
              <tr><th>영업 진입</th><td style={{color:"#d35400",fontWeight:"bold"}}>✓ 초창기 단계 (선점 가능)</td></tr>
            )}
          </tbody></table>
        </div>

        <div className="dp-section">
          <h3>현재 시세</h3>
          <div className="price-cards">
            <div className="price-card">
              <div className="pc-label">평당 시세</div>
              <div className="pc-value">{site.price_per_pyeong || "-"}<span className="pc-unit">만원</span></div>
              <div className={`pc-change ${(site.price_change || 0) > 0 ? "up" : "down"}`}>
                {(site.price_change || 0) > 0 ? "▲" : "▼"} {Math.abs(site.price_change || 0)}만원 (전월비)
              </div>
            </div>
            <div className="price-card">
              <div className="pc-label">조합원 분담금 (추정)</div>
              <div className="pc-value">{site.contribution || "-"}<span className="pc-unit">만원</span></div>
              <div className="pc-change">84㎡ 기준</div>
            </div>
            <div className="price-card">
              <div className="pc-label">일반분양가 (추정)</div>
              <div className="pc-value">{site.sale_price || "-"}<span className="pc-unit">만원/평</span></div>
              <div className="pc-change">{site.sale_price_date || "-"} 기준</div>
            </div>
            <div className="price-card">
              <div className="pc-label">프리미엄</div>
              <div className="pc-value">{site.premium || "-"}<span className="pc-unit">만원</span></div>
              <div className="pc-change">입주권 기준</div>
            </div>
          </div>
        </div>

        <div className="dp-section">
          <h3>사업 개요</h3>
          <table className="info-table"><tbody>
            <tr><th>리모델링 유형</th><td>{site.subtype}</td></tr>
            <tr><th>시행자</th><td>{site.developer || "-"}</td></tr>
            <tr><th>시공사</th><td>{site.constructor || "-"}</td></tr>
            <tr><th>대지 면적</th><td>{site.area || "-"}</td></tr>
            <tr><th>기존 세대수</th><td>{site.existing_households || "-"}세대</td></tr>
            <tr><th>리모델링 후</th><td>{site.households || "-"}세대</td></tr>
            <tr><th>증가 세대</th><td>{site.added_households || "-"}세대 ({site.increase_rate || "-"}%)</td></tr>
            <tr><th>준공연도</th><td>{site.built_year || "-"}년</td></tr>
            <tr><th>최고 층수</th><td>{site.max_floors || "-"}층</td></tr>
          </tbody></table>
        </div>

        <div className="dp-section">
          <h3>법적 근거 및 규제</h3>
          {legals.length > 0 ? (
            legals.map((l, i) => (
              <div key={i} className="legal-item">
                <strong>{l.title}</strong><br />{l.content}
              </div>
            ))
          ) : (
            <div className="legal-item"><strong>법적 정보</strong><br />등록된 법적 정보가 없습니다.</div>
          )}
        </div>
      </div>
    </div>
  );
}
