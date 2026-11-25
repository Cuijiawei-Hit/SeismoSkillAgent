/* Core power GIS workspace. All engineering values are read from saved results.
 * Leaflet is distributed locally under its original BSD-2-Clause license.
 */
(function () {
  "use strict";
  const mounts = new WeakMap();
  const palette = { teal: "#087f79", ink: "#173b49", blue: "#2871a5", amber: "#d6952e", red: "#b94045", grey: "#84939b" };
  const strategyColors = { id_order: "#8b9ca7", importance: "#c28d48", ga: "#087f79" };
  const list = value => Array.isArray(value) ? value : [];
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const tr = c => (zh, en) => String(c.options.language || "zh-CN").startsWith("en") ? en : zh;
  const num = (value, digits = 1) => finite(value) ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—";
  const percent = value => finite(value) ? `${num(value * 100, 1)}%` : "—";
  const validPoint = node => finite(node.longitude) && finite(node.latitude) && Math.abs(node.longitude) <= 180 && Math.abs(node.latitude) <= 90;
  const objectText = value => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);
  const byId = rows => Object.fromEntries(rows.map(row => [String(row.id ?? row.result_id), row]));
  const query = (c, selector) => c.container.querySelector(selector);
  const safeURL = value => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; } };
  const timeHours = frame => finite(frame?.time_hours) ? frame.time_hours : finite(frame?.time_day) ? frame.time_day * 24 : finite(frame?.time) ? frame.time * (/小时|hour|^h$/.test(frame.time_unit || "") ? 1 : 24) : 0;
  const atOrBefore = (frames, hours) => {
    let found = null;
    for (const frame of list(frames)) { if (timeHours(frame) > hours + 1e-8) break; found = frame; }
    return found;
  };
  function normalizedScene(scene) {
    const network = scene.network || scene;
    const nodes = list(network.nodes || scene.nodes), edges = list(network.edges || network.links || scene.links);
    const recovery = scene.recovery || {};
    const strategies = list(recovery.strategies || scene.strategies).map(strategy => ({ ...strategy, frames: list(strategy.frames || strategy.map_frames), curve: list(strategy.curve), schedule: list(strategy.schedule) }));
    const impact = scene.impact || {};
    return { ...scene, network: { ...network, nodes, edges }, recovery: { ...recovery, strategies }, impact: { ...impact, areas: list(impact.areas || impact.service_areas), strategies: list(impact.strategies) } };
  }
  function selectedStrategy(c) { return c.scene.recovery.strategies.find(row => row.id === c.strategyId) || c.scene.recovery.strategies[0] || null; }
  function metricAvailable(c, metric) {
    if (metric === "voltage") return true;
    if (metric === "damage") return finite(c.scene.damage?.damaged_count) || c.scene.network.nodes.some(row => row.damage_state != null || row.damage_label != null);
    if (metric === "impact") return c.scene.impact.computed === true && c.scene.impact.areas.length > 0;
    return finite(c.scene.function?.post_supply_mw) || c.scene.recovery.strategies.some(row => row.frames.length > 0);
  }
  function impactStrategy(c) { return c.scene.impact.strategies.find(row => row.id === c.strategyId) || c.scene.impact.strategies[0] || c.scene.impact; }
  function currentFrame(c) { return selectedStrategy(c)?.frames[c.index] || null; }
  function frameGroups(frame, group, metric) {
    if (!frame) return {};
    if (group === "node") return frame[metric === "function" ? "node_function" : "node_damage"] || frame.node?.[metric] || {};
    return frame[metric === "function" ? "branch_function" : "branch_damage"] || frame.pipe?.[metric] || frame.branch?.[metric] || {};
  }
  function assetValue(c, item, group, metric) {
    const values = frameGroups(currentFrame(c), group, metric), key = String(item.result_id ?? item.id);
    if (Object.hasOwn(values, key)) return values[key];
    if (metric === "damage") return item.damage_label ?? item.damage_state ?? item.damage ?? null;
    return item.function ?? item.function_ratio ?? item.supply_ratio ?? null;
  }
  function impactFrame(c) {
    const strategy = impactStrategy(c);
    return atOrBefore(strategy?.frames || strategy?.timeline, timeHours(currentFrame(c))) || null;
  }
  function areaState(c, area) {
    const frame = impactFrame(c), id = String(area.id);
    return frame?.area_states?.[id] || frame?.states?.[id] || area.properties || area;
  }
  function voltageColor(value) { return value >= 200 ? "#85528e" : value >= 100 ? "#357baa" : value >= 30 ? "#138b83" : "#c28b40"; }
  function damageColor(value) {
    if (value == null || /未知|unknown|未记录/i.test(String(value))) return palette.grey;
    if (/完全|毁坏/.test(String(value)) || value === 5) return "#852c39";
    if (/严重/.test(String(value)) || value === 4) return palette.red;
    if (/中等|中度/.test(String(value)) || value === 3) return palette.amber;
    if (/轻微|轻度/.test(String(value)) || value === 2) return "#a9a344";
    return palette.teal;
  }
  function supplyColor(value) { return !finite(value) ? palette.grey : value >= .999 ? palette.teal : value <= .000001 ? palette.red : palette.amber; }
  function stateColor(state) {
    if (state === "grid_supplied" || state === "supplied") return palette.teal;
    if (state === "full_outage") return palette.red;
    if (state === "partial_outage") return palette.amber;
    return palette.grey;
  }
  function assetColor(c, item, group) {
    if (c.metric === "damage") return damageColor(assetValue(c, item, group, "damage"));
    if (c.metric === "supply" || c.metric === "impact") return supplyColor(assetValue(c, item, group, "function"));
    return voltageColor(Number(item.voltage_kv ?? item.properties?.voltage_kv));
  }
  function frameRatio(c) {
    const frame = currentFrame(c), curve = selectedStrategy(c)?.curve || [];
    const point = atOrBefore(curve.map(row => ({ ...row, time_hours: finite(row.time_hours) ? row.time_hours : (row.time ?? row.time_day ?? 0) * 24 })), timeHours(frame));
    return frame?.function_ratio ?? frame?.function ?? point?.function ?? point?.function_ratio ?? (frame ? null : c.scene.function?.function_ratio);
  }
  function sourceHTML(value, depth = 0) {
    if (depth > 4 || value == null) return "";
    if (Array.isArray(value)) return value.slice(0, 8).map(row => sourceHTML(row, depth + 1)).join("");
    if (typeof value === "object") {
      const url = safeURL(value.url || value.source_url || value.download_url), title = value.title || value.name || value.publisher;
      if (url || title) return `<p>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title || url)} ↗</a>` : esc(title)}${value.note ? `<small>${esc(value.note)}</small>` : ""}</p>`;
      return Object.entries(value).filter(([key]) => !/hash|geometry|coordinates|records/.test(key)).slice(0, 8).map(([, row]) => sourceHTML(row, depth + 1)).join("");
    }
    const url = safeURL(value);
    return `<p>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)} ↗</a>` : esc(value)}</p>`;
  }
  function button(action, label, text, extra = "") { return `<button type="button" data-ps-action="${action}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${text}</button>`; }
  function render(c) {
    const t = tr(c), calculated = c.scene.recovery.strategies.length > 0, nodes = c.scene.network.nodes;
    const hasResults = c.scene.status === "ready" || c.scene.has_results || calculated;
    const title = c.options.title || c.scene.case?.title || c.scene.title || t("奥克兰电网", "Auckland electricity network");
    c.container.innerHTML = `<section class="power-scene${calculated ? " has-results" : " is-preview"}" aria-label="${t("电网地理分析工作台", "Electricity GIS workspace")}">
      <header class="ps-heading"><div><span class="ps-kicker">${hasResults ? t("电力系统 · 已保存结果", "POWER SYSTEM · SAVED RESULTS") : t("案例数据 · 地理预览", "CASE DATA · GEOGRAPHIC PREVIEW")}</span><h3>${esc(title)}</h3></div><span class="ps-record-badge"><i></i>${hasResults ? t("计算结果", "Saved result") : t("完整网络", "Full network")}</span></header>
      <div class="ps-kpis" data-ps-kpis></div>
      <div class="ps-toolbar">
        <div class="ps-modes" role="group" aria-label="${t("地图专题", "Map theme")}">
          ${[["voltage", t("电网结构", "Network")], ["damage", t("设备损伤", "Damage")], ["supply", t("供电状态", "Supply")], ["impact", t("停电范围", "Outage areas")]].map(([key, label]) => `<button type="button" data-ps-mode="${key}" class="${c.metric === key ? "is-active" : ""}" aria-pressed="${c.metric === key}" ${!metricAvailable(c, key) ? "disabled" : ""}>${label}</button>`).join("")}
        </div>
        <div class="ps-tools"><select data-ps-basemap aria-label="${t("底图", "Basemap")}"><option value="light">${t("清爽底图", "Light basemap")}</option><option value="osm">${t("原始底图", "Original basemap")}</option><option value="offline">${t("离线坐标网格", "Offline coordinate grid")}</option></select>${button("fit", t("显示完整电网", "Fit complete network"), "<span aria-hidden='true'>⌖</span>")}${button("details", t("对象详情", "Object details"), t("对象详情", "Details"), "aria-expanded='false'")}${button("fullscreen", t("全屏地图", "Expand map"), "<span aria-hidden='true'>⛶</span>")}</div>
      </div>
      <div class="ps-map-stage"><div class="ps-map-canvas" data-ps-map role="region" aria-label="${t("可缩放电网地图", "Zoomable electricity network map")}"></div>
        <div class="ps-map-stamp"><strong>${t("奥克兰", "AUCKLAND")}</strong><span data-ps-time>${calculated ? t("震后初始状态", "Initial post-event state") : "WGS 84"}</span></div>
        <div class="ps-legend"><button type="button" data-ps-action="legend" aria-expanded="true">${t("图层与说明", "Layers & legend")}<span aria-hidden="true">−</span></button><div data-ps-legend-body>
          <label><input type="checkbox" data-ps-network checked>${t("电网节点与线路", "Grid nodes & lines")}</label><label><input type="checkbox" data-ps-areas ${c.showAreas ? "checked" : ""} ${!c.scene.impact.areas.length ? "disabled" : ""}>${t("供电服务分区", "Supply service areas")}</label><label><input type="checkbox" data-ps-junctions>${t("馈线连接点", "Feeder junctions")}</label><label><input type="checkbox" data-ps-labels>${t("站点名称", "Station labels")}</label>
          <label class="ps-voltage-label">${t("电压等级", "Voltage level")}<select data-ps-voltage aria-label="${t("筛选电压等级", "Filter voltage level")}"><option value="all">${t("全部电压", "All voltages")}</option>${[...new Set(nodes.map(row => row.voltage_kv).filter(finite))].sort((a, b) => b - a).map(value => `<option value="${value}">${value} kV</option>`).join("")}</select></label><div class="ps-color-key" data-ps-color-key></div>
        </div></div>
        <aside class="ps-details" data-ps-details hidden><header><strong>${t("对象详情", "Object details")}</strong>${button("close-details", t("关闭对象详情", "Close object details"), "×")}</header><div data-ps-detail-content></div></aside>
        <div class="ps-background-state" data-ps-background-state role="status" hidden></div>
      </div>
      <div class="ps-map-caption"><span>${t("实际地理坐标 · 路线与连接关系来自绑定版本", "Saved geographic coordinates, routes and connectivity")}</span><span>${num(nodes.length, 0)} ${t("节点", "nodes")} / ${num(c.scene.network.edges.length, 0)} ${t("支路", "branches")}</span></div>
      ${calculated ? `<section class="ps-recovery" aria-label="${t("保存的恢复过程", "Saved recovery playback")}"><div class="ps-recovery-heading"><div><strong>${t("恢复过程", "RECOVERY PLAYBACK")}</strong><small>${t("地图、曲线与人口影响同步至已保存时刻", "Map, curve and exposure use saved event times")}</small></div><label>${t("修复策略", "Strategy")}<select data-ps-strategy aria-label="${t("修复策略", "Repair strategy")}">${c.scene.recovery.strategies.map(row => `<option value="${esc(row.id)}" ${row.id === c.strategyId ? "selected" : ""}>${esc(row.name || row.id)}</option>`).join("")}</select></label></div>
      <div class="ps-curve" data-ps-curve></div><div class="ps-playback">${button("previous", t("上一个保存时刻", "Previous saved time"), "‹")}${button("play", t("播放恢复过程", "Play recovery"), `<span aria-hidden="true">▶</span><span>${t("播放", "Play")}</span>`, "class='ps-play' aria-pressed='false'")}${button("next", t("下一个保存时刻", "Next saved time"), "›")}<input type="range" min="0" max="${Math.max(0, (selectedStrategy(c)?.frames.length || 1) - 1)}" value="${c.index}" data-ps-timeline aria-label="${t("恢复保存时刻", "Saved recovery time")}"><output data-ps-frame-time></output><select data-ps-speed aria-label="${t("播放速度", "Playback speed")}"><option value="800">1×</option><option value="400" selected>2×</option><option value="160">5×</option></select></div><p class="ps-recovery-note">${t("按本轮已保存事件帧回放；不在展示时重新计算。人口为有来源分区的等效影响，未映射范围单列。", "Replays saved event frames without recomputing. Population is equivalent exposure in sourced service areas; unmapped coverage remains separate.")}</p></section>` : `<p class="ps-preview-note">${t("当前展示已发布案例数据。输入问题并批准执行方案后，可查看设备损伤、供电与恢复过程。", "This preview shows the published case. Submit a question and approve the plan to view damage, supply and recovery results.")}</p>`}
    </section>`;
    bind(c);
    initializeMap(c);
    update(c, true);
  }
  function initializeMap(c) {
    const t = tr(c), L = window.L;
    if (!L) { query(c, "[data-ps-map]").innerHTML = `<div class="ps-map-error">${t("本地地图组件尚未载入，请刷新页面。", "The local map component has not loaded. Refresh the page.")}</div>`; return; }
    c.map = L.map(query(c, "[data-ps-map]"), { preferCanvas: true, zoomControl: false, attributionControl: true, minZoom: 3, maxZoom: 19, zoomSnap: .1, zoomDelta: .5 });
    L.control.zoom({ position: "bottomleft" }).addTo(c.map);
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(c.map);
    c.map.createPane("ps-areas"); c.map.getPane("ps-areas").style.zIndex = 350;
    c.map.createPane("ps-edges"); c.map.getPane("ps-edges").style.zIndex = 410;
    c.map.createPane("ps-nodes"); c.map.getPane("ps-nodes").style.zIndex = 430;
    c.areaGroup = L.layerGroup().addTo(c.map); c.edgeGroup = L.layerGroup().addTo(c.map); c.nodeGroup = L.layerGroup().addTo(c.map);
    c.layers = { nodes: [], edges: [], areas: [] };
    c.scene.network.edges.forEach(item => {
      const geometry = item.geometry || (item.coordinates ? { type: "LineString", coordinates: item.coordinates } : null);
      let layer, schematic = !geometry;
      if (geometry) {
        try { layer = L.geoJSON(geometry, { pane: "ps-edges", style: { weight: 2 }, smoothFactor: .65 }); } catch { schematic = true; }
      }
      if (!layer) {
        const a = c.nodeById[String(item.source ?? item.from_node)], b = c.nodeById[String(item.target ?? item.to_node)];
        if (!validPoint(a || {}) || !validPoint(b || {})) return;
        layer = L.polyline([[a.latitude, a.longitude], [b.latitude, b.longitude]], { pane: "ps-edges", dashArray: "5 5", weight: 1.4 });
      }
      const row = { item, layer, schematic };
      layer.bindTooltip(esc(item.name || `${item.source ?? item.from_node} — ${item.target ?? item.to_node}`), { sticky: true, className: "ps-tooltip" });
      layer.on("click", () => selectAsset(c, row, "edge"));
      layer.addTo(c.edgeGroup); c.layers.edges.push(row);
    });
    c.scene.network.nodes.forEach(item => {
      if (!validPoint(item)) return;
      const junction = isJunction(item), layer = L.circleMarker([item.latitude, item.longitude], { pane: "ps-nodes", radius: junction ? 2 : 4.5, weight: junction ? 0 : 1.4, color: "#fff", fillOpacity: 1 });
      layer.bindTooltip(esc(item.name || item.id), { direction: "top", className: "ps-tooltip" });
      const row = { item, layer, junction };
      layer.on("click", () => selectAsset(c, row, "node")); layer.addTo(c.nodeGroup); c.layers.nodes.push(row);
    });
    c.scene.impact.areas.forEach(item => {
      const geometry = item.geometry || c.scene.impact.geometry_by_id?.[String(item.id)];
      if (!geometry || !["Polygon", "MultiPolygon", "GeometryCollection"].includes(geometry.type)) return;
      try {
        const layer = L.geoJSON(geometry, { pane: "ps-areas", smoothFactor: .7, style: { color: "#84939b", weight: .8, fillOpacity: .13 } });
        const row = { item, layer };
        layer.bindTooltip(esc(item.name || item.id), { sticky: true, className: "ps-tooltip" }); layer.on("click", () => selectAsset(c, row, "area")); layer.addTo(c.areaGroup); c.layers.areas.push(row);
      } catch { c.invalidGeometries++; }
    });
    c.bounds = L.latLngBounds(c.scene.network.nodes.filter(validPoint).map(row => [row.latitude, row.longitude]));
    // Geographic routes can extend beyond their endpoint bounds. Keep them too.
    c.layers.edges.forEach(row => { const bounds = row.layer.getBounds?.(); if (bounds?.isValid()) c.bounds.extend(bounds); });
    c.fitPending = true;
    c.map.setView([-36.85, 174.76], 10, { animate: false });
    fitCompleteNetwork(c);
    setBasemap(c, c.options.basemap || "light");
    c.resizeObserver = new ResizeObserver(() => { if (!c.disposed) updateViewport(c); }); c.resizeObserver.observe(query(c, "[data-ps-map]"));
    c.visibilityListener = () => { if (document.hidden) pause(c.container); else updateViewport(c); };
    document.addEventListener("visibilitychange", c.visibilityListener);
    requestAnimationFrame(() => updateViewport(c));
  }
  function fitCompleteNetwork(c, animate = false) {
    if (!c.map || !c.bounds?.isValid()) return false;
    const rectangle = query(c, "[data-ps-map]")?.getBoundingClientRect();
    // Hidden tabs have zero layout size. Fitting them would set an unusably
    // low zoom; wait for first actual layout and then preserve the camera.
    if (!rectangle || rectangle.width <= 0 || rectangle.height <= 0) { c.fitPending = true; return false; }
    c.map.invalidateSize({ pan: false });
    const legendOpen = query(c, "[data-ps-action=legend]")?.getAttribute("aria-expanded") === "true";
    const legendPadding = legendOpen && rectangle.width > 620 ? 194 : 18;
    c.map.fitBounds(c.bounds, { paddingTopLeft: [18, 14], paddingBottomRight: [legendPadding, 16], maxZoom: 12, animate });
    c.fitPending = false;
    return true;
  }
  function updateViewport(c) {
    if (!c.map || c.disposed) return;
    c.map.invalidateSize({ pan: false });
    if (c.fitPending) fitCompleteNetwork(c);
    renderCurve(c);
  }
  function isJunction(node) { return node.asset_kind === "junction" || node.kind === "junction" || node.type === 0 || /馈线连接点|连接点/.test(node.name || ""); }
  function setBasemap(c, mode) {
    if (!c.map) return;
    if (c.tiles) c.map.removeLayer(c.tiles);
    c.tiles = null; c.tileErrors = 0; c.tileSuccesses = 0; c.basemap = mode;
    const canvas = query(c, "[data-ps-map]"); canvas.classList.toggle("ps-coordinate-grid", mode === "offline"); canvas.classList.toggle("ps-basemap-light", mode === "light");
    const select = query(c, "[data-ps-basemap]"); if (select) select.value = mode;
    const status = query(c, "[data-ps-background-state]"); status.hidden = true;
    if (mode === "offline") return;
    const L = window.L;
    // Both online presentations use the same standard, key-free OSM service.
    // The light presentation only changes tile styling; engineering layers
    // and saved values are never filtered or altered.
    const url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
    const tiles = L.tileLayer(url, { attribution, maxZoom: 19, crossOrigin: true }); c.tiles = tiles;
    tiles.on("tileload", () => { if (c.tiles === tiles) c.tileSuccesses++; });
    tiles.on("tileerror", () => {
      if (c.tiles !== tiles || ++c.tileErrors < 3 || c.tileSuccesses) return;
      c.map.removeLayer(tiles); c.tiles = null; canvas.classList.add("ps-coordinate-grid");
      const t = tr(c); status.textContent = t("在线底图未能载入，已保留完整电网、地理坐标及计算状态。可切换底图重试。", "Online basemap unavailable. The complete grid, coordinates and saved states remain visible; switch basemap to retry."); status.hidden = false;
    });
    tiles.addTo(c.map);
  }
  function bind(c) {
    c.container.addEventListener("click", c.onClick = event => {
      const mode = event.target.closest("[data-ps-mode]");
      if (mode && !mode.disabled) { c.metric = mode.dataset.psMode; if (c.metric === "impact") { c.showAreas = true; query(c, "[data-ps-areas]").checked = true; } update(c); return; }
      const action = event.target.closest("[data-ps-action]")?.dataset.psAction;
      if (action === "fit") fitCompleteNetwork(c, true);
      if (action === "details") showDetails(c, query(c, "[data-ps-details]").hidden);
      if (action === "close-details") showDetails(c, false);
      if (action === "legend") { const body = query(c, "[data-ps-legend-body]"), button = query(c, "[data-ps-action=legend]"); body.hidden = !body.hidden; button.setAttribute("aria-expanded", String(!body.hidden)); button.querySelector("span").textContent = body.hidden ? "+" : "−"; }
      if (action === "fullscreen") { const panel = query(c, ".power-scene"); panel.classList.toggle("ps-expanded"); query(c, "[data-ps-action=fullscreen]").setAttribute("aria-pressed", String(panel.classList.contains("ps-expanded"))); c.map?.invalidateSize({ pan: false }); }
      if (action === "play") togglePlay(c);
      if (action === "previous") setIndex(c, c.index - 1);
      if (action === "next") setIndex(c, c.index + 1);
      if (action === "clear-selection") { c.selected = null; renderDetails(c); updateMap(c); c.options.onSelect?.(null); }
    });
    query(c, "[data-ps-basemap]").addEventListener("change", event => setBasemap(c, event.target.value));
    query(c, "[data-ps-network]").addEventListener("change", event => { c.showNetwork = event.target.checked; updateMap(c); });
    query(c, "[data-ps-areas]").addEventListener("change", event => { c.showAreas = event.target.checked; updateMap(c); });
    query(c, "[data-ps-labels]").addEventListener("change", event => { c.showLabels = event.target.checked; updateMap(c); });
    query(c, "[data-ps-junctions]").addEventListener("change", event => { c.showJunctions = event.target.checked; updateMap(c); });
    query(c, "[data-ps-voltage]").addEventListener("change", event => { c.voltage = event.target.value; updateMap(c); });
    query(c, "[data-ps-strategy]")?.addEventListener("change", event => { pause(c.container); const hours = timeHours(currentFrame(c)); c.strategyId = event.target.value; const frames = selectedStrategy(c)?.frames || []; c.index = Math.max(0, frames.findLastIndex(frame => timeHours(frame) <= hours + 1e-8)); update(c, true); });
    query(c, "[data-ps-timeline]")?.addEventListener("input", event => { pause(c.container); setIndex(c, Number(event.target.value)); });
    query(c, "[data-ps-speed]")?.addEventListener("change", () => { if (c.timer) { pause(c.container); togglePlay(c); } });
    c.keyListener = event => { if (event.key === "Escape") { query(c, ".power-scene")?.classList.remove("ps-expanded"); query(c, "[data-ps-action=fullscreen]")?.setAttribute("aria-pressed", "false"); showDetails(c, false); c.map?.invalidateSize({ pan: false }); } }; document.addEventListener("keydown", c.keyListener);
  }
  function showDetails(c, open) { const panel = query(c, "[data-ps-details]"); panel.hidden = !open; query(c, "[data-ps-action=details]").setAttribute("aria-expanded", String(open)); if (open) renderDetails(c); }
  function selectAsset(c, row, group) { c.selected = { row, group }; showDetails(c, true); updateMap(c); c.options.onSelect?.({ id: row.item.id, group, item: row.item, frame: currentFrame(c), strategyId: c.strategyId }); }
  function renderDetails(c) {
    const holder = query(c, "[data-ps-detail-content]"), t = tr(c);
    if (!c.selected) {
      holder.innerHTML = `<div class="ps-selection-empty"><span aria-hidden="true">⌖</span><h4>${t("查看电网对象", "Inspect a grid asset")}</h4><p>${t("点击站点、线路或供电分区，查看本轮保存的属性与计算状态。", "Select a station, line or service area to inspect its saved attributes and results.")}</p></div><label class="ps-asset-picker">${t("定位站点", "Locate a station")}<select data-ps-object aria-label="${t("定位站点", "Locate a station")}"><option value="">${t("选择站点…", "Choose a station…")}</option>${c.layers.nodes.filter(row => !row.junction).map(row => `<option value="${esc(row.item.id)}">${esc(row.item.name || row.item.id)}</option>`).join("")}</select></label><details class="ps-source-notes"><summary>${t("案例来源与适用范围", "Case sources & scope")}</summary>${sourceHTML(c.scene.case?.source || c.scene.provenance || c.scene.case?.source_note || c.scene.source_note)}</details>`;
      holder.querySelector("[data-ps-object]")?.addEventListener("change", event => { const row = c.layers.nodes.find(value => String(value.item.id) === event.target.value); if (row) { c.map.setView(row.layer.getLatLng(), Math.max(c.map.getZoom(), 13)); selectAsset(c, row, "node"); } });
      return;
    }
    const { row, group } = c.selected, item = row.item, properties = item.properties || {}, fields = [];
    const damageValue = assetValue(c, item, group === "edge" ? "branch" : "node", "damage");
    const damageLabel = c.scene.damage?.state_labels?.[damageValue] || damageValue;
    if (group === "area") {
      const state = areaState(c, item);
      fields.push([t("类型", "Type"), t("供电服务分区", "Supply service area")], [t("供电状态", "Supply status"), statusLabel(c, state.status)], [t("供电比例", "Supply ratio"), percent(state.supply_ratio ?? state.served_ratio)], [t("分区人口", "Area population"), num(state.population ?? properties.population, 0)], [t("等效受影响人口", "Equivalent affected population"), num(state.affected_population_equivalent, 0)], [t("分区面积", "Area"), finite(properties.area_km2) ? `${num(properties.area_km2, 2)} km²` : "—"]);
    } else {
      const supplyLabel = group === "node" && finite(item.demand_mw) && item.demand_mw > 0 ? t("负荷供电比例", "Served-load ratio") : t("带电连通状态", "Energized connectivity");
      fields.push([t("对象编号", "Asset ID"), item.id], [t("类型", "Type"), group === "edge" ? (item.asset_kind || properties.asset_kind || t("电网支路", "Grid branch")) : isJunction(item) ? t("馈线连接点", "Feeder junction") : (item.asset_kind || properties.asset_kind || t("站点 / 设备组", "Station / equipment group"))], [t("电压等级", "Voltage"), finite(item.voltage_kv) ? `${item.voltage_kv} kV` : "—"], [t("损伤状态", "Damage state"), objectText(damageLabel)], [supplyLabel, percent(assetValue(c, item, group === "edge" ? "branch" : "node", "function"))]);
      if (group === "edge") fields.push([t("连接节点", "Connected nodes"), `${item.source ?? item.from_node} → ${item.target ?? item.to_node}`], [t("路线依据", "Route basis"), item.geometry_basis || properties.geometry_basis || (row.schematic ? t("无保存路线，仅拓扑示意", "Schematic connection; route not recorded") : t("保存的地理路线", "Saved geographic route"))]);
      else fields.push([t("经纬度", "Coordinates"), `${num(item.longitude, 6)}, ${num(item.latitude, 6)}`], [t("参考负荷", "Reference demand"), finite(item.demand_mw) ? `${num(item.demand_mw)} MW` : "—"]);
      const task = selectedStrategy(c)?.schedule.find(entry => String(entry.id) === String(item.result_id ?? item.id) && entry.group === (group === "edge" ? "pipe" : "node"));
      if (task) fields.push([t("维修队", "Repair crew"), task.team], [t("修复窗口", "Repair window"), `${num(task.start_day)} — ${num(task.end_day)} ${t("天", "days")}`]);
    }
    const assumptions = item.assumptions || properties.assumptions || (properties.synthetic ? [t("部分工程属性采用参考假设，详见来源记录。", "Some engineering attributes use reference assumptions; see source records.")] : []);
    holder.innerHTML = `<span class="ps-detail-kind">${group === "area" ? t("服务分区", "SERVICE AREA") : group === "edge" ? t("线路 / 连接", "LINE / CONNECTION") : t("站点 / 设备", "STATION / EQUIPMENT")}</span><h4>${esc(item.name || item.id)}</h4><dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(objectText(value))}</dd>`).join("")}</dl><details class="ps-source-notes"><summary>${t("资料来源与建模依据", "Sources & modelling basis")}</summary>${sourceHTML((group === "edge" ? item.data_source : item.source) || item.sources || item.provenance || properties.source || properties.sources || c.scene.case?.source || c.scene.case?.source_note)}${assumptions.length ? `<h5>${t("参考假设", "Reference assumptions")}</h5>${sourceHTML(assumptions)}` : ""}${properties.uncertainty ? `<h5>${t("适用范围", "Scope")}</h5>${sourceHTML(properties.uncertainty)}` : ""}</details>${button("clear-selection", t("清除选择", "Clear selection"), t("返回对象列表", "Back to object list"), "class='ps-clear-selection'")}`;
  }
  function statusLabel(c, status) { const t = tr(c); return ({ full_outage: t("完全失供", "Full outage"), partial_outage: t("部分失供", "Partial outage"), grid_supplied: t("电网供电", "Grid supplied"), supplied: t("已供电", "Supplied"), unknown: t("未知 / 未映射", "Unknown / unmapped"), not_assessed: t("尚未评估", "Not assessed") })[status] || status || t("未记录", "Not recorded"); }
  function updateMap(c) {
    if (!c.map) return;
    const voltage = c.voltage;
    const show = (group, layer, visible) => { const present = group.hasLayer(layer); if (visible && !present) group.addLayer(layer); else if (!visible && present) group.removeLayer(layer); };
    c.layers.edges.forEach(row => {
      const selected = c.selected?.row === row, color = assetColor(c, row.item, "branch");
      row.layer.setStyle({ color: selected ? "#122b38" : color, weight: selected ? 4 : Number(row.item.voltage_kv) >= 100 ? 2.3 : 1.35, opacity: c.metric === "impact" ? .65 : .82, dashArray: row.schematic || /literature|schematic|文献|示意/.test(row.item.geometry_basis || "") ? "5 4" : null });
      show(c.edgeGroup, row.layer, c.showNetwork && (voltage === "all" || Number(row.item.voltage_kv) === Number(voltage)));
    });
    c.layers.nodes.forEach(row => {
      const selected = c.selected?.row === row, color = assetColor(c, row.item, "node");
      row.layer.setStyle({ fillColor: color, color: selected ? "#153441" : "#fff", radius: selected ? 7.5 : row.junction ? 2 : Number(row.item.voltage_kv) >= 100 ? 5 : 4, weight: selected ? 2.5 : row.junction ? 0 : 1.2, fillOpacity: row.junction ? .78 : 1 });
      show(c.nodeGroup, row.layer, c.showNetwork && (!row.junction || c.showJunctions || selected) && (voltage === "all" || Number(row.item.voltage_kv) === Number(voltage)));
      const tooltip = row.layer.getTooltip(); if (tooltip && Boolean(tooltip.options.permanent) !== (c.showLabels && !row.junction)) { row.layer.unbindTooltip(); row.layer.bindTooltip(esc(row.item.name || row.item.id), { permanent: c.showLabels && !row.junction, direction: "top", className: "ps-tooltip" }); }
    });
    c.layers.areas.forEach(row => { const state = areaState(c, row.item), selected = c.selected?.row === row, unknown = state.status === "unknown"; row.layer.setStyle({ fillColor: stateColor(state.status), color: selected ? "#183b49" : stateColor(state.status), fillOpacity: unknown ? .08 : c.metric === "impact" ? .27 : .1, weight: selected ? 2.5 : .8, dashArray: unknown ? "3 5" : null }); show(c.areaGroup, row.layer, c.showAreas); });
  }
  function renderKPIs(c) {
    const t = tr(c), strategy = selectedStrategy(c), ratio = frameRatio(c), impact = impactFrame(c)?.summary || c.scene.impact.initial_summary || {}, coverage = impactStrategy(c)?.coverage || c.scene.impact.coverage || {};
    const preSupply = c.scene.function?.pre_supply_mw ?? c.scene.pre_supply_mw;
    const initial = !currentFrame(c) || timeHours(currentFrame(c)) === 0;
    const supply = currentFrame(c)?.supply_mw ?? currentFrame(c)?.served_mw ?? (initial ? c.scene.function?.post_supply_mw : null);
    const derivedSupply = supply == null && finite(ratio) && finite(preSupply) ? ratio * preSupply : null;
    const rows = strategy || c.scene.has_results || c.scene.status === "ready" ? [[t("供电功能", "Supply function"), percent(ratio), t("相对震前供电基准", "Relative to pre-event supply")], [t("当前供电", "Current supply"), finite(supply ?? derivedSupply) ? `${num(supply ?? derivedSupply)} <em>MW</em>` : "—", finite(derivedSupply) ? t("保存功能比 × 震前基准", "Saved function × pre-event baseline") : t("保存的模型供电功率", "Saved model supply")], [t("等效受影响人口", "Equivalent affected population"), num(impact.affected_population_equivalent, 0), t("已映射分区 · 空间模型", "Mapped service areas · spatial model")], [t("人口映射覆盖", "Population mapping coverage"), percent(coverage.population_coverage_ratio), `${t("未映射", "Unmapped")} ${num(coverage.unmapped_population, 0)} ${t("人", "people")}`]] : [[t("电网节点", "Grid nodes"), num(c.scene.network.nodes.length, 0), t("保留完整地理范围", "Complete geographic extent")], [t("电网支路", "Grid branches"), num(c.scene.network.edges.length, 0), t("真实路线与拓扑连接", "Saved routes and topology")], [t("电压范围", "Voltage range"), (() => { const v = c.scene.network.nodes.map(row => row.voltage_kv).filter(finite); return v.length ? `${Math.min(...v)}–${Math.max(...v)} <em>kV</em>` : "—"; })(), t("多电压层级电网", "Multiple voltage levels")], [t("人口映射覆盖", "Population mapping coverage"), percent(coverage.population_coverage_ratio), coverage.unmapped_population == null ? t("计算后显示影响指标", "Impact metrics follow computation") : `${t("未映射", "Unmapped")} ${num(coverage.unmapped_population, 0)} ${t("人", "people")}`]];
    query(c, "[data-ps-kpis]").innerHTML = rows.map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${esc(note)}</small></div>`).join("");
  }
  function renderLegend(c) {
    const t = tr(c), keys = c.metric === "voltage" ? [["#85528e", "220 kV"], ["#357baa", "110 kV"], ["#138b83", "33 kV"], ["#c28b40", "22 kV"]] : c.metric === "damage" ? [[palette.teal, t("完好 / 基本完好", "Intact / operational")], ["#a9a344", t("轻微破坏", "Slight")], [palette.amber, t("中等破坏", "Moderate")], [palette.red, t("严重破坏", "Extensive")], ["#852c39", t("完全破坏", "Complete")]] : [[palette.teal, t("供电 / 带电连通", "Supplied / energized")], [palette.amber, t("部分失供", "Partial outage")], [palette.red, t("失供 / 未带电", "Outage / de-energized")], [palette.grey, t("未知 / 未映射", "Unknown / unmapped")]];
    const supplyNote = ["supply", "impact"].includes(c.metric) ? `<small>${t("负荷节点显示供电比；零负荷节点及支路显示带电连通，不代表线路潮流MW。", "Loaded nodes show served-load ratios; zero-load nodes and branches show energized connectivity, not line-flow MW.")}</small>` : "";
    query(c, "[data-ps-color-key]").innerHTML = keys.map(([color, label]) => `<span><i style="--ps-key:${color}"></i>${label}</span>`).join("") + `<small>${t("实线：保存路线 · 虚线：文献或拓扑连接", "Solid: saved route · dashed: documented or schematic link")}</small>${supplyNote}`;
  }
  function renderCurve(c) {
    const holder = query(c, "[data-ps-curve]"); if (!holder) return;
    const t = tr(c), width = Math.max(280, Math.round(holder.getBoundingClientRect().width) || 880), left = 42, right = width - 22, top = 12, bottom = 99, strategies = c.scene.recovery.strategies;
    const maxTime = Math.max(1, ...strategies.flatMap(row => row.curve.map(point => Number(point.time ?? point.time_day ?? 0))));
    const x = time => left + time / maxTime * (right - left), y = ratio => bottom - ratio * (bottom - top);
    const paths = strategies.map(row => {
      let path = "", previous = false;
      row.curve.forEach(point => { const value = point.function ?? point.function_ratio, time = point.time ?? point.time_day; if (!finite(value) || !finite(time)) { previous = false; return; } path += `${previous ? "H" : "M"}${x(time)}${previous ? "V" : ","}${y(value)} `; previous = true; });
      return `<path d="${path}" fill="none" stroke="${strategyColors[row.id] || palette.blue}" stroke-width="${row.id === c.strategyId ? 2.8 : 1.5}" opacity="${row.id === c.strategyId ? 1 : .65}"/>`;
    }).join("");
    const day = timeHours(currentFrame(c)) / 24;
    holder.innerHTML = `<div class="ps-curve-legend">${strategies.map(row => `<span style="--ps-key:${strategyColors[row.id] || palette.blue}"><i></i>${esc(row.name || row.id)}</span>`).join("")}<small>${t("点击曲线定位保存时刻", "Click to locate a saved event")}</small></div><svg viewBox="0 0 ${width} 125" role="img" aria-label="${t("三种策略供电功能恢复曲线", "Supply recovery curves for three repair strategies")}"><path d="M${left} ${top}H${right} M${left} ${y(.5)}H${right} M${left} ${bottom}H${right}" class="ps-chart-grid"/><text x="4" y="16">100%</text><text x="10" y="${y(.5) + 4}">50%</text><text x="17" y="${bottom + 4}">0%</text>${paths}<path d="M${x(day)} ${top}V${bottom}" class="ps-chart-cursor"/><text x="${left}" y="120">0</text><text x="${right}" y="120" text-anchor="end">${num(maxTime)} ${t("天", "days")}</text><rect x="${left}" y="${top}" width="${right - left}" height="${bottom - top}" fill="transparent" data-ps-curve-hit style="cursor:crosshair"/></svg>`;
    holder.querySelector("[data-ps-curve-hit]").addEventListener("click", event => { const rect = event.target.getBoundingClientRect(), day = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * maxTime, frames = selectedStrategy(c)?.frames || []; pause(c.container); setIndex(c, frames.reduce((best, frame, index) => Math.abs(timeHours(frame) / 24 - day) < Math.abs(timeHours(frames[best]) / 24 - day) ? index : best, 0)); });
  }
  function update(c, curve = false) {
    if (c.disposed) return;
    c.container.querySelectorAll("[data-ps-mode]").forEach(button => { const active = button.dataset.psMode === c.metric; button.classList.toggle("is-active", active); button.setAttribute("aria-pressed", String(active)); });
    updateMap(c); renderKPIs(c); renderLegend(c); if (c.selected) renderDetails(c);
    const t = tr(c), frame = currentFrame(c), frames = selectedStrategy(c)?.frames || [], day = timeHours(frame) / 24;
    const slider = query(c, "[data-ps-timeline]"); if (slider) { slider.max = String(Math.max(0, frames.length - 1)); slider.value = String(c.index); slider.disabled = !frames.length; }
    const label = query(c, "[data-ps-frame-time]"); if (label) label.textContent = `${num(day)} / ${num(timeHours(frames.at(-1)) / 24)} ${t("天", "days")}`;
    query(c, "[data-ps-time]").textContent = frame ? `${t("震后", "Day")} ${num(day)} ${t("天", "")} · ${num(c.index + 1, 0)}/${num(frames.length, 0)}` : t("已发布地理数据", "Published geographic data");
    if (curve || query(c, "[data-ps-curve]")) renderCurve(c);
    for (const action of ["previous", "next", "play"]) { const button = query(c, `[data-ps-action=${action}]`); if (button) button.disabled = !frames.length || (action === "previous" && c.index <= 0) || (action === "next" && c.index >= frames.length - 1); }
    c.options.onFrame?.({ index: c.index, frame, strategyId: c.strategyId, impactFrame: impactFrame(c) });
  }
  function setIndex(c, index) { const frames = selectedStrategy(c)?.frames || []; c.index = Math.max(0, Math.min(Math.max(0, frames.length - 1), index)); update(c); }
  function togglePlay(c) {
    if (c.timer) { pause(c.container); return; }
    const frames = selectedStrategy(c)?.frames || []; if (!frames.length) return;
    if (c.index >= frames.length - 1) setIndex(c, 0);
    const t = tr(c), button = query(c, "[data-ps-action=play]"); button.innerHTML = `<span aria-hidden="true">Ⅱ</span><span>${t("暂停", "Pause")}</span>`; button.setAttribute("aria-pressed", "true");
    c.timer = setInterval(() => { if (document.hidden || !c.container.isConnected || !c.container.getClientRects().length) { pause(c.container); return; } setIndex(c, c.index + 1); if (c.index >= frames.length - 1) pause(c.container); }, Number(query(c, "[data-ps-speed]")?.value) || 400);
  }
  function pause(container) { const c = mounts.get(container); if (!c) return; clearInterval(c.timer); c.timer = null; const button = query(c, "[data-ps-action=play]"); if (button) { const t = tr(c); button.innerHTML = `<span aria-hidden="true">▶</span><span>${t("播放", "Play")}</span>`; button.setAttribute("aria-pressed", "false"); } }
  function destroy(container) { const c = mounts.get(container); if (!c) return; pause(container); c.disposed = true; c.resizeObserver?.disconnect(); document.removeEventListener("visibilitychange", c.visibilityListener); document.removeEventListener("keydown", c.keyListener); container.removeEventListener("click", c.onClick); c.map?.remove(); mounts.delete(container); }
  function mount(container, scene, options = {}) {
    if (!container || !scene) return null;
    const data = normalizedScene(scene), key = JSON.stringify([data.run_id, data.dataset_fingerprint, data.case?.version_id || data.dataset_version, options.language || "zh-CN"]), old = mounts.get(container);
    if (old?.key === key) { old.options = options; if (options.view && old.lastView !== options.view) old.setView(options.view); updateViewport(old); return old; }
    destroy(container);
    const preferred = options.strategy || data.recovery.recommended_strategy || data.recommended_strategy || (data.recovery.strategies.some(row => row.id === "ga") ? "ga" : data.recovery.strategies[0]?.id);
    const c = { container, scene: data, options, key, strategyId: preferred, index: 0, metric: viewMetric(options.view), lastView: options.view, showNetwork: true, showAreas: options.view === "impact", showJunctions: false, showLabels: false, voltage: "all", nodeById: byId(data.network.nodes), invalidGeometries: 0, disposed: false, timer: null };
    c.destroy = () => destroy(container);
    c.pause = () => pause(container);
    c.resize = () => resize(container);
    c.setView = view => { c.lastView = view; c.setMode(viewMetric(view)); };
    c.setMode = mode => { const metric = ["voltage", "damage", "supply", "impact"].includes(mode) ? mode : viewMetric(mode); c.metric = metricAvailable(c, metric) ? metric : "voltage"; if (c.metric === "impact") { c.showAreas = true; const toggle = query(c, "[data-ps-areas]"); if (toggle) toggle.checked = true; } update(c); };
    c.setFrame = index => { pause(container); setIndex(c, Number(index)); };
    c.select = (id, group = "node") => {
      const type = group === "area" ? "area" : ["edge", "pipe", "branch"].includes(group) ? "edge" : "node";
      const row = (type === "area" ? c.layers.areas : type === "edge" ? c.layers.edges : c.layers.nodes).find(item => String(item.item.id) === String(id));
      if (!row) return;
      if (type === "area") { c.showAreas = true; query(c, "[data-ps-areas]").checked = true; }
      else { c.showNetwork = true; c.voltage = "all"; query(c, "[data-ps-network]").checked = true; query(c, "[data-ps-voltage]").value = "all"; }
      selectAsset(c, row, type);
      const bounds = row.layer.getBounds?.();
      if (type === "node") c.map?.setView(row.layer.getLatLng(), Math.max(c.map.getZoom(), 13));
      else if (bounds?.isValid()) c.map?.fitBounds(bounds, { maxZoom: 14, padding: [30, 30] });
    };
    if (!metricAvailable(c, c.metric)) c.metric = "voltage";
    mounts.set(container, c); render(c); return c;
  }
  function viewMetric(view) { return ({ damage: "damage", function: "supply", supply: "supply", impact: "impact", recovery: "supply" })[view] || "voltage"; }
  function resize(container) { const c = mounts.get(container); if (c) updateViewport(c); }
  function captureState(container) { const c = mounts.get(container); if (!c) return null; return { strategyId: c.strategyId, index: c.index, metric: c.metric, center: c.map?.getCenter(), zoom: c.map?.getZoom(), selectedId: c.selected?.row.item.id }; }
  window.PowerScene = { mount, destroy, pause, resize, captureState, utils: { normalizedScene, timeHours, atOrBefore, voltageColor, damageColor, supplyColor, stateColor } };
})();
