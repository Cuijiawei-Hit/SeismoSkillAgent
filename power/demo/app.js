"use strict";

const LANGUAGE_STORAGE_KEY = "power-skill-agent.language.v2";

const app = {
  health: null,
  healthError: false,
  sessions: [],
  current: null,
  preset: "quick",
  activeTab: "conversation",
  pollTimer: null,
  selectedScenario: null,
  primaryArtifactIndex: null,
  spatialCategory: "all",
  selectedIteration: null,
  autoFollowLatestIteration: true,
  reviewDraft: null,
  reviewOriginal: null,
  reviewTargets: null,
  reviewTargetsOriginal: null,
  reviewKey: null,
  expertMemoryRenderKey: null,
  expertMemoryRequests: new Set(),
  figureZoom: 1,
  pendingDeleteSessionId: null,
  deletingSession: false,
  observations: [],
  observationFilename: "",
  language: localStorage.getItem(LANGUAGE_STORAGE_KEY) === "zh-CN" ? "zh-CN" : "en-US",
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const elements = {
  emptyWorkspace: $("#empty-workspace"),
  sessionWorkspace: $("#session-workspace"),
  sessionList: $("#session-list"),
  sessionCount: $("#session-count"),
  taskInput: $("#task-input"),
  submitTask: $("#submit-task"),
  suggestionList: $("#suggestion-list"),
  parameterToggle: $("#parameter-toggle"),
  parameterDrawer: $("#parameter-drawer"),
  newSession: $("#new-session"),
  sessionToggle: $("#session-toggle"),
  closeSessions: $("#close-sessions"),
  drawerBackdrop: $("#drawer-backdrop"),
  sessionRail: $(".session-rail"),
  inspector: $("#inspector"),
  inspectorResizer: $("#inspector-resizer"),
  inspectorExpand: $("#inspector-expand"),
  inspectorContent: $("#inspector-content"),
  inspectorToggle: $("#inspector-toggle"),
  closeInspector: $("#close-inspector"),
  connectionDot: $("#connection-dot"),
  connectionLabel: $("#connection-label"),
  modelLabel: $("#model-label"),
  sessionIdLabel: $("#session-id-label"),
  sessionTitle: $("#session-title"),
  sessionStatus: $("#session-status"),
  conversation: $("#conversation-stream"),
  results: $("#results-content"),
  spatial: $("#spatial-content"),
  artifacts: $("#artifacts-content"),
  audit: $("#audit-content"),
  toastRegion: $("#toast-region"),
  figureLightbox: $("#figure-lightbox"),
  figureLightboxTitle: $("#figure-lightbox-title"),
  figureLightboxImage: $("#figure-lightbox-image"),
  figureLightboxStage: $("#figure-lightbox-stage"),
  figureZoomLevel: $("#figure-zoom-level"),
  figureZoomIn: $("#figure-zoom-in"),
  figureZoomOut: $("#figure-zoom-out"),
  figureZoomReset: $("#figure-zoom-reset"),
  figureLightboxClose: $("#figure-lightbox-close"),
  deleteSessionDialog: $("#delete-session-dialog"),
  deleteSessionName: $("#delete-session-name"),
  deleteSessionCancel: $("#delete-session-cancel"),
  deleteSessionConfirm: $("#delete-session-confirm"),
  languageSwitch: $("#language-switch"),
};

const translations = {
  calculation_profile: ["计算版本", "Calculation profile"],
  legacy_ms_profile: ["原模型 + 中重伤修正", "Original models + moderate/severe correction"],
  constrained_profile: ["共享资源约束 v2", "Shared-resource constraints v2"],
  legacy_profile: ["旧版复现 v1", "Legacy reproduction v1"],
  treatment_parameters: ["救治资源与参数依据", "Treatment resources and evidence"],
  treatment_step: ["救治时间步长（小时）", "Treatment time step (h)"],
  survival_policy: ["生存曲线处理", "Survival-curve policy"],
  conservative_survival: ["保守不增包络", "Conservative nonincreasing envelope"],
  strict_survival: ["严格校验原曲线", "Strict original-curve validation"],
  pre_transport_delay: ["转运前延迟（小时）", "Pre-transport delay (h)"],
  treatment_contract: ["资源需求、占用时间与来源（JSON）", "Requirements, occupancy times and evidence (JSON)"],
  decision_preferences: ["恢复目标与专家偏好", "Recovery objectives and expert preferences"],
  resilience_weight: ["韧性权重", "Resilience weight"],
  duration_weight: ["工期权重", "Duration weight"],
  cost_weight: ["费用权重", "Cost weight"],
  risk_weight: ["低尾风险权重", "Lower-tail risk weight"],
  duration_reference: ["工期归一化基准（天）", "Duration reference (days)"],
  first_hospital: ["必须首先进场的医院", "Required first hospital"],
  no_priority_constraint: ["不指定", "Unconstrained"],
  daily_team_cost: ["每队每日费用", "Daily cost per team"],
  cost_reference: ["费用归一化基准", "Cost reference"],
  cost_unit: ["费用单位", "Cost unit"],
  cost_source: ["费用依据", "Cost evidence"],
  observed_inputs: ["事件观测与现场数据", "Event observations and field data"],
  import_observations: ["导入观测 JSON", "Import observation JSON"],
  clear_observations: ["清除观测", "Clear observations"],
  no_observation_packet: ["未载入观测包", "No observation packet loaded"],
  page_title: ["PowerSkillAgent | 城市工程系统抗震韧性决策工作台", "PowerSkillAgent | Urban Engineering Seismic Resilience Workbench"],
  brand_subtitle: ["城市工程系统抗震韧性决策工作台", "Urban Engineering Seismic Resilience Workbench"],
  single_center: ["单决策中枢", "Single decision center"],
  task_history: ["任务记录", "Task history"],
  execution_review: ["执行审查", "Execution review"],
  new_task: ["新建任务", "New task"],
  no_runs: ["当前还没有运行记录", "No task runs yet"],
  task_management: ["任务管理", "Task management"],
  delete_task: ["删除任务", "Delete task"],
  delete_task_title: ["永久删除这项任务？", "Permanently delete this task?"],
  delete_task_description: ["删除后将移除任务记录、状态快照以及该任务生成的报告和图表。", "This removes the task record, state snapshots, and reports and figures generated by this task."],
  delete_task_warning: ["此操作无法撤销，但不会影响其他任务和共享知识库。", "This action cannot be undone. Other tasks and the shared knowledge base are not affected."],
  cancel: ["取消", "Cancel"],
  delete_permanently: ["永久删除", "Delete permanently"],
  approval_required: ["所有工程计算均需人工批准", "Every engineering computation requires human approval"],
  human_in_loop: ["专家参与决策", "Human-in-the-loop"],
  case_domain: ["案例域", "Case area"],
  yangpu: ["上海市杨浦区", "Yangpu District, Shanghai"],
  engineering_system: ["工程系统", "Engineering system"],
  regional_healthcare: ["区域医疗", "Regional healthcare"],
  analysis_objects: ["分析对象", "Analysis objects"],
  seven_hospitals: ["7家医院", "7 hospitals"],
  assessment_mode: ["评估模式", "Assessment mode"],
  new_assessment: ["新建工程评估任务", "New engineering assessment"],
  task_prompt_heading: ["向智能体描述需要评估或决策的问题", "Describe the engineering question or decision task"],
  task_prompt_body: ["智能体先理解任务并检索知识，再给出可审核的工程技能执行方案；计算后由专家接受结果或反馈修订并重算。", "The agent understands the task, retrieves evidence, and proposes a reviewable Engineering Skills plan. Experts then accept the result or revise constraints and rerun the analysis."],
  task_understanding: ["任务理解", "Task understanding"],
  task_understanding_detail: ["提取对象、情景与输出", "Extract objects, scenarios, and outputs"],
  knowledge_retrieval: ["知识检索", "Knowledge retrieval"],
  knowledge_retrieval_detail: ["匹配规范、论文与案例", "Match standards, papers, and cases"],
  plan_review: ["方案审核", "Plan review"],
  plan_review_detail: ["核验参数与工程能力链", "Verify parameters and the Skill chain"],
  analysis_computation: ["分析与计算", "Analysis and computation"],
  analysis_computation_detail: ["运行经校验的工程能力组合", "Run the validated Engineering Skills DAG"],
  review_loop: ["结果审查闭环", "Result review loop"],
  review_loop_detail: ["接受、修订、重算与对比", "Accept, revise, rerun, and compare"],
  case_label: ["上海市杨浦区 · 区域医疗系统", "Yangpu District, Shanghai · Regional healthcare system"],
  default_task_title: ["抗震韧性评估任务", "Seismic resilience assessment"],
  tab_conversation: ["协同对话", "Collaborative dialog"],
  tab_results: ["工程结果", "Engineering results"],
  tab_spatial: ["空间分析", "Spatial analysis"],
  tab_artifacts: ["报告与文件", "Reports and files"],
  tab_audit: ["运行审计", "Run audit"],
  quick_run: ["原数据试算", "Baseline quick run"],
  formal_run: ["原数据正式计算", "Baseline formal run"],
  yangpu_updated_run: ["杨浦更新版", "Updated Yangpu"],
  parameter_settings: ["参数设置", "Parameters"],
  earthquake_scenarios: ["地震情景（PGA/g）", "Earthquake scenarios (PGA/g)"],
  scenario_placeholder: ["留空=全部；0.4 或 0.1-0.4", "Blank=all; 0.4 or 0.1-0.4"],
  updated_scenario_placeholder: ["未指定时采用 0.4g", "Defaults to 0.4g"],
  mcs_samples: ["MCS 样本", "MCS samples"],
  random_seed: ["随机种子", "Random seed"],
  team_count: ["工程队数量", "Repair teams"],
  control_horizon: ["控制期（天）", "Control horizon (days)"],
  service_radius: ["服务半径（分钟）", "Service radius (minutes)"],
  treatment_horizon: ["救治预测上限（小时）", "Treatment forecast horizon (hours)"],
  task_placeholder: ["例如：评估奥克兰电网在0.4g情景下的供电与韧性，比较修复策略，并给出地图和报告……", "Example: Assess Auckland grid supply and resilience at 0.4g, compare repair strategies, and provide maps and a report..."],
  send_task: ["发送任务", "Send task"],
  send_hint: ["Enter 发送，Shift + Enter 换行", "Enter to send, Shift + Enter for a new line"],
  data_source_note: ["上海案例数据绑定 · 工程参数仍须专家核验", "Shanghai case data bound · Engineering parameters require expert verification"],
  waiting_for_task: ["等待任务输入", "Waiting for a task"],
  waiting_for_task_detail: ["任务理解、知识依据、执行方案和工程校验将在这里逐步展开。", "Task understanding, evidence, the Skill plan, and engineering validation will appear here."],
  engineering_figure: ["工程图件", "Engineering figure"],
  engineering_figure_label: ["工程图件", "Engineering figure"],
  decision_trace: ["决策轨迹", "Decision trace"],
  mode_hybrid: ["混合评估", "Hybrid"],
  mode_predictive: ["预测评估", "Predictive"],
  mode_rapid: ["快速评估", "Rapid"],
  runtime_config: ["运行配置", "Runtime configuration"],
  connecting: ["正在连接", "Connecting"],
  open_task_history: ["打开任务记录", "Open task history"],
  open_execution_review: ["打开执行审查", "Open execution review"],
  close_task_history: ["关闭任务记录", "Close task history"],
  sample_questions: ["示例问题", "Sample questions"],
  decision_process: ["决策流程", "Decision process"],
  workspace_views: ["工作区视图", "Workspace views"],
  task_input: ["任务输入", "Task input"],
  computation_scale: ["计算规模", "Computation scale"],
  inspector_resize: ["调整执行审查面板宽度", "Resize the execution-review panel"],
  inspector_resize_title: ["拖动调整执行审查宽度，双击恢复默认", "Drag to resize the review panel; double-click to restore the default"],
  close_execution_review: ["关闭执行审查", "Close execution review"],
  figure_zoom_tools: ["图件缩放工具", "Figure zoom controls"],
  zoom_out: ["缩小图件", "Zoom out"],
  zoom_in: ["放大图件", "Zoom in"],
  zoom_reset: ["恢复图件大小", "Reset figure size"],
  close_figure: ["关闭图件", "Close figure"],
  close_sidebar: ["关闭侧栏", "Close sidebar"],
  ready: ["准备中", "Ready"],
};

function tr(zh, en) {
  return app.language === "en-US" ? en : zh;
}

function i18n(key) {
  const pair = translations[key];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : key;
}

function localizedAPIPath(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}language=${encodeURIComponent(app.language)}`;
}

function applyLanguage() {
  document.documentElement.lang = app.language === "en-US" ? "en" : "zh-CN";
  window.ReferencePowerLanguage?.setLanguage(app.language, Object.values(translations));
  $$('[data-i18n]').forEach((node) => { node.textContent = i18n(node.dataset.i18n); });
  $$('[data-i18n-placeholder]').forEach((node) => { node.placeholder = i18n(node.dataset.i18nPlaceholder); });
  $$('[data-i18n-aria-label]').forEach((node) => { node.setAttribute("aria-label", i18n(node.dataset.i18nAriaLabel)); });
  $$('[data-i18n-title]').forEach((node) => { node.title = i18n(node.dataset.i18nTitle); });
  $$('[data-language]', elements.languageSwitch).forEach((button) => button.classList.toggle("active", button.dataset.language === app.language));
  const chineseLanguageButton = $('[data-language="zh-CN"]', elements.languageSwitch);
  if (chineseLanguageButton) {
    chineseLanguageButton.textContent = app.language === "en-US" ? "ZH" : "中文";
    chineseLanguageButton.setAttribute("aria-label", app.language === "en-US" ? "Switch to Chinese" : "切换为中文");
  }
  elements.sessionToggle.title = tr("任务记录", "Task history");
  elements.inspectorToggle.title = tr("执行审查", "Execution review");
  elements.submitTask.title = tr("发送任务", "Send task");
  elements.inspectorExpand.setAttribute("aria-label", elements.inspectorExpand.classList.contains("expanded")
    ? tr("还原执行审查面板宽度", "Restore review-panel width")
    : tr("展开执行审查面板", "Expand review panel"));
  elements.inspectorExpand.title = elements.inspectorExpand.getAttribute("aria-label");
}

async function setLanguage(language) {
  app.language = language === "en-US" ? "en-US" : "zh-CN";
  localStorage.setItem(LANGUAGE_STORAGE_KEY, app.language);
  applyLanguage();
  renderConnectionStatus();
  renderSuggestions();
  const sessionId = app.current?.session_id;
  await refreshSessionList();
  if (sessionId) {
    try {
      const data = await api(localizedAPIPath(`/api/sessions/${sessionId}`));
      if (app.current?.session_id === sessionId) showSession(data);
    } catch (error) {
      toast(error.message, "error");
    }
  } else {
    showEmpty();
  }
  hydrateIcons();
}

function renderConnectionStatus() {
  if (app.health) {
    const configured = Boolean(app.health.api_key_configured);
    elements.connectionDot.className = `status-dot ${configured ? "online" : "offline"}`;
    elements.connectionLabel.textContent = configured
      ? tr("服务正常", "Service online")
      : tr("模型未配置", "Model not configured");
    elements.modelLabel.textContent = app.health.model;
    return;
  }
  if (app.healthError) {
    elements.connectionDot.className = "status-dot offline";
    elements.connectionLabel.textContent = tr("服务不可用", "Service unavailable");
  }
}

const statusLabels = {
  received: ["任务已接收", "Task received"],
  analyzing: ["正在分析任务", "Analyzing task"],
  analyzed: ["任务理解完成", "Task understood"],
  planned: ["计划已生成", "Plan generated"],
  revalidating: ["正在重新校验", "Revalidating"],
  processing_feedback: ["正在处理专家反馈", "Processing expert feedback"],
  recovering: ["正在恢复会话", "Recovering session"],
  finalizing: ["正在确认最终结果", "Finalizing result"],
  answering: ["正在回答结果追问", "Answering follow-up"],
  needs_input: ["等待参数修改", "Waiting for parameter revision"],
  awaiting_approval: ["等待人工批准", "Waiting for human approval"],
  executing: ["正在分析与计算", "Executing Skills"],
  awaiting_result_review: ["等待结果审查", "Waiting for result review"],
  awaiting_recovery: ["等待异常恢复决策", "Waiting for recovery decision"],
  succeeded: ["处理完成", "Completed"],
  rejected: ["计划已拒绝", "Plan rejected"],
  failed: ["运行失败", "Run failed"],
};

function statusLabel(status) {
  const pair = statusLabels[status];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : status;
}

const nonDeletableStatuses = new Set([
  "received", "analyzing", "analyzed", "planned", "revalidating",
  "processing_feedback", "recovering", "finalizing", "answering", "executing",
]);

function sessionIsBusy(session) {
  return nonDeletableStatuses.has(session?.status);
}

const skillNames = {
  "power_system.input_preparation": ["电网与地震输入准备", "Grid and earthquake input preparation"],
  "power_system.damage_assessment": ["设备与线路损伤评估", "Asset and line damage assessment"],
  "power_system.function_assessment": ["供电功率与系统功能评估", "Electricity supply and functionality"],
  "power_system.recovery_assessment": ["原模型基础恢复评估", "Original-model basic restoration"],
  "power_system.recovery_optimization": ["有限工程队恢复优化", "Finite-crew restoration optimization"],
  "power_system.resilience_assessment": ["电力系统韧性评价", "Electricity-system resilience"],
  "power_system.outage_impact": ["停电范围与人口影响评估", "Outage footprint and population impact"],
  "power_system.result_reporting": ["电力系统完整评估报告", "Complete electricity assessment report"],
  earthquake_scenario_interpretation: ["数据与地震情景准备", "Data and earthquake scenario preparation"],
  seismic_hazard_demand_analysis: ["地震危险性与工程需求", "Seismic hazard and engineering demand"],
  hospital_damage_assessment: ["医疗建筑损伤评估", "Hospital damage assessment"],
  hospital_function_degradation: ["医院功能退化", "Hospital functionality degradation"],
  road_accessibility_analysis: ["道路与医疗可达性", "Road and medical accessibility"],
  casualty_dispatch_treatment: ["伤员分派与救治", "Casualty dispatch and treatment"],
  medical_system_function: ["区域医疗系统功能", "Regional healthcare system functionality"],
  recovery_optimization: ["恢复策略优化", "Recovery strategy optimization"],
  resilience_quantification: ["韧性指标量化", "Resilience quantification"],
  resilience_result_reporting: ["结果解释与报告", "Result interpretation and reporting"],
  skill_registry_dynamic_composition: ["工程能力动态组合", "Registry dynamic Skill composition"],
};

function skillName(skillId) {
  const pair = skillNames[skillId];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : skillId;
}

const strategyNames = {
  importance: ["重要性排序", "Criticality ranking"],
  importance_ranking: ["重要性排序", "Criticality ranking"],
  baseline: ["重要性排序", "Criticality ranking"],
  sample_ga: ["逐样本遗传算法", "Sample-wise GA"],
  per_sample_ga: ["逐样本遗传算法", "Sample-wise GA"],
  robust_ga: ["稳健遗传算法", "Robust GA"],
};

function strategyName(value) {
  const pair = strategyNames[String(value || "").toLowerCase()];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : value;
}

function assessmentModeName(value) {
  const labels = {
    hybrid: ["混合评估", "Hybrid"],
    predictive: ["显式PGA电力情景", "Explicit-PGA power scenario"],
    rapid: ["快速评估", "Rapid"],
  };
  const pair = labels[String(value || "").toLowerCase()];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : value || "—";
}

function resilienceLevelName(value) {
  const labels = {
    "一级": ["一级", "Level I"],
    "二级": ["二级", "Level II"],
    "三级": ["三级", "Level III"],
    "未分级": ["未分级", "Not graded"],
    "未评级": ["未评级", "Not rated"],
  };
  const pair = labels[String(value || "")];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : value || tr("未评级", "Not rated");
}

function compositionModeName(value) {
  if (app.language === "en-US") return value || "single";
  return String(value || "single").toLowerCase() === "single" ? "单项能力" : "多能力依赖组合";
}

function localizedMissingInformation(value) {
  if (app.language === "en-US") return value;
  const replacements = {
    road_accessibility_analysis: "道路与医疗可达性分析",
    resilience_quantification: "韧性指标量化",
    resilience_result_reporting: "结果解释与报告",
    decay_model: "衰减模型",
    recovery_threshold: "恢复阈值",
    grading_model: "等级评定模型",
    knowledge_evidence: "知识依据",
  };
  return Object.entries(replacements).reduce((text, [source, target]) => text.replaceAll(source, target), String(value || ""));
}

function decisionActionName(value) {
  const labels = {
    pending: ["待审查", "Pending review"],
    approve: ["已批准", "Approved"],
    accept: ["已接受", "Accepted"],
    edit: ["已修改", "Edited"],
    revise: ["要求重算", "Revision requested"],
    retry: ["已重试", "Retried"],
    reject: ["已拒绝", "Rejected"],
  };
  const pair = labels[value];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : value;
}

function reviewFields() {
  return [
    ["assessment_mode", tr("评估方式", "Assessment method"), "readonly"],
    ["pga_g", tr("显式地震输入 PGA / g", "Explicit earthquake input PGA / g"), "number"],
    ["node_pga_g", tr("逐节点PGA / g（如有）", "Node-specific PGA / g, if supplied"), "json"],
    ["power_damage_mode", tr("损伤情景模式", "Damage scenario mode"), "select", ["most_likely", "sampled"]],
    ["seed", tr("随机种子", "Random seed"), "number"],
    ["team_count", tr("工程队数量", "Repair teams"), "number"],
    ["daily_work_hours", tr("每日工时 / h", "Daily working hours / h"), "number"],
    ["team_efficiency", tr("工程队效率", "Crew efficiency"), "number"],
    ["target_function", tr("目标供电比例", "Target supply ratio"), "number"],
    ["repair_objective", tr("恢复优化目标", "Recovery optimization objective"), "select", ["function_loss_area", "target_time"]],
    ["ga_population", tr("GA 种群", "GA population"), "number"],
    ["ga_generations", tr("GA 代数", "GA generations"), "number"],
    ["repair_constraints", tr("施工先后、最早开工与可用队伍约束", "Repair predecessors, release times and allowed crews"), "json"],
  ];
}

const stageIcons = {
  task_analysis: "scan-text",
  knowledge_retrieval: "library-big",
  knowledge_answer: "message-square-text",
  execution_plan: "workflow",
  plan_validation: "shield-check",
  human_review: "user-round-check",
  skill_execution_finished: "cpu",
  iteration_interpretation: "file-chart-column",
  result_review: "messages-square",
  final_acceptance: "badge-check",
};

const inspectorSizing = {
  storageKey: "seismo-skill-agent.inspector-width.v3",
  defaultRatio: 0.27,
  minWidth: 320,
  minimumWorkspaceWidth: 560,
  desktopBreakpoint: 980,
  keyboardStep: 24,
};

function defaultInspectorWidth() {
  return Math.round(Math.min(430, Math.max(inspectorSizing.minWidth, window.innerWidth * inspectorSizing.defaultRatio)));
}

function inspectorWidthLimit() {
  const shellWidth = document.querySelector(".app-shell")?.getBoundingClientRect().width || window.innerWidth;
  const railWidth = elements.sessionRail?.getBoundingClientRect().width || 0;
  const resizerWidth = elements.inspectorResizer?.getBoundingClientRect().width || 14;
  return Math.max(
    inspectorSizing.minWidth,
    shellWidth - railWidth - resizerWidth - inspectorSizing.minimumWorkspaceWidth,
  );
}

function applyInspectorWidth(width, { persist = false } = {}) {
  if (window.innerWidth <= inspectorSizing.desktopBreakpoint) return;
  const maximum = inspectorWidthLimit();
  const nextWidth = Math.round(Math.min(maximum, Math.max(inspectorSizing.minWidth, Number(width) || defaultInspectorWidth())));
  document.documentElement.style.setProperty("--inspector-width", `${nextWidth}px`);
  scheduleReferenceResize();
  elements.inspectorResizer.setAttribute("aria-valuemin", String(inspectorSizing.minWidth));
  elements.inspectorResizer.setAttribute("aria-valuemax", String(Math.round(maximum)));
  elements.inspectorResizer.setAttribute("aria-valuenow", String(nextWidth));
  const expanded = nextWidth >= Math.round(maximum) - 1;
  elements.inspectorExpand.classList.toggle("expanded", expanded);
  elements.inspectorExpand.setAttribute("aria-pressed", String(expanded));
  elements.inspectorExpand.setAttribute("aria-label", expanded
    ? tr("还原执行审查面板宽度", "Restore review-panel width")
    : tr("展开执行审查面板", "Expand review panel"));
  elements.inspectorExpand.title = elements.inspectorExpand.getAttribute("aria-label");
  if (persist) localStorage.setItem(inspectorSizing.storageKey, String(nextWidth));
}

let referenceResizeFrame = null;
function scheduleReferenceResize() {
  if (referenceResizeFrame !== null) return;
  referenceResizeFrame = requestAnimationFrame(() => {
    referenceResizeFrame = null;
    if (window.ReferencePowerMaps) {
      window.ReferencePowerMaps.resize(elements.results);
      window.ReferencePowerMaps.resize(elements.spatial);
    } else {
      window.ReferencePowerResults?.resize?.(elements.results);
      window.ReferencePowerResults?.resize?.(elements.spatial);
    }
  });
}

function setReferencePresentation(enabled) {
  const stylesheet = document.getElementById("reference-platform-style");
  if (stylesheet) stylesheet.disabled = !enabled;
  if (enabled) document.documentElement.dataset.engineeringWorkspace = "power_system";
  else delete document.documentElement.dataset.engineeringWorkspace;
}

function currentInspectorWidth() {
  return elements.inspector.getBoundingClientRect().width || defaultInspectorWidth();
}

function initializeInspectorResize() {
  const savedWidth = Number(localStorage.getItem(inspectorSizing.storageKey));
  applyInspectorWidth(Number.isFinite(savedWidth) && savedWidth > 0 ? savedWidth : defaultInspectorWidth());

  elements.inspectorResizer.addEventListener("pointerdown", (event) => {
    if (window.innerWidth <= inspectorSizing.desktopBreakpoint || event.button !== 0) return;
    event.preventDefault();
    elements.inspectorResizer.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = currentInspectorWidth();
    document.body.classList.add("resizing-inspector");

    let finished = false;
    const move = (moveEvent) => {
      if (moveEvent.cancelable) moveEvent.preventDefault();
      applyInspectorWidth(startWidth + startX - moveEvent.clientX);
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      applyInspectorWidth(currentInspectorWidth(), { persist: true });
      document.body.classList.remove("resizing-inspector");
      if (elements.inspectorResizer.hasPointerCapture?.(event.pointerId)) elements.inspectorResizer.releasePointerCapture(event.pointerId);
      scheduleReferenceResize();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("mouseup", finish);
      window.removeEventListener("blur", finish);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("mouseup", finish);
    window.addEventListener("blur", finish);
  });

  elements.inspectorResizer.addEventListener("dblclick", () => {
    applyInspectorWidth(defaultInspectorWidth(), { persist: true });
  });

  elements.inspectorResizer.addEventListener("keydown", (event) => {
    if (window.innerWidth <= inspectorSizing.desktopBreakpoint) return;
    const step = event.shiftKey ? inspectorSizing.keyboardStep * 2 : inspectorSizing.keyboardStep;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      applyInspectorWidth(currentInspectorWidth() + step, { persist: true });
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      applyInspectorWidth(currentInspectorWidth() - step, { persist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      applyInspectorWidth(inspectorSizing.minWidth, { persist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      applyInspectorWidth(inspectorWidthLimit(), { persist: true });
    }
  });

  elements.inspectorExpand.addEventListener("click", () => {
    const maximum = inspectorWidthLimit();
    const expanded = currentInspectorWidth() >= maximum - 1;
    if (expanded) {
      const restoreWidth = Number(elements.inspectorExpand.dataset.restoreWidth) || defaultInspectorWidth();
      applyInspectorWidth(restoreWidth, { persist: true });
    } else {
      elements.inspectorExpand.dataset.restoreWidth = String(Math.round(currentInspectorWidth()));
      applyInspectorWidth(maximum, { persist: true });
    }
  });

  window.addEventListener("resize", () => applyInspectorWidth(currentInspectorWidth()));
}

function hydrateIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function closeMobileDrawers() {
  elements.inspector.classList.remove("open");
  elements.sessionRail.classList.remove("open");
  elements.drawerBackdrop.classList.add("hidden");
}

function openMobileDrawer(target) {
  closeMobileDrawers();
  target.classList.add("open");
  elements.drawerBackdrop.classList.remove("hidden");
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}

function inlineMarkdown(text) {
  let safe = escapeHTML(text);
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  safe = safe.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return safe;
}

function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function renderMarkdown(markdown) {
  if (!markdown) return "";
  const lines = String(markdown).replaceAll("\r\n", "\n").split("\n");
  const html = [];
  let index = 0;
  let listType = null;

  const closeList = () => {
    if (listType) html.push(`</${listType}>`);
    listType = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const next = lines[index + 1]?.trim() ?? "";
    if (trimmed.includes("|") && /^\|?\s*:?-{3,}/.test(next)) {
      closeList();
      const headers = tableCells(trimmed);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      html.push('<div class="table-wrap"><table><thead><tr>');
      headers.forEach((cell) => html.push(`<th>${inlineMarkdown(cell)}</th>`));
      html.push("</tr></thead><tbody>");
      rows.forEach((row) => {
        html.push("<tr>");
        row.forEach((cell) => html.push(`<td>${inlineMarkdown(cell)}</td>`));
        html.push("</tr>");
      });
      html.push("</tbody></table></div>");
      continue;
    }
    if (!trimmed) {
      closeList();
      index += 1;
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeList();
      html.push("<hr>");
      index += 1;
      continue;
    }
    if (trimmed.startsWith(">")) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(trimmed.replace(/^>\s?/, ""))}</blockquote>`);
      index += 1;
      continue;
    }
    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = ordered ? "ol" : "ul";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      index += 1;
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(trimmed)}</p>`);
    index += 1;
  }
  closeList();
  return html.join("");
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value).toLocaleString(app.language, { maximumFractionDigits: digits });
}

function formatPercent(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(app.language, { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function parseScenarioSelectionInput(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  const numberPattern = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const range = value.match(new RegExp(`^\\s*(${numberPattern})\\s*[gG]?\\s*(?:至|到|—|–|-|~|～)\\s*(${numberPattern})\\s*[gG]?\\s*$`));
  if (range) {
    const minimum = Number(range[1]);
    const maximum = Number(range[2]);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum < 0 || maximum < minimum) {
      throw new Error(tr("地震情景区间必须是非负且按从小到大填写，例如 0.1-0.4", "The earthquake scenario range must be non-negative and ordered from low to high, for example 0.1-0.4."));
    }
    return { pga_range_g: [minimum, maximum] };
  }
  const values = value.split(/[，,、;；\s]+/).filter(Boolean).map((item) => {
    const normalized = item.replace(/[gG]$/, "");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(tr(`无法识别地震情景“${item}”，请填写 0.4 或 0.1,0.2`, `Cannot parse earthquake scenario "${item}". Enter 0.4 or 0.1,0.2.`));
    }
    return parsed;
  });
  return { pga_values_g: [...new Set(values)] };
}

function formatScenarioSelection(selection) {
  if (!selection || typeof selection !== "object") return "";
  if (Array.isArray(selection.pga_range_g) && selection.pga_range_g.length === 2) {
    return `${selection.pga_range_g[0]}-${selection.pga_range_g[1]}`;
  }
  if (Array.isArray(selection.pga_values_g) && selection.pga_values_g.length) {
    return selection.pga_values_g.join(",");
  }
  if (Array.isArray(selection.scenario_ids) && selection.scenario_ids.length) {
    return selection.scenario_ids.join(",");
  }
  return "";
}

function humanSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function artifactDescription(artifact) {
  const name = String(artifact.name || "");
  const descriptions = [
    [/multi_round_session_report\.docx$/i, ["汇总已保存的计算轮次、专家复核与追问的多轮会话报告", "Multi-round session report summarizing saved computation rounds, expert reviews and follow-ups"]],
    [/engineering_result_summary\.json/i, ["本次任务的结构化工程结果摘要", "Structured engineering result summary for this task"]],
    [/engineering_results\.xlsx/i, ["完整工程结果与可复核明细", "Complete engineering results and review tables"]],
    [/engineering_results\.docx/i, ["面向专家审查的工程分析决策主报告", "Decision-facing engineering analysis report"]],
    [/医疗系统抗震韧性评价报告\.docx|healthcare.*resilience.*report\.docx/i, ["包含模型方法、完整结果与溯源的技术报告", "Technical report with methods, complete results, and traceability"]],
    [/execution_trace\.json/i, ["逐Skill版本、耗时、输入哈希与产物溯源", "Per-Skill versions, duration, input hashes, and artifacts"]],
    [/artifact_manifest\.json/i, ["本次运行全部输出文件的索引与校验信息", "Index and checksum metadata for all run outputs"]],
    [/events\.jsonl/i, ["智能体各处理阶段的不可覆盖事件记录", "Append-only events for every agent-processing stage"]],
    [/final_state\.json/i, ["经专家确认后的智能体最终状态快照", "Final agent-state snapshot after expert review"]],
    [/resilience_summary\.json/i, ["结构化韧性结果与完整溯源信息", "Structured resilience results and provenance"]],
    [/\.xlsx$/i, ["工程计算结果与明细表", "Engineering computation workbook"]],
    [/\.docx$/i, ["完整工程评估与决策报告", "Engineering assessment and decision report"]],
    [/系统韧性总览/, ["多地震情景下的系统功能与韧性总览", "System function and resilience across scenarios"]],
    [/医院损伤功能矩阵/, ["医院损伤状态与功能保有率矩阵", "Hospital damage and retained-function matrix"]],
    [/医院需求点空间关系/, ["医院、需求点与交通服务关系图", "Hospital, demand-node, and service-relation map"]],
    [/医疗可达性空间分布/, ["震后医疗服务可达性空间分布图", "Post-earthquake medical accessibility map"]],
    [/伤员救治分析/, ["伤员需求、分派与救治率", "Casualty demand, dispatch, and treatment rates"]],
    [/医院接诊负荷/, ["医院接诊量与能力负荷分析", "Hospital reception demand and capacity load"]],
    [/恢复曲线/, ["系统功能恢复过程及不确定性区间", "System recovery and uncertainty intervals"]],
    [/策略对比/, ["恢复策略韧性与工期对比", "Recovery-strategy resilience and duration comparison"]],
    [/稳健修复甘特图/, ["工程队任务分配与稳健恢复日程", "Repair-team assignments and robust schedule"]],
  ];
  const matched = descriptions.find(([pattern]) => pattern.test(name));
  if (matched) return matched[1][app.language === "en-US" ? 1 : 0];
  return artifact.description || artifact.media_type || tr("工程输出文件", "Engineering output file");
}

function selectedIterationView(data) {
  const iterations = data.iterations || [];
  if (!iterations.length) return null;
  const latestIteration = iterations[iterations.length - 1];
  if (app.autoFollowLatestIteration || !app.selectedIteration || !iterations.some((item) => item.iteration === app.selectedIteration)) {
    app.selectedIteration = latestIteration.iteration;
  }
  return iterations.find((item) => item.iteration === app.selectedIteration) || latestIteration;
}

function selectIteration(data, value, { manual = false } = {}) {
  const iteration = Number(value);
  app.selectedIteration = iteration;
  if (manual) {
    const iterations = data.iterations || [];
    const latestIteration = iterations[iterations.length - 1];
    app.autoFollowLatestIteration = Boolean(latestIteration && latestIteration.iteration === iteration);
  }
}

function payloadPatch(original, draft) {
  const protectedFields = new Set(["dataset_source", "dataset_artifacts"]);
  const patch = {};
  Object.keys(draft || {}).forEach((key) => {
    if (protectedFields.has(key)) return;
    if (JSON.stringify(original?.[key]) !== JSON.stringify(draft[key])) patch[key] = draft[key];
  });
  return patch;
}

function downloadURL(url) {
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

function toast(message, type = "info") {
  const item = document.createElement("div");
  item.className = `toast ${type === "error" ? "error" : ""}`;
  item.innerHTML = `<i data-lucide="${type === "error" ? "circle-alert" : "circle-check"}" aria-hidden="true"></i><span>${escapeHTML(message)}</span>`;
  elements.toastRegion.appendChild(item);
  hydrateIcons();
  window.setTimeout(() => item.remove(), 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || tr(`请求失败（${response.status}）`, `Request failed (${response.status})`));
  return payload;
}

function setPreset(preset) {
  app.preset = preset;
  $$("#preset-control button").forEach((button) => button.classList.toggle("active", button.dataset.preset === preset));
  $("#power-mode").value = preset === "formal" ? "sampled" : "most_likely";
}

function collectOverrides() {
  const powerInvalid = elements.parameterDrawer.querySelector("input:not([hidden]):invalid");
  if (powerInvalid && !powerInvalid.closest("[hidden]")) {
    powerInvalid.reportValidity();
    throw new Error(tr("请检查电力参数范围。", "Check power parameter ranges."));
  }
  let repairConstraints;
  try { repairConstraints = JSON.parse($("#power-constraints").value || "{}"); }
  catch { throw new Error(tr("施工约束JSON格式错误。", "Invalid repair-constraint JSON.")); }
  if (!repairConstraints || typeof repairConstraints !== "object" || Array.isArray(repairConstraints)) throw new Error(tr("施工约束必须是JSON对象。", "Repair constraints must be a JSON object."));
  return {assessment_mode: "predictive", power_damage_mode: $("#power-mode").value,
    pga_g: Number($("#power-pga").value), seed: Number($("#power-seed").value),
    team_count: Number($("#power-teams").value), daily_work_hours: Number($("#power-hours").value),
    team_efficiency: Number($("#power-efficiency").value), target_function: Number($("#power-target").value),
    repair_objective: $("#power-objective").value, ga_population: Number($("#power-ga-population").value),
    ga_generations: Number($("#power-ga-generations").value), repair_constraints: repairConstraints, output_language: app.language};
}

function showEmpty() {
  window.PowerWorkbench?.notifyTab("home");
  window.ReferencePowerResults?.destroy?.(elements.results);
  window.ReferencePowerResults?.destroy?.(elements.spatial);
  setReferencePresentation(false);
  app.current = null;
  const emptyURL = new URL(location.href);
  emptyURL.searchParams.delete("session"); emptyURL.searchParams.delete("view");
  history.replaceState(null, "", emptyURL);
  document.body.classList.remove("power-visual", "pw-inspector-closed", "pw-result-focus");
  document.body.classList.add("power-home");
  delete document.body.dataset.powerView;
  updatePowerReviewButton();
  app.selectedScenario = null;
  app.primaryArtifactIndex = null;
  app.selectedIteration = null;
  app.autoFollowLatestIteration = true;
  app.reviewKey = null;
  app.reviewOriginal = null;
  app.reviewTargets = null;
  app.reviewTargetsOriginal = null;
  clearTimeout(app.pollTimer);
  closeMobileDrawers();
  elements.sessionWorkspace.classList.add("hidden");
  elements.emptyWorkspace.classList.remove("hidden");
  elements.inspectorContent.innerHTML = `
    <div class="inspector-empty">
      <span class="empty-crosshair" aria-hidden="true"><i data-lucide="route"></i></span>
      <strong>${tr("等待任务输入", "Waiting for a task")}</strong>
      <p>${tr("任务理解、知识依据、执行方案和工程校验将在这里逐步展开。", "Task understanding, evidence, the Skill plan, and engineering validation will appear here.")}</p>
    </div>`;
  hydrateIcons();
  renderSessionList();
  elements.taskInput.focus();
}

function showSession(data) {
  setReferencePresentation(true);
  document.body.classList.remove("power-home");
  document.body.classList.add("power-visual");
  if (app.current?.session_id !== data.session_id) document.body.classList.remove("pw-inspector-closed");
  app.current = data;
  const sessionURL = new URL(location.href);
  sessionURL.searchParams.set("session", data.session_id);
  sessionURL.searchParams.set("view", app.activeTab);
  history.replaceState(null, "", sessionURL);
  elements.emptyWorkspace.classList.add("hidden");
  elements.sessionWorkspace.classList.remove("hidden");
  elements.sessionIdLabel.textContent = data.session_id;
  elements.sessionTitle.textContent = data.user_message;
  elements.sessionStatus.textContent = statusLabel(data.status);
  elements.sessionStatus.className = `status-pill ${data.status}`;
  renderConversation(data);
  renderResults(data);
  renderSpatial(data);
  renderArtifacts(data);
  renderAudit(data);
  renderInspector(data);
  renderSessionList();
  hydrateIcons();
  updatePowerReviewButton();
}

function updatePowerReviewButton() {
  const button = $("#power-review-toggle");
  if (!button) return;
  const closed = document.body.classList.contains("pw-inspector-closed");
  button.setAttribute("aria-expanded", String(!closed));
  button.querySelector("span").textContent = closed ? tr("审查与调整", "Review & revise") : tr("收起审查", "Hide review");
}

function phaseMessage(data) {
  if (data.error) return tr(`运行发生异常：${data.error}`, `Run error: ${data.error}`);
  if (data.status === "analyzing") {
    const stages = new Set((data.events || []).map((event) => event.stage));
    if (data.task_analysis?.task_type === "knowledge_query" && stages.has("knowledge_retrieval")) return tr("正在依据知识证据组织回答……", "Preparing an answer from retrieved evidence...");
    if (stages.has("plan_validation")) return tr("正在准备人工审核界面……", "Preparing the human review interface...");
    if (stages.has("execution_plan")) return tr("正在校验工程参数、适用条件与约束……", "Validating engineering parameters and constraints with Pydantic...");
    if (stages.has("knowledge_retrieval")) return tr("正在选择并组合所需工程能力……", "Selecting and composing Engineering Skills...");
    if (stages.has("task_analysis")) return tr("正在从知识库检索方法依据与相关案例……", "Retrieving methods and relevant cases from the knowledge base...");
    return tr("正在理解任务目标、评估模式与所需输出……", "Understanding the task objective, assessment mode, and requested outputs...");
  }
  if (data.status === "revalidating") return tr("正在合并专家修改并重新校验执行计划……", "Merging expert revisions and revalidating the execution plan...");
  if (data.status === "processing_feedback") return tr("正在识别专家意见中的要点、待核事项和拟议修改……", "Identifying feedback notes, open questions, and proposed revisions...");
  if (data.status === "recovering") return tr("正在从持久化状态记录恢复任务……", "Recovering the session from the persistent LangGraph checkpoint...");
  if (data.status === "finalizing") return tr("正在记录专家审查结论并固化最终方案……", "Recording the expert decision and finalizing the accepted result...");
  if (data.status === "answering") return tr("正在结合工程计算结果和知识证据回答追问……", "Answering the follow-up using Engineering Skill results and knowledge evidence...");
  if (data.status === "executing") {
    const progress = data.skill_progress;
    return progress ? tr(`已获人工批准，正在调用工程能力开展分析与计算（${progress.completed}/${progress.total}）……`, `Human approval received. Running Engineering Skills analysis and computation (${progress.completed}/${progress.total})...`) : tr("已获人工批准，正在调用工程能力开展分析与计算……", "Human approval received. Running Engineering Skills analysis and computation...");
  }
  if (data.status === "awaiting_approval") return tr("计划已通过工程校验，等待您在右侧审查并批准。", "The plan passed engineering validation and is waiting for your approval in the review panel.");
  if (data.status === "awaiting_result_review") return tr(`第 ${formatNumber(data.iteration, 0)} 轮计算已完成，等待您接受结果或提出修改后重新计算。`, `Round ${formatNumber(data.iteration, 0)} is complete. Accept the result or submit a revision for recomputation.`);
  if (data.status === "awaiting_recovery") return data.review?.message || tr("请核对计算诊断，并在右侧选择可用的处理操作。", "Review the computation diagnostics and select an available action in the review panel.");
  if (data.status === "needs_input") return tr("当前计划未通过校验，请在右侧修改参数后重新提交。", "The current plan failed validation. Revise the parameters in the review panel and resubmit.");
  return statusLabel(data.status) || tr("正在处理任务……", "Processing task...");
}

function activateTab(tabId) {
  const target = $$(".tab").find((item) => item.dataset.tab === tabId);
  if (!target) return;
  app.activeTab = tabId;
  if (app.current) {
    const viewURL = new URL(location.href);
    viewURL.searchParams.set("view", tabId);
    history.replaceState(null, "", viewURL);
  }
  $$(".tab").forEach((item) => {
    const active = item.dataset.tab === app.activeTab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  $$(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${app.activeTab}`));
  const panel = $(`#tab-${app.activeTab}`);
  if (panel) panel.scrollTop = 0;
  window.PowerWorkbench?.notifyTab(tabId);
  if (tabId !== "results") window.ReferencePowerMaps?.pause?.(elements.results);
  if (tabId !== "spatial") window.ReferencePowerMaps?.pause?.(elements.spatial);
  scheduleReferenceResize();
}

function executionOrderFor(data, summary) {
  const candidates = [
    data.plan?.dag?.execution_order,
    data.plan?.execution_order,
    summary?.executed_components,
    data.plan?.selected_skill_ids,
    summary?.target_skill_ids,
  ];
  const order = candidates.find((item) => Array.isArray(item) && item.length) || [];
  return [...new Set(order.filter(Boolean))];
}

function scenarioOverviewLabel(data, summary) {
  const scenarios = summary?.scenario_summary || [];
  if (scenarios.length === 1) return scenarios[0].scenario_id || `${formatNumber(scenarios[0].pga_g, 2)}g`;
  if (scenarios.length > 1) {
    const first = scenarios[0].scenario_id || `${formatNumber(scenarios[0].pga_g, 2)}g`;
    const last = scenarios[scenarios.length - 1].scenario_id || `${formatNumber(scenarios[scenarios.length - 1].pga_g, 2)}g`;
    return scenarios.length > 2 ? `${first}–${last}` : scenarios.map((item) => item.scenario_id || `${formatNumber(item.pga_g, 2)}g`).join("、");
  }
  const selection = data.plan?.request_payload?.scenario_selection || data.task_analysis?.extracted_parameters?.scenario_selection;
  const raw = formatScenarioSelection(selection);
  if (!raw) return summary?.event_pga_g ? `${formatNumber(summary.event_pga_g, 2)}g` : "—";
  if (/^\d+(?:\.\d+)?-\d+(?:\.\d+)?$/.test(raw)) {
    const [minimum, maximum] = raw.split("-");
    return `${minimum}g–${maximum}g`;
  }
  return raw.split(",").map((item) => /^\d+(?:\.\d+)?$/.test(item) ? `${item}g` : item).join("、");
}

function signedNumber(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${formatNumber(number, digits)}`;
}

function warningText(warning) {
  if (typeof warning === "string") return warning;
  return warning?.message || warning?.detail || warning?.title || tr("存在需要专家核验的数据或模型提示。", "An input or model note requires expert verification.");
}

function taskOverviewState(data, latestIteration) {
  if (data.is_demo) return {tone: "confirmed", icon: "archive", label: tr("已保存案例", "Saved example")};
  const decision = latestIteration?.expert_decision?.action;
  if (data.status === "succeeded" || decision === "accept") return { tone: "confirmed", icon: "badge-check", label: tr("已完成并通过专家确认", "Completed and expert-confirmed") };
  if (data.status === "awaiting_result_review") return { tone: "review", icon: "clipboard-check", label: tr("计算完成，等待结果审查", "Computation complete, awaiting review") };
  if (data.status === "awaiting_approval") return { tone: "review", icon: "user-round-check", label: tr("方案已校验，等待人工批准", "Plan validated, awaiting approval") };
  if (data.status === "executing") return { tone: "running", icon: "loader-circle", label: tr("正在分析与计算", "Analysis and computation in progress") };
  if (["needs_input", "awaiting_recovery"].includes(data.status)) return { tone: "warning", icon: "triangle-alert", label: statusLabel(data.status) };
  if (["failed", "rejected"].includes(data.status)) return { tone: "failed", icon: "circle-x", label: statusLabel(data.status) };
  return { tone: "running", icon: "loader-circle", label: statusLabel(data.status) || tr("正在处理", "Processing") };
}

function renderExecutionScope(data, summary) {
  const order = executionOrderFor(data, summary);
  if (!order.length) return "";
  const progress = Number(data.skill_progress?.completed || 0);
  const allDone = ["awaiting_result_review", "succeeded"].includes(data.status);
  const items = order.map((skillId, index) => {
    const state = allDone ? "done" : data.status === "executing" && index < progress ? "done" : data.status === "executing" && index === progress ? "running" : "ready";
    const icon = state === "done" ? "check" : state === "running" ? "loader-circle" : "circle";
    return `<li class="scope-item ${state}"><span class="scope-state"><i data-lucide="${icon}" aria-hidden="true"></i></span><span><small>${String(index + 1).padStart(2, "0")}</small><strong>${escapeHTML(skillName(skillId))}</strong></span></li>`;
  }).join("");
  const scopeLead = allDone
    ? tr(`本次任务实际调用了 ${order.length} 项工程能力，以下环节均已完成。`, `This task used ${order.length} Engineering Skills; every listed step is complete.`)
    : tr(`系统已根据任务目标组织 ${order.length} 项工程能力，执行顺序经过依赖校验。`, `The agent composed ${order.length} Engineering Skills and validated their dependency order.`);
  return `<section class="overview-section execution-overview"><div class="overview-section-head"><div><span>${tr("分析范围", "ANALYSIS SCOPE")}</span><h3>${tr("本次任务调用的工程能力", "Engineering capabilities used for this task")}</h3></div><p>${escapeHTML(scopeLead)}</p></div><ol class="scope-grid">${items}</ol></section>`;
}

function overviewMetric(icon, label, value, detail, tone = "") {
  return `<div class="overview-metric ${escapeAttribute(tone)}"><span class="metric-icon"><i data-lucide="${icon}" aria-hidden="true"></i></span><span class="metric-copy"><small>${escapeHTML(label)}</small><strong>${escapeHTML(value)}</strong><em>${escapeHTML(detail || "")}</em></span></div>`;
}

function renderRecoveryOrder(summary, scenarioId, recommendation) {
  if (Array.isArray(recommendation?.preferred_order) && recommendation.preferred_order.length) {
    const names = new Map((summary.hospital_entities || []).map((item) => [item.hospital_id, item.hospital_name]));
    return `<div class="repair-sequence">${recommendation.preferred_order.map((id, index) => `<span><b>${index + 1}</b><strong>${escapeHTML(id)}</strong><small>${escapeHTML(names.get(id) || "")}</small></span>`).join("")}</div>`;
  }
  const order = (summary.robust_orders || []).find((item) => item.scenario_id === scenarioId) || (summary.robust_orders || [])[0];
  if (!order && !recommendation?.robust_order) return "";
  if (Array.isArray(order?.order) && order.order.length) {
    return `<div class="repair-sequence">${order.order.map((hospitalId, index) => `<span><b>${index + 1}</b><strong>${escapeHTML(hospitalId)}</strong><small>${escapeHTML(order.order_names?.[index] || "")}</small></span>`).join("")}</div>`;
  }
  return `<p class="repair-order-text">${escapeHTML(recommendation.robust_order)}</p>`;
}

function interventionPlans(summary, scenarioId) {
  return (summary?.decision_support?.hospital_intervention_plans || [])
    .filter((plan) => !scenarioId || plan.scenario_id === scenarioId);
}

function selectOverviewInterventionPlans(plans, limit = 3) {
  const selected = [];
  const add = (plan) => {
    if (plan && !selected.some((item) => item.hospital_id === plan.hospital_id)) selected.push(plan);
  };
  add([...plans].sort((a, b) => Number(a.vulnerability_rank || 999) - Number(b.vulnerability_rank || 999))[0]);
  add([...plans].sort((a, b) => Number(a.mobilization_rank || 999) - Number(b.mobilization_rank || 999))[0]);
  [...plans]
    .sort((a, b) => Number(a.vulnerability_rank || 999) - Number(b.vulnerability_rank || 999))
    .forEach(add);
  return selected.slice(0, limit);
}

function planRole(plan) {
  if (Number(plan.vulnerability_rank) === 1) return tr("功能损失最高", "Largest functionality loss");
  if (Number(plan.mobilization_rank) === 1) return tr("医院级优先进场", "First hospital-level mobilization");
  return tr("重点核查医院", "Priority inspection hospital");
}

function renderHospitalActionBrief(summary, scenarioId) {
  const plans = selectOverviewInterventionPlans(interventionPlans(summary, scenarioId));
  if (!plans.length) return "";
  const cards = plans.map((plan) => {
    const components = (plan.component_actions || []).slice(0, 3);
    const services = (plan.service_actions || []).slice(0, 2);
    return `<article class="hospital-action-card">
      <header>
        <span class="hospital-rank">${plan.mobilization_rank ? `#${escapeHTML(plan.mobilization_rank)}` : "—"}</span>
        <div><small>${escapeHTML(planRole(plan))}</small><h5><b>${escapeHTML(plan.hospital_id)}</b> ${escapeHTML(plan.hospital_name)}</h5></div>
        <span class="hospital-priority">${escapeHTML(plan.priority || "P2")}</span>
      </header>
      <div class="hospital-action-metrics"><span><small>${tr("功能保有率", "Function retained")}</small><strong>${formatPercent(plan.function_retention_ratio)}</strong></span><span><small>P(DS≥3)</small><strong>${formatPercent(plan.probability_ds_ge_3)}</strong></span><span><small>${tr("修复P50", "Repair P50")}</small><strong>${tr(`${formatNumber(plan.median_repair_time_days, 1)}天`, `${formatNumber(plan.median_repair_time_days, 1)} d`)}</strong></span></div>
      ${components.length ? `<div class="component-hotspots"><small>${tr("构件/系统风险热点", "Component and system risk hotspots")}</small><ul>${components.map((item) => `<li><span><strong>${escapeHTML(item.component)}</strong><em>${escapeHTML(item.location)}</em></span><b>${formatPercent(item.failure_probability)}</b></li>`).join("")}</ul></div>` : `<p class="component-missing">${escapeHTML(plan.evidence_statement || tr("构件位置需现场补录。", "Component locations require field entry."))}</p>`}
      ${services.length ? `<div class="service-bottlenecks"><small>${tr("优先保障诊疗链", "Priority service continuity")}</small>${services.map((item) => `<span><strong>${escapeHTML(item.service)}</strong><em>${formatPercent(item.retention_ratio)}</em></span>`).join("")}</div>` : ""}
      <p class="first-action"><i data-lucide="wrench" aria-hidden="true"></i><span>${escapeHTML(plan.first_action || "")}</span></p>
    </article>`;
  }).join("");
  return `<section class="hospital-action-brief">
    <div class="hospital-action-head"><div><small>${tr("医院级工程处置", "HOSPITAL ENGINEERING ACTIONS")}</small><h4>${tr("从“修哪家医院”细化到“核查和修复什么”", "From which hospital to what must be inspected and repaired")}</h4></div><p>${tr("构件概率用于确定现场核查优先级；GA编号仅表示医院级进场序。", "Component probabilities prioritize field inspection; GA numbers denote hospital-level mobilization only.")}</p></div>
    <div class="hospital-action-grid">${cards}</div>
  </section>`;
}

function renderHospitalInterventionResults(summary, scenarioId) {
  const plans = interventionPlans(summary, scenarioId)
    .sort((a, b) => Number(a.mobilization_rank || 999) - Number(b.mobilization_rank || 999));
  if (!plans.length) return "";
  const items = plans.map((plan) => {
    const componentRows = (plan.component_actions || []).map((action, index) => {
      const references = (action.knowledge_basis || []).map((item) => `<span title="${escapeAttribute(item.title || "")}">${escapeHTML(item.citation || item.evidence_id || "KB")}</span>`).join("");
      return `<article class="component-work-package">
        <header><span>${String(index + 1).padStart(2, "0")}</span><div><small>${escapeHTML(action.category || "")}</small><h5>${escapeHTML(action.component || "")}</h5><p>${escapeHTML(action.location || "")}</p></div><b>${formatPercent(action.failure_probability)}</b></header>
        <p class="finding-boundary"><i data-lucide="scan-search" aria-hidden="true"></i>${escapeHTML(action.finding || "")}</p>
        <dl><dt>${tr("可能后果", "Potential consequence")}</dt><dd>${escapeHTML(action.functional_consequence || "—")}</dd><dt>${tr("立即控制", "Immediate control")}</dt><dd>${escapeHTML(action.immediate_action || "—")}</dd><dt>${tr("专业修复", "Qualified repair")}</dt><dd>${escapeHTML(action.repair_action || "—")}</dd><dt>${tr("恢复使用条件", "Return-to-service criteria")}</dt><dd>${escapeHTML(action.verification || "—")}</dd></dl>
        ${references ? `<footer><small>${tr("知识依据", "Knowledge basis")}</small>${references}</footer>` : ""}
      </article>`;
    }).join("");
    const serviceRows = (plan.service_actions || []).map((action) => `<tr><td><strong>${escapeHTML(action.service || "")}</strong><small>${escapeHTML(action.state || "")}</small></td><td>${formatPercent(action.retention_ratio)}</td><td>${escapeHTML(action.functional_consequence || "—")}</td><td>${escapeHTML(action.continuity_action || "—")}</td><td>${escapeHTML(action.verification || "—")}</td></tr>`).join("");
    const open = Number(plan.vulnerability_rank) === 1 || Number(plan.mobilization_rank) === 1 ? "open" : "";
    return `<details class="hospital-intervention" ${open}>
      <summary><span class="hospital-rank">${plan.mobilization_rank ? `#${escapeHTML(plan.mobilization_rank)}` : "—"}</span><div><small>${escapeHTML(planRole(plan))}</small><strong><b>${escapeHTML(plan.hospital_id)}</b> ${escapeHTML(plan.hospital_name)}</strong><em>${escapeHTML(plan.first_action || "")}</em></div><span class="plan-summary-metrics"><b>${formatPercent(plan.function_retention_ratio)}</b><small>${tr("功能", "function")}</small></span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
      <div class="hospital-intervention-body">
        <div class="diagnostic-banner"><i data-lucide="stethoscope" aria-hidden="true"></i><div><strong>${escapeHTML(plan.diagnostic_statement || "")}</strong><p>${escapeHTML(plan.evidence_statement || "")}</p></div></div>
        <h4>${tr("构件与系统处置包", "Component and system work packages")}</h4>
        ${componentRows ? `<div class="component-work-grid">${componentRows}</div>` : `<div class="component-empty">${tr("快速模式没有构件概率。补录现场损伤位置后，使用混合模式重算才能形成构件级修复指令。", "Rapid mode has no component probabilities. Enter observed damage locations and rerun in hybrid mode before issuing component-level repair instructions.")}</div>`}
        ${serviceRows ? `<h4>${tr("诊疗链连续运行措施", "Clinical-service continuity measures")}</h4><div class="table-wrap service-action-table"><table><thead><tr><th>${tr("服务", "Service")}</th><th>${tr("保有率", "Retained")}</th><th>${tr("后果", "Consequence")}</th><th>${tr("临时保障", "Continuity measure")}</th><th>${tr("复核", "Verification")}</th></tr></thead><tbody>${serviceRows}</tbody></table></div>` : ""}
        <div class="schedule-boundary"><span><i data-lucide="calendar-range" aria-hidden="true"></i><strong>${tr("代表性排程", "Representative schedule")}</strong><p>${escapeHTML(plan.schedule_summary || "—")}</p></span><span><i data-lucide="triangle-alert" aria-hidden="true"></i><strong>${tr("排程边界", "Scheduling boundary")}</strong><p>${escapeHTML(plan.sequencing_note || "")}</p></span></div>
        <p class="field-requirements"><strong>${tr("进入实施前必须补充：", "Required before execution: ")}</strong>${escapeHTML((plan.field_update_requirements || []).join(tr("；", "; ")))}</p>
      </div>
    </details>`;
  }).join("");
  return `<section class="result-section hospital-intervention-section"><div class="decision-section-head"><div><span>${tr("HOSPITAL ACTION REGISTER", "HOSPITAL ACTION REGISTER")}</span><h3>${tr("医院—构件—诊疗链工程处置清单", "Hospital-component-clinical-chain action register")}</h3></div><p>${tr(`${plans.length}家医院 · 可展开查看`, `${plans.length} hospitals · expandable`)}</p></div><p class="decision-summary">${escapeHTML(summary.decision_support?.component_level_optimization_status || "")}</p><div class="hospital-intervention-list">${items}</div></section>`;
}

function renderCalculationContract(summary) {
  if (summary.historical_read_only || summary.metric_standard_status === "historical_unverified") return `<section class="result-section calculation-contract"><h3>${tr("历史结果：只读", "Historical result: read only")}</h3><p>${tr("本结果没有当前统一指标合同。保留原始文件供核查；不能与当前口径直接比较净改善。请新建会话重新计算。", "This result has no current metric contract. Original artifacts remain available; do not infer improvement against current results. Start a new session for a current calculation.")}</p></section>`;
  if (summary.metric_standard_status === "independent_curve") return `<section class="result-section calculation-contract"><p>${tr("独立功能曲线计算：Q/R按本任务显式评价时域定义，不包含临床救治启动覆盖率。", "Independent functionality curve: Q/R use this task's explicit evaluation horizon; no clinical treatment-start coverage is inferred.")}</p></section>`;
  if (!summary.model_profile) return "";
  const params = summary.treatment_parameters || {};
  const preferences = summary.decision_preferences || {};
  const weights = ["resilience_weight", "duration_weight", "cost_weight", "risk_weight"].map((key) => formatNumber(preferences[key], 2)).join(" / ");
  const moderateSevere = summary.emergency_severity_scope === "moderate_severe";
  const severityWeights = moderateSevere
    ? (summary.severity_weights || []).slice(1).join(" / ")
    : (summary.severity_weights || []).join(" / ");
  const scope = moderateSevere ? tr("中伤、重伤", "Moderate and severe") : tr("轻伤、中伤、重伤", "Minor, moderate, and severe");
  const minorPolicy = moderateSevere
    ? tr("仅保留输入与守恒溯源，不进入医院应急排程", "Retained for input and conservation provenance; excluded from emergency hospital scheduling")
    : tr("进入旧版分伤情独立计算", "Included in the legacy independent-severity calculation");
  return `<section class="result-section calculation-contract"><header><h3>${tr("计算口径与参数核验", "Calculation definitions and parameter verification")}</h3><span class="tag">${escapeHTML(summary.model_profile)}</span></header><p>${escapeHTML(summary.quantitative_interpretation || "")}</p><dl><div><dt>${tr("应急伤员范围", "Emergency casualty scope")}</dt><dd>${scope}</dd></div><div><dt>${tr("伤情指标权重", "Severity metric weights")}</dt><dd>${escapeHTML(severityWeights)}</dd></div><div><dt>${tr("救治步长 / 转运前延迟", "Care time step / pre-transport delay")}</dt><dd>${formatNumber(params.time_step_hours, 2)} / ${formatNumber(params.pre_transport_delay_hours, 2)} h</dd></div><div><dt>${tr("参数核验", "Parameter verification")}</dt><dd>${params.verification_status === "expert_confirmed" ? tr("有专家签认依据", "Expert-confirmed with evidence") : tr("未经本地校准", "Not locally calibrated")}</dd></div><div><dt>${tr("韧性 / 工期 / 费用 / 风险权重", "Resilience / duration / cost / risk weights")}</dt><dd>${weights}</dd></div></dl><p>${tr("轻伤处理", "Minor-casualty treatment")}: ${minorPolicy} · ${tr("生存曲线处理", "Survival-curve policy")}: ${params.survival_curve_policy === "conservative_envelope" ? tr("保守不增包络，原曲线保留", "Conservative nonincreasing envelope; original retained") : escapeHTML(params.survival_curve_policy || "legacy")}</p></section>`;
}

function canonicalPeriodRows(scenario, rows = []) {
  const records = scenario?.treatment_coverage_by_period;
  return Array.isArray(records) && records.length ? records : rows;
}

function treatmentWindow(summary, rows = []) {
  const hours = summary?.metric_standard?.treatment_horizon_hours ?? summary?.treatment_horizon_hours;
  if (hours === 60 || hours === 72) return hours;
  return rows.some((row) => Object.hasOwn(row, "moderate_60h_treatment_start_coverage")) ? 60 : 72;
}

function coverageByPeriod(scenario, rows, severity) {
  const records = canonicalPeriodRows(scenario, rows);
  const hours = treatmentWindow(scenario, records);
  return records.map((item) => `${item.period === "day" ? tr("白天", "Day") : item.period === "night" ? tr("夜间", "Night") : "—"}: ${formatPercent(item[`${severity}_${hours}h_treatment_start_coverage`])}`).join(" · ") || "—";
}

function coveragePairByPeriod(scenario, rows = []) {
  const records = canonicalPeriodRows(scenario, rows);
  const hours = treatmentWindow(scenario, records);
  return records.map((item) => `${item.period === "day" ? tr("白天", "Day") : item.period === "night" ? tr("夜间", "Night") : "—"}: ${tr("中", "M")} ${formatPercent(item[`moderate_${hours}h_treatment_start_coverage`])} / ${tr("重", "S")} ${formatPercent(item[`severe_${hours}h_treatment_start_coverage`])}`).join(" · ") || "—";
}

function renderSeverityResults(casualties) {
  const hours = treatmentWindow(null, casualties);
  const severity = [["moderate", tr("中伤", "Moderate")], ["severe", tr("重伤", "Severe")]];
  const count = (item, key, scalar, vector) => item[`${scalar}_${key}`] ?? item[vector]?.[key === "moderate" ? 1 : 2];
  const rows = casualties.flatMap((item) => severity.map(([key, label]) => `<tr><td>${item.period === "day" ? tr("白天", "Day") : tr("夜间", "Night")}</td><td><strong>${label}</strong></td><td>${formatNumber(count(item, key, "mean_demand", "mean_total_demand"), 1)}</td><td>${formatNumber(count(item, key, "mean_treated", "mean_treated_capacity"), 1)}</td><td>${formatNumber(count(item, key, "mean_unmet", "mean_unmet_demand"), 1)}</td><td><strong>${formatPercent(item[`${key}_${hours}h_treatment_start_coverage`])}</strong></td><td>${formatPercent(item[`${key}_${hours}h_survival_weighted_fulfillment`])}</td><td>${formatNumber(count(item, key, "mean_start_hours", "mean_care_start_hours"), 1)}</td></tr>`)).join("");
  return rows ? `<div class="table-wrap severity-result-table"><table><caption>${tr(`统一指标：按白天/夜间分别报告中伤、重伤${hours}h启动治疗覆盖率；分母为对应伤级源需求，零需求为未定义。`, `Unified metrics: separate day/night moderate and severe ${hours}h treatment-start coverage; denominator is source demand of that severity, undefined for zero demand.`)}</caption><thead><tr><th>${tr("时段", "Period")}</th><th>${tr("伤情", "Severity")}</th><th>${tr("需求", "Demand")}</th><th>${tr(`${hours}h内启动人数`, `Starts within ${hours}h`)}</th><th>${tr(`${hours}h内未启动人数`, `Not started within ${hours}h`)}</th><th>${tr(`${hours}h启动覆盖率`, `${hours}h start coverage`)}</th><th>${tr("生存加权满足率（辅助）", "Survival-weighted fulfillment (secondary)")}</th><th>${tr("平均启动救治时间/h", "Mean care start / h")}</th></tr></thead><tbody>${rows}</tbody></table></div>` : "";
}

function renderPreferenceEvaluation(strategies, summary) {
  const rows = strategies.filter((row) => row.decision_evaluation).map((row) => {
    const ci = row.mean_resilience_ci95 || [];
    const evaluation = row.decision_evaluation;
    return `<tr><td>${escapeHTML(strategyName(row.strategy))}</td><td>${formatNumber(evaluation.score, 6)}</td><td>${formatNumber(evaluation.tail_function_loss, 4)}</td><td>${formatNumber(evaluation.reserved_team_cost, 2)}</td><td>${ci.length ? `${formatNumber(ci[0], 4)} - ${formatNumber(ci[1], 4)}` : "—"}</td><td>${summary.recommended_strategies?.[row.scenario_id] === row.strategy ? tr("当前偏好推荐", "Preferred under current objectives") : "—"}</td></tr>`;
  }).join("");
  return rows ? `<div class="table-wrap"><table><caption>${tr("显式偏好评价；费用仅为工程队占用费用，均值区间不代表现场预测准确性", "Explicit preference evaluation; cost covers reserved teams only; mean intervals do not establish field accuracy")}</caption><thead><tr><th>${tr("策略", "Strategy")}</th><th>${tr("评价分值", "Decision score")}</th><th>${tr("低尾功能损失", "Lower-tail function loss")}</th><th>${tr("工程队费用", "Reserved-team cost")}</th><th>${tr("MC均值近似95%区间", "Approx. 95% interval for MC mean")}</th><th>${tr("推荐", "Recommendation")}</th></tr></thead><tbody>${rows}</tbody></table></div>` : "";
}

function renderFullOutcome(summary) {
  const hours = treatmentWindow(summary);
  const scenarios = summary.scenario_summary || [];
  const decisionSupport = summary.decision_support || {};
  const preferredScenario = decisionSupport.highest_scenario;
  const selected = scenarios.find((item) => item.scenario_id === preferredScenario) || scenarios[scenarios.length - 1];
  if (!selected) return "";
  const thresholdDetail = Number(selected.threshold_reached_fraction || 0) > 0
    ? tr(`达到恢复阈值概率 ${formatPercent(selected.threshold_reached_fraction)}`, `Threshold-reaching probability ${formatPercent(selected.threshold_reached_fraction)}`)
    : tr(`控制期内未达到 ${formatNumber(summary.recovery_threshold ?? 0.9, 2)} 恢复阈值`, `The ${formatNumber(summary.recovery_threshold ?? 0.9, 2)} recovery threshold was not reached within the horizon`);
  const casualtyRows = (summary.casualty_summary || []).filter((row) => row.scenario_id === selected.scenario_id);
  const treatmentRate = coveragePairByPeriod(selected, casualtyRows);
  const treatmentDetail = tr("中伤/重伤分别；白天/夜间不取均值", "Separate severities and day/night periods");
  const metrics = [
    overviewMetric("activity", tr("震后初始功能", "Initial post-earthquake function"), formatPercent(selected.mean_initial_function), tr(`功能损失 ${formatPercent(selected.mean_initial_loss)}`, `Function loss ${formatPercent(selected.mean_initial_loss)}`), "blue"),
    overviewMetric("gauge", tr("韧性指数", "Resilience index"), formatNumber(selected.mean_resilience, 3), `${selected.overall_resilience_level || tr("未评级", "Not rated")} · ${formatNumber(selected.p05_resilience, 3)}–${formatNumber(selected.p95_resilience, 3)}`, "teal"),
    overviewMetric("chart-no-axes-combined", tr("控制期末功能", "End-of-horizon function"), formatPercent(selected.mean_final_function), tr(`控制期 ${formatNumber(summary.control_time_days, 0)} 天`, `${formatNumber(summary.control_time_days, 0)}-day horizon`), "green"),
    overviewMetric("calendar-clock", tr("平均恢复工期", "Mean recovery duration"), tr(`${formatNumber(selected.mean_recovery_time_days, 1)} 天`, `${formatNumber(selected.mean_recovery_time_days, 1)} days`), thresholdDetail, "orange"),
    overviewMetric("heart-pulse", tr(`中/重伤${hours}h启动覆盖率`, `Moderate/severe ${hours}h start coverage`), treatmentRate, treatmentDetail, "red"),
    overviewMetric("users", tr("人口覆盖率", "Population coverage"), formatPercent(selected.covered_population_ratio), tr(`${formatNumber(summary.demand_node_count, 0)} 个需求点`, `${formatNumber(summary.demand_node_count, 0)} demand nodes`), "violet"),
  ].join("");
  const actions = (decisionSupport.priority_actions || []).slice(0, 2);
  const actionHTML = actions.length ? `<div class="priority-brief">${actions.map((action) => `<article><span>${escapeHTML(action.priority || "")}</span><div><small>${escapeHTML(action.phase || "")}</small><strong>${escapeHTML(action.decision || "")}</strong><p>${escapeHTML(action.target || "")}</p></div></article>`).join("")}</div>` : "";
  const recommendation = decisionSupport.strategy_recommendation || {};
  const strategy = (summary.recovery_strategy_summary || []).find((item) => item.scenario_id === selected.scenario_id && item.strategy === recommendation.recommended_strategy) || (summary.recovery_strategy_summary || []).find((item) => item.scenario_id === selected.scenario_id && item.strategy === "robust_ga");
  const strategyHTML = recommendation.interpretation || strategy ? `
    <section class="strategy-brief">
      <div class="strategy-brief-head"><span class="strategy-symbol"><i data-lucide="git-compare-arrows" aria-hidden="true"></i></span><div><small>${tr("恢复策略比较", "RECOVERY STRATEGY COMPARISON")}</small><h4>${recommendation.practically_close ? tr("本样本的韧性差异较小", "Small resilience difference in this sample") : tr("恢复策略计算结论", "Recovery-strategy conclusion")}</h4></div></div>
      <p>${escapeHTML(recommendation.interpretation || tr("恢复策略已完成比较，详细指标见工程结果。", "Recovery strategies were compared; see Engineering results for the detailed metrics."))}</p>
      ${strategy ? `<div class="strategy-deltas"><span><small>${tr("韧性增量", "Resilience delta")}</small><strong>${signedNumber(strategy.resilience_delta_vs_importance, 6)}</strong></span><span><small>${tr("工期差值", "Duration delta")}</small><strong>${tr(`${signedNumber(strategy.recovery_time_delta_vs_importance_days, 1)} 天`, `${signedNumber(strategy.recovery_time_delta_vs_importance_days, 1)} days`)}</strong></span></div>` : ""}
      <div class="repair-order-head"><strong>${recommendation.preferred_order ? tr("当前偏好的修复次序", "Preferred repair order") : tr("稳健修复次序", "Robust repair order")}</strong><small>${tr("提交专家进行资源与施工约束校核", "For expert review of resource and construction constraints")}</small></div>
      ${renderRecoveryOrder(summary, selected.scenario_id, recommendation)}
    </section>` : "";
  const hospitalActionHTML = renderHospitalActionBrief(summary, selected.scenario_id);
  return `
    <section class="overview-section outcome-overview">
      <div class="overview-section-head"><div><span>${tr("总体结果", "OVERALL OUTCOME")}</span><h3>${escapeHTML(selected.scenario_id)} ${tr("地震情景的核心工程指标", "scenario: core engineering metrics")}</h3></div><p>${tr("以下结果来自工程模型计算，不由语言模型生成。", "These values come from engineering models, not from the language model.")}</p></div>
      <div class="overview-metrics">${metrics}</div>
      <div class="overview-decision-grid">
        <section class="decision-brief"><div class="decision-brief-head"><span><i data-lucide="target" aria-hidden="true"></i></span><div><small>${tr("工程决策结论", "ENGINEERING DECISION")}</small><h4>${tr("本次计算支持的优先行动", "Priority actions supported by this analysis")}</h4></div></div><p class="decision-lead">${escapeHTML(decisionSupport.decision_summary || tr("工程计算已完成，详细结果见工程结果页面。", "The engineering analysis is complete; see Engineering results for details."))}</p>${actionHTML}</section>
        ${strategyHTML}
      </div>
      ${hospitalActionHTML}
    </section>`;
}

function renderPartialOutcome(summary) {
  if (summary.result_scope === "multi_target") {
    const requested = summary.requested_skill_ids || Object.keys(summary.result_sections || {});
    return `<section class="overview-section partial-overview"><div class="partial-icon"><i data-lucide="scan-search" aria-hidden="true"></i></div><div><span>${tr("多目标专项分析结果", "MULTI-TARGET ANALYSIS RESULT")}</span><h3>${tr("医院损伤、功能、接诊与恢复综合分析", "Integrated hospital damage, function, reception, and recovery analysis")}</h3><p>${tr(`本次任务按用户问题联合返回 ${requested.length} 类目标结果，完整依赖链中的中间计算也已执行。医院明细、伤员负荷和修复次序已整理到工程结果页面。`, `This task jointly returns ${requested.length} requested result types, while all required intermediate computations were also executed. Hospital details, casualty loads, and repair priorities are organized under Engineering results.`)}</p></div></section>`;
  }
  const targetId = summary.partial_kind || (summary.target_skill_ids || []).slice(-1)[0];
  return `<section class="overview-section partial-overview"><div class="partial-icon"><i data-lucide="scan-search" aria-hidden="true"></i></div><div><span>${tr("专项分析结果", "TARGETED ANALYSIS RESULT")}</span><h3>${escapeHTML(skillName(targetId))}</h3><p>${tr("本次任务按用户要求只执行与该问题相关的工程能力，没有触发完整韧性评价链。专项指标、医院明细和约束提示已整理到工程结果页面。", "Only the Engineering Skills needed for this question were executed; the full resilience assessment chain was not triggered. Detailed metrics and constraint notes are available under Engineering results.")}</p></div></section>`;
}

function overviewWarnings(data, summary) {
  const warnings = summary?.warnings?.length ? summary.warnings : data.validation?.warnings || [];
  if (!warnings.length) return "";
  return `<section class="overview-section warning-overview"><div class="overview-section-head"><div><span>${tr("数据与模型提示", "DATA AND MODEL NOTES")}</span><h3>${tr(`${warnings.length} 项需要关注`, `${warnings.length} items require attention`)}</h3></div><p>${tr("提示不等同于计算失败，但会影响结果适用边界。", "These notes do not imply failure, but they affect the result's applicability.")}</p></div><ul>${warnings.slice(0, 3).map((warning) => `<li><i data-lucide="triangle-alert" aria-hidden="true"></i><span>${escapeHTML(warningText(warning))}</span></li>`).join("")}</ul></section>`;
}

function overviewActions(data, latestIteration) {
  const artifacts = [...(latestIteration?.artifacts || data.artifacts || []), ...(data.session_artifacts || [])];
  const hasResults = Boolean(latestIteration?.report_summary || data.report_summary || latestIteration);
  const hasImages = artifacts.some((item) => item.kind === "image");
  const hasArtifacts = artifacts.length > 0;
  return `<nav class="overview-actions" aria-label="${tr("查看本次任务的详细内容", "Open detailed task views")}">
    <button class="overview-action primary" type="button" data-overview-tab="results" ${hasResults ? "" : "disabled"}><i data-lucide="chart-no-axes-combined" aria-hidden="true"></i><span>${tr("查看工程结果", "View engineering results")}</span></button>
    <button class="overview-action" type="button" data-overview-tab="spatial" ${hasImages ? "" : "disabled"}><i data-lucide="map" aria-hidden="true"></i><span>${tr("查看空间分析", "View spatial analysis")}</span></button>
    <button class="overview-action" type="button" data-overview-tab="artifacts" ${hasArtifacts ? "" : "disabled"}><i data-lucide="files" aria-hidden="true"></i><span>${tr("查看报告与文件", "View reports and files")}</span></button>
    <button class="overview-action quiet" type="button" data-overview-tab="audit"><i data-lucide="shield-check" aria-hidden="true"></i><span>${tr("查看运行审计", "View run audit")}</span></button>
  </nav>`;
}

function renderExpertSummary(data, latestIteration) {
  const decision = latestIteration?.expert_decision;
  let tone = "pending";
  let icon = "user-round-check";
  let title = tr("等待专家审查", "Awaiting expert review");
  let detail = data.status === "awaiting_approval"
    ? tr("执行方案已通过工程校验，请在右侧审查参数、约束和执行范围。", "The plan passed engineering validation. Review its parameters, constraints, and scope in the right panel.")
    : tr("计算结果需要由专家接受，或提出参数与资源约束修改后重新计算。", "An expert must accept the result or revise parameters and resource constraints before recomputation.");
  if (data.is_demo) {
    tone = "accepted"; icon = "archive";
    title = tr("奥克兰默认案例", "Bundled Auckland example");
    detail = tr("地图、曲线和报告读取随包保存的计算结果；可新建任务，使用自己的模型API开展分析。", "Maps, curves and reports use the bundled saved results. Create a new task to run an assessment with your own model API.");
  } else if (data.status === "rejected" && data.recovery_attempt) {
    tone = "rejected";
    icon = "circle-x";
    title = tr("本轮执行尝试已终止", "Execution attempt cancelled");
    detail = data.final_answer || tr("请查看已保留的恢复诊断。", "See the retained recovery diagnostics.");
  } else if (data.status === "succeeded" || decision?.action === "accept") {
    tone = "accepted";
    icon = "badge-check";
    title = tr("专家已确认本次结果", "Expert confirmed this result");
    detail = tr(`第 ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)} 轮结果已接受，参数、计算结果和审查记录均已固化。`, `Round ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)} was accepted; parameters, results, and review records are fixed.`);
  } else if (decision?.action === "revise") {
    tone = "revised";
    icon = "refresh-cw";
    title = tr("专家已要求修订并重算", "Expert requested revision and recomputation");
    detail = decision.feedback || detail;
  } else if (decision?.action === "reject" || data.status === "rejected") {
    tone = "rejected";
    icon = "circle-x";
    title = tr("专家未接受本次结果", "Expert did not accept this result");
    detail = decision?.feedback || tr("本次任务已终止，审查原因保留在运行审计中。", "The task was terminated; the review reason is retained in the run audit.");
  }
  return `<section class="expert-summary ${tone}"><span><i data-lucide="${icon}" aria-hidden="true"></i></span><div><small>${tr("人机协同状态", "HUMAN-IN-THE-LOOP STATUS")}</small><strong>${escapeHTML(title)}</strong><p>${escapeHTML(detail)}</p></div><time>${escapeHTML(formatTime(data.updated_at))}</time></section>`;
}

function recoveryAttemptHTML(attempt) {
  if (!attempt) return "";
  const failure = attempt.classification || {};
  const details = failure.details || {};
  const reason = {
    recovery_deadline_below_necessary_bound: tr("截止时间低于必要下界", "Deadline below a necessary lower bound"),
    recovery_sample_constraints_infeasible: tr("给定样本在所报工程约束下无可行排程", "No schedule satisfies the reported engineering constraints for a supplied sample"),
    recovery_common_order_infeasible: tr("给定样本不存在满足约束的共同修复顺序", "No common repair order satisfies the constraints across the supplied samples"),
    recovery_feasible_candidate_not_found: tr("搜索未找到满足约束的排程", "Search did not find a schedule satisfying the constraints"),
  }[failure.reason_code];
  const heading = failure.feasibility === "proven_infeasible"
    ? tr("最近一次计算证实在所报范围内不可行", "Latest attempt established infeasibility within the reported scope")
    : failure.category === "optimization_not_solved"
      ? tr("最近一次计算未能判定可行性", "Latest attempt left feasibility undetermined")
      : tr("最近一次计算尝试未完成", "Latest computation attempt did not complete");
  const precedence = Array.isArray(details.precedence)
    ? details.precedence.map((edge) => edge?.before_hospital_id && edge?.after_hospital_id
      ? `${edge.before_hospital_id} → ${edge.after_hospital_id}` : JSON.stringify(edge)).join("; ")
    : details.precedence;
  const durations = details.repair_durations_days && Object.entries(details.repair_durations_days)
    .map(([hospital, duration]) => `${hospital} ${duration}`).join(" · ");
  const scope = failure.solver_scope;
  const scopeLabel = scope?.endsWith(":individual_sample_continuous_start_times")
    ? tr("单个样本 · 连续开工时间排程", "Individual realization · continuous start-time scheduling")
    : scope?.endsWith(":one_shared_priority_list_with_earliest_free_crew_dispatch")
      ? tr("给定样本共用一份优先顺序 · 分派最早空闲队伍", "One shared priority list across supplied realizations · earliest-free-crew dispatch")
      : scope === "identical_crew_nonpreemptive_hospital_tasks_for_supplied_repair_samples"
        ? tr("给定样本 · 同质队伍、不间断维修", "Supplied realizations · identical crews, nonpreemptive repairs")
        : scope;
  const fields = [
    [tr("尝试运行 ID", "Attempt run ID"), attempt.run_id],
    [tr("地震情景", "Scenario"), details.scenario_id],
    [tr("样本序号（从 0 开始）", "Sample index (zero-based)"), details.sample_index_zero_based],
    [tr("队伍数", "Repair crews"), details.team_count],
    [tr("工期上限（天）", "Hard deadline (days)"), details.deadline_days],
    [tr("修复先后依赖", "Repair precedence"), precedence],
    [tr("各医院维修时长（天）", "Repair duration by hospital (days)"), durations],
    [tr("要求优先的医院", "Required first hospital"), details.required_first_hospital_id],
    [tr("必要工期下界（天）", "Necessary lower bound (days)"), details.lower_bound_days],
    [tr("搜索节点数", "Explored search nodes"), details.search_nodes],
    [tr("判定范围", "Solver scope"), scopeLabel],
    [tr("原因代码", "Reason code"), failure.reason_code],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  const previous = attempt.retained_result;
  return `<section class="recovery-attempt" aria-label="${tr("计算恢复诊断", "Computation recovery diagnostics")}"><strong>${escapeHTML(heading)}</strong>
    ${reason || attempt.message ? `<p>${escapeHTML(reason || attempt.message)}</p>` : ""}
    <dl class="meta-grid">${fields.map(([label, value]) => `<dt>${escapeHTML(label)}</dt><dd>${escapeHTML(typeof value === "object" ? JSON.stringify(value) : String(value))}</dd>`).join("")}</dl>
    ${previous ? `<p>${tr("下方结果为先前计算记录，仅对应当时执行的方案。运行 ID", "The results below are historical and apply to the previously executed plan only. Run ID")} <span class="mono">${escapeHTML(previous.run_id)}</span></p>` : ""}
  </section>`;
}

function priorResultNoticeHTML(data, iterationView) {
  const prior = data.recovery_attempt?.retained_result;
  if (!prior) return "";
  const runId = iterationView?.run_id || prior.run_id;
  return `<p class="inline-warning">${tr("此处显示先前已执行方案的结果。运行 ID", "These results apply to a previously executed plan. Run ID")} <span class="mono">${escapeHTML(runId)}</span></p>`;
}

function renderTaskOverview(data, latestIteration, summary) {
  return renderPowerTaskOverview(data, latestIteration, summary);
  const priorResult = data.recovery_attempt?.retained_result;
  const displayedPlan = priorResult ? latestIteration?.plan : data.plan;
  const request = displayedPlan?.request_payload || data.task_analysis?.extracted_parameters || {};
  const resultData = priorResult ? { ...data, plan: displayedPlan } : data;
  const state = taskOverviewState(data, latestIteration);
  const order = executionOrderFor(resultData, summary);
  const title = summary?.result_scope === "multi_target"
    ? tr("医院损伤、功能、接诊与恢复综合分析", "Integrated hospital damage, function, reception, and recovery analysis")
    : summary?.result_scope === "partial"
      ? skillName(summary.partial_kind)
    : order.includes("resilience_quantification") || order.includes("resilience_result_reporting")
      ? tr("区域医疗系统抗震韧性综合评估", "Integrated seismic resilience assessment of the regional healthcare system")
      : tr("区域医疗系统专项工程分析", "Targeted engineering analysis of the regional healthcare system");
  const metadata = [
    ["waves", tr("地震情景", "Earthquake scenario"), scenarioOverviewLabel(resultData, summary)],
    ["layers-3", tr("评估模式", "Assessment mode"), assessmentModeName(summary?.assessment_mode || request.assessment_mode || data.task_analysis?.assessment_mode)],
    ["dice-5", tr("蒙特卡洛样本", "Monte Carlo samples"), formatNumber(summary?.mcs ?? request.mcs, 0)],
    ["hospital", tr("分析对象", "Analysis objects"), summary?.hospital_count ? tr(`${formatNumber(summary.hospital_count, 0)} 家医院`, `${formatNumber(summary.hospital_count, 0)} hospitals`) : tr("区域医疗系统", "Regional healthcare system")],
    ["repeat-2", tr("计算轮次", "Computation round"), tr(`第 ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)}`)],
  ];
  const metadataHTML = metadata.map(([icon, label, value]) => `<div><i data-lucide="${icon}" aria-hidden="true"></i><span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value || "—")}</strong></span></div>`).join("");
  const outcome = ["partial", "multi_target"].includes(summary?.result_scope) ? renderPartialOutcome(summary) : summary ? renderFullOutcome(summary) : "";
  return `<article class="task-overview">
    <header class="overview-header"><div class="overview-title"><span class="overview-mark"><i data-lucide="clipboard-list" aria-hidden="true"></i></span><div><small>${tr("任务执行总览", "TASK EXECUTION OVERVIEW")}</small><h2>${escapeHTML(title)}</h2><p>${escapeHTML(data.task_analysis?.objective || data.user_message)}</p></div></div><span class="overview-status ${state.tone}"><i data-lucide="${state.icon}" aria-hidden="true"></i>${escapeHTML(state.label)}</span></header>
    ${recoveryAttemptHTML(data.recovery_attempt)}
    <div class="overview-metadata">${metadataHTML}</div>
    ${!["succeeded", "rejected", "failed"].includes(data.status) ? `<div class="overview-live"><span class="activity-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>${escapeHTML(phaseMessage(data))}</strong></div>` : ""}
    ${renderExecutionScope(resultData, summary)}
    ${outcome}
    ${overviewWarnings(data, summary)}
    ${overviewActions(data, latestIteration)}
    ${renderExpertSummary(data, latestIteration)}
  </article>`;
}

function renderFollowUpThread(data) {
  if (data.is_demo) return "";
  const followUps = (data.follow_ups || []).map((item) => `
    <div class="message-block user follow-up"><div class="message-head"><strong>${escapeHTML(item.actor || tr("工程人员", "Engineer"))} · ${tr("结果追问", "Result follow-up")}</strong><span>${escapeHTML(formatTime(item.asked_at))}</span></div><div class="message-body">${escapeHTML(item.question)}</div></div>
    ${item.status === "answered" ? `<div class="message-block agent"><div class="message-head"><strong>PowerSkillAgent · ${tr("依据当前结果回答", "Answer from the current result")}</strong><span>${escapeHTML(formatTime(item.answered_at))}</span></div><div class="message-body markdown">${renderMarkdown(item.answer)}</div></div>` : item.status === "failed" ? `<div class="message-block system"><div class="message-head"><strong>${tr("追问处理失败", "Follow-up failed")}</strong></div><div class="message-body">${escapeHTML(item.error || tr("未知错误", "Unknown error"))}</div></div>` : ""}`).join("");
  const mayAsk = !data.historical_read_only && ["awaiting_result_review", "succeeded"].includes(data.status);
  const composer = (data.iterations || []).length ? `<div class="follow-up-composer"><textarea id="follow-up-input" rows="2" placeholder="${tr("针对当前电网结果追问，例如：为什么遗传算法与功能增益排序的恢复曲线不同？", "Ask about the current grid result, for example: Why do the genetic-algorithm and functional-gain strategies have different recovery curves?")}" ${mayAsk ? "" : "disabled"}></textarea><button id="follow-up-submit" type="button" ${mayAsk ? "" : "disabled"}>${tr("发送追问", "Send follow-up")}</button><small>${tr("追问只解释已有结果；改变参数请在右侧结果审查中提交修订。", "Follow-ups explain existing results only; submit parameter revisions in the result-review panel.")}</small></div>` : "";
  return `${followUps}${composer}`;
}

function renderConversation(data) {
  const userMessage = `<div class="message-block user task-question"><div class="message-head"><strong>${tr("工程人员", "Engineer")}</strong><span>${escapeHTML(formatTime(data.created_at))}</span></div><div class="message-body">${escapeHTML(data.user_message)}</div></div>`;
  const working = !["succeeded", "rejected", "failed"].includes(data.status)
    ? `<div class="message-block agent knowledge-working"><div class="message-head"><strong>PowerSkillAgent</strong><span>${tr("实时状态", "Live status")}</span></div><div class="message-body working-state"><span class="activity-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><span>${escapeHTML(phaseMessage(data))}</span></div></div>`
    : "";
  const error = data.error ? `<div class="message-block system"><div class="message-head"><strong>${tr("运行异常", "Run error")}</strong></div><div class="message-body">${escapeHTML(data.error)}</div></div>` : "";
  if (data.task_analysis?.task_type === "knowledge_query") {
    const answer = data.final_answer ? `<div class="message-block agent"><div class="message-head"><strong>PowerSkillAgent · ${tr("知识回答", "Knowledge answer")}</strong><span>${escapeHTML(formatTime(data.updated_at))}</span></div><div class="message-body markdown">${renderMarkdown(data.final_answer)}</div></div>` : "";
    elements.conversation.innerHTML = `${userMessage}${working}${answer}${window.PowerWorkbench?.evidenceHTML(data) || ""}${error}`;
    window.PowerWorkbench?.bindEvidence(elements.conversation);
    return;
  }
  const iterations = data.iterations || [];
  const latestIteration = iterations.length ? iterations[iterations.length - 1] : null;
  const summary = latestIteration?.report_summary || data.report_summary;
  const interpretation = latestIteration?.interpretation || data.current_interpretation || (!data.recovery_attempt && data.final_answer);
  const interpretationLabel = data.recovery_attempt?.retained_result
    ? tr("历史计算结果解释", "Prior computation interpretation")
    : tr("工程结果解释", "Engineering result interpretation");
  const answer = interpretation ? `<div class="message-block agent result-interpretation"><div class="message-head"><strong>PowerSkillAgent · ${interpretationLabel}</strong><span>${escapeHTML(formatTime(latestIteration?.completed_at || data.updated_at))}</span></div><div class="message-body markdown">${renderMarkdown(interpretation)}</div></div>` : "";
  const overview = data.historical_read_only ? renderCalculationContract({historical_read_only: true}) : renderTaskOverview(data, latestIteration, summary);
  elements.conversation.innerHTML = `${userMessage}${overview}${answer}${renderFollowUpThread(data)}${error}`;
  $("#follow-up-submit")?.addEventListener("click", submitFollowUp);
  $$('[data-overview-tab]', elements.conversation).forEach((button) => button.addEventListener("click", () => activateTab(button.dataset.overviewTab)));
}

async function submitFollowUp() {
  if (!app.current) return;
  const input = $("#follow-up-input");
  const question = input?.value.trim() || "";
  if (!question) {
    toast(tr("请输入要追问的结果问题。", "Enter a follow-up question about the result."), "error");
    input?.focus();
    return;
  }
  const button = $("#follow-up-submit");
  if (button) button.disabled = true;
  try {
    const data = await api(localizedAPIPath(`/api/sessions/${app.current.session_id}/messages`), {
      method: "POST",
      body: JSON.stringify({ question, actor: "local-user", actor_role: "engineer" }),
    });
    showSession(data);
    schedulePoll(400);
  } catch (error) {
    toast(error.message, "error");
    if (button) button.disabled = false;
  }
}

function emptyResult(title, copy) {
  return `<div class="empty-result"><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(copy)}</p></div></div>`;
}

function selectedDelivery(data, iterationView = selectedIterationView(data)) {
  return iterationView?.result_delivery || data.result_delivery || null;
}

function formatDeliveryValue(value, valueFormat = "auto") {
  if (value === null || value === undefined || value === "") return "—";
  if (valueFormat === "percent") return formatPercent(value);
  if (valueFormat === "integer") return formatNumber(value, 0);
  if (valueFormat === "days") return formatNumber(value, 1);
  if (valueFormat === "ratio") {
    const number = Number(value);
    return Number.isFinite(number) ? number.toPrecision(6) : String(value);
  }
  if (valueFormat === "scientific") {
    const number = Number(value);
    return Number.isFinite(number) ? number.toPrecision(4) : String(value);
  }
  if (valueFormat === "number") return formatNumber(value, 4);
  if (valueFormat === "boolean") return value ? tr("有", "Yes") : tr("无", "No");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderDeliveryTable(table) {
  const columns = table.columns || [];
  const rows = table.rows || [];
  if (!columns.length) return "";
  return `<section class="delivery-table"><h4>${escapeHTML(table.title || tr("工程结果明细", "Engineering result details"))}<small>${tr(`${rows.length} 行`, `${rows.length} rows`)}</small></h4><div class="table-wrap"><table><thead><tr>${columns.map((column) => `<th>${escapeHTML(column.label || column.key)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHTML(formatDeliveryValue(row?.[column.key], column.format))}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${columns.length}">${tr("无可展示记录", "No displayable records")}</td></tr>`}</tbody></table></div></section>`;
}

function renderDeliveryResults(data, delivery, iterationView) {
  const sections = delivery.sections || [];
  const allMetrics = sections.flatMap((section) => (section.metrics || []).map((metric) => ({ ...metric, sectionTitle: section.title })));
  const headlineMetrics = allMetrics.filter((metric) => metric.value !== null && metric.value !== undefined).slice(0, 4);
  const warnings = [...(delivery.warnings || []), ...(iterationView?.result?.warnings || data.skill_result?.warnings || [])];
  const iterationSelector = (data.iterations || []).length
    ? `<select id="iteration-selector" aria-label="${tr("选择计算迭代", "Select computation round")}">${data.iterations.map((item) => `<option value="${item.iteration}" ${item.iteration === app.selectedIteration ? "selected" : ""}>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)} · ${escapeHTML(item.run_id || "")}</option>`).join("")}</select>`
    : "";
  const scopeName = delivery.result_scope === "multi_target" ? tr("多目标专项结果", "Multi-target result") : tr("专项工程结果", "Targeted engineering result");
  elements.results.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title"><div><span class="section-eyebrow">ENGINEERING RESULT DELIVERY</span><h2>${escapeHTML(delivery.objective || scopeName)}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(assessmentModeName(delivery.assessment_mode))} · ${tr(`${sections.length} 类用户请求结果`, `${sections.length} requested result sections`)} · ${tr(`${(delivery.executed_components || []).length} 个执行节点`, `${(delivery.executed_components || []).length} executed nodes`)}</p></div><div class="result-selectors">${iterationSelector}<span class="tag">${escapeHTML(scopeName)}</span></div></div>
    ${headlineMetrics.length ? `<div class="kpi-grid">${headlineMetrics.map((metric) => `<div class="kpi"><span>${escapeHTML(metric.label || metric.key)}</span><strong>${escapeHTML(formatDeliveryValue(metric.value, metric.format))}${metric.unit ? `<small> ${escapeHTML(metric.unit)}</small>` : ""}</strong><small>${escapeHTML(metric.sectionTitle || "")}</small></div>`).join("")}</div>` : ""}
    ${warnings.length ? `<div class="inline-warning"><strong>${tr("模型与数据提示：", "Model and data note: ")}</strong>${escapeHTML(warningText(warnings[0]))}${warnings.length > 1 ? tr(`（另有 ${warnings.length - 1} 条提示）`, ` (${warnings.length - 1} additional notes)`) : ""}</div>` : ""}
    <div class="delivery-sections">${sections.map((section, index) => `<article class="delivery-section"><header><span>${String(index + 1).padStart(2, "0")}</span><div><small>${escapeHTML(section.skill_id || "")}</small><h3>${escapeHTML(section.title || skillName(section.skill_id))}</h3></div></header>${(section.findings || []).length ? `<ul class="delivery-findings">${section.findings.map((finding) => `<li>${escapeHTML(finding)}</li>`).join("")}</ul>` : ""}${(section.metrics || []).length ? `<dl class="delivery-metrics">${section.metrics.map((metric) => `<div><dt>${escapeHTML(metric.label || metric.key)}</dt><dd>${escapeHTML(formatDeliveryValue(metric.value, metric.format))}${metric.unit ? `<small>${escapeHTML(metric.unit)}</small>` : ""}</dd></div>`).join("")}</dl>` : ""}${(section.tables || []).map(renderDeliveryTable).join("")}${(section.limitations || []).length ? `<div class="delivery-limit"><i data-lucide="info" aria-hidden="true"></i><span><strong>${tr("适用边界", "Applicability limit")}</strong>${escapeHTML(section.limitations.join("；"))}</span></div>` : ""}</article>`).join("")}</div>
    <section class="result-section"><h3>${tr("实际执行链与结果范围", "Executed chain and result scope")}</h3><div class="execution-strip">${(delivery.executed_components || []).map((item) => `<code>${escapeHTML(skillName(item))}</code>`).join("<span>→</span>")}</div><p class="delivery-scope-note">${tr(`用户请求能力：${(delivery.requested_skill_ids || []).map(skillName).join("、")}；执行叶节点：${(delivery.execution_target_skill_ids || []).map(skillName).join("、")}。`, `Requested capabilities: ${(delivery.requested_skill_ids || []).map(skillName).join(", ")}; execution leaf targets: ${(delivery.execution_target_skill_ids || []).map(skillName).join(", ")}.`)}</p></section>`;
  $("#iteration-selector")?.addEventListener("change", (event) => {
    selectIteration(data, event.target.value, { manual: true });
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    renderResults(data);
    renderSpatial(data);
    renderArtifacts(data);
    renderAudit(data);
  });
}

function scenarioRows(scenarios) {
  return scenarios.map((item) => `
    <tr>
      <td><strong>${escapeHTML(item.scenario_id)}</strong></td>
      <td>${formatNumber(item.pga_g, 2)}g</td>
      <td>${formatPercent(item.mean_initial_function)}</td>
      <td>${formatPercent(item.mean_final_function)}</td>
      <td>${formatNumber(item.mean_resilience, 3)} <small>[${formatNumber(item.p05_resilience, 3)}, ${formatNumber(item.p95_resilience, 3)}]</small></td>
      <td>${escapeHTML(resilienceLevelName(item.overall_resilience_level))}</td>
      <td>${formatNumber(item.mean_recovery_time_days, 1)}</td>
      <td>${coveragePairByPeriod(item)}</td>
    </tr>`).join("");
}

function renderPartialResults(data, summary, iterationView) {
  const targets = summary.target_skill_ids || [];
  const targetId = summary.partial_kind || targets[targets.length - 1] || "partial_result";
  const executed = summary.executed_components || [];
  const warnings = [...(summary.warnings || []), ...(iterationView?.result?.warnings || data.skill_result?.warnings || [])];
  if (targetId === "road_accessibility_analysis") {
    const scenarios = [...(summary.scenario_summary || [])].sort((a, b) => Number(a.pga_g) - Number(b.pga_g));
    const minimumCoverage = scenarios.reduce((current, item) => Math.min(current, Number(item.population_coverage_ratio)), 1);
    const maximumUnreachable = scenarios.reduce((current, item) => Math.max(current, Number(item.unreachable_population)), 0);
    const slowestTime = scenarios.reduce((current, item) => Math.max(current, Number(item.population_weighted_nearest_time_minutes)), 0);
    elements.results.innerHTML = `
      ${priorResultNoticeHTML(data, iterationView)}
      <div class="section-title"><div><h2>${tr("道路与医疗可达性评估结果", "Road and medical accessibility results")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(summary.assessment_mode || "—")} · ${tr(`服务半径 ${formatNumber(summary.service_radius_minutes, 0)} 分钟`, `Service radius ${formatNumber(summary.service_radius_minutes, 0)} min`)} · ${tr(`${executed.length} 个已编译组件`, `${executed.length} compiled components`)}</p></div><span class="tag">${tr("局部任务报告", "Partial-task report")}</span></div>
      <div class="kpi-grid">
        <div class="kpi"><span>${tr("最低人口覆盖率", "Minimum population coverage")}</span><strong>${formatPercent(minimumCoverage)}</strong><small>${tr("按输入OD通行时间计算", "Computed from the input OD travel times")}</small></div>
        <div class="kpi"><span>${tr("最大不可达人口", "Maximum unreachable population")}</span><strong>${formatNumber(maximumUnreachable, 0)}</strong><small>${tr("人", "people")}</small></div>
        <div class="kpi"><span>${tr("最长人口加权就医时间", "Longest population-weighted access time")}</span><strong>${formatNumber(slowestTime, 1)}<small> ${tr("分钟", "min")}</small></strong><small>${tr("仅统计可达需求点", "Reachable demand nodes only")}</small></div>
        <div class="kpi"><span>${tr("衰减模型", "Decay model")}</span><strong>${escapeHTML(summary.decay_model || "—")}</strong><small>${tr("不反演道路物理损伤", "Does not infer physical road damage")}</small></div>
      </div>
      ${warnings.length ? `<div class="inline-warning"><strong>${tr("模型提示：", "Model note: ")}</strong>${escapeHTML(warnings[0].message || warnings[0])}${warnings.length > 1 ? tr(`（另有 ${warnings.length - 1} 条提示）`, ` (${warnings.length - 1} additional notes)`) : ""}</div>` : ""}
      <section class="result-section"><h3>${tr("各地震情景医疗可达性", "Medical accessibility by earthquake scenario")}</h3><div class="table-wrap"><table><thead><tr><th>${tr("情景", "Scenario")}</th><th>PGA</th><th>${tr("人口覆盖率", "Population coverage")}</th><th>${tr("覆盖人口", "Covered population")}</th><th>${tr("不可达人口", "Unreachable population")}</th><th>${tr("加权最近时间/分钟", "Weighted nearest time / min")}</th><th>${tr("平均可达医院数", "Mean reachable hospitals")}</th></tr></thead><tbody>
        ${scenarios.map((item) => `<tr><td><strong>${escapeHTML(item.scenario_id)}</strong></td><td>${formatNumber(item.pga_g, 2)}g</td><td>${formatPercent(item.population_coverage_ratio)}</td><td>${formatNumber(item.covered_population, 0)}</td><td>${formatNumber(item.unreachable_population, 0)}</td><td>${formatNumber(item.population_weighted_nearest_time_minutes, 1)}</td><td>${formatNumber(item.mean_accessible_hospital_count, 2)}</td></tr>`).join("")}
      </tbody></table></div></section>
      <section class="result-section"><h3>${tr("实际执行链", "Executed chain")}</h3><div class="execution-strip">${executed.map((item) => `<code>${escapeHTML(skillName(item))}</code>`).join("<span>→</span>")}</div></section>`;
    return;
  }
  if (targetId !== "hospital_damage_assessment") {
    elements.results.innerHTML = `
      ${priorResultNoticeHTML(data, iterationView)}
      <div class="section-title"><div><h2>${escapeHTML(skillName(targetId))}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(summary.assessment_mode || "—")} · ${tr(`${executed.length} 个已编译组件`, `${executed.length} compiled components`)}</p></div><span class="tag">${tr("部分目标结果", "Partial-target result")}</span></div>
      ${warnings.length ? `<div class="inline-warning"><strong>${tr("模型提示：", "Model note: ")}</strong>${escapeHTML(warnings[0].message || warnings[0])}${warnings.length > 1 ? tr(`（另有 ${warnings.length - 1} 条提示）`, ` (${warnings.length - 1} additional notes)`) : ""}</div>` : ""}
      <section class="result-section"><h3>${tr("实际执行链", "Executed chain")}</h3><div class="execution-strip">${executed.map((item) => `<code>${escapeHTML(skillName(item))}</code>`).join("<span>→</span>")}</div></section>
      <section class="result-section"><h3>${tr("结构化工程输出", "Structured engineering output")}</h3><pre class="result-json">${escapeHTML(JSON.stringify(summary.target_data || {}, null, 2))}</pre></section>`;
    return;
  }

  const scenarios = [...(summary.scenario_summary || [])].sort((a, b) => Number(a.pga_g) - Number(b.pga_g));
  if (!scenarios.length) {
    elements.results.innerHTML = emptyResult(tr("医院损伤结果为空", "Hospital damage result is empty"), tr("损伤 Skill 已执行，但未返回可展示的情景结果。", "The damage Skill executed but returned no displayable scenario result."));
    return;
  }
  const worst = scenarios[scenarios.length - 1];
  if (!app.selectedScenario || !scenarios.some((item) => item.scenario_id === app.selectedScenario)) app.selectedScenario = worst.scenario_id;
  const selected = scenarios.find((item) => item.scenario_id === app.selectedScenario) || worst;
  const hospitals = (summary.hospital_summary || []).filter((item) => item.scenario_id === app.selectedScenario);
  const sortedHospitals = [...hospitals].sort((a, b) => Number(b.mean_max_idr) - Number(a.mean_max_idr));
  const iterationSelector = (data.iterations || []).length
    ? `<select id="iteration-selector" aria-label="${tr("选择计算迭代", "Select computation round")}">${data.iterations.map((item) => `<option value="${item.iteration}" ${item.iteration === app.selectedIteration ? "selected" : ""}>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)} · ${escapeHTML(item.run_id || "")}</option>`).join("")}</select>`
    : "";
  elements.results.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title">
      <div><h2>${tr("医院损伤评估结果", "Hospital damage assessment results")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(summary.assessment_mode || "—")} · MCS ${formatNumber(summary.mcs, 0)} · ${tr(`${formatNumber(summary.hospital_count, 0)} 家医院`, `${formatNumber(summary.hospital_count, 0)} hospitals`)}</p></div>
      <div class="result-selectors">${iterationSelector}<select id="scenario-selector" aria-label="${tr("选择地震情景", "Select earthquake scenario")}">${scenarios.map((item) => `<option value="${escapeAttribute(item.scenario_id)}" ${item.scenario_id === app.selectedScenario ? "selected" : ""}>${escapeHTML(item.scenario_id)} · PGA ${formatNumber(item.pga_g, 2)}g</option>`).join("")}</select></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><span>${escapeHTML(selected.scenario_id)} ${tr("系统失效概率", "system failure probability")}</span><strong>${formatPercent(selected.system_failure_probability)}</strong><small>${tr("医院平均", "Hospital mean")} ${formatPercent(selected.mean_hospital_failure_probability)}</small></div>
      <div class="kpi"><span>${tr("医院平均最大层间位移角（无量纲）", "Mean maximum hospital IDR (ratio)")}</span><strong>${formatDeliveryValue(selected.mean_max_idr, "ratio")}</strong><small>${tr("IDR 以比值参与判定", "IDR is evaluated as a ratio")}</small></div>
      <div class="kpi"><span>${tr("医院平均修复时间", "Mean hospital repair time")}</span><strong>${formatNumber(selected.mean_repair_time_days, 1)}<small> ${tr("天", "days")}</small></strong><small>${tr(`${formatNumber(summary.component_count, 0)} 个构件类型`, `${formatNumber(summary.component_count, 0)} component types`)}</small></div>
      <div class="kpi"><span>${tr("模型覆盖", "Model coverage")}</span><strong>${formatNumber(summary.component_count - (summary.unsupported_component_count || 0), 0)}</strong><small>${tr(`未支持 ${formatNumber(summary.unsupported_component_count, 0)} 项`, `${formatNumber(summary.unsupported_component_count, 0)} unsupported`)}</small></div>
    </div>
    ${warnings.length ? `<div class="inline-warning"><strong>${tr("模型提示：", "Model note: ")}</strong>${escapeHTML(warnings[0].message || warnings[0])}${warnings.length > 1 ? tr(`（另有 ${warnings.length - 1} 条提示）`, ` (${warnings.length - 1} additional notes)`) : ""}</div>` : ""}
    <section class="result-section"><h3>${tr("多地震情景损伤响应", "Damage response across earthquake scenarios")}</h3><div class="table-wrap"><table><thead><tr><th>${tr("情景", "Scenario")}</th><th>PGA</th><th>${tr("平均最大 IDR（无量纲）", "Mean maximum IDR (ratio)")}</th><th>${tr("平均修复时间/天", "Mean repair time / days")}</th><th>${tr("医院平均失效概率", "Mean hospital failure probability")}</th><th>${tr("系统失效概率", "System failure probability")}</th></tr></thead><tbody>
      ${scenarios.map((item) => `<tr><td><strong>${escapeHTML(item.scenario_id)}</strong></td><td>${formatNumber(item.pga_g, 2)}g</td><td>${formatDeliveryValue(item.mean_max_idr, "ratio")}</td><td>${formatNumber(item.mean_repair_time_days, 1)}</td><td>${formatPercent(item.mean_hospital_failure_probability)}</td><td>${formatPercent(item.system_failure_probability)}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="result-section"><h3>${escapeHTML(app.selectedScenario)} ${tr("医院损伤明细", "hospital damage details")}</h3><div class="table-wrap"><table><thead><tr><th>${tr("IDR 序", "IDR rank")}</th><th>${tr("医院", "Hospital")}</th><th>${tr("平均最大 IDR（无量纲）", "Mean maximum IDR (ratio)")}</th><th>${tr("众数损伤状态", "Modal damage state")}</th><th>${tr("损伤状态概率", "State probability")}</th><th>${tr("任意损伤概率", "Any-damage probability")}</th><th>${tr("修复时间/天", "Repair time / days")}</th><th>${tr("医院失效概率", "Hospital failure probability")}</th></tr></thead><tbody>
      ${sortedHospitals.map((hospital, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHTML(hospital.hospital_id)}</strong> ${escapeHTML(hospital.hospital_name)}</td><td>${formatDeliveryValue(hospital.mean_max_idr, "ratio")}</td><td>DS${formatNumber(hospital.modal_damage_state, 0)} · ${escapeHTML(hospital.modal_damage_label || "—")}</td><td>${formatPercent(hospital.modal_damage_probability)}</td><td>${formatPercent(hospital.probability_any_damage)}</td><td>${formatNumber(hospital.mean_repair_time_days, 1)}</td><td>${formatPercent(hospital.hospital_failure_probability)}</td></tr>`).join("")}
    </tbody></table></div></section>
    <section class="result-section"><h3>${tr("实际执行链", "Executed chain")}</h3><div class="execution-strip">${executed.map((item) => `<code>${escapeHTML(skillName(item))}</code>`).join("<span>→</span>")}</div></section>`;
  $("#scenario-selector")?.addEventListener("change", (event) => {
    app.selectedScenario = event.target.value;
    renderResults(data);
  });
  $("#iteration-selector")?.addEventListener("change", (event) => {
    selectIteration(data, event.target.value, { manual: true });
    app.selectedScenario = null;
    renderResults(data);
    renderArtifacts(data);
  });
}

function renderMultiTargetResults(data, summary, iterationView) {
  const hours = treatmentWindow(summary);
  const sections = summary.result_sections || {};
  const damage = sections.hospital_damage_assessment || {};
  const functionality = sections.hospital_function_degradation || {};
  const casualty = sections.casualty_dispatch_treatment || {};
  const recovery = sections.recovery_optimization || {};
  const scenarioMap = new Map();
  const addScenarios = (rows) => (rows || []).forEach((row) => {
    const scenarioId = String(row?.scenario_id || "");
    if (!scenarioId) return;
    scenarioMap.set(scenarioId, { ...scenarioMap.get(scenarioId), ...row, scenario_id: scenarioId });
  });
  addScenarios(damage.scenario_summary);
  addScenarios(functionality.scenario_summary);
  addScenarios(casualty.scenario_summary);
  addScenarios(recovery.recovery_strategy_summary);
  const scenarios = [...scenarioMap.values()].sort((a, b) => Number(a.pga_g ?? String(a.scenario_id).replace(/g$/i, "")) - Number(b.pga_g ?? String(b.scenario_id).replace(/g$/i, "")));
  if (!scenarios.length) {
    elements.results.innerHTML = emptyResult(tr("综合结果为空", "The integrated result is empty"), tr("目标 Skills 已执行，但当前摘要中没有可展示的地震情景。", "The target Skills executed, but the current summary contains no displayable earthquake scenario."));
    return;
  }
  const defaultScenario = scenarios[scenarios.length - 1];
  if (!app.selectedScenario || !scenarioMap.has(app.selectedScenario)) app.selectedScenario = defaultScenario.scenario_id;
  const scenarioId = app.selectedScenario;
  const damageScenario = (damage.scenario_summary || []).find((row) => row.scenario_id === scenarioId) || {};
  const functionScenario = (functionality.scenario_summary || []).find((row) => row.scenario_id === scenarioId) || {};
  const casualtyScenarios = (casualty.scenario_summary || []).filter((row) => row.scenario_id === scenarioId);
  const dayCasualty = casualtyScenarios.find((row) => row.period === "day") || casualtyScenarios[0] || {};
  const strategies = (recovery.recovery_strategy_summary || []).filter((row) => row.scenario_id === scenarioId);
  const robustStrategy = strategies.find((row) => row.strategy === "robust_ga") || strategies[0] || {};
  const damageRows = (damage.hospital_summary || []).filter((row) => row.scenario_id === scenarioId);
  const functionRows = (functionality.hospital_function_summary || []).filter((row) => row.scenario_id === scenarioId);
  const loadRows = (casualty.casualty_hospital_load || []).filter((row) => row.scenario_id === scenarioId);
  const damageByHospital = new Map(damageRows.map((row) => [row.hospital_id, row]));
  const functionByHospital = new Map(functionRows.map((row) => [row.hospital_id, row]));
  const entityByHospital = new Map((summary.hospital_entities || []).map((row) => [row.hospital_id, row]));
  const order = (recovery.robust_orders || []).find((row) => row.scenario_id === scenarioId) || (recovery.robust_orders || [])[0];
  const orderRanks = new Map((order?.order || []).map((hospitalId, index) => [hospitalId, index + 1]));
  const hospitalIds = [...new Set([
    ...damageRows.map((row) => row.hospital_id),
    ...functionRows.map((row) => row.hospital_id),
    ...loadRows.map((row) => row.hospital_id),
    ...(order?.order || []),
  ])].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
  const hospitalRows = hospitalIds.map((hospitalId) => {
    const damageRow = damageByHospital.get(hospitalId) || {};
    const functionRow = functionByHospital.get(hospitalId) || {};
    const entity = entityByHospital.get(hospitalId) || {};
    const hospitalName = damageRow.hospital_name || functionRow.hospital_name || entity.hospital_name || hospitalId;
    return `<tr><td><strong>${escapeHTML(hospitalId)}</strong> ${escapeHTML(hospitalName)}</td><td>${formatDeliveryValue(damageRow.mean_max_idr, "ratio")}</td><td>${damageRow.modal_damage_state === undefined ? "—" : `DS${formatNumber(damageRow.modal_damage_state, 0)} · ${escapeHTML(damageRow.modal_damage_label || "—")}`}</td><td>${formatPercent(damageRow.hospital_failure_probability)}</td><td>${formatPercent(functionRow.mean_function_ratio)}<div class="metric-bar"><i style="width:${Math.max(0, Math.min(100, Number(functionRow.mean_function_ratio || 0) * 100))}%"></i></div></td><td>${formatPercent(functionRow.mean_function_loss)}</td><td>${formatNumber(functionRow.mean_weighted_treatment_capacity_72h, 1)}</td><td>${formatNumber(damageRow.mean_repair_time_days, 1)}</td><td>${orderRanks.get(hospitalId) || "—"}</td></tr>`;
  }).join("");
  const periodRank = { day: 0, night: 1 };
  const sortedLoads = [...loadRows].sort((a, b) => (periodRank[a.period] ?? 9) - (periodRank[b.period] ?? 9) || String(a.hospital_id).localeCompare(String(b.hospital_id), undefined, { numeric: true }));
  const loadTableRows = sortedLoads.map((row) => {
    const assigned = row.mean_assigned_by_severity || [];
    return `<tr><td>${row.period === "day" ? tr("白天", "Day") : row.period === "night" ? tr("夜间", "Night") : escapeHTML(row.period || "—")}</td><td><strong>${escapeHTML(row.hospital_id)}</strong> ${escapeHTML(row.hospital_name || "")}</td><td>${formatNumber(assigned[1], 1)}</td><td>${formatNumber(assigned[2], 1)}</td><td>${formatNumber(row.mean_assigned_total, 1)}</td><td>${formatNumber(row.mean_treated_total, 1)}</td><td>${formatNumber(row.mean_unmet_total, 1)}</td></tr>`;
  }).join("");
  const warnings = [...(summary.warnings || []), ...(iterationView?.result?.warnings || data.skill_result?.warnings || [])];
  const executed = summary.executed_components || [];
  const iterationSelector = (data.iterations || []).length
    ? `<select id="iteration-selector" aria-label="${tr("选择计算迭代", "Select computation round")}">${data.iterations.map((item) => `<option value="${item.iteration}" ${item.iteration === app.selectedIteration ? "selected" : ""}>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)} · ${escapeHTML(item.run_id || "")}</option>`).join("")}</select>`
    : "";
  elements.results.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title">
      <div><h2>${tr("医院损伤、功能、接诊与恢复综合结果", "Integrated hospital damage, function, reception, and recovery results")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(assessmentModeName(summary.assessment_mode))} · MCS ${formatNumber(summary.mcs, 0)} · ${tr(`${formatNumber(summary.hospital_count || hospitalIds.length, 0)} 家医院`, `${formatNumber(summary.hospital_count || hospitalIds.length, 0)} hospitals`)}</p></div>
      <div class="result-selectors">${iterationSelector}<select id="scenario-selector" aria-label="${tr("选择地震情景", "Select earthquake scenario")}">${scenarios.map((row) => `<option value="${escapeAttribute(row.scenario_id)}" ${row.scenario_id === scenarioId ? "selected" : ""}>${escapeHTML(row.scenario_id)}${Number.isFinite(Number(row.pga_g)) ? ` · PGA ${formatNumber(row.pga_g, 2)}g` : ""}</option>`).join("")}</select></div>
    </div>
    <div class="kpi-grid">
      <div class="kpi"><span>${escapeHTML(scenarioId)} ${tr("系统失效概率", "system failure probability")}</span><strong>${formatPercent(damageScenario.system_failure_probability)}</strong><small>${tr("医院平均失效概率", "Mean hospital failure probability")} ${formatPercent(damageScenario.mean_hospital_failure_probability)}</small></div>
      <div class="kpi"><span>${tr("平均医院功能保有率", "Mean hospital functionality retained")}</span><strong>${formatPercent(functionScenario.mean_function_ratio)}</strong><small>${tr("最低医院", "Lowest hospital")} ${formatPercent(functionScenario.minimum_function_ratio)}</small></div>
      <div class="kpi"><span>${tr(`中/重伤${hours}h启动覆盖率`, `Moderate/severe ${hours}h start coverage`)}</span><strong>${coveragePairByPeriod({}, casualtyScenarios)}</strong><small>${tr("分伤级、分时段报告", "Separate severities and periods")}</small></div>
      <div class="kpi"><span>${tr(`中伤${hours}h启动覆盖率`, `Moderate ${hours}h start coverage`)}</span><strong>${coverageByPeriod({}, casualtyScenarios, "moderate")}</strong><small>${tr("对应源需求为分母", "Source demand denominator")}</small></div>
      <div class="kpi"><span>${tr(`重伤${hours}h启动覆盖率`, `Severe ${hours}h start coverage`)}</span><strong>${coverageByPeriod({}, casualtyScenarios, "severe")}</strong><small>${tr("对应源需求为分母", "Source demand denominator")}</small></div>
      <div class="kpi"><span>${tr("稳健恢复方案", "Robust recovery plan")}</span><strong>${formatNumber(robustStrategy.mean_resilience, 6)}</strong><small>${tr("平均恢复工期", "Mean recovery duration")} ${formatNumber(robustStrategy.mean_recovery_time_days, 1)} ${tr("天", "days")}</small></div>
    </div>
    ${warnings.length ? `<div class="inline-warning"><strong>${tr("模型提示：", "Model note: ")}</strong>${escapeHTML(warningText(warnings[0]))}${warnings.length > 1 ? tr(`（另有 ${warnings.length - 1} 条提示）`, ` (${warnings.length - 1} additional notes)`) : ""}</div>` : ""}
    <section class="result-section"><h3>${escapeHTML(scenarioId)} ${tr("7家医院损伤、功能与修复优先级", "hospital damage, function, and repair priority")}</h3><div class="table-wrap"><table class="multi-hospital-table"><thead><tr><th>${tr("医院", "Hospital")}</th><th>${tr("最大 IDR（无量纲）", "Maximum IDR (ratio)")}</th><th>${tr("损伤状态", "Damage state")}</th><th>${tr("医院失效概率", "Hospital failure probability")}</th><th>${tr("功能保有率", "Function retained")}</th><th>${tr("功能损失率", "Function loss")}</th><th>${tr("加权72h潜在能力（Q/R）", "Weighted 72h potential capacity (Q/R)")}</th><th>${tr("修复时间/天", "Repair time / days")}</th><th>${tr("稳健修复序", "Robust repair rank")}</th></tr></thead><tbody>${hospitalRows || `<tr><td colspan="9">${tr("无医院级结果", "No hospital-level results")}</td></tr>`}</tbody></table></div></section>
    <section class="result-section"><h3>${escapeHTML(scenarioId)} ${tr("中重伤接诊负荷", "moderate/severe reception load")}</h3><div class="table-wrap"><table class="multi-casualty-table"><thead><tr><th>${tr("时段", "Period")}</th><th>${tr("医院", "Hospital")}</th><th>${tr("中伤", "Moderate")}</th><th>${tr("重伤", "Severe")}</th><th>${tr("分派总量", "Assigned total")}</th><th>${tr("可救治人数", "Treatable")}</th><th>${tr("未能救治人数", "Not treated")}</th></tr></thead><tbody>${loadTableRows || `<tr><td colspan="7">${tr("当前结果未包含医院级接诊数组", "The current result contains no hospital-level reception array")}</td></tr>`}</tbody></table></div></section>
    <section class="result-section"><h3>${escapeHTML(scenarioId)} ${tr("恢复策略比较与修复次序", "recovery-strategy comparison and repair order")}</h3><div class="table-wrap"><table><thead><tr><th>${tr("策略", "Strategy")}</th><th>${tr("韧性均值", "Mean resilience")}</th><th>${tr("5%–95%分位", "5th–95th percentile")}</th><th>${tr("平均恢复工期/天", "Mean recovery / days")}</th><th>${tr("95%恢复工期/天", "95th-percentile recovery / days")}</th><th>${tr("训练样本目标改善", "Training-sample objective improvement")}</th></tr></thead><tbody>${strategies.map((row) => `<tr><td><span class="tag">${escapeHTML(strategyName(row.strategy))}</span></td><td>${formatNumber(row.mean_resilience, 6)}</td><td>${formatNumber(row.p05_resilience, 6)}–${formatNumber(row.p95_resilience, 6)}</td><td>${formatNumber(row.mean_recovery_time_days, 1)}</td><td>${formatNumber(row.p95_recovery_time_days, 1)}</td><td>${row.training_improvement === null || row.training_improvement === undefined ? tr("基线", "Baseline") : signedNumber(row.training_improvement, 6)}</td></tr>`).join("") || `<tr><td colspan="6">${tr("无恢复策略数据", "No recovery-strategy data")}</td></tr>`}</tbody></table></div><div class="repair-order-head"><strong>${tr("稳健修复优先次序", "Robust repair priority")}</strong><small>${tr("单一可实施次序，需经专家结合现场资源与施工约束确认", "A single implementable order, subject to expert confirmation against field resources and construction constraints")}</small></div>${renderRecoveryOrder(recovery, scenarioId, {})}</section>
    <section class="result-section"><h3>${tr("实际执行链", "Executed chain")}</h3><div class="execution-strip">${executed.map((item) => `<code>${escapeHTML(skillName(item))}</code>`).join("<span>→</span>")}</div></section>`;
  $("#scenario-selector")?.addEventListener("change", (event) => {
    app.selectedScenario = event.target.value;
    renderResults(data);
  });
  $("#iteration-selector")?.addEventListener("change", (event) => {
    selectIteration(data, event.target.value, { manual: true });
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    renderResults(data);
    renderSpatial(data);
    renderArtifacts(data);
  });
}

function renderResults(data) {
  if (data.historical_read_only) {
    elements.results.innerHTML = renderCalculationContract({historical_read_only: true});
    return;
  }
  const iterationView = selectedIterationView(data);
  const delivery = selectedDelivery(data, iterationView);
  const summary = iterationView?.report_summary || data.report_summary;
  if (delivery?.target_system === "power_system") {
    if (window.ReferencePowerResults) {
      if (window.ReferencePowerResults.render(elements.results, data, summary, iterationView, referenceResultOptions())) return;
    }
    if (window.PowerWorkbench) {
      window.PowerWorkbench.renderResults(elements.results, data, summary, iterationView);
      return;
    }
    renderDeliveryResults(data, delivery, iterationView);
    return;
  }
  const hours = treatmentWindow(summary);
  if (delivery && delivery.status !== "failed" && delivery.result_scope !== "full") {
    renderDeliveryResults(data, delivery, iterationView);
    return;
  }
  if (!summary) {
    elements.results.innerHTML = emptyResult(
      tr("尚无工程计算结果", "No engineering results yet"),
      data.status === "awaiting_approval"
        ? tr("批准执行方案后，工程结果将在此按设备、供电和修复策略展开。", "After the plan is approved, results will be organized here by assets, electricity supply and repair strategies.")
        : phaseMessage(data),
    );
    return;
  }
  if (summary.result_scope === "multi_target") {
    renderMultiTargetResults(data, summary, iterationView);
    return;
  }
  if (summary.result_scope === "partial") {
    renderPartialResults(data, summary, iterationView);
    return;
  }
  const scenarios = [...(summary.scenario_summary || [])].sort((a, b) => Number(a.pga_g) - Number(b.pga_g));
  if (!scenarios.length) {
    elements.results.innerHTML = emptyResult(tr("结果结构为空", "The result is empty"), tr("Skill 已执行，但报告摘要中没有场景数据。", "The Skill executed, but the report summary contains no scenario data."));
    return;
  }
  const worst = scenarios[scenarios.length - 1];
  if (!app.selectedScenario || !scenarios.some((item) => item.scenario_id === app.selectedScenario)) app.selectedScenario = worst.scenario_id;
  const selected = scenarios.find((item) => item.scenario_id === app.selectedScenario) || worst;
  const hospitals = (summary.hospital_summary || []).filter((item) => item.scenario_id === app.selectedScenario);
  const vulnerability = [...hospitals].sort((a, b) => Number(a.mean_function_ratio) - Number(b.mean_function_ratio));
  const criticality = [...hospitals].sort((a, b) => Number(b.criticality_score) - Number(a.criticality_score));
  const criticalRanks = new Map(criticality.map((item, index) => [item.hospital_id, index + 1]));
  const order = (summary.robust_orders || []).find((item) => item.scenario_id === app.selectedScenario);
  const orderRanks = new Map((order?.order || []).map((hospitalId, index) => [hospitalId, index + 1]));
  const casualties = (summary.casualty_summary || []).filter((item) => item.scenario_id === app.selectedScenario);
  const moderateTreatmentRate = coverageByPeriod(selected, casualties, "moderate");
  const severeTreatmentRate = coverageByPeriod(selected, casualties, "severe");
  const strategies = (summary.recovery_strategy_summary || []).filter((item) => item.scenario_id === app.selectedScenario);
  const schedule = (summary.representative_repair_schedule || []).filter((item) => item.scenario_id === app.selectedScenario);
  const warnings = [...(summary.warnings || []), ...(iterationView?.result?.warnings || data.skill_result?.warnings || [])];
  const iterationRows = (data.iterations || []).map((item) => {
    const scenario = (item.report_summary?.scenario_summary || []).find((candidate) => candidate.scenario_id === app.selectedScenario);
    if (!scenario) return "";
    if (!item.comparison_status?.comparable) return `<tr><td>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)}</td><td colspan="8">${tr("口径、数据版本或评价窗不同/待确认：不作净改善比较", "Metric contract, data version or horizon differs/is unknown; no improvement comparison")}</td></tr>`;
    const request = item.plan?.request_payload || {};
    const action = item.expert_decision?.action || "pending";
    const treatmentText = coveragePairByPeriod(scenario);
    const pairing = item.comparison_status.paired ? tr("严格配对", "Paired") : tr("非严格配对：MCS或seed不同/待确认", "Unpaired: MCS/seed differ or are unknown");
    return `<tr><td><strong>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)}</strong><br><small>${escapeHTML(item.run_id || "")}</small></td><td>${formatNumber(request.mcs, 0)}<br><small>${pairing}</small></td><td>${formatNumber(request.team_count, 0)}</td><td>${formatNumber(request.service_radius_minutes, 0)}</td><td>${formatNumber(scenario.mean_resilience, 6)}</td><td>${formatPercent(scenario.mean_initial_function)}</td><td>${formatNumber(scenario.mean_recovery_time_days, 2)}</td><td>${treatmentText}</td><td>${escapeHTML(decisionActionName(action))}</td></tr>`;
  }).join("");
  const iterationSelector = (data.iterations || []).length
    ? `<select id="iteration-selector" aria-label="${tr("选择计算迭代", "Select computation round")}">${data.iterations.map((item) => `<option value="${item.iteration}" ${item.iteration === app.selectedIteration ? "selected" : ""}>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)} · ${escapeHTML(item.run_id || "")}</option>`).join("")}</select>`
    : "";
  const decisionSupport = summary.decision_support || {};
  const decisionActions = decisionSupport.priority_actions || [];
  const decisionHTML = decisionActions.length ? `
    <section class="result-section decision-support" id="result-decisions">
      <div class="decision-section-head">
        <div><span>ENGINEERING DECISION SUPPORT</span><h3>${tr("工程决策建议", "Engineering decision recommendations")}</h3></div>
        <p>${escapeHTML(decisionSupport.highest_scenario || tr("最高地震情景", "Highest-intensity scenario"))} · ${tr(`${decisionActions.length} 项分级措施，点击展开实施细节`, `${decisionActions.length} prioritized actions; expand for implementation detail`)}</p>
      </div>
      <p class="decision-summary">${escapeHTML(decisionSupport.decision_summary || "")}</p>
      <div class="decision-action-list">
        ${decisionActions.map((action) => {
          const references = (action.knowledge_basis || []).map((item) => `<span title="${escapeAttribute(item.title || tr("知识库依据", "Knowledge-base evidence"))}">${escapeHTML(item.citation || item.evidence_id || "KB")}</span>`).join("");
          return `<details class="decision-action priority-${escapeAttribute(String(action.priority || "P2").toLowerCase())}" ${action.priority === "P0" ? "open" : ""}>
            <summary><strong>${escapeHTML(action.priority || "P2")}</strong><span>${escapeHTML(action.phase || tr("待确认阶段", "Phase to be confirmed"))}</span><div><h4>${escapeHTML(action.decision || tr("工程措施", "Engineering action"))}</h4><small>${tr("作用对象：", "Target: ")}${escapeHTML(action.target || "—")}</small></div><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
            <div class="decision-action-body"><dl>
              <dt>${tr("计算触发", "Calculation trigger")}</dt><dd>${escapeHTML(action.calculation_trigger || "—")}</dd>
              <dt>${tr("实施步骤", "Implementation")}</dt><dd>${escapeHTML(action.implementation || "—")}</dd>
              <dt>${tr("复核条件", "Verification")}</dt><dd>${escapeHTML(action.verification || "—")}</dd>
            </dl>
            <footer><small>${tr("知识依据", "Knowledge basis")}</small>${references || `<span>${tr("本条仅依据计算规则生成，待专家补充适用依据", "Generated from calculation rules only; an expert should add applicable evidence.")}</span>`}</footer></div>
          </details>`;
        }).join("")}
      </div>
      <div class="decision-boundary"><strong>${tr("证据边界：", "Evidence boundary: ")}</strong>${escapeHTML(decisionSupport.evidence_use_statement || tr("知识依据用于解释和措施选择，不参与工程数值计算。", "Knowledge evidence supports interpretation and action selection; it does not enter engineering numerical computation."))}</div>
    </section>` : "";
  const hospitalInterventionHTML = renderHospitalInterventionResults(summary, app.selectedScenario);
  const weakestHospital = vulnerability[0] || null;
  const preferredStrategy = strategies.find((item) => item.strategy === summary.recommended_strategies?.[app.selectedScenario]) || [...strategies].filter((item) => item.strategy !== "ga_legacy").sort((a, b) => Number(b.decision_evaluation?.score ?? b.mean_resilience ?? 0) - Number(a.decision_evaluation?.score ?? a.mean_resilience ?? 0))[0] || null;
  const firstRepairId = preferredStrategy?.implementable_order?.[0] || order?.order?.[0] || null;
  const firstRepairHospital = hospitals.find((item) => item.hospital_id === firstRepairId) || null;
  const resultNavigation = [
    decisionActions.length ? ["result-decisions", tr("决策行动", "Decision actions"), "list-checks"] : null,
    hospitalInterventionHTML ? ["result-hospitals", tr("医院处置", "Hospital actions"), "hospital"] : null,
    ["result-scenarios", tr("情景对比", "Scenario comparison"), "chart-column-big"],
    ["result-hospitals-table", tr("医院排序", "Hospital ranking"), "building-2"],
    ["result-casualties", tr("伤员救治", "Casualty treatment"), "heart-pulse"],
    ["result-recovery", tr("恢复策略", "Recovery strategy"), "calendar-range"],
  ].filter(Boolean);

  elements.results.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title results-page-title">
      <div><span class="section-eyebrow">ENGINEERING DECISION VIEW</span><h2>${tr("工程计算与决策结果", "Engineering computation and decision results")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(assessmentModeName(summary.assessment_mode))} · ${tr("蒙特卡洛样本", "MCS")} ${formatNumber(summary.mcs, 0)} · ${tr(`${formatNumber(summary.hospital_count, 0)}家医院`, `${formatNumber(summary.hospital_count, 0)} hospitals`)} · ${tr(`${formatNumber(summary.total_population, 0)}人`, `${formatNumber(summary.total_population, 0)} people`)}</p></div>
      <div class="result-selectors">${iterationSelector}<select id="scenario-selector" aria-label="${tr("选择地震情景", "Select earthquake scenario")}">${scenarios.map((item) => `<option value="${escapeAttribute(item.scenario_id)}" ${item.scenario_id === app.selectedScenario ? "selected" : ""}>${escapeHTML(item.scenario_id)} · PGA ${formatNumber(item.pga_g, 2)}g</option>`).join("")}</select></div>
    </div>
    <nav class="result-subnav" aria-label="${tr("结果章节导航", "Result section navigation")}">${resultNavigation.map(([id, label, icon]) => `<a href="#${id}"><i data-lucide="${icon}" aria-hidden="true"></i><span>${label}</span></a>`).join("")}</nav>
    <div class="kpi-grid kpi-grid-six">
      <div class="kpi"><span>${escapeHTML(selected.scenario_id)} ${tr("韧性指标", "resilience index")}</span><strong>${formatNumber(selected.mean_resilience, 3)}</strong><small>${escapeHTML(resilienceLevelName(selected.overall_resilience_level))} · ${tr("5%–95%分位", "5th–95th percentile")} ${formatNumber(selected.p05_resilience, 3)}–${formatNumber(selected.p95_resilience, 3)}</small></div>
      <div class="kpi"><span>${tr("震后初始功能", "Initial post-earthquake functionality")}</span><strong>${formatPercent(selected.mean_initial_function)}</strong><small>${tr("功能损失", "Function loss")} ${formatPercent(selected.mean_initial_loss)}</small></div>
      <div class="kpi"><span>${tr("平均恢复工期", "Mean recovery duration")}</span><strong>${formatNumber(selected.mean_recovery_time_days, 1)}<small> ${tr("天", "days")}</small></strong><small>${tr("控制期", "Control horizon")} ${formatNumber(summary.control_time_days, 0)} ${tr("天", "days")}</small></div>
      <div class="kpi"><span>${tr(`中/重伤${hours}h启动覆盖率`, `Moderate/severe ${hours}h start coverage`)}</span><strong>${coveragePairByPeriod(selected, casualties)}</strong><small>${tr("分伤级、分时段报告", "Separate severities and periods")}</small></div>
      <div class="kpi"><span>${tr(`中伤${hours}h启动覆盖率`, `Moderate ${hours}h start coverage`)}</span><strong>${moderateTreatmentRate}</strong><small>${tr("对应伤级源需求为分母", "Source demand as denominator")}</small></div>
      <div class="kpi"><span>${tr(`重伤${hours}h启动覆盖率`, `Severe ${hours}h start coverage`)}</span><strong>${severeTreatmentRate}</strong><small>${tr("对应伤级源需求为分母", "Source demand as denominator")}</small></div>
    </div>
    ${renderCalculationContract(summary)}
    <section class="result-focus-band">
      <header><div><small>CURRENT SCENARIO</small><h3>${escapeHTML(selected.scenario_id)} ${tr("决策焦点", "decision focus")}</h3></div><span>${tr("基于已完成工程计算，提交专家复核", "Derived from completed engineering computation; subject to expert review")}</span></header>
      <div class="result-focus-grid">
        <div><i data-lucide="triangle-alert" aria-hidden="true"></i><span><small>${tr("首要薄弱医院", "Most vulnerable hospital")}</small><strong>${weakestHospital ? `${escapeHTML(weakestHospital.hospital_id)} ${escapeHTML(weakestHospital.hospital_name)}` : "—"}</strong><em>${weakestHospital ? `${tr("功能保有率", "Retained function")} ${formatPercent(weakestHospital.mean_function_ratio)}` : tr("暂无医院级结果", "No hospital-level result")}</em></span></div>
        <div><i data-lucide="hard-hat" aria-hidden="true"></i><span><small>${tr("首要进场对象", "First mobilization target")}</small><strong>${firstRepairHospital ? `${escapeHTML(firstRepairHospital.hospital_id)} ${escapeHTML(firstRepairHospital.hospital_name)}` : "—"}</strong><em>${firstRepairHospital ? `${tr("平均修复工期", "Mean repair duration")} ${formatNumber(firstRepairHospital.mean_repair_time_days, 1)} ${tr("天", "days")}` : tr("待生成稳健修复次序", "Awaiting robust repair order")}</em></span></div>
        <div><i data-lucide="route" aria-hidden="true"></i><span><small>${tr("当前最优恢复方案", "Best evaluated recovery strategy")}</small><strong>${preferredStrategy ? escapeHTML(strategyName(preferredStrategy.strategy)) : "—"}</strong><em>${preferredStrategy ? `${tr("韧性", "Resilience")} ${formatNumber(preferredStrategy.mean_resilience, 4)} · ${tr("工期", "Duration")} ${formatNumber(preferredStrategy.mean_recovery_time_days, 1)} ${tr("天", "days")}` : tr("暂无策略结果", "No strategy result")}</em></span></div>
      </div>
    </section>
    ${warnings.length ? `<details class="result-warning"><summary><i data-lucide="circle-alert" aria-hidden="true"></i><strong>${tr(`${warnings.length} 项数据与模型提示`, `${warnings.length} data and model note(s)`)}</strong><span>${escapeHTML(warnings[0].message || warnings[0])}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary><ul>${warnings.map((warning) => `<li>${escapeHTML(warning.message || warning)}</li>`).join("")}</ul></details>` : ""}
    ${decisionHTML}
    <div id="result-hospitals">${hospitalInterventionHTML}</div>
    ${(data.iterations || []).length > 1 ? `<details class="result-detail result-section"><summary><div><small>ITERATION COMPARISON</small><h3>${escapeHTML(app.selectedScenario)} ${tr("多轮方案对比", "multi-round plan comparison")}</h3></div><span>${tr(`${data.iterations.length} 轮`, `${data.iterations.length} rounds`)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary><div class="result-detail-body"><div class="table-wrap"><table><thead><tr><th>${tr("迭代", "Round")}</th><th>MCS</th><th>${tr("工程队", "Repair teams")}</th><th>${tr("服务半径/min", "Service radius / min")}</th><th>${tr("韧性", "Resilience")}</th><th>${tr("初始功能", "Initial function")}</th><th>${tr("恢复工期/天", "Recovery / days")}</th><th>${tr(`中/重伤${hours}h启动覆盖率`, `Moderate/severe ${hours}h start coverage`)}</th><th>${tr("审查结论", "Review decision")}</th></tr></thead><tbody>${iterationRows}</tbody></table></div></div></details>` : ""}
    <details class="result-detail result-section" id="result-scenarios" open>
      <summary><div><small>SCENARIO COMPARISON</small><h3>${tr("多地震情景系统韧性", "System resilience across earthquake scenarios")}</h3></div><span>${tr(`${scenarios.length} 个情景`, `${scenarios.length} scenarios`)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
      <div class="result-detail-body"><div class="table-wrap"><table><thead><tr><th>${tr("情景", "Scenario")}</th><th>PGA</th><th>${tr("初始功能", "Initial function")}</th><th>${tr("控制期末功能", "End-of-horizon function")}</th><th>${tr("韧性均值与区间", "Mean resilience and interval")}</th><th>${tr("等级", "Level")}</th><th>${tr("恢复工期/天", "Recovery / days")}</th><th>${tr(`中/重伤${hours}h启动覆盖率`, `Moderate/severe ${hours}h start coverage`)}</th></tr></thead><tbody>${scenarioRows(scenarios)}</tbody></table></div></div>
    </details>
    <details class="result-detail result-section" id="result-hospitals-table" open>
      <summary><div><small>HOSPITAL PRIORITY</small><h3>${escapeHTML(app.selectedScenario)} ${tr("医院脆弱性、关键度与稳健修复次序", "hospital vulnerability, criticality, and robust repair order")}</h3></div><span>${tr(`${vulnerability.length} 家医院`, `${vulnerability.length} hospitals`)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
      <div class="result-detail-body"><div class="table-wrap"><table><thead><tr><th>${tr("脆弱性序", "Vulnerability rank")}</th><th>${tr("医院", "Hospital")}</th><th>${tr("功能比", "Function ratio")}</th><th>${tr("损伤状态", "Damage state")}</th><th>${tr("修复时间/天", "Repair time / days")}</th><th>${tr("关键度序", "Criticality rank")}</th><th>${tr("稳健修复序", "Robust repair rank")}</th></tr></thead><tbody>
        ${vulnerability.map((hospital, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHTML(hospital.hospital_id)}</strong> ${escapeHTML(hospital.hospital_name)}</td><td>${formatPercent(hospital.mean_function_ratio)}<div class="metric-bar"><i style="width:${Math.max(0, Math.min(100, Number(hospital.mean_function_ratio) * 100))}%"></i></div></td><td>DS${formatNumber(hospital.modal_damage_state, 0)} · ${formatPercent(hospital.probability_any_damage)}</td><td>${formatNumber(hospital.mean_repair_time_days, 1)}</td><td>${criticalRanks.get(hospital.hospital_id) || "—"} <small>(${formatNumber(hospital.criticality_score, 3)})</small></td><td>${orderRanks.get(hospital.hospital_id) || "—"}</td></tr>`).join("")}
      </tbody></table></div>
      ${order ? `<div class="inline-warning"><strong>${tr("单一可实施修复次序：", "Single implementable repair order: ")}</strong>${escapeHTML(order.order_display || (order.order || []).join(" → "))}</div>` : ""}
      </div>
    </details>
    <details class="result-detail result-section" id="result-casualties" open>
      <summary><div><small>EMERGENCY TREATMENT</small><h3>${escapeHTML(app.selectedScenario)} ${tr("中重伤需求与救治率", "moderate/severe demand and treatment rates")}</h3></div><span>${tr(`${casualties.length} 个时段结果`, `${casualties.length} period result(s)`)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
      <div class="result-detail-body">${renderSeverityResults(casualties)}</div>
    </details>
    <details class="result-detail result-section" id="result-recovery" open>
      <summary><div><small>RECOVERY DECISION</small><h3>${escapeHTML(app.selectedScenario)} ${tr("恢复策略比较", "recovery-strategy comparison")}</h3></div><span>${tr(`${strategies.length} 种策略`, `${strategies.length} strategies`)}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
      <div class="result-detail-body"><div class="table-wrap"><table><thead><tr><th>${tr("策略", "Strategy")}</th><th>${tr("韧性均值", "Mean resilience")}</th><th>${tr("5%–95%分位", "5th–95th percentile")}</th><th>${tr("相对重要性排序差值", "Delta vs. criticality ranking")}</th><th>${tr("平均恢复工期/天", "Mean recovery / days")}</th><th>${tr("工期差值/天", "Duration delta / days")}</th></tr></thead><tbody>
        ${strategies.map((item) => `<tr><td><span class="tag">${escapeHTML(strategyName(item.strategy))}</span></td><td>${formatNumber(item.mean_resilience, 6)}</td><td>${formatNumber(item.p05_resilience, 4)}–${formatNumber(item.p95_resilience, 4)}</td><td>${formatNumber(item.resilience_delta_vs_importance, 6)}</td><td>${formatNumber(item.mean_recovery_time_days, 2)}</td><td>${formatNumber(item.recovery_time_delta_vs_importance_days, 2)}</td></tr>`).join("") || `<tr><td colspan="6">${tr("无恢复策略数据", "No recovery-strategy data")}</td></tr>`}
      </tbody></table></div>
      ${renderPreferenceEvaluation(strategies, summary)}
      ${schedule.length ? `<p class="inline-warning">${tr(`代表性工程队计划包含 ${schedule.length} 个修复任务，分配给 ${formatNumber(summary.team_count, 0)} 支工程队；完整日程见“稳健修复甘特图”和 Excel 报告。`, `The representative schedule contains ${schedule.length} repair tasks assigned to ${formatNumber(summary.team_count, 0)} teams. See the robust repair Gantt chart and Excel report for the full schedule.`)}</p>` : ""}
      </div>
    </details>`;

  $("#scenario-selector")?.addEventListener("change", (event) => {
    app.selectedScenario = event.target.value;
    renderResults(data);
  });
  $("#iteration-selector")?.addEventListener("change", (event) => {
    selectIteration(data, event.target.value, { manual: true });
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    renderResults(data);
    renderSpatial(data);
    renderArtifacts(data);
  });
}

function artifactFigureCategory(artifact) {
  const value = `${artifact?.name || ""} ${artifact?.description || ""}`;
  if (/可达性|空间关系|spatial|accessibility|road_accessibility|demand.*relationship/i.test(value)) return "spatial";
  if (/恢复曲线|策略对比|甘特|recovery|strategy|gantt|schedule|resilience_quantification/i.test(value)) return "recovery";
  if (/医院损伤|医院功能|伤员|接诊|damage|casualty|reception|hospital_(damage|function)|hospital.*matrix/i.test(value)) return "service";
  return "overview";
}

function artifactCategoryName(category) {
  const labels = {
    all: ["全部图件", "All figures"],
    spatial: ["空间格局", "Spatial pattern"],
    service: ["医院与救治", "Hospitals & treatment"],
    recovery: ["恢复决策", "Recovery decisions"],
    overview: ["综合总览", "Overview"],
  };
  return (labels[category] || labels.overview)[app.language === "en-US" ? 1 : 0];
}

function weightedAverage(rows, valueKey, weightKey = "population") {
  let weighted = 0;
  let weights = 0;
  (rows || []).forEach((row) => {
    const value = Number(row?.[valueKey]);
    const weight = Number(row?.[weightKey]);
    if (!Number.isFinite(value) || !Number.isFinite(weight) || weight <= 0) return;
    weighted += value * weight;
    weights += weight;
  });
  return weights > 0 ? weighted / weights : null;
}

function selectedSpatialEvidence(summary) {
  const scenarios = [...(summary?.scenario_summary || [])].sort((a, b) => Number(a.pga_g) - Number(b.pga_g));
  const selected = scenarios.find((row) => row.scenario_id === app.selectedScenario) || scenarios[scenarios.length - 1] || {};
  const scenarioId = selected.scenario_id;
  const nodes = (summary?.node_accessibility_summary || []).filter((row) => row.scenario_id === scenarioId);
  const hospitals = (summary?.hospital_summary || []).filter((row) => row.scenario_id === scenarioId);
  const casualties = (summary?.casualty_summary || []).filter((row) => row.scenario_id === scenarioId);
  const loads = (summary?.casualty_hospital_load || []).filter((row) => row.scenario_id === scenarioId);
  const strategies = (summary?.recovery_strategy_summary || []).filter((row) => row.scenario_id === scenarioId);
  const schedule = (summary?.representative_repair_schedule || []).filter((row) => row.scenario_id === scenarioId);
  const worstNode = [...nodes].sort((a, b) => Number(a.mean_accessibility_ratio) - Number(b.mean_accessibility_ratio))[0] || null;
  const vulnerableHospital = [...hospitals].sort((a, b) => Number(a.mean_function_ratio) - Number(b.mean_function_ratio))[0] || null;
  const busiestHospital = [...loads].sort((a, b) => Number(b.mean_assigned) - Number(a.mean_assigned))[0] || null;
  const latestTask = [...schedule].sort((a, b) => Number(b.finish_day) - Number(a.finish_day))[0] || null;
  return {
    selected,
    scenarioId,
    nodes,
    hospitals,
    casualties,
    strategies,
    schedule,
    worstNode,
    vulnerableHospital,
    busiestHospital,
    latestTask,
    weightedAccessibility: weightedAverage(nodes, "mean_accessibility_ratio"),
  };
}

function figureNarrative(artifact, summary, evidence) {
  const hours = treatmentWindow(summary);
  const name = String(artifact?.name || "");
  const selected = evidence.selected || {};
  const defaultBoundary = tr(
    "图件反映当前输入、服务半径和模型假设下的计算结果，应结合震后巡查、道路状态和医院实报更新。",
    "The figure reflects the current inputs, service radius, and model assumptions; update it with post-event inspections, road states, and hospital reports.",
  );
  if (/医院需求点空间关系|spatial.*relationship|demand.*relationship/i.test(name)) {
    return {
      purpose: tr("识别需求点与可达医院之间的服务联系，检查空间覆盖和服务替代关系。", "Identify service links between demand nodes and reachable hospitals, including coverage and substitution."),
      findings: [
        tr(`当前服务半径为 ${formatNumber(summary.service_radius_minutes, 0)} 分钟，覆盖人口比例为 ${formatPercent(selected.covered_population_ratio)}。`, `The ${formatNumber(summary.service_radius_minutes, 0)}-minute service radius covers ${formatPercent(selected.covered_population_ratio)} of the population.`),
        tr(`人口加权最近医院通行时间为 ${formatNumber(selected.population_weighted_nearest_time_minutes, 2)} 分钟。`, `Population-weighted travel time to the nearest hospital is ${formatNumber(selected.population_weighted_nearest_time_minutes, 2)} minutes.`),
      ],
      implication: tr("优先复核承担大量需求点的医院及其关键通道；道路或医院状态变化后，应立即更新OD矩阵并重新分配服务。", "Verify hospitals serving many demand nodes and their critical access routes first; update the OD matrix and service allocation after road or hospital state changes."),
      boundary: tr("图中连线是最短可达OD服务分配，不是实际道路路径；外边界是需求点凸包，不是行政区边界。", "Lines represent nearest reachable OD assignments, not physical road paths; the outline is a demand-node convex hull, not an administrative boundary."),
    };
  }
  if (/医疗可达性|accessibility/i.test(name)) {
    const worst = evidence.worstNode;
    return {
      purpose: tr("比较震前与震后初始医疗可达性的空间变化，定位服务退化热点。", "Compare pre-event and initial post-event medical accessibility to locate service-loss hotspots."),
      findings: [
        tr(`人口加权可达性保有率约为 ${formatPercent(evidence.weightedAccessibility ?? selected.mean_initial_function)}。`, `Population-weighted accessibility retention is approximately ${formatPercent(evidence.weightedAccessibility ?? selected.mean_initial_function)}.`),
        worst
          ? tr(`最低保有率出现在 ${worst.demand_node_id}（${formatPercent(worst.mean_accessibility_ratio)}，人口 ${formatNumber(worst.population, 0)}）。`, `The lowest retention occurs at ${worst.demand_node_id} (${formatPercent(worst.mean_accessibility_ratio)}, population ${formatNumber(worst.population, 0)}).`)
          : tr("需求点级可达性明细尚未进入当前摘要。", "Demand-node accessibility details are not available in the current summary."),
      ],
      implication: worst
        ? tr(`将 ${worst.demand_node_id} 及邻近低值需求点列为转运、临时救治点和道路抢通的优先复核区域。`, `Prioritize ${worst.demand_node_id} and nearby low-retention nodes for transfer planning, temporary care points, and route restoration.`)
        : tr("结合人口和伤员需求对低可达性区域开展转运与临时医疗资源配置。", "Use population and casualty demand to plan transfers and temporary medical resources in low-accessibility areas."),
      boundary: tr("颜色表示相对于同一震前基准的模型可达性，不等同于行政区医疗资源等级，也不能证明道路完好。", "Colors show model accessibility relative to a shared pre-event baseline; they are not administrative service grades and do not prove road integrity."),
    };
  }
  if (/医院损伤|damage.*matrix|hospital.*matrix/i.test(name)) {
    const hospital = evidence.vulnerableHospital;
    return {
      purpose: tr("联合比较医院损伤、严重损伤概率、功能保有率和修复工期，识别院级薄弱对象。", "Jointly compare damage, severe-damage probability, retained function, and repair duration to identify vulnerable hospitals."),
      findings: hospital
        ? [
            tr(`${hospital.hospital_id} ${hospital.hospital_name} 功能保有率最低，为 ${formatPercent(hospital.mean_function_ratio)}。`, `${hospital.hospital_id} ${hospital.hospital_name} has the lowest retained function at ${formatPercent(hospital.mean_function_ratio)}.`),
            tr(`其 P(DS≥3) 为 ${formatPercent(hospital.probability_ds_ge_3)}，修复时间P50为 ${formatNumber(hospital.p50_repair_time_days, 1)} 天。`, `Its P(DS≥3) is ${formatPercent(hospital.probability_ds_ge_3)} and median repair time is ${formatNumber(hospital.p50_repair_time_days, 1)} days.`),
          ]
        : [tr("医院级诊断数据尚未进入当前摘要。", "Hospital diagnostic data are not available in the current summary.")],
      implication: tr("矩阵用于确定医院和专业系统的核查顺序；具体修复仍应下钻至构件、楼层和诊疗链处置包。", "Use the matrix to prioritize hospital and system inspections; actual repair decisions must drill down to component, floor, and care-pathway work packages."),
      boundary: tr("损伤值是易损性模型概率统计，不代表现场已确认整院或具体构件发生相同损伤。", "Damage values are probabilistic fragility outputs and do not confirm uniform physical damage across a hospital or its components."),
    };
  }
  if (/伤员救治|casualty.*treatment/i.test(name)) {
    const casualty = evidence.casualties[0];
    return {
      purpose: tr("核查重伤需求、震后当前救治能力、医院剩余资源及可达性约束，并保留累计救治过程。", "Assess severe-casualty demand, current post-earthquake treatment capacity, residual hospital resources, and accessibility constraints while retaining cumulative treatment detail."),
      findings: casualty
        ? [
            coveragePairByPeriod({}, evidence.casualties),
            tr(`中重伤需求 ${formatNumber(casualty.mean_demand, 1)} 人，实际救治 ${formatNumber(casualty.mean_treated, 1)} 人，未能救治 ${formatNumber(casualty.mean_unmet, 1)} 人。`, `Moderate/severe demand is ${formatNumber(casualty.mean_demand, 1)}, with ${formatNumber(casualty.mean_treated, 1)} actually treated and ${formatNumber(casualty.mean_unmet, 1)} not treated.`),
          ]
        : [tr("伤员救治数据尚未进入当前摘要。", "Casualty-treatment data are not available in the current summary.")],
      implication: tr("优先保障重伤员转运、急诊手术、影像和麻醉链，并针对高通行时间需求点设置转诊触发条件。", "Prioritize severe-casualty transfer, emergency surgery, imaging, and anesthesia, with referral triggers for high-travel-time nodes."),
      boundary: tr(`中伤、重伤${hours}h启动治疗覆盖率以对应伤级源需求为分母，按时段分别报告；不是完成治疗率或实际存活率。`, `Moderate/severe ${hours}h treatment-start coverage uses source demand of the corresponding severity and is reported per period; it is not completion or observed survival.`),
    };
  }
  if (/医院接诊负荷|reception.*load/i.test(name)) {
    const hospital = evidence.busiestHospital;
    return {
      purpose: tr("比较医院接诊量和伤情构成，识别可能出现拥挤或能力瓶颈的接收端。", "Compare hospital reception loads and severity mix to identify congestion or capacity bottlenecks."),
      findings: hospital
        ? [tr(`${hospital.hospital_id} ${hospital.hospital_name} 的单时段平均分派量最高，为 ${formatNumber(hospital.mean_assigned, 1)} 人。`, `${hospital.hospital_id} ${hospital.hospital_name} has the highest mean assigned load in a period at ${formatNumber(hospital.mean_assigned, 1)} casualties.`)]
        : [tr("医院接诊负荷明细尚未进入当前摘要。", "Hospital reception-load details are not available in the current summary.")],
      implication: tr("对高负荷医院同步检查急诊入口、影像、手术、床位和医护排班，并设置跨院分流阈值。", "For high-load hospitals, verify emergency access, imaging, surgery, beds, and staffing, and define inter-hospital diversion thresholds."),
      boundary: defaultBoundary,
    };
  }
  if (/恢复曲线|recovery.*curve/i.test(name)) {
    return {
      purpose: tr("展示系统功能随修复任务完成的恢复过程，并比较策略和不确定性。", "Show functionality recovery as repair tasks finish, including strategy differences and uncertainty."),
      findings: [
        tr(`震后初始功能为 ${formatPercent(selected.mean_initial_function)}，控制期末功能为 ${formatPercent(selected.mean_final_function)}。`, `Initial post-event function is ${formatPercent(selected.mean_initial_function)}, reaching ${formatPercent(selected.mean_final_function)} at the control horizon.`),
        tr(`达到0.9阈值的样本比例为 ${formatPercent(selected.threshold_reached_fraction)}，平均恢复工期为 ${formatNumber(selected.mean_recovery_time_days, 1)} 天。`, `${formatPercent(selected.threshold_reached_fraction)} of samples reach the 0.9 threshold; mean recovery duration is ${formatNumber(selected.mean_recovery_time_days, 1)} days.`),
      ],
      implication: tr("关注曲线的长平台期和跃升节点：平台期对应资源等待，跃升节点对应关键医院任务完成。", "Focus on long plateaus and jumps: plateaus indicate resource waiting, while jumps correspond to completion of critical hospital tasks."),
      boundary: tr("曲线由医院级修复任务驱动，尚未表示院内单个构件的详细施工流水。", "The curves are driven by hospital-level repair tasks and do not yet represent detailed component-level construction sequencing."),
    };
  }
  if (/策略对比|strategy.*comparison/i.test(name)) {
    const robust = evidence.strategies.find((row) => row.strategy === "robust_ga");
    const importance = evidence.strategies.find((row) => row.strategy === "importance");
    return {
      purpose: tr("在同一MCS样本上比较恢复策略的韧性收益、工期和不确定性。", "Compare resilience benefit, duration, and uncertainty across strategies on the same MCS samples."),
      findings: robust && importance
        ? [
            tr(`稳健GA相对重要性排序的韧性差值为 ${formatNumber(robust.mean_resilience - importance.mean_resilience, 6)}。`, `Robust GA changes mean resilience by ${formatNumber(robust.mean_resilience - importance.mean_resilience, 6)} relative to importance ranking.`),
            tr(`两者平均工期差值为 ${formatNumber(robust.mean_recovery_time_days - importance.mean_recovery_time_days, 1)} 天。`, `The mean-duration difference is ${formatNumber(robust.mean_recovery_time_days - importance.mean_recovery_time_days, 1)} days.`),
          ]
        : [tr("策略对比明细尚未进入当前摘要。", "Strategy-comparison details are not available in the current summary.")],
      implication: tr("当均值差异很小，应重点比较方案可实施性、尾部风险和专家约束，而不是仅依据单一韧性均值决策。", "When mean differences are small, prioritize implementability, tail risk, and expert constraints rather than a single resilience mean."),
      boundary: defaultBoundary,
    };
  }
  if (/甘特|gantt|schedule/i.test(name)) {
    return {
      purpose: tr("展示医院级修复任务的工程队分配、先后关系和控制期超限情况。", "Show repair-team allocation, hospital task sequence, and tasks extending beyond the control horizon."),
      findings: [
        tr(`代表性计划包含 ${evidence.schedule.length} 个医院任务，由 ${formatNumber(summary.team_count, 0)} 支工程队执行。`, `The representative plan contains ${evidence.schedule.length} hospital tasks assigned to ${formatNumber(summary.team_count, 0)} teams.`),
        evidence.latestTask
          ? tr(`最晚任务为 ${evidence.latestTask.hospital_id}，计划完成于第 ${formatNumber(evidence.latestTask.finish_day, 0)} 天。`, `The latest task is ${evidence.latestTask.hospital_id}, scheduled to finish on day ${formatNumber(evidence.latestTask.finish_day, 0)}.`)
          : tr("当前情景没有医院修复任务。", "No hospital repair task is required in the selected scenario."),
      ],
      implication: tr("优先检查跨越控制期的任务及工程队等待；院内施工前还需补充构件工期、工种、材料和停机窗口。", "Review tasks extending beyond the control horizon and team waiting; component durations, trades, materials, and outage windows are still needed before construction."),
      boundary: tr("甘特图是医院级代表性排程，不表示整座医院全部损坏，也不是构件级施工进度计划。", "The Gantt chart is a representative hospital-level schedule; it does not imply whole-hospital failure and is not a component-level construction program."),
    };
  }
  return {
    purpose: tr("综合查看地震情景下的功能损失、救治表现和恢复结果。", "Review functionality loss, treatment performance, and recovery outcomes under the earthquake scenario."),
    findings: [
      tr(`系统韧性指数为 ${formatNumber(selected.mean_resilience, 3)}，震后初始功能为 ${formatPercent(selected.mean_initial_function)}。`, `System resilience is ${formatNumber(selected.mean_resilience, 3)}, with initial post-event function at ${formatPercent(selected.mean_initial_function)}.`),
      evidence.vulnerableHospital
        ? tr(`功能最弱医院为 ${evidence.vulnerableHospital.hospital_id}，保有率 ${formatPercent(evidence.vulnerableHospital.mean_function_ratio)}。`, `The lowest-function hospital is ${evidence.vulnerableHospital.hospital_id} at ${formatPercent(evidence.vulnerableHospital.mean_function_ratio)}.`)
        : tr("医院级摘要尚不可用。", "Hospital-level summary is not available."),
    ],
    implication: tr("将综合图用于识别需进一步下钻的医院、需求点和恢复任务，并在相应专题图中复核。", "Use the overview to identify hospitals, demand nodes, and recovery tasks requiring drill-down in the corresponding thematic figures."),
    boundary: defaultBoundary,
  };
}

function renderSpatial(data) {
  const iterationView = selectedIterationView(data);
  const summary = iterationView?.report_summary || data.report_summary || {};
  if (summary.target_system === "power_system") {
    renderPowerSpatial(data, summary, iterationView);
    return;
  }
  const delivery = selectedDelivery(data, iterationView);
  const images = (iterationView?.artifacts || data.artifacts || []).filter((artifact) => artifact.kind === "image");
  if (!images.length) {
    elements.spatial.innerHTML = emptyResult(
      tr("本次结果没有可适用的空间或工程图件", "No applicable spatial or engineering figures are available"),
      tr("结果交付层只根据已经完成的工程计算生成图件；当前输出缺少可绘制的空间坐标或数值序列，请查看“工程结果”和“报告与文件”。", "The delivery layer generates figures only from completed engineering computations. The current output contains no plottable spatial coordinates or numerical series; see Engineering results and Reports and files."),
    );
    return;
  }
  const availableCategories = ["all", ...new Set(images.map(artifactFigureCategory))];
  if (!availableCategories.includes(app.spatialCategory)) app.spatialCategory = "all";
  const filteredImages = app.spatialCategory === "all"
    ? images
    : images.filter((item) => artifactFigureCategory(item) === app.spatialCategory);
  const preferred = filteredImages.find((item) => /可达性|accessibility/i.test(item.name)) || filteredImages[0] || images[0];
  if (app.primaryArtifactIndex === null || !filteredImages.some((item) => item.index === app.primaryArtifactIndex)) app.primaryArtifactIndex = preferred.index;
  const primary = filteredImages.find((item) => item.index === app.primaryArtifactIndex) || preferred;
  const evidence = selectedSpatialEvidence(summary);
  const deliverySection = (delivery?.sections || []).find((section) => (section.figure_names || []).includes(primary.name));
  const narrative = deliverySection ? {
    purpose: deliverySection.title || tr("工程结果图件", "Engineering result figure"),
    findings: (deliverySection.findings || []).length ? deliverySection.findings : [tr("图件由本次已执行Skill的结构化结果生成。", "The figure was generated from the structured output of the executed Skill.")],
    implication: tr("将图件与同一能力的指标表、警告和适用边界结合解读。", "Interpret the figure together with the metrics, warnings, and applicability limits for the same capability."),
    boundary: (deliverySection.limitations || [tr("图件只表达本次模型计算结果，不替代现场调查和专家判断。", "The figure represents this model run and does not replace field investigation or expert judgment.")])[0],
  } : figureNarrative(primary, summary, evidence);
  const metricRetention = evidence.weightedAccessibility ?? evidence.selected?.mean_initial_function;
  const weakestLabel = evidence.worstNode
    ? `${evidence.worstNode.demand_node_id} · ${formatPercent(evidence.worstNode.mean_accessibility_ratio)}`
    : "—";
  const categoryButtons = availableCategories.map((category) => {
    const count = category === "all" ? images.length : images.filter((item) => artifactFigureCategory(item) === category).length;
    return `<button type="button" data-figure-category="${escapeAttribute(category)}" class="${category === app.spatialCategory ? "active" : ""}"><span>${escapeHTML(artifactCategoryName(category))}</span><small>${count}</small></button>`;
  }).join("");
  elements.spatial.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title spatial-page-title"><div><span class="section-eyebrow">SPATIAL & DECISION EVIDENCE</span><h2>${tr("空间分析与工程图表", "Spatial analysis and engineering charts")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${escapeHTML(evidence.scenarioId || tr("当前情景", "Current scenario"))} · ${tr("计算图件与工程解读联动", "linked computational figures and engineering interpretation")}</p></div><span class="tag">${tr(`${images.length} 个图件`, `${images.length} figures`)}</span></div>
    <section class="spatial-summary-band" aria-label="${tr("空间分析指标摘要", "Spatial-analysis metric summary")}">
      <div class="spatial-summary-copy"><strong>${tr("先读结论，再读图件", "Read the finding before the figure")}</strong><span>${tr("指标随当前计算轮次和地震情景更新；点击下方图件可查看对应工程解释。", "Metrics update with the current round and scenario; select a figure below for its engineering interpretation.")}</span></div>
      <dl class="spatial-kpi-strip">
        <div><dt>${tr("覆盖人口", "Population covered")}</dt><dd>${formatPercent(evidence.selected?.covered_population_ratio)}</dd></div>
        <div><dt>${tr("可达性保有率", "Accessibility retained")}</dt><dd>${formatPercent(metricRetention)}</dd></div>
        <div><dt>${tr("人口加权最近时间", "Weighted nearest time")}</dt><dd>${formatNumber(evidence.selected?.population_weighted_nearest_time_minutes, 2)}<small>${tr(" 分钟", " min")}</small></dd></div>
        <div><dt>${tr("最低可达性需求点", "Lowest-access node")}</dt><dd>${escapeHTML(weakestLabel)}</dd></div>
      </dl>
    </section>
    <div class="figure-category-control" role="group" aria-label="${tr("筛选图件类型", "Filter figure category")}">${categoryButtons}</div>
    <section class="spatial-focus">
      <figure class="figure-primary"><div class="figure-canvas"><img src="${escapeAttribute(primary.url)}" alt="${escapeAttribute(primary.name)}"><button class="figure-expand" data-figure-open type="button" aria-label="${escapeAttribute(tr(`全屏查看${primary.name}`, `View ${primary.name} full screen`))}" title="${tr("全屏查看图件", "View figure full screen")}"><i data-lucide="maximize-2" aria-hidden="true"></i></button></div><figcaption><strong>${escapeHTML(String(primary.name || "").replace(/\.(png|svg)$/i, ""))}</strong><span>${escapeHTML(artifactDescription(primary))}</span></figcaption></figure>
      <aside class="figure-reading">
        <div class="figure-reading-head"><span>${escapeHTML(artifactCategoryName(artifactFigureCategory(primary)))}</span><h3>${tr("这张图说明什么", "What this figure shows")}</h3></div>
        <div class="figure-reading-block"><small>${tr("分析目的", "Purpose")}</small><p>${escapeHTML(narrative.purpose)}</p></div>
        <div class="figure-reading-block finding"><small>${tr("关键发现", "Key findings")}</small><ul>${narrative.findings.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul></div>
        <div class="figure-reading-block action"><small>${tr("工程含义", "Engineering implication")}</small><p>${escapeHTML(narrative.implication)}</p></div>
        <div class="figure-reading-boundary"><i data-lucide="info" aria-hidden="true"></i><span>${escapeHTML(narrative.boundary)}</span></div>
      </aside>
    </section>
    <section class="figure-catalog"><header><div><h3>${escapeHTML(artifactCategoryName(app.spatialCategory))}</h3><p>${tr("选择图件后，上方同步更新大图、关键发现与工程解释。", "Selecting a figure updates the main view, key findings, and engineering interpretation above.")}</p></div><span>${filteredImages.length}</span></header><div class="figure-grid">${filteredImages.map((item) => `<figure class="figure-thumb ${item.index === primary.index ? "active" : ""}" data-artifact-index="${item.index}" tabindex="0"><img loading="lazy" src="${escapeAttribute(item.url)}" alt="${escapeAttribute(item.name)}"><figcaption><small>${escapeHTML(artifactCategoryName(artifactFigureCategory(item)))}</small><strong>${escapeHTML(String(item.name || "").replace(/\.(png|svg)$/i, ""))}</strong><span>${escapeHTML(artifactDescription(item))}</span></figcaption></figure>`).join("")}</div></section>`;
  $("[data-figure-open]", elements.spatial)?.addEventListener("click", () => openFigureLightbox(primary));
  $$("[data-figure-category]", elements.spatial).forEach((button) => {
    button.addEventListener("click", () => {
      app.spatialCategory = button.dataset.figureCategory || "all";
      const categoryImages = app.spatialCategory === "all" ? images : images.filter((item) => artifactFigureCategory(item) === app.spatialCategory);
      app.primaryArtifactIndex = categoryImages[0]?.index ?? images[0].index;
      renderSpatial(data);
    });
  });
  $$(".figure-thumb", elements.spatial).forEach((figure) => {
    const select = () => {
      app.primaryArtifactIndex = Number(figure.dataset.artifactIndex);
      renderSpatial(data);
      $(".spatial-focus", elements.spatial)?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    figure.addEventListener("click", select);
    figure.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") select(); });
  });
}

function applyFigureZoom() {
  app.figureZoom = Math.min(3, Math.max(0.75, app.figureZoom));
  elements.figureLightboxImage.style.width = `${app.figureZoom * 100}%`;
  elements.figureZoomLevel.textContent = `${Math.round(app.figureZoom * 100)}%`;
  elements.figureZoomOut.disabled = app.figureZoom <= 0.75;
  elements.figureZoomIn.disabled = app.figureZoom >= 3;
}

function openFigureLightbox(artifact) {
  elements.figureLightboxTitle.textContent = artifact.name || tr("工程图件", "Engineering figure");
  elements.figureLightboxImage.src = artifact.url;
  elements.figureLightboxImage.alt = artifact.name || tr("工程图件", "Engineering figure");
  app.figureZoom = 1;
  applyFigureZoom();
  elements.figureLightboxStage.scrollTo({ top: 0, left: 0 });
  elements.figureLightbox.showModal();
}

function initializeFigureLightbox() {
  elements.figureZoomIn.addEventListener("click", () => { app.figureZoom += 0.25; applyFigureZoom(); });
  elements.figureZoomOut.addEventListener("click", () => { app.figureZoom -= 0.25; applyFigureZoom(); });
  elements.figureZoomReset.addEventListener("click", () => { app.figureZoom = 1; applyFigureZoom(); });
  elements.figureLightboxClose.addEventListener("click", () => elements.figureLightbox.close());
  elements.figureLightbox.addEventListener("click", (event) => {
    if (event.target === elements.figureLightbox) elements.figureLightbox.close();
  });
  elements.figureLightbox.addEventListener("close", () => {
    elements.figureLightboxImage.removeAttribute("src");
    app.figureZoom = 1;
  });
}

function renderArtifacts(data) {
  const iterationView = selectedIterationView(data);
  const sourceArtifacts = iterationView?.artifacts || data.artifacts || [];
  const artifacts = [...sourceArtifacts, ...(data.session_artifacts || []), ...(data.audit_files || [])].filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index);
  if (!artifacts.length) {
    elements.artifacts.innerHTML = emptyResult(tr("尚无输出文件", "No output files yet"), tr("批准并完成工程计算后，可在这里下载结构化 JSON、Excel、Word、地图和图表。", "After the computation is approved and completed, structured JSON, Excel, Word, maps, and charts can be downloaded here."));
    return;
  }
  const extension = (name) => name.split(".").pop()?.toUpperCase().slice(0, 5) || "FILE";
  const categories = ["report", "structured_result", "figure", "traceability", "machine_artifact"];
  const categoryName = (category) => ({
    report: tr("可读报告", "Readable reports"),
    structured_result: tr("结构化结果", "Structured results"),
    figure: tr("地图与工程图件", "Maps and engineering figures"),
    traceability: tr("运行溯源文件", "Traceability files"),
    machine_artifact: tr("工程计算矩阵", "Engineering computation arrays"),
  }[category] || tr("其他文件", "Other files"));
  const featured = [
    artifacts.find((item) => /multi_round_session_report\.docx$/i.test(item.name || "")),
    artifacts.find((item) => /engineering_results\.docx$/i.test(item.name || "")),
    artifacts.find((item) => /医疗系统抗震韧性评价报告\.docx$|healthcare.*resilience.*report\.docx$/i.test(item.name || "")),
    artifacts.find((item) => /engineering_results\.xlsx$/i.test(item.name || "")),
  ].filter(Boolean).filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index);
  const featuredURLs = new Set(featured.map((item) => item.url));
  const featureMeta = (item) => {
    if (/multi_round_session_report\.docx$/i.test(item.name || "")) return [tr("多轮会话最终报告", "Final multi-round report"), tr("首选交付", "Top delivery"), "files", "primary"];
    if (/engineering_results\.docx$/i.test(item.name || "")) return [tr("决策主报告", "Decision report"), tr("先读这个", "Start here"), "file-text", "primary"];
    if (/\.docx$/i.test(item.name || "")) return [tr("完整技术报告", "Full technical report"), tr("方法与附录", "Methods & appendix"), "book-open-text", "technical"];
    return [tr("结果工作簿", "Result workbook"), tr("完整明细", "Complete tables"), "sheet", "workbook"];
  };
  const grouped = categories.map((category) => [category, artifacts.filter((item) => !featuredURLs.has(item.url) && (item.category || "machine_artifact") === category)]).filter(([, items]) => items.length);
  elements.artifacts.innerHTML = `
    ${priorResultNoticeHTML(data, iterationView)}
    <div class="section-title"><div><span class="section-eyebrow">DELIVERY & TRACEABILITY</span><h2>${tr("报告、图件与可追溯文件", "Reports, figures, and traceable output files")}</h2><p>${tr(`第 ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(iterationView?.iteration || data.iteration || 1, 0)}`)} · ${tr("运行ID：", "Run ID: ")}${escapeHTML(iterationView?.run_id || data.skill_result?.run_id || "—")} · ${tr("轮次文件与会话级文件均保留独立来源", "round and session-level files retain independent provenance")}</p></div><span class="tag">${tr(`${artifacts.length} 个文件`, `${artifacts.length} files`)}</span></div>
    ${featured.length ? `<section class="artifact-featured"><header><div><small>RECOMMENDED DELIVERY</small><h3>${tr("优先交付文件", "Recommended deliverables")}</h3></div><p>${tr("多轮会话报告用于最终交付；本轮主报告、技术报告与工作簿用于逐项复核。", "Use the multi-round session report for final delivery, and the current-round decision report, technical report, and workbook for item-level review.")}</p></header><div class="artifact-feature-grid">${featured.map((item) => { const [label, badge, icon, tone] = featureMeta(item); return `<article class="artifact-feature ${tone}"><i data-lucide="${icon}" aria-hidden="true"></i><div><small>${badge}</small><h4>${label}</h4><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(artifactDescription(item))} · ${escapeHTML(humanSize(item.size_bytes))}</span></div><a href="${escapeAttribute(downloadURL(item.url))}" aria-label="${tr(`下载${label}`, `Download ${label}`)}"><i data-lucide="download" aria-hidden="true"></i><span>${tr("下载", "Download")}</span></a></article>`; }).join("")}</div></section>` : ""}
    <div class="artifact-groups">${grouped.map(([category, items]) => `<section class="artifact-group"><header><div><h3>${escapeHTML(categoryName(category))}</h3><p>${category === "machine_artifact" ? tr("供后续Skill复用和工程复核的大型数组，不建议直接作为结论阅读。", "Large arrays for downstream Skills and engineering review; they are not intended as direct narrative conclusions.") : tr("由本次结果交付与运行溯源机制统一整理。", "Organized by the result-delivery and traceability mechanism for this run.")}</p></div><span>${items.length}</span></header><div class="artifact-list">${items.map((item) => `<div class="artifact-row"><div class="file-mark">${escapeHTML(extension(item.name))}</div><div><strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(artifactDescription(item))} · ${escapeHTML(humanSize(item.size_bytes))}${item.source_skill_id ? ` · ${escapeHTML(skillName(item.source_skill_id))}` : ""}</span></div><a class="download-link" href="${escapeAttribute(downloadURL(item.url))}">${tr("下载文件", "Download")}</a></div>`).join("")}</div></section>`).join("")}</div>`;
}

function auditStageName(stage, fallback) {
  const labels = {
    task_analysis: ["任务理解", "Task understanding"],
    knowledge_retrieval: ["知识检索", "Knowledge retrieval"],
    knowledge_answer: ["知识回答", "Knowledge answer"],
    execution_plan: ["执行方案生成", "Execution plan generated"],
    plan_validation: ["计划校验", "Plan validation"],
    human_review: ["人工审查", "Human review"],
    human_revision: ["人工修订", "Human revision"],
    skill_execution_started: ["分析与计算开始", "Analysis and computation started"],
    skill_execution_finished: ["分析与计算完成", "Analysis and computation completed"],
    skill_execution_failed: ["分析与计算异常", "Analysis and computation failed"],
    execution_failed: ["分析与计算异常", "Analysis and computation failed"],
    iteration_interpretation: ["结果解释", "Result interpretation"],
    result_review: ["结果审查", "Result review"],
    feedback_analysis: ["专家反馈解析", "Expert feedback analysis"],
    final_acceptance: ["最终确认", "Final confirmation"],
  };
  const pair = labels[stage];
  return pair ? pair[app.language === "en-US" ? 1 : 0] : fallback || stage;
}

function renderAudit(data) {
  const events = data.events || [];
  const iterationView = selectedIterationView(data);
  const trace = iterationView?.execution_trace || data.execution_trace || [];
  if (!events.length && !trace.length) {
    elements.audit.innerHTML = emptyResult(tr("审计记录尚未产生", "No audit records yet"), tr("智能体完成第一个处理节点后，事件时间戳与关键状态会写入独立会话目录。", "After the first processing node completes, event timestamps and key states will be written to the isolated session directory."));
    return;
  }
  const totalDuration = trace.reduce((total, node) => total + (Number(node.duration_seconds) || 0), 0);
  const warningCount = trace.reduce((total, node) => total + (Number(node.warning_count) || 0), 0);
  const reusedNodes = trace.filter((node) => node.execution_status === "reused" || node.reused_from_run_id);
  const auditFiles = [...(data.audit_files || []), ...(iterationView?.artifacts || data.artifacts || []).filter((item) => item.category === "traceability")].filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index);
  const detailHTML = (detail) => Object.entries(detail || {}).filter(([, value]) => value !== null && value !== undefined && value !== "").map(([key, value]) => `<div><dt>${escapeHTML(key.replaceAll("_", " "))}</dt><dd>${escapeHTML(typeof value === "object" ? JSON.stringify(value) : String(value))}</dd></div>`).join("");
  elements.audit.innerHTML = `
    <div class="section-title"><div><span class="section-eyebrow">EXECUTION PROVENANCE</span><h2>${tr("运行审计与决策溯源", "Run audit and decision traceability")}</h2><p>${escapeHTML(data.session_id)} · ${tr(`${events.length} 个阶段事件`, `${events.length} stage events`)} · ${tr(`${trace.length} 个Skill节点`, `${trace.length} Skill nodes`)}</p></div><span class="tag">${data.status === "succeeded" ? tr("已固化", "Finalized") : tr("运行中", "In progress")}</span></div>
    ${trace.length ? `<section class="audit-summary"><dl><div><dt>${tr("执行节点", "Executed nodes")}</dt><dd>${trace.length}</dd></div><div><dt>${tr("节点累计耗时", "Cumulative node duration")}</dt><dd>${formatNumber(totalDuration, 3)}<small>s</small></dd></div><div><dt>${tr("节点警告", "Node warnings")}</dt><dd>${warningCount}</dd></div><div><dt>${tr("可下载审计文件", "Downloadable audit files")}</dt><dd>${auditFiles.length}</dd></div></dl></section>
    <section class="audit-node-section"><header><h3>${tr("逐 Skill 执行记录", "Per-Skill execution records")}</h3><p>${tr("模型版本、随机种子、输入哈希、耗时和产物均来自实际执行结果。", "Model versions, random seeds, input hashes, durations, and artifacts come from actual execution results.")}</p></header><div class="table-wrap"><table class="audit-node-table"><thead><tr><th>#</th><th>Skill</th><th>${tr("版本", "Version")}</th><th>${tr("状态", "Status")}</th><th>${tr("耗时/s", "Duration / s")}</th><th>${tr("随机种子", "Seed")}</th><th>${tr("输入哈希", "Input hash")}</th><th>${tr("产物", "Artifacts")}</th></tr></thead><tbody>${trace.map((node, index) => `<tr><td>${index + 1}</td><td><strong>${escapeHTML(skillName(node.skill_id))}</strong><small>${escapeHTML(node.skill_id || "")}</small></td><td>${escapeHTML(node.skill_version || "—")}</td><td><span class="audit-node-status ${escapeAttribute(node.status || "")}">${escapeHTML(node.status || "—")}</span></td><td>${formatNumber(node.duration_seconds, 4)}</td><td>${escapeHTML(node.seed ?? "—")}</td><td><code title="${escapeAttribute(node.input_hash || "")}">${escapeHTML((node.input_hash || "—").slice(0, 12))}</code></td><td>${(node.artifacts || []).length}</td></tr>`).join("")}</tbody></table></div></section>` : ""}
    ${reusedNodes.length ? `<section class="audit-files"><header><h3>${tr("经核验复用的上游结果", "Verified reuse of upstream results")}</h3></header><ul>${reusedNodes.map((node) => `<li><strong>${escapeHTML(skillName(node.skill_id))}</strong> <code>${escapeHTML(node.reused_from_run_id || "")}</code> <span>${tr("输入与模型哈希一致；产物已独立保存", "Matching input and model hashes; artifacts saved independently")}</span></li>`).join("")}</ul></section>` : ""}
    ${auditFiles.length ? `<section class="audit-files"><header><h3>${tr("审计文件", "Audit files")}</h3></header><div>${auditFiles.map((item) => `<a href="${escapeAttribute(downloadURL(item.url))}"><i data-lucide="file-check-2" aria-hidden="true"></i><span><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(artifactDescription(item))}</small></span><i data-lucide="download" aria-hidden="true"></i></a>`).join("")}</div></section>` : ""}
    <section class="audit-event-section"><header><h3>${tr("智能体阶段事件", "Agent stage events")}</h3><p>${tr("记录任务理解、知识检索、计划校验、人工审查、计算与结果确认。", "Records task understanding, retrieval, plan validation, human review, computation, and result confirmation.")}</p></header><div class="audit-timeline">${events.map((event) => `<div class="audit-event"><strong>${escapeHTML(auditStageName(event.stage, event.label))}</strong><time>${escapeHTML(formatTime(event.timestamp))}</time>${Object.keys(event.detail || {}).length ? `<dl>${detailHTML(event.detail)}</dl>` : ""}</div>`).join("")}</div></section>`;
}

function catalogFor(componentId) {
  return (app.health?.skills || []).find((item) => item.id === componentId);
}

function pipelineHTML(data) {
  const definitions = data.task_analysis?.task_type === "knowledge_query" ? [
    ["task_analysis", tr("问题理解", "Question understanding")],
    ["knowledge_retrieval", tr("知识检索", "Knowledge retrieval")],
    ["knowledge_answer", tr("依据证据回答", "Evidence-grounded answer")],
  ] : [
    ["task_analysis", tr("任务理解", "Task understanding")],
    ["knowledge_retrieval", tr("知识检索", "Knowledge retrieval")],
    ["execution_plan", tr("工程能力选择与计划", "Skill selection and planning")],
    ["plan_validation", tr("参数与约束校验", "Parameter and constraint validation")],
    ["human_review", tr("人工审查", "Human review")],
    ["skill_execution_finished", tr("分析与计算", "Analysis and computation")],
    ["iteration_interpretation", tr("结果解释", "Result interpretation")],
    ["result_review", tr("结果审查与反馈", "Result review and feedback")],
    ["final_acceptance", tr("最终方案确认", "Final confirmation")],
  ];
  const stages = new Set((data.events || []).map((event) => event.stage));
  if (stages.has("human_revision")) stages.add("human_review");
  let activeFound = false;
  return `<ol class="run-progress">${definitions.map(([stage, label]) => {
    const done = stages.has(stage) || (stage === "human_review" && ["executing", "awaiting_result_review", "succeeded"].includes(data.status));
    let state = done ? "done" : "";
    if (!done && !activeFound && !["succeeded", "rejected", "failed"].includes(data.status)) {
      state = "active";
      activeFound = true;
    }
    return `<li class="${state}"><span class="progress-icon"><i data-lucide="${stageIcons[stage] || "circle"}" aria-hidden="true"></i></span><span>${escapeHTML(label)}</span></li>`;
  }).join("")}</ol>`;
}

function validationHTML(validation) {
  if (!validation) return `<div class="validation-warning">${tr("等待结构化输入与工程约束校验。", "Waiting for Pydantic Schema and engineering-constraint validation.")}</div>`;
  const issues = validation.issues || [];
  const errors = issues.filter((item) => item.severity === "error");
  const className = errors.length ? "validation-error" : issues.length ? "validation-warning" : "validation-ok";
  const summary = errors.length
    ? tr(`校验未通过：${errors.length}项错误`, `Validation failed: ${errors.length} errors`)
    : issues.length
      ? tr(`校验通过，包含${issues.length}项工程提示`, `Validation passed with ${issues.length} engineering notes`)
      : tr("校验通过，输入满足工程契约", "Validation passed; the input satisfies the engineering contract");
  const checks = [
    ["registered_ok", tr("注册信息", "Registry")],
    ["schema_ok", tr("结构契约", "Schema")],
    ["type_ok", tr("类型", "Types")],
    ["dependency_ok", tr("依赖", "Dependencies")],
    ["dag_ok", tr("无环", "Acyclic")],
    ["binding_ok", tr("绑定", "Bindings")],
  ];
  const icon = errors.length ? "circle-x" : issues.length ? "triangle-alert" : "circle-check";
  return `<div class="${className}"><i data-lucide="${icon}" aria-hidden="true"></i><span>${escapeHTML(summary)}</span></div><div class="validation-checks">${checks.map(([key, label]) => `<span class="${validation[key] === false ? "failed" : "passed"}"><i data-lucide="${validation[key] === false ? "x" : "check"}" aria-hidden="true"></i>${escapeHTML(label)}</span>`).join("")}</div>${issues.length ? `<ul class="issue-list">${issues.map((item) => `<li>${app.language === "en-US" ? `<strong>${escapeHTML(item.code)}</strong>` : ""}<span>${escapeHTML(item.message)}</span></li>`).join("")}</ul>` : ""}`;
}

function reviewHTML(data) {
  if (data.historical_read_only) return renderCalculationContract({historical_read_only: true});
  if (!data.review || !data.plan) return "";
  const reviewKey = `${data.session_id}:${data.review.type}:${data.iteration || 0}:${data.updated_at}`;
  if (app.reviewKey !== reviewKey) {
    app.reviewKey = reviewKey;
    app.reviewDraft = JSON.parse(JSON.stringify(data.plan.request_payload || {}));
    app.reviewOriginal = JSON.parse(JSON.stringify(data.plan.request_payload || {}));
    app.reviewTargets = [...(data.plan.target_skill_ids || [])];
    app.reviewTargetsOriginal = [...(data.plan.target_skill_ids || [])];
  }
  const revisionOnly = data.review.type === "request_revision";
  const resultReview = data.review.type === "result_review";
  const clarification = data.review.type === "feedback_clarification";
  const executionRecovery = data.review.type === "execution_recovery";
  const allowed = data.review.allowed_actions || (revisionOnly ? ["edit", "reject"] : ["approve", "edit", "reject"]);
  const fields = reviewFields().filter(([key]) => Object.hasOwn(app.reviewDraft || {}, key)).map(([key, label, type, choices]) => {
    const value = app.reviewDraft[key];
    if (type === "readonly") return `<label>${escapeHTML(label)}<input type="text" value="${escapeAttribute(tr("显式PGA电力情景", "Explicit-PGA electricity scenario"))}" readonly aria-readonly="true"></label>`;
    if (type === "json") return `<label class="review-json-field">${escapeHTML(label)}<textarea data-review-field="${escapeAttribute(key)}" data-review-type="json" rows="3" spellcheck="false">${escapeHTML(JSON.stringify(value, null, 2))}</textarea></label>`;
    if (type === "select") {
      const labels = {most_likely:tr("最大概率损伤状态", "Most-likely damage state"),sampled:tr("固定种子单次损伤情景", "Fixed-seed single damage scenario"),function_loss_area:tr("累计功能损失", "Cumulative function loss"),target_time:tr("目标供电达标时间", "Time to target supply")};
      return `<label>${escapeHTML(label)}<select data-review-field="${escapeAttribute(key)}">${choices.map((choice) => `<option value="${choice}" ${choice === value ? "selected" : ""}>${escapeHTML(labels[choice] || choice)}</option>`).join("")}</select></label>`;
    }
    if (type === "scenario") {
      return `<label>${escapeHTML(label)}<input data-review-field="${escapeAttribute(key)}" data-review-type="scenario" type="text" value="${escapeAttribute(formatScenarioSelection(value))}" placeholder="${tr("全部；0.4；0.1-0.4", "all; 0.4; 0.1-0.4")}"></label>`;
    }
    return `<label>${escapeHTML(label)}<input data-review-field="${escapeAttribute(key)}" type="number" step="${["seed","team_count","ga_population","ga_generations"].includes(key) ? "1" : "any"}" value="${escapeAttribute(value)}"></label>`;
  }).join("");
  const availableTargets = data.review.allowed_target_skill_ids || [];
  const executionSkillIds = data.plan.selected_skill_ids?.length
    ? data.plan.selected_skill_ids
    : data.plan.component_id ? [data.plan.component_id] : [];
  const executionSkillSet = new Set(executionSkillIds);
  const targetControls = availableTargets.length
    ? `<fieldset class="target-selector"><legend>${tr("本次执行的工程能力", "Skills in this execution")} <small>${tr("目标可调整，所需依赖由能力注册表自动补全", "Targets are editable; the Registry resolves dependencies automatically")}</small></legend>${availableTargets.map((skillId) => {
      const isTarget = app.reviewTargets.includes(skillId);
      const isInExecution = executionSkillSet.has(skillId);
      const isAutomaticDependency = isInExecution && !isTarget;
      const className = [isInExecution || isTarget ? "selected" : "", isAutomaticDependency ? "auto-selected" : ""].filter(Boolean).join(" ");
      const inputAttributes = isAutomaticDependency
        ? `data-execution-skill="${escapeAttribute(skillId)}" checked disabled aria-label="${escapeAttribute(tr(`${skillName(skillId)}，自动依赖，已包含在本次执行中`, `${skillName(skillId)}, automatically included by the Registry`))}"`
        : `data-target-skill="${escapeAttribute(skillId)}" ${isTarget ? "checked" : ""}`;
      const role = isTarget ? tr("目标", "Target") : isAutomaticDependency ? tr("自动依赖", "Auto dependency") : tr("可选", "Optional");
      return `<label class="${className}"><input type="checkbox" ${inputAttributes}><span><strong>${escapeHTML(skillName(skillId))}</strong>${app.language === "en-US" ? `<code>${escapeHTML(skillId)}</code>` : ""}</span><em>${role}</em></label>`;
    }).join("")}</fieldset>`
    : "";
  const heading = resultReview
    ? tr(`第 ${formatNumber(data.review.iteration || data.iteration, 0)} 轮结果审查`, `Round ${formatNumber(data.review.iteration || data.iteration, 0)} result review`)
    : clarification
      ? tr("请澄清专家修订要求", "Clarify the expert revision request")
      : executionRecovery
        ? tr("工程能力分析与计算异常", "Engineering Skills analysis and computation failed")
        : revisionOnly
          ? tr("参数需要补充或修订", "Parameters require revision")
          : tr("请审核工程能力执行方案", "Review the Engineering Skills execution plan");
  const changeGroups = [
    ["hard_constraints", tr("硬约束变更", "Hard constraint changes")],
    ["preferences", tr("决策偏好变更", "Decision preference changes")],
    ["engineering_parameters", tr("工程参数变更", "Engineering parameter changes")],
  ];
  const changes = changeGroups.flatMap(([key, label]) =>
    (data.review.constraint_changes?.[key] || []).map((item) => `<tr><td>${escapeHTML(label)}</td><td><code>${escapeHTML(item.field)}</code></td><td>${escapeHTML(JSON.stringify(item.before ?? null))}</td><td>${escapeHTML(JSON.stringify(item.after ?? null))}</td></tr>`)
  );
  const actionButtons = [
    allowed.includes("approve") ? `<button class="approve-button" data-decision-action="approve" type="button"><i data-lucide="play" aria-hidden="true"></i>${tr("批准并开始分析与计算", "Approve and start analysis")}</button>` : "",
    allowed.includes("accept") ? `<button class="approve-button" data-decision-action="accept" type="button"><i data-lucide="badge-check" aria-hidden="true"></i>${tr("接受本轮结果并完成", "Accept this result and finish")}</button>` : "",
    allowed.includes("edit") ? `<button class="edit-button" data-decision-action="edit" type="button"><i data-lucide="pencil-line" aria-hidden="true"></i>${tr("修改并重新校验", "Revise and revalidate")}</button>` : "",
    allowed.includes("revise") ? `<button class="edit-button" data-decision-action="revise" type="button"><i data-lucide="message-square" aria-hidden="true"></i>${tr("提交专家反馈", "Submit expert feedback")}</button>` : "",
    allowed.includes("retry") ? `<button class="approve-button" data-decision-action="retry" type="button"><i data-lucide="rotate-cw" aria-hidden="true"></i>${tr("使用当前参数重试", "Retry with current parameters")}</button>` : "",
    allowed.includes("reject") ? `<button class="reject-button" data-decision-action="reject" type="button"><i data-lucide="x" aria-hidden="true"></i>${executionRecovery ? tr("终止本轮尝试", "Cancel this execution attempt") : resultReview ? tr("拒绝本轮结果", "Reject this result") : tr("拒绝本次方案", "Reject this plan")}</button>` : "",
  ].join("");
  return `<div class="review-panel">
    <div class="review-heading"><span><i data-lucide="${resultReview ? "clipboard-check" : "user-round-check"}" aria-hidden="true"></i></span><div><small>${resultReview ? tr("专家结果审查", "EXPERT REVIEW") : tr("人工审批节点", "APPROVAL GATE")}</small><h3>${escapeHTML(heading)}</h3></div></div>
    <p>${escapeHTML(data.review.message || tr("核对评估模式、计算规模、模型链和警告后再批准执行。", "Verify the assessment mode, computation scale, model chain, and warnings before approval."))}</p>
    ${changes.length ? `<div class="table-wrap"><table><thead><tr><th>${tr("类别", "Category")}</th><th>${tr("字段", "Field")}</th><th>${tr("上一轮", "Previous")}</th><th>${tr("拟采用", "Proposed")}</th></tr></thead><tbody>${changes.join("")}</tbody></table></div>` : ""}
    ${resultReview ? `<div class="review-result-summary"><strong>${tr("本轮运行ID", "Run ID for this round")}</strong><span class="mono">${escapeHTML(data.review.result?.run_id || data.skill_result?.run_id || "—")}</span><p>${escapeHTML((data.review.interpretation || "").slice(0, 260))}${(data.review.interpretation || "").length > 260 ? "…" : ""}</p></div>` : ""}
    ${executionRecovery ? `<div class="validation-error"><strong>${tr(`第 ${formatNumber(data.review.attempt, 0)} / ${formatNumber(data.review.max_attempts, 0)} 次尝试失败`, `Attempt ${formatNumber(data.review.attempt, 0)} of ${formatNumber(data.review.max_attempts, 0)} failed`)}</strong><br>${escapeHTML(data.review.error?.message || tr("未知执行错误", "Unknown execution error"))}</div>` : ""}
    <div class="review-identity"><label>${tr("审查人", "Reviewer")}<input id="reviewer-id" value="local-user"></label><label>${tr("审查角色", "Reviewer role")}<select id="reviewer-role"><option value="engineer" ${resultReview || clarification ? "" : "selected"}>${tr("工程人员", "Engineer")}</option><option value="domain_expert" ${resultReview || clarification ? "selected" : ""}>${tr("领域专家", "Domain expert")}</option><option value="emergency_manager">${tr("应急管理者", "Emergency manager")}</option></select></label></div>
    <div class="review-fields">${fields}</div>
    ${targetControls}
    <details class="advanced-json"><summary>${tr("查看并编辑完整请求参数", "View and edit the full request_payload")}</summary><textarea id="review-json" spellcheck="false">${escapeHTML(JSON.stringify(app.reviewDraft, null, 2))}</textarea></details>
    <textarea class="review-feedback" id="review-feedback" rows="3" placeholder="${resultReview || clarification ? tr("输入专家判断、参数调整或方案优化要求", "Enter expert judgment, parameter changes, or plan-optimization requirements") : tr("专家意见或拒绝原因（可选）", "Expert comments or reason for rejection (optional)")}"></textarea>
    <div class="review-actions">${actionButtons}</div>
  </div>`;
}

function expertMemoryHTML(data) {
  const memory = data.expert_memory;
  if (!memory) return "";
  const { notes = [], experiences = [], retrieved = [], available, scope } = memory;
  const hasEntries = notes.length || experiences.length || retrieved.length;
  if (!hasEntries && !available) return "";
  const kinds = {
    fact: tr("现场事实", "Field fact"),
    hard_constraint: tr("硬约束", "Hard constraint"),
    preference: tr("偏好", "Preference"),
    rationale: tr("判断依据", "Rationale"),
    open_question: tr("待核事项", "Open question"),
  };
  const statuses = {
    proposed: tr("待确认", "Proposed"),
    confirmed: tr("已确认", "Confirmed"),
    withdrawn: tr("已撤回", "Withdrawn"),
    active: tr("可供复用", "Active"),
    expired: tr("已过期", "Expired"),
    revoked: tr("已撤回", "Revoked"),
  };
  const reviewerField = (name) => `<label>${tr("复核人编号", "Reviewer ID")}<input name="${name}" required maxlength="128" autocomplete="off"></label>`;
  const canReview = notes.some((note) => ["proposed", "confirmed"].includes(note.status))
    || experiences.some((item) => ["active", "expired"].includes(item.status));
  const renderExperience = (item, allowRevoke) => `<li>
    <strong>${escapeHTML(item.principle)}</strong>
    <span>${tr("适用条件", "Applicability")} · ${escapeHTML(item.applicability)}</span>
    <span>${escapeHTML(item.id)} · ${tr("版本", "Version")} ${escapeHTML(item.version)}${allowRevoke ? ` · ${escapeHTML(statuses[item.status] || item.status)}` : ""}${item.valid_until ? ` · ${tr("有效至", "Valid until")} ${escapeHTML(item.valid_until)}` : ""}</span>
    ${item.tags?.length ? `<span>${escapeHTML(item.tags.join(" · "))}</span>` : ""}
    ${allowRevoke && item.status !== "revoked" ? `<button type="button" class="reject-button" data-memory-action="revoke" data-memory-id="${escapeAttribute(item.id)}">${tr("撤回经验", "Revoke experience")}</button>` : ""}
  </li>`;

  return `<section class="inspector-section" data-expert-memory>
    <header><strong>${tr("专家反馈记忆", "Expert feedback memory")}</strong></header>
    <div class="inspector-section-body expert-memory">
      ${hasEntries ? "" : `<p>${tr("提交专家意见后，可在这里核对提取的要点并整理可复用经验。", "After submitting feedback, review extracted notes here and prepare experience for reuse.")}</p>`}
      ${canReview ? `<div class="expert-memory-reviewer">${reviewerField("memory_reviewer")}</div>` : ""}
      ${notes.length ? `<h4>${tr("本案意见", "Case notes")}</h4>
        <p>${tr("逐条核对原文。确认要点只更新本案记忆，工程方案仍在审批区审核。", "Check each source excerpt. Confirming a note updates case memory. Use plan review for engineering approval.")}</p>
        <ul class="evidence-list">${notes.map((note) => `<li>
          <span>${escapeHTML(tr(`第 ${note.iteration} 轮`, `Round ${note.iteration}`))} · ${escapeHTML(kinds[note.kind] || note.kind)} · ${note.kind === "open_question" && note.status === "confirmed" ? tr("已记录，仍待核", "Recorded for follow-up") : escapeHTML(statuses[note.status] || note.status)}</span>
          <strong>${escapeHTML(note.text)}</strong>
          <blockquote aria-label="${tr("原文片段", "Source excerpt")}">${escapeHTML(note.source_excerpt)}</blockquote>
          <div class="expert-memory-actions">
            ${note.status === "proposed" ? `<button type="button" class="edit-button" data-memory-action="confirm" data-memory-id="${escapeAttribute(note.id)}">${tr("确认要点", "Confirm note")}</button>` : ""}
            ${["proposed", "confirmed"].includes(note.status) ? `<button type="button" class="reject-button" data-memory-action="withdraw" data-memory-id="${escapeAttribute(note.id)}" aria-label="${tr("撤回要点及关联经验", "Withdraw note and linked experience")}">${tr("撤回要点", "Withdraw note")}</button>` : ""}
          </div>
          ${available && scope && note.domain === scope.domain && note.target_system === scope.target_system && note.status === "confirmed" && note.kind !== "open_question" ? `<details class="expert-memory-publish">
            <summary>${tr("整理为跨案经验", "Prepare reusable experience")}</summary>
            <form data-memory-publish="${escapeAttribute(note.id)}">
              <p>${tr("请另写可复用的原则和适用条件，去除人员、机构和本案编号。", "Write a transferable principle and its applicability. Remove personal, institutional, and case identifiers.")}</p>
              <label>${tr("经验原则", "Principle")}<textarea name="principle" rows="3" required maxlength="1600"></textarea></label>
              <label>${tr("适用条件", "Applicability")}<textarea name="applicability" rows="2" required maxlength="1000"></textarea></label>
              <label>${tr("检索关键词，用逗号分隔", "Search keywords, comma separated")}<input name="tags" autocomplete="off"></label>
              <label>${tr("有效期（可选）", "Expiry date (optional)")}<input name="valid_until" type="date"></label>
              ${reviewerField("reviewer")}
              <button type="submit" class="edit-button">${tr("审核并发布经验", "Review and publish experience")}</button>
            </form>
          </details>` : ""}
        </li>`).join("")}</ul>` : ""}
      ${experiences.length ? `<h4>${tr("本案发布的经验", "Experience published from this case")}</h4><ul class="evidence-list">${experiences.map((item) => renderExperience(item, true)).join("")}</ul>` : ""}
      ${retrieved.length ? `<h4>${tr("跨案经验建议", "Experience from prior cases")}</h4>
        <p>${tr("请按本案条件复核。经验仅提供参考，不会直接改动工程计划。", "Check applicability to this case. Experience is advisory and does not update the engineering plan.")}</p>
        <ul class="evidence-list">${retrieved.map((item) => renderExperience(item, false)).join("")}</ul>` : ""}
    </div>
  </section>`;
}

function bindExpertMemory(data, panel) {
  const sessionId = data.session_id;
  const reviewer = $("[name='memory_reviewer']", panel);
  const buttons = $$("button", panel);
  if (app.expertMemoryRequests.has(sessionId)) buttons.forEach((button) => { button.disabled = true; });

  async function submit(payload) {
    if (app.expertMemoryRequests.has(sessionId)) return;
    app.expertMemoryRequests.add(sessionId);
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const memory = await api(localizedAPIPath(`/api/sessions/${encodeURIComponent(sessionId)}/expert-memory`), {
        method: "POST", body: JSON.stringify(payload),
      });
      if (app.current?.session_id !== sessionId) return;
      app.current = { ...app.current, expert_memory: memory };
      const livePanel = $("[data-expert-memory]", elements.inspectorContent);
      if (livePanel) {
        const reviewerValue = $("[name='memory_reviewer']", livePanel)?.value;
        livePanel.outerHTML = expertMemoryHTML(app.current);
        const nextPanel = $("[data-expert-memory]", elements.inspectorContent);
        if (nextPanel) {
          const nextReviewer = $("[name='memory_reviewer']", nextPanel);
          if (nextReviewer && reviewerValue) nextReviewer.value = reviewerValue;
          app.expertMemoryRequests.delete(sessionId);
          bindExpertMemory(app.current, nextPanel);
        }
      }
      app.expertMemoryRenderKey = JSON.stringify([sessionId, app.language, memory]);
      toast(tr("专家记忆已更新。", "Expert memory updated."));
    } catch (error) {
      if (app.current?.session_id === sessionId) toast(error.message, "error");
    } finally {
      app.expertMemoryRequests.delete(sessionId);
      if (app.current?.session_id === sessionId) {
        $$("[data-expert-memory] button", elements.inspectorContent).forEach((button) => { button.disabled = false; });
      }
    }
  }

  $$('[data-memory-action]', panel).forEach((button) => button.addEventListener("click", () => {
    const value = reviewer?.value.trim();
    if (!value) {
      toast(tr("请输入本次复核人编号。", "Enter the reviewer ID for this action."), "error");
      reviewer?.focus();
      return;
    }
    const { memoryAction: action, memoryId: id } = button.dataset;
    const item = action === "revoke" ? { item_id: id } : { note_id: id };
    submit({ action, reviewer: value, ...item });
  }));

  $$('[data-memory-publish]', panel).forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = new FormData(form);
    const principle = fields.get("principle").trim();
    const applicability = fields.get("applicability").trim();
    const publisher = fields.get("reviewer").trim();
    const tags = fields.get("tags").split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean);
    const validUntil = fields.get("valid_until");
    if (!principle || !applicability || !publisher || tags.length > 12 || tags.some((tag) => tag.length > 64)) {
      toast(tr("请填写原则、适用条件和复核人。关键词最多12个，每个不超过64个字符。", "Enter the principle, applicability, and reviewer. Use at most 12 keywords of up to 64 characters each."), "error");
      return;
    }
    submit({
      action: "publish", note_id: form.dataset.memoryPublish, reviewer: publisher,
      publication: { principle, applicability, tags, ...(validUntil ? { valid_until: validUntil } : {}) },
    });
  }));
}

function knowledgeUsageHTML(data) {
  const traces = data.knowledge_usage || [];
  if (!traces.length) return "";
  const titles = {
    plan: tr("执行前核查", "Pre-execution review"),
    answer: tr("知识问答", "Knowledge answer"),
    interpretation: tr("结果解释", "Result interpretation"),
    feedback: tr("反馈补充检索", "Retrieval for feedback"),
    follow_up: tr("结果追问", "Result follow-up"),
  };
  const planned = data.review?.type === "human_review" ? (data.review.knowledge_checks || []) : [];
  const cards = traces.slice(-5).reverse().map(trace => {
    const sources = trace.resolved_references || [];
    const label = titles[trace.stage] || trace.stage;
    const unresolved = trace.unknown_reference_count || 0;
    return `<li>
      <strong>${escapeHTML(label)}</strong>
      <span>${escapeHTML(tr(`提供 ${trace.provided_count} 条 · 引用定位成功 ${sources.length} 条`,
                             `${trace.provided_count} supplied · ${sources.length} references resolved`))}</span>
      ${unresolved ? `<span>${escapeHTML(tr(`${unresolved} 条引用编号未匹配`, `${unresolved} unmatched reference IDs`))}</span>` : ""}
      ${sources.map(source => `<p>${escapeHTML(source.title || source.evidence_id)}
        ${escapeHTML(source.section || source.locator || "")}
        ${source.purpose === "background_only" ? escapeHTML(tr("（仅供背景查证）", " (background only)")) : ""}
        <code>${escapeHTML(source.evidence_id)}</code></p>`).join("")}
    </li>`;
  });
  const review = planned.length ? `<ul class="evidence-list">${planned.map(check => `<li>
    <strong>${escapeHTML(check.review_question)}</strong>
    <p>${escapeHTML(check.source_excerpt)}</p>
    <code>${escapeHTML(check.evidence_id)}</code>
  </li>`).join("")}</ul>` : "";
  return `<section class="inspector-section">
    <header><strong>${tr("知识使用记录", "Knowledge use")}</strong></header>
    <div class="inspector-section-body">${review}<ul class="evidence-list">${cards.join("")}</ul></div>
  </section>`;
}

function renderInspector(data) {
  const analysis = data.task_analysis;
  const evidence = data.knowledge_evidence || [];
  const plan = data.plan;
  const chain = plan ? (plan.selected_skill_ids?.length ? plan.selected_skill_ids : [plan.component_id]) : [];
  const targetSet = new Set(plan?.target_skill_ids || []);
  const skillProgress = data.skill_progress;
  const progressById = new Map((skillProgress?.components || []).map((item) => [item.component_id, item.status]));
  const review = reviewHTML(data);
  const memoryKey = JSON.stringify([data.session_id, app.language, data.expert_memory]);
  const memoryPanel = memoryKey === app.expertMemoryRenderKey ? $("[data-expert-memory]", elements.inspectorContent) : null;
  elements.inspectorContent.innerHTML = `
    ${review}
    <div data-memory-mount>${memoryPanel ? "" : expertMemoryHTML(data)}</div>
    ${knowledgeUsageHTML(data)}
    <section class="inspector-section"><header><strong>${tr("决策流程", "Decision process")}</strong><span>${escapeHTML(statusLabel(data.status))}</span></header><div class="inspector-section-body">${pipelineHTML(data)}</div></section>
    ${analysis ? `<section class="inspector-section"><header><strong>${tr("任务理解", "Task understanding")}</strong><span>${tr("语言模型", "LLM")}</span></header><div class="inspector-section-body"><p class="analysis-objective">${escapeHTML(analysis.objective)}</p><dl class="meta-grid"><dt>${tr("任务类型", "Task type")}</dt><dd>${analysis.task_type === "knowledge_query" ? tr("知识问答", "Knowledge query") : tr("工程计算", "Engineering computation")}</dd><dt>${tr("评估模式", "Assessment mode")}</dt><dd>${escapeHTML(analysis.assessment_mode ? assessmentModeName(analysis.assessment_mode) : tr("不适用", "Not applicable"))}</dd><dt>${tr("工程范围", "Engineering scope")}</dt><dd>${escapeHTML(analysis.engineering_scope)}</dd><dt>${tr("目标工程能力", "Target Skills")}</dt><dd>${escapeHTML((analysis.selected_skill_ids || []).map((item) => skillName(item)).join(app.language === "en-US" ? ", " : "、") || tr("无需工程计算", "No engineering computation required"))}</dd><dt>${tr("缺失信息", "Missing information")}</dt><dd>${analysis.missing_information?.length ? escapeHTML(analysis.missing_information.map((item) => localizedMissingInformation(item)).join(app.language === "en-US" ? "; " : "；")) : tr("无", "None")}</dd></dl></div></section>` : ""}
    ${evidence.length ? `<section class="inspector-section"><header><strong>${tr("知识检索依据", "Retrieved knowledge evidence")}</strong><span>${tr(`${evidence.length} 条依据`, `${evidence.length} hits`)}</span></header><div class="inspector-section-body"><ul class="evidence-list">${evidence.map((item) => { const title = escapeHTML(item.title || item.evidence_id); const linkedTitle = /^https?:\/\//.test(item.source_url || "") ? `<a href="${escapeAttribute(item.source_url)}" target="_blank" rel="noreferrer"><strong>${title}</strong></a>` : `<strong>${title}</strong>`; return `<li>${linkedTitle}<span class="evidence-score">${escapeHTML(item.citation || item.evidence_id)} · ${tr("相关度", "score")} ${formatNumber(item.score, 3)}</span>${item.locator ? `<span>${escapeHTML(item.locator)}</span>` : ""}<span>${escapeHTML(item.snippet || "")}</span></li>`; }).join("")}</ul></div></section>` : ""}
    ${plan ? `<section class="inspector-section"><header><strong>${tr("工程能力计划", "Engineering Skills plan")}</strong><span>${skillProgress ? tr(`${skillProgress.completed}/${skillProgress.total} 已完成`, `${skillProgress.completed}/${skillProgress.total} completed`) : tr(`${chain.length} 个节点`, `${chain.length} nodes`)}</span></header><div class="inspector-section-body"><div class="skill-legend"><span><i class="legend-target"></i>${tr("任务目标能力", "LLM target Skill")}</span><span><i class="legend-dependency"></i>${tr("自动补全依赖", "Registry dependency")}</span></div><dl class="meta-grid"><dt>${tr("组合来源", "Composition source")}</dt><dd>${tr("工程能力注册表动态编译", "Dynamic Skill Registry compilation")}</dd><dt>${tr("输入契约", "Input contract")}</dt><dd>${app.language === "en-US" ? escapeHTML(plan.input_profile_id || plan.component_id) : tr("电力系统统一分析契约", "Power analysis contract")}</dd><dt>${tr("组合模式", "Composition mode")}</dt><dd>${escapeHTML(compositionModeName(plan.composition_mode))}</dd></dl><ol class="skill-chain">${chain.map((skillId, index) => `<li class="${escapeAttribute(progressById.get(skillId) || "")} ${targetSet.has(skillId) ? "is-target" : "is-dependency"}"><span class="skill-index">${String(index + 1).padStart(2, "0")}</span><span class="skill-copy"><strong>${escapeHTML(skillName(skillId))}</strong>${app.language === "en-US" ? `<code>${escapeHTML(skillId)}</code>` : ""}</span><small class="skill-role">${targetSet.has(skillId) ? tr("目标", "Target") : tr("依赖", "Dependency")}</small></li>`).join("")}</ol><p class="analysis-objective plan-rationale">${app.language === "en-US" ? escapeHTML(plan.rationale || "") : tr("已按任务目标和能力依赖生成确定性执行顺序。内部组合原因与原始标识保留在运行审计中。", "")}</p></div></section>` : ""}
    ${analysis?.task_type !== "knowledge_query" ? `<section class="inspector-section"><header><strong>${tr("工程参数校验", "Engineering parameter validation")}</strong><span>${tr("结构化校验", "Pydantic")}</span></header><div class="inspector-section-body">${validationHTML(data.validation)}</div></section>` : ""}
    ${(data.iterations || []).length ? `<section class="inspector-section"><header><strong>${tr("方案迭代记录", "Plan iteration history")}</strong><span>${tr(`${data.iterations.length} 轮`, `${data.iterations.length} rounds`)}</span></header><div class="inspector-section-body"><ol class="iteration-list">${data.iterations.map((item) => `<li><button type="button" data-iteration-jump="${item.iteration}"><strong>${tr(`第 ${formatNumber(item.iteration, 0)} 轮`, `Round ${formatNumber(item.iteration, 0)}`)}</strong><span>${escapeHTML(decisionActionName(item.expert_decision?.action || "pending"))}</span><code>${escapeHTML(item.run_id || "")}</code></button></li>`).join("")}</ol></div></section>` : ""}
    ${data.skill_result ? `<section class="inspector-section"><header><strong>${tr("运行溯源", "Run provenance")}</strong><span>${tr("统一结果", "SkillResult")}</span></header><div class="inspector-section-body"><dl class="meta-grid"><dt>${tr("运行ID", "Run ID")}</dt><dd class="mono">${escapeHTML(data.skill_result.run_id)}</dd><dt>${tr("工程能力", "Skill")}</dt><dd>${escapeHTML(skillName(data.skill_result.skill_id))}</dd><dt>${tr("模型版本", "Model version")}</dt><dd>${escapeHTML(data.skill_result.provenance?.skill_version || "—")}</dd><dt>${tr("运行时间", "Runtime")}</dt><dd>${formatNumber(data.skill_result.provenance?.duration_seconds, 2)} ${tr("秒", "s")}</dd><dt>${tr("随机种子", "Random seed")}</dt><dd>${escapeHTML(data.skill_result.provenance?.seed ?? "—")}</dd></dl></div></section>` : ""}`;
  bindReviewActions(data);
  if (memoryPanel) {
    $("[data-memory-mount]", elements.inspectorContent).replaceChildren(memoryPanel);
  } else {
    const newPanel = $("[data-expert-memory]", elements.inspectorContent);
    if (newPanel) bindExpertMemory(data, newPanel);
  }
  app.expertMemoryRenderKey = memoryKey;
  hydrateIcons();
  $$('[data-iteration-jump]', elements.inspectorContent).forEach((button) => button.addEventListener("click", () => {
    selectIteration(data, button.dataset.iterationJump, { manual: true });
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    renderResults(data);
    renderSpatial(data);
    renderArtifacts(data);
  }));
}

function bindReviewActions(data) {
  if (!data.review) return;
  const jsonArea = $("#review-json");
  $$('[data-review-field]', elements.inspectorContent).forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.reviewField;
      try {
        app.reviewDraft[key] = input.dataset.reviewType === "scenario"
          ? parseScenarioSelectionInput(input.value)
          : input.dataset.reviewType === "json" ? JSON.parse(input.value)
          : input.type === "number" ? Number(input.value) : input.value;
        if (jsonArea) jsonArea.value = JSON.stringify(app.reviewDraft, null, 2);
      } catch (error) {
        input.value = input.dataset.reviewType === "json" ? JSON.stringify(app.reviewDraft[key], null, 2) : formatScenarioSelection(app.reviewDraft[key]);
        toast(error.message, "error");
      }
    });
  });
  $$('[data-target-skill]', elements.inspectorContent).forEach((input) => {
    input.addEventListener("change", () => {
      app.reviewTargets = $$('[data-target-skill]:checked', elements.inspectorContent).map((item) => item.dataset.targetSkill);
      input.closest("label")?.classList.toggle("selected", input.checked);
      const badge = input.closest("label")?.querySelector("em");
      if (badge) badge.textContent = input.checked ? tr("目标", "Target") : tr("可选", "Optional");
    });
  });
  $$('[data-decision-action]', elements.inspectorContent).forEach((button) => {
    button.addEventListener("click", () => submitDecision(button.dataset.decisionAction));
  });
}

async function submitDecision(action) {
  if (!app.current) return;
  const feedback = $("#review-feedback")?.value.trim() || null;
  let payload = {
    action,
    feedback,
    reviewer: $("#reviewer-id")?.value.trim() || "local-user",
    reviewer_role: $("#reviewer-role")?.value || "engineer",
  };
  if (action === "edit" || action === "revise") {
    try {
      const parsed = JSON.parse($("#review-json")?.value || "{}");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(tr("必须是JSON对象", "The value must be a JSON object"));
      const patch = payloadPatch(app.reviewOriginal, parsed);
      const targetsChanged = JSON.stringify(app.reviewTargets || []) !== JSON.stringify(app.reviewTargetsOriginal || []);
      if (Object.keys(patch).length) payload.payload_patch = patch;
      if (targetsChanged) payload.target_skill_ids = app.reviewTargets;
      app.reviewDraft = parsed;
      if (action === "edit" && !Object.keys(patch).length && !targetsChanged) throw new Error(tr("请至少修改一个参数或目标Skill", "Change at least one parameter or target Skill"));
      if (action === "revise" && !Object.keys(patch).length && !targetsChanged && !feedback) throw new Error(tr("请填写专家修订意见，或修改参数/目标Skill", "Enter expert revision feedback or change a parameter or target Skill"));
    } catch (error) {
      toast(tr(`参数JSON无效：${error.message}`, `Invalid parameter JSON: ${error.message}`), "error");
      return;
    }
  }
  $$(".review-actions button").forEach((button) => { button.disabled = true; });
  try {
    const data = await api(localizedAPIPath(`/api/sessions/${app.current.session_id}/decision`), { method: "POST", body: JSON.stringify(payload) });
    if (action === "revise") app.autoFollowLatestIteration = true;
    showSession(data);
    const messages = {
      approve: tr("方案已批准，开始分析与计算。", "Plan approved. Analysis and computation are starting."),
      edit: tr("修改已提交，正在重新校验。", "Changes submitted. The plan is being revalidated."),
      accept: tr("本轮工程结果已接受并固化。", "This engineering result has been accepted and finalized."),
      revise: tr("专家修订已提交，正在形成下一轮受约束方案。", "Expert revisions submitted. The next constrained plan is being prepared."),
      retry: tr("已提交重试，继续执行当前工程方案。", "Retry submitted. The current engineering plan will run again."),
      reject: tr("审查拒绝已记录。", "The rejection has been recorded."),
    };
    toast(messages[action] || tr("审查决定已提交。", "The review decision has been submitted."));
    schedulePoll(500);
  } catch (error) {
    toast(error.message, "error");
    $$(".review-actions button").forEach((button) => { button.disabled = false; });
  }
}

function renderSessionList() {
  elements.sessionCount.textContent = app.sessions.length;
  if (!app.sessions.length) {
    elements.sessionList.innerHTML = `<div class="rail-empty">${tr("当前还没有运行记录", "No task runs yet")}</div>`;
    return;
  }
  elements.sessionList.innerHTML = app.sessions.map((session) => `
    <div class="session-item-shell ${app.current?.session_id === session.session_id ? "active" : ""}">
      <button class="session-item ${app.current?.session_id === session.session_id ? "active" : ""}" data-session-id="${escapeAttribute(session.session_id)}" type="button">
        <strong>${escapeHTML(session.user_message)}</strong>
        <span><span class="mini-status ${escapeAttribute(session.status)}">${escapeHTML(statusLabel(session.status))}</span><time>${escapeHTML(formatTime(session.created_at))}</time></span>
      </button>
      ${session.is_demo ? '' : `<button class="session-delete ${sessionIsBusy(session) ? "busy" : ""}" data-delete-session-id="${escapeAttribute(session.session_id)}" type="button" aria-label="${escapeAttribute(tr("删除任务", "Delete task"))}" title="${escapeAttribute(sessionIsBusy(session) ? tr("任务正在处理，完成当前操作后才能删除", "The task is running and can be deleted after the current operation finishes") : tr("删除任务", "Delete task"))}" aria-disabled="${sessionIsBusy(session)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>`}
    </div>`).join("");
  $$(".session-item", elements.sessionList).forEach((button) => button.addEventListener("click", () => openSession(button.dataset.sessionId)));
  $$(".session-delete", elements.sessionList).forEach((button) => button.addEventListener("click", () => openDeleteSessionDialog(button.dataset.deleteSessionId)));
  hydrateIcons();
}

function openDeleteSessionDialog(sessionId) {
  const session = app.sessions.find((item) => item.session_id === sessionId);
  if (!session) return;
  if (sessionIsBusy(session)) {
    toast(tr("任务正在处理，完成当前操作后才能删除。", "The task is running and can be deleted after the current operation finishes."), "error");
    return;
  }
  app.pendingDeleteSessionId = sessionId;
  elements.deleteSessionName.textContent = session.user_message;
  elements.deleteSessionDialog.showModal();
  elements.deleteSessionCancel.focus();
}

function closeDeleteSessionDialog() {
  if (app.deletingSession) return;
  app.pendingDeleteSessionId = null;
  if (elements.deleteSessionDialog.open) elements.deleteSessionDialog.close();
}

async function confirmDeleteSession() {
  const sessionId = app.pendingDeleteSessionId;
  if (!sessionId || app.deletingSession) return;
  app.deletingSession = true;
  elements.deleteSessionCancel.disabled = true;
  elements.deleteSessionConfirm.disabled = true;
  elements.deleteSessionConfirm.querySelector("span").textContent = tr("正在删除", "Deleting");
  try {
    await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    const deletingCurrent = app.current?.session_id === sessionId;
    app.sessions = app.sessions.filter((session) => session.session_id !== sessionId);
    app.pendingDeleteSessionId = null;
    elements.deleteSessionDialog.close();
    if (deletingCurrent) showEmpty();
    else renderSessionList();
    toast(tr("任务及其运行文件已删除。", "The task and its run files were deleted."));
  } catch (error) {
    toast(error.message, "error");
  } finally {
    app.deletingSession = false;
    elements.deleteSessionCancel.disabled = false;
    elements.deleteSessionConfirm.disabled = false;
    elements.deleteSessionConfirm.querySelector("span").textContent = tr("永久删除", "Delete permanently");
  }
}

async function refreshSessionList() {
  try {
    const payload = await api(localizedAPIPath("/api/sessions"));
    app.sessions = payload.sessions || [];
    renderSessionList();
  } catch (error) {
    console.error(error);
  }
}

function schedulePoll(delay = 1000) {
  clearTimeout(app.pollTimer);
  if (!app.current) return;
  if (app.current.review && app.current.status !== "answering") return;
  if (["succeeded", "rejected", "failed", "awaiting_approval", "needs_input"].includes(app.current.status)) return;
  app.pollTimer = window.setTimeout(() => pollCurrent(), delay);
}

async function pollCurrent() {
  if (!app.current) return;
  const sessionId = app.current.session_id;
  const memoryAtRequest = app.current.expert_memory;
  try {
    const data = await api(localizedAPIPath(`/api/sessions/${sessionId}`));
    if (app.current?.session_id !== sessionId) return;
    // A concurrent memory action may have returned a fresher panel state.
    if (app.current.expert_memory !== memoryAtRequest) data.expert_memory = app.current.expert_memory;
    showSession(data);
    await refreshSessionList();
    schedulePoll(1000);
  } catch (error) {
    toast(error.message, "error");
    schedulePoll(2500);
  }
}

async function openSession(sessionId) {
  clearTimeout(app.pollTimer);
  closeMobileDrawers();
  try {
    const data = await api(localizedAPIPath(`/api/sessions/${sessionId}`));
    app.reviewKey = null;
    app.reviewOriginal = null;
    app.reviewTargets = null;
    app.reviewTargetsOriginal = null;
    app.selectedIteration = null;
    app.autoFollowLatestIteration = true;
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    showSession(data);
    schedulePoll(700);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function createSession() {
  const message = elements.taskInput.value.trim();
  if (!message) {
    toast(tr("请先输入需要评估或决策的问题。", "Enter an assessment or decision question first."), "error");
    elements.taskInput.focus();
    return;
  }
  elements.submitTask.disabled = true;
  elements.submitTask.querySelector("span").textContent = tr("已提交", "Submitted");
  try {
    const data = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ message, preset: app.preset, overrides: collectOverrides() }),
    });
    app.reviewKey = null;
    app.reviewOriginal = null;
    app.reviewTargets = null;
    app.reviewTargetsOriginal = null;
    app.selectedIteration = null;
    app.autoFollowLatestIteration = true;
    app.selectedScenario = null;
    app.primaryArtifactIndex = null;
    elements.taskInput.value = "";
    showSession(data);
    await refreshSessionList();
    schedulePoll(500);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements.submitTask.disabled = false;
    elements.submitTask.querySelector("span").textContent = tr("发送任务", "Send task");
  }
}

function renderSuggestions() {
  if (!app.health) return;
  const suggestions = app.health.suggested_tasks_by_language?.[app.language] || app.health.suggested_tasks || [];
  elements.suggestionList.innerHTML = suggestions.map((task, index) => `<button class="suggestion" type="button" data-suggestion-index="${index}"><span>0${index + 1} / ${tr("示例任务", "SAMPLE TASK")}</span>${escapeHTML(task)}</button>`).join("");
  $$(".suggestion", elements.suggestionList).forEach((button) => button.addEventListener("click", () => {
    elements.taskInput.value = suggestions[Number(button.dataset.suggestionIndex)];
    elements.taskInput.focus();
  }));
}

async function loadHealth() {
  try {
    app.health = await api("/api/health");
    app.healthError = false;
    renderConnectionStatus();
    renderSuggestions();
  } catch (error) {
    app.healthError = true;
    renderConnectionStatus();
    toast(tr(`无法连接本地服务：${error.message}`, `Unable to connect to the local service: ${error.message}`), "error");
  }
}

function bindUI() {
  initializeInspectorResize();
  initializeFigureLightbox();
  $$('[data-language]', elements.languageSwitch).forEach((button) => button.addEventListener("click", () => setLanguage(button.dataset.language)));
  elements.deleteSessionCancel.addEventListener("click", closeDeleteSessionDialog);
  elements.deleteSessionConfirm.addEventListener("click", confirmDeleteSession);
  elements.deleteSessionDialog.addEventListener("cancel", (event) => {
    if (app.deletingSession) event.preventDefault();
    else app.pendingDeleteSessionId = null;
  });
  elements.deleteSessionDialog.addEventListener("click", (event) => {
    if (event.target === elements.deleteSessionDialog) closeDeleteSessionDialog();
  });
  elements.deleteSessionDialog.addEventListener("close", () => {
    if (!app.deletingSession) app.pendingDeleteSessionId = null;
  });
  $$("#preset-control button").forEach((button) => button.addEventListener("click", () => setPreset(button.dataset.preset)));
  elements.parameterToggle.addEventListener("click", () => {
    const opening = elements.parameterDrawer.classList.contains("hidden");
    elements.parameterDrawer.classList.toggle("hidden", !opening);
    elements.parameterToggle.setAttribute("aria-expanded", String(opening));
  });
  elements.submitTask.addEventListener("click", createSession);
  elements.taskInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      createSession();
    }
  });
  elements.newSession.addEventListener("click", showEmpty);
  elements.sessionToggle.addEventListener("click", () => openMobileDrawer(elements.sessionRail));
  elements.closeSessions.addEventListener("click", closeMobileDrawers);
  elements.inspectorToggle.addEventListener("click", () => openMobileDrawer(elements.inspector));
  elements.closeInspector.addEventListener("click", closeMobileDrawers);
  elements.drawerBackdrop.addEventListener("click", closeMobileDrawers);
  $$(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));
}

async function init() {
  window.PowerWorkbench?.configure({
    language: () => app.language,
    onTab: activateTab,
    onReview: () => {
      document.body.classList.remove("pw-result-focus", "pw-inspector-closed");
      updatePowerReviewButton();
      if (window.innerWidth <= inspectorSizing.desktopBreakpoint) openMobileDrawer(elements.inspector);
      requestAnimationFrame(() => {
        window.PowerWorkbench?.notifyTab(app.activeTab);
        const controls = [...elements.inspector.querySelectorAll("input, select, textarea, button")]
          .filter(control => !control.disabled && control.getClientRects().length);
        const target = controls.find(control => control.id === "review-feedback") || controls.find(control => control.closest(".inspector-scroll"));
        if (target) { target.focus({preventScroll: true}); target.scrollIntoView({block: "nearest"}); }
      });
    },
    onIteration: (data, value) => {
      selectIteration(data, value, {manual: true});
      renderResults(data); renderSpatial(data); renderArtifacts(data); renderAudit(data);
    },
  });
  applyLanguage();
  bindUI();
  $("#power-review-toggle")?.addEventListener("click", () => {
    document.body.classList.toggle("pw-inspector-closed");
    updatePowerReviewButton();
    window.PowerWorkbench?.notifyTab(app.activeTab);
  });
  hydrateIcons();
  setPreset("quick");
  await Promise.all([loadHealth(), refreshSessionList()]);
  const route = new URLSearchParams(location.search);
  const initialSession = route.get("session") || app.health?.default_demo_session_id;
  const initialView = route.get("view");
  if (initialSession && app.sessions.some(item => item.session_id === initialSession)) {
    await openSession(initialSession);
    activateTab(["conversation","results","spatial","artifacts","audit"].includes(initialView) ? initialView : initialSession === app.health?.default_demo_session_id ? "results" : "conversation");
  } else {
    showEmpty();
  }
  hydrateIcons();
}

Object.assign(translations, {
  page_title: ["PowerSkillAgent | 电力系统抗震韧性决策工作台", "PowerSkillAgent | Electricity Seismic Resilience Workbench"],
  brand_subtitle: ["电力系统抗震韧性决策工作台", "Electricity Seismic Resilience Workbench"],
  yangpu: ["新西兰奥克兰", "Auckland, New Zealand"], regional_healthcare: ["城市电网", "Urban electricity grid"],
  seven_hospitals: ["468节点 · 562支路", "468 nodes · 562 branches"],
  case_label: ["奥克兰 · 电力系统", "Auckland · Electricity system"], mode_hybrid: ["显式PGA情景", "Explicit PGA scenario"],
  quick_run: ["最大概率情景", "Most-likely scenario"], formal_run: ["固定种子抽样情景", "Seeded damage scenario"],
  task_placeholder: ["例如：评估奥克兰电网在0.4g情景下的供电与韧性，比较3队修复方案，并给出地图和报告……", "Example: Assess Auckland grid supply and resilience at 0.4g, compare repair strategies with three crews, and provide maps and a report..."],
  data_source_note: ["奥克兰综合电网固定版本 · PGA为情景输入", "Frozen Auckland integrated grid version · PGA is an explicit scenario input"],
  power_damage_mode: ["损伤情景", "Damage scenario"], power_most_likely: ["最大概率状态", "Most-likely state"], power_sampled: ["固定种子抽样", "Seeded sample"],
  power_work_hours: ["每日工时 / h", "Daily working hours / h"], power_efficiency: ["工程队效率", "Crew efficiency"], power_target: ["目标供电比例", "Target supply ratio"],
  power_objective: ["恢复优化目标", "Recovery objective"], power_loss_area: ["累计功能损失", "Cumulative function loss"], power_target_time: ["目标供电达标时间", "Time to target supply"],
  power_search_constraints: ["搜索设置与施工约束", "Search settings and repair constraints"], power_population: ["GA种群", "GA population"], power_generations: ["GA代数", "GA generations"],
  power_constraints: ["前置关系、最早开工、可用队伍（JSON）", "Predecessors, release times and allowed crews (JSON)"],
});

function renderPowerTaskOverview(data, latestIteration, summary) {
  const iteration = selectedIterationView(data);
  summary = iteration?.report_summary || summary || {};
  const state = taskOverviewState(data, latestIteration);
  const order = executionOrderFor(data, summary);
  const checks = data.validation?.checks || data.plan?.input_checks ||
    ["registered_ok", "schema_ok", "type_ok", "dependency_ok", "dag_ok", "binding_ok"]
      .filter(key => typeof data.validation?.[key] === "boolean")
      .map(key => ({valid: data.validation[key]}));
  const metadata = [
    ["layers-3", tr("执行能力", "Engineering capabilities"), tr(`${order.length} 项`, `${order.length} Skills`)],
    ["shield-check", tr("输入校验", "Input checks"), checks.length ? `${checks.filter(check => check.valid).length}/${checks.length}` : tr("待校验", "Pending")],
    ["network", tr("分析对象", "Analysis objects"), tr("电力系统", "Electricity system")],
    ["repeat-2", tr("计算轮次", "Computation round"), tr(`第 ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)} 轮`, `Round ${formatNumber(latestIteration?.iteration || data.iteration || 1, 0)}`)],
  ];
  const metadataHTML = metadata.map(([icon,label,value]) => `<div><i data-lucide="${icon}" aria-hidden="true"></i><span><small>${escapeHTML(label)}</small><strong>${escapeHTML(value || "—")}</strong></span></div>`).join("");
  return `<article class="task-overview">
    <header class="overview-header"><div class="overview-title"><span class="overview-mark"><i data-lucide="clipboard-list" aria-hidden="true"></i></span><div><small>${tr("任务执行总览", "TASK EXECUTION OVERVIEW")}</small><h2>${tr("电力系统专项工程分析", "Electricity system engineering analysis")}</h2><p>${escapeHTML(data.task_analysis?.objective || data.user_message)}</p></div></div><span class="overview-status ${state.tone}"><i data-lucide="${state.icon}" aria-hidden="true"></i>${escapeHTML(state.label)}</span></header>
    ${recoveryAttemptHTML(data.recovery_attempt)}
    <div class="overview-metadata">${metadataHTML}</div>
    ${!["succeeded","rejected","failed"].includes(data.status) ? `<div class="overview-live"><span class="activity-bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>${escapeHTML(phaseMessage(data))}</strong></div>` : ""}
    ${renderExecutionScope(data,summary)}${overviewWarnings(data,summary)}${overviewActions(data,latestIteration)}${renderExpertSummary(data,latestIteration)}</article>`;
}

function referenceResultOptions() {
  return {
    language: app.language, skillName, markdown: renderMarkdown,
    onIteration: value => { selectIteration(app.current, value, {manual: true}); renderResults(app.current); renderSpatial(app.current); renderArtifacts(app.current); renderAudit(app.current); },
    onFiles: () => activateTab("artifacts"),
    onReview: () => { document.body.classList.remove("pw-inspector-closed"); updatePowerReviewButton(); if (window.innerWidth <= 980) openMobileDrawer(elements.inspector); scheduleReferenceResize(); },
  };
}

function powerRows(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.entries(value).map(([id,v]) => typeof v === "object" && v ? {id,...v} : {id,value:v});
  return [];
}
function powerCoordinates(node) {
  const geometry = node.coordinates || node.geometry?.coordinates;
  const x = node.longitude ?? node.lon ?? node.lng ?? node.x ?? geometry?.[0];
  const y = node.latitude ?? node.lat ?? node.y ?? geometry?.[1];
  return Number.isFinite(Number(x)) && Number.isFinite(Number(y)) ? [Number(x),Number(y)] : null;
}
function renderPowerSpatial(data, summary, iterationView) {
  if (window.ReferencePowerResults) {
    window.ReferencePowerResults.render(elements.spatial, data, summary, iterationView, {...referenceResultOptions(), initialTopic: "network"});
    return;
  }
  if (window.PowerWorkbench) {
    window.PowerWorkbench.renderSpatial(elements.spatial, data, summary, iterationView);
    return;
  }
  const nodes = powerRows(summary.network?.nodes).filter((n) => powerCoordinates(n));
  const links = powerRows(summary.network?.links || summary.network?.branches);
  const images = (iterationView?.artifacts || data.artifacts || []).filter((a) => a.kind === "image");
  let map = "";
  if (nodes.length) {
    const byId = new Map(nodes.map((n) => [String(n.id ?? n.node_id),n]));
    const coordinates = nodes.map(powerCoordinates);
    const xs = coordinates.map((p) => p[0]), ys = coordinates.map((p) => p[1]);
    const bounds = [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
    const project = (n) => {const p=powerCoordinates(n);return [30+(p[0]-bounds[0])/Math.max(.00001,bounds[2]-bounds[0])*840,500-(p[1]-bounds[1])/Math.max(.00001,bounds[3]-bounds[1])*460];};
    const edgeSVG = links.map((e) => {
      const a=byId.get(String(e.source ?? e.from ?? e.from_node ?? e.from_bus)),b=byId.get(String(e.target ?? e.to ?? e.to_node ?? e.to_bus));
      if (!a || !b) return "";
      const state=summary.function?.network_frame?.pipe?.function?.[String(e.id)];
      const color=state === 0 ? "#c15d48" : "#9caebc";
      const p=project(a),q=project(b);return `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${color}" stroke-width="1"><title>${escapeHTML(String(e.id || ""))}</title></line>`;
    }).join("");
    const supply = summary.function?.node_supply_mw || {};
    const nodeSVG = nodes.map((n) => {
      const id=String(n.id ?? n.node_id),p=project(n);const text=JSON.stringify(n);
      const ratio=summary.function?.network_frame?.node?.function?.[id];
      const color=ratio === 0 ? "#c15d48" : ratio != null && ratio < .999 ? "#d29b4c" : "#287f89";
      return `<circle data-power-node="${escapeAttribute(id)}" cx="${p[0]}" cy="${p[1]}" r="3.4" fill="${color}" stroke="white" stroke-width=".6" tabindex="0"><title>${escapeHTML(n.name || id)} · ${escapeHTML(text)}</title></circle>`;
    }).join("");
    map = `<section class="result-section"><h3>${tr("奥克兰电网拓扑", "Auckland grid topology")}</h3><p>${tr("悬停或选择节点查看保存属性；图中地理坐标与电气连接来自绑定版本。", "Hover over or select a node to inspect saved attributes. Coordinates and electrical connections use the bound dataset version.")}</p><div class="power-map" style="overflow:auto;border:1px solid var(--border,#d9e1e7);border-radius:10px;background:#f7fafb"><svg viewBox="0 0 900 540" style="width:100%;min-width:600px" role="img" aria-label="${tr("奥克兰电网拓扑图", "Auckland grid topology")}">${edgeSVG}${nodeSVG}</svg></div><div id="power-node-detail" class="inline-note">${tr("选择任一节点查看编号、属性及其供电结果。", "Select a node to view its identity, attributes and supply result.")}</div></section>`;
  }
  elements.spatial.innerHTML = `${priorResultNoticeHTML(data,iterationView)}<div class="section-title"><h2>${tr("电网空间分析与恢复图表", "Grid spatial analysis and recovery figures")}</h2><span class="tag">${nodes.length} ${tr("节点", "nodes")}</span></div>${map}<div class="figure-grid">${images.map((a) => `<figure class="figure-thumb" data-power-figure="${a.index}" tabindex="0"><img src="${escapeAttribute(a.url)}" alt="${escapeAttribute(a.name)}"><figcaption><strong>${escapeHTML(a.name)}</strong><span>${escapeHTML(artifactDescription(a))}</span></figcaption></figure>`).join("")}</div>${!nodes.length&&!images.length ? emptyResult(tr("当前结果没有空间数据", "No spatial data in this result"),tr("完成相应工程能力后，地图和图件将在这里显示。", "Maps and figures appear after the relevant engineering capability completes.")) : ""}`;
  $$("[data-power-node]",elements.spatial).forEach((el) => el.addEventListener("click",() => {
    const node=nodes.find((n) => String(n.id ?? n.node_id) === el.dataset.powerNode);
    const supply=summary.function?.node_supply_mw;
    const value=Array.isArray(supply) ? supply[Number(el.dataset.powerNode)-1] : supply?.[el.dataset.powerNode];
    $("#power-node-detail").innerHTML=`<strong>${escapeHTML(node?.name || el.dataset.powerNode)}</strong><pre>${escapeHTML(JSON.stringify({...node,supply_mw:value},null,2))}</pre>`;
  }));
  $$("[data-power-figure]",elements.spatial).forEach((el) => el.addEventListener("click",() => openFigureLightbox(images.find((a) => String(a.index)===el.dataset.powerFigure))));
  const impactArtifact=(iterationView?.artifacts || data.artifacts || []).find((a) => a.name === "outage_impact.json");
  if (impactArtifact) {
    const holder=document.createElement("section");holder.className="result-section";
    holder.innerHTML=`<h3>${tr("停电分区与人口影响", "Outage areas and population impact")}</h3><p>${tr("按需读取本轮保存的分区几何和时序；不重新计算。", "Load the saved zone geometry and time history on demand; no calculation is rerun.")}</p><button class="button secondary" id="load-power-impact">${tr("载入已计算分区", "Load saved outage zones")}</button><div id="power-impact-view"></div>`;
    elements.spatial.appendChild(holder);
    $("#load-power-impact",holder).addEventListener("click",async(event) => {
      const button=event.currentTarget;button.disabled=true;button.textContent=tr("正在载入…", "Loading…");
      try { const result=await api(impactArtifact.url);renderPowerImpactView(result,$("#power-impact-view",holder));button.remove(); }
      catch(error) {button.disabled=false;button.textContent=tr("重新载入分区", "Retry zone loading");toast(error.message,"error");}
    });
  }
}

function renderPowerImpactView(result,holder) {
  const strategies=result.strategies || [];
  if (!strategies.length) {holder.textContent=tr("没有已保存的分区时序。", "No saved zone timeline is available.");return;}
  let chosen=strategies.findIndex((s) => s.id === result.recommended_strategy);if(chosen<0)chosen=0;
  holder.innerHTML=`<div class="result-selectors"><select id="power-impact-strategy">${strategies.map((s,i)=>`<option value="${i}" ${i===chosen?"selected":""}>${escapeHTML(s.name || s.id)}</option>`).join("")}</select><label>${tr("保存时刻", "Saved time")}<input id="power-impact-time" type="range" min="0" value="0"><output id="power-impact-hour"></output></label></div><div id="power-impact-map"></div><div id="power-impact-zone"></div>`;
  const geometries=result.geometry_by_id || {};
  const points=[];
  function vertices(geometry) {
    if (!geometry) return [];
    if (geometry.type === "Polygon") return geometry.coordinates || [];
    if (geometry.type === "MultiPolygon") return (geometry.coordinates || []).flat();
    return [];
  }
  Object.values(geometries).forEach((geometry)=>vertices(geometry).forEach((ring)=>ring.forEach((p)=>points.push(p))));
  if (!points.length) {holder.textContent=tr("分区没有可绘制的地理边界。", "No plottable geographic zone boundaries are saved.");return;}
  let xmin=Infinity,ymin=Infinity,xmax=-Infinity,ymax=-Infinity;
  for(const p of points){xmin=Math.min(xmin,p[0]);xmax=Math.max(xmax,p[0]);ymin=Math.min(ymin,p[1]);ymax=Math.max(ymax,p[1]);}
  const project=(p)=>[20+(p[0]-xmin)/Math.max(.00001,xmax-xmin)*860,520-(p[1]-ymin)/Math.max(.00001,ymax-ymin)*500];
  const paths={};Object.entries(geometries).forEach(([id,geometry])=>{paths[id]=vertices(geometry).map((ring)=>ring.map((p,i)=>`${i?"L":"M"}${project(p).map((x)=>x.toFixed(2)).join(",")}`).join(" ")+" Z").join(" ");});
  function draw(){
    const s=strategies[Number($("#power-impact-strategy",holder).value)],frames=s.frames || [];
    const slider=$("#power-impact-time",holder);slider.max=Math.max(0,frames.length-1);if(Number(slider.value)>Number(slider.max))slider.value=0;
    const frame=frames[Number(slider.value)] || {};$("#power-impact-hour",holder).textContent=` ${formatNumber(frame.time_hours,2)} h`;
    const colors={full_outage:"#bd5647",partial_outage:"#e1b665",grid_supplied:"#81b3a8",unknown:"#a9afb6"};
    $("#power-impact-map",holder).innerHTML=`<svg viewBox="0 0 900 540" style="width:100%;background:#f7fafb" role="img" aria-label="${tr("保存的停电分区", "Saved outage zones")}">${(frame.features || []).map((f)=>`<path data-impact-zone="${escapeAttribute(f.id)}" d="${paths[f.geometry_ref || f.id] || ""}" fill="${colors[f.properties?.status] || colors.unknown}" fill-opacity=".8" stroke="white" stroke-width=".5" fill-rule="evenodd"><title>${escapeHTML(f.name || f.id)} · ${escapeHTML(f.properties?.status || "unknown")}</title></path>`).join("")}</svg><p>${tr("红：完全失供；黄：部分缺供；绿：电网供电；灰：未知。", "Red: full outage; yellow: partial supply; green: grid supplied; grey: unknown.")}</p>`;
    $$("[data-impact-zone]",holder).forEach((path)=>path.addEventListener("click",()=>{const f=(frame.features || []).find((z)=>z.id===path.dataset.impactZone);const p=f?.properties || {};$("#power-impact-zone",holder).innerHTML=`<strong>${escapeHTML(f?.name || f?.id)}</strong><dl class="delivery-metrics"><div><dt>${tr("供电比例", "Supply ratio")}</dt><dd>${formatPercent(p.supply_ratio)}</dd></div><div><dt>${tr("区域人口", "Zone population")}</dt><dd>${formatNumber(p.population,0)}</dd></div><div><dt>${tr("等效缺供暴露人口", "Equivalent deficit exposure")}</dt><dd>${formatNumber(p.affected_population_equivalent,2)}</dd></div><div><dt>${tr("资料来源", "Source")}</dt><dd>${escapeHTML(p.source || "—")}</dd></div></dl>`;}));
  }
  $("#power-impact-strategy",holder).addEventListener("change",()=>{$("#power-impact-time",holder).value=0;draw();});$("#power-impact-time",holder).addEventListener("input",draw);draw();
}

document.addEventListener("DOMContentLoaded", init);
