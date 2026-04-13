import { useState, useEffect, useRef, useCallback } from "react";

// 리모델링 사업 추진 단계
const STAGES = ["안전진단", "추진위구성", "조합설립인가", "시공자선정", "리모델링허가", "착공", "준공"];

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
  const [stageFilter, setStageFilter] = useState("all");
  const [regionFilter, setRegionFilter] = useState("all");
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

  // ── 고유 단계/지역 목록 ──
  const uniqueStages = [...new Set(sites.map((s) => s.properties.stage).filter(Boolean))].sort();
  const uniqueRegions = [...new Set(sites.map((s) => {
    const parts = (s.properties.address || "").split(" ");
    return parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
  }).filter(Boolean))].sort();

  // ── 필터링 (유형 + 단계 + 지역) ──
  const filtered = sites.filter((s) => {
    const p = s.properties;
    if (filter !== "all" && p.subtype !== filter) return false;
    if (stageFilter !== "all" && p.stage !== stageFilter) return false;
    if (regionFilter !== "all") {
      const parts = (p.address || "").split(" ");
      const region = parts.length >= 2 ? parts[0] + " " + parts[1] : parts[0];
      if (region !== regionFilter) return false;
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

        <div className="filter-selects">
          <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)}>
            <option value="all">사업단계 전체</option>
            {uniqueStages.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
          <select value={regionFilter} onChange={(e) => setRegionFilter(e.target.value)}>
            <option value="all">지역 전체</option>
            {uniqueRegions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          {(stageFilter !== "all" || regionFilter !== "all") && (
            <button className="filter-reset" onClick={() => { setStageFilter("all"); setRegionFilter("all"); setFilter("all"); }}>
              초기화
            </button>
          )}
        </div>

        <div className="site-list">
          {filtered.length === 0 ? (
            <div className="loading">등록된 현장이 없습니다.</div>
          ) : (
            filtered.map((f) => {
              const p = f.properties;
              return (
                <div key={p.id} className="site-card" onClick={() => selectSite(p.id)}>
                  <span className={`sc-type ${typeClass(p.subtype)}`}>{p.subtype}</span>
                  <div className="sc-name">{p.name}</div>
                  <div className="sc-addr">{p.address}</div>
                  <div className="sc-tags">
                    <span className="sc-tag">{p.stage || "-"}</span>
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
    </div>
  );
}

/* ===== 상세 패널 ===== */
function DetailPanel({ site, onClose }) {
  const stageIdx = STAGES.indexOf(site.stage);
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
            {STAGES.map((s, i) => (
              <div key={s} className={`step${i < stageIdx ? " done" : ""}${i === stageIdx ? " current" : ""}`}>
                {s}
              </div>
            ))}
          </div>
          <table className="info-table"><tbody>
            <tr><th>현재 단계</th><td><strong>{site.stage || "-"}</strong></td></tr>
            <tr><th>단계 일자</th><td>{site.stage_date || "-"}</td></tr>
            <tr><th>다음 단계</th><td>{stageIdx >= 0 && stageIdx < STAGES.length - 1 ? STAGES[stageIdx + 1] : "완료"}</td></tr>
            <tr><th>예상 완공</th><td>{site.expected_completion || "-"}</td></tr>
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
