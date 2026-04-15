import { useState, useEffect, useRef, useCallback } from "react";

// 리모델링 사업 추진 단계 (진행도 표시용) - 법적 절차 순서
const STAGES = ["리모델링검토", "추진위원회", "조합설립", "안전진단", "각종심의", "시공사선정", "허가", "착공", "준공"];

// 조합설립 이전 초창기 단계 판별 (영업 진입 가능 단계)
// 1단계: 리모델링 검토 (타당성 검토 · 설명회)
// 2단계: 추진위원회 (조합설립 준비 조직)
const REVIEW_STAGE_LABELS = ["리모델링검토", "리모델링추진준비"];
const COMMITTEE_STAGE_LABELS = ["추진위원회", "추진위원회구성", "조합설립준비", "조합설립추진"];
function isReviewStage(s) {
  if (!s) return false;
  if (REVIEW_STAGE_LABELS.includes(s)) return true;
  return s.includes("검토");
}
function isCommitteeStage(s) {
  if (!s) return false;
  if (COMMITTEE_STAGE_LABELS.includes(s)) return true;
  return s.includes("추진위") || (s.includes("조합설립") && s.includes("준비"));
}
function isEarlyStage(s) {
  return isReviewStage(s) || isCommitteeStage(s);
}

// 사업단계 그룹 (필터용) - 법적 절차 순서 (주택법 제66조·68조 기준)
// 리모델링검토 → 추진위원회 → 조합설립 → 안전진단 → 각종심의 → 시공사선정 → 허가/승인 → 착공
const STAGE_GROUPS = [
  { label: "리모델링검토", match: isReviewStage },
  { label: "추진위원회", match: isCommitteeStage },
  { label: "조합설립", match: (s) => !isEarlyStage(s) && (s.includes("조합") || s.includes("창립")) },
  { label: "안전진단", match: (s) => s.includes("안전진단") },
  { label: "각종심의", match: (s) => s.includes("심의") || s.includes("교통") || s.includes("도시") || s.includes("사전자문") || s.includes("지구단위") },
  { label: "시공사선정", match: (s) => s.includes("시공사") },
  { label: "허가/승인", match: (s) => s.includes("사업계획") || s.includes("허가") },
  { label: "착공", match: (s) => s === "착공" },
  { label: "준공", match: (s) => s === "준공" || s === "사용승인" },
  { label: "재건축전환", match: (s) => s === "재건축전환" || s === "사업중단" },
];

function getProgressIndex(stage) {
  if (!stage) return -1;
  if (stage === "재건축전환" || stage === "사업중단") return -2;
  if (isReviewStage(stage)) return 0;
  if (isCommitteeStage(stage)) return 1;
  if (stage.includes("조합") || stage.includes("창립")) return 2;
  if (stage.includes("안전진단")) return 3;
  if (stage.includes("심의") || stage.includes("교통") || stage.includes("도시") || stage.includes("사전자문") || stage.includes("지구단위")) return 4;
  if (stage.includes("시공사")) return 5;
  if (stage.includes("사업계획") || stage.includes("허가")) return 6;
  if (stage === "착공") return 7;
  if (stage === "준공" || stage === "사용승인") return 8;
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
  const searchMarkerRef = useRef(null);
  const searchOverlayRef = useRef(null);
  const [measureMode, setMeasureMode] = useState(null); // null | "distance" | "area"
  const measureRef = useRef({ points: [], polyline: null, polygon: null, markers: [], label: null, clickHandler: null });

  const [sites, setSites] = useState([]);
  const [filter, setFilter] = useState("all");
  const [stageFilters, setStageFilters] = useState([]);
  const [regionFilters, setRegionFilters] = useState([]);
  const [stageOpen, setStageOpen] = useState(false);
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
    // 검색어로 사이트명/주소 실시간 필터링
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const hay = [p.name, p.address, p.developer, p.stage].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
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
      // 자동 이동/확대 제거 — 사용자가 수동으로 지도 탐색
    },
    [sites]
  );

  // ── 검색 ──
  const doSearch = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) return;

    // 1) 로컬 사이트 우선 (아파트명/주소 매칭)
    const qLower = q.toLowerCase();
    const localMatches = sites.filter((s) => {
      const hay = [s.properties.name, s.properties.address].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(qLower);
    });
    if (localMatches.length === 1) {
      const first = localMatches[0];
      const center = centroid(first.geometry.coordinates[0]);
      const map = mapObjRef.current;
      if (map) {
        map.setCenter(new window.kakao.maps.LatLng(center[1], center[0]));
        // 자동 확대 제거
      }
      setSelected(first.properties.id);
      setSearchResults([]);
      return;
    }

    // 2) Kakao SDK로 주소/장소 검색 (우선 주소, fallback 키워드)
    sdkSearch(q);
  }, [searchQuery, sites]);

  const sdkSearch = (query) => {
    if (!window.kakao?.maps?.services) {
      alert("지도 서비스가 로딩되지 않았습니다. 잠시 후 다시 시도해주세요.");
      return;
    }
    const geocoder = new window.kakao.maps.services.Geocoder();
    geocoder.addressSearch(query, (result, status) => {
      if (status === window.kakao.maps.services.Status.OK && result.length > 0) {
        const mapped = result.slice(0, 5).map((r) => ({
          name: r.address_name, address: r.road_address?.address_name || r.address_name,
          lat: +r.y, lng: +r.x,
        }));
        if (mapped.length === 1) {
          moveToLocation(mapped[0].lat, mapped[0].lng, mapped[0].name);
        } else {
          setSearchResults(mapped);
        }
      } else {
        // 주소 못 찾으면 키워드 검색
        const ps = new window.kakao.maps.services.Places();
        ps.keywordSearch(query, (data, s2) => {
          if (s2 === window.kakao.maps.services.Status.OK && data.length > 0) {
            const mapped = data.slice(0, 8).map((d) => ({
              name: d.place_name, address: d.road_address_name || d.address_name,
              lat: +d.y, lng: +d.x,
            }));
            if (mapped.length === 1) {
              moveToLocation(mapped[0].lat, mapped[0].lng, mapped[0].name);
            } else {
              setSearchResults(mapped);
            }
          } else {
            setSearchResults([]);
            alert(`"${query}"에 대한 검색 결과가 없습니다.`);
          }
        });
      }
    });
  };

  const moveToLocation = (lat, lng, name) => {
    const map = mapObjRef.current;
    if (map) {
      map.setCenter(new window.kakao.maps.LatLng(lat, lng));
      // 자동 확대 제거 (사용자 수동 조작)
    }
    // 기존 검색 마커 제거
    if (searchMarkerRef.current) {
      searchMarkerRef.current.setMap(null);
      searchMarkerRef.current = null;
    }
    if (searchOverlayRef.current) {
      searchOverlayRef.current.setMap(null);
      searchOverlayRef.current = null;
    }
    // 새 마커 생성 (빨간 핀)
    if (map && window.kakao?.maps) {
      const pos = new window.kakao.maps.LatLng(lat, lng);
      const marker = new window.kakao.maps.Marker({
        position: pos,
        map: map,
        image: new window.kakao.maps.MarkerImage(
          "data:image/svg+xml;base64," + btoa(`<svg xmlns='http://www.w3.org/2000/svg' width='36' height='48' viewBox='0 0 36 48'><path d='M18 0C8.1 0 0 8.1 0 18c0 13.5 18 30 18 30s18-16.5 18-30C36 8.1 27.9 0 18 0z' fill='#e74c3c'/><circle cx='18' cy='18' r='7' fill='#fff'/></svg>`),
          new window.kakao.maps.Size(36, 48),
          { offset: new window.kakao.maps.Point(18, 48) }
        ),
      });
      searchMarkerRef.current = marker;
      // 라벨 오버레이
      const overlay = new window.kakao.maps.CustomOverlay({
        position: pos,
        content: `<div class='search-marker-label'>📍 ${name}</div>`,
        yAnchor: 2.2,
        zIndex: 999,
      });
      overlay.setMap(map);
      searchOverlayRef.current = overlay;
    }
    setSearchQuery(name);
    setSearchResults([]);
  };

  // ── 거리/면적 측정 ──
  const clearMeasure = () => {
    const m = measureRef.current;
    if (m.polyline) { m.polyline.setMap(null); m.polyline = null; }
    if (m.polygon) { m.polygon.setMap(null); m.polygon = null; }
    m.markers.forEach(mk => mk.setMap(null));
    m.markers = [];
    if (m.label) { m.label.setMap(null); m.label = null; }
    if (m.clickHandler && mapObjRef.current) {
      window.kakao.maps.event.removeListener(mapObjRef.current, "click", m.clickHandler);
      m.clickHandler = null;
    }
    if (m.dblclickHandler && mapObjRef.current) {
      window.kakao.maps.event.removeListener(mapObjRef.current, "dblclick", m.dblclickHandler);
      m.dblclickHandler = null;
    }
    m.points = [];
  };

  const endMeasure = () => {
    clearMeasure();
    setMeasureMode(null);
  };

  // Haversine 거리 계산 (미터)
  const geoDistance = (p1, p2) => {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (p2[1] - p1[1]) * r;
    const dLng = (p2[0] - p1[0]) * r;
    const a = Math.sin(dLat/2)**2 + Math.cos(p1[1]*r) * Math.cos(p2[1]*r) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  // 다각형 면적 (제곱미터)
  const geoArea = (pts) => {
    if (pts.length < 3) return 0;
    let a = 0; const r = Math.PI / 180;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const x1 = pts[i][0] * 111320 * Math.cos(pts[i][1] * r), y1 = pts[i][1] * 110540;
      const x2 = pts[j][0] * 111320 * Math.cos(pts[j][1] * r), y2 = pts[j][1] * 110540;
      a += x1 * y2 - x2 * y1;
    }
    return Math.abs(a) / 2;
  };

  const formatDistance = (m) => m >= 1000 ? (m/1000).toFixed(2) + " km" : Math.round(m) + " m";
  const formatArea = (a) => a >= 10000 ? (a/10000).toFixed(2) + " ha (" + Math.round(a).toLocaleString() + "㎡)" : Math.round(a).toLocaleString() + " ㎡";

  const startMeasure = (mode) => {
    if (measureMode === mode) { endMeasure(); return; }
    clearMeasure();
    setMeasureMode(mode);
    const map = mapObjRef.current;
    if (!map || !window.kakao?.maps) return;

    const m = measureRef.current;
    const updateLabel = () => {
      if (m.label) { m.label.setMap(null); m.label = null; }
      if (m.points.length === 0) return;
      const last = m.points[m.points.length - 1];
      let text = "";
      if (mode === "distance") {
        let total = 0;
        for (let i = 1; i < m.points.length; i++) total += geoDistance(m.points[i-1], m.points[i]);
        text = `총 거리: ${formatDistance(total)}`;
      } else {
        const a = geoArea(m.points);
        text = `면적: ${formatArea(a)}`;
      }
      m.label = new window.kakao.maps.CustomOverlay({
        position: new window.kakao.maps.LatLng(last[1], last[0]),
        content: `<div class='measure-label'>${text}</div>`,
        yAnchor: 2.0, xAnchor: 0.5, zIndex: 1000,
      });
      m.label.setMap(map);
    };

    const redraw = () => {
      if (m.polyline) { m.polyline.setMap(null); m.polyline = null; }
      if (m.polygon) { m.polygon.setMap(null); m.polygon = null; }
      const path = m.points.map(p => new window.kakao.maps.LatLng(p[1], p[0]));
      if (mode === "distance" && path.length >= 2) {
        m.polyline = new window.kakao.maps.Polyline({
          path, strokeWeight: 4, strokeColor: "#2980b9", strokeOpacity: 0.9, strokeStyle: "solid",
        });
        m.polyline.setMap(map);
      } else if (mode === "area" && path.length >= 3) {
        m.polygon = new window.kakao.maps.Polygon({
          path, strokeWeight: 3, strokeColor: "#2980b9", strokeOpacity: 0.9,
          fillColor: "#3498db", fillOpacity: 0.25,
        });
        m.polygon.setMap(map);
      }
      updateLabel();
    };

    m.clickHandler = (e) => {
      const lat = e.latLng.getLat(), lng = e.latLng.getLng();
      m.points.push([lng, lat]);
      // 클릭 마커
      const dot = new window.kakao.maps.Marker({
        position: e.latLng, map,
        image: new window.kakao.maps.MarkerImage(
          "data:image/svg+xml;base64," + btoa(`<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12'><circle cx='6' cy='6' r='5' fill='#2980b9' stroke='#fff' stroke-width='2'/></svg>`),
          new window.kakao.maps.Size(12, 12), { offset: new window.kakao.maps.Point(6, 6) }
        ),
      });
      m.markers.push(dot);
      redraw();
    };
    m.dblclickHandler = () => { /* 완료: 추가 클릭 방지 */ };
    window.kakao.maps.event.addListener(map, "click", m.clickHandler);
    window.kakao.maps.event.addListener(map, "dblclick", m.dblclickHandler);
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
            <button className={`dropdown-btn ${stageOpen ? "open" : ""}`} onClick={() => { setStageOpen((v) => !v); setRegionOpen(false); }}>
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
                  const isEarly = g.label === "리모델링검토" || g.label === "추진위원회";
                  return (
                    <div key={g.label}
                      className={`dropdown-item ${isEarly ? "early" : ""} ${sel ? "selected" : ""}`}
                      onClick={() => setStageFilters((prev) =>
                        prev.includes(g.label) ? prev.filter((v) => v !== g.label) : [...prev, g.label]
                      )}>
                      <span className="dropdown-check">{sel ? "✓" : ""}</span>
                      <span className="dropdown-name">{isEarly ? "🔥 " : ""}{g.label}</span>
                      <span className="dropdown-count">{g.count}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="filter-dropdown">
            <button className={`dropdown-btn ${regionOpen ? "open" : ""}`} onClick={() => { setRegionOpen((v) => !v); setStageOpen(false); }}>
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

        {/* 측정 도구 */}
        <div className="measure-tools">
          <button
            className={`measure-btn ${measureMode === "distance" ? "active" : ""}`}
            onClick={() => startMeasure("distance")}
          >
            📏
            <span className="measure-btn-tooltip">거리측정</span>
          </button>
          <button
            className={`measure-btn ${measureMode === "area" ? "active" : ""}`}
            onClick={() => startMeasure("area")}
          >
            📐
            <span className="measure-btn-tooltip">면적측정</span>
          </button>
        </div>

        {measureMode && (
          <div className="measure-info">
            <strong>{measureMode === "distance" ? "📏 거리측정" : "📐 면적측정"}</strong>
            <button className="measure-close" onClick={endMeasure}>종료</button>
            <span className="measure-hint">
              지도를 클릭하여 {measureMode === "distance" ? "경로" : "영역"}을 그리세요. 더블클릭으로 완료.
            </span>
          </div>
        )}

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

      {showFlow && <FlowModal onClose={() => setShowFlow(false)} />}
    </div>
  );
}

/* ===== 사업단계 절차도 모달 ===== */
const FLOW_STEPS = [
  {
    key: "리모델링검토",
    icon: "💡",
    name: "리모델링 검토",
    subtitle: "타당성 사전 검토 · 주민 공론화",
    duration: "3~6개월",
    early: true,
    law: "비법정 단계 (법률상 의무 없음)",
    tasks: [
      "리모델링 필요성 제기 (주민 · 관리사무소)",
      "리모델링 타당성 사전 검토 · 개략 사업성 분석",
      "리모델링 설명회 개최 · 주민 설문조사",
      "대안 비교 검토 (재건축 vs 리모델링)",
      "사업 방향 설정 (세대수증가 / 수평증축 / 수직증축)",
    ],
    docs: ["리모델링 타당성 검토 보고서", "주민 설문조사 결과", "설명회 자료"],
  },
  {
    key: "추진위원회",
    icon: "🔥",
    name: "추진위원회 구성",
    subtitle: "조합설립 준비 조직 결성",
    duration: "6개월~1년",
    early: true,
    law: "비법정 단계 (실무상 조합설립 전 단계)",
    tasks: [
      "추진위원회 설립 동의서 징구 (주민 1/10 이상 권장)",
      "추진위원장 · 임원 선임",
      "정비업체 · 설계사무소 선정 (입찰)",
      "개략적 사업계획 초안 수립",
      "조합설립 동의서 징구 준비 · 주민 홍보",
    ],
    docs: ["추진위원회 설립 동의서", "정비업체 선정 계약서", "개략 사업계획서"],
  },
  {
    key: "조합설립",
    icon: "📝",
    name: "조합설립 인가",
    subtitle: "시·군·구청장의 인가 필수",
    duration: "6개월~1년",
    law: "주택법 제66조 ② (입주자 2/3 이상 + 각 동 과반수 동의)",
    tasks: [
      "조합설립 동의서 징구 (구분소유자 2/3 이상 + 각 동 과반수)",
      "창립총회 개최 · 조합장·임원 선임",
      "조합 정관 제정",
      "조합설립 인가 신청 (관할 시·군·구청)",
      "조합 법인등기 · 사업자등록",
    ],
    docs: ["조합설립 인가서", "조합 정관", "창립총회 회의록", "동의서"],
  },
  {
    key: "안전진단",
    icon: "🏗️",
    name: "1차 안전진단",
    subtitle: "조합이 시·군·구청장에 신청",
    duration: "3~6개월",
    law: "주택법 제68조 ① (증축형 리모델링 허가 전 의무)",
    highlight: "B등급 이상 → 수직증축 가능 / C등급 이상 → 수평증축·세대수증가 가능",
    tasks: [
      "안전진단 전문기관 선정 · 계약",
      "현지조사 → 정밀조사 순서 진행",
      "구조안전성 평가 (B·C등급 판정)",
      "결과 보고서 시·군·구청장 제출",
      "불합격 시 사업 재검토",
    ],
    docs: ["안전진단 결과보고서", "구조안전성 평가서"],
  },
  {
    key: "각종심의",
    icon: "🔍",
    name: "건축·경관·교통·도시계획 심의",
    subtitle: "각종 행정 심의 절차",
    duration: "1년 내외",
    law: "건축법 · 도시계획법 · 도시교통정비촉진법 등",
    tasks: [
      "건축위원회 심의 (서울시·성남시 등)",
      "경관위원회 심의",
      "도시계획위원회 심의 (지구단위계획 변경 포함)",
      "교통영향평가 심의",
      "환경영향평가 (해당 시)",
    ],
    docs: ["건축심의 의결서", "교통영향평가 보고서", "경관심의 의결서", "도시계획위원회 의결서"],
  },
  {
    key: "시공사선정",
    icon: "🏢",
    name: "시공사 선정",
    subtitle: "조합총회 의결 필수",
    duration: "3~6개월",
    law: "도시 및 주거환경정비법 시공자 선정기준 준용",
    tasks: [
      "시공사 입찰 공고 (전자입찰 원칙)",
      "현장 설명회 · 입찰서 접수",
      "조합원 총회 의결을 통한 시공사 선정",
      "공사도급 가계약 체결",
      "공사비 · 공사 조건 확정",
    ],
    docs: ["시공사 선정 총회 의결서", "공사도급 계약서", "입찰 공고문"],
  },
  {
    key: "허가/승인",
    icon: "📑",
    name: "사업계획 승인 / 리모델링 허가",
    subtitle: "세대수증가형은 사업계획 승인 필수",
    duration: "6개월~1년",
    law: "주택법 제66조 (리모델링 허가) · 제71조 (사업계획 승인)",
    tasks: [
      "사업계획 승인 신청 (세대수증가형: 30세대 이상)",
      "리모델링 허가 신청 (주택법 제66조)",
      "관리처분계획 수립 · 인가",
      "건축허가 병행 처리",
      "이주 준비 · 이주비 대출 실행",
    ],
    docs: ["사업계획 승인서", "리모델링 허가서", "관리처분계획 인가서"],
  },
  {
    key: "정밀안전진단",
    icon: "🔬",
    name: "2차 정밀안전진단",
    subtitle: "수직증축형 리모델링 시 추가 필수",
    duration: "3~6개월",
    law: "주택법 제68조 ④ (수직증축형 리모델링 허가 후)",
    highlight: "수직증축형에만 해당 (수평증축·별동증축은 생략)",
    tasks: [
      "국토안전관리원 등 정밀안전진단 기관 선정",
      "구조 상세 검토 (기초·내력벽·슬래브)",
      "보강설계 적정성 평가",
      "불합격 시 허가 취소 가능",
    ],
    docs: ["2차 정밀안전진단 보고서", "구조 보강 검토서"],
  },
  {
    key: "이주철거",
    icon: "🚚",
    name: "이주 · 철거",
    subtitle: "조합원 이주 · 기존 건물 철거",
    duration: "6개월~1년",
    law: "주택법 시행령 제76조 (이주대책 수립)",
    tasks: [
      "조합원 이주 (임시거주지 알선 · 이주비 지급)",
      "기존 건축물 일부 철거 (내력벽·비내력벽 구분)",
      "공사 준비 (가설 울타리, 안전시설 설치)",
      "이주 현황 조합 보고",
    ],
    docs: ["이주 계획서", "철거 계획서", "이주비 지급 내역서"],
  },
  {
    key: "착공",
    icon: "🔨",
    name: "착공 · 준공",
    subtitle: "본 공사 시행 · 사용검사",
    duration: "3~5년",
    law: "주택법 제49조 (사용검사) · 제66조 (리모델링 허가 후 공사)",
    tasks: [
      "착공 신고 · 본 공사 착공",
      "수평 / 별동 / 수직 증축 공사",
      "시설 공사 · 내·외장 공사",
      "사용검사(준공검사) · 소유권보존등기",
      "조합원 재입주 · 일반분양",
      "조합 청산",
    ],
    docs: ["착공 신고서", "사용검사 필증", "준공도면", "분양 공고"],
  },
];

function FlowModal({ onClose }) {
  return (
    <div className="flow-modal-backdrop" onClick={onClose}>
      <div className="flow-modal" onClick={(e) => e.stopPropagation()}>
        <button className="flow-close" onClick={onClose}>&times;</button>
        <div className="flow-header">
          <h2>리모델링 사업단계 절차도</h2>
          <p>아파트 리모델링 사업의 추진 단계별 업무와 주요 서류 안내</p>
        </div>

        {/* 단계 카드 리스트 */}
        <div className="flow-steps">
          {FLOW_STEPS.map((step, idx) => {
            return (
              <div key={step.key}>
                <div className={`flow-step ${step.early ? "early" : ""}`}>
                  <div className="flow-step-num">{idx === 0 ? "0" : idx}</div>
                  <div className="flow-step-body">
                    <div className="flow-step-title">
                      <span className="flow-step-icon">{step.icon}</span>
                      <span className="flow-step-name">{step.name}</span>
                      <span className="flow-step-duration">{step.duration}</span>
                    </div>
                    <div className="flow-step-sub">{step.subtitle}</div>
                    {step.law && (
                      <div className="flow-step-law">
                        <strong>⚖️ 법적근거:</strong> {step.law}
                      </div>
                    )}
                    {step.highlight && (
                      <div className="flow-step-highlight">💡 {step.highlight}</div>
                    )}
                    <div className="flow-step-tasks-label">📋 단계별 업무</div>
                    <ul className="flow-step-tasks">
                      {step.tasks.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                    <div className="flow-step-docs">
                      <strong>📄 주요 서류:</strong> {step.docs.join(" · ")}
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
  const [news, setNews] = useState({ loading: false, items: null, error: null });
  const [realPrice, setRealPrice] = useState({ loading: false, items: null, error: null });
  const [landRecord, setLandRecord] = useState({ loading: false, data: null, error: null });

  // 사이트 변경 시 뉴스/실거래가 자동 조회
  useEffect(() => {
    let cancelled = false;
    // 1) 뉴스
    setNews({ loading: true, items: null, error: null });
    fetch(`/api/news?query=${encodeURIComponent(site.name)}`)
      .then((r) => r.ok ? r.json() : Promise.reject(r.statusText))
      .then((d) => { if (!cancelled) setNews({ loading: false, items: d.items || [], error: null }); })
      .catch((e) => { if (!cancelled) setNews({ loading: false, items: [], error: String(e) }); });

    // 2) 실거래가 (최근 12개월)
    setRealPrice({ loading: true, items: null, error: null });
    fetch(`/api/lawdcd?address=${encodeURIComponent(site.address)}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then(async (lc) => {
        if (cancelled || !lc.code) throw new Error("법정동 매핑 실패");
        // 최근 6개월 시도
        const now = new Date();
        const months = [];
        for (let i = 0; i < 6; i++) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          months.push(d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0"));
        }
        const all = [];
        for (const ym of months) {
          try {
            const rr = await fetch(`/api/realprice?lawdCd=${lc.code}&dealYmd=${ym}&aptName=${encodeURIComponent(site.name.replace(/\s/g,""))}`);
            const rd = await rr.json();
            (rd.items || []).forEach(it => all.push(it));
          } catch {}
        }
        if (!cancelled) setRealPrice({ loading: false, items: all.slice(0, 10), error: null });
      })
      .catch((e) => { if (!cancelled) setRealPrice({ loading: false, items: [], error: String(e) }); });

    return () => { cancelled = true; };
  }, [site.id]);

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
          <h3>💹 최근 실거래 시세 (국토부)</h3>
          {(() => {
            const items = realPrice.items || [];
            if (realPrice.loading) return <div className="dp-sub-info">조회중...</div>;
            if (items.length === 0) return <div className="dp-sub-info">최근 6개월 실거래 없음</div>;

            const amounts = items.map(it => parseInt(String(it.dealAmount).replace(/[^0-9]/g, "")) || 0).filter(n => n > 0);
            const areas = items.map(it => parseFloat(it.excluArea) || 0).filter(n => n > 0);
            const avg = amounts.length > 0 ? Math.round(amounts.reduce((a,b) => a+b, 0) / amounts.length) : 0;
            const max = Math.max(...amounts);
            const min = Math.min(...amounts);
            // 평당 시세 = (금액/전용면적) * 3.305785 / 10000(만원단위 변환 없음, 이미 만원단위)
            const pyeongPrices = items.map(it => {
              const amt = parseInt(String(it.dealAmount).replace(/[^0-9]/g, "")) || 0;
              const area = parseFloat(it.excluArea) || 0;
              if (amt && area) return Math.round(amt / (area / 3.3058));
              return 0;
            }).filter(n => n > 0);
            const avgPyeong = pyeongPrices.length > 0 ? Math.round(pyeongPrices.reduce((a,b) => a+b, 0) / pyeongPrices.length) : 0;

            return (
              <div className="price-cards">
                <div className="price-card">
                  <div className="pc-label">평균 거래가</div>
                  <div className="pc-value">{(avg/10000).toFixed(1)}<span className="pc-unit">억원</span></div>
                  <div className="pc-change">{items.length}건 평균</div>
                </div>
                <div className="price-card">
                  <div className="pc-label">평당 시세 (환산)</div>
                  <div className="pc-value">{avgPyeong.toLocaleString()}<span className="pc-unit">만원/평</span></div>
                  <div className="pc-change">전용면적 기준</div>
                </div>
                <div className="price-card">
                  <div className="pc-label">최고가</div>
                  <div className="pc-value">{(max/10000).toFixed(1)}<span className="pc-unit">억원</span></div>
                  <div className="pc-change up">▲ 최근 거래</div>
                </div>
                <div className="price-card">
                  <div className="pc-label">최저가</div>
                  <div className="pc-value">{(min/10000).toFixed(1)}<span className="pc-unit">억원</span></div>
                  <div className="pc-change down">▼ 최근 거래</div>
                </div>
              </div>
            );
          })()}
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

        {/* 실거래가 */}
        <div className="dp-section">
          <h3>💰 최근 실거래가 (국토교통부)</h3>
          {realPrice.loading && <div className="dp-sub-info">조회중...</div>}
          {!realPrice.loading && (realPrice.items?.length > 0 ? (
            <table className="realprice-table">
              <thead><tr><th>거래일</th><th>전용</th><th>층</th><th>금액</th></tr></thead>
              <tbody>
                {realPrice.items.map((it, i) => (
                  <tr key={i}>
                    <td>{it.dealDate}</td>
                    <td>{it.excluArea}㎡</td>
                    <td>{it.floor}층</td>
                    <td><strong>{it.dealAmount.trim()}만원</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="dp-sub-info">
              {realPrice.error ? `조회 실패 (${realPrice.error})` : "최근 6개월 실거래 내역 없음"}
            </div>
          ))}
        </div>

        {/* 관련 뉴스 */}
        <div className="dp-section">
          <h3>📰 관련 뉴스</h3>
          {news.loading && <div className="dp-sub-info">뉴스 검색중...</div>}
          {!news.loading && (news.items?.length > 0 ? (
            <div className="news-list">
              {news.items.slice(0, 5).map((n, i) => (
                <a key={i} href={n.link} target="_blank" rel="noopener noreferrer" className="news-item">
                  <div className="news-title">{n.title}</div>
                  <div className="news-meta">
                    <span className="news-source">{n.source || "뉴스"}</span>
                    {n.date && <span className="news-date"> · {new Date(n.date).toLocaleDateString("ko-KR")}</span>}
                  </div>
                </a>
              ))}
            </div>
          ) : (
            <div className="dp-sub-info">관련 뉴스 없음</div>
          ))}
        </div>
      </div>
    </div>
  );
}
