/* A gallery of server-rendered, immutable scientific figures. No model calculation occurs here. */
(() => {
  "use strict";
  const cache = new Map();
  const mounted = new WeakMap();
  let retrySequence = 0;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const rows = value => Array.isArray(value) ? value : [];
  const translate = language => (zh, en) => String(language).startsWith("en") ? en : zh;
  const steps = [
    ["all", "全部图件", "All figures", "00", "#396a79"],
    ["earthquake_scenario_interpretation", "地震情景", "Earthquake scenario", "01", "#56aab8"],
    ["hospital_damage_assessment", "医院损伤", "Hospital damage", "02", "#4e80ab"],
    ["hospital_function_degradation", "救治能力", "Treatment capacity", "03", "#55856b"],
    ["medical_system_function", "服务可达性", "Service accessibility", "04", "#529fa2"],
    ["recovery_optimization", "修复与恢复", "Repair and recovery", "05", "#bf8850"],
  ];
  function safeURL(value) {
    if (typeof value !== "string" || /[\\\u0000-\u001f]/.test(value)) return "";
    try {
      const url = new URL(value, window.location.href);
      return ["http:", "https:"].includes(url.protocol) && url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : "";
    } catch { return ""; }
  }
  const isCurrent = context => mounted.get(context.container) === context && context.container.isConnected !== false;
  const resultRevision = options => String(options.resultRevision || "");
  const identity = options => JSON.stringify([options.sessionId, options.iteration || 1, options.language || "zh-CN", resultRevision(options)]);
  function artifactURL(context, value) {
    const safe = safeURL(value);
    if (!safe) return "";
    const url = new URL(safe, window.location.href), revision = resultRevision(context.options);
    // Versioned figures always belong to the same saved result as their manifest.
    if (revision) {
      if (url.searchParams.has("revision") && url.searchParams.get("revision") !== revision) return "";
      url.searchParams.set("revision", revision);
    }
    // An explicit retry must also recover from an unsuccessful cached image.
    if (context.retryToken) url.searchParams.set("retry", context.retryToken);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const isInline = context => context.options.mode === "inline";
  const viewIdentity = options => JSON.stringify([options.mode || "gallery", options.templateIds === undefined ? null : [...new Set(rows(options.templateIds).map(String))].sort()]);
  function figureIdentity(figure) { return String(figure.figure_id || `${figure.template_id}:${figure.scenario_id}:${figure.page || 1}`); }
  function templateFigures(context) {
    const figures = rows(context.manifest?.figures);
    if (context.options.templateIds === undefined) return figures;
    const allowed = new Set(rows(context.options.templateIds).map(String));
    return figures.filter(figure => allowed.has(String(figure.template_id)));
  }
  function selectableFigures(context) {
    const scenario = context.state.scenario;
    return templateFigures(context).filter(figure => isInline(context)
      ? (scenario ? String(figure.scenario_id ?? "") === scenario : !figure.scenario_id)
      : (!figure.scenario_id || String(figure.scenario_id) === scenario));
  }
  function filteredFigures(context) {
    return selectableFigures(context).filter(figure => context.state.category === "all" || figure.source_skill_id === context.state.category);
  }
  function selectedFigure(context) {
    const figures = filteredFigures(context);
    return figures.find(figure => figureIdentity(figure) === context.state.figureId) || figures[0];
  }
  function downloadLinks(context, figure, t, className = "") {
    return ["svg", "png", "pdf"].map(format => {
      const url = artifactURL(context, figure?.formats?.[format]);
      const label = format === "png" ? "PNG · 300 dpi" : format.toUpperCase();
      return url ? `<a class="publication-format ${className}" href="${esc(url)}" download aria-label="${esc(t(`下载 ${label} 图件`, `Download ${label} figure`))}">${label}<span aria-hidden="true">↓</span></a>` : "";
    }).join("");
  }
  function galleryHeader(context, t) {
    const manifest = context.manifest;
    const zip = artifactURL(context, manifest?.download_url);
    return `<header class="publication-heading"><div><span class="publication-eyebrow">${t("空间分析 · 工程图册", "SPATIAL ANALYSIS · ENGINEERING ATLAS")}</span><h2>${t("看见系统的韧性", "Resilience, in figures")}</h2><p>${t("按计算步骤阅读本轮评估图件。", "Read this assessment by engineering step.")}</p></div><div class="publication-heading-action">${zip ? `<a class="publication-package" href="${esc(zip)}" download><span aria-hidden="true">↓</span>${t("下载完整图包", "Download figure package")}</a><small>SVG / PNG / PDF${manifest?.figures ? ` · ${rows(manifest.figures).length} ${t("张", "figures")}` : ""}</small>` : `<span class="publication-round">${esc(t(`第 ${context.options.iteration || 1} 轮评估`, `Assessment round ${context.options.iteration || 1}`))}</span>`}</div></header>`;
  }
  function loadingView(context) {
    const t = translate(context.options.language);
    if (isInline(context)) return `<section class="publication-gallery publication-inline" aria-label="${t("本节工程图件", "Figures for this section")}"><div class="publication-status publication-loading" role="status" aria-live="polite"><div class="publication-status-symbol" aria-hidden="true"><i></i><i></i><i></i></div><h3>${t("正在载入本节图件", "Loading this section's figures")}</h3><p>${t("图件来自本轮已完成的工程计算。", "Figures use the completed engineering calculations from this round.")}</p></div></section>`;
    return `<section class="publication-gallery" aria-label="${t("空间分析工程图册", "Spatial engineering atlas")}">${galleryHeader(context, t)}<div class="publication-status publication-loading" role="status" aria-live="polite"><div class="publication-status-symbol" aria-hidden="true"><i></i><i></i><i></i></div><h3>${t("正在整理本次工程图册", "Preparing this assessment's figures")}</h3><p>${t("将已完成的工程结果排入统一图式，生成清晰的预览与可下载图件。", "Arranging completed engineering results into consistent figures for viewing and download.")}</p><small>${t("首次打开可能需要一些时间；工程计算结果保持不变。", "The first visit may take a moment. The engineering results remain unchanged.")}</small></div></section>`;
  }
  function emptyView(context, message, error = false) {
    const t = translate(context.options.language);
    if (isInline(context)) return `<section class="publication-gallery publication-inline" aria-label="${t("本节工程图件", "Figures for this section")}"><div class="publication-status" role="status"><h3>${error ? t("本节图件暂时未能加载", "This section's figures could not be loaded") : t("本节暂无可展示的图件", "No figures are available for this section")}</h3><p>${esc(message || t("当前情景尚未生成本节所需图件，可先阅读已完成的结果。", "The selected scenario has no figures for this section yet. Completed results remain available to read."))}</p><button class="publication-button" type="button" data-publication-action="retry">${t("重新加载图件", "Reload figures")} <span aria-hidden="true">↻</span></button></div></section>`;
    return `<section class="publication-gallery" aria-label="${t("空间分析工程图册", "Spatial engineering atlas")}">${galleryHeader(context, t)}<div class="publication-status" role="status"><span class="publication-status-index">${error ? "!" : "—"}</span><h3>${error ? t("图册暂时未能加载", "The figure atlas could not be loaded") : t("当前还没有可展示的图件", "No figures are available yet")}</h3><p>${esc(message || t("完成相应工程计算后，图件会出现在这里。", "Figures will appear here after the relevant engineering calculations are complete."))}</p><button class="publication-button" type="button" data-publication-action="retry">${t("重新加载图册", "Reload figures")} <span aria-hidden="true">↻</span></button></div></section>`;
  }
  function controls(context, t) {
    const figures = rows(context.manifest.figures);
    const scenarioIds = [...new Set(figures.map(figure => figure.scenario_id).filter(id => id !== null && id !== undefined && id !== "").map(String))];
    const scenarios = scenarioIds.map(id => `<option value="${esc(id)}" ${context.state.scenario === id ? "selected" : ""}>${esc(id)}</option>`);
    if (context.state.scenario && !scenarioIds.includes(context.state.scenario)) scenarios.unshift(`<option value="${esc(context.state.scenario)}" selected>${esc(context.state.scenario)} · ${t("暂无图件", "no figures")}</option>`);
    const iterations = rows(context.options.iterations).map(item => typeof item === "object" ? item.iteration : item);
    return `<div class="publication-controls"><div class="publication-control-group">${iterations.length > 1 ? `<label><span>${t("计算轮次", "Assessment round")}</span><select data-publication-iteration>${iterations.map(iteration => `<option value="${esc(iteration)}" ${Number(iteration) === Number(context.options.iteration) ? "selected" : ""}>${esc(t(`第 ${iteration} 轮`, `Round ${iteration}`))}</option>`).join("")}</select></label>` : `<span class="publication-round">${esc(t(`第 ${context.options.iteration || 1} 轮评估`, `Assessment round ${context.options.iteration || 1}`))}</span>`}<label><span>${t("地震情景", "Earthquake scenario")}</span><select data-publication-scenario ${scenarioIds.length ? "" : "disabled"}>${scenarios.join("") || `<option>${t("未区分情景", "No separate scenarios")}</option>`}</select></label></div><span class="publication-control-note">${t("选择步骤 → 阅读图件 → 下载使用", "Choose a step → Read the figure → Download")}</span></div>`;
  }
  function stepTabs(context, t) {
    const figures = selectableFigures(context);
    return `<nav class="publication-steps" aria-label="${t("按工程计算步骤筛选图件", "Filter figures by engineering step")}">${steps.map(([id, zh, en, order, color]) => {
      const count = id === "all" ? figures.length : figures.filter(figure => figure.source_skill_id === id).length;
      return `<button type="button" data-publication-step="${id}" class="publication-step ${context.state.category === id ? "is-active" : ""}" style="--publication-step-color:${color}" aria-pressed="${context.state.category === id}" ${!count && id !== "all" ? "disabled" : ""}><span class="publication-step-number">${order}</span><span>${t(zh, en)}</span><small>${count || "—"}</small></button>`;
    }).join("")}</nav>`;
  }
  function mainFigure(context, figure, figures, t) {
    const selectedIndex = figures.indexOf(figure);
    const allIndex = rows(context.manifest.figures).indexOf(figure) + 1;
    const number = String(allIndex).padStart(2, "0");
    const preview = artifactURL(context, figure.formats?.svg || figure.formats?.png);
    const step = steps.find(item => item[0] === figure.source_skill_id);
    return `<figure class="publication-main"><header class="publication-figure-toolbar"><div><span class="publication-figure-number">FIG. ${number}</span><span class="publication-figure-kind">${step ? t(step[1], step[2]) : t("工程结果", "Engineering result")}</span>${Number(figure.page_count) > 1 ? `<span class="publication-page-badge">${esc(t(`分图 ${figure.page || 1} / ${figure.page_count}`, `Sheet ${figure.page || 1} / ${figure.page_count}`))}</span>` : ""}</div><div class="publication-figure-tools">${figurePager(context, figures, selectedIndex, t)}<button type="button" data-publication-action="fullscreen" ${preview ? "" : "disabled"}>${t("全屏查看", "Full screen")} <span aria-hidden="true">⛶</span></button></div></header><div class="publication-paper">${preview ? `<img class="publication-main-image" src="${esc(preview)}" alt="${esc(figure.title)}" decoding="async"><div class="publication-image-error" hidden><strong>${t("图件预览暂时无法加载", "The figure preview could not be loaded")}</strong><p>${t("可以重新加载图册，或使用下方链接下载原图。", "Reload the atlas or use the links below to download the original figure.")}</p><button type="button" data-publication-action="retry">${t("重新加载", "Reload")}</button></div>` : `<div class="publication-status"><p>${t("本图暂无可预览格式，请使用下方提供的下载文件。", "No preview format is available. Use the download files below.")}</p></div>`}</div><figcaption class="publication-figure-caption"><div><h3><span>${t(`图 ${number}`, `Figure ${number}`)}.</span> ${esc(figure.title || t("工程结果图件", "Engineering result figure"))}</h3><p>${esc(figure.caption || "")}</p></div><div class="publication-figure-downloads"><span>${t("下载这张图", "Download this figure")}</span><div>${downloadLinks(context, figure, t)}</div></div></figcaption></figure>`;
  }
  function figurePager(context, figures, selectedIndex, t) {
    if (isInline(context) && figures.length < 2) return "";
    return `<button type="button" data-publication-action="previous" ${selectedIndex <= 0 ? "disabled" : ""} aria-label="${t("上一张图", "Previous figure")}">←</button><span>${selectedIndex + 1} / ${figures.length}</span><button type="button" data-publication-action="next" ${selectedIndex >= figures.length - 1 ? "disabled" : ""} aria-label="${t("下一张图", "Next figure")}">→</button>`;
  }
  function inlineChoices(context, figures, t) {
    if (figures.length < 2) return "";
    const current = figureIdentity(selectedFigure(context) || {});
    return `<div class="publication-inline-choices" role="group" aria-label="${t("选择本节图件", "Select a figure in this section")}">${figures.map(figure => {
      const id = figureIdentity(figure);
      const number = String(rows(context.manifest.figures).indexOf(figure) + 1).padStart(2, "0");
      return `<button type="button" class="publication-inline-choice ${id === current ? "is-active" : ""}" data-publication-figure="${esc(id)}" aria-pressed="${id === current}"><span>FIG. ${number}</span><strong>${esc(figure.title || t("工程图件", "Engineering figure"))}</strong>${Number(figure.page_count) > 1 ? `<small>${esc(t(`分图 ${figure.page || 1} / ${figure.page_count}`, `Sheet ${figure.page || 1} / ${figure.page_count}`))}</small>` : ""}</button>`;
    }).join("")}</div>`;
  }
  function inlineReadyView(context, t) {
    const candidates = templateFigures(context);
    if (!context.state.scenario) context.state.scenario = String(candidates.find(figure => figure.scenario_id)?.scenario_id || "");
    const figures = filteredFigures(context);
    const figure = selectedFigure(context);
    if (!figure) return emptyView(context, context.state.scenario
      ? t(`所选情景 ${context.state.scenario} 尚无本节所需的工程图件。`, `No matching figures are available for this section in the selected scenario ${context.state.scenario}.`)
      : t("本轮尚未生成本节所需的工程图件。", "This round has no matching figures for this section yet."));
    context.state.figureId = figureIdentity(figure);
    return `<section class="publication-gallery publication-inline" aria-label="${t("本节工程图件", "Figures for this section")}">${mainFigure(context, figure, figures, t)}${inlineChoices(context, figures, t)}${fullscreenDialog(context, figure, t)}</section>`;
  }
  function thumbnails(context, figures, t) {
    return `<section class="publication-catalog"><header><h3>${t("本组图件", "Figures in this group")}</h3><span>${t(`${figures.length} 张 · 点击切换`, `${figures.length} figures · select to view`)}</span></header><div class="publication-thumbnails" role="group" aria-label="${t("选择图件", "Choose a figure")}">${figures.map(figure => {
      const figureId = figureIdentity(figure);
      const number = String(rows(context.manifest.figures).indexOf(figure) + 1).padStart(2, "0");
      const preview = artifactURL(context, figure.formats?.svg || figure.formats?.png);
      const active = figureIdentity(selectedFigure(context) || {}) === figureId;
      return `<button type="button" class="publication-thumbnail ${active ? "is-active" : ""}" data-publication-figure="${esc(figureId)}" aria-pressed="${active}"><span class="publication-thumb-image">${preview ? `<img src="${esc(preview)}" alt="" loading="lazy" decoding="async">` : `<span>${t("暂无预览", "No preview")}</span>`}<i>FIG. ${number}</i></span><strong>${esc(figure.title || t("工程图件", "Engineering figure"))}</strong>${Number(figure.page_count) > 1 ? `<small>${esc(t(`分图 ${figure.page || 1} / ${figure.page_count}`, `Sheet ${figure.page || 1} / ${figure.page_count}`))}</small>` : ""}</button>`;
    }).join("")}</div></section>`;
  }
  function fullscreenDialog(context, figure, t) {
    const preview = artifactURL(context, figure?.formats?.svg || figure?.formats?.png);
    if (!figure || !preview) return "";
    return `<dialog class="publication-fullscreen" aria-label="${esc(t(`全屏图件：${figure.title}`, `Full-screen figure: ${figure.title}`))}"><header><div><span>${t("工程图册", "ENGINEERING ATLAS")}</span><strong>${esc(figure.title)}</strong></div><div class="publication-fullscreen-tools"><button type="button" data-publication-action="zoom-out" aria-label="${t("缩小图件", "Zoom out")}">−</button><span data-publication-zoom>${Math.round(context.state.zoom * 100)}%</span><button type="button" data-publication-action="zoom-in" aria-label="${t("放大图件", "Zoom in")}">+</button><button type="button" data-publication-action="fit">${t("适应页面", "Fit page")}</button><button type="button" data-publication-action="close">${t("关闭", "Close")} ×</button></div></header><div class="publication-fullscreen-stage"><img class="publication-fullscreen-image" src="${esc(preview)}" alt="${esc(figure.title)}" style="width:${context.state.zoom * 100}%"></div><footer><p>${esc(figure.caption || "")}</p><div>${downloadLinks(context, figure, t)}</div></footer></dialog>`;
  }
  function readyView(context) {
    const t = translate(context.options.language);
    if (isInline(context)) return inlineReadyView(context, t);
    const manifestFigures = rows(context.manifest.figures);
    const scenarioIds = [...new Set(manifestFigures.map(figure => figure.scenario_id).filter(Boolean).map(String))];
    if (!context.state.scenario && scenarioIds.length) context.state.scenario = scenarioIds[0];
    const figures = filteredFigures(context);
    const figure = selectedFigure(context);
    if (figure) context.state.figureId = figureIdentity(figure);
    const missing = context.state.scenario && !scenarioIds.includes(context.state.scenario);
    const unavailable = missing ? t(`所选情景 ${context.state.scenario} 暂无图件。请选择已有图件的情景。`, `No figures are available for the selected scenario ${context.state.scenario}. Select an available scenario.`) : t("本步骤暂无可展示的图件，可以选择其他已完成步骤或查看全部图件。", "No figures are available for this step. Choose another completed step or view all figures.");
    return `<section class="publication-gallery" aria-label="${t("空间分析工程图册", "Spatial engineering atlas")}">${galleryHeader(context, t)}${controls(context, t)}${stepTabs(context, t)}${figure ? `${mainFigure(context, figure, figures, t)}${thumbnails(context, figures, t)}` : `<div class="publication-status"><span class="publication-status-index">—</span><h3>${t("当前选择暂无图件", "No figures for this selection")}</h3><p>${esc(unavailable)}</p></div>`}<footer class="publication-footnote"><span>${t("图件依据本轮已完成的工程计算结果生成。", "Figures are generated from this round's completed engineering calculations.")}</span><span title="${esc(context.manifest.template_version || "")}">${t("可用于报告与论文排版", "Ready for reports and publications")}</span></footer>${fullscreenDialog(context, figure, t)}</section>`;
  }
  function paint(context) {
    if (!isCurrent(context)) return;
    const focus = context.focusAfterPaint;
    context.focusAfterPaint = null;
    if (context.loading) context.container.innerHTML = loadingView(context);
    else if (context.error) context.container.innerHTML = emptyView(context, context.error, true);
    else if (!rows(context.manifest?.figures).length) context.container.innerHTML = emptyView(context, context.manifest?.message || context.manifest?.reason || rows(context.manifest?.warnings)[0]);
    else context.container.innerHTML = readyView(context);
    const root = context.container.querySelector(".publication-gallery");
    if (!root) return;
    root.addEventListener("click", event => handleClick(context, event));
    root.addEventListener("change", event => handleChange(context, event));
    root.addEventListener("error", event => {
      if (!event.target.matches?.(".publication-main-image")) return;
      event.target.hidden = true;
      const message = root.querySelector(".publication-image-error");
      if (message) message.hidden = false;
    }, true);
    const dialog = root.querySelector(".publication-fullscreen");
    dialog?.querySelector(".publication-fullscreen-image")?.addEventListener("load", () => applyZoom(context, dialog));
    dialog?.addEventListener("close", () => {
      context.state.fullscreen = false;
      root.querySelector('[data-publication-action="fullscreen"]')?.focus({ preventScroll: true });
    });
    if (context.state.fullscreen && dialog?.showModal) { dialog.showModal(); applyZoom(context, dialog); }
    if (focus) root.querySelector(focus)?.focus({ preventScroll: true });
  }
  function handleChange(context, event) {
    if (event.target.matches?.("[data-publication-scenario]")) {
      context.state.scenario = event.target.value;
      context.state.figureId = null;
      context.state.category = "all";
      context.state.fullscreen = false;
      context.focusAfterPaint = "[data-publication-scenario]";
      paint(context);
      context.options.onScenarioChange?.(context.state.scenario);
    } else if (event.target.matches?.("[data-publication-iteration]")) context.options.onIterationChange?.(Number(event.target.value));
  }
  function applyZoom(context, dialog) {
    const image = dialog?.querySelector(".publication-fullscreen-image");
    const stage = dialog?.querySelector(".publication-fullscreen-stage");
    const label = dialog?.querySelector("[data-publication-zoom]");
    if (image && stage) {
      const width = Math.max(1, stage.clientWidth - 32);
      const height = Math.max(1, stage.clientHeight - 32);
      const fitWidth = image.naturalWidth > 0 && image.naturalHeight > 0 ? Math.min(width, height * image.naturalWidth / image.naturalHeight) : width;
      image.style.width = `${fitWidth * context.state.zoom}px`;
    }
    if (label) label.textContent = `${Math.round(context.state.zoom * 100)}%`;
  }
  function handleClick(context, event) {
    const step = event.target.closest?.("[data-publication-step]");
    if (step && !step.disabled) {
      context.state.category = step.dataset.publicationStep;
      context.state.figureId = null;
      context.focusAfterPaint = `[data-publication-step="${context.state.category}"]`;
      paint(context);
      return;
    }
    const thumbnail = event.target.closest?.("[data-publication-figure]");
    if (thumbnail) {
      context.state.figureId = thumbnail.dataset.publicationFigure;
      paint(context);
      const main = context.container.querySelector(".publication-main");
      main?.setAttribute("tabindex", "-1");
      main?.focus({ preventScroll: true });
      main?.scrollIntoView({ block: "start", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth" });
      return;
    }
    const button = event.target.closest?.("[data-publication-action]");
    if (!button || button.disabled) return;
    const action = button.dataset.publicationAction;
    if (action === "retry") { context.state.fullscreen = false; requestManifest(context, true); return; }
    const dialog = context.container.querySelector(".publication-fullscreen");
    if (action === "fullscreen") {
      context.state.fullscreen = true;
      context.state.zoom = 1;
      dialog?.showModal?.();
      applyZoom(context, dialog);
      dialog?.querySelector(".publication-fullscreen-stage")?.scrollTo({ top: 0, left: 0 });
    } else if (action === "close") dialog?.close?.();
    else if (["zoom-in", "zoom-out", "fit"].includes(action)) {
      context.state.zoom = action === "fit" ? 1 : Math.max(.5, Math.min(3, context.state.zoom + (action === "zoom-in" ? .25 : -.25)));
      applyZoom(context, dialog);
    } else if (action === "next" || action === "previous") {
      const figures = filteredFigures(context);
      const at = figures.indexOf(selectedFigure(context));
      const next = figures[at + (action === "next" ? 1 : -1)];
      if (!next) return;
      context.state.figureId = figureIdentity(next);
      context.focusAfterPaint = `[data-publication-action="${action}"]:not(:disabled)`;
      paint(context);
    }
  }
  async function requestManifest(context, force = false) {
    const t = translate(context.options.language);
    try {
      const source = window.ReferencePowerResults?.figureManifest?.({...context.options,force});
      if (source) {
        context.loading = true; context.error = null; paint(context);
        const supplied = await source;
        if (supplied) { context.manifest = supplied; context.loading = false; context.error = null; paint(context); return; }
      }
    } catch (error) { context.loading = false; context.error = error?.message || String(error); paint(context); return; }
    const revision = resultRevision(context.options);
    if (force) context.retryToken = `${Date.now()}-${++retrySequence}`;
    let entry = cache.get(context.key);
    if (force || !entry || entry.sourceSignature !== context.sourceSignature) {
      const params = new URLSearchParams({ iteration: String(context.options.iteration || 1), language: context.options.language || "zh-CN" });
      if (revision) params.set("revision", revision);
      entry = { sourceSignature: context.sourceSignature, data: null, error: null, promise: null };
      const url = `/api/engineering/native/sessions/${encodeURIComponent(context.options.sessionId)}/figures?${params}`;
      entry.promise = fetch(url, { headers: { Accept: "application/json" }, cache: force ? "reload" : (revision ? "force-cache" : "no-store") }).then(async response => {
        let payload;
        try { payload = await response.json(); } catch { throw new Error(t("图册服务没有返回有效数据，请稍后重新加载。", "The figure service returned invalid data. Please reload shortly.")); }
        if (!response.ok) throw new Error(payload?.detail?.message || payload?.message || (typeof payload?.detail === "string" ? payload.detail : t(`图册请求失败（${response.status}）。`, `Figure request failed (${response.status}).`)));
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.figures)) throw new Error(t("图册格式不完整，请稍后重新加载。", "The figure manifest is incomplete. Please reload shortly."));
        if (revision && payload.display_revision !== revision) throw new Error(t("图册版本与本轮结果不一致，请重新加载页面。", "The figure version differs from this result. Please reload the page."));
        entry.data = payload;
        return payload;
      }).catch(error => { entry.error = error?.message || String(error); throw error; });
      cache.set(context.key, entry);
      while (cache.size > 16) cache.delete(cache.keys().next().value);
    }
    context.entry = entry;
    if (entry.data) { context.manifest = entry.data; context.loading = false; context.error = null; paint(context); return; }
    if (entry.error && !force) { context.loading = false; context.error = entry.error; paint(context); return; }
    context.loading = true;
    context.error = null;
    paint(context);
    try {
      const manifest = await entry.promise;
      if (!isCurrent(context) || context.entry !== entry) return;
      context.manifest = manifest;
      context.loading = false;
      context.error = null;
      paint(context);
    } catch (error) {
      if (!isCurrent(context) || context.entry !== entry) return;
      context.loading = false;
      context.error = error?.message || String(error);
      paint(context);
    }
  }
  function mount(container, options) {
    if (!container || !options?.sessionId) return;
    const key = identity(options);
    const sourceSignature = resultRevision(options) || String(options.sourceSignature || "");
    const viewSignature = viewIdentity(options);
    const previous = mounted.get(container);
    const selected = options.selectedScenario === null || options.selectedScenario === undefined ? "" : String(options.selectedScenario);
    if (previous && previous.key === key && previous.sourceSignature === sourceSignature) {
      previous.options = options;
      const viewChanged = previous.viewSignature !== viewSignature;
      previous.viewSignature = viewSignature;
      if (previous.externalScenario !== selected || viewChanged) {
        previous.externalScenario = selected;
        previous.state.scenario = selected;
        previous.state.category = "all";
        previous.state.figureId = null;
        previous.state.fullscreen = false;
        paint(previous);
      }
      const latestEntry = cache.get(key);
      if (latestEntry && latestEntry.sourceSignature === sourceSignature && previous.entry !== latestEntry) requestManifest(previous);
      return;
    }
    const context = { container, options, key, sourceSignature, viewSignature, externalScenario: selected, manifest: null, loading: true, error: null, state: { scenario: selected, category: "all", figureId: null, fullscreen: false, zoom: 1 } };
    mounted.set(container, context);
    requestManifest(context);
  }
  function destroy(container) {
    const current = mounted.get(container);
    if (current) current.state.fullscreen = false;
    mounted.delete(container);
    container?.querySelector?.(".publication-fullscreen[open]")?.close?.();
  }
  function mountInline(container, options) { mount(container, { ...options, mode: "inline" }); }
  window.PublicationGallery = Object.freeze({ mount, mountInline, destroy });
})();


