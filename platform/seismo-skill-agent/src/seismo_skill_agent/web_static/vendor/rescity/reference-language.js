/* Localize the copied reader without changing its layout, object identities or data.
 * Only visible text and accessibility labels are translated. Source names and
 * unknown free text retain their original spelling. Chinese is fully reversible.
 */
(() => {
  'use strict';
  const scope = '#results-content,#spatial-content,.map-fullscreen,.publication-fullscreen';
  const phrases = new Map(Object.entries({
    '电力系统评估':'Electricity system assessment', '电力系统':'Electricity system',
    '结论与建议':'Conclusions and recommendations', '设施损伤与功能状态':'Asset damage and functionality',
    '区域电网震后功能状态':'Post-earthquake grid functionality', '停电范围与人口':'Outage areas and population',
    '恢复方案':'Recovery plans', '数据与依据':'Data and evidence', '仅本次录入范围':'Assessment area only',
    '电力分析能力与本轮执行范围':'Power analysis capabilities and completed scope',
    '设施损伤与供电评估':'Asset damage and power supply', '电网恢复策略':'Grid recovery strategies',
    '本轮已计算':'Computed in this round', '本轮未计算':'Not computed in this round',
    '当前提供电网损伤、供电、基础恢复、有限工程队优化，以及停电范围与人口影响评估。':'This assessment covers grid damage, power supply, baseline recovery, limited-crew optimization, and outage areas and population.',
    '供电分区与人口叠加结果已保存':'Supply-zone and population results are available',
    '地图展示明确分区边界与本轮供电状态；查看全部失供区域人口、部分失供等效人口、未知及未覆盖部分，并核对来源与关联方法。':'Explore supply-zone boundaries, saved supply states, full and partial outages, population exposure, and coverage.',
    '打开停电范围与人口':'Open outage areas and population', '震后初始概览':'Initial post-earthquake overview',
    '电网与供电分区概览':'Grid and supply-zone overview',
    '这里只展示震后初始电网与分区；供电状态、人口影响和恢复过程请进入相应分项。':'This overview shows the initial grid and supply zones. Open the individual topics for supply states, population impact and recovery.',
    '核心结论':'Key findings', '本次评估结论':'ASSESSMENT FINDINGS', '建议先做什么':'Recommended actions',
    '展开看具体做法':'Expand for action details', '配套工程建议':'Supporting actions',
    '优先行动':'First action', '阶段安排':'Next step', '现场核查':'Field checks', '工程建议':'Engineering guidance',
    '判断依据与落实条件':'Rationale and implementation checks', '查看计算依据':'View calculation evidence',
    '展开指标解读与计算口径':'Expand metric interpretation and calculation basis',
    '采用原模型计算口径，指标定义与适用范围见数据与依据。':'Metric definitions and model scope are available under Data and evidence.',
    '关键结果对比':'Key result comparisons', '先看变化，再查看恢复过程':'Compare outcomes, then inspect recovery',
    '恢复过程与时间':'Recovery and timing', '查看分析':'View analysis', '结果说明了什么':'What the results show',
    '建议怎么做':'Recommended actions', '影响与恢复解读':'Impact and recovery interpretation',
    '评估范围与计算依据':'Assessment scope and calculation basis',
    '下列资料对应当前任务与计算轮次，明细保留原始单位。':'These records belong to the selected task and round. Details retain the original units.',
    '数据来源与估算说明':'Data sources and estimation methods', '城市资料':'City dataset', '地图范围':'Map coverage',
    '使用说明':'Usage notes', '查看资料来源':'View source', '模型假设与使用说明':'Model assumptions and usage notes',
    '本轮计算链路':'Execution chain', '运行标识':'Run ID', '查看报告与文件':'View reports and files',
    '恢复策略优化与工程队调度':'Recovery optimization and crew scheduling',
    '下列结果已保存，调整参数请到执行审查中重新校验和批准。':'These results are saved. Use Execution review to revise, validate and approve parameters.',
    '地图跟随所选电网恢复策略展示设施恢复与可关联的供电分区变化，队伍安排见下方排程。':'The map follows the selected recovery strategy. Crew assignments are listed in the schedule below.',
    '设施修复优先级与工程队分配':'Repair sequence and crew assignments', '恢复策略':'Recovery strategy',
    '累计功能损失（功能损失·天）':'Cumulative function loss (function-loss days)',
    '达到目标功能（天）':'Target recovery time (days)', '本轮修复任务完工（天）':'All repairs completed (days)',
    '目标功能达标（天）':'Target recovery time (days)', '全部修复完成（天）':'All repairs completed (days)',
    '共同评价期韧性指数':'Resilience index over the comparison period', '本轮推荐':'Recommended', '未达到':'Not reached',
    '查看已保存策略':'View saved strategy', '累计功能损失最小':'Minimum cumulative function loss',
    '达到目标功能时间最短':'Minimum time to target functionality', '目标功能':'Target functionality',
    '排程页码':'Schedule page', '页码':'Page', '来源':'Source', '未记录':'Not recorded', '未知':'Unknown',
    '首批队伍具体怎么安排':'Assign the first repair jobs', '首批完成后接着修哪里':'Continue with the next jobs',
    '按恢复目标选择方案':'Choose the plan for the recovery objective', '同步安排近期供电保障':'Arrange near-term supply support',
    '结合停电分区核对重要负荷的转供路径和临时电源需求，设备抢修与近期供电保障同步安排。':'Use the outage zones to check transfer paths and temporary power needs for critical loads, alongside asset repairs.',
    '开工前核对设备状态、进场条件和材料；完工后复核潮流与保护。':'Check equipment, access and materials before work; review power flow and protection after repairs.',
    '沿用同一方案各队的下一项任务。':'Uses each crew’s next job in the same saved schedule.',
    '按实际完工进度衔接后续任务，有变化时在右侧提交排程修订。':'Link subsequent jobs to actual completion. Submit schedule revisions in the review panel when conditions change.',
    '两项时间来自同一损伤情景和评价期的保存结果。':'Both times come from the saved results for the same damage scenario and evaluation period.',
    '本轮存在供电缺口；重要负荷位置与需求可结合供电分区和设备明细核对。':'This round records a supply shortfall. Use the supply zones and asset details to check critical-load locations and needs.',
    '核对实际负荷、可用电源和接线条件。':'Check actual loads, available power sources and connection conditions.',
    '节点震后损伤与功能明细':'Post-earthquake node damage and functionality',
    '支路震后损伤与功能明细':'Post-earthquake branch damage and functionality', '恢复策略比较':'Recovery strategy comparison',
    '节点损伤状态分布':'Node damage-state distribution', '支路损伤状态分布':'Branch damage-state distribution',
    '震前与震后供电功率':'Pre- and post-earthquake power supply', '震前供电功率':'Pre-earthquake power supply',
    '震后供电功率':'Post-earthquake power supply', '震前供电':'Pre-earthquake supply', '震后供电':'Post-earthquake supply',
    '待修复对象':'Assets requiring repair', '推荐方案目标达标时间':'Recommended plan: target recovery time',
    '全部失供区域人口（估计）':'Estimated population in full-outage areas',
    '本轮保存的震前基准':'Saved pre-earthquake baseline', '本轮保存的震后初始状态':'Saved initial post-earthquake state',
    '编号顺序基准':'ID-order baseline', '编号顺序方案':'ID-order plan', '系统功能增益每工时排序':'Function gain per crew-hour',
    '系统功能增益排序':'Function-gain order', '功能增益排序方案':'Function-gain plan',
    '遗传算法搜索':'Genetic algorithm', '遗传算法方案':'Genetic-algorithm plan', '有限队伍恢复曲线':'Limited-crew recovery curve',
    '节点编号':'Node ID', '支路编号':'Branch ID', '起点节点':'From node', '终点节点':'To node',
    '设施名称':'Asset name', '损伤状态':'Damage state', '原始状态码':'Original state code',
    '组件功能状态':'Component functionality', '组件类型':'Component type', '组件编号':'Component ID',
    '队伍编号':'Crew ID', '工程队':'Repair crew', '开始（天）':'Start (days)', '完成（天）':'Finish (days)',
    '优先顺序':'Repair order', '类别':'Type', '开工（天）':'Start (days)', '完工（天）':'Finish (days)',
    '轮次':'Round', '选择计算轮次':'Select computation round', '图文工程评估结果':'Illustrated engineering assessment',
    '开始时间（天）':'Start (days)', '完成时间（天）':'Finish (days)', '修复工作量（小时）':'Repair work (hours)',
    '基本完好':'Undamaged', '轻微破坏':'Slight damage', '轻度破坏':'Slight damage',
    '中等破坏':'Moderate damage', '中度破坏':'Moderate damage', '严重破坏':'Extensive damage', '完全破坏':'Complete damage',
    '在地图中查看此对象':'Show this asset on the map', '查看知识依据':'View knowledge evidence',
    '以下资料用于支持工程解释和行动原则；本轮数值仍来自已保存的工程计算。':'These sources support interpretation and action principles. Numerical results come from the saved engineering calculation.',
    '图例与显示':'Legend and display', '勾选显示，取消隐藏':'Check to show; uncheck to hide',
    '图层与说明':'Layers and notes', '对象详情':'Object details', '地图图层与说明':'Map layers and notes',
    '收起图层与说明':'Hide layers and notes', '收起对象详情':'Hide object details', '收起地图图例':'Hide map legend',
    '展开地图图例':'Show map legend', '收起':'Hide', '展开':'Show', '查看':'View',
    '电网节点':'Grid nodes', '输电线路':'Transmission lines', '输配电线路':'Transmission and distribution lines',
    '停电范围 / 供电分区':'Outage areas / supply zones', '供电状态颜色说明':'Supply-state colors',
    '变电站节点':'Substation node', '供电接入点':'Supply connection', '配电接入点':'Distribution connection',
    '线路连接点':'Line junction', '中压连接点':'Medium-voltage junction', '站内变压连接':'In-substation transformer link',
    '变压连接':'Transformer link', '外部电源':'External source', '杆塔':'Tower', '变电站':'Substation',
    '全部失供':'Full outage', '部分失供':'Partial outage', '无失供':'No outage', '电网供电':'Grid supplied',
    '供电状态未知':'Supply state unknown', '状态未知':'Unknown state', '未映射/关联未明确':'Unmapped / association unknown',
    '电网关联未明确':'Grid association unknown', '失供 / 需求未满足':'Outage / unmet demand',
    '部分失供 / 备用供电':'Partial outage / backup supply', '地图图例与显示开关':'Map legend and layer toggles',
    '点击分区查看供电状态、人口及关联依据。':'Select a zone for supply state, population and association evidence.',
    '点击节点或线路查看当前电网结果。':'Select a node or line to inspect its saved result.',
    '网络地图指标':'Map metric', '节点与网络':'Nodes and network', '功能状态':'Functionality',
    '地图方式':'Map mode', '电网地图方式':'Grid map mode', '二维地图':'2D map', '三维分析地图':'3D analysis map',
    '显示全部网络':'Show full network', '全屏查看':'Full screen', '退出全屏':'Exit full screen',
    '全屏查看地图':'View map full screen', '地图全屏总览':'Full-screen map overview',
    '底图':'Basemap', '电力地图底图':'Grid basemap', '清爽分析底图':'Analysis basemap', '原始地理底图':'Original basemap',
    '底图仅提供道路与地名参照；地形和地物符号不属于电力评估结果。':'The basemap provides road and place-name context. Its terrain and symbols are not assessment results.',
    '停电影响地图视图':'Outage map view', '电网':'Grid', '停电范围':'Outage areas', '综合':'Combined',
    '查找对象':'Find an asset', '选择地图对象':'Select a map asset', '请选择':'Select',
    '选择供电分区':'Select a supply zone', '请选择供电分区':'Select a supply zone',
    '电压层级':'Voltage level', '电网电压层级':'Grid voltage level', '全部电压层级':'All voltage levels',
    '显示线路连接点':'Show line junctions', '显示站内接入':'Show in-substation connections',
    '网络恢复时间点':'Saved recovery time', '恢复时刻':'Recovery time', '播放恢复过程':'Play recovery',
    '暂停':'Pause', '重置':'Reset', '回放范围':'Playback range', '全程':'Full period', '速度':'Speed',
    '回放速度':'Playback speed', '仅展示已有位置和已关联结果':'Saved locations and linked results',
    '网络地图，可缩放和平移':'Network map; zoom and pan', '工程系统真实网络地图':'Engineering network map',
    '查看对应结果明细':'View linked result details', '源数据属性与计算假设':'Source attributes and assumptions',
    '当前状态':'Current state', '空间依据':'Spatial basis', '资料来源':'Source', '区域人口':'Zone population',
    '关联电网节点':'Linked grid node', '供电比例':'Supply ratio', '失供比例':'Supply deficit ratio',
    '经纬度（':'Coordinates (', '连接':'Connections', '路线依据':'Route source', '功能值':'Function value',
    '地图数据与计算口径':'Map data and calculation basis', '查看原始来源':'View original source',
    '位置来自所选数据版本；地图底图不参与工程计算。':'Locations come from the selected dataset version. The basemap is not used in engineering calculations.',
    '当前查看震后初始状态；切换':'Showing the initial post-earthquake state. Open',
    '可播放已保存的恢复过程。':'to play the saved recovery sequence.',
    '本轮只保存了一个状态，没有可播放的时间变化。':'This round contains one saved state; no time sequence is available.',
    '重新加载地图':'Reload map', '正在加载本轮网络地图':'Loading the saved grid map',
    '部分地理底图暂未加载，评估对象与坐标仍有效；可切换底图。':'Some basemap tiles are unavailable. Asset locations remain valid; another basemap can be selected.',
    '停电范围与人口地图':'Outage areas and population map', '停电影响范围与人口':'Outage extent and population',
    '二维 / 三维共用保存结果':'2D and 3D share saved results', '人口资料与电网时刻分开记录':'Population data and grid timestamps are recorded separately',
    '分区与人口明细':'Zone and population details', '人口影响恢复过程':'Population exposure during recovery',
    '停电影响策略':'Outage strategy', '保存情景 / 恢复策略':'Saved scenario / recovery strategy',
    '本图聚焦供电分区、停电状态与受影响人口，播放分区随基础电网恢复发生的变化；电网设施见供电页，抢修安排见恢复方案。区域来源、供电关联和未知部分分别报告。':'Explore supply zones, outage states and population exposure over the saved grid recovery. Assets are shown in Grid functionality and crew assignments in Recovery plans.',
    '全部失供区域人口':'Population in full-outage areas', '部分失供等效人口':'Equivalent population in partial outages',
    '存在失供区域人口':'Population in areas with any outage', '供电状态未知人口':'Population with unknown supply state',
    '未覆盖人口':'Uncovered population', '未映射人口':'Unmapped population', '存在失供的分区面积':'Area with supply deficit',
    '分区人口':'Zone population', '分区面积（':'Zone area (', '分区':'Zone', '供电状态':'Supply state',
    '边界 / 电网关联依据':'Boundary / grid-association basis', '本轮研究范围':'Study area',
    '本轮保存情景':'Saved scenario', '最大概率损伤等级':'Most-likely damage state', '可复现概率抽样':'Seeded damage sample',
    '本图聚焦变电站、线路和震后供电状态；人口分区见“停电范围与人口”，抢修安排与恢复回放见“恢复方案”。':'This map focuses on substations, lines and post-earthquake supply. Open Outage areas and population for zones, or Recovery plans for crew schedules and playback.',
    '恢复过程与方案':'Recovery progress and plans', '下载本轮优化工作簿与报告':'Download the optimization workbook and report',
    '本轮保存的原模型损伤状态':'Saved model damage state', '节点数量（个）':'Node count', '支路数量（个）':'Branch count',
    '按本轮保存的组件状态分组计数；原始状态码、组件功能及对象编号保留在明细中。':'Counts use saved component states. Original state codes, functionality and asset IDs are available in the details.',
    'MW为保存的供电功率；原模型为稀疏直流供电评估，不能替代实际运行调度。':'Power supply is recorded in MW using the sparse DC model.',
    '本轮已批准资源下逐事件回算；阶梯点对应保存时刻，不插值。目标达标、全部完工和累计功能损失分别比较，搜索结果不等于全局最优。':'Step points follow saved repair events and approved crew resources. Target recovery, completion time and cumulative function loss are reported separately.',
    '震后时间（天）':'Time after earthquake (days)', '相对震前供电功能':'Supply relative to the pre-earthquake baseline',
    '按原模型口径展示；完整明细可在':'Uses the saved model definitions; full details are available under',
    '中逐项核对。':'for review.', '结合设施差异和系统指标，核对本轮影响范围。':'Review the affected area using asset differences and system metrics.',
    '查看保存的恢复轨迹和计算时间；不同策略或情景分别展示，按相同口径比较。':'Review saved recovery curves and timing for each strategy or scenario using consistent metrics.',
    '计算依据':'Calculation basis', '查看原始数据与计算说明':'View source data and calculation notes',
    '结合现场情况核查计算结果，具体安排需以工程审查为准。':'Review the calculated results and proposed actions against field conditions.',
    '本轮计算情景':'Scenario', '观察时窗':'Observation window', '人口资料完整性未记录':'Population completeness not recorded',
    '全部失供人口累计暴露':'Cumulative full-outage exposure', '部分失供等效累计暴露':'Cumulative equivalent partial-outage exposure',
    '未知供电人口累计暴露':'Cumulative unknown-supply exposure', '人·小时':'person-hours',
    '所用人口资料完整':'Population values are complete', '明细页码':'Details page',
    '边界、人口与计算方法':'Boundaries, population and methods', '人口资料来源':'Population source',
    '供电分区来源':'Supply-zone source', '输入资料来源':'Input sources', '面积计算坐标系':'Area calculation CRS',
    '人口统计面':'Census polygons', '研究范围':'Study area', '电网关联':'Grid association', '供电分区':'Supply zones',
    '人口':'Population', '边界':'Boundary', '供电分区发布方':'Supply-zone publisher',
    '官方供电分区':'Official supply zones', '明确录入的服务区边界':'Recorded service-zone boundary',
    '官方普查统计面':'Official census polygons', '站点代码精确匹配至现有等值电网负荷节点':'Station codes matched to equivalent grid load nodes',
    '运营商正式披露的供电分区':'Operator-published supply zones', '研究范围扣除明确供电分区后的区域':'Study area outside associated supply zones',
    '未映射或供电分区重叠，电网关联未明确':'Unmapped or overlapping zones; grid association unresolved',
    '奥克兰（Auckland）':'Auckland', '奥克兰城市电力综合数据':'Auckland integrated electricity dataset',
    '都市区分层电网 · 96站子网及上级联络':'Metropolitan grid · 96-station subnetwork and upstream interconnections',
    '设备组':' equipment group', '电力支路':'Power branch', '节点':'Node', '支路':'Branch',
    '人':'people', '天':'days', '小时':'hours', '是':'Yes', '否':'No',
  }));
  // Whole-sentence rules preserve saved quantities and named assets verbatim.
  const rules = [
    [/^按(.+)安排抢修，减少恢复期供电损失$/, (_, plan) => `Use the ${text(plan)} to reduce supply losses during recovery`],
    [/^按(.+)安排抢修，尽早达到恢复目标$/, (_, plan) => `Use the ${text(plan)} to reach the recovery target sooner`],
    [/^震后供电功率为 (.*?) MW，震前为 (.*?) MW；待修复对象包括 (.*?) 个节点和 (.*?) 条支路。$/, (_, post, pre, nodes, branches) => `Post-earthquake supply is ${post} MW, compared with ${pre} MW before the event. Repairs are required for ${nodes} nodes and ${branches} branches.`],
    [/^震后供电功率为 (.*?) MW(?:，震前为 (.*?) MW)?。$/, (_, post, pre) => `Post-earthquake supply is ${post} MW${pre ? `, compared with ${pre} MW before the event` : ''}.`],
    [/初始完全失供区域人口约 (.*?) 人/g, 'Estimated population in full-outage areas: $1'],
    [/初始完全失供区域已知人口至少 (.*?) 人/g, 'Known population in full-outage areas: at least $1'],
    [/部分缺供等效人口约 (.*?) 人/g, 'Equivalent population in partial outages: $1'],
    [/缺供面积约 (.*?) km²/g, 'Area with supply deficit: $1 km²'],
    [/另有 (.*?) 人所在区域待补全供电关联/g, 'Supply-zone associations still need to be completed for areas containing $1 people'],
    [/^本轮按(累计功能损失|目标功能达标时间)选择(.+?)，累计功能损失为 (.*?) 功能损失·天(?:，编号顺序方案为 (.*?) 功能损失·天)?(?:；推荐方案的共同评价期韧性指数为 (.*?))?。$/, (_, goal, plan, loss, baseline, index) => `The ${text(plan)} is recommended for ${goal === '累计功能损失' ? 'minimum cumulative function loss' : 'minimum time to target functionality'}. Cumulative function loss is ${loss} function-loss days${baseline ? ` (ID-order baseline: ${baseline})` : ''}${index ? `; the resilience index over the comparison period is ${index}` : ''}.`],
    [/推荐方案预计震后第 (.*?) 天达到 (.*?) 功能/g, 'The recommended plan reaches $2 functionality on day $1'],
    [/编号顺序方案的达标时间为第 (.*?) 天/g, 'The ID-order plan reaches the target on day $1'],
    [/推荐方案的全部修复任务于第 (.*?) 天完成/g, 'All repairs in the recommended plan finish on day $1'],
    [/推荐方案在本轮排程结束时尚未达到设定功能目标/g, 'The recommended plan does not reach the functionality target within the saved schedule'],
    [/按本轮 (.*?) 支工程队、每天 (.*?) 小时的配置，/g, 'With $1 repair crews working $2 hours per day, '],
    [/第 (.*?) 队先修复 (.*?)，排程为震后第 (.*?)—(.*?) 天/g, 'crew $1 first repairs $2, scheduled for days $3–$4 after the event'],
    [/第 (.*?) 队随后转入 (.*?)，排程为震后第 (.*?)—(.*?) 天/g, 'Crew $1 then moves to $2, scheduled for days $3–$4'],
    [/对象和顺序取自本轮(.+?)的保存排程。/g, (_, plan) => `Assets and sequence follow the saved ${text(plan)} schedule.`],
    [/^若优先尽早达到 (.*?) 功能，可采用(.+?)，达标时间为第 (.*?) 天；若按本轮(.*?)目标安排，则采用当前推荐的(.+?)。$/, (_, target, faster, time, goal, current) => `To reach ${target} functionality sooner, use the ${text(faster)} (day ${time}). For the current ${goal === '累计功能损失' ? 'cumulative function-loss' : 'target recovery-time'} objective, use the recommended ${text(current)}.`],
    [/本轮已批准：(.*?) 支工程队，每队每天 (.*?) 小时，效率 (.*?) 倍。优化目标：(.*?)；目标功能 (.*?)%。/g, (_, crews, hours, efficiency, goal, target) => `Approved resources: ${crews} crews, ${hours} working hours per day, efficiency ${efficiency}. Objective: ${text(goal)}; target functionality: ${target}%. `],
    [/每页最多20条；全部 (.*?) 条可在数据与依据中翻页查看。/g, 'Up to 20 rows per page; all $1 rows are available under Data and evidence.'],
    [/已选中 (.*?) · 对应明细已定位并标亮。地图状态和恢复排程各自保留原计算口径。/g, 'Selected $1. Linked details are highlighted. Map states and repair schedules retain their saved definitions.'],
    [/(\d[\d,.]*) 个保存数据点/g, '$1 saved data points'],
    [/第\s*(\d+)\s*轮/g, 'Round $1'], [/第\s*(\d+)\s*页/g, 'Page $1'],
    [/第\s*(\d+)\s*队/g, 'Crew $1'], [/第\s*(\d+)\s*天/g, 'Day $1'],
    [/(\d[\d,.]*)\s*个节点/g, '$1 nodes'], [/(\d[\d,.]*)\s*条支路/g, '$1 branches'],
    [/(\d[\d,.]*)\s*支工程队/g, '$1 repair crews'], [/(\d[\d,.]*)\s*个分区/g, '$1 zones'],
    [/(\d[\d,.]*)\s*个回放时刻/g, '$1 saved frames'], [/每日\s*(\d[\d,.]*)\s*小时/g, '$1 working hours/day'],
  ];
  let language = 'en-US', observer;
  let ordered = [...phrases].sort((a, b) => b[0].length - a[0].length);
  const originals = new WeakMap(), attributes = new WeakMap();
  const labels = ['title', 'aria-label', 'placeholder', 'alt'];
  function text(value) {
    const raw = String(value ?? '');
    if (!/[\u3400-\u9fff]/.test(raw)) return raw;
    const leading = raw.match(/^\s*/)[0], trailing = raw.match(/\s*$/)[0], trimmed = raw.trim();
    if (phrases.has(trimmed)) return leading + phrases.get(trimmed) + trailing;
    let output = trimmed;
    for (const [pattern, replacement] of rules) output = output.replace(pattern, replacement);
    for (const [zh, en] of ordered) {
      // Single-character units are translated only as standalone labels or after
      // quantities; never replace characters within source names or free prose.
      if (zh.length < 2) continue;
      output = output.split(zh).join(en);
    }
    output = output.replace(/(\d[\d,.]*)\s*小时/g, '$1 h').replace(/(\d[\d,.]*)\s*天/g, '$1 days')
      .replace(/(\d[\d,.]*)\s*人/g, '$1 people').replace(/\b1 repair crews\b/g, '1 repair crew')
      .replace(/；/g, '; ').replace(/。/g, '. ');
    return leading + output.trim() + trailing;
  }
  function localizeNode(node) {
    if (node.nodeType === 3) {
      if (node.parentElement?.closest('script,style,pre,code,blockquote,.reading-knowledge h4,[data-preserve-language]')) return;
      const current = node.nodeValue;
      if (language !== 'en-US') { if (originals.has(node)) node.nodeValue = originals.get(node); return; }
      const translated = text(current);
      if (translated !== current) { originals.set(node, current); node.nodeValue = translated; }
    } else if (node.nodeType === 1) {
      for (const label of labels) {
        if (!node.hasAttribute(label)) continue;
        if (language !== 'en-US') { if (attributes.get(node)?.has(label)) node.setAttribute(label, attributes.get(node).get(label)); continue; }
        const current = node.getAttribute(label), translated = text(current);
        if (translated !== current) {
          if (!attributes.has(node)) attributes.set(node, new Map());
          attributes.get(node).set(label, current);
          node.setAttribute(label, translated);
        }
      }
    }
  }
  function subtree(node) {
    localizeNode(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) localizeNode(walker.currentNode);
  }
  function setLanguage(value, common = []) {
    observer?.disconnect();
    language = value === 'zh-CN' ? 'zh-CN' : 'en-US';
    for (const [zh, en] of common) if (zh && en) phrases.set(zh, en);
    ordered = [...phrases].sort((a, b) => b[0].length - a[0].length);
    document.querySelectorAll(scope).forEach(subtree);
    if (language !== 'en-US') return;
    observer = new MutationObserver(records => {
      for (const record of records) {
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (record.type !== 'childList') { if (element?.closest(scope)) localizeNode(record.target); continue; }
        for (const node of record.addedNodes) {
          const parent = node.nodeType === 1 ? node : node.parentElement;
          if (parent?.closest(scope)) subtree(node);
          else if (node.nodeType === 1) node.querySelectorAll(scope).forEach(subtree);
        }
      }
    });
    observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: labels});
  }
  window.ReferencePowerLanguage = Object.freeze({text, setLanguage});
})();
