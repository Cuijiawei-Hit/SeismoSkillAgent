(function () {
  "use strict";

  // Geographic background only. Engineering values and facility symbols belong to the host.
  const contexts = new WeakMap();
  const BASE = "/vendor/rescity/vendor/cesium/";
  const API = "/api/engineering/geographic-scenes";
  // A shared oblique opening view keeps the map readable while showing relief.
  const DEFAULT_VIEW = Object.freeze({ pitch: -35, heading: 0, padding: 1.06 });
  // Render at the display's native density, within one full 4K frame and GPU limits.
  const MAX_RENDER_PIXELS = 3840 * 2160;
  const DETAIL_EDGE_KM = 3;
  const REQUEST_TIMEOUT_MS = 30000;
  let libraryPromise = null;
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const rows = value => Array.isArray(value) ? value : [];
  const abortError = () => new DOMException("地图准备已取消", "AbortError");
  const tr = (context, zh, en) => /^en(?:-|$)/i.test(context.options.language || "") ? en : zh;
  const alive = context => !context.destroyed && !context.controller.signal.aborted && contexts.get(context.container) === context;
  const assertAlive = context => { if (!alive(context)) throw abortError(); };
  const pointCoordinates = point => [point.longitude ?? point.lon, point.latitude ?? point.lat];
  const validCoordinates = point => Array.isArray(point) && finite(point[0]) && finite(point[1]) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85;
  const validBounds = bbox => Array.isArray(bbox) && bbox.length === 4 && bbox.every(finite)
    && bbox[0] < bbox[2] && bbox[1] < bbox[3] && validCoordinates(bbox.slice(0, 2)) && validCoordinates(bbox.slice(2));
  const sameBounds = (a, b) => validBounds(a) && validBounds(b) && a.every((value, i) => Math.abs(value-b[i]) < 1e-6);
  function mapError(message, stage, code, cause) {
    return Object.assign(new Error(message, cause ? { cause } : undefined), { stage, code });
  }

  function status(context, zh, en = zh) {
    if (!alive(context)) return;
    const text = tr(context, zh, en);
    if (context.statusDetail) context.statusDetail.textContent = text;
    else if (context.statusNode) context.statusNode.textContent = text;
    if (typeof context.options.onStatus === "function") context.options.onStatus(text);
  }

  function loadingState(context, state) {
    if (!alive(context)) return;
    context.loadingState = state;
    context.container.dataset.geographicLoading = state;
    const pending = state === "loading" || state === "background";
    if (!pending) { clearTimeout(context.loadingTimer); context.loadingTimer = null; }
    if (!context.statusTitle) return;
    context.statusNode.hidden = state === "ready";
    context.statusNode.dataset.state = state;
    context.statusNode.classList.toggle("is-preview", state === "background" || state === "failed");
    context.statusNode.setAttribute("aria-busy", String(pending));
    context.statusTitle.textContent = state === "failed" ? context.ready
      ? tr(context, "立体建筑背景加载失败", "Building background could not load") : tr(context, "三维地图加载失败", "3D map could not load")
      : context.loadingSlow ? tr(context, "三维地图加载较慢，请稍候", "The 3D map is taking longer to load")
      : tr(context, "正在加载 3D 地图，请稍候", "Loading the 3D map, please wait");
    context.statusHelp.textContent = state === "failed" ? tr(context,
      "当前地图预览和评估结果仍可查看。请重试加载三维，无需重新评估。",
      "The map preview and assessment results remain available. Retry the map without rerunning the assessment.")
      : state === "background" ? tr(context,
        "可先查看当前底图预览和评估结果；立体建筑加载完成后会自动替换。",
        "You can use the current basemap preview and results. Buildings will appear automatically when ready.")
      : context.options.lightweightAnalysis === true ? tr(context,
        "正在载入本轮评估对象与空间图层。", "Loading saved assessment objects and spatial layers.")
      : tr(context, "首次加载需准备建筑与道路，可能需要一些时间。", "The first load prepares buildings and roads and may take some time.");
    context.retryButton.hidden = state !== "failed" || !context.sceneScope && typeof context.options.onRetry !== "function";
  }

  function backgroundIssue(context, error) {
    if (error?.name === "AbortError" || error?.stage && error.stage !== "source") return error;
    const detail = String(error?.message || error || "");
    if (/设施图标|三维地图绘制|Geometry|WebGL|render/i.test(detail)) return mapError(detail, "render", "RENDER_FAILED", error);
    if (/三维地图资源|三维地图引擎|Cesium/i.test(detail)) return mapError(detail, "engine", "ENGINE_FAILED", error);
    const message = /timeout|time[ -]?out|504|超时|超过\s*120\s*秒/i.test(detail)
      ? tr(context, "建筑与道路地图源响应超时，请检查网络后重试", "The building and road source timed out; check your connection and retry")
      : /HTTPStatusError|https?:\/\/|502|503|Bad Gateway/i.test(detail)
        ? tr(context, "地图源暂时无法提供建筑与道路背景，请稍后重试", "The map source is temporarily unavailable; please retry later") : detail;
    return Object.assign(mapError(message, "source", error?.code || (/timeout|time[ -]?out|504|超时/i.test(detail) ? "SOURCE_TIMEOUT" : "SOURCE_FAILED"), error), { technicalMessage: detail });
  }

  function loadLibrary() {
    if (window.Cesium) return Promise.resolve(window.Cesium);
    if (libraryPromise) return libraryPromise;
    window.CESIUM_BASE_URL = BASE;
    if (!document.querySelector("link[data-geographic-cesium]")) {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = BASE + "Widgets/widgets.css";
      css.dataset.geographicCesium = "true"; document.head.append(css);
    }
    libraryPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = BASE + "Cesium.js"; script.async = true;
      const timer = setTimeout(() => finish(mapError("本地三维地图引擎加载超时，请重试加载地图", "engine", "ENGINE_TIMEOUT")), 45000);
      function finish(error) {
        clearTimeout(timer); script.onload = null; script.onerror = null;
        if (error) { script.remove(); libraryPromise = null; reject(error); }
        else resolve(window.Cesium);
      }
      script.onload = () => finish(window.Cesium ? null : mapError("三维地图引擎未完成加载", "engine", "ENGINE_UNAVAILABLE"));
      script.onerror = () => finish(mapError("无法加载本地三维地图引擎，请重试加载地图", "engine", "ENGINE_UNAVAILABLE"));
      document.head.append(script);
    });
    return libraryPromise;
  }

  async function json(context, url, options = {}) {
    assertAlive(context);
    const { timeoutMs = REQUEST_TIMEOUT_MS, ...request } = options;
    const controller = new AbortController(), parent = context.controller.signal;
    let timedOut = false;
    const abort = () => controller.abort();
    parent.addEventListener("abort", abort, { once: true });
    if (parent.aborted) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
    try {
      const response = await fetch(url, { ...request, signal: controller.signal });
      const type = response.headers.get("content-type") || "";
      if (!type.includes("json")) throw mapError("地图服务未返回有效地理数据", "request", "INVALID_RESPONSE");
      const value = await response.json();
      assertAlive(context);
      if (!response.ok) throw mapError(value?.detail || value?.message || `地图服务请求失败（${response.status}）`, "request", "HTTP_"+response.status);
      return value;
    } catch (error) {
      if (parent.aborted || !alive(context)) throw abortError();
      if (timedOut) throw mapError("地图服务单次请求超时，可重试背景，当前评估对象仍保留", "request", "REQUEST_TIMEOUT", error);
      throw error?.stage ? error : mapError("地图服务连接失败，请稍后重试背景", "request", "REQUEST_FAILED", error);
    } finally {
      clearTimeout(timer); parent.removeEventListener("abort", abort);
    }
  }

  function sourcePayload(options) {
    const source = options.source || options;
    let payload;
    if (source.session_id) payload = { session_id: source.session_id, ...(source.iteration != null ? { iteration: source.iteration } : {}) };
    else if (source.dataset_version_id) payload = { dataset_version_id: source.dataset_version_id };
    else if (source.dataset_id) payload = { dataset_id: source.dataset_id, revision: source.revision ?? source.draft_revision };
    else throw new Error("三维地图需要当前城市数据或评估记录");
    if (source.view_bbox != null) {
      const bounds = source.view_bbox;
      if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(finite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error("局部地图范围无效");
      payload.view_bbox = [...bounds];
    }
    return payload;
  }

  function analysisManifest(options) {
    if (options.powerRegionalMode !== true || options.lightweightAnalysis !== true) return null;
    const bbox = options.analysisBounds || options.analysisManifest?.city?.bbox || options.analysisManifest?.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finite) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3] ||
      !validCoordinates(bbox.slice(0, 2)) || !validCoordinates(bbox.slice(2))) throw new Error("三维分析视图缺少有效的评估坐标范围");
    // This is a presentation manifest over WGS84, not a synthetic city or engineering result.
    // It requires no scene-generation job, buildings download, terrain claim or database write.
    return { schema: "rescity.power-analysis-view.v1", coordinate_system: "WGS84", bbox: [...bbox],
      center: [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2], analysis_only: true,
      height_note: "三维分析视图，未载入实测地形；对象采用评估记录的经纬度。",
      assets: { buildings: { features: [] }, roads: [], landscape: { features: [] } } };
  }

  function wait(context, milliseconds) {
    return new Promise((resolve, reject) => {
      const signal = context.controller.signal;
      const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(abortError()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  async function readSceneData(context, manifest) {
    const city = manifest.city || manifest;
    if (city.coordinate_system && city.coordinate_system !== "WGS84") throw new Error("三维地图需要 WGS84 经纬度");
    if (!Array.isArray(city.bbox) || city.bbox.length !== 4 || !city.bbox.every(finite) || city.bbox[0] >= city.bbox[2] || city.bbox[1] >= city.bbox[3]) throw new Error("区域地图边界无效");
    const center = validCoordinates(city.center) ? city.center : [(city.bbox[0] + city.bbox[2]) / 2, (city.bbox[1] + city.bbox[3]) / 2];
    const assets = manifest.assets || {};
    if (manifest.analysis_only) status(context, "正在准备评估位置与底图预览", "Preparing assessment locations and the basemap preview");
    else status(context, "正在读取建筑与道路数据", "Reading building and road data");
    const read = (name, fallback) => {
      const asset = assets[name] || manifest[name];
      return asset && typeof asset === "string" ? json(context, asset) : Promise.resolve(asset || fallback);
    };
    const [buildings, roads, landscape] = await Promise.all([read("buildings", { features: [] }), read("roads", []), read("landscape", { features: [] })]);
    assertAlive(context);
    return { manifest, city: { ...city, center }, buildings, roads: rows(roads.features || roads), landscape };
  }

  function describeBackground(context, data) {
    const count = rows(data.buildings?.features).length;
    const pending = data.manifest.background_pending === true;
    const local = validBounds(data.manifest.background_bbox) && !sameBounds(data.manifest.background_bbox, data.manifest.full_bbox);
    context.container.dataset.geographicBackground = pending ? "preparing" : local ? "partial" : data.manifest.analysis_only ? "analysis" : "ready";
    context.container.dataset.buildingCount = String(count);
    if (!context.note) return;
    if (!pending && local) {
      context.note.textContent = tr(context,
        `当前视野局部立体建筑 ${count.toLocaleString()} 栋 · 完整评估对象保持显示，其他区域仍为底图 · © OpenStreetMap contributors`,
        `${count.toLocaleString()} local building shapes · All assessment objects remain visible; other areas use the basemap · © OpenStreetMap contributors`);
      context.note.title = [data.manifest.height_note, data.manifest.extent_note,
        "建筑轮廓来自地图源；缺少实测高度时为示意高度。局部建筑背景不代表全域建筑已加载。"].filter(Boolean).join("\n");
      return;
    }
    if (context.options.assessmentStyle === 'building' && !pending) {
      context.note.textContent = tr(context,
        '彩色实体：评估建筑 · 灰白：区域背景 · 高度及来源见对象详情 · © OpenStreetMap contributors',
        'Colored solids: assessed buildings · Gray: background · Height sources in object details · © OpenStreetMap contributors');
      context.note.title = '屋顶与侧面使用同一评估状态；缺少高度时采用12米示意值。';
      return;
    }
    context.note.textContent = pending ? tr(context,
      "立体建筑准备中 · 当前为倾斜底图预览，尚未加载建筑",
      "Buildings preparing · Tilted basemap preview; building geometry has not loaded") : data.manifest.analysis_only === true ? tr(context,
      "三维分析视图 · 未载入实测地形 · 标签引线指向评估坐标，图标错位仅用于阅读",
      "3D analysis view · No measured terrain loaded · Leaders show saved coordinates; symbol offsets are for readability") : count ? tr(context,
      `立体建筑 ${count.toLocaleString()} 栋 · © OpenStreetMap contributors · 高度为展示示意`,
      `${count.toLocaleString()} building shapes · © OpenStreetMap contributors · Heights are schematic`) : tr(context,
      "地理背景已加载 · 地图源未提供该范围的建筑轮廓",
      "Geographic background loaded · No building footprints provided for this area");
    context.note.title = [data.manifest.height_note, data.manifest.extent_note].filter(Boolean).join("\n");
  }

  async function finishSceneJob(context, initialJob) {
    let job = initialJob;
    const started = Date.now();
    while (job.status !== "ready") {
      if (job.status === "failed") throw mapError(job.message || "此区域的地理背景暂时无法准备", "source", job.error_code || "SOURCE_FAILED");
      if (Date.now() - started > 12 * 60 * 1000) throw mapError("局部建筑背景准备超时，可稍后重试，评估对象仍可查看", "source", "SCENE_TIMEOUT");
      status(context, job.message || "正在准备区域建筑、道路与绿地", "Preparing the area's buildings, roads and landscape");
      if (typeof context.options.onProgress === "function") context.options.onProgress(job);
      backgroundState(context, "loading", { bbox: context.requestedBackgroundBounds, ...job });
      const id = job.job_id || job.scene_id;
      if (!id) throw new Error("地图服务未提供有效任务编号");
      await wait(context, 1500);
      job = await json(context, API + "/" + encodeURIComponent(id), { timeoutMs: Math.min(REQUEST_TIMEOUT_MS, Math.max(1, 12*60*1000-(Date.now()-started))) });
    }
    const manifest = job.manifest || await json(context, job.manifest_url || API + "/" + encodeURIComponent(job.scene_id || job.job_id) + "/manifest");
    return readSceneData(context, manifest);
  }

  async function loadScene(context) {
    let manifest = analysisManifest(context.options) || context.options.manifest || context.options.scene;
    if (typeof manifest === "string") manifest = await json(context, manifest);
    if (manifest) return readSceneData(context, manifest);
    const payload = sourcePayload(context.options);
    // Resolving the authorized extent does not start a city-wide OSM download.
    const scope = await json(context, API + "/scope", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    if (!validBounds(scope.bbox)) throw mapError("地图服务未提供有效评估范围", "request", "INVALID_SCOPE");
    context.sceneScope = scope;
    const bbox = scope.bbox;
    const initial = await readSceneData(context, {
      schema: "rescity.progressive-scene.v1", coordinate_system: "WGS84", bbox: [...bbox],
      center: [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2],
      analysis_only: true, background_pending: true, progressive_background: true,
      full_bbox: scope.full_bbox || bbox, title: scope.title,
      height_note: "展示底板不表示实测地形；评估对象使用本轮保存的位置，建筑与道路背景按视野局部加载。",
      assets: { buildings: { features: [] }, roads: [], landscape: { features: [] } },
    });
    return { ...initial, backgroundRequest: detailBounds(context.options.backgroundBounds || bbox, bbox) };
  }

  async function upgradeMedicalBackground(context, data) {
    assertAlive(context);
    const previous = context.background, previousData = context.data;
    // Detail geometry changes independently of the complete assessment extent.
    // The camera, exact facility/link overlays and full-area basemap stay live.
    if (context.sceneScope) data = { ...data, city: previousData.city,
      manifest: { ...data.manifest, progressive_background: true, background_bbox: [...data.city.bbox],
        full_bbox: context.sceneScope.full_bbox || context.sceneScope.bbox } };
    context.background = []; context.data = data;
    try {
      status(context, "正在绘制立体建筑与道路", "Drawing 3D buildings and roads");
      buildBackground(context, data);
      await waitForBackground(context);
      assertAlive(context);
      for (const primitive of previous) context.viewer.scene.primitives.remove(primitive);
      if (!context.sceneScope) clearAnalysisBasemap(context);
      if (context.adapter) context.adapter.manifest = data.manifest;
      describeBackground(context, data);
      context.viewer.scene.requestRender();
      loadingState(context, "ready");
      status(context, "", "");
      const meta = { bbox: data.manifest.background_bbox || data.city.bbox,
        full_bbox: context.sceneScope?.full_bbox || context.sceneScope?.bbox || data.city.bbox,
        building_count: rows(data.buildings?.features).length, local: !!context.sceneScope && !sameBounds(data.manifest.background_bbox, context.sceneScope.bbox) };
      meta.map_scope = meta.local ? "local" : "full";
      backgroundState(context, "ready", meta);
      if (typeof context.options.onBackgroundReady === "function") context.options.onBackgroundReady(meta);
    } catch (error) {
      if (alive(context)) {
        for (const primitive of context.background) context.viewer.scene.primitives.remove(primitive);
        context.background = previous; context.data = previousData;
      }
      throw error;
    }
  }

  function startMedicalBackground(context, data) {
    if (data.backgroundRequest) { queueBackground(context, data.backgroundRequest); return; }
    if (!data.backgroundPromise) return;
    loadingState(context, "background");
    status(context, "正在后台加载立体建筑与道路，完成后自动替换", "Loading buildings and roads in the background; they will appear automatically");
    data.backgroundPromise.then(next => upgradeMedicalBackground(context, next)).catch(error => {
      if (!alive(context) || error.name === "AbortError") return;
      context.container.dataset.geographicBackground = "unavailable";
      if (context.note) context.note.textContent = tr(context,
        "立体建筑尚未加载 · 当前为倾斜底图预览",
        "Building background unavailable · Current view is a tilted basemap preview");
      const issue = backgroundIssue(context, error);
      loadingState(context, "failed");
      status(context, String(issue?.message || issue));
      if (typeof context.options.onBackgroundError === "function") context.options.onBackgroundError(issue);
    });
  }

  // Limit optional detail geometry, never the saved engineering network.
  function detailBounds(view, full, maximumEdgeKm = DETAIL_EDGE_KM) {
    if (!validBounds(full)) throw mapError("缺少有效的背景授权范围", "request", "INVALID_SCOPE");
    const middle = [(full[0]+full[2])/2, (full[1]+full[3])/2];
    const widthKm = (full[2]-full[0])*111.195*Math.cos(middle[1]*Math.PI/180);
    const heightKm = (full[3]-full[1])*111.195;
    if (widthKm <= maximumEdgeKm && heightKm <= maximumEdgeKm) return [...full];
    const region = validBounds(view) ? view : full;
    const viewWidth = (region[2]-region[0])*111.195*Math.cos((region[1]+region[3])/2*Math.PI/180);
    const viewHeight = (region[3]-region[1])*111.195;
    const edgeKm = Math.min(maximumEdgeKm, Math.max(.25,viewWidth,viewHeight));
    // A stable 250m center grid avoids refetching nearly identical views.
    const latStep = .25/111.195, lonStep = latStep/Math.max(.08, Math.cos(middle[1]*Math.PI/180));
    let cy = clamp(Math.round(((region[1]+region[3])/2)/latStep)*latStep, full[1], full[3]);
    let cx = clamp(Math.round(((region[0]+region[2])/2)/lonStep)*lonStep, full[0], full[2]);
    const halfY = Math.min(edgeKm/111.195/2, (full[3]-full[1])/2);
    const halfX = Math.min(edgeKm/(111.195*Math.max(.08,Math.cos(cy*Math.PI/180)))/2, (full[2]-full[0])/2);
    cx = clamp(cx, full[0]+halfX, full[2]-halfX); cy = clamp(cy, full[1]+halfY, full[3]-halfY);
    return [cx-halfX,cy-halfY,cx+halfX,cy+halfY].map((value,i)=>{
      const rounded=Number(value.toFixed(7));
      return i<2 ? Math.max(full[i],rounded) : Math.min(full[i],rounded);
    });
  }

  function backgroundState(context, state, meta = {}) {
    if (!alive(context)) return;
    context.backgroundState = state;
    if (typeof context.options.onBackgroundState === "function") context.options.onBackgroundState({ ...meta, state });
  }

  function backgroundCoversView(background, view) {
    if (!validBounds(background) || !validBounds(view)) return false;
    const x=(view[0]+view[2])/2,y=(view[1]+view[3])/2;
    const mx=(background[2]-background[0])*.15,my=(background[3]-background[1])*.15;
    return x>=background[0]+mx&&x<=background[2]-mx&&y>=background[1]+my&&y<=background[3]-my;
  }

  function queueBackground(context, bounds, retry = false) {
    if (!alive(context) || !context.sceneScope) return Promise.resolve(false);
    const bbox = detailBounds(bounds || context.requestedBackgroundBounds || context.sceneScope.bbox, context.sceneScope.bbox, context.detailEdgeKm || DETAIL_EDGE_KM);
    if (context.backgroundTask) {
      if ((!retry && backgroundCoversView(context.requestedBackgroundBounds,bounds)) || sameBounds(bbox,context.requestedBackgroundBounds)) {
        // The user may return to the active view after briefly visiting another
        // area. Only the latest request survives; do not keep a stale queued view.
        context.nextBackgroundBounds = null;
        return context.backgroundTask;
      }
      context.nextBackgroundBounds = bbox;
      return context.backgroundTask;
    }
    if (!retry && context.backgroundState === "ready" && backgroundCoversView(context.loadedBackgroundBounds,bounds)) return Promise.resolve(true);
    if (!retry && context.backgroundState === "ready" && sameBounds(bbox, context.loadedBackgroundBounds)) return Promise.resolve(true);
    context.requestedBackgroundBounds = bbox;
    loadingState(context, "background");
    status(context, "正在加载当前视野附近的立体建筑与道路；完整评估对象保持显示", "Loading nearby buildings and roads; all assessment objects remain available");
    backgroundState(context, "loading", { bbox });
    const task = (async () => {
      try {
        const payload = sourcePayload(context.options);
        if (!sameBounds(bbox, context.sceneScope.bbox)) payload.view_bbox = bbox;
        if (retry || context.options.retry !== false) payload.retry = true;
        const job = await json(context, API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const next = await finishSceneJob(context, job);
        assertAlive(context);
        // If the user has already moved elsewhere, load only the latest queued view.
        if (context.nextBackgroundBounds && !sameBounds(context.nextBackgroundBounds, bbox)) return false;
        await upgradeMedicalBackground(context, next);
        context.loadedBackgroundBounds = bbox;
        return true;
      } catch (error) {
        if (!alive(context) || error.name === "AbortError") return false;
        const issue = backgroundIssue(context, error);
        const currentEdge = Math.max((bbox[2]-bbox[0])*111.195*Math.cos((bbox[1]+bbox[3])/2*Math.PI/180),(bbox[3]-bbox[1])*111.195);
        if (issue.code === "source_capacity" && !context.backgroundCapacityRetried && currentEdge>.1) {
          context.backgroundCapacityRetried = true;
          context.detailEdgeKm = Math.min(context.detailEdgeKm || DETAIL_EDGE_KM,currentEdge)/2;
          context.nextBackgroundBounds = detailBounds(context.nextBackgroundBounds || bbox,context.sceneScope.bbox,context.detailEdgeKm);
          status(context,"当前视野建筑较密，正在缩小单次背景范围重试；完整评估对象仍保留", "Dense building background; retrying a smaller detail area while retaining all assessment objects");
          backgroundState(context,"loading",{bbox:context.nextBackgroundBounds,stage:"source",code:"source_capacity",adaptive_retry:true});
          return false;
        }
        context.container.dataset.geographicBackground = context.loadedBackgroundBounds ? "partial" : "unavailable";
        if (context.note) context.note.textContent = tr(context,
          context.loadedBackgroundBounds ? "本视野建筑背景未完成 · 保留已加载局部建筑、完整评估对象与底图" : "立体建筑背景尚未加载 · 当前仅有评估对象与倾斜底图预览",
          "Building background incomplete; saved assessment objects and the basemap remain available");
        loadingState(context, "failed"); status(context, String(issue?.message || issue));
        backgroundState(context, "failed", { bbox, stage: issue.stage, code: issue.code, message: issue.message });
        if (typeof context.options.onBackgroundError === "function") context.options.onBackgroundError(issue);
        return false;
      } finally {
        if (context.backgroundTask === task) context.backgroundTask = null;
        const queued = context.nextBackgroundBounds; context.nextBackgroundBounds = null;
        if (alive(context) && queued && !sameBounds(queued, bbox)) queueBackground(context, queued);
      }
    })();
    context.backgroundTask = task;
    return task;
  }

  function cameraBounds(context) {
    const viewer = context.viewer, C = context.C;
    if (!alive(context) || !viewer || viewer.isDestroyed?.()) return null;
    const canvas = viewer.scene.canvas;
    // The center ray gives the ground location actually being inspected, even
    // when an oblique rectangle extends toward a distant horizon.
    if (canvas?.clientWidth > 0 && canvas.clientHeight > 0 && C.Cartesian2 && C.Cartographic?.fromCartesian && viewer.camera.pickEllipsoid) {
      const positions = [[canvas.clientWidth/2,canvas.clientHeight/2],[0,0],[canvas.clientWidth,0],[0,canvas.clientHeight],[canvas.clientWidth,canvas.clientHeight]];
      const locations = positions.map(([x,y])=>viewer.camera.pickEllipsoid(new C.Cartesian2(x,y),viewer.scene.globe.ellipsoid))
        .map(point=>point&&C.Cartographic.fromCartesian(point)).map(location=>location&&[location.longitude*180/Math.PI,location.latitude*180/Math.PI]);
      const center=locations[0],valid=locations.filter(validCoordinates);
      if (validCoordinates(center) && valid.length>=3) {
        const xs=valid.map(p=>p[0]),ys=valid.map(p=>p[1]);
        const halfX=(Math.max(...xs)-Math.min(...xs))/2,halfY=(Math.max(...ys)-Math.min(...ys))/2;
        const bounds=[center[0]-halfX,center[1]-halfY,center[0]+halfX,center[1]+halfY];
        if (validBounds(bounds)) return bounds;
      }
    }
    const rectangle = viewer?.camera.computeViewRectangle?.(viewer.scene.globe.ellipsoid);
    if (!rectangle) return null;
    const bbox = [rectangle.west, rectangle.south, rectangle.east, rectangle.north].map(value=>value*180/Math.PI);
    return validBounds(bbox) ? bbox : null;
  }

  function watchBackgroundView(context) {
    if (!context.sceneScope || !context.viewer?.camera.moveEnd?.addEventListener) return;
    context.offBackgroundMove = context.viewer.camera.moveEnd.addEventListener(() => {
      clearTimeout(context.backgroundViewTimer);
      context.backgroundViewTimer = setTimeout(() => {
        context.backgroundViewTimer = null;
        if (!alive(context) || !visible(context)) return;
        const bounds = cameraBounds(context);
        if (bounds) queueBackground(context, bounds);
      }, 700);
    });
  }

  // Road classes are global OSM attributes; no city names or local street names affect geometry.
  function roadWidth(road) {
    const width = Number(road.width);
    if (finite(width) && width > 0) return clamp(width, 2, 45);
    const category = String(road.highway || road.properties?.highway || "").replace(/_link$/, "");
    return ({ motorway: 24, trunk: 22, primary: 18, secondary: 14, tertiary: 11,
      residential: 7, unclassified: 7, living_street: 5, service: 4,
      pedestrian: 4, footway: 2, cycleway: 2, path: 2, track: 3 })[category] || 6;
  }

  function displayHeight(properties) {
    const known = properties.height_source !== "unknown" && finite(Number(properties.height)) && Number(properties.height) > 0;
    // Background relief is schematic and never used by the engineering model.
    return (known ? clamp(Number(properties.height), 4, 120) : 12) * 2;
  }

  function polygonParts(geometry) {
    if (geometry?.type === "MultiPolygon") return rows(geometry.coordinates);
    if (geometry?.type === "Polygon") return [rows(geometry.coordinates)];
    return [];
  }

  function normalizedRings(input) {
    if (input?.type) return polygonParts(input)[0] || [];
    if (!Array.isArray(input)) return [];
    const rings = Array.isArray(input[0]) && finite(input[0][0]) ? [input] : input;
    return rings.map(ring => rows(ring).filter(validCoordinates)).filter(ring => ring.length >= 3);
  }

  function sourceBuildingId(record) {
    const properties = record.properties || {};
    for (const value of [record.source_building_id, properties['OSM编号'], properties.osm_url, properties.id, record.source]) {
      const match = String(value || '').match(/(?:^|\/)(way|relation)\/(\d+)(?:\/|$)/);
      if (match) return match[1] + '/' + match[2];
    }
    return null;
  }

  function footprintKey(input) {
    const ring = normalizedRings(input)[0];
    if (!ring?.length) return null;
    const points = ring.map(point => point.map(value => value.toFixed(7)).join(','));
    if (points[0] === points[points.length - 1]) points.pop();
    const canonical = values => {
      const first = values.indexOf([...values].sort()[0]);
      return values.slice(first).concat(values.slice(0, first)).join(';');
    };
    return [canonical(points), canonical([...points].reverse())].sort()[0];
  }

  function assessmentBuildingIndex(context) {
    if (context.assessmentBuildingIndex) return context.assessmentBuildingIndex;
    const ids = new Set(), footprints = new Set();
    for (const record of rows(context.options.assessmentBuildings)) {
      const id = sourceBuildingId(record), footprint = footprintKey(record.footprint);
      // Only replace a background building when there is an assessment volume to draw.
      if (!footprint) continue;
      if (id) ids.add(id);
      footprints.add(footprint);
    }
    return context.assessmentBuildingIndex = { ids, footprints };
  }

  function isAssessmentBuilding(context, feature) {
    if (context.options.assessmentStyle !== 'building') return false;
    const index = assessmentBuildingIndex(context), id = sourceBuildingId(feature);
    return Boolean(id && index.ids.has(id)) || polygonParts(feature.geometry).some(rings => index.footprints.has(footprintKey(rings)));
  }

  function cleanLine(line) {
    return rows(line).filter(validCoordinates).filter((point, i, points) => !i || point[0] !== points[i - 1][0] || point[1] !== points[i - 1][1]);
  }

  function lineDashPattern(dash) {
    const lengths = rows(dash).filter(value => finite(value) && value > 0);
    if (!lengths.length) return 0xffff;
    const total = lengths.reduce((sum, value) => sum + value, 0);
    let pattern = 0;
    for (let bit = 0; bit < 16; bit++) {
      const distance = (bit + .5) * total / 16;
      let boundary = 0, index = 0;
      while (index < lengths.length - 1 && distance >= boundary + lengths[index]) boundary += lengths[index++];
      if (index % 2 === 0) pattern |= 1 << (15 - bit);
    }
    return pattern;
  }

  function liftedArc(context, coordinates, specification) {
    const C = context.C, start = coordinates[0], end = coordinates[coordinates.length - 1];
    const geodesic = new C.EllipsoidGeodesic(C.Cartographic.fromDegrees(start[0], start[1]), C.Cartographic.fromDegrees(end[0], end[1]));
    const distance = geodesic.surfaceDistance;
    if (!finite(distance) || distance < 1) return null;
    const options = specification && typeof specification === "object" ? specification : {};
    const height = finite(options.height) ? clamp(options.height, 1, 2500) : clamp(distance * .12, 24, 1000);
    const baseHeight = finite(options.baseHeight) ? clamp(options.baseHeight, 0, 500) : 3;
    const segments = finite(options.segments) ? Math.round(clamp(options.segments, 24, 96)) : 48;
    const positions = [];
    for (let step = 0; step <= segments; step++) {
      const fraction = step / segments;
      // Preserve the caller's exact endpoint order: the arrow points to the final location.
      if (step === 0 || step === segments) {
        const point = step === 0 ? start : end;
        positions.push(C.Cartesian3.fromDegrees(point[0], point[1], baseHeight));
      } else {
        const point = geodesic.interpolateUsingFraction(fraction);
        positions.push(C.Cartesian3.fromRadians(point.longitude, point.latitude, baseHeight + 4 * height * fraction * (1 - fraction)));
      }
    }
    return positions;
  }

  function svgImage(markup, width = 16, height = 16, textureScale = 1) {
    if (!markup || typeof markup !== "string") return null;
    if (!markup.includes("<svg")) return markup;
    const match = markup.match(/<svg\b[\s\S]*?<\/svg>/i);
    if (!match) return null;
    let svg = match[0];
    if (!/\bxmlns\s*=/.test(svg)) svg = svg.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
    // Cesium rasterizes SVGs into its texture atlas at their intrinsic dimensions.
    // Supply a sharper texture while retaining the host's CSS-sized billboard and exact geometry.
    svg = svg.replace(/<svg\b[^>]*>/i, opening => {
      const attribute = name => opening.match(new RegExp('\\s' + name + '\\s*=\\s*(["\x27])(.*?)\\1', 'i'))?.[2];
      const dimension = name => {
        const value = attribute(name);
        return value && /^\d+(?:\.\d+)?(?:px)?$/i.test(value) ? Number.parseFloat(value) : null;
      };
      const sourceWidth = dimension("width") || width, sourceHeight = dimension("height") || height;
      let tag = opening.replace(/\s(?:width|height)\s*=\s*(["\x27]).*?\1/gi, "");
      if (!attribute("viewBox")) tag = tag.replace(/>$/, ` viewBox="0 0 ${sourceWidth} ${sourceHeight}">`);
      return tag.replace(/>$/, ` width="${Math.ceil(width * textureScale)}" height="${Math.ceil(height * textureScale)}">`);
    });
    // Standalone SVGs do not inherit host CSS. Host glyphs already carry their colours inline.
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }

  function buildBackground(context, data) {
    const C = context.C, scene = context.viewer.scene;
    const medical = context.options.assessmentStyle === "medical";
    const css = value => C.Color.fromCssColorString(value);
    const geometryItem = (geometry, color, id) => new C.GeometryInstance({ id, geometry, attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(css(color)) } });
    const primitive = (items, flat = false, shadows = C.ShadowMode.DISABLED, translucent = false) => {
      if (!items.length) return null;
      const value = scene.primitives.add(new C.Primitive({ geometryInstances: items,
        appearance: new C.PerInstanceColorAppearance({ flat, translucent, closed: !flat }), asynchronous: true, shadows }));
      context.background.push(value); return value;
    };
    const hierarchy = rings => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(rings[0].flat()),
      rings.slice(1).map(ring => new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(ring.flat()))));
    context.hierarchy = hierarchy;
    if (data.manifest.analysis_only === true && !data.manifest.background_pending) return;
    const itemsFrom = (features, make) => {
      const result = [];
      rows(features).forEach(feature => polygonParts(feature.geometry).forEach(part => {
        const rings = normalizedRings(part);
        if (!rings.length) return;
        try { const item = make(feature, rings); if (item) result.push(item); } catch (_) { context.excludedGeometry++; }
      }));
      return result;
    };
    const vertexFormat = C.PerInstanceColorAppearance.VERTEX_FORMAT;
    const [w, s, e, n] = data.manifest.progressive_background && validBounds(data.manifest.background_bbox)
      ? data.manifest.background_bbox : data.city.bbox;
    const board = [[w, s], [e, s], [e, n], [w, n], [w, s]];
    const boundary = normalizedRings(data.manifest.boundary?.geometry || data.manifest.boundary);
    const groundRings = boundary.length ? boundary : [board];
    const power = context.options.powerRegionalMode === true;
    const pending = data.manifest.background_pending === true;
    // The provisional board must not cover its street imagery with an opaque
    // rectangle. Full vector scenes retain their existing solid presentation.
    primitive([geometryItem(new C.PolygonGeometry({ polygonHierarchy: hierarchy(groundRings), height: -2, extrudedHeight: -70, vertexFormat }), pending ? "rgba(203,211,213,0.08)" : power ? "#d9dfe4" : medical ? "#cbd3d5" : "#c3cbbb")], true, C.ShadowMode.RECEIVE_ONLY, pending);
    primitive([geometryItem(new C.PolygonGeometry({ polygonHierarchy: hierarchy(groundRings), height: -1.5, vertexFormat }), pending ? "rgba(228,233,232,0.04)" : power ? "#eef1f4" : medical ? "#e4e9e8" : "#d7decc")], true, C.ShadowMode.RECEIVE_ONLY, pending);
    if (data.manifest.analysis_only === true) return;
    primitive(itemsFrom(data.landscape.features, (feature, rings) => geometryItem(new C.PolygonGeometry({
      polygonHierarchy: hierarchy(rings), height: feature.properties?.kind === "water" ? 0 : .3, vertexFormat,
    }), power ? feature.properties?.kind === "water" ? "#d7e3ec" : "#e1e7df" : feature.properties?.kind === "water" ? medical ? "#b9d4dc" : "#80b1bc" : feature.properties?.kind === "pitch" ? medical ? "#d7dfcd" : "#b8c69e" : medical ? "#cad9ca" : "#a7c191", "landscape:" + feature.properties?.id)), true);
    const beds = [], tops = [];
    for (const road of data.roads) {
      const line = cleanLine(road.coordinates || road.geometry?.coordinates);
      if (line.length < 2) continue;
      try {
        const positions = C.Cartesian3.fromDegreesArray(line.flat()), width = roadWidth(road);
        beds.push(geometryItem(new C.CorridorGeometry({ positions, width: width + 4, height: .7, cornerType: C.CornerType.BEVELED, vertexFormat }), "#f5f3e9"));
        tops.push(geometryItem(new C.CorridorGeometry({ positions, width, height: 1, cornerType: C.CornerType.BEVELED, vertexFormat }), power ? "#d0d5db" : "#929d9c"));
      } catch (_) { context.excludedGeometry++; }
    }
    primitive(beds, true); primitive(tops, true);
    primitive(itemsFrom(data.buildings.features, (feature, rings) => {
      if (isAssessmentBuilding(context, feature)) return null;
      const properties = feature.properties || {};
      const buildingAssessment = context.options.assessmentStyle === 'building';
      return geometryItem(new C.PolygonGeometry({ polygonHierarchy: hierarchy(rings), height: 1.6,
        extrudedHeight: 1.6 + (power || buildingAssessment ? displayHeight(properties) * .5 : displayHeight(properties)), vertexFormat }), buildingAssessment ? '#e1e5e5' : power ? "#e0e5ea" : properties.height_source === "unknown" ? "#e9e9df" : "#faf8ef", "building:" + properties.id);
    }), false, C.ShadowMode.CAST_ONLY);
  }

  function visible(context) {
    return alive(context) && !context.explicitPause && !document.hidden && context.intersecting !== false && context.container.isConnected !== false && context.container.getClientRects().length > 0;
  }

  function resolutionSettings(context) {
    const canvas = context.viewer?.scene.canvas;
    const width = canvas?.clientWidth, height = canvas?.clientHeight;
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0) return null;
    const rawRatio = window.devicePixelRatio;
    const devicePixelRatio = finite(rawRatio) && rawRatio > 0 ? rawRatio : 1;
    const limits = context.C.ContextLimits || {};
    const maximumDimension = Math.min(...[limits.maximumTextureSize, limits.maximumRenderbufferSize]
      .filter(value => finite(value) && value > 0), Infinity);
    const pixelRatio = Math.min(devicePixelRatio, Math.sqrt(MAX_RENDER_PIXELS / (width * height)),
      maximumDimension / width, maximumDimension / height);
    // Native Cesium density already multiplies by DPR; never multiply by DPR a second time.
    return { width, height, devicePixelRatio, pixelRatio, resolutionScale: pixelRatio / devicePixelRatio };
  }

  function syncResolution(context) {
    const settings = resolutionSettings(context);
    if (!settings) return;
    context.viewer.useBrowserRecommendedResolution = false;
    if (context.viewer.resolutionScale !== settings.resolutionScale) context.viewer.resolutionScale = settings.resolutionScale;
    const textureScale = clamp(Math.ceil(settings.pixelRatio - 1e-6), 1, 4);
    if (textureScale !== context.symbolTextureScale) {
      context.symbolTextureScale = textureScale;
      // Refresh only the atlas image when moving between display densities; retain point identity.
      for (const [key, marker] of context.points) {
        const record = context.records.get(key);
        if (record) marker.image = svgImage(record.image, finite(record.width) ? record.width : 16,
          finite(record.height) ? record.height : 16, textureScale);
      }
    }
    context.viewer.resize();
  }

  function watchDisplayResolution(context) {
    context.onDisplayResize = () => syncVisibility(context);
    window.addEventListener?.("resize", context.onDisplayResize);
    const bind = () => {
      context.displayMedia?.removeEventListener("change", context.onDensityChange);
      if (!alive(context) || typeof window.matchMedia !== "function") return;
      context.displayMedia = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      context.onDensityChange = () => { bind(); syncVisibility(context); };
      context.displayMedia.addEventListener("change", context.onDensityChange);
    };
    bind();
  }

  function unwatchDisplayResolution(context) {
    window.removeEventListener?.("resize", context.onDisplayResize);
    context.displayMedia?.removeEventListener("change", context.onDensityChange);
    context.displayMedia = null;
  }

  function syncVisibility(context) {
    if (!context.viewer || !alive(context)) return;
    const on = visible(context);
    context.viewer.useDefaultRenderLoop = on;
    if (on) {
      syncResolution(context);
      if (context.data && !context.initialFramed) frame(context);
      context.viewer.scene.requestRender();
      scheduleImageFrames(context);
    }
    if (!on) {
      if (context.tooltip) context.tooltip.hidden = true;
      clearTimeout(context.imageTimer); context.imageTimer = null; context.imageDeadline = null;
    }
  }

  function renderingFailed(context, error) {
    context.renderError = error?.stage ? error : mapError(String(error?.message || error), "render", "RENDER_FAILED", error);
    if (!context.ready || !alive(context)) return;
    const callback = context.options.onError, detail = context.renderError, container = context.container;
    destroy(context);
    if (typeof callback === "function") callback(detail);
    else container.dispatchEvent(new CustomEvent("geographic-sandbox-error", { bubbles: true, detail }));
  }

  function scheduleImageFrames(context) {
    clearTimeout(context.imageTimer); context.imageTimer = null;
    if (!alive(context) || !visible(context) || !context.points.size) { context.imageDeadline = null; return; }
    const pending = [...context.points.values()].filter(marker => marker.ready === false);
    if (!pending.length) { context.imageDeadline = null; return; }
    if (!context.imageDeadline) context.imageDeadline = Date.now() + 15000;
    context.imageTimer = setTimeout(() => {
      context.imageTimer = null;
      if (!alive(context) || !visible(context)) { context.imageDeadline = null; return; }
      const markers = [...context.points.values()], error = markers.find(marker => marker.loadError)?.loadError;
      if (error) { renderingFailed(context, error); return; }
      // Cesium 1.145 marks its asynchronous image atlas dirty without requesting a scene frame.
      // Request frames only while the atlas is pending, and one final frame after it becomes ready.
      context.viewer.scene.requestRender();
      if (markers.some(marker => marker.ready === false)) {
        if (Date.now() >= context.imageDeadline) { renderingFailed(context, mapError("设施图标绘制超时", "render", "SYMBOL_RENDER_TIMEOUT")); return; }
        scheduleImageFrames(context);
      } else context.imageDeadline = null;
    }, 40);
  }

  async function waitForBackground(context) {
    const start = Date.now();
    while (context.background.some(primitive => !primitive.ready)) {
      assertAlive(context);
      if (context.renderError) throw context.renderError;
      // Hidden views defer geometry work until visible instead of running a background RAF.
      if (!visible(context)) return;
      if (Date.now() - start > 90000) throw mapError("立体几何绘制超时，可重试地图或缩小背景视野", "render", "GEOMETRY_RENDER_TIMEOUT");
      context.viewer.scene.requestRender();
      await wait(context, 75);
    }
    if (context.renderError) throw context.renderError;
  }

  function frame(context, pitch = context.options.powerRegionalMode === true ? -50 : DEFAULT_VIEW.pitch, heading = DEFAULT_VIEW.heading) {
    const C = context.C, viewer = context.viewer, city = context.data.city;
    // Defer the opening view until a hidden or mounting panel has real dimensions.
    if (viewer.scene.canvas.clientWidth <= 0 || viewer.scene.canvas.clientHeight <= 0) return;
    const [w, s, e, n] = city.bbox;
    const width = (e - w) * 111000 * Math.cos(city.center[1] * Math.PI / 180), height = (n - s) * 111000;
    const aspect = Math.max(.25, viewer.scene.canvas.clientWidth / Math.max(1, viewer.scene.canvas.clientHeight));
    const yaw = C.Math.toRadians(heading), tilt = C.Math.toRadians(-pitch);
    const fov = viewer.camera.frustum.fovy || Math.PI / 3;
    const tanV = Math.tan(fov / 2), tanH = tanV * aspect;
    let range = 600;
    for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) {
      const right = x * Math.cos(yaw) - y * Math.sin(yaw), forward = x * Math.sin(yaw) + y * Math.cos(yaw);
      range = Math.max(range, Math.max(Math.abs(right) / tanH, Math.abs(forward) * Math.sin(tilt) / tanV) - forward * Math.cos(tilt));
    }
    viewer.camera.cancelFlight();
    viewer.camera.lookAt(C.Cartesian3.fromDegrees(...city.center, 0), new C.HeadingPitchRange(yaw, C.Math.toRadians(pitch), range * DEFAULT_VIEW.padding));
    viewer.camera.lookAtTransform(C.Matrix4.IDENTITY);
    context.initialFramed = true;
    viewer.scene.requestRender();
  }

  function pointKey(record) { return "point:" + String(record.id); }

  function powerLabelText(record) {
    const title = String(record.labelTitle || [record.objectType, record.objectName || record.id].filter(Boolean).join(" · ") || record.label || record.id);
    const detail = String(record.labelDetail || record.statusText || "暂无保存状态");
    const basis = String(record.basisText || "");
    return { title, detail, basis, accessible: [title, detail, basis].filter(Boolean).join("，") };
  }

  function rectOverlap(a, b) {
    return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
      Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  }

  function screenPlacement(anchor, size, viewport, occupied, direction = "right") {
    const pad = 8, gap = 12, width = Math.min(size.width, Math.max(40, viewport.width - pad * 2));
    const height = Math.min(size.height, Math.max(24, viewport.height - pad * 2));
    const sign = direction === "left" ? -1 : 1;
    const candidates = [];
    for (const distance of [gap, 54, 104, 164]) {
      for (const y of [0, -height - 10, height + 10, -2 * (height + 10), 2 * (height + 10)]) {
        for (const side of [sign, -sign]) candidates.push({ x: side > 0 ? anchor.x + distance : anchor.x - distance - width, y: anchor.y - height / 2 + y });
      }
    }
    // When a dense group exceeds the nearby slots, look for free screen space.
    // Leaders retain the exact anchor; a label never moves its engineering object.
    for (let y = pad; y + height <= viewport.height - pad; y += height + 10) {
      for (let x = pad; x + width <= viewport.width - pad; x += width + 12) candidates.push({ x, y });
    }
    let best = null, bestScore = Infinity;
    for (const candidate of candidates) {
      const rect = { x: clamp(candidate.x, pad, Math.max(pad, viewport.width - width - pad)),
        y: clamp(candidate.y, pad, Math.max(pad, viewport.height - height - pad)), width, height };
      const overlap = rows(occupied).reduce((sum, previous) => sum + rectOverlap(rect, previous), 0);
      const dx = rect.x + width / 2 - anchor.x, dy = rect.y + height / 2 - anchor.y;
      const score = overlap * 10000 + dx * dx + dy * dy;
      if (score < bestScore) { best = rect; bestScore = score; }
    }
    return best || { x: pad, y: pad, width, height };
  }

  function powerPriority(context, record) {
    return (context.selected === String(record.id) ? 10000 : 0) + (Number(record.labelPolicy?.priority) || 0) +
      (record.analysisRole === "regional" ? record.regionalKind === "zone_proxy" || record.regionalKind === "outage_zone" ? 20 : 100 : 0);
  }

  function selectRecord(context, record) {
    select(context, record.id);
    if (typeof record.onSelect === "function") record.onSelect(String(record.id));
    else if (typeof context.options.onSelect === "function") context.options.onSelect(String(record.id));
  }

  function syncPowerLabels(context) {
    if (context.options.powerRegionalMode !== true || !context.powerLabels) return;
    const wanted = new Set();
    for (const [key, record] of context.records) {
      if (!key.startsWith("point:")) continue;
      const selected = context.selected === String(record.id);
      const permanent = record.analysisRole === "regional" && record.labelPolicy?.permanent !== false;
      if (!permanent && !selected) continue;
      const coordinates = pointCoordinates(record);
      if (!validCoordinates(coordinates)) continue;
      wanted.add(key);
      let entry = context.powerLabels.get(key);
      if (!entry) {
        const button = document.createElement("button"); button.type = "button";
        button.className = "geographic-power-label"; button.hidden = true;
        const title = document.createElement("strong"), detail = document.createElement("span"), basis = document.createElement("small");
        title.className = "geographic-power-label-title"; detail.className = "geographic-power-label-status"; basis.className = "geographic-power-label-basis";
        button.append(title, detail, basis);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "path"); line.setAttribute("class", "geographic-power-leader");
        const click = () => { const currentRecord = context.records.get(key); if (currentRecord && alive(context)) selectRecord(context, currentRecord); };
        button.addEventListener("click", click); context.powerLabelLayer.append(button); context.powerLeaderLayer.append(line);
        entry = { button, title, detail, basis, line, click }; context.powerLabels.set(key, entry);
      }
      const text = powerLabelText(record);
      for (const [node, value] of [[entry.title, text.title], [entry.detail, text.detail], [entry.basis, text.basis]]) if (node.textContent !== value) node.textContent = value;
      entry.basis.hidden = !text.basis;
      entry.button.setAttribute("aria-label", text.accessible); entry.button.setAttribute("aria-pressed", String(selected));
      entry.button.title = text.accessible;
      entry.button.dataset.objectId = String(record.id); entry.button.dataset.statusKey = record.statusKey || "unknown";
      entry.button.dataset.longitude = String(coordinates[0]); entry.button.dataset.latitude = String(coordinates[1]);
      entry.button.dataset.timeHours = String(record.timeHours ?? ""); entry.button.dataset.replayTimeHours = String(record.replayTimeHours ?? record.timeHours ?? "");
      entry.button.dataset.moving = String(record.moving === true);
      entry.button.style.setProperty("--power-label-color", record.color || "#334155");
      entry.button.classList.toggle("is-selected", selected);
    }
    for (const [key, entry] of context.powerLabels) if (!wanted.has(key)) {
      entry.button.removeEventListener("click", entry.click); entry.button.remove(); entry.line.remove(); context.powerLabels.delete(key);
    }
  }

  function powerPointZoomSize(context, record, position, selected) {
    const policy = record.zoomSizing;
    if (record.analysisRole !== "regional" || !policy || record.polygonOnly) return null;
    const camera = context.viewer?.camera, height = context.viewer?.scene?.canvas?.clientHeight;
    const coordinates = pointCoordinates(record), fovy = camera?.frustum?.fovy;
    if (!camera?.positionWC || !position || !validCoordinates(coordinates) || !finite(height) || height <= 0 || !finite(fovy) || fovy <= 0 || fovy >= Math.PI) return null;
    const distance = context.C.Cartesian3.distance(camera.positionWC, position);
    if (!finite(distance)) return null;
    const metresPerPixel = Math.max(.0001, 2 * Math.max(1, distance) * Math.tan(fovy / 2) / height);
    const zoom = Math.log2(40075016.686 * Math.max(.01, Math.cos(coordinates[1] * Math.PI / 180)) / (256 * metresPerPixel));
    const min = finite(policy.min) ? policy.min : 12, max = finite(policy.max) ? policy.max : 26;
    const base = finite(policy.base) ? policy.base : 12, referenceZoom = finite(policy.referenceZoom) ? policy.referenceZoom : 7;
    const slope = finite(policy.pixelsPerZoom) ? policy.pixelsPerZoom : 1.4, boost = selected ? finite(policy.selectedBoost) ? policy.selectedBoost : 3 : 0;
    return clamp(base + (zoom - referenceZoom) * slope, min, max) + boost;
  }

  function projectPowerOverlays(context) {
    if (context.options.powerRegionalMode !== true || !alive(context) || !context.viewer || !context.powerLabels) return;
    const C = context.C, scene = context.viewer.scene, viewport = { width: scene.canvas.clientWidth, height: scene.canvas.clientHeight - 28 };
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const occluder = C.EllipsoidalOccluder && scene.globe?.ellipsoid && context.viewer.camera.positionWC ?
      new C.EllipsoidalOccluder(scene.globe.ellipsoid, context.viewer.camera.positionWC) : null;
    const project = record => {
      const coordinates = pointCoordinates(record); if (!validCoordinates(coordinates)) return null;
      const position = C.Cartesian3.fromDegrees(coordinates[0], coordinates[1], 3);
      if (occluder && !occluder.isPointVisible(position)) return null;
      const anchor = C.SceneTransforms.worldToWindowCoordinates(scene, position);
      return anchor && finite(anchor.x) && finite(anchor.y) && anchor.x >= -50 && anchor.y >= -50 && anchor.x <= viewport.width + 50 && anchor.y <= viewport.height + 50 ? anchor : null;
    };
    const pointRecords = [...context.records.entries()].filter(([key, record]) => key.startsWith("point:") && record.analysisRole === "regional" && record.polygonOnly !== true && context.points.has(key))
      .sort((a, b) => powerPriority(context, b[1]) - powerPriority(context, a[1]) || a[0].localeCompare(b[0]));
    const occupiedMarkers = [], anchors = new Map(); let offsetsChanged = false;
    for (const [key, record] of pointRecords) {
      const anchor = project(record), marker = context.points.get(key);
      if (!anchor) { if (marker) marker.show = false; continue; }
      if (marker) marker.show = true;
      const baseWidth = finite(record.width) ? record.width : 34, baseHeight = finite(record.height) ? record.height : baseWidth;
      const pixels = powerPointZoomSize(context, record, marker?.position, context.selected === String(record.id));
      const scale = pixels == null ? 1 : pixels / baseWidth;
      if (marker && pixels != null && (!finite(marker.scale) || Math.abs(marker.scale - scale) > .0001)) { marker.scale = scale; offsetsChanged = true; }
      const width = baseWidth * scale, height = baseHeight * scale;
      const base = rows(record.screenOffset), ox = (finite(base[0]) ? base[0] : 0) * scale, oy = (finite(base[1]) ? base[1] : 0) * scale;
      const step = width + 6, farStep = step * 2 + 2;
      const candidates = pixels == null ? [[ox, oy], [ox + 40, oy], [ox - 40, oy], [ox, oy - 42], [ox, oy + 42],
        [ox + 48, oy - 46], [ox - 48, oy + 46], [ox + 86, oy], [ox - 86, oy], [ox, oy + 86], [ox, oy - 86]] :
        [[ox, oy], [ox + step, oy], [ox - step, oy], [ox, oy - step], [ox, oy + step],
          [ox + step, oy - step], [ox - step, oy + step], [ox + farStep, oy], [ox - farStep, oy], [ox, oy + farStep], [ox, oy - farStep]];
      let best = null, score = Infinity;
      for (const [x, y] of candidates) {
        const center = { x: clamp(anchor.x + x, width / 2 + 4, viewport.width - width / 2 - 4), y: clamp(anchor.y + y, height / 2 + 4, viewport.height - height / 2 - 4) };
        const rect = { x: center.x - width / 2 - 5, y: center.y - height / 2 - 5, width: width + 10, height: height + 10 };
        const overlap = occupiedMarkers.reduce((sum, other) => sum + rectOverlap(rect, other), 0);
        const candidateScore = overlap * 10000 + x * x + y * y;
        if (candidateScore < score) { best = { center, rect }; score = candidateScore; }
      }
      occupiedMarkers.push(best.rect); anchors.set(key, { anchor, center: best.center, markerPixels: width });
      if (marker) {
        const x = best.center.x - anchor.x, y = best.center.y - anchor.y;
        if (!marker.pixelOffset || Math.abs(marker.pixelOffset.x - x) > .05 || Math.abs(marker.pixelOffset.y - y) > .05) {
          marker.pixelOffset = new C.Cartesian2(x, y); offsetsChanged = true;
        }
      }
    }
    const occupiedLabels = [...occupiedMarkers];
    if (context.controls) occupiedLabels.push({ x: viewport.width - (context.controls.offsetWidth || 180) - 18, y: 0, width: (context.controls.offsetWidth || 180) + 24, height: 64 });
    const workspace = context.container.closest?.(".engineering-network-map"), mapRect = context.container.getBoundingClientRect?.();
    if (workspace?.querySelectorAll && mapRect) for (const panel of workspace.querySelectorAll(".network-map-layer-panel:not([hidden]), .medical-map-sidebar:not([hidden]), .network-map-display-legend:not([hidden])")) {
      const panelRect = panel.getBoundingClientRect();
      const rect = { x: Math.max(0, panelRect.left - mapRect.left - 8), y: Math.max(0, panelRect.top - mapRect.top - 8),
        width: panelRect.width + 16, height: panelRect.height + 16 };
      if (rectOverlap(rect, { x: 0, y: 0, width: viewport.width, height: viewport.height })) occupiedLabels.push(rect);
    }
    const labelEntries = [...context.powerLabels.entries()].sort((a, b) => powerPriority(context, context.records.get(b[0]) || {}) - powerPriority(context, context.records.get(a[0]) || {}) || a[0].localeCompare(b[0]));
    for (const [key, entry] of labelEntries) {
      const record = context.records.get(key), projection = anchors.get(key) || (() => { const anchor = record && project(record); return anchor ? { anchor, center: anchor } : null; })();
      entry.button.hidden = !projection; entry.line.style.display = projection ? "" : "none";
      if (!projection) continue;
      const { anchor, center } = projection;
      if (finite(projection.markerPixels)) entry.button.dataset.markerPixels = projection.markerPixels.toFixed(2);
      const size = { width: entry.button.offsetWidth || 230, height: entry.button.offsetHeight || (entry.basis.hidden ? 52 : 70) };
      const rect = screenPlacement(center, size, viewport, occupiedLabels, record.labelPolicy?.direction);
      occupiedLabels.push({ ...rect, x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 });
      entry.button.style.transform = `translate(${Math.round(rect.x)}px, ${Math.round(rect.y)}px)`;
      entry.button.dataset.anchorX = String(Math.round(anchor.x)); entry.button.dataset.anchorY = String(Math.round(anchor.y));
      const edge = { x: clamp(center.x, rect.x, rect.x + rect.width), y: clamp(center.y, rect.y, rect.y + rect.height) };
      entry.line.setAttribute("d", `M ${anchor.x.toFixed(1)} ${anchor.y.toFixed(1)} L ${center.x.toFixed(1)} ${center.y.toFixed(1)} L ${edge.x.toFixed(1)} ${edge.y.toFixed(1)}`);
    }
    // A changed billboard offset reaches the atlas on the next scene update; request
    // that single settling frame rather than a permanent animation loop.
    if (offsetsChanged) scene.requestRender();
  }

  function buildPowerPresentation(context) {
    if (context.options.powerRegionalMode !== true) return;
    context.container.classList.add("geographic-power-analysis");
    context.powerLabels = new Map();
    const leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg"); leaders.setAttribute("class", "geographic-power-leaders"); leaders.setAttribute("aria-hidden", "true");
    const labels = document.createElement("div"); labels.className = "geographic-power-labels"; labels.setAttribute("aria-label", "电力评估对象标签");
    context.powerLeaderLayer = leaders; context.powerLabelLayer = labels; context.container.append(leaders, labels);
    // Projection runs only on a requested scene frame: idle/paused views add no RAF or timer.
    context.offPowerProjection = context.viewer.scene.preRender.addEventListener(() => projectPowerOverlays(context));
  }

  function clearAnalysisBasemap(context) {
    for (const off of context.powerImageryEvents || []) off();
    for (const layer of context.powerImageryLayers || []) context.viewer.imageryLayers.remove(layer, true);
    context.powerImageryEvents = []; context.powerImageryLayers = [];
  }

  function setPowerBasemap(context, config) {
    if (!alive(context) || !context.viewer) return;
    const medicalPending = context.data.manifest.background_pending === true || context.data.manifest.progressive_background === true;
    const powerAnalysis = context.options.powerRegionalMode === true && context.data.manifest.analysis_only === true;
    if (!medicalPending && !powerAnalysis) return;
    context.presentationBasemapSource = config;
    if (!context.presentationOff) context.presentationOff = window.ResCityPresentationMask?.subscribe?.(() => setPowerBasemap(context, context.presentationBasemapSource));
    config = window.ResCityPresentationMask?.basemap?.(config) || config;
    clearAnalysisBasemap(context);
    if ((!config?.tileUrl && !Array.isArray(config?.layers)) || !context.C.UrlTemplateImageryProvider) { context.viewer.scene.requestRender(); return; }
    // Provider failure concerns geographic context only: exact saved object overlays remain live.
    const sources = Array.isArray(config.layers) ? config.layers.filter(source => source?.tileUrl) : [config.tileUrl, config.referenceUrl].filter(Boolean).map(tileUrl => ({ ...config, tileUrl }));
    for (const source of sources) {
      const provider = new context.C.UrlTemplateImageryProvider({ url: source.tileUrl, minimumLevel: 0,
        maximumLevel: source.maxNativeZoom ?? source.maxZoom ?? 16,
        ...(source.geographic === true ? { tilingScheme: new context.C.GeographicTilingScheme() } : {}),
        credit: source.attribution || "Esri, HERE, Garmin, OpenStreetMap contributors" });
      let imageryLayer;
      if (provider.errorEvent) context.powerImageryEvents.push(provider.errorEvent.addEventListener(error => {
        if (alive(context) && context.note) context.note.dataset.basemapStatus = "partial";
        if (source.fallbackOnError === true && imageryLayer) imageryLayer.show = false;
        if (typeof source.onError === "function") source.onError(error);
        if (alive(context)) context.viewer.scene.requestRender();
      }));
      imageryLayer = context.viewer.imageryLayers.addImageryProvider(provider);
      if (source.presentationNoLabels) { imageryLayer.alpha = 0.32; imageryLayer.saturation = 0; imageryLayer.brightness = 1.35; }
      context.powerImageryLayers.push(imageryLayer);
    }
    context.viewer.scene.requestRender();
  }

  function pointPresentation(context, record, selected) {
    const C = context.C;
    if (context.options.powerRegionalMode === true) {
      const offset = rows(record.screenOffset), coordinates = pointCoordinates(record);
      const pixels = record.zoomSizing && validCoordinates(coordinates) ? powerPointZoomSize(context, record, C.Cartesian3.fromDegrees(coordinates[0], coordinates[1], 3), selected) : null;
      const scale = pixels == null ? 1 : pixels / (finite(record.width) ? record.width : 26);
      return { scale, scaleByDistance: undefined, eyeOffset: new C.Cartesian3(0, 0, selected ? -24 : record.analysisRole === "regional" ? -18 : -3),
        pixelOffset: new C.Cartesian2((finite(offset[0]) ? offset[0] : 0) * scale, (finite(offset[1]) ? offset[1] : 0) * scale) };
    }
    // Scale only resident glyphs. The hospital capacity ring remains 16px at
    // every zoom level, and no point is clustered, moved, or suppressed.
    return {
      scale: 1,
      scaleByDistance: record.kind === "demand" && !selected ? new C.NearFarScalar(1500, 1, 40000, .25) : undefined,
      eyeOffset: new C.Cartesian3(0, 0, record.kind === "hospital" ? selected ? -80 : -45 : selected ? -20 : -5),
    };
  }

  function footprintState(context, record) {
    const source = record.footprint, input = source?.type ? polygonParts(source)[0] || [] : source;
    const raw = !Array.isArray(input) ? [] : Array.isArray(input[0]) && finite(input[0][0]) ? [input] : input;
    const key = pointKey(record), cache = context.footprintGeometry ||= new Map(), previous = cache.get(key);
    // Published coordinate arrays are immutable. Retain their exact identity and
    // cheaply check ring replacement/length changes, including added holes.
    // A coordinate edit supplies a new footprint array; colours do not.
    if (previous && previous.source === source && previous.shape.length === raw.length &&
      raw.every((ring, index) => previous.shape[index].ring === ring && previous.shape[index].length === ring?.length)) return previous;
    const rings = normalizedRings(source);
    if (!rings.length) { cache.delete(key); return null; }
    const state = { source, shape: raw.map(ring => ({ ring, length: ring?.length })), rings, entity: null };
    cache.set(key, state); return state;
  }

  function updateFootprint(context, record) {
    const C = context.C, key = pointKey(record), state = footprintState(context, record), rings = state?.rings || [];
    const existing = context.footprints.get(key);
    if (!rings.length) { if (existing) context.viewer.entities.remove(existing); context.footprints.delete(key); return; }
    const volume = record.buildingVolume === true, selected = context.selected === String(record.id);
    const height = finite(record.height_m) && record.height_m > 0 ? record.height_m : 12;
    const geometrySignature = JSON.stringify([volume, volume ? height : null]);
    const styleSignature = JSON.stringify([record.fillColor || record.color || "#467e77", volume ? 1 : finite(record.fillOpacity) ? record.fillOpacity : .35, volume && selected]);
    if (existing && state.entity === existing && state.geometrySignature === geometrySignature && state.styleSignature === styleSignature) return;
    const baseColor = C.Color.fromCssColorString(record.fillColor || record.color || "#467e77");
    const color = baseColor.withAlpha(volume ? 1 : finite(record.fillOpacity) ? record.fillOpacity : .35);
    const edgeColor = volume && selected ? C.Color.fromCssColorString('#ffe28a') : baseColor.withAlpha(.9);
    if (existing && state.entity === existing && state.geometrySignature === geometrySignature) {
      // Replacing PolygonGraphics/hierarchy retriangulates the same large city
      // geometry. A saved supply-state change only changes its appearance.
      existing.polygon.material = color;
      existing.polyline.material = edgeColor;
      existing.polyline.width = volume && selected ? 3 : 2;
      if (volume) existing.polygon.outlineColor = edgeColor;
      else existing.polyline.depthFailMaterial = baseColor.withAlpha(.75);
      state.styleSignature = styleSignature;
      return;
    }
    const polygon = { hierarchy: context.hierarchy(rings), height: volume ? 1.6 : 2, material: color, outline: volume,
      ...(volume ? { extrudedHeight: 1.6 + height, closeTop: true, closeBottom: true, outlineColor: edgeColor, shadows: C.ShadowMode?.CAST_ONLY } : {}) };
    const outline = rings[0][0][0] === rings[0][rings[0].length - 1][0] && rings[0][0][1] === rings[0][rings[0].length - 1][1] ? rings[0] : [...rings[0], rings[0][0]];
    const polyline = { positions: C.Cartesian3.fromDegreesArrayHeights(outline.flatMap(point => [point[0], point[1], volume ? 1.65 + height : 3])), width: volume && selected ? 3 : 2,
      material: edgeColor, ...(!volume ? {depthFailMaterial: baseColor.withAlpha(.75)} : {}) };
    if (existing) { existing.polygon = polygon; existing.polyline = polyline; state.entity = existing; state.geometrySignature = geometrySignature; state.styleSignature = styleSignature; return; }
    const entity = context.viewer.entities.add({ id: key + ":footprint", polygon, polyline });
    state.entity = entity; state.geometrySignature = geometrySignature; state.styleSignature = styleSignature; context.footprints.set(key, entity);
  }

  function setPoints(context, records) {
    if (!alive(context) || !context.viewer) return;
    const C = context.C, wanted = new Set();
    // Host-selected state supersedes an older canvas click, including an explicit clear.
    if (rows(records).some(record => Object.prototype.hasOwnProperty.call(record, "selected"))) {
      const selected = rows(records).find(record => record.selected === true);
      context.selected = selected ? String(selected.id) : null;
    }
    // Depth-disabled billboards share Cesium's near plane. Keep resident
    // quads before hospitals in the shared collection so hospitals are drawn
    // above them; changing eyeOffset alone cannot guarantee this ordering.
    const orderedRecords = [...rows(records)].sort((a, b) => context.options.powerRegionalMode === true ?
      powerPriority(context, a) - powerPriority(context, b) : Number(a.kind === "hospital") - Number(b.kind === "hospital"));
    for (const record of orderedRecords) {
      if (record.id == null) continue;
      const key = pointKey(record), coordinates = pointCoordinates(record);
      const footprint = footprintState(context, record)?.rings || [];
      if (!validCoordinates(coordinates) && !footprint.length) continue;
      wanted.add(key); context.records.set(key, record); updateFootprint(context, record);
      const image = svgImage(record.image, finite(record.width) ? record.width : 16,
        finite(record.height) ? record.height : 16, context.symbolTextureScale || 1);
      if (!image || record.polygonOnly === true || !validCoordinates(coordinates)) {
        const previous = context.points.get(key); if (previous) context.billboards.remove(previous); context.points.delete(key); continue;
      }
      let marker = context.points.get(key);
      const selected = context.selected === String(record.id);
      const definition = { id: key, position: C.Cartesian3.fromDegrees(coordinates[0], coordinates[1], 3), image,
        width: finite(record.width) ? record.width : 16, height: finite(record.height) ? record.height : 16,
        disableDepthTestDistance: Infinity, verticalOrigin: C.VerticalOrigin.CENTER, horizontalOrigin: C.HorizontalOrigin.CENTER,
        color: C.Color.WHITE, ...pointPresentation(context, record, selected),
      };
      if (!marker) { marker = context.billboards.add(definition); context.points.set(key, marker); }
      else {
        for (const name of ["position", "image", "width", "height", "scale", "scaleByDistance", "eyeOffset", "pixelOffset"]) {
          if (name !== "pixelOffset" || context.options.powerRegionalMode === true) marker[name] = definition[name];
        }
      }
    }
    for (const [key, marker] of context.points) if (!wanted.has(key)) { context.billboards.remove(marker); context.points.delete(key); }
    for (const [key, entity] of context.footprints) if (!wanted.has(key)) { context.viewer.entities.remove(entity); context.footprints.delete(key); context.footprintGeometry?.delete(key); }
    for (const key of context.footprintGeometry?.keys() || []) if (!wanted.has(key)) context.footprintGeometry.delete(key);
    for (const key of context.records.keys()) if (key.startsWith("point:") && !wanted.has(key)) context.records.delete(key);
    syncPowerLabels(context);
    context.imageDeadline = null;
    context.viewer.scene.requestRender();
    scheduleImageFrames(context);
  }

  function updatePointPositions(context, updates) {
    if (!alive(context) || !context.viewer) return;
    const C = context.C; let changed = false;
    for (const update of rows(updates)) {
      if (update.id == null) continue;
      const key = pointKey(update), previous = context.records.get(key), marker = context.points.get(key);
      if (!previous || !marker || previous.analysisRole !== "regional" || previous.polygonOnly || previous.footprint) continue;
      const record = { ...previous }, transport = ["crew", "vehicle", "generator"].includes(previous.regionalKind);
      if (transport && (update.lon != null || update.longitude != null || update.lat != null || update.latitude != null)) {
        const coordinates = pointCoordinates(update); if (!validCoordinates(coordinates)) continue;
        record.lon = record.longitude = coordinates[0]; record.lat = record.latitude = coordinates[1];
        marker.position = C.Cartesian3.fromDegrees(coordinates[0], coordinates[1], 3);
      }
      for (const field of ["replayTimeHours", "moving", "positionInterpolated"]) if (transport && Object.prototype.hasOwnProperty.call(update, field)) record[field] = update[field];
      if (Array.isArray(update.screenOffset) && update.screenOffset.length === 2 && update.screenOffset.every(finite)) {
        record.screenOffset = [...update.screenOffset]; marker.pixelOffset = new C.Cartesian2(...record.screenOffset);
      }
      context.records.set(key, record);
      const entry = context.powerLabels?.get(key), coordinates = pointCoordinates(record);
      if (entry) {
        entry.button.dataset.longitude = String(coordinates[0]); entry.button.dataset.latitude = String(coordinates[1]);
        entry.button.dataset.replayTimeHours = String(record.replayTimeHours ?? record.timeHours ?? "");
        entry.button.dataset.moving = String(record.moving === true);
      }
      changed = true;
    }
    // Continuous transport never rebuilds static city polygons, links, labels or textures.
    if (changed) context.viewer.scene.requestRender();
  }

  function setLinks(context, records, { arcLimit = 30 } = {}) {
    if (!alive(context) || !context.viewer) return;
    const C = context.C, wanted = new Set(), wantedHeads = new Set(), wantedCasings = new Set();
    if (!context.linkGeometry) context.linkGeometry = new Map();
    if (!context.linkHeads) context.linkHeads = new Map();
    if (!context.linkCasings) context.linkCasings = new Map();
    // Association arcs are a presentation overlay, not a replacement for the full physical network.
    // Hosts can explicitly request every saved association. Ordinary network links are never sampled.
    const arcRecords = rows(records).filter(record => record.arc).sort((a, b) => Number(b.selected === true) - Number(a.selected === true));
    const maximum = arcLimit === "all" ? arcRecords.length : finite(arcLimit) ? Math.max(0, Math.floor(arcLimit)) : 30;
    const permittedArcs = new Set(arcRecords.slice(0, maximum));
    for (const record of rows(records)) {
      const coordinates = cleanLine(record.coordinates);
      if (coordinates.length < 2 || record.id == null) continue;
      if (record.arc && !permittedArcs.has(record)) continue;
      const key = "link:" + String(record.id);
      const signature = JSON.stringify([coordinates, record.arc || false]);
      let geometry = context.linkGeometry.get(key);
      if (!geometry || geometry.signature !== signature) {
        const positions = record.arc ? liftedArc(context, coordinates, record.arc) : C.Cartesian3.fromDegreesArrayHeights(coordinates.flatMap(point => [point[0], point[1], 3]));
        if (positions) { geometry = { signature, positions }; context.linkGeometry.set(key, geometry); }
        else geometry = null;
      }
      const positions = geometry?.positions;
      if (!positions) continue;
      wanted.add(key);
      const selected = record.selected === true;
      const opacity = finite(record.opacity) ? record.opacity : .85;
      const shaftWidth = (finite(record.width) ? record.width : record.arc ? 2.2 : 2) * (selected ? 1.35 : 1);
      const cssColor = record.color || (record.arc ? "#216ea5" : "#21877c");
      // A host can opt physical lines into a screen-space casing without changing
      // their real route or inventing an overhead cable. Width is pixels per side.
      const casingColor = !record.arc && !record.arrow && finite(record.casingWidth) && record.casingWidth > 0 && record.casingColor ? C.Color.fromCssColorString(record.casingColor) : null;
      const casingWidth = casingColor ? record.casingWidth : 0;
      const dashed = rows(record.dash).length > 0;
      const styleSignature = JSON.stringify([selected, opacity, cssColor, shaftWidth, Boolean(record.arrow), rows(record.dash), casingWidth, casingColor ? record.casingColor : null]);
      let previous = context.links.get(key);
      const changed = geometry.styleSignature !== styleSignature || !previous;
      if (casingWidth && dashed) {
        wantedCasings.add(key);
        const casing = context.linkCasings.get(key);
        if (changed || !casing) {
          const material = new C.PolylineDashMaterialProperty({ color: casingColor.withAlpha(selected ? Math.max(.95, opacity) : opacity),
            dashLength: record.dash.reduce((sum, value) => sum + value, 0) || 10, dashPattern: lineDashPattern(record.dash) });
          const polyline = { positions, width: shaftWidth + casingWidth * 2, material, depthFailMaterial: material, clampToGround: false };
          if (casing) casing.polyline = polyline;
          else {
            context.linkCasings.set(key, context.viewer.entities.add({ id: key + ":casing", polyline }));
            // Insert an opted-in dashed underlay before its main colored line.
            // The one-time style transition preserves the cached route positions.
            if (previous) { context.viewer.entities.remove(previous); context.links.delete(key); previous = null; }
          }
        }
      }
      if (changed) {
        const baseColor = C.Color.fromCssColorString(cssColor);
        const color = baseColor.withAlpha(selected ? Math.max(.95, opacity) : opacity);
        const material = record.arrow ? new C.PolylineArrowMaterialProperty(color) : dashed ? new C.PolylineDashMaterialProperty({ color, dashLength: record.dash.reduce((sum, value) => sum + value, 0) || 10, dashPattern: lineDashPattern(record.dash) }) : casingWidth ? new C.PolylineOutlineMaterialProperty({ color, outlineColor: casingColor.withAlpha(selected ? Math.max(.95, opacity) : opacity), outlineWidth: casingWidth }) : color;
        // Cesium's arrow material uses 30% of its strip for the shaft.
        const polyline = { positions, width: record.arrow ? shaftWidth / .3 : shaftWidth + (casingWidth && !dashed ? casingWidth * 2 : 0), material, depthFailMaterial: material, clampToGround: false,
          ...(record.arc ? { arcType: C.ArcType.NONE } : {}) };
        if (previous) previous.polyline = polyline;
        else context.links.set(key, context.viewer.entities.add({ id: key, polyline }));
        geometry.styleSignature = styleSignature;
      }
      if (record.arc && record.arrow) {
        // A hospital's screen-facing circle can cover the terminal arrow. Add one direction cue
        // before that circle, using a cached subset of the same real curve, not shifted locations.
        if (!geometry.directionPositions) {
          const last = positions.length - 1;
          geometry.directionPositions = positions.slice(Math.round(last * .65), Math.round(last * .85) + 1);
        }
        const head = context.linkHeads.get(key);
        if (changed || !head) {
          const baseColor = C.Color.fromCssColorString(cssColor);
          // Explicitly thin, translucent full-area links keep their direction cues equally translucent.
          const headOpacity = selected ? Math.max(.95, opacity) : finite(record.opacity) ? opacity : Math.max(.86, opacity);
          const headMaterial = new C.PolylineArrowMaterialProperty(baseColor.withAlpha(headOpacity));
          const directionPolyline = { positions: geometry.directionPositions, width: shaftWidth / .3,
            material: headMaterial, depthFailMaterial: headMaterial, clampToGround: false, arcType: C.ArcType.NONE };
          if (head) head.polyline = directionPolyline;
          else context.linkHeads.set(key, context.viewer.entities.add({ id: key + ":direction", polyline: directionPolyline }));
        }
        wantedHeads.add(key);
      }
      if (record.interactive !== false) context.records.set(key, record); else context.records.delete(key);
    }
    for (const [key, entity] of context.links) if (!wanted.has(key)) { context.viewer.entities.remove(entity); context.links.delete(key); context.records.delete(key); }
    for (const [key, entity] of context.linkHeads) if (!wantedHeads.has(key)) { context.viewer.entities.remove(entity); context.linkHeads.delete(key); }
    for (const [key, entity] of context.linkCasings) if (!wantedCasings.has(key)) { context.viewer.entities.remove(entity); context.linkCasings.delete(key); }
    for (const key of context.linkGeometry.keys()) if (!wanted.has(key)) context.linkGeometry.delete(key);
    context.viewer.scene.requestRender();
  }

  function select(context, id) {
    if (!alive(context) || !context.viewer) return;
    context.selected = id == null ? null : String(id);
    for (const [key, marker] of context.points) {
      const record = context.records.get(key);
      if (record) Object.assign(marker, pointPresentation(context, record, key === "point:" + context.selected));
    }
    for (const key of context.footprints.keys()) {
      const record = context.records.get(key);
      if (record?.buildingVolume) updateFootprint(context, record);
    }
    syncPowerLabels(context);
    context.viewer.scene.requestRender();
  }

  function focus(context, id) {
    if (!alive(context) || !context.viewer) return;
    const record = context.records.get("point:" + String(id)) || (context.options.powerRegionalMode === true ? context.records.get("link:" + String(id)) : null);
    if (!record) return;
    const geographicExtent = context.options.powerRegionalMode === true ?
      record.coordinates ? cleanLine(record.coordinates) : normalizedRings(record.footprint).flat() : [];
    let coordinates = pointCoordinates(record);
    let bounds = null;
    const suppliedBounds = record.focusBounds;
    if (context.options.powerRegionalMode === true && Array.isArray(suppliedBounds) && suppliedBounds.length === 4 && suppliedBounds.every(finite) &&
      suppliedBounds[0] <= suppliedBounds[2] && suppliedBounds[1] <= suppliedBounds[3] && validCoordinates(suppliedBounds.slice(0, 2)) && validCoordinates(suppliedBounds.slice(2))) {
      bounds = [...suppliedBounds];
      coordinates = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    } else if (geographicExtent.length) {
      bounds = [Math.min(...geographicExtent.map(point => point[0])), Math.min(...geographicExtent.map(point => point[1])),
        Math.max(...geographicExtent.map(point => point[0])), Math.max(...geographicExtent.map(point => point[1]))];
      coordinates = [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
    }
    if (!validCoordinates(coordinates)) {
      const ring = normalizedRings(record.footprint)[0];
      if (!ring?.length) return;
      coordinates = [ring.reduce((sum, point) => sum + point[0], 0) / ring.length, ring.reduce((sum, point) => sum + point[1], 0) / ring.length];
    }
    const C = context.C, camera = context.viewer.camera;
    const target = C.Cartesian3.fromDegrees(coordinates[0], coordinates[1], 0);
    let distance = Math.max(1000, Math.min(4000, C.Cartesian3.distance(camera.positionWC, target)));
    if (bounds) {
      const width = (bounds[2] - bounds[0]) * 111000 * Math.cos(coordinates[1] * Math.PI / 180), height = (bounds[3] - bounds[1]) * 111000;
      const aspect = Math.max(.25, context.viewer.scene.canvas.clientWidth / Math.max(1, context.viewer.scene.canvas.clientHeight));
      const tanV = Math.tan((camera.frustum.fovy || Math.PI / 3) / 2), tanH = tanV * aspect;
      const tilt = -camera.pitch, yaw = camera.heading;
      for (const x of [-width / 2, width / 2]) for (const y of [-height / 2, height / 2]) {
        const right = x * Math.cos(yaw) - y * Math.sin(yaw), forward = x * Math.sin(yaw) + y * Math.cos(yaw);
        distance = Math.max(distance, (Math.max(Math.abs(right) / tanH, Math.abs(forward) * Math.sin(tilt) / tanV) - forward * Math.cos(tilt)) * 1.1);
      }
    }
    camera.cancelFlight(); camera.lookAt(target, new C.HeadingPitchRange(camera.heading, camera.pitch, distance));
    camera.lookAtTransform(C.Matrix4.IDENTITY); select(context, id);
  }

  function pickedRecord(context, position) {
    const picked = context.viewer.scene.pick(position);
    let id = picked?.id;
    if (id && typeof id === "object") id = id.id;
    if (typeof id !== "string") return null;
    const record = context.records.get(id.replace(/:footprint$/, ""));
    if (record) return record;
    const casingKey = id.replace(/:casing$/, "");
    return casingKey !== id && context.linkCasings?.has(casingKey) ? context.records.get(casingKey) || null : null;
  }

  function buildControls(context) {
    const controls = document.createElement("div"); controls.className = "geographic-sandbox-controls";
    const actions = [["overview", "全域", "Fit area"], ["top", "俯视", "Top view"], ["tilt", "三维", "3D view"]];
    for (const [action, zh, en] of actions) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = tr(context, zh, en);
      button.dataset.sandboxView = action; button.setAttribute("aria-label", tr(context, zh, en));
      controls.append(button);
    }
    context.onControl = event => {
      const action = event.target.closest("button[data-sandbox-view]")?.dataset.sandboxView;
      if (!action || !alive(context)) return;
      if (action === "overview") frame(context);
      else {
        const C = context.C, camera = context.viewer.camera;
        const center = context.viewer.scene.globe.pick(camera.getPickRay(new C.Cartesian2(context.viewer.scene.canvas.clientWidth / 2, context.viewer.scene.canvas.clientHeight / 2)), context.viewer.scene);
        const target = center || C.Cartesian3.fromDegrees(...context.data.city.center, 0);
        const distance = Math.max(180, C.Cartesian3.distance(camera.positionWC, target));
        camera.cancelFlight(); camera.lookAt(target, new C.HeadingPitchRange(action === "top" ? 0 : camera.heading, C.Math.toRadians(action === "top" ? -89 : context.options.powerRegionalMode === true ? -50 : DEFAULT_VIEW.pitch), distance));
        camera.lookAtTransform(C.Matrix4.IDENTITY); context.viewer.scene.requestRender();
      }
    };
    controls.addEventListener("click", context.onControl);
    context.controls = controls; context.container.append(controls);
  }

  function configureCameraController(scene, city) {
    const controller = scene.screenSpaceCameraController;
    // City-scale maps need finer steps than the engine's globe-navigation defaults.
    // Keep native pointer-centred zoom, drag/rotate settings and distance bounds.
    controller.zoomFactor = .5;
    controller.inertiaZoom = .1;
    controller.minimumZoomDistance = 180;
    const span = Math.max((city.bbox[2] - city.bbox[0]) * 111000 * Math.cos(city.center[1] * Math.PI / 180), (city.bbox[3] - city.bbox[1]) * 111000);
    controller.maximumZoomDistance = Math.max(35000, span * 5);
  }

  function captureView(context) {
    if (!alive(context) || !context.viewer) return null;
    const camera = context.viewer.camera, vector = point => point && [point.x, point.y, point.z];
    return { position: vector(camera.positionWC), direction: vector(camera.directionWC), up: vector(camera.upWC) };
  }

  function restoreView(context, view) {
    if (!alive(context) || !context.viewer || !view || !['position', 'direction', 'up'].every(key => Array.isArray(view[key]) && view[key].length === 3 && view[key].every(finite))) return false;
    const C = context.C, vector = key => new C.Cartesian3(...view[key]), camera = context.viewer.camera;
    camera.cancelFlight(); camera.lookAtTransform(C.Matrix4.IDENTITY);
    camera.setView({ destination: vector('position'), orientation: { direction: vector('direction'), up: vector('up') } });
    context.viewer.scene.requestRender(); return true;
  }

  function destroy(context) {
    if (context.destroyed) return;
    context.presentationOff?.();
    context.destroyed = true; context.controller.abort();
    clearTimeout(context.loadingTimer); context.loadingTimer = null;
    clearTimeout(context.imageTimer); context.imageTimer = null;
    clearTimeout(context.backgroundViewTimer); context.backgroundViewTimer = null;
    context.offBackgroundMove?.();
    unwatchDisplayResolution(context);
    context.resizeObserver?.disconnect(); context.intersectionObserver?.disconnect();
    document.removeEventListener("visibilitychange", context.onVisibility);
    context.offRenderError?.();
    context.offPowerProjection?.();
    for (const off of context.powerImageryEvents || []) off();
    context.powerImageryEvents = [];
    for (const entry of context.powerLabels?.values() || []) entry.button.removeEventListener("click", entry.click);
    context.powerLabels?.clear();
    context.controls?.removeEventListener("click", context.onControl);
    context.retryButton?.removeEventListener("click", context.onRetry);
    if (context.options.signal && context.onAbort) context.options.signal.removeEventListener("abort", context.onAbort);
    context.handler?.destroy();
    if (context.viewer && !context.viewer.isDestroyed()) context.viewer.destroy();
    context.points.clear(); context.links.clear(); context.footprints.clear(); context.footprintGeometry?.clear(); context.records.clear(); context.linkGeometry?.clear(); context.linkHeads?.clear(); context.linkCasings?.clear();
    for (const node of [context.viewport, context.controls, context.tooltip, context.statusNode, context.note, context.powerLabelLayer, context.powerLeaderLayer]) node?.remove();
    if (contexts.get(context.container) === context) {
      contexts.delete(context.container); context.container.classList.remove("geographic-sandbox", "geographic-power-analysis");
      delete context.container.dataset.geographicSandbox;
      delete context.container.dataset.geographicBackground;
      delete context.container.dataset.buildingCount;
      delete context.container.dataset.geographicLoading;
    }
  }

  async function create(container, options = {}) {
    if (!container || typeof container.append !== "function") throw new Error("三维地图缺少展示容器");
    const previous = contexts.get(container); if (previous) destroy(previous);
    const context = { container, options, controller: new AbortController(), destroyed: false, viewer: null,
      points: new Map(), links: new Map(), linkGeometry: new Map(), linkHeads: new Map(), linkCasings: new Map(), footprints: new Map(), footprintGeometry: new Map(), records: new Map(), background: [], selected: null, intersecting: true, explicitPause: false, excludedGeometry: 0, ready: false };
    contexts.set(container, context); container.classList.add("geographic-sandbox"); container.dataset.geographicSandbox = "preparing";
    const loading = document.createElement("div"); loading.className = "geographic-sandbox-status"; loading.setAttribute("role", "status");
    loading.setAttribute("aria-live", "polite");
    const title = document.createElement("strong"), detail = document.createElement("span"), help = document.createElement("span"), retry = document.createElement("button");
    title.className = "geographic-loading-title"; detail.className = "geographic-loading-detail"; help.className = "geographic-loading-help";
    retry.type = "button"; retry.textContent = tr(context, "重新加载三维", "Retry 3D map"); retry.hidden = true;
    context.statusTitle = title; context.statusDetail = detail; context.statusHelp = help; context.retryButton = retry;
    context.onRetry = () => {
      if (!alive(context) || context.loadingState !== "failed") return;
      if (context.sceneScope) queueBackground(context, cameraBounds(context) || context.requestedBackgroundBounds, true);
      else context.options.onRetry?.();
    };
    retry.addEventListener("click", context.onRetry); loading.append(title, detail, help, retry);
    context.statusNode = loading; container.append(loading);
    context.onAbort = () => destroy(context);
    if (options.signal) { options.signal.addEventListener("abort", context.onAbort, { once: true }); if (options.signal.aborted) context.onAbort(); }
    try {
      assertAlive(context);
      loadingState(context, "loading");
      context.loadingTimer = setTimeout(() => {
        if (!alive(context) || !["loading", "background"].includes(context.loadingState)) return;
        context.loadingSlow = true; loadingState(context, context.loadingState);
      }, 20000);
      status(context, "正在读取本轮区域地理数据", "Reading geographic data for this saved assessment");
      const [C, data] = await Promise.all([loadLibrary(), loadScene(context)]);
      assertAlive(context); context.C = C; context.data = data;
      const viewport = document.createElement("div"); viewport.className = "geographic-sandbox-viewport"; context.viewport = viewport; container.append(viewport);
      const viewer = new C.Viewer(viewport, { animation: false, timeline: false, baseLayerPicker: false, baseLayer: false,
        geocoder: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
        selectionIndicator: false, infoBox: false, showRenderLoopErrors: false, requestRenderMode: true, maximumRenderTimeChange: Infinity,
        terrainProvider: new C.EllipsoidTerrainProvider(), useBrowserRecommendedResolution: false,
        shadows: options.powerRegionalMode !== true, contextOptions: { webgl: { alpha: false, antialias: true } } });
      context.viewer = viewer;
      const scene = viewer.scene, css = value => C.Color.fromCssColorString(value);
      scene.canvas.style.imageRendering = "auto";
      context.offRenderError = scene.renderError.addEventListener((_scene, error) => renderingFailed(context, error));
      scene.backgroundColor = css(options.powerRegionalMode === true ? "#e7edf3" : "#d5ddda"); scene.globe.baseColor = css(options.powerRegionalMode === true ? "#e7edf3" : "#d5ddda");
      scene.globe.enableLighting = false; scene.globe.depthTestAgainstTerrain = false;
      scene.skyAtmosphere.show = false; scene.skyBox.show = false; scene.sun.show = false; scene.moon.show = false; scene.fog.enabled = false;
      scene.highDynamicRange = false; scene.postProcessStages.fxaa.enabled = true;
      syncResolution(context);
      configureCameraController(scene, data.city);
      const localFrame = C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(...data.city.center));
      const direction = C.Matrix4.multiplyByPointAsVector(localFrame, new C.Cartesian3(.5, .4, -1), new C.Cartesian3());
      scene.light = new C.DirectionalLight({ direction: C.Cartesian3.normalize(direction, direction), intensity: 1.3 });
      scene.shadowMap.darkness = .25; scene.shadowMap.softShadows = true; scene.shadowMap.size = 2048; scene.shadowMap.maximumDistance = 18000;
      status(context, data.manifest.analysis_only ? "正在绘制评估图层" : "正在绘制立体建筑与道路",
        data.manifest.analysis_only ? "Drawing assessment layers" : "Drawing 3D buildings and roads");
      buildBackground(context, data);
      setPowerBasemap(context, options.analysisBasemap);
      context.billboards = scene.primitives.add(new C.BillboardCollection({ scene }));
      buildPowerPresentation(context);
      const tooltip = document.createElement("div"); tooltip.className = "geographic-sandbox-tooltip"; tooltip.hidden = true;
      context.tooltip = tooltip; container.append(tooltip);
      context.handler = new C.ScreenSpaceEventHandler(scene.canvas);
      context.handler.setInputAction(event => {
        const record = pickedRecord(context, event.position); if (!record) return;
        selectRecord(context, record);
      }, C.ScreenSpaceEventType.LEFT_CLICK);
      context.handler.setInputAction(event => {
        const record = pickedRecord(context, event.endPosition);
        tooltip.hidden = !record?.label;
        if (!tooltip.hidden) { tooltip.textContent = record.label; tooltip.style.left = clamp(event.endPosition.x + 12, 8, Math.max(8, container.clientWidth - 240)) + "px"; tooltip.style.top = clamp(event.endPosition.y + 12, 8, Math.max(8, container.clientHeight - 70)) + "px"; }
        scene.canvas.style.cursor = record ? "pointer" : "grab";
      }, C.ScreenSpaceEventType.MOUSE_MOVE);
      buildControls(context);
      const note = document.createElement("div"); note.className = "geographic-sandbox-note";
      context.note = note; container.append(note);
      describeBackground(context, data);
      if (container.clientWidth > 0 && container.clientHeight > 0) frame(context);
      context.onVisibility = () => syncVisibility(context); document.addEventListener("visibilitychange", context.onVisibility);
      watchDisplayResolution(context);
      if (window.ResizeObserver) { context.resizeObserver = new ResizeObserver(() => syncVisibility(context)); context.resizeObserver.observe(container); }
      if (window.IntersectionObserver) { context.intersectionObserver = new IntersectionObserver(entries => { context.intersecting = entries[0]?.isIntersecting !== false; syncVisibility(context); }, { threshold: 0 }); context.intersectionObserver.observe(container); }
      syncVisibility(context);
      await waitForBackground(context);
      assertAlive(context); context.ready = true;
      container.dataset.geographicSandbox = "ready"; syncVisibility(context);
      // A usable preview is not a completed building scene. Keep a nonblocking
      // preparation notice until the real geometry has finished drawing.
      if (!data.backgroundPromise && !data.backgroundRequest) { loadingState(context, "ready"); status(context, "", ""); }
      const adapter = { setPoints: records => setPoints(context, records), updatePointPositions: updates => updatePointPositions(context, updates), setLinks: (records, options) => setLinks(context, records, options),
        setBasemap: config => setPowerBasemap(context, config), captureView: () => captureView(context), restoreView: view => restoreView(context, view),
        select: id => select(context, id), focus: id => focus(context, id), resize: () => { context.explicitPause = false; syncVisibility(context); },
        ...(context.sceneScope ? { retryBackground: () => queueBackground(context, cameraBounds(context) || context.requestedBackgroundBounds, true),
          reloadBackground: bounds => queueBackground(context, bounds, true) } : {}),
        fit: () => { if (alive(context)) frame(context); },
        pause: (on = true) => { context.explicitPause = on !== false; syncVisibility(context); },
        resume: () => { context.explicitPause = false; syncVisibility(context); }, destroy: () => destroy(context),
        manifest: data.manifest };
      context.adapter = adapter;
      watchBackgroundView(context);
      startMedicalBackground(context, data);
      return adapter;
    } catch (error) {
      const issue = backgroundIssue(context, error);
      destroy(context); throw issue;
    }
  }

  window.GeographicSandbox = Object.freeze({ create, version: "progressive-background-20261024-r1" });
})();
