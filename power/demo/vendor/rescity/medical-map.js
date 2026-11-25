/* Geographic point results: verified coordinates and model outputs, never inferred surfaces. */
(() => {
  "use strict";
  const mounts = new WeakMap(), cache = new Map();
  let gridArrowSerial = 0;
  const rows = value => Array.isArray(value) ? value : [];
  const resultNotes = values => window.MedicalDisplayLabels?.resultNotes?.(rows(values)) || rows(values);
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const tr = language => (zh, en) => String(language).startsWith("en") ? en : zh;
  const number = (value, digits = 2) => finite(value) ? (value === 0 ? 0 : value).toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
  const percent = value => finite(value) ? `${number(value * 100, 1)}%` : "—";
  const validPoint = row => (!row.coordinate_status || row.coordinate_status === "available") && finite(row.longitude) && finite(row.latitude) && Math.abs(row.longitude) <= 180 && Math.abs(row.latitude) <= 90;
  const DEFAULT_COLORS = ["#89aee8", "#6090d4", "#3973bf", "#1858a8", "#083a7d"];
  const HOSPITAL_GREEN = "#007a43";
  const TRAVEL_COLORS = ["#174e91", "#5284bb", "#929cab", "#bd8529", "#993c17"];
  const CHANGE_COLORS = ["#993c17", "#c98951", "#99a6b5", "#5788c7", "#174e91"];
  const MISSING_COLOR = "#a8b1b4";
  const DIFFERENCE_METHOD = "pre_event_capacity_with_same_scenario_travel_times";
  const afterPaint = fn => typeof window.requestAnimationFrame === "function" ? window.requestAnimationFrame(fn) : fn();

  function identity(options) {
    return JSON.stringify([String(options.sessionId), Number(options.iteration || 1), options.language || "zh-CN"]);
  }
  function request(options, force = false) {
    const key = identity(options), signature = String(options.sourceSignature || "");
    const existing = cache.get(key);
    if (!force && existing?.signature === signature) return existing;
    const entry = { signature, data: null, error: null };
    const query = new URLSearchParams({ iteration: String(options.iteration || 1), display_language: options.language || "zh-CN" });
    entry.promise = fetch(`/api/engineering/native/sessions/${encodeURIComponent(options.sessionId)}/medical-map?${query}`, { cache: "no-store" })
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (String(data.session_id) !== String(options.sessionId) || Number(data.iteration) !== Number(options.iteration || 1)) throw new Error("Result identity mismatch");
        if (!Array.isArray(data.scenarios)) throw new Error("Missing scenario results");
        entry.data = data;
      }).catch(error => { entry.error = error; });
    cache.set(key, entry);
    while (cache.size > 12) cache.delete(cache.keys().next().value);
    return entry;
  }
  function current(context) { return mounts.get(context.container) === context && context.container.isConnected !== false; }
  function scenarioFor(data, selected) {
    if (selected === undefined || selected === null || selected === "") return rows(data.scenarios)[0] || null;
    return rows(data.scenarios).find(scenario => String(scenario.scenario_id) === String(selected)) || null;
  }
  function metricValue(context, row, kind) {
    const { layer, period, data } = context;
    if (layer === "hospital") {
      if (kind !== "hospital" || !finite(row.weighted_pre_capacity) || row.weighted_pre_capacity <= 0) return null;
      const post = finite(row.weighted_post_capacity) ? row.weighted_post_capacity / row.weighted_pre_capacity : null;
      return period === "before" ? 1 : period === "after" ? post : finite(post) ? (post - 1) * 100 : null;
    }
    if (kind !== "demand") return null;
    if (layer === "travel") {
      if (!finite(row.nearest_minutes)) return null;
      return period === "change" ? data.basis?.baseline === DIFFERENCE_METHOD ? 0 : null : row.nearest_minutes;
    }
    const before = row.baseline_accessibility, after = row.post_accessibility;
    return period === "before" ? finite(before) ? before : null : period === "after" ? finite(after) ? after : null : finite(before) && finite(after) ? after - before : null;
  }
  function descriptor(context) {
    const { t, layer, period, data } = context;
    const change = period === "change";
    const title = layer === "travel" ? t("最近医院到院时间", "Time to nearest hospital") : layer === "hospital" ? t("医院能力保留", "Hospital capacity retained") : t("居民医疗可达性", "Population healthcare accessibility");
    const unit = layer === "travel" ? t("分钟", "minutes") : layer === "hospital" ? change ? t("百分点", "percentage points") : "%" : t("2SFCA 指数", "2SFCA index");
    const values = rows(data.scenarios).flatMap(scenario => rows(layer === "hospital" ? scenario.hospitals : scenario.demand_nodes).map(row => metricValue(context, row, layer === "hospital" ? "hospital" : "demand"))).filter(finite);
    let domain = values.length ? [0, Math.max(0, ...values)] : null;
    let colors = layer === "travel" ? TRAVEL_COLORS : DEFAULT_COLORS;
    if (layer === "accessibility" && !change) {
      const supplied = data.color_scales?.accessibility;
      if (rows(supplied?.domain).length === 2 && supplied.domain.every(finite)) domain = [...supplied.domain];
      else {
        const all = rows(data.scenarios).flatMap(scenario => rows(scenario.demand_nodes).flatMap(row => [row.baseline_accessibility, row.post_accessibility])).filter(finite);
        domain = all.length ? [0, Math.max(0, ...all)] : null;
      }
      // Retain the result's numeric scale, while using a legible population palette
      // distinct from green hospital capacity rings, including older saved results.
      colors = DEFAULT_COLORS;
    }
    if (layer === "hospital" && !change) {
      const ratios = rows(data.scenarios).flatMap(scenario => rows(scenario.hospitals).map(row => finite(row.weighted_pre_capacity) && row.weighted_pre_capacity > 0 && finite(row.weighted_post_capacity) ? row.weighted_post_capacity / row.weighted_pre_capacity : null)).filter(finite);
      domain = values.length || ratios.length ? [0, Math.max(1, ...ratios)] : null;
    }
    if (change && values.length) { const max = Math.max(...values.map(Math.abs)); domain = max ? [-max, max] : [0, 0]; colors = CHANGE_COLORS; }
    return { title, unit, domain, colors, values };
  }
  function colorFor(value, desc) {
    if (!finite(value) || !desc.domain) return MISSING_COLOR;
    const [min, max] = desc.domain;
    if (max === min) return desc.colors[min === 0 && desc.colors === CHANGE_COLORS ? 2 : 0];
    const position = Math.min(1, Math.max(0, (value - min) / (max - min))) * (desc.colors.length - 1);
    const index = Math.min(desc.colors.length - 2, Math.floor(position)), fraction = position - index;
    return "#" + [1, 3, 5].map(offset => {
      const first = parseInt(desc.colors[index].slice(offset, offset + 2), 16);
      const second = parseInt(desc.colors[index + 1].slice(offset, offset + 2), 16);
      return Math.round(first + (second - first) * fraction).toString(16).padStart(2, "0");
    }).join("");
  }
  function metricText(context, value, units = false) {
    const formatted = context.layer === "hospital" && context.period !== "change" ? percent(value) : number(value, context.layer === "accessibility" ? 4 : 2);
    return `${context.period === "change" && finite(value) && value > 0 ? "+" : ""}${formatted}${units && !(context.layer === "hospital" && context.period !== "change") ? ` ${descriptor(context).unit}` : ""}`;
  }
  function recordName(row, kind, t) {
    return kind === "hospital" ? row.hospital_name || row.hospital_id || t("未命名医院", "Unnamed hospital") : row.node_name || row.name || row.node_id || t("未命名居民点", "Unnamed population point");
  }
  function findRecord(context, key) {
    const [type, rawIndex] = String(key).split(":"), index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || !["d", "h"].includes(type)) return null;
    const kind = type === "h" ? "hospital" : "demand";
    const row = rows(kind === "hospital" ? context.scenario.hospitals : context.scenario.demand_nodes)[index];
    return row ? { row, kind, key: `${type}:${index}` } : null;
  }
  function pointRecords(context) {
    return [
      ...rows(context.scenario.demand_nodes).map((row, index) => ({ row, kind: "demand", key: `d:${index}` })),
      ...rows(context.scenario.hospitals).map((row, index) => ({ row, kind: "hospital", key: `h:${index}` })),
    ];
  }
  function highlightedDemandKeys(context) {
    if (context.layer !== "accessibility" || context.period !== "after") return [];
    return rows(context.scenario.weak_nodes).filter(row => finite(row.population) && row.population > 0 && finite(row.post_accessibility) && validPoint(row)).slice(0, 3)
      .map(row => rows(context.scenario.demand_nodes).findIndex(node => String(node.node_id) === String(row.node_id))).filter(index => index >= 0).map(index => `d:${index}`);
  }
  function highlightedHospitalKeys(context) {
    if (!context.compact || context.layer !== "hospital" || context.period !== "after") return [];
    return rows(context.scenario.hospitals).map((row, index) => ({ row, index, ratio: metricValue(context, row, "hospital") }))
      .filter(item => validPoint(item.row) && finite(item.ratio) && item.ratio < 1)
      .sort((a, b) => a.ratio - b.ratio).slice(0, 3).map(item => `h:${item.index}`);
  }
  function stateHTML(context, status) {
    const t = context.t;
    const title = status === "loading" ? t("正在加载医疗服务地图", "Loading the healthcare map") : status === "error" ? t("地图结果暂时未能加载", "Map results could not be loaded") : t("所选情景暂无地图结果", "No map results for this scenario");
    const copy = status === "loading" ? t("读取本轮已完成的计算结果与坐标。", "Reading completed results and coordinates for this round.") : status === "error" ? t("请重试加载；下面的工程图表仍可查看。", "Try again. The engineering figures below remain available.") : t("当前任务与轮次没有该情景的空间结果。", "This task and round have no spatial results for the selected scenario.");
    return `<section class="medical-map-state" role="status"><strong>${title}</strong><p>${copy}</p>${status === "error" ? `<button type="button" data-medical-map-action="retry">${t("重新加载", "Retry")}</button>` : ""}</section>`;
  }
  function scopeHTML(context) {
    const t = context.t, hospitals = rows(context.scenario.hospitals), demands = rows(context.scenario.demand_nodes);
    const locatedH = hospitals.filter(validPoint).length, locatedD = demands.filter(validPoint).length;
    const population = demands.filter(validPoint).reduce((sum, row) => sum + (finite(row.population) ? row.population : 0), 0);
    const missing = [];
    if (hospitals.length > locatedH) missing.push(t(`${hospitals.length - locatedH} 家医院`, `${hospitals.length - locatedH} hospitals`));
    if (demands.length > locatedD) missing.push(t(`${demands.length - locatedD} 个居民点`, `${demands.length - locatedD} population points`));
    return `<span>${t(`已定位：${locatedH}/${hospitals.length} 家医院 · ${locatedD}/${demands.length} 个居民点`, `Located: ${locatedH}/${hospitals.length} hospitals · ${locatedD}/${demands.length} population points`)}</span><span>${context.compact ? t("仅展示本次录入范围", "Input assessment scope only") : t(`已定位人口 ${number(population, 0)} 人 · 仅本次录入范围`, `Located population: ${number(population, 0)} · input scope only`)}</span>${missing.length ? `<strong>${esc(missing.join(t("、", ", ")))}${t("缺少有效坐标，暂未显示在图上。", " lack valid coordinates and are not shown on the map.")}</strong>` : ""}`;
  }
  function explanation(context) {
    const { t, layer, period, data } = context;
    if (layer === "travel") return data.basis?.baseline === DIFFERENCE_METHOD
      ? t("前后沿用同一份情景通行时间。变化为 0 表示采用相同输入，不代表地震没有影响道路；本图不含独立道路损伤计算。到达医院也不保证救治容量充足。", "Both periods use the same scenario travel-time inputs. A zero change means shared inputs, not undamaged roads; no separate road-damage model is included. Reaching a hospital does not guarantee sufficient capacity.")
      : t("显示输入通行时间至最近医院的结果，未提供独立的前后通行变化；变化保持缺失。到院时间不代表实际救护车响应时间。", "Shows input travel time to the nearest hospital. Separate before/after travel inputs are unavailable, so changes remain missing. This is not an observed ambulance response time.");
    if (layer === "hospital") return t("每个同尺寸圆点代表一家医院。绿色圆弧长度表示 72 小时加权模型能力相对震前的保留率：100%为整圈，50%为半圈，0%没有绿色圆弧；灰色虚线表示指标缺失。变化视图仍用圆弧表示震后保留率，点击可查看后−前的百分点差。超过100%时圆弧显示为整圈，详情保留原值。模型能力比不等于实际收治人数，震前能力为0时比值保持缺失。", "Each equally sized point represents one hospital. The green arc shows weighted 72-hour capacity retained relative to baseline: full at 100%, half at 50%, absent at 0%; a dashed grey ring indicates missing data. In the change view the arc still shows post-event capacity retained; select to see the percentage-point difference. Ratios above 100% have a full ring and retain their actual value in the details. This ratio is not actual admissions; a zero baseline remains missing.");
    return period === "change"
      ? t("颜色表示震后−震前的 2SFCA 指数差，负值表示服务可达性降低。两期采用同一份情景通行时间，因此变化体现医院能力变化；只展示录入居民点，不推算连续面。", "Colour shows the after-minus-before change in 2SFCA: negative values indicate reduced service accessibility. Both periods use the same scenario travel times, so changes reflect hospital capacity. Only actual population points are shown, without an interpolated surface.")
      : t("2SFCA 同时考虑医院能力、人口需求与通行时间。震前基准采用震前医院能力和同一份情景通行时间；前后及不同情景共用色标，颜色越深指数越高，不代表实际就医人数。", "2SFCA combines hospital capacity, population demand and travel time. The baseline uses pre-event hospital capacity with the same scenario travel times. Periods and scenarios share one colour scale; darker points have higher index values, not higher actual treatment counts.");
  }
  function legendHTML(context) {
    const { t } = context, desc = descriptor(context);
    const sample = desc.domain && desc.domain[0] === desc.domain[1] ? [desc.domain[0]] : desc.domain ? [desc.domain[0], (desc.domain[0] + desc.domain[1]) / 2, desc.domain[1]] : [];
    const highlighted = highlightedDemandKeys(context).length, hospitalHighlights = highlightedHospitalKeys(context).length;
    const title = context.layer === "hospital" ? context.period === "before" ? t("震前医院能力（基准）", "Baseline hospital capacity") : t("震后医院能力保留", "Post-event hospital capacity retained") : `${desc.title}${context.period === "change" ? t("变化", " change") : ""}`;
    const gradient = sample.length === 1 ? colorFor(sample[0], desc) : `linear-gradient(90deg,${desc.colors.join(",")})`;
    const example = fraction => hospitalRingSVG({ period: "after" }, { weighted_pre_capacity: 1, weighted_post_capacity: fraction });
    const examples = `<div class="medical-map-progress-key" aria-label="${t("医院能力保留率图例", "Hospital capacity retained legend")}">${[0, 0.5, 1].map(fraction => `<span><i class="medical-map-ring-example" aria-hidden="true">${example(fraction)}</i><b>${percent(fraction)}</b></span>`).join("")}</div><p class="medical-map-progress-meaning">${t("绿圈越完整，医院保留的诊疗能力越多。", "More of the green ring means more hospital capacity is retained.")}</p>`;
    return `<div class="medical-map-legend-heading"><strong>${title}</strong><span>${context.layer === "hospital" ? "%" : desc.unit}</span></div>${context.layer === "hospital" ? examples : sample.length ? `<div class="medical-map-colorbar" style="background:${gradient}"></div><div class="medical-map-scale-labels">${sample.map(value => `<span>${metricText(context, value)}</span>`).join("")}${sample.length === 1 ? `<span>${t("全部同值", "All values equal")}</span>` : ""}</div>` : `<p>${t("本图层缺少可用指标", "No available values for this layer")}</p>`}<div class="medical-map-symbol-key">${context.layer !== "hospital" ? `<span><i class="medical-map-ring-example" aria-hidden="true">${example(1)}</i>${t("医院（绿环表示能力保留）", "Hospital (ring shows capacity retained)")}</span>` : ""}${context.layer === "hospital" ? `<label class="medical-map-population-toggle"><input type="checkbox" data-medical-map-population ${context.showPopulation ? "checked" : ""}><i class="medical-map-person-key" aria-hidden="true">${window.MedicalMapSymbols.populationSVG({ color: "#235ba8" })}</i>${t("显示居民点", "Show population points")}</label>` : `<span><i class="medical-map-person-key" aria-hidden="true">${window.MedicalMapSymbols.populationSVG({ color: "#235ba8" })}</i>${t("居民点", "Population point")}</span>`}<span><i class="medical-map-ring-example is-missing" aria-hidden="true">${hospitalRingSVG({ period: "after" }, { weighted_pre_capacity: 1, weighted_post_capacity: null })}</i>${t("指标缺失", "Missing value")}</span>${highlighted ? `<span class="medical-map-ranked-key"><i class="medical-map-person-key" aria-hidden="true">${window.MedicalMapSymbols.populationSVG({ color: "#235ba8", emphasis: true })}</i>${t("橙色描边：服务指数较低的居民点", "Orange outline: lower service index")}</span>` : ""}${hospitalHighlights ? `<span class="medical-map-ranked-key"><i class="medical-map-priority-key" aria-hidden="true"></i>${t("橙色角标：本次能力下降较多的医院", "Orange dot: larger capacity decreases in this assessment")}</span>` : ""}</div>${context.compact ? `<label class="medical-map-population-toggle"><input type="checkbox" data-medical-map-connection ${context.showConnection ? "checked" : ""}>${t("显示居民到医院的联系", "Show population-to-hospital links")}</label>` : ""}<p class="medical-map-link-note">${t("每个小人代表一个人口片区，人数可点击查看；弧形箭头按录入到院时间指向最近医院。默认显示全部可定位的最近到院联系；可切换简洁示意或只看所选对象。点击小人或医院可突出相关联系。", "Each person represents a population area, not one resident; select it to see the population. Curved arrows point to the nearest hospital by recorded travel time. All drawable nearest-hospital links are shown by default. Switch to a concise diagram or selected-only view; select a person or hospital to highlight its links.")} <span>${t("联系示意，不表示实际道路或就医分配。", "Links indicate a relationship, not a road route or patient allocation.")}</span></p><p class="medical-map-density-note" data-medical-map-density-note></p>`;
  }
  function rowsHTML(items) { return `<dl>${items.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join("")}</dl>`; }
  function selectedFacts(context, record) {
    const t = context.t, facts = [];
    if (record.kind === 'hospital') {
      const linked = rows(context.scenario.demand_nodes).filter(node => String(node.nearest_hospital_id) === String(record.row.hospital_id));
      const population = linked.reduce((total, node) => total + (finite(node.population) ? node.population : 0), 0);
      facts.push([t('最近到院关联片区', 'Nearest-hospital linked areas'), t(`${number(linked.length, 0)} 个 · ${number(population, 0)} 人（非实际患者分配）`, `${number(linked.length, 0)} areas · ${number(population, 0)} people (not patient allocation)`)]);
      const quality = record.row.location_quality;
      if (quality?.label) facts.push([t('位置资料', 'Location source'), esc(quality.label)]);
      if (finite(quality?.estimated_uncertainty_m)) facts.push([t('定位不确定度', 'Location uncertainty'), t(`约 ${number(quality.estimated_uncertainty_m, 0)} 米`, `Approx. ${number(quality.estimated_uncertainty_m, 0)} m`)]);
    } else {
      const year = context.data?.data_quality?.population?.year;
      if (finite(year)) facts.push([t('人口资料年份', 'Population data year'), number(year, 0)]);
    }
    return facts;
  }
  function compactSelectionHTML(context) {
    const { t } = context, record = findRecord(context, context.selected);
    if (!record) return "";
    const { row, kind } = record;
    const ratio = finite(row.weighted_pre_capacity) && row.weighted_pre_capacity > 0 && finite(row.weighted_post_capacity) ? row.weighted_post_capacity / row.weighted_pre_capacity : null;
    const items = kind === "hospital" ? [
      [t("震后能力保留", "Capacity retained"), percent(ratio)],
      [t("震前加权模型能力", "Baseline weighted model capacity"), number(row.weighted_pre_capacity)],
      [t("震后加权模型能力", "Post-event weighted model capacity"), number(row.weighted_post_capacity)],
    ] : [
      [t("录入人口", "Input population"), `${number(row.population, 0)} ${t("人", "people")}`],
      [t("震后医疗服务指数", "Post-event service index"), number(row.post_accessibility, 4)],
      [t("最近到院时间", "Nearest travel time"), finite(row.nearest_minutes) ? `${number(row.nearest_minutes)} ${t("分钟", "min")}` : "—"],
    ];
    items.push(...selectedFacts(context, record));
    return `<button class="medical-map-selection-close" type="button" data-medical-map-action="clear-selection" aria-label="${t("关闭对象信息", "Close selected record")}">×</button><div class="medical-map-selection-heading"><span>${kind === "hospital" ? t("医院", "Hospital") : t("居民点", "Population point")}</span><h4>${esc(recordName(row, kind, t))}</h4></div>${rowsHTML(items)}${kind === "demand" && connectionNodeNote(context, row) ? `<p class="medical-map-connection-missing">${esc(connectionNodeNote(context, row))}</p>` : ""}<p class="medical-map-inline-note">${kind === "hospital" ? t("保留比按 72 小时加权模型能力计算。", "Retained ratio uses the weighted 72-hour model capacity.") : t("服务指数同时考虑医院能力、人口和通行时间。", "The service index combines hospital capacity, population and travel time.")}</p><button class="medical-map-selection-details" type="button" data-medical-map-action="details">${t("查看完整指标", "View full indicators")} →</button>`;
  }
  function selectionHTML(context) {
    const { t, selected } = context, record = findRecord(context, selected);
    if (!record) return `<div class="medical-map-selection-empty"><span aria-hidden="true">↖</span><h4>${t("点击地图上的居民点或医院", "Select a population point or hospital")}</h4><p>${t("查看前后指标、人口和到院信息，也可从下方列表定位。", "Inspect before/after indicators, population and travel information, or select a point from the list below.")}</p></div>`;
    const { row, kind } = record, id = kind === "hospital" ? row.hospital_id : row.node_id;
    let items;
    if (kind === "hospital") items = [
      [t("震前加权模型能力", "Baseline weighted capacity"), number(row.weighted_pre_capacity)],
      [t("震后加权模型能力", "Post-event weighted capacity"), number(row.weighted_post_capacity)],
      [t("模型能力保留比", "Model capacity retained"), finite(row.weighted_pre_capacity) && row.weighted_pre_capacity > 0 && finite(row.weighted_post_capacity) ? percent(row.weighted_post_capacity / row.weighted_pre_capacity) : "—"],
    ];
    else items = [
      [t("录入人口", "Input population"), `${number(row.population, 0)} ${t("人", "people")}`],
      [t("震前基准可达性", "Baseline accessibility"), number(row.baseline_accessibility, 4)],
      [t("震后可达性", "Post-event accessibility"), number(row.post_accessibility, 4)],
      [t("可达性均值比", "Accessibility ratio of means"), percent(row.retained_ratio)],
      [t("最近医院", "Nearest hospital"), esc(row.nearest_hospital_name || row.nearest_hospital_id || "—")],
      [t("最近到院时间", "Nearest travel time"), finite(row.nearest_minutes) ? `${number(row.nearest_minutes)} ${t("分钟", "min")}` : "—"],
      [t("服务半径内医院", "Hospitals within radius"), finite(row.reachable_hospital_count) ? `${number(row.reachable_hospital_count, 0)} ${t("家", "")}` : "—"],
    ];
    items.push(...selectedFacts(context, record));
    if (row.coordinate_provenance?.source_sheet || row.coordinate_provenance?.source_id) items.push([t("坐标来源记录", "Coordinate source record"), esc([row.coordinate_provenance.source_sheet, row.coordinate_provenance.source_id].filter(Boolean).join(" / "))]);
    const access = kind === "demand" ? rows(row.hospital_access) : [];
    return `<div class="medical-map-selection-heading"><span>${t(kind === "hospital" ? "医院" : "居民点", kind === "hospital" ? "HOSPITAL" : "POPULATION POINT")}</span><h4>${esc(recordName(row, kind, t))}</h4><small>ID · ${esc(id || "—")}</small></div>${rowsHTML(items)}${kind === "demand" && connectionNodeNote(context, row) ? `<p class="medical-map-connection-missing">${esc(connectionNodeNote(context, row))}</p>` : ""}${!validPoint(row) ? `<p class="medical-map-inline-note">${t("此对象缺少有效坐标，可查看指标，暂不能在图上定位。", "This record has no valid coordinates. Its indicators are available, but it cannot be located on the map.")}</p>` : `<p class="medical-map-coordinates">WGS84 · ${t("经度", "Lon")} ${number(row.longitude, 5)}° / ${t("纬度", "Lat")} ${number(row.latitude, 5)}°</p>`}${kind === "hospital" ? `<p class="medical-map-inline-note">${t("加权能力为 72 小时模型指标，非实际收治人数。", "Weighted capacity is a 72-hour model indicator, not actual admissions.")}</p>` : ""}${access.length ? `<details class="medical-map-access-list"><summary>${t("查看各医院通行时间", "Travel time to each hospital")}</summary><ul>${access.map(item => {
      const index = rows(context.scenario.hospitals).findIndex(hospital => String(hospital.hospital_id) === String(item.hospital_id));
      const hospital = context.scenario.hospitals[index];
      return `<li>${hospital ? `<button type="button" data-medical-map-select="h:${index}">${esc(recordName(hospital, "hospital", t))}</button>` : `<span>${esc(item.hospital_id)}</span>`}<strong>${finite(item.minutes) ? `${number(item.minutes)} ${t("分", "min")}` : "—"}</strong><small>${item.within_radius === true ? t("半径内", "Within radius") : item.within_radius === false ? t("半径外", "Outside radius") : t("通行数据缺失", "Travel data missing")}${item.positive_post_capacity === false ? t(" · 震后模型能力为零", " · zero post-event model capacity") : ""}</small></li>`;
    }).join("")}</ul><p>${t("通行时间来自输入 OD，不代表实际行驶路线。", "Times come from the input OD data, not observed driving routes.")}</p></details>` : ""}`;
  }
  function weakHTML(context) {
    const t = context.t;
    if (context.layer === "hospital") {
      const hospitals = rows(context.scenario.hospitals).map((row, index) => ({ row, index, ratio: finite(row.weighted_pre_capacity) && row.weighted_pre_capacity > 0 && finite(row.weighted_post_capacity) ? row.weighted_post_capacity / row.weighted_pre_capacity : null })).sort((a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity));
      return `<h4>${t(`全部 ${hospitals.length} 家医院`, `All ${hospitals.length} hospitals`)}</h4><p>${t("按震后能力保留比从低到高排列；位置重叠的医院也可从这里选择。", "Ordered by post-event capacity retained. Hospitals with overlapping locations can also be selected here.")}</p><ol>${hospitals.map(({ row, index, ratio }) => `<li><button type="button" data-medical-map-select="h:${index}" aria-pressed="${context.selected === `h:${index}`}" title="${esc(recordName(row, "hospital", t))}"><span><b>${esc(recordName(row, "hospital", t))}</b><small>${esc(row.hospital_id)}${validPoint(row) ? "" : t(" · 缺坐标", " · unlocated")}</small></span><strong>${percent(ratio)}</strong></button></li>`).join("")}</ol><small>${t("比值 = 震后 / 震前加权模型能力；基准为零时显示“—”。", "Ratio = post-event / baseline weighted model capacity; a zero baseline is shown as “—”.")}</small>`;
    }
    const weak = rows(context.scenario.weak_nodes);
    const candidates = weak.map(row => ({ row, index: rows(context.scenario.demand_nodes).findIndex(node => String(node.node_id) === String(row.node_id)) })).filter(item => item.index >= 0 && finite(item.row.post_accessibility));
    return `<h4>${t("震后可达性较低的居民点", "Lower post-event accessibility")}</h4><p>${t("按本次录入点的指数从低到高查看，不等同于无法就医。", "Ordered by lower index within the input points; this does not mean people cannot obtain care.")}</p>${candidates.length ? `<ol>${candidates.map(({ row, index }) => `<li><button type="button" data-medical-map-select="d:${index}" aria-pressed="${context.selected === `d:${index}`}" title="${esc(recordName(row, "demand", t))}"><span><b>${esc(recordName(row, "demand", t))}</b><small>${number(row.population, 0)} ${t("人", "people")}${validPoint(row) ? "" : t(" · 缺坐标", " · unlocated")}</small></span><strong>${number(row.post_accessibility, 4)}</strong></button></li>`).join("")}</ol><small>${t(`显示 ${candidates.length} / ${number(context.scenario.weak_nodes_total_count ?? candidates.length, 0)} 个有可达性结果的居民点`, `${candidates.length} / ${number(context.scenario.weak_nodes_total_count ?? candidates.length, 0)} population points with accessibility results shown`)}</small>` : `<p class="medical-map-inline-note">${t("本轮缺少可排序的可达性结果。", "No accessibility values are available for ranking in this round.")}</p>`}`;
  }
  function renderShell(context) {
    const { t } = context;
    context.container.innerHTML = `<section class="medical-map" aria-label="${t("医疗服务交互地图", "Interactive healthcare service map")}"><div class="medical-map-toolbar"><div class="medical-map-control-group" role="group" aria-label="${t("地图指标", "Map metric")}"><span>${t("查看", "Metric")}</span>${[["travel", "到院时间", "Travel time"], ["accessibility", "医疗可达性", "Accessibility"], ["hospital", "医院能力保留", "Capacity retained"]].map(([key, zh, en]) => `<button type="button" data-medical-map-layer="${key}" aria-pressed="${key === "accessibility"}">${t(zh, en)}</button>`).join("")}</div><div class="medical-map-control-group" role="group" aria-label="${t("对比阶段", "Comparison period")}"><span>${t("对比", "Period")}</span>${[["before", "震前", "Before"], ["after", "震后", "After"], ["change", "变化", "Change"]].map(([key, zh, en]) => `<button type="button" data-medical-map-period="${key}" aria-pressed="${key === "after"}">${t(zh, en)}</button>`).join("")}</div></div><div class="medical-map-layout"><div class="medical-map-cartography"><div class="medical-map-canvas" data-medical-map-canvas role="region" aria-label="${t("医疗服务点地图，可缩放和平移", "Healthcare point map, zoomable and pannable")}" tabindex="0"></div><div class="medical-map-map-actions"><button type="button" data-medical-map-action="fit">${t("显示全部点", "Fit all points")}</button><label><input type="checkbox" data-medical-map-connection ${context.showConnection ? "checked" : ""}>${t("居民到医院的联系", "Population-to-hospital links")}</label></div>${connectionControlsHTML(context)}<div class="medical-map-tile-status" data-medical-map-tile-status role="status" hidden></div><div class="medical-map-map-footer"><div class="medical-map-legend" data-medical-map-legend></div><p class="medical-map-explanation" data-medical-map-explanation></p></div></div><aside class="medical-map-sidebar" aria-label="${t("选中对象与居民点列表", "Selected record and population points")}"><div class="medical-map-selection" data-medical-map-selection aria-live="polite"></div><div class="medical-map-weak" data-medical-map-weak></div></aside></div><div class="medical-map-scope">${scopeHTML(context)}</div><details class="medical-map-method"><summary>${t("地图数据与计算口径", "Map data and calculation scope")}</summary><p>${t("居民点仅表示录入的需求位置；没有行政区多边形，未绘制连续热力面或推断服务边界。底图背景道路不参与本轮通行计算。", "Population points represent the input demand locations. No administrative polygons, continuous heat surfaces or inferred service boundaries are drawn. Background roads are not used in this round's travel calculation.")}</p><ul>${resultNotes([...new Set([...rows(context.data.limitations), ...rows(context.scenario.limitations)])]).filter(item => typeof item === "string").map(item => `<li>${esc(item)}</li>`).join("")}</ul></details></section>`;
    context.root = context.container.querySelector(".medical-map");
    if (context.compact) {
      context.root.classList.add("medical-map--compact");
      const controls = document.createElement("details");
      controls.className = "medical-map-compact-controls";
      controls.innerHTML = `<summary>${t("图层与指标说明", "Layers and metric notes")}</summary>`;
      controls.append(context.root.querySelector(".medical-map-toolbar"), context.root.querySelector(".medical-map-explanation"), context.root.querySelector(".medical-map-method"));
      context.root.append(controls);
      const cartography = context.root.querySelector(".medical-map-cartography");
      const selection = context.root.querySelector("[data-medical-map-selection]");
      selection.classList.add("medical-map-selection--compact");
      selection.hidden = true;
      cartography.querySelector(".medical-map-canvas").after(selection);
      context.root.querySelector(".medical-map-sidebar").remove();
      const actions = context.root.querySelector(".medical-map-map-actions");
      actions.querySelector("label").remove();
      actions.querySelector("[data-medical-map-action=fit]").textContent = t("查看全域", "View full extent");
      const detailsButton = document.createElement("button");
      detailsButton.type = "button"; detailsButton.dataset.medicalMapAction = "details";
      detailsButton.className = "medical-map-details-button";
      detailsButton.textContent = t("查看地图详情", "View map details");
      actions.append(detailsButton);
      context.root.querySelector(".medical-map-map-footer").append(actions);
    }
    const fullscreenButton = document.createElement("button");
    fullscreenButton.type = "button"; fullscreenButton.dataset.mapFullscreen = "";
    fullscreenButton.textContent = t("全屏查看", "Full screen");
    context.root.querySelector(".medical-map-map-actions").prepend(fullscreenButton);
    const sceneRetry = document.createElement("button");
    sceneRetry.type = "button"; sceneRetry.dataset.medicalMapAction = "retry-3d"; sceneRetry.hidden = true;
    sceneRetry.textContent = t("重新加载三维", "Reload 3D");
    context.root.querySelector(".medical-map-map-actions").append(sceneRetry);
    context.fullscreen = window.MapFullscreen?.mount(context.root, {
      button: fullscreenButton, language: context.options.language,
      onResize: () => { if (current(context)) resize(context.container); }
    });
    const method = context.root.querySelector(".medical-map-method");
    if (method && rows(context.data.geography?.sources).length) {
      const sourceNote = document.createElement("p");
      sourceNote.textContent = t("坐标资料：", "Coordinate sources: ") + context.data.geography.sources.map(source => source.filename).filter(Boolean).join(" / ") + (context.data.geography.calculation_unchanged ? t("。本次坐标补充未改变已完成的工程计算。", ". These coordinate additions did not alter the completed engineering calculations.") : "");
      method.append(sourceNote);
    }
    if (context.scenario.accessibility_status === "unavailable") {
      const notice = document.createElement("p"); notice.className = "medical-map-warning";
      notice.textContent = t("本情景通行数据不完整，无法可靠计算到院覆盖与医疗可达性；缺失值以灰色显示，仍可查看医院能力及明确录入的到院时间。", "Scenario travel data is incomplete, so travel coverage and accessibility cannot be reliably derived. Missing values are grey; hospital capacity and explicitly recorded travel times remain available.");
      context.root.querySelector(".medical-map-layout").before(notice);
    }
    context.root.addEventListener("click", event => {
      const layer = event.target.closest("[data-medical-map-layer]");
      const period = event.target.closest("[data-medical-map-period]");
      const connectionMode = event.target.closest("[data-medical-map-connection-mode]");
      const selection = event.target.closest("[data-medical-map-select]");
      const action = event.target.closest("[data-medical-map-action]");
      if (connectionMode && ["all", "concise", "focus"].includes(connectionMode.dataset.medicalMapConnectionMode)) { context.connectionMode = connectionMode.dataset.medicalMapConnectionMode; context.showConnection = true; drawConnection(context); }
      else if (layer) { context.layer = layer.dataset.medicalMapLayer; update(context); }
      else if (period) { context.period = period.dataset.medicalMapPeriod; update(context); }
      else if (selection) select(context, selection.dataset.medicalMapSelect, true);
      else if (action?.dataset.medicalMapAction === "fit") fit(context);
      else if (action?.dataset.medicalMapAction === "retry-3d") retrySandbox(context);
      else if (action?.dataset.medicalMapAction === "details") openDetails(context);
      else if (action?.dataset.medicalMapAction === "clear-selection") selectRecord(context.container, { hospitalId: null, nodeId: null, pan: false });
    });
    context.root.addEventListener("change", event => {
      if (event.target.matches("[data-medical-map-connection]")) { context.showConnection = event.target.checked; drawConnection(context); }
      if (event.target.matches("[data-medical-map-population]")) { context.showPopulation = event.target.checked; update(context); }
    });
    update(context);
    afterPaint(() => { if (current(context)) initializeMap(context); });
  }
  function update(context) {
    if (!context.root) return;
    for (const button of context.root.querySelectorAll("[data-medical-map-layer]")) button.setAttribute("aria-pressed", String(button.dataset.medicalMapLayer === context.layer));
    for (const button of context.root.querySelectorAll("[data-medical-map-period]")) button.setAttribute("aria-pressed", String(button.dataset.medicalMapPeriod === context.period));
    context.root.querySelector("[data-medical-map-legend]").innerHTML = legendHTML(context);
    context.root.querySelector("[data-medical-map-explanation]").textContent = explanation(context);
    const selection = context.root.querySelector("[data-medical-map-selection]");
    selection.innerHTML = context.compact ? compactSelectionHTML(context) : selectionHTML(context);
    selection.hidden = context.compact && !findRecord(context, context.selected);
    const weak = context.root.querySelector("[data-medical-map-weak]");
    if (weak) weak.innerHTML = weakHTML(context);
    renderPointLayers(context);
    if (context.fallback) drawGrid(context);
  }
  function select(context, key, pan) {
    const record = findRecord(context, key);
    if (!record) return;
    const changed = context.selected !== record.key;
    context.selected = record.key;
    if (changed) update(context);
    drawConnection(context);
    if (pan && context.sandbox && validPoint(record.row)) context.sandbox.focus?.(record.key);
    if (pan && context.map && validPoint(record.row)) {
      const location = [record.row.latitude, record.row.longitude];
      const animate = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (record.kind === "hospital" && context.map.getZoom() < 15) context.map.setView(location, Math.min(15, context.map.getMaxZoom()), { animate });
      else context.map.panTo(location, { animate });
    }
    if (changed) {
      const detail = selectionDetail(context);
      if (typeof context.options.onSelect === "function") context.options.onSelect(detail);
      context.container.dispatchEvent(new CustomEvent("medical-map-selection", { bubbles: true, detail }));
    }
  }
  function selectionDetail(context) {
    const record = findRecord(context, context.selected);
    return {
      sessionId: context.options.sessionId,
      iteration: Number(context.options.iteration || 1),
      scenarioId: context.scenario?.scenario_id ?? context.options.selectedScenario ?? null,
      hospitalId: record?.kind === "hospital" ? record.row.hospital_id : null,
      nodeId: record?.kind === "demand" ? record.row.node_id : null,
    };
  }
  function openDetails(context) {
    const detail = selectionDetail(context);
    if (typeof context.options.onDetails === "function") { context.options.onDetails(detail); return; }
    const handled = !context.container.dispatchEvent(new CustomEvent("medical-map-details", { bubbles: true, cancelable: true, detail }));
    if (!handled) {
      const controls = context.root.querySelector(".medical-map-compact-controls");
      if (controls) { controls.open = true; controls.querySelector("summary")?.focus(); }
    }
  }
  function selectRecord(container, selection = {}) {
    const context = mounts.get(container);
    if (!context?.scenario) return false;
    if (selection.hospitalId === null && selection.nodeId === null) {
      const changed = context.selected !== null;
      context.selected = null;
      update(context); drawConnection(context);
      if (changed) {
        const detail = selectionDetail(context);
        context.options.onSelect?.(detail);
        context.container.dispatchEvent(new CustomEvent("medical-map-selection", { bubbles: true, detail }));
      }
      return true;
    }
    const hospital = selection.hospitalId ?? selection.selectedHospitalId;
    const node = selection.nodeId ?? selection.selectedNodeId;
    const kind = hospital !== undefined && hospital !== null ? "hospital" : "demand";
    const id = kind === "hospital" ? hospital : node;
    if (id === undefined || id === null) return false;
    const index = rows(kind === "hospital" ? context.scenario.hospitals : context.scenario.demand_nodes).findIndex(row => String(kind === "hospital" ? row.hospital_id : row.node_id) === String(id));
    if (index < 0) return false;
    select(context, `${kind === "hospital" ? "h" : "d"}:${index}`, selection.pan !== false);
    return true;
  }
  function status(context, message) {
    if (!current(context)) return;
    const element = context.root?.querySelector("[data-medical-map-tile-status]");
    if (!element) return;
    const text = context.sandboxIssue || message || (context.sandboxBackgroundPending ? context.t("正在加载 3D 地图，请稍候。当前先显示点位与底图预览，当前视野的立体建筑在后台分批加载后会自动替换。", "Loading the 3D map. Saved points and a basemap preview remain available while local buildings load in the background.") : context.sandboxBackgroundNote || "");
    element.hidden = !text; element.textContent = text;
  }
  function sandboxIssue(context, error, background = false) {
    context.sandboxBackgroundPending = false;
    const reason = String(error?.message || error || context.t("地图绘制未完成", "Map rendering did not finish"));
    const stage = error?.stage, label = stage === "engine" ? context.t("三维引擎加载失败", "3D engine loading failed") : stage === "render" ? background ? context.t("局部建筑绘制失败", "Local building rendering failed") : context.t("三维绘制失败", "3D rendering failed") : ["source", "request"].includes(stage) ? context.t("局部建筑背景下载失败", "Local building download failed") : background ? context.t("立体建筑尚未加载", "Building geometry has not loaded") : context.t("三维地图暂不可用", "The 3D map is unavailable");
    context.sandboxIssue = background
      ? context.t(`${label}：${reason}。当前未完成区域仅为底图预览，评估结果仍可查看。点击“重新加载三维”仅重试地图，无需重新评估。`, `${label}: ${reason}. Areas without building geometry remain a basemap preview; assessment results remain available. Select Reload 3D to retry only the map without rerunning the assessment.`)
      : context.t(`${label}：${reason}。已保留二维地图与本轮评估结果。点击“重新加载三维”仅重试地图，无需重新评估。`, `${label}: ${reason}. The 2D map and assessment results remain available. Select Reload 3D to retry only the map without rerunning the assessment.`);
    const button = context.root?.querySelector('[data-medical-map-action="retry-3d"]');
    if (button) { button.hidden = false; button.disabled = false; }
    status(context, "");
  }
  function retrySandbox(context) {
    if (!current(context) || context.sandboxPending) return;
    if (context.sandbox?.retryBackground && !context.sandboxFailed) {
      if (context.sandboxBackgroundRetryPending) return;
      const adapter = context.sandbox;
      context.sandboxBackgroundRetryPending = true; context.sandboxIssue = ""; context.sandboxBackgroundPending = true;
      const button = context.root.querySelector('[data-medical-map-action="retry-3d"]');
      if (button) { button.hidden = true; button.disabled = true; }
      status(context, "");
      return Promise.resolve().then(() => adapter.retryBackground()).catch(error => {
        if (current(context) && context.sandbox === adapter && error?.name !== "AbortError") sandboxIssue(context, error, true);
      }).finally(() => { if (current(context) && context.sandbox === adapter) context.sandboxBackgroundRetryPending = false; });
    }
    context.sandboxSerial = (context.sandboxSerial || 0) + 1; context.sandboxController?.abort(); context.sandbox?.destroy();
    context.sandbox = null; context.sandboxFailed = false; context.sandboxIssue = ""; context.sandboxBackgroundNote = ""; context.sandboxBackgroundRetryPending = false;
    window.clearTimeout?.(context.tileTimer); context.map?.remove(); context.map = null;
    context.tiles = null; context.connection = null; context.pointsLayer = null; context.markers = [];
    context.fallback = false; context.hasFitted = false; context.pointView = null;
    const canvas = context.root.querySelector("[data-medical-map-canvas]"); canvas.innerHTML = "";
    const button = context.root.querySelector('[data-medical-map-action="retry-3d"]');
    if (button) { button.hidden = true; button.disabled = true; }
    status(context, ""); initializeMap(context);
  }
  function fit(context) {
    if (!visibleCanvas(context)) return;
    if (context.sandbox) { context.sandbox.fit(); return; }
    const points = pointRecords(context).filter(record => validPoint(record.row)).map(record => [record.row.latitude, record.row.longitude]);
    if (context.map && points.length) {
      context.map.fitBounds(points, { padding: [34, 34], maxZoom: 13, animate: false });
      context.hasFitted = true;
    }
  }
  function visibleCanvas(context) {
    const canvas = context.root?.querySelector("[data-medical-map-canvas]");
    if (!canvas) return false;
    const bounds = canvas.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }
  function observeSize(context, canvas) {
    if (!window.ResizeObserver || context.resizeObserver) return;
    context.resizeObserver = new window.ResizeObserver(() => resize(context.container));
    context.resizeObserver.observe(canvas);
  }
  function basemapConfig(data) {
    const fallback = { tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors' };
    const source = data.basemap;
    if (!source || typeof source.tile_url !== "string" || !/^https?:\/\//i.test(source.tile_url)) return fallback;
    let url;
    try { url = new URL(source.tile_url); } catch (_error) { return fallback; }
    if (url.username || url.password || !source.tile_url.includes("{z}") || !source.tile_url.includes("{x}") || !source.tile_url.includes("{y}")) return fallback;
    let attribution = fallback.attribution;
    if (source.attribution && window.DOMParser) {
      const parsed = new window.DOMParser().parseFromString(String(source.attribution), "text/html");
      const safeNode = node => {
        if (node.nodeType === 3) return esc(node.textContent);
        const contents = Array.from(node.childNodes || []).map(safeNode).join("");
        const href = node.nodeType === 1 && node.tagName === "A" ? node.getAttribute("href") : null;
        return href && /^https?:\/\//i.test(href) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${contents}</a>` : contents;
      };
      attribution = Array.from(parsed.body.childNodes).map(safeNode).join("");
    }
    return { tileUrl: source.tile_url, attribution, maxZoom: finite(source.max_zoom) ? Math.max(2, Math.min(22, source.max_zoom)) : 19 };
  }
  function markerAppearance(context, record) {
    const selected = context.selected === record.key;
    const highlighted = highlightedDemandKeys(context).includes(record.key) || highlightedHospitalKeys(context).includes(record.key);
    const primary = (context.layer === "hospital") === (record.kind === "hospital");
    const color = primary ? colorFor(metricValue(context, record.row, record.kind), descriptor(context)) : record.kind === "hospital" ? "#547675" : "#235ba8";
    return { fillColor: color, fillOpacity: primary || selected ? 0.9 : 0.3, color: selected ? "#214c68" : highlighted ? "#b75b12" : primary ? color : "#829398", weight: selected ? 2.2 : highlighted ? 1.8 : primary ? 1.2 : 0.7, radius: selected ? 7 : highlighted ? 5.5 : primary ? 4.5 : 2.8 };
  }
  function hospitalProgress(context, row) {
    if (!finite(row.weighted_pre_capacity) || row.weighted_pre_capacity <= 0) return { ratio: null, fraction: null };
    const ratio = context.period === "before" ? 1 : finite(row.weighted_post_capacity) ? row.weighted_post_capacity / row.weighted_pre_capacity : null;
    return { ratio, fraction: finite(ratio) ? Math.max(0, Math.min(1, ratio)) : null };
  }
  function hospitalRingSVG(context, row, center = null) {
    const { fraction } = hospitalProgress(context, row), missing = !finite(fraction);
    const placement = center ? ` x="${center.x - 8}" y="${center.y - 8}"` : "";
    const offset = finite(fraction) ? number((1 - fraction) * 100, 4).replace(/,/g, "") : null;
    // Every hospital uses the same geometry. Only the green arc length changes.
    return `<svg class="medical-map-hospital-ring-svg"${placement} width="16" height="16" viewBox="0 0 20 20" aria-hidden="true"><circle class="medical-map-hospital-ring-track" cx="10" cy="10" r="7.3" fill="none" stroke="#c7d0cf" stroke-width="2.2"${missing ? ' stroke-dasharray="2 2"' : ""}/>${finite(fraction) && fraction > 0 ? `<circle class="medical-map-hospital-ring-progress" cx="10" cy="10" r="7.3" fill="none" stroke="${HOSPITAL_GREEN}" stroke-width="2.2" pathLength="100" stroke-dasharray="100 100" stroke-dashoffset="${offset}" stroke-linecap="butt" transform="rotate(-90 10 10)"/>` : ""}<circle class="medical-map-hospital-ring-core" cx="10" cy="10" r="1.5" fill="${missing || fraction === 0 ? "#819295" : HOSPITAL_GREEN}"/></svg>`;
  }
  function hospitalSymbolHTML(context, record) {
    const { fraction } = hospitalProgress(context, record.row);
    const classes = ["medical-map-hospital-symbol", context.selected === record.key ? "is-selected" : "", highlightedHospitalKeys(context).includes(record.key) ? "is-priority" : "", !finite(fraction) ? "is-missing" : "", fraction === 0 ? "is-zero" : ""].filter(Boolean).join(" ");
    return `<span class="${classes}" aria-hidden="true">${hospitalRingSVG(context, record.row)}</span>`;
  }
  function pointLabel(context, record) {
    const name = recordName(record.row, record.kind, context.t), value = metricValue(context, record.row, record.kind);
    const primary = (context.layer === "hospital") === (record.kind === "hospital");
    return primary ? `${name} · ${descriptor(context).title} ${finite(value) ? metricText(context, value, true) : context.t("指标缺失", "missing value")}` : name;
  }
  function renderPointLayers(context) {
    if (context.sandbox) { renderSandboxPoints(context); return; }
    if (!context.map || !context.pointsLayer) return;
    const points = pointRecords(context).filter(record => validPoint(record.row));
    context.pointsLayer.clearLayers(); context.markers = [];
    const independent = points.filter(record => record.kind === "hospital" || context.layer !== "hospital" || context.showPopulation || context.selected === record.key);
    for (const record of independent) {
      const label = pointLabel(context, record), location = [record.row.latitude, record.row.longitude];
      const marker = window.L.marker(location, { icon: window.L.divIcon(record.kind === 'hospital' ? { className: "medical-map-hospital-marker", html: hospitalSymbolHTML(context, record), iconSize: [18, 18], iconAnchor: [9, 9] } : { className: "medical-map-population-marker", html: populationSymbolSVG(context, record), iconSize: [16, 20], iconAnchor: [8, 10] }), keyboard: true, title: label, zIndexOffset: context.selected === record.key ? 1200 : record.kind === 'hospital' ? 500 : 250 });
      marker.addTo(context.pointsLayer).bindTooltip(esc(label), { direction: "top", className: "medical-map-tooltip", offset: [0, -7] });
      marker.on("click", () => select(context, record.key, false));
      const element = marker.getElement();
      if (element) {
        element.setAttribute("role", "button"); element.setAttribute("tabindex", "0"); element.setAttribute("aria-label", label); element.setAttribute("aria-pressed", String(context.selected === record.key));
        element.addEventListener("keydown", event => { if (event.key === " " || (event.key === "Enter" && record.kind === "demand")) { event.preventDefault(); event.stopPropagation(); select(context, record.key, false); } });
      }
      context.markers.push({ ...record, marker });
    }
    context.pointView = pointView(context);
    const note = context.root.querySelector("[data-medical-map-density-note]");
    if (note) note.textContent = context.t("绿环代表医院，蓝色小人代表人口片区；放大或全屏查看密集区域。", "Green rings are hospitals; blue people are population areas. Zoom or enter fullscreen to inspect dense areas.");
  }
  function pointView(context) {
    const bounds = context.root.querySelector("[data-medical-map-canvas]").getBoundingClientRect();
    return JSON.stringify([context.map.getZoom(), bounds.width, bounds.height]);
  }
  function drawConnection(context) {
    context.connection?.clearLayers();
    const links = connectionRecords(context);
    renderConnectionStatus(context, links);
    if (context.fallback) { drawGrid(context); return; }
    if (context.sandbox) {
      context.sandbox.setLinks(links.map(link => ({ id: link.id, coordinates: [[link.node.longitude, link.node.latitude], [link.hospital.longitude, link.hospital.latitude]], arc: true, arrow: true, selected: link.selected, color: link.selected ? "#b35413" : "#267b96", width: link.selected ? 2.6 : context.connectionMode === "concise" ? 1.4 : .85, opacity: link.selected ? .96 : context.connectionMode === "concise" ? .58 : .28, interactive: false, label: `${recordName(link.node, 'demand', context.t)} → ${recordName(link.hospital, 'hospital', context.t)} · ${number(link.minutes, 1)} ${context.t('分钟', 'min')}` })), { arcLimit: "all" });
      return;
    }
    if (context.map && context.connection) for (const link of links) window.MedicalMapSymbols.addLeafletConnection(window.L, context.map, context.connection, { ...link, color: link.selected ? "#b35413" : "#267b96", width: link.selected ? 2.6 : context.connectionMode === "concise" ? 1.4 : .85, opacity: link.selected ? .96 : context.connectionMode === "concise" ? .58 : .28 });
  }
  function connectionRecords(context) {
    const selected = findRecord(context, context.selected);
    if (!context.showConnection || (context.layer === 'hospital' && !context.showPopulation && selected?.kind !== 'demand')) return [];
    const nodeId = selected?.kind === "demand" ? selected.row.node_id : null;
    const hospitalId = selected?.kind === "hospital" ? selected.row.hospital_id : null;
    const candidates = window.MedicalMapSymbols.nearestConnections({ demandNodes: context.scenario.demand_nodes, hospitals: context.scenario.hospitals,
      selectedNodeId: context.connectionMode === "focus" ? nodeId : null,
      selectedHospitalId: context.connectionMode === "focus" ? hospitalId : null, limit: null });
    if (context.connectionMode === "focus" && !selected) return [];
    const marked = candidates.map(link => ({ ...link, selected: nodeId != null ? String(link.node.node_id) === String(nodeId)
      : hospitalId != null && String(link.hospital.hospital_id) === String(hospitalId) }));
    if (context.connectionMode !== "concise" || marked.length <= 24) return marked;
    const sampled = Array.from({ length: 24 }, (_, i) => marked[Math.floor(i * marked.length / 24)]);
    const highlighted = marked.find(link => link.selected);
    if (highlighted && !sampled.some(link => link.selected)) sampled[sampled.length - 1] = highlighted;
    return sampled;
  }
  function connectionControlsHTML(context) {
    const { t } = context;
    return `<section class="medical-map-connections" aria-label="${t("到院联系显示方式", "Access-link display")}"><div class="medical-map-connection-modes" role="group" aria-label="${t("到院联系显示方式", "Access-link display")}">${[["all", "全部联系", "All links"], ["concise", "简洁示意（24条）", "Concise (24 links)"], ["focus", "只看所选对象", "Selected only"]].map(([mode, zh, en]) => `<button type="button" data-medical-map-connection-mode="${mode}" aria-pressed="${(context.connectionMode || "all") === mode}">${t(zh, en)}</button>`).join("")}</div><p class="medical-map-connection-status" data-medical-map-connections-status role="status"></p></section>`;
  }
  function connectionMissingText(t, summary) {
    return [summary.missingHospitalCoordinates ? t(`${number(summary.missingHospitalCoordinates, 0)} 个居民片区最近医院缺坐标`, `${number(summary.missingHospitalCoordinates, 0)} population areas have an unlocated nearest hospital`) : "",
      summary.missingNodeCoordinates ? t(`${number(summary.missingNodeCoordinates, 0)} 个居民片区缺坐标`, `${number(summary.missingNodeCoordinates, 0)} population areas lack coordinates`) : "",
      summary.missingTravelTimes ? t(`${number(summary.missingTravelTimes, 0)} 个居民片区缺本轮到院时间`, `${number(summary.missingTravelTimes, 0)} population areas lack saved travel times`) : "",
      summary.missingHospitalRelation ? t(`${number(summary.missingHospitalRelation, 0)} 个居民片区缺最近医院关联`, `${number(summary.missingHospitalRelation, 0)} population areas lack a nearest-hospital relationship`) : ""].filter(Boolean).join(t("；", "; "));
  }
  function connectionNodeNote(context, node) {
    const { t } = context;
    const summary = window.MedicalMapSymbols.connectionSummary({ demandNodes: [node], hospitals: context.scenario.hospitals });
    if (summary.available) return "";
    const cause = summary.missingHospitalCoordinates ? t("本轮最近医院缺少有效坐标", "The saved nearest hospital has no valid coordinates")
      : summary.missingNodeCoordinates ? t("该居民片区缺少有效坐标", "This population area has no valid coordinates")
      : summary.missingTravelTimes ? t("本轮未保存到该医院的有效通行时间", "No valid travel time to this hospital is saved for this round")
      : t("本轮没有可核对的最近医院关联", "No verifiable nearest-hospital relationship is saved for this round");
    return `${cause}${t("，因此未画联系线；不会自行改连其他医院。", "; no link is drawn and another hospital is not substituted.")}`;
  }
  function connectionStatusText(context, links = connectionRecords(context)) {
    const { t } = context, selected = findRecord(context, context.selected);
    const summary = window.MedicalMapSymbols.connectionSummary({ demandNodes: context.scenario.demand_nodes, hospitals: context.scenario.hospitals });
    const missing = connectionMissingText(t, summary);
    const selectedNote = selected?.kind === "demand" ? connectionNodeNote(context, selected.row) : "";
    const guidance = context.connectionMode === "focus" && !selected ? t("请先点击居民点或医院。", "Select a population area or hospital first.") : "";
    return [t(`显示 ${number(links.length, 0)} 条，可显示 ${number(summary.available, 0)} 条。`, `Showing ${number(links.length, 0)} of ${number(summary.available, 0)} drawable links.`),
      !context.showConnection ? t("到院联系已隐藏。", "Access links are hidden.") : "",
      missing ? `${missing}${t("，未绘制联系。", "; links cannot be drawn.")}` : "", guidance, selectedNote,
      t("每个片区连向本轮最近医院；箭头不是道路路线、实际患者分配或完整医疗服务网络。", "Each area links to its saved nearest hospital; arrows are not road routes, actual patient allocation or the full healthcare-service network.")].filter(Boolean).join(" ");
  }
  function renderConnectionStatus(context, links) {
    const node = context.root.querySelector("[data-medical-map-connections-status]");
    if (node) { const text = connectionStatusText(context, links); if (node.textContent !== text) node.textContent = text; }
    for (const input of context.root.querySelectorAll("[data-medical-map-connection]")) input.checked = context.showConnection;
    for (const button of context.root.querySelectorAll("[data-medical-map-connection-mode]")) {
      const pressed = String(button.dataset.medicalMapConnectionMode === (context.connectionMode || "all"));
      if (button.getAttribute?.("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
    }
  }
  function populationSymbolSVG(context, record) {
    const style = markerAppearance(context, record);
    return window.MedicalMapSymbols.populationSVG({ color: style.fillColor, selected: context.selected === record.key, emphasis: highlightedDemandKeys(context).includes(record.key) });
  }
  function sandboxPoints(context) {
    return pointRecords(context).filter(record => validPoint(record.row) && (record.kind === "hospital" || context.layer !== "hospital" || context.showPopulation || context.selected === record.key)).map(record => {
      const size = 16, height = record.kind === "hospital" ? 16 : 20;
      const image = record.kind === "hospital" ? hospitalRingSVG(context, record.row)
        .replace(/(<svg[^>]*>)/, `$1<circle cx="10" cy="10" r="9.5" fill="white" fill-opacity=".95"/>${context.selected === record.key ? '<circle cx="10" cy="10" r="9" fill="none" stroke="#214c68" stroke-width="1"/>' : ""}`)
        .replace("</svg>", `${highlightedHospitalKeys(context).includes(record.key) ? '<circle cx="17" cy="3" r="2.2" fill="#b75b12" stroke="white" stroke-width=".8"/>' : ""}</svg>`)
        : populationSymbolSVG(context, record);
      return { id: record.key, longitude: record.row.longitude, latitude: record.row.latitude, image, width: size, height, label: pointLabel(context, record), selected: context.selected === record.key, kind: record.kind };
    });
  }
  function renderSandboxPoints(context) {
    if (!context.sandbox || !current(context)) return;
    context.sandbox.setPoints(sandboxPoints(context));
    context.sandbox.select(context.selected);
    drawConnection(context);
    const note = context.root.querySelector("[data-medical-map-density-note]");
    if (note) note.textContent = context.t("绿环代表医院，蓝色小人代表人口片区；放大或全屏查看密集区域。", "Green rings are hospitals; blue people are population areas. Zoom or enter fullscreen to inspect dense areas.");
  }
  function initializeSandbox(context, canvas) {
    const serial = context.sandboxSerial = (context.sandboxSerial || 0) + 1;
    context.sandboxPending = true; context.sandboxBackgroundPending = true;
    status(context, "");
    context.sandboxController = new AbortController();
    const active = () => current(context) && serial === context.sandboxSerial;
    const fallback = error => {
      if (!active()) return;
      context.sandboxSerial++; context.sandboxController.abort();
      context.sandbox?.destroy(); context.sandbox = null; context.sandboxPending = false; context.sandboxFailed = true;
      canvas.innerHTML = ""; initializeMap(context);
      sandboxIssue(context, error);
    };
    window.GeographicSandbox.create(canvas, {
      session_id: context.options.sessionId, iteration: Number(context.options.iteration || 1), language: context.options.language,
      signal: context.sandboxController.signal, assessmentStyle: "medical",
      analysisBasemap: basemapConfig(context.data),
      onSelect: key => { if (active()) select(context, key, false); },
      onStatus: value => { if (active()) status(context, typeof value === "string" ? value : value?.message || ""); },
      onBackgroundState: value => {
        if (!active() || value?.state !== "loading") return;
        context.sandboxIssue = ""; context.sandboxBackgroundPending = true; status(context, value.message || "");
        const button = context.root.querySelector('[data-medical-map-action="retry-3d"]');
        if (button) { button.hidden = true; button.disabled = true; }
      },
      onBackgroundError: error => { if (active()) sandboxIssue(context, error, true); },
      onRetry: () => { if (active()) retrySandbox(context); },
      onBackgroundReady: metadata => {
        if (!active()) return;
        context.sandboxIssue = ""; context.sandboxBackgroundPending = false;
        context.sandboxBackgroundNote = metadata?.local ? context.t("当前视野的立体建筑已加载；医院与居民点仍按本轮坐标显示，移动或缩放后按视野补充建筑背景。", "Local buildings have loaded. Saved hospital and population points remain unchanged; move or zoom to load further local detail.") : "";
        const button = context.root.querySelector('[data-medical-map-action="retry-3d"]');
        if (button) { button.hidden = true; button.disabled = false; }
        status(context, "");
      },
      onError: fallback,
    }).then(adapter => {
      if (!active()) { adapter.destroy(); return; }
      context.sandboxPending = false; context.sandbox = adapter;
      context.sandboxBackgroundPending = !context.sandboxIssue && adapter.manifest?.background_pending === true;
      status(context, "");
      renderSandboxPoints(context); adapter.resize();
    }).catch(error => {
      if (!active() || error.name === "AbortError") return;
      fallback(error);
    });
  }
  function initializeMap(context) {
    if (context.map || context.fallback || context.sandbox || context.sandboxPending) return;
    const canvas = context.root.querySelector("[data-medical-map-canvas]");
    observeSize(context, canvas);
    const points = pointRecords(context).filter(record => validPoint(record.row));
    if (!points.length) { context.fallback = true; drawGrid(context); return; }
    // A hidden tab has no viewport for Leaflet to fit. Observe it now and create
    // the map only after a real width and height are available.
    if (!visibleCanvas(context)) { context.initializationPending = true; return; }
    context.initializationPending = false;
    if (window.GeographicSandbox && context.options.sessionId && !context.sandboxFailed) { initializeSandbox(context, canvas); return; }
    if (!window.L?.map) { context.fallback = true; drawGrid(context); return; }
    try {
      const sourceBasemap = basemapConfig(context.data);
      const basemap = window.ResCityPresentationMask?.basemap?.(sourceBasemap) || sourceBasemap;
      context.map = window.L.map(canvas, { zoomControl: true, attributionControl: true, scrollWheelZoom: true, preferCanvas: false, worldCopyJump: false, zoomSnap: 0.25, zoomDelta: 0.5, maxZoom: basemap.maxZoom, minZoom: 2 });
      const mapInstance = context.map;
      context.map.attributionControl.setPrefix(false);
      context.tiles = window.L.tileLayer(basemap.tileUrl, { maxZoom: basemap.maxZoom, crossOrigin: false, referrerPolicy: "strict-origin-when-cross-origin", attribution: basemap.attribution });
      context.tiles.on("loading", () => { if (current(context) && context.map === mapInstance) { context.tileErrors = 0; context.tileSuccesses = 0; } });
      context.tiles.on("tileerror", () => {
        if (!current(context) || context.map !== mapInstance) return;
        context.tileErrors++;
        status(context, context.t("部分底图瓦片未能加载，当前位置点与图例仍有效；空白处没有道路背景，请检查网络后缩放或平移重试。", "Some basemap tiles could not load. Coordinate points and the legend remain valid; blank areas lack a road background. Check the network, then zoom or pan to retry."));
      });
      context.tiles.on("tileload", () => { if (!current(context) || context.map !== mapInstance) return; context.tileSuccesses++; window.clearTimeout?.(context.tileTimer); if (!context.tileErrors) status(context, ""); });
      context.tiles.on("load", () => { if (current(context) && context.map === mapInstance && !context.tileErrors && context.tileSuccesses) status(context, ""); });
      context.tiles.addTo(context.map);
      context.presentationOff = window.ResCityPresentationMask?.bindLeaflet?.(context.tiles, context.map, sourceBasemap);
      context.tileTimer = window.setTimeout?.(() => { if (current(context) && context.map === mapInstance && !context.tileSuccesses && !context.tileErrors) status(context, context.t("底图加载较慢，已保留真实坐标点与图例；底图出现前请勿将空白背景理解为缺少道路。", "The basemap is taking longer to load. Actual coordinate points and the legend remain visible; a blank background does not mean there are no roads.")); }, 12000);
      context.connection = window.L.layerGroup().addTo(context.map);
      context.pointsLayer = window.L.layerGroup().addTo(context.map);
      fit(context); renderPointLayers(context);
      context.map.on("zoomend", () => { if (current(context) && context.map === mapInstance) renderPointLayers(context); });
    } catch (_error) {
      context.resizeObserver?.disconnect(); window.clearTimeout?.(context.tileTimer); context.map?.remove(); context.map = null; context.markers = []; context.fallback = true;
      drawGrid(context);
    }
  }
  function drawGrid(context) {
    const { t } = context, canvas = context.root.querySelector("[data-medical-map-canvas]");
    const points = pointRecords(context).filter(record => validPoint(record.row));
    if (!points.length) {
      canvas.innerHTML = `<div class="medical-map-no-coordinates"><strong>${t("尚无可定位的有效坐标", "No valid geographic coordinates")}</strong><p>${context.compact ? t("本轮医院和居民点缺少有效经纬度。已有计算指标仍可在下方专题中查看。", "Hospitals and population points lack valid coordinates in this round. Existing results remain available in the analysis below.") : t("请补充医院或居民点的 WGS84 经纬度；右侧仍可查询已有指标。", "Add WGS84 coordinates for hospitals or population points. Existing indicators remain available on the right.")}</p></div>`;
      status(context, ""); return;
    }
    const lon = points.map(record => record.row.longitude), lat = points.map(record => record.row.latitude);
    const minLon = Math.min(...lon), maxLon = Math.max(...lon), minLat = Math.min(...lat), maxLat = Math.max(...lat);
    const spanLon = Math.max(maxLon - minLon, 0.01), spanLat = Math.max(maxLat - minLat, 0.01);
    const x = value => 60 + (value - minLon + spanLon * 0.08) / (spanLon * 1.16) * 620;
    const y = value => 370 - (value - minLat + spanLat * 0.08) / (spanLat * 1.16) * 310;
    context.gridArrowId ||= `medical-population-arrow-${++gridArrowSerial}`;
    const relations = connectionRecords(context).map(link => {
      const coordinates = window.MedicalMapSymbols.curvedCoordinates(link.node, link.hospital);
      const path = coordinates.slice(0, Math.floor((coordinates.length - 1) * .9) + 1).map(point => `${x(point[0])},${y(point[1])}`).join(' ');
      return `<polyline points="${path}" fill="none" stroke="${link.selected ? '#b35413' : '#267b96'}" stroke-width="${link.selected ? 2.6 : context.connectionMode === 'concise' ? 1.4 : .85}" opacity="${link.selected ? .96 : context.connectionMode === 'concise' ? .58 : .28}" marker-end="url(#${context.gridArrowId})"/>`;
    }).join('');
    canvas.innerHTML = `<svg class="medical-map-coordinate-grid" viewBox="0 0 740 440" role="img" aria-label="${t("经纬度坐标示意，非真实底图", "Longitude/latitude diagram, not a basemap")}"><rect width="740" height="440" fill="#f7faf9"/>${Array.from({ length: 5 }, (_, index) => {
      const longitude = minLon + spanLon * index / 4, latitude = minLat + spanLat * index / 4;
      return `<path d="M${x(longitude)} 30V380 M50 ${y(latitude)}H695" stroke="#d2dedd" stroke-width="1"/><text x="${x(longitude)}" y="403" text-anchor="middle">${number(longitude, 3)}</text><text x="46" y="${y(latitude) + 4}" text-anchor="end">${number(latitude, 3)}</text>`;
    }).join("")}<text x="375" y="430" text-anchor="middle">${t("经度", "Longitude")} / WGS84</text><text x="12" y="24">${t("纬度", "Latitude")}</text><defs><marker id="${context.gridArrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 1L9 5L0 9Z" fill="#267b96"/></marker></defs>${relations}${points.filter(record => record.kind === "hospital" || context.layer !== "hospital" || context.showPopulation || context.selected === record.key).map(record => {
      return `<g data-medical-map-select="${record.key}" role="button" tabindex="0" aria-label="${esc(pointLabel(context, record))}"><title>${esc(pointLabel(context, record))}</title>${record.kind === "hospital" ? hospitalRingSVG(context, record.row, { x: x(record.row.longitude), y: y(record.row.latitude) }) : populationSymbolSVG(context, record).replace('<svg ', `<svg x="${x(record.row.longitude) - 8}" y="${y(record.row.latitude) - 10}" `)}</g>`;
    }).join("")}</svg>`;
    for (const point of canvas.querySelectorAll("[data-medical-map-select]")) point.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); select(context, point.dataset.medicalMapSelect, false); } });
    status(context, t("交互底图库未能加载，当前为真实坐标的经纬度网格示意，不是街道底图。可点击点查看数据。", "The interactive map library did not load. This is a longitude/latitude diagram of actual coordinates, not a street basemap. Select points to inspect their data."));
  }
  function destroy(container) {
    const context = mounts.get(container);
    if (!context) return;
    context.presentationOff?.();
    context.fullscreen?.destroy();
    context.sandboxSerial = (context.sandboxSerial || 0) + 1; context.sandboxController?.abort(); context.sandbox?.destroy();
    context.resizeObserver?.disconnect(); window.clearTimeout?.(context.tileTimer); context.map?.remove(); mounts.delete(container);
  }
  function mount(container, options) {
    if (!container || !options?.sessionId) return;
    const entry = request(options), key = JSON.stringify([identity(options), options.selectedScenario ?? null, String(options.sourceSignature || ""), options.compact === true]);
    const previous = mounts.get(container);
    if (previous?.key === key && previous.entry === entry) {
      previous.options = options;
      if (options.selectedHospitalId != null || options.selectedNodeId != null) selectRecord(container, { hospitalId: options.selectedHospitalId, nodeId: options.selectedNodeId, pan: options.pan });
      resize(container);
      return;
    }
    destroy(container);
    const context = { container, options, entry, key, t: tr(options.language), compact: options.compact === true, layer: options.compact === true ? "hospital" : "accessibility", period: "after", selected: null, connectionMode: "all", showConnection: true, showPopulation: true, tileErrors: 0, tileSuccesses: 0 };
    mounts.set(container, context);
    container.innerHTML = stateHTML(context, "loading");
    const complete = () => {
      if (!current(context)) return;
      if (entry.error) {
        container.innerHTML = stateHTML(context, "error");
        container.querySelector("[data-medical-map-action=retry]")?.addEventListener("click", () => { request(options, true); mount(container, options); });
        return;
      }
      context.data = entry.data; context.scenario = scenarioFor(entry.data, options.selectedScenario);
      if (!context.scenario) { container.innerHTML = stateHTML(context, "empty"); return; }
      renderShell(context);
      if (context.options.selectedHospitalId != null || context.options.selectedNodeId != null) selectRecord(container, { hospitalId: context.options.selectedHospitalId, nodeId: context.options.selectedNodeId, pan: context.options.pan });
    };
    if (entry.data || entry.error) complete(); else entry.promise.then(complete);
  }
  function resize(container) {
    const context = mounts.get(container);
    if (!context) return;
    afterPaint(() => {
      if (!current(context) || !visibleCanvas(context)) return;
      if (context.initializationPending) initializeMap(context);
      context.sandbox?.resize();
      if (context.map) {
        context.map.invalidateSize({ animate: false, pan: false });
        // Fit once when a usable viewport first appears. Later tab switches
        // and container resizes preserve the user's pan and zoom.
        if (!context.hasFitted) fit(context);
        if (context.pointsLayer && context.pointView !== pointView(context)) renderPointLayers(context);
      }
    });
  }
  window.MedicalMap = Object.freeze({ mount, update: mount, resize, select: selectRecord, destroy, basemapConfig });
})();
