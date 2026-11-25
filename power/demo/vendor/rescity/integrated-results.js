/* Read a completed assessment as one illustrated engineering report. */
(() => {
  "use strict";
  const mounts = new WeakMap();
  const list = value => Array.isArray(value) ? value : [];
  const resultNotes = values => window.MedicalDisplayLabels?.resultNotes?.(list(values)) || list(values);
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const translate = language => (zh, en) => String(language).startsWith("en") ? en : zh;
  const stages = [
    ["earthquake_scenario_interpretation", "评估范围与地震情景", "Assessment scope and scenario", "先确认本轮评估覆盖哪里、用了什么输入。", "Start with the area and inputs covered by this assessment.", ["earthquake-preparation"]],
    ["hospital_damage_assessment", "医院损伤与修复", "Hospital damage and repair", "从结构损伤判断需要重点核查的医院。", "Identify hospitals that need closer structural review.", ["hospital-damage-repair"]],
    ["hospital_function_degradation", "医院诊疗能力评估", "Hospital treatment capacity", "查看医院还保留多少诊疗能力，以及不同伤情的救治能力。", "Examine retained hospital capacity and treatment capacity by injury severity.", ["hospital-function-capacity", "severity-capacity"]],
    ["medical_system_function", "居民就医影响", "Impact on access to care", "把医院能力放回居民片区，查看哪些地方就医受到影响。", "Relate hospital capacity to the population and its access to care.", ["regional-function", "demand-accessibility", "spatial-distribution"]],
    ["recovery_optimization", "医院抢修顺序与方案", "Hospital repair order and plans", "比较恢复效果和修复工期，再查看队伍与修复顺序。", "Compare recovery and repair duration, then inspect teams and repair orders.", ["recovery-comparison", "sample-schedule"]],
  ];

  function scenarioIds(delivery) {
    return [...new Set([
      ...list(delivery.scenario_ids), ...list(delivery.computed_scenarios),
      ...list(delivery.decision_support?.scenarios).map(s => s.scenario_id),
      ...list(delivery.medical_service?.scenarios).map(s => s.scenario_id),
    ].filter(id => id !== null && id !== undefined && id !== "").map(String))];
  }
  function scopedRows(table, scenario) {
    return list(table.rows).filter(row => {
      const id = row.scenario_id ?? row.scenario;
      return id === null || id === undefined || id === "" || String(id) === scenario;
    });
  }
  function sectionsFor(delivery, scenario) {
    const sections = new Map();
    for (const section of [...list(delivery.figure_sections), ...list(delivery.sections)]) {
      const previous = sections.get(section.skill_id);
      const tables = new Map(list(previous?.tables).map(table => [table.table_id, table]));
      for (const table of list(section.tables)) tables.set(table.table_id, { ...table, rows: scopedRows(table, scenario) });
      sections.set(section.skill_id, {
        ...previous, ...section, tables: [...tables.values()],
        limitations: [...new Set([...list(previous?.limitations), ...list(section.limitations)])],
      });
    }
    return stages.filter(stage => sections.has(stage[0])).map((stage, index) => ({
      stage, section: sections.get(stage[0]), index, id: `engineering-chapter-${index + 1}`,
    }));
  }
  function evidenceButton(item, chapters, t) {
    const chapter = chapters.find(c => c.stage[0] === item.source_skill_id);
    const index = list(chapter?.section.tables).findIndex(table => table.table_id === item.source_table_id);
    return index < 0 ? "" : `<button type="button" class="reading-evidence" data-reading-jump="${chapter.id}-table-${index}">${t("查看计算依据", "View calculation evidence")} ↗</button>`;
  }
  function servicePart(context, name) {
    return window.MedicalServiceView?.renderPart(context.service, context.scenario, context.options.language, name) || "";
  }

  const finite = value => typeof value === "number" && Number.isFinite(value);
  const number = (value, digits = 1) => finite(value) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
  const indexNumber = value => finite(value) && value !== 0 && Math.abs(value) < .001 ? value.toExponential(3) : number(value, 4);
  const percent = value => finite(value) ? `${number(Number(value) * 100)}%` : "—";
  const strategyName = (value, t) => window.MedicalDisplayLabels?.strategy(value, t("zh-CN", "en-US")) || ({ importance: t("损失与修复时间排序", "Loss / repair-time order"), ga: t("逐次模拟优化方案", "Per-simulation optimized plan"), robust_ga: t("统一抢修顺序优化", "Unified repair order") })[value] || String(value || "—");
  function recoveryRows(context) {
    return list(context.chapters.find(c => c.stage[0] === "recovery_optimization")?.section.tables).find(table => table.table_id === "recovery")?.rows || [];
  }
  function availableTopics(context) {
    const has = skill => context.chapters.some(c => c.stage[0] === skill);
    return [
      ["overview", "结论与建议", "Conclusion & actions"],
      ...(has("hospital_damage_assessment") || has("hospital_function_degradation") ? [["hospitals", "医院震后救治能力", "Post-earthquake hospital treatment capacity"]] : []),
      ...(has("medical_system_function") ? [["service", "居民就医影响", "Access to care"]] : []),
      ...(has("recovery_optimization") ? [["recovery", "恢复方案", "Recovery plans"]] : []),
      ["evidence", "数据与依据", "Data & evidence"],
    ];
  }
  function scope(context) {
    const region = context.service?.basis?.region || context.delivery.region;
    const place = region && typeof region === "object" ? [...new Set([region.city_name, region.region_name].filter(Boolean))].join(" · ") : typeof region === "string" ? region : "";
    const summary = context.serviceScenario?.summary;
    const hospitalCount = summary?.hospital_count ?? context.delivery.hospital_count;
    const demandCount = summary?.demand_node_count ?? context.delivery.demand_node_count ?? context.delivery.node_count;
    const counts = [finite(hospitalCount) ? context.t(`${number(hospitalCount, 0)} 家医院`, `${number(hospitalCount, 0)} hospitals`) : "", finite(demandCount) ? context.t(`${number(demandCount, 0)} 个居民片区`, `${number(demandCount, 0)} population areas`) : ""].filter(Boolean).join(" · ");
    return [place, context.scenario, counts].filter(Boolean).join(" / ");
  }
  function assessmentTitle(context) {
    const computed = new Set([...list(context.delivery.executed_components), ...context.chapters.map(chapter => chapter.stage[0])]);
    if (computed.has("recovery_optimization") || computed.has("resilience_quantification")) return context.t("医疗系统韧性评估", "Healthcare resilience assessment");
    if (computed.has("medical_system_function")) return context.t("医疗服务功能评估", "Healthcare service function assessment");
    if (computed.has("hospital_function_degradation")) return context.t("医院损伤与功能评估", "Hospital damage and function assessment");
    if (computed.has("hospital_damage_assessment")) return context.t("医疗建筑损伤评估", "Healthcare building damage assessment");
    return context.t("医疗工程评估", "Healthcare engineering assessment");
  }
  function figureSlot(context, key, templates) {
    context.figureSlots.set(key, templates);
    return `<div class="reading-figure-slot" data-reading-figures="${key}"></div>`;
  }
  function observations(context, skills) {
    const items = list(context.decision?.findings).filter(item => skills.includes(item.source_skill_id));
    return items.length ? `<div class="reading-observations">${items.map(item => `<article><h4>${esc(item.title)}</h4><p>${esc(item.observation)}</p><details><summary>${context.t("解释与依据", "Meaning and evidence")}</summary>${item.meaning ? `<p>${esc(item.meaning)}</p>` : ""}${evidenceButton(item, context.chapters, context.t)}</details></article>`).join("")}</div>` : `<p class="reading-muted">${context.t("本轮未提供额外解读，可结合图表和原始表查看结果。", "No additional interpretation is available. Refer to the figures and original data.")}</p>`;
  }
  function recommendationList(context, items, compact = false) {
    const t = context.t;
    const names = { first: t("优先", "Priority"), next: t("后续优化", "Next"), verify: t("补充验证", "Verify") };
    return `<div class="reading-recommendations ${compact ? "is-compact" : ""}">${items.map((item, index) => {
      const detail = `<p>${esc(item.action)}</p>${item.rationale ? `<p><b>${t("为什么：", "Why: ")}</b>${esc(item.rationale)}</p>` : ''}${item.verification ? `<p><b>${t("如何验证：", "Verify: ")}</b>${esc(item.verification)}</p>` : ''}`;
      return `<details class="reading-recommendation"><summary><span class="reading-action-index">${String(index + 1).padStart(2, "0")}</span><span><small>${esc(names[item.priority] || names.verify)}</small><strong>${esc(item.title)}</strong></span><span class="reading-expand" aria-hidden="true">＋</span></summary><div>${detail}${evidenceButton(item, context.chapters, t)}${knowledgeHTML(context, item.source_skill_id, item.title)}</div></details>`;
    }).join('')}</div>`;
  }
  function priorityItems(context) {
    const all = list(context.decision?.recommendations);
    const chosen = all.filter(item => item.priority === "first").slice(0, 2);
    const recovery = all.find(item => item.source_skill_id === "recovery_optimization");
    if (recovery && !chosen.includes(recovery)) chosen.push(recovery);
    for (const item of all) if (chosen.length < 3 && !chosen.includes(item)) chosen.push(item);
    return chosen;
  }
  function shortText(value, limit = 260) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (text.length <= limit) return text;
    const candidate = text.slice(0, limit);
    const sentence = Math.max(candidate.lastIndexOf("。"), candidate.lastIndexOf("！"), candidate.lastIndexOf("？"), candidate.lastIndexOf(". "));
    return sentence > limit / 3 ? candidate.slice(0, sentence + 1) : `${candidate.trim()}…`;
  }
  function displayText(context, value) {
    return window.MedicalDisplayLabels?.text(value, context.options.language) ?? String(value ?? "");
  }
  function topicFinding(context, skills) {
    return list(context.decision?.findings).find(item => skills.includes(item.source_skill_id) && item.observation);
  }
  function summaryText(context, summary) {
    if (finite(summary.system_function_ratio)) {
      const t = context.t;
      const parts = [t(`本轮模拟平均结果显示，区域医疗服务功能保留为震前的 ${percent(summary.system_function_ratio)}。这不是可收治人数，也不表示同等比例的人口无法就医。`, `Across the saved simulations, regional healthcare service function retains ${percent(summary.system_function_ratio)} of its baseline. This is neither admissions nor the proportion of people unable to access care.`)];
      if (finite(summary.coverage_ratio) && finite(context.serviceScenario?.service_radius_minutes)) parts.push(t(`${number(context.serviceScenario.service_radius_minutes)} 分钟内至少可到一家医院的人口占 ${percent(summary.coverage_ratio)}；到得了医院不代表诊疗能力足够。`, `${percent(summary.coverage_ratio)} of the input population can reach at least one hospital within ${number(context.serviceScenario.service_radius_minutes)} minutes; reaching care does not guarantee sufficient capacity.`));
      const hospitals = list(context.serviceScenario?.hospitals).filter(row => finite(row.retained_ratio)).sort((a, b) => a.retained_ratio - b.retained_ratio).slice(0, 2);
      if (hospitals.length) parts.push(t(`诊疗能力保留较低的包括 ${hospitals.map(row => row.hospital_name || row.hospital_id).join('、')}，应结合关联居民片区和恢复方案重点核查。`, `Lower retained capacity is found at ${hospitals.map(row => row.hospital_name || row.hospital_id).join(', ')}. Review their population-area links and repair plans.`));
      return parts.join(' ');
    }
    const findings = list(context.decision?.findings);
    const finding = ["medical_system_function", "hospital_function_degradation", "hospital_damage_assessment", "recovery_optimization"]
      .map(skill => findings.find(item => item.source_skill_id === skill && item.observation)).find(Boolean);
    const paragraph = finding?.observation || list(context.decision?.paragraphs)[0] || context.decision?.summary;
    if (paragraph) return shortText(displayText(context, paragraph));
    return context.t("本轮已完成的计算结果见地图和下方明细；尚未计算的指标不作结论。", "The map and details show completed computations. No conclusions are drawn for metrics that have not been computed.");
  }
  function dataQualityHTML(context) {
    const quality = context.service?.data_quality, t = context.t;
    if (!quality) return '';
    const s = quality.summary || {}, population = quality.population || {}, travel = quality.travel || {};
    const details = [
      [t('医院位置', 'Hospital locations'), t(`${number(s.hospital_count, 0)} 家医院；${number(s.address_estimate_count, 0)} 家使用地址附近估算，${number(s.high_uncertainty_count, 0)} 家标注定位不确定度至少 800 米。`, `${number(s.hospital_count, 0)} hospitals; ${number(s.address_estimate_count, 0)} use address estimates, ${number(s.high_uncertainty_count, 0)} have recorded uncertainty of at least 800 m.`)],
      [t('人口资料', 'Population inputs'), [population.source, finite(population.year) ? t(`${String(Math.trunc(population.year))} 年资料`, `Year ${String(Math.trunc(population.year))}`) : t('未注明统计年份', 'Statistical year not specified'), population.scope].filter(Boolean).join(' · ')],
      [t('到院时间', 'Travel times'), travel.label || t('录入的日常到院时间', 'Input baseline travel times')],
    ];
    return `<details class="reading-detail reading-quality"><summary>${t('数据来源与估算说明', 'Data sources and estimates')}</summary><dl>${details.map(([title, value]) => `<div><dt>${esc(title)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl>${population.method === 'population_grid' ? `<p>${t('人口点代表聚合片区，不是单个居民或现势社区台账。', 'Population points represent aggregated areas, not individuals or a current community census.')}</p>` : ''}${travel.routing === false ? `<p>${t('距离估算不包含道路、桥梁绕行或震后交通中断；重点片区应优先用实际到院时间替换。', 'Distance estimates omit road routes, bridge detours and post-event disruptions. Replace them with actual travel times for priority areas.')}</p>` : ''}${resultNotes(quality.reference_assumptions).map(note => `<p>${esc(note)}</p>`).join('')}<p>${t('已录入的实际资料优先使用。通用参数由系统自动匹配，不需要您选择模型。', 'Actual inputs take priority. Reference matching is automatic and requires no model selection.')}</p></details>`;
  }
  function knowledgeHTML(context, skill = null, adviceTitle = null) {
    const t = context.t, topics = { hospital_damage_assessment: 'damage', hospital_function_degradation: 'service', medical_system_function: 'service', recovery_optimization: 'recovery' };
    const references = list(context.delivery.knowledge_references).filter(ref =>
      (!ref.scenario_id || String(ref.scenario_id) === context.scenario) &&
      (!skill || ref.source_skill_id === skill || ref.topic === topics[skill]) &&
      (!adviceTitle || ref.kind === 'method' || ref.advice_title === adviceTitle));
    if (!references.length) return '';
    return `<details class="reading-detail reading-knowledge"><summary>${t(`已核对的文献依据（${references.length}条）`, `Verified references (${references.length})`)}</summary>${references.map(ref => `<article><strong>${esc(ref.title || ref.evidence_id)}</strong>${ref.page != null ? `<span> · ${t('页码', 'Page')} ${esc(ref.page)}</span>` : ''}${ref.applies_to ? `<p>${t('支持的解释或建议：', 'Supports: ')}${esc(ref.applies_to)}</p>` : ''}<blockquote>${esc(ref.quote)}</blockquote></article>`).join('')}<p>${t('引用用于说明方法和建议，评估数值仍来自本轮工程计算。', 'References explain methods and advice; numerical results come from this assessment’s engineering calculations.')}</p></details>`;
  }
  function objectButton(context, row, kind) {
    const id = kind === "hospital" ? row.hospital_id : row.node_id;
    const label = kind === "hospital" ? row.hospital_name || id : row.node_name || id;
    if (id === null || id === undefined) return esc(label || "—");
    return `<button type="button" class="reading-object-button" data-reading-${kind === "hospital" ? "hospital" : "node"}="${esc(id)}" title="${context.t("在地图上查看", "Show on map")}">${esc(label || "—")} ↗</button>`;
  }
  function keyTable(context, topic) {
    const t = context.t;
    if (topic === "hospitals") {
      const rows = list(context.serviceScenario?.hospitals).filter(row => finite(row.retained_ratio)).sort((a, b) => a.retained_ratio - b.retained_ratio).slice(0, 5);
      if (rows.length) return `<div class="reading-comparison-table reading-key-table" role="region" aria-label="${t("医院能力明细", "Hospital capacity detail")}" tabindex="0"><table><caption>${t("能力保留比例较低的医院", "Hospitals with the lowest capacity retained")}</caption><thead><tr><th scope="col">${t("医院", "Hospital")}</th><th scope="col">${t("震前能力", "Pre-event capacity")}</th><th scope="col">${t("震后能力", "Post-event capacity")}</th><th scope="col">${t("能力保留比例", "Capacity retained")}</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${objectButton(context, row, "hospital")}</th><td>${number(row.weighted_pre_capacity)}</td><td>${number(row.weighted_post_capacity)}</td><td><strong>${percent(row.retained_ratio)}</strong></td></tr>`).join("")}</tbody></table><p class="reading-table-note">${t("最多显示 5 家。能力为 72 小时加权模型指标；详细名单与分伤情结果可在下方查询。", "Up to five hospitals. Capacity is a 72-hour weighted model index; explore the complete list and injury-severity results below.")}</p></div>`;
      const damage = list(context.chapters.find(c => c.stage[0] === "hospital_damage_assessment")?.section.tables).find(table => table.table_id === "damage");
      const damageRows = list(damage?.rows).filter(row => finite(row.probability_extensive_or_complete)).sort((a, b) => b.probability_extensive_or_complete - a.probability_extensive_or_complete).slice(0, 5);
      if (damageRows.length) return `<div class="reading-comparison-table reading-key-table" role="region" aria-label="${t("医院损伤明细", "Hospital damage detail")}" tabindex="0"><table><caption>${t("严重损伤概率较高的医院", "Hospitals with higher extensive or complete damage probabilities")}</caption><thead><tr><th scope="col">${t("医院", "Hospital")}</th><th scope="col">${t("发生损伤概率", "Any damage probability")}</th><th scope="col">${t("严重或毁坏概率", "Extensive or complete damage probability")}</th><th scope="col">${t("平均修复时间 / 天", "Mean repair time / days")}</th></tr></thead><tbody>${damageRows.map(row => `<tr><th scope="row">${objectButton(context, row, "hospital")}</th><td>${percent(row.probability_any_damage)}</td><td><strong>${percent(row.probability_extensive_or_complete)}</strong></td><td>${number(row.mean_repair_days)}</td></tr>`).join("")}</tbody></table><p class="reading-table-note">${t("最多显示 5 家。损伤概率用于确定核查对象，抢修顺序需结合恢复方案。", "Up to five hospitals. Damage probability identifies inspection priorities; repair order requires a recovery plan.")}</p></div>`;
    }
    if (topic === "service") {
      const rows = list(context.serviceScenario?.demand_nodes).filter(row => finite(row.post_accessibility)).sort((a, b) => a.post_accessibility - b.post_accessibility).slice(0, 5);
      if (rows.length) return `<div class="reading-comparison-table reading-key-table" role="region" aria-label="${t("居民片区就医明细", "Population-area healthcare detail")}" tabindex="0"><table><caption>${t("震后医疗服务相对较弱的居民片区", "Population areas with lower post-event healthcare access")}</caption><thead><tr><th scope="col">${t("居民片区", "Population area")}</th><th scope="col">${t("人口 / 人", "Population")}</th><th scope="col">${t("综合可达性", "Healthcare accessibility")}<small>${t("基准 → 震后", "Baseline → post-event")}</small></th><th scope="col">${t("最近到院时间 / 分钟", "Nearest travel / min")}</th></tr></thead><tbody>${rows.map(row => `<tr><th scope="row">${objectButton(context, row, "demand")}</th><td>${number(row.population, 0)}</td><td>${indexNumber(row.baseline_accessibility)} → <strong>${indexNumber(row.post_accessibility)}</strong></td><td>${number(row.nearest_minutes)}</td></tr>`).join("")}</tbody></table><p class="reading-table-note">${t("最多显示 5 个片区，按震后综合可达性从低到高排列。该指数在本轮内比较，没有统一的好坏分界。", "Up to five areas, ordered by post-event accessibility. Compare this index within the assessment; it has no universal pass/fail cutoff.")}</p></div>`;
    }
    return "";
  }
  function comparisonTable(context) {
    const rows = recoveryRows(context), t = context.t;
    if (!rows.length) return "";
    const rValues = rows.map(row => row.resilience).filter(finite).map(Number);
    const days = rows.map(row => row.total_recovery_days).filter(finite).map(Number);
    const maxR = rValues.length ? Math.max(...rValues) : null;
    const minDays = days.length ? Math.min(...days) : null;
    return `<div class="reading-comparison-table" role="region" aria-label="${t("恢复策略指标对比", "Recovery strategy comparison")}" tabindex="0"><table><caption>${t("恢复方案对比", "Recovery plan comparison")}</caption><thead><tr><th>${t("恢复策略", "Strategy")}</th><th>${t("平均韧性 R", "Mean resilience R")}<small>${t("同口径比较，越高越好", "Higher within comparable settings")}</small></th><th>${t("平均总恢复时间", "Mean total recovery time")}<small>${t("天 · 越短越好", "Days · shorter is better")}</small></th></tr></thead><tbody>${rows.map(row => `<tr><th>${esc(strategyName(row.strategy, t))}</th><td class="${finite(row.resilience) && Number(row.resilience) === maxR ? "reading-best" : ""}"><strong>${number(row.resilience, 4)}</strong>${finite(row.resilience) && Number(row.resilience) === maxR ? `<small>${t("本轮最高", "Highest this round")}</small>` : ""}</td><td class="${finite(row.total_recovery_days) && Number(row.total_recovery_days) === minDays ? "reading-best" : ""}"><strong>${number(row.total_recovery_days, 2)}</strong>${finite(row.total_recovery_days) && Number(row.total_recovery_days) === minDays ? `<small>${t("本轮最短", "Shortest this round")}</small>` : ""}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function overviewHTML(context) {
    const { t, decision, serviceScenario } = context;
    const summary = { ...serviceScenario?.summary };
    if (!finite(summary.system_function_ratio)) {
      const table = list(context.chapters.find(c => c.stage[0] === "medical_system_function")?.section.tables).find(table => table.table_id === "system_function");
      const row = list(table?.rows).find(row => String(row.scenario_id ?? row.scenario) === context.scenario && finite(row.function_ratio));
      if (row) summary.system_function_ratio = row.function_ratio;
    }
    const rows = recoveryRows(context);
    const days = rows.map(row => row.total_recovery_days).filter(finite).map(Number);
    const minDays = days.length ? Math.min(...days) : null;
    const has = skill => context.chapters.some(c => c.stage[0] === skill);
    const metricCards = [];
    if (finite(summary.system_function_ratio)) metricCards.push(`<article><span>${t("震后医疗服务功能", "Initial healthcare service function")}</span><strong>${percent(summary.system_function_ratio)}</strong><small>${t("相对震前 · 模型指标", "Relative to baseline · model index")}</small></article>`);
    if (finite(summary.coverage_ratio)) metricCards.push(`<article><span>${finite(serviceScenario?.service_radius_minutes) ? t(`${number(serviceScenario.service_radius_minutes, 2)} 分钟内可到院的人口`, `Population within ${number(serviceScenario.service_radius_minutes, 2)} min`) : t("规定时间内可到院的人口", "Population within the travel threshold")}</span><strong>${percent(summary.coverage_ratio)}</strong><small>${t("仅录入人口 · 到院不等于能够收治", "Input population · travel does not guarantee treatment")}</small></article>`);
    if (finite(minDays)) metricCards.push(`<article><span>${t("候选方案最短总恢复时间", "Shortest total recovery among candidates")}</span><strong>${number(minDays, 2)}<em>${t("天", "days")}</em></strong><small>${t("模拟样本均值 · 需按现场条件复核", "Simulation mean · verify against field conditions")}</small></article>`);
    if (!metricCards.length && has("hospital_damage_assessment")) {
      const damageRows = list(context.chapters.find(chapter => chapter.stage[0] === "hospital_damage_assessment")?.section.tables).find(table => table.table_id === "damage")?.rows || [];
      for (const [key, zh, en, probability] of [
        ["probability_any_damage", "单院最高发生损伤概率", "Highest individual hospital damage probability", true],
        ["probability_extensive_or_complete", "单院最高严重或毁坏概率", "Highest individual hospital extensive or complete damage probability", true],
        ["mean_repair_days", "单院最长平均修复时间", "Longest individual hospital mean repair time", false],
      ]) {
        const values = damageRows.map(row => row[key]).filter(finite);
        if (!values.length) continue;
        const value = Math.max(...values);
        metricCards.push(`<article><span>${t(zh, en)}</span><strong>${probability ? percent(value) : `${number(value, 2)}<em>${t("天", "days")}</em>`}</strong><small>${t("本情景所含医院比较 · 非系统恢复指标", "Hospitals within this scenario · not system recovery")}</small></article>`);
      }
    }
    const headline = displayText(context, decision?.headline) || (finite(summary.system_function_ratio)
      ? t(`区域医疗服务初始功能保留 ${percent(summary.system_function_ratio)}`, `Initial regional healthcare function retained: ${percent(summary.system_function_ratio)}`)
      : t("本轮评估结果已汇总", "This assessment's results are ready"));
    const conclusion = summaryText(context, summary);
    const priority = priorityItems(context);
    const figureCards = [];
    if (has("hospital_function_degradation")) figureCards.push(["overview-hospital", "震前与震后，医院能力差多少？", "Hospital capacity before and after", ["hospital-function-capacity"], "hospitals"]);
    else if (has("medical_system_function")) figureCards.push(["overview-service", "医疗服务发生了什么变化？", "How has healthcare service changed?", ["regional-function"], "service"]);
    else if (has("hospital_damage_assessment")) figureCards.push(["overview-damage", "哪些医院损伤更值得关注？", "Which hospital damage needs attention?", ["hospital-damage-repair"], "hospitals"]);
    else if (has("earthquake_scenario_interpretation")) figureCards.push(["overview-input", "本轮评估使用了哪些输入？", "Which inputs does this assessment use?", ["earthquake-preparation"], "evidence"]);
    if (has("recovery_optimization")) figureCards.push(["overview-recovery", "不同方案，恢复效果如何？", "How do recovery plans compare?", ["recovery-comparison"], "recovery"]);
    else if (has("medical_system_function") && !figureCards.some(card => card[4] === "service")) figureCards.push(["overview-service", "医疗服务发生了什么变化？", "How has healthcare service changed?", ["regional-function"], "service"]);
    const completeParagraphs = (list(decision?.paragraphs).length ? decision.paragraphs : decision?.summary ? String(decision.summary).split(/\n\s*\n/) : []).map(value => displayText(context, value));
    const hero = `<div class="reading-overview-grid"><section class="reading-overview-map" aria-label="${t("整体地图", "Assessment map")}"><div class="reading-block-heading reading-map-heading"><h3>${t("整体地图", "Assessment map")}</h3><span>${t("本轮评估范围", "Current assessment scope")}</span></div><div class="reading-overview-map-slot" data-reading-medical-map data-reading-overview-map></div></section><aside class="reading-overview-summary"><section class="reading-conclusion" aria-label="${t("总体结论", "Overall conclusion")}"><span class="reading-kicker">${t("总体结论", "OVERALL CONCLUSION")}</span><h3>${esc(headline)}</h3><p>${esc(conclusion)}</p></section><section class="reading-priorities" aria-label="${t("优先建议", "Priority actions")}"><div class="reading-block-heading"><h3>${t("建议先做什么", "Recommended next actions")}</h3><span>${t("展开看做法", "Expand for details")}</span></div>${priority.length ? recommendationList(context, priority, true) : `<p class="reading-muted">${t("本轮尚未形成可核验的工程建议。", "No verified engineering recommendations are available for this round.")}</p>`}</section></aside></div>
      ${metricCards.length ? `<section class="reading-key-metrics" aria-label="${t("核心结果指标", "Key result metrics")}">${metricCards.slice(0, 3).join("")}</section>` : ""}`;
    if (context.options.brief) return `${hero}<div class="reading-brief-links"><button type="button" class="reading-text-button" data-reading-open-topic="overview">${t("完整结论与建议", "Full conclusion & actions")} →</button>${context.topics.filter(topic => topic[0] !== "overview" && topic[0] !== "evidence").map(topic => `<button type="button" class="reading-text-button" data-reading-open-topic="${topic[0]}">${t(topic[1], topic[2])} →</button>`).join("")}<button type="button" class="reading-text-button" data-reading-open-topic="evidence">${t("数据与计算依据", "Data & calculation evidence")} →</button></div>`;
    return `${hero}
      <p class="reading-average-note">${t('总览中的服务功能和医院能力是本轮模拟平均结果；恢复地图演示某一次模拟，两者可能不同。点击医院或居民点，可联动查看对应明细。', 'Overview service function and hospital capacity are simulation averages. The recovery map shows one realization and may differ. Select a hospital or population area to inspect its linked details.')}</p>
      ${figureCards.length ? `<div class="reading-block-heading reading-comparison-heading"><h3>${t("逐项看影响与恢复", "Explore impact and recovery")}</h3><span>${t("看图了解变化，看表定位重点", "Read the figures, then identify priorities in the tables")}</span></div><div class="reading-comparison-grid">${figureCards.map((card, index) => `<section><header><h4><span class="reading-section-index">${String(index + 1).padStart(2, "0")}</span>${t(card[1], card[2])}</h4><button type="button" class="reading-text-button" data-reading-open-topic="${card[4]}">${t("查看详细分析", "Explore in detail")} →</button></header>${figureSlot(context, card[0], card[3])}${card[4] === "recovery" ? comparisonTable(context) : keyTable(context, card[4])}</section>`).join("")}</div>` : ""}
      ${completeParagraphs.length ? `<details class="reading-detail"><summary>${t("完整结论与解读", "Full conclusion and interpretation")}</summary>${completeParagraphs.map(text => `<p>${esc(text)}</p>`).join("")}${finite(summary.system_function_ratio) ? `<p>${t("医疗服务功能采用原模型逐样本截断均值，不等同于实际收治人数或无法就医人口比例。", "Healthcare function uses the original model's clipped per-sample mean. It is not an actual treatment or unmet-population count.")}</p>` : ""}</details>` : ""}
      ${list(decision?.recommendations).length > priority.length ? `<details class="reading-detail"><summary>${t(`查看全部 ${decision.recommendations.length} 条工程建议`, `All ${decision.recommendations.length} engineering recommendations`)}</summary>${recommendationList(context, decision.recommendations)}</details>` : ""}`;
  }
  function topicHTML(context, topic) {
    const t = context.t;
    const config = {
      hospitals: ["医院震后救治能力", "Post-earthquake hospital treatment capacity", "看清医院之间的差异，再确定需要核查和保障的对象。", "Compare hospitals to identify where checks and support are needed.", ["hospital_function_degradation", "hospital_damage_assessment"], ["hospital-function-capacity", "hospital-damage-repair", "severity-capacity"], "hospitals"],
      service: ["居民就医影响", "Impact on access to care", "结合地图与片区明细，查看居民能否及时到院，以及能够获得多少医疗服务。", "Use the map and area details to examine travel to hospitals and access to healthcare.", ["medical_system_function"], ["regional-function", "demand-accessibility"], "areas"],
      recovery: ["恢复方案对比", "Recovery plan comparison", "同时比较服务恢复过程和总工期，明确方案的收益与取舍。", "Compare recovery trajectories and total duration to assess trade-offs.", ["recovery_optimization"], ["recovery-comparison", "sample-schedule"], null],
    }[topic];
    const actions = list(context.decision?.recommendations).filter(item => config[4].includes(item.source_skill_id));
    const finding = topicFinding(context, config[4]);
    return `<header class="reading-topic-heading"><h3>${t(config[0], config[1])}</h3><p class="${finding ? "reading-topic-conclusion" : ""}">${esc(finding ? shortText(displayText(context, finding.observation)) : t(config[2], config[3]))}</p></header>
      ${topic === "recovery" ? `<p class="reading-average-note">${t('下方动画展示选中样本的逐日恢复，不是全部模拟的平均状态。方案对比表采用本轮模拟平均值，演示顺序不能直接当作现场抢修指令。', 'The animation shows daily recovery in one selected realization. The comparison table uses simulation averages; the illustrated order is not a field repair instruction.')}</p><div class="reading-recovery-playback-slot" data-reading-recovery-playback></div>${comparisonTable(context)}` : ""}
      ${topic === "service" ? `<div class="reading-medical-map-slot" data-reading-medical-map></div>${keyTable(context, topic)}${context.topics.some(item => item[0] === "recovery") ? `<div class="reading-recovery-link"><span>${t("想看医院逐日恢复后，医疗服务怎样变化？", "See how healthcare service changes as hospitals recover.")}</span><button type="button" data-reading-open-topic="recovery">▶ ${t("查看恢复过程", "View recovery playback")} →</button></div>` : ""}<div class="reading-block-heading reading-service-figures-heading"><h3>${t("居民片区服务变化", "Changes in population-area healthcare access")}</h3></div>` : ""}
      <div class="reading-analysis-chart">${figureSlot(context, `topic-${topic}`, config[5])}</div>
      ${topic === "hospitals" ? keyTable(context, topic) : ""}
      ${config[6] ? `<details class="reading-detail reading-query"><summary>${topic === "hospitals" ? t("查询完整医院名单与分伤情明细", "Explore all hospitals and injury severity") : t("查询全部居民片区", "Explore all population areas")}</summary>${servicePart(context, config[6])}</details>` : ""}
      <details class="reading-detail reading-explanation"><summary>${t("结果解释与计算依据", "Interpretation and calculation evidence")}</summary><div class="reading-explanation-content">${observations(context, config[4])}${topic === "service" ? `<div class="reading-service-notes">${list(context.serviceScenario?.findings).map(text => `<p>${esc(text)}</p>`).join("")}${list(context.serviceScenario?.recommendations).length ? `<h4>${t("医疗服务改进方向", "Service improvements")}</h4><ul>${context.serviceScenario.recommendations.map(text => `<li>${esc(text)}</li>`).join("")}</ul>` : ""}</div>` : ""}</div></details>
      ${actions.length ? `<section class="reading-topic-actions"><div class="reading-block-heading"><h3>${t("对应的工程行动", "Engineering actions")}</h3><span>${t("建议与本轮结果对应", "Actions based on this assessment")}</span></div>${recommendationList(context, actions)}</section>` : ""}
      <button type="button" class="reading-evidence" data-reading-open-topic="evidence">${t("查看原始数据与计算说明", "View source data and calculation notes")} →</button>`;
  }
  function evidenceHTML(context) {
    const { t, delivery, chapters, options } = context;
    const warnings = list(delivery.warnings).map(item => typeof item === "string" ? item : item.message).filter(Boolean);
    const limits = resultNotes([...new Set([...list(context.decision?.limitations), ...list(delivery.assumptions), ...warnings])]);
    const preparation = chapters.find(c => c.stage[0] === "earthquake_scenario_interpretation");
    return `<header class="reading-topic-heading"><h3>${t("评估范围与计算依据", "Assessment scope and calculation evidence")}</h3><p>${esc(delivery.decision_support?.basis || t("下列资料对应当前任务、轮次与情景。", "The data below belongs to the current task, round and scenario."))}</p></header>
      ${dataQualityHTML(context)}${knowledgeHTML(context)}
      ${preparation ? figureSlot(context, "evidence-input", ["earthquake-preparation"]) : ""}
      ${chapters.map(chapter => `<section class="reading-chapter" id="${chapter.id}" tabindex="-1"><h3>${esc(window.MedicalDisplayLabels?.skill(chapter.stage[0], options.language, t(chapter.stage[1], chapter.stage[2])) || t(chapter.stage[1], chapter.stage[2]))}</h3>${list(chapter.section.tables).map((table, index) => list(table.columns).length ? `<details id="${chapter.id}-table-${index}" class="reading-table-detail"><summary>${esc(table.title || table.table_id)}<span>${t(`${table.rows.length} 行`, `${table.rows.length} rows`)}</span></summary>${options.renderTable(table)}</details>` : "").join("")}${resultNotes(chapter.section.limitations).length ? `<details class="reading-detail"><summary>${t("本项计算说明", "Calculation notes for this step")}</summary><ul>${resultNotes(chapter.section.limitations).map(text => `<li>${esc(text)}</li>`).join("")}</ul></details>` : ""}</section>`).join("")}
      ${servicePart(context, "notes")}
      ${limits.length ? `<details class="reading-detail"><summary>${t("模型假设与使用说明", "Model assumptions and scope")}</summary><ul>${limits.map(text => `<li>${esc(text)}</li>`).join("")}</ul></details>` : ""}
      <details class="reading-detail"><summary>${t("本轮计算链路", "This round's computation chain")}</summary><ol>${list(delivery.executed_components).map(skill => `<li>${esc(options.skillName(skill))}</li>`).join("")}</ol></details>`;
  }
  function readingHeader({title, scopeText, iterations, options, ids=[], valid=true, scenario="", t, compact=false}) {
    return `<header class="reading-header${compact ? " is-compact" : ""}"><div><h2${compact ? ` class="reading-summary-title"` : ""}>${esc(title)}</h2><p>${esc(scopeText)}<span>${t("仅本次录入范围", "Input scope only")}</span></p></div><div class="reading-selectors">${iterations.length ? `<label>${t("轮次", "Round")}<select data-reading-iteration aria-label="${t("选择计算轮次", "Select assessment round")}">${iterations.map(item => `<option value="${esc(item.iteration)}" ${Number(item.iteration) === Number(options.iteration) ? "selected" : ""}>${t(`第 ${item.iteration} 轮`, `Round ${item.iteration}`)}</option>`).join("")}</select></label>` : ""}${ids.length ? `<label>${t("情景", "Scenario")}<select data-reading-scenario aria-label="${t("选择评估情景", "Select assessment scenario")}">${!valid ? `<option selected value="${esc(scenario)}">${esc(scenario)} · ${t("暂无结果", "unavailable")}</option>` : ""}${ids.map(id => `<option value="${esc(id)}" ${id === scenario ? "selected" : ""}>${esc(id)}</option>`).join("")}</select></label>` : ""}</div></header>`;
  }
  function contextNote(context) {
    const t = context.t;
    const scopeHTML = String(context.options.assessmentScopeHTML || "").trim();
    if (!scopeHTML) return "";
    const sourceDetails = scopeHTML.match(/^<details\b[^>]*>([\s\S]*)<\/details>$/i);
    const scopeSummary = (scopeHTML.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] || t("评估范围与模型说明", "Assessment scope and model notes")).replace(/\s*·\s*(查看说明|View notes)\s*$/i, "");
    const scopeBody = sourceDetails ? sourceDetails[1].replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/i, "") : scopeHTML;
    return `<details class="reading-context-note"><summary><span>${scopeSummary}</span><span class="reading-context-expand">${t("查看说明", "View notes")}</span></summary><div class="reading-context-body">${scopeBody}</div></details>`;
  }
  function readingNavigation(topics, t) {
    return `<nav class="reading-navigation" role="tablist" aria-label="${t("结果阅读主题", "Result topics")}">${topics.map(topic => `<button type="button" role="tab" id="reading-tab-${topic[0]}" data-reading-topic="${topic[0]}" aria-controls="reading-panel-${topic[0]}" aria-selected="${topic[0] === "overview"}" tabindex="${topic[0] === "overview" ? "0" : "-1"}">${t(topic[1], topic[2])}</button>`).join("")}</nav>`;
  }
  function render(context) {
    const { options, t, delivery, scenario } = context;
    const iterations = list(options.iterations), ids = scenarioIds(delivery);
    const valid = !scenario || ids.includes(scenario);
    const topics = availableTopics(context);
    context.topics = topics;
    if (options.brief) return `<article class="integrated-engineering-results is-brief" aria-label="${t("医疗评估地图与结论", "Healthcare assessment map and conclusion")}"><header class="reading-brief-header"><p>${esc(scope(context))}</p><span>${t(`第 ${options.iteration} 轮`, `Round ${options.iteration}`)}</span></header>${contextNote(context)}<section class="reading-panel" data-reading-panel="overview">${valid ? overviewHTML(context) : `<p class="reading-muted">${t("所选情景暂无已完成结果，请选择已有结果的情景。", "No completed results exist for this scenario. Choose a scenario with results.")}</p>`}</section></article>`;
    return `<article class="integrated-engineering-results" aria-label="${t("图文工程评估结果", "Illustrated engineering assessment")}">
      ${readingHeader({title:assessmentTitle(context), scopeText:scope(context), iterations, options, ids, valid, scenario, t, compact:true})}
      ${contextNote(context)}
      ${valid ? `${readingNavigation(topics, t)}${topics.map(topic => `<section class="reading-panel" data-reading-panel="${topic[0]}" id="reading-panel-${topic[0]}" role="tabpanel" aria-labelledby="reading-tab-${topic[0]}" tabindex="-1" ${topic[0] === "overview" ? "" : "hidden"}>${topic[0] === "overview" ? overviewHTML(context) : topic[0] === "evidence" ? evidenceHTML(context) : topicHTML(context, topic[0])}</section>`).join("")}` : `<section class="reading-empty"><h3>${t("所选情景暂无结果", "No results for this scenario")}</h3><p>${t(`所选情景 ${esc(scenario)} 暂无已完成结果，请选择已有结果的情景。`, `No completed results exist for ${esc(scenario)}. Choose an available scenario.`)}</p></section>`}
    </article>`;
  }
  function destroy(container) {
    if (!container) return;
    for (const slot of container.querySelectorAll("[data-reading-figures]")) window.PublicationGallery?.destroy(slot);
    for (const slot of container.querySelectorAll("[data-reading-medical-map], [data-reading-overview-map]")) window.MedicalMap?.destroy(slot);
    for (const slot of container.querySelectorAll("[data-reading-recovery-playback]")) window.RecoveryPlayback?.destroy(slot);
    mounts.delete(container);
  }
  function mount(container, options) {
    const t = translate(options.language), delivery = options.delivery;
    const ids = scenarioIds(delivery);
    const scenario = options.selectedScenario === null || options.selectedScenario === undefined ? ids[0] || "" : String(options.selectedScenario);
    const key = JSON.stringify([options.sessionId, options.iteration, options.language, scenario, Boolean(options.brief), options.sourceSignature, delivery, options.service]);
    const previous = mounts.get(container);
    if (previous?.key === key) {
      previous.options = options;
      previous.refreshVisible?.();
      return scenario;
    }
    const previousTopic = previous?.options.sessionId === options.sessionId ? previous.topic : null;
    destroy(container);
    const context = { key, options, t, delivery, scenario, service: options.service,
      serviceScenario: options.service?.status === "available" ? list(options.service.scenarios).find(s => String(s.scenario_id) === scenario) : null,
      decision: list(delivery.decision_support?.scenarios).find(s => String(s.scenario_id) === scenario),
      chapters: sectionsFor(delivery, scenario), figureSlots: new Map(), mountedSlots: new Set(), topic: "overview" };
    mounts.set(container, context);
    container.innerHTML = render(context);
    const root = container.querySelector(".integrated-engineering-results");
    function mountVisibleFigures() {
      const panel = root.querySelector(`[data-reading-panel="${context.topic}"]`);
      for (const slot of panel?.querySelectorAll("[data-reading-medical-map], [data-reading-overview-map]") || []) {
        if (window.MedicalMap) window.MedicalMap.mount(slot, { sessionId: context.options.sessionId, iteration: context.options.iteration, language: context.options.language, selectedScenario: scenario, sourceSignature: context.options.sourceSignature, compact: slot.hasAttribute("data-reading-overview-map"), selectedHospitalId: context.selection?.hospitalId, selectedNodeId: context.selection?.nodeId, pan: false, onDetails: detail => { context.selection = detail; const topic = context.topics.some(item => item[0] === "service") ? "service" : context.topics.some(item => item[0] === "hospitals") ? "hospitals" : "evidence"; if (context.options.brief) context.options.onOpenTopic?.(topic, detail); else selectTopic(topic, true); } });
        else slot.innerHTML = `<p class="reading-muted">${t("地图组件暂时未加载，请刷新页面重试。", "The map component has not loaded. Refresh the page to retry.")}</p>`;
      }
      for (const slot of panel?.querySelectorAll("[data-reading-recovery-playback]") || []) {
        if (window.RecoveryPlayback) window.RecoveryPlayback.mount(slot, { sessionId: context.options.sessionId, iteration: context.options.iteration, language: context.options.language, selectedScenario: scenario, sourceSignature: context.options.sourceSignature, selectedHospitalId: context.selection?.hospitalId, selectedNodeId: context.selection?.nodeId });
        else slot.innerHTML = `<p class="reading-muted">${t("动态回放组件暂时未加载，请刷新页面重试。", "The playback component has not loaded. Refresh the page to retry.")}</p>`;
      }
      for (const slot of panel?.querySelectorAll("[data-reading-figures]") || []) {
        if (context.mountedSlots.has(slot)) continue;
        if (!window.PublicationGallery) { slot.innerHTML = `<p class="reading-muted">${t("图表组件暂时未加载，请刷新页面重试。", "The figure component has not loaded. Refresh the page to retry.")}</p>`; continue; }
        context.mountedSlots.add(slot);
        window.PublicationGallery.mountInline(slot, { sessionId: context.options.sessionId, iteration: context.options.iteration, language: context.options.language, selectedScenario: scenario, templateIds: context.figureSlots.get(slot.dataset.readingFigures), sourceSignature: context.options.sourceSignature });
      }
    }
    context.refreshVisible = mountVisibleFigures;
    function selectTopic(topic, focus = false) {
      if (!context.topics.some(item => item[0] === topic)) return;
      if (context.options.brief && topic !== "overview") { context.options.onOpenTopic?.(topic); return; }
      context.topic = topic;
      if (topic !== "recovery") for (const slot of container.querySelectorAll("[data-reading-recovery-playback]")) window.RecoveryPlayback?.pause(slot);
      for (const panel of root.querySelectorAll("[data-reading-panel]")) panel.hidden = panel.dataset.readingPanel !== topic;
      for (const button of root.querySelectorAll("[data-reading-topic]")) {
        const selected = button.dataset.readingTopic === topic;
        button.setAttribute("aria-selected", String(selected)); button.tabIndex = selected ? 0 : -1;
        if (selected && focus) button.focus({ preventScroll: true });
      }
      mountVisibleFigures();
      if (focus) root.querySelector(`[data-reading-panel="${topic}"]`)?.scrollIntoView({ block: "start", behavior: "auto" });
    }
    context.openTopic = (topic, selection) => {
      if (selection && (!selection.scenarioId || String(selection.scenarioId) === scenario)) context.selection = selection;
      selectTopic(topic, true);
      return context.topic === topic;
    };
    function openSelectedDetails() {
      const topic = context.topics.some(item => item[0] === 'service') ? 'service' : 'hospitals';
      selectTopic(topic, true);
      const query = root.querySelector(`[data-reading-panel="${topic}"] .reading-query`);
      if (query) { query.open = true; query.scrollIntoView?.({ block: 'nearest', behavior: 'auto' }); }
    }
    function focusMap(selection) {
      context.selection = selection;
      selectTopic(context.topics.some(item => item[0] === "service") ? "service" : "overview", true);
      const panel = root.querySelector(`[data-reading-panel="${context.topic}"]`);
      for (const slot of panel?.querySelectorAll("[data-reading-medical-map]") || []) window.MedicalMap?.select(slot, { ...selection, pan: true });
    }
    root.addEventListener("medical-map-focus", event => {
      event.stopPropagation();
      focusMap(event.detail || {});
    });
    root.addEventListener("medical-map-selection", event => {
      if (context.syncingSelection) return;
      context.selection = event.detail || null;
      context.syncingSelection = true;
      try {
        for (const slot of root.querySelectorAll('[data-reading-medical-map], [data-reading-overview-map]')) if (slot !== event.target) window.MedicalMap?.select(slot, { ...context.selection, pan: false });
        for (const slot of root.querySelectorAll('[data-reading-recovery-playback]')) if (slot !== event.target) window.RecoveryPlayback?.select?.(slot, { ...context.selection, pan: false });
        window.MedicalServiceView?.focusSelection?.(root, context.service, scenario, options.language, context.selection);
        const selectedNode = list(context.serviceScenario?.demand_nodes).find(row => String(row.node_id) === String(context.selection?.nodeId));
        const selectedHospital = list(context.serviceScenario?.hospitals).find(row => String(row.hospital_id) === String(context.selection?.hospitalId));
        for (const slot of root.querySelectorAll('[data-reading-medical-map]')) {
          let notice = slot.parentElement.querySelector('[data-reading-linked-status]');
          if (!notice) { notice = document.createElement('p'); notice.dataset.readingLinkedStatus = ''; notice.className = 'reading-average-note'; slot.after(notice); }
          notice.hidden = !selectedNode && !selectedHospital;
          if (!notice.hidden) notice.innerHTML = `${t('已选择', 'Selected')}: ${esc(selectedNode?.node_name || selectedNode?.node_id || selectedHospital?.hospital_name || selectedHospital?.hospital_id)}。${t('下方完整名单已按此对象筛选，重点对比表仍展示本轮总体薄弱对象。', 'The full list below is filtered by this record; priority tables retain the overall assessment scope.')} <button type="button" class="reading-text-button" data-reading-selected-details>${t('查看对应明细', 'View linked details')} →</button>`;
        }
      } finally { context.syncingSelection = false; }
      for (const button of root.querySelectorAll("[data-reading-hospital], [data-reading-node], [data-medical-select-hospital], [data-medical-select-node]")) {
        const hospitalId = button.dataset.readingHospital ?? button.dataset.medicalSelectHospital;
        const nodeId = button.dataset.readingNode ?? button.dataset.medicalSelectNode;
        const selected = hospitalId !== undefined ? String(hospitalId) === String(context.selection?.hospitalId) : nodeId !== undefined && String(nodeId) === String(context.selection?.nodeId);
        button.closest("tr, .medical-service-hospital")?.classList.toggle("is-map-selected", selected);
        if (selected) button.setAttribute("aria-current", "true"); else button.removeAttribute("aria-current");
      }
    });
    root.addEventListener("change", event => {
      if (event.target.matches("[data-reading-scenario]")) context.options.onScenarioChange?.(event.target.value);
      if (event.target.matches("[data-reading-iteration]")) context.options.onIterationChange?.(Number(event.target.value));
    });
    root.addEventListener("keydown", event => {
      if (!event.target.matches("[data-reading-topic]")) return;
      const index = context.topics.findIndex(item => item[0] === context.topic);
      const next = { ArrowRight: (index + 1) % context.topics.length, ArrowLeft: (index - 1 + context.topics.length) % context.topics.length, Home: 0, End: context.topics.length - 1 }[event.key];
      if (next !== undefined) { event.preventDefault(); selectTopic(context.topics[next][0], true); }
    });
    root.addEventListener("click", event => {
      if (event.target.closest('[data-reading-selected-details]')) { openSelectedDetails(); return; }
      const topicButton = event.target.closest("[data-reading-topic], [data-reading-open-topic]");
      if (topicButton) {
        const topic = topicButton.dataset.readingTopic || topicButton.dataset.readingOpenTopic;
        if (context.options.brief) context.options.onOpenTopic?.(topic);
        else selectTopic(topic, true);
        return;
      }
      const object = event.target.closest("[data-reading-hospital], [data-reading-node]");
      if (object) {
        focusMap({ hospitalId: object.dataset.readingHospital ?? null, nodeId: object.dataset.readingNode ?? null });
        return;
      }
      const button = event.target.closest("[data-reading-jump]");
      if (!button) return;
      if (context.options.brief) { context.options.onOpenTopic?.("evidence"); return; }
      const target = Array.from(root.querySelectorAll("[id]")).find(item => item.id === button.dataset.readingJump);
      if (!target) return;
      selectTopic("evidence");
      for (let parent = target; parent && parent !== root; parent = parent.parentElement) if (parent.tagName === "DETAILS") parent.open = true;
      target.scrollIntoView({ block: "start", behavior: "auto" });
      (target.tagName === "DETAILS" ? target.querySelector("summary") : target)?.focus({ preventScroll: true });
    });
    window.MedicalServiceView?.bindParts(container, context.service, scenario, options.language);
    selectTopic(!options.brief && context.topics.some(item => item[0] === previousTopic) ? previousTopic : "overview");
    return scenario;
  }
  const mountBrief = (container, options) => mount(container, { ...options, brief: true });
  const openTopic = (container, topic, selection) => mounts.get(container)?.openTopic?.(topic, selection) || false;
  window.IntegratedResultsView = Object.freeze({ mount, mountBrief, openTopic, destroy, scenarioIds, readingHeader, readingNavigation });
})();
