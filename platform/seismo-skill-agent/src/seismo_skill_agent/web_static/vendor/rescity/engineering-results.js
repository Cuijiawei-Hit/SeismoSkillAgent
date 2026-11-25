/* Engineering content adapted to the medical reading layout and figure gallery. */
window.EngineeringResultsView = (() => {
  const mounts=new WeakMap();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const display=v=>v==null?'—':typeof v==='object'?JSON.stringify(v):typeof v==='number'?v.toLocaleString('zh-CN',{maximumFractionDigits:4}):String(v);
  const lossDisplay=v=>typeof v==='number'&&v!==0&&Math.abs(v)<.0001?v.toExponential(3):display(v);
  const money=v=>typeof v!=='number'||!Number.isFinite(v)?'—':v!==0&&Math.abs(v)<.005?v.toExponential(3)+'元':(v/ (Math.abs(v)>=1e8?1e8:Math.abs(v)>=1e4?1e4:1)).toLocaleString('zh-CN',{maximumFractionDigits:2})+(Math.abs(v)>=1e8?'亿元':Math.abs(v)>=1e4?'万元':'元');
  function costExplanation(report){
    const rows=report.buildings||[],s=report.summary;
    if(!rows.length||rows.length!==s.building_count||!rows.every(r=>Number.isFinite(r.area_m2)))return '';
    const area=rows.reduce((sum,r)=>sum+r.area_m2,0),groups=new Map();
    if(area<=0)return '';
    for(const r of rows){const g=groups.get(r.damage_state)||{count:0,loss:0,rates:[]};g.count++;g.loss+=r.repair_cost_yuan;g.rates.push(r.repair_cost_ratio);groups.set(r.damage_state,g)}
    const rateText=rates=>{const min=Math.min(...rates)*100,max=Math.max(...rates)*100;return display(min)+(min===max?'%':'%～'+display(max)+'%')};
    const order=['基本完好','轻微破坏','中等破坏','严重破坏','完全破坏'];
    const source=report.parameter_sources||{},reference=[source.replacement_costs,source.repair_ratios].some(x=>String(x).includes('通用参考'));
    return `<p>本轮共 ${display(s.building_count)} 栋，总建筑面积 ${display(area)} m²；按重置总值折算的面积加权单价为 ${display(s.replacement_cost_yuan/area)} 元/m²。金额单位为人民币。</p>${reference?'<p>本轮造价或损失系数使用原模型通用参考参数，尚未按当地造价及损伤修复情况校准；金额为这些假设下的模型估计。</p>':''}<details class="reading-detail"><summary>这笔经济损失怎么算出来的？</summary><p>逐栋经济损失＝占地面积×层数×单位面积重置成本×对应损伤损失系数，再对本轮建筑求和。损失比以建筑重置总值加权，不是损伤系数的简单平均。</p><div class="reading-comparison-table"><table><thead><tr><th>损伤状态</th><th>建筑数量</th><th>本轮损失系数</th><th>经济损失</th></tr></thead><tbody>${[...groups].sort((a,b)=>order.indexOf(a[0])-order.indexOf(b[0])).map(([state,g])=>`<tr><td>${esc(state)}</td><td>${g.count}</td><td>${esc(rateText(g.rates))}</td><td>${esc(money(g.loss))}</td></tr>`).join('')}</tbody></table></div><p>损失系数沿用本轮保存的模型参数，不能只根据状态名称假定为零；逐栋原始金额保留在下方明细及工作簿中。</p></details>`;
  }
  const domains={water_supply_system:['节点与管道对比','供水功能'],drainage_system:['节点与管渠对比','排水功能'],heating_system:['热源与管网对比','供热连通性'],gas_system:['设施与管网对比','供气功能'],communication_system:['通信设施对比','通信服务'],power_system:['设施损伤与功能状态','区域电网震后功能状态'],building_complex:['建筑损伤与功能对比','建筑群功能'],transportation_system:['道路与桥梁对比','交通通行功能'],rail_transit_system:['轨道设施对比','轨道交通功能'],substation:['设备失效对比','变电站供电功能']};
  function objectIdentity(column,row,table){
    const label=column.label||'',raw=row[column.key];if(raw==null||raw==='')return null;
    if(column.key==='key'||label==='组件编号'){const match=String(raw).match(/^(node|pipe|component):(.+)$/);return match?{id:match[2],group:match[1]==='node'?'node':'pipe'}:null;}
    if(/起点|终点|所在/.test(label))return null;
    if(/管道编号|管渠编号|线路编号|区间编号|支路编号/.test(label))return {id:String(raw),group:'pipe'};
    if(/节点编号|车站编号|建筑编号|变电站编号|设施编号|热源编号/.test(label))return {id:String(raw),group:'node'};
    if(label==='编号'&&/节点|建筑|车站|变电站/.test(table.title||''))return {id:String(raw),group:'node'};
    return null;
  }
  function matchesObject(identity,selected){return identity&&selected&&identity.group===(selected.resultGroup||selected.group)&&identity.id===String(selected.resultId??selected.id);}
  function tableHTML(table,page=0,selected=null){const format=table.role?.startsWith('building_')?lossDisplay:display;return `<div class="reading-comparison-table"><table><thead><tr>${table.columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${table.rows.slice(page*20,page*20+20).map(r=>`<tr class="${table.columns.some(c=>matchesObject(objectIdentity(c,r,table),selected))?'is-map-selected':''}">${table.columns.map(c=>{const id=objectIdentity(c,r,table);return `<td>${id?`<button class="reading-text-button" type="button" data-engineering-object="${esc(id.id)}" data-engineering-group="${id.group}" title="在地图中查看此对象">${esc(format(r[c.key]))} ↗</button>`:esc(format(r[c.key]))}</td>`;}).join('')}</tr>`).join('')}</tbody></table></div>`;}
  function knowledgeHTML(d,topic=null,title=null){
    const mapped={objects:'damage',service:'service',recovery:'recovery'}[topic];
    const refs=(d.knowledge_references||[]).filter(r=>(!mapped||r.topic===mapped)&&(!title||r.advice_title===title||r.kind==='method'));
    if(!refs.length)return '';
    return `<details class="reading-detail reading-knowledge"><summary>查看知识依据（${refs.length} 条）</summary><p class="reading-muted">以下资料用于支持工程解释和行动原则；本轮数值仍来自已保存的工程计算。</p>${refs.map(r=>`<article><h4>${esc(r.title)}${r.page!=null?' · 第 '+esc(r.page)+' 页':''}${r.scenario_id?' · '+esc(r.scenario_id):''}</h4><p>${esc(r.applies_to)}</p><blockquote>${esc(r.quote)}</blockquote></article>`).join('')}</details>`;
  }
  function basisHTML(d){const b=d.input_basis;if(!b)return '';const notes=[...new Set([b.source_note,...(b.assumptions||[]),...(b.map_notes||[])].filter(Boolean).flatMap(v=>String(v).split(/\r?\n/)).filter(Boolean))];return `<details class="reading-detail reading-quality"><summary>数据来源与估算说明</summary><dl><div><dt>城市资料</dt><dd>${esc(b.source_title)}${b.synthetic?' · 含合成数据':''}</dd></div><div><dt>地图范围</dt><dd>${b.located_nodes} 个可定位节点、${b.located_links} 条可定位连线${Number.isFinite(b.endpoint_only_links)?`；其中 ${b.endpoint_only_links} 条仅按端点表达拓扑`:''}。</dd></div><div><dt>使用说明</dt><dd>${esc(b.scope_note)}</dd></div></dl>${b.source_url?`<a href="${esc(b.source_url)}" target="_blank" rel="noopener noreferrer">查看资料来源 ↗</a>`:''}${b.license?`<p>${esc(b.license)}</p>`:''}${notes.length?`<ul>${notes.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:''}</details>`;}
  function destroy(root){const previous=mounts.get(root);if(previous?.onObjectClick)root.removeEventListener?.('click',previous.onObjectClick);root.querySelectorAll('[data-network-map],[data-schedule-map],[data-approved-map]').forEach(el=>window.EngineeringNetworkMap?.destroy(el));root.querySelectorAll('[data-power-impact-results]').forEach(el=>window.PowerImpactView?.destroy(el));root.querySelectorAll('[data-power-regional-results]').forEach(el=>window.PowerRestorationView?.destroy?.(el));root.querySelectorAll('[data-reading-figures]').forEach(el=>window.PublicationGallery?.destroy(el));mounts.delete(root);}
  function mount(root,d,options){
    const powerProfile=options.powerProfile || window.ResCityPowerProfile || d.power_profile;
    const coordinationEnabled=d.system!=='power_system'||powerProfile?.regional_restoration_enabled!==false;
    const revision=/^[a-f0-9]{64}$/.test(options.resultRevision||d.display_revision||'')?(options.resultRevision||d.display_revision):null;options={...options,resultRevision:revision,powerProfile};
    const signature=JSON.stringify([options.sessionId,options.iteration,options.language,powerProfile,(options.iterations||[]).map(i=>[i.iteration,i.status]),revision||d]),previous=mounts.get(root);
    if(previous?.signature===signature && root.querySelector('.integrated-engineering-results')){previous.options=options;return;}
    const previousTopic=previous?.sessionId===options.sessionId?previous.topic:'overview';
    destroy(root);
    const state={signature,options,sessionId:options.sessionId,topic:'overview',activeTopic:null,selection:null,syncing:false,mapStates:new Map()};mounts.set(root,state);
    const charts=d.charts||[],tables=d.tables||[],metrics=d.metrics||[],warnings=d.warnings||[];
    const [objects,service]=domains[d.system]||['设施对比','系统功能'];
    const recovery=charts.filter(c=>c.kind==='line'),comparison=charts.filter(c=>c.kind==='bar'),functions=comparison.filter(c=>/功能|连通/.test(c.title));
    const regional=coordinationEnabled&&(d.regional_restoration || d.optimization?.regional_restoration);
    const impact=d.power_impact || d.optimization?.power_impact;
    const powerSystem=d.system==='power_system';
    const buildingLoss=d.system==='building_complex'?d.building_losses:null;
    const topics=[['overview','结论与建议'],...((comparison.length||tables.some(t=>t.role==='objects'))?[['objects',objects]]:[]),['service',service+(powerSystem?'':'与地图')],...(buildingLoss?[['casualties','人员伤亡'],['costs','经济损失']]:[]),...(impact?[['impact','停电范围与人口']]:[]),...(recovery.length?[['recovery','恢复方案']]:[]),...(coordinationEnabled&&(regional||powerSystem)?[['regional','多主体与应急协同']]:[]),['evidence','数据与依据']];
    const slot=(key,items)=>`<div class="reading-figure-slot" data-reading-figures="${key}" data-templates="${esc(items.map(c=>'engineering-'+c.id).join(','))}"></div>`;
    const metricHTML=metrics.length?`<section class="reading-key-metrics" aria-label="核心结果指标">${metrics.map(m=>`<article><span>${esc(m.label)}</span><strong>${esc(m.source===buildingLoss?.model_version?lossDisplay(m.value):display(m.value))}<em>${esc(m.unit)}</em></strong><small>${esc(m.note||m.source)}</small></article>`).join('')}</section>`:'';
    const decision=d.decision, advice=decision?.recommendations||[];
    const adviceHTML=(items,open=false)=>`<div class="reading-recommendations is-compact">${items.map((a,i)=>`<details class="reading-recommendation" ${open&&i===0?'open':''}><summary><span class="reading-action-index">${String(i+1).padStart(2,'0')}</span><span><small>${{first:'优先行动',next:'阶段安排',verify:'现场核查'}[a.priority]||'工程建议'}</small><strong>${esc(a.title)}</strong></span><span class="reading-expand">＋</span></summary><div><p>${esc(a.action)}</p><details class="reading-detail"><summary>判断依据与落实条件</summary><p>${esc(a.rationale)}</p><p>${esc(a.verification)}</p></details>${knowledgeHTML(d,a.topic,a.title)}<button class="reading-evidence" data-reading-open-topic="${esc(topics.some(t=>t[0]===a.topic)?a.topic:'evidence')}">查看计算依据 ↗</button></div></details>`).join('')}</div>`;
    const actions=[...(comparison.length?[[objects,'核对设施损伤和功能差异，再结合现场检查确定保障对象。','objects']]:[]),...(recovery.length?[['核对恢复过程与安排','查看恢复曲线、时间单位及原模型定义；已有排程时，结合人员与资源约束复核。','recovery']]:[]),['确认计算范围与数据','检查本轮输入、模型说明和原始工作簿，避免将结论推广到未录入区域。','evidence']];
    const recommendations=advice.length?adviceHTML(advice.slice(0,3),true):`<div class="reading-recommendations is-compact">${actions.map((a,i)=>`<details class="reading-recommendation"><summary><span class="reading-action-index">${String(i+1).padStart(2,'0')}</span><span><small>结果复核</small><strong>${esc(a[0])}</strong></span><span class="reading-expand">＋</span></summary><div><p>${esc(a[1])}</p><button class="reading-evidence" data-reading-open-topic="${a[2]}">查看计算依据 ↗</button></div></details>`).join('')}</div>`;
    const headline=decision?.headline||(metrics[0]?`${metrics[0].label}：${display(metrics[0].value)}${metrics[0].unit||''}`:'本轮分项评估结果已汇总');
    const overviewFigures=[...(comparison.length?[[objects,functions.length?functions:comparison,'objects']]:[]),...(recovery.length?[['恢复过程与时间',recovery,'recovery']]:[])];
    const regionalEntry=(impact?'<section class="power-regional-entry"><div><strong>供电分区与人口叠加结果已保存</strong><p>地图展示明确分区边界与本轮供电状态；查看全部失供区域人口、部分失供等效人口、未知及未覆盖部分，并核对来源与关联方法。</p></div><button type="button" class="reading-evidence" data-reading-open-topic="impact">打开停电范围与人口 →</button></section>':'')+(regional?'<section class="power-regional-entry"><div><strong>区域恢复与应急处置结果已保存</strong><p>在多主体协同页联动查看关键设施、应急电源、抢修队与物资配送；各分项地图分别展示对应内容。</p></div><button type="button" class="reading-evidence" data-reading-open-topic="regional">打开区域恢复与应急地图 →</button></section>':'');
    const findings=(d.findings||[]).length?`<section class="reading-chapter"><div class="reading-block-heading"><h3>影响与恢复解读</h3></div>${d.findings.map(x=>`<p>${esc(x)}</p>`).join('')}${d.earthquake_scenario?`<p><strong>本轮地震情景：</strong>${esc(d.earthquake_scenario.summary)}${d.earthquake_scenario.synthetic?' 假设参数测试，不代表实际灾害预测。':''}</p>`:''}</section>`:'';
    const completionHTML=(d.milestones||[]).length?`<section class="reading-chapter"><header class="reading-topic-heading"><h3>组件修复完成时间轴</h3><p>${esc(d.recovery_note)}</p></header>${d.milestones.map(m=>`<details class="reading-recommendation"><summary><strong>第 ${display(m.time)} 天</strong><span>完成 ${m.nodes.length} 个节点、${m.pipes.length} 条管道修复</span></summary><div><p>节点编号：${esc(m.nodes.join('、')||'无')}</p><p>管道编号：${esc(m.pipes.join('、')||'无')}</p></div></details>`).join('')}<p class="reading-muted">这是同时开工假设下的完成先后。现有模型未计算有限抢修队伍下的优先顺序；不能据此给出先修哪个节点的调度指令。</p></section>`:'';
    const regionalNotComputed='<header class="reading-topic-heading"><h3>区域恢复、应急供电与多主体协同</h3><p>平台保留政府、电网企业、调度员、抢修队伍、物资供应和物流保障的任务交互，以及关键设施、移动电源、仓库库存和配送仿真。</p></header><section class="reading-chapter" data-regional-not-computed><h4>本轮未计算这项能力</h4><p>当前轮次的批准计算链没有生成区域协同结果，因此不填充应急电源位置、运输轨迹或角色事件。可在协同对话中追加区域恢复、应急供电与多主体协同需求，并在执行审查中核对本轮设施、车辆、电源、物资和角色指令；计算后本页与停电人口结果一起展示。</p></section>';
    const capabilityStatus=powerSystem?`<section class="power-capability-status" aria-label="电力分析能力与本轮执行范围"><strong>电力分析能力与本轮执行范围</strong><ul>${[['设施损伤与供电评估',(d.executed_components||[]).some(id=>/damage_assessment|function_assessment/.test(id))],['电网恢复策略',Boolean(d.optimization || recovery.length)],['停电范围与人口',Boolean(impact)],...(coordinationEnabled?[['多主体协同、应急电源与物资运输',Boolean(regional)]]:[])].map(([label,computed])=>`<li><span>${esc(label)}</span><em>${computed?'本轮已计算':'本轮未计算'}</em></li>`).join('')}</ul><p>${coordinationEnabled?'各项能力可以组合执行；新增人口评估不会替代应急供电与协同恢复。':'当前提供电网损伤、供电、基础恢复、有限工程队优化，以及停电范围与人口影响评估。'}</p></section>`:'';
    const overview=`${capabilityStatus}${regionalEntry}<section class="reading-overview-map"><div class="reading-block-heading"><h3>${powerSystem?'震后初始概览':'整体地图'}</h3><span>${powerSystem?'电网与供电分区概览':'本轮评估范围与设施状态'}</span></div><div data-network-map data-overview-map></div><p class="reading-muted">${powerSystem?(coordinationEnabled?'这里只展示震后初始电网与分区；供电状态、人口影响、恢复过程和应急资源请进入相应分项。':'这里只展示震后初始电网与分区；供电状态、人口影响和恢复过程请进入相应分项。'):'点击设施查看结果；网络连线表达已录入的连接关系，不能据此推断未录入的设施。'}</p></section><div class="reading-brief-grid"><section class="reading-conclusion" aria-label="核心结论"><span class="reading-kicker">本次评估结论</span><h3>${esc(headline)}</h3><p>${esc(decision?.scope||'以下结论仅覆盖本次录入范围和已完成的计算项目。')}</p>${decision?`<div class="reading-decision-prose">${decision.summary.map(x=>`<p>${esc(x)}</p>`).join('')}</div>`:''}<small>${esc(warnings[0]||'采用原模型计算口径，指标定义与适用范围见数据与依据。')}</small></section><aside class="reading-priorities"><div class="reading-block-heading"><h3>建议先做什么</h3><span>展开看具体做法</span></div>${recommendations}</aside></div>${metricHTML}${advice.length>3?`<section class="reading-chapter"><h3>配套工程建议</h3>${adviceHTML(advice.slice(3),true)}</section>`:""}${findings?`<details class="reading-detail"><summary>展开指标解读与计算口径</summary>${findings}</details>`:""}${overviewFigures.length?`<div class="reading-block-heading reading-comparison-heading"><h3>关键结果对比</h3><span>先看变化，再查看恢复过程</span></div><div class="reading-comparison-grid">${overviewFigures.map((f,i)=>`<section><header><h4>${esc(f[0])}</h4><button class="reading-text-button" data-reading-open-topic="${f[2]}">查看分析 →</button></header>${slot('overview-'+i,f[1])}</section>`).join('')}</div>`:''}`;
    const analysis=(topic,label,items)=>`<header class="reading-topic-heading"><h3>${esc(label)}</h3><p>${topic==='recovery'?'查看保存的恢复轨迹和计算时间；不同策略或情景分别展示，按相同口径比较。':'结合设施差异和系统指标，核对本轮影响范围。'}</p></header><div class="reading-analysis-layout"><div class="reading-analysis-chart">${slot(topic,items)}</div><aside class="reading-analysis-notes"><h3>结果说明了什么</h3><div class="reading-observations">${items.map(c=>`<article><h4>${esc(c.title)}</h4><p>${c.points.length} 个保存数据点 · ${esc(c.x_label)} / ${esc(c.y_label)}</p><p>${esc(c.note||'按原模型口径展示；完整明细可在“数据与依据”中逐项核对。')}</p><details><summary>计算依据</summary><p>${esc(options.skillName(c.source))}</p></details></article>`).join('')}</div><h3 class="reading-actions-title">建议怎么做</h3>${advice.some(a=>a.topic===topic)?adviceHTML(advice.filter(a=>a.topic===topic),true):'<p class="reading-muted">结合现场情况核查计算结果，具体安排需以工程审查为准。</p>'}<button class="reading-evidence" data-reading-open-topic="evidence">查看原始数据与计算说明 →</button></aside></div>`;
    const evidence=`${basisHTML(d)}${knowledgeHTML(d)}<header class="reading-topic-heading"><h3>评估范围与计算依据</h3><p>下列资料对应当前任务与计算轮次，明细保留原始单位。</p></header>${tables.map((table,i)=>`<section class="reading-chapter"><details class="reading-table-detail" data-table="${i}"><summary>${esc(table.title)}<span>${table.total_rows||table.rows.length} 行</span></summary><div data-table-body data-linked-table="${i}">${tableHTML(table)}</div>${table.rows.length>20?`<label>页码 <select data-table-page aria-label="${esc(table.title)}页码">${Array.from({length:Math.ceil(table.rows.length/20)},(_,j)=>`<option value="${j}">${j+1}</option>`).join('')}</select></label>`:''}<p class="reading-muted">来源：${esc(table.source)}${table.total_rows>table.rows.length?` · 页面保留 ${table.rows.length} 行，完整数据见工作簿`:''}</p></details></section>`).join('')}<details class="reading-detail"><summary>模型假设与使用说明</summary><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details><details class="reading-detail"><summary>本轮计算链路</summary><ol>${(d.executed_components||[]).map(id=>`<li>${esc(options.skillName(id))}</li>`).join('')}</ol><p class="reading-muted">运行标识：${esc(d.source_run_id||'未记录')}</p></details><button class="reading-evidence" data-engineering-files>查看报告与文件 →</button>`;
    const opt=d.optimization;
    const optimizationHTML=opt?`<section class="reading-chapter" data-approved-optimization><header class="reading-topic-heading"><h3>恢复策略优化与工程队调度</h3><p>本轮已批准：${opt.parameters.team_count} 支工程队，每队每天 ${display(opt.parameters.daily_work_hours)} 小时，效率 ${display(opt.parameters.team_efficiency)} 倍。优化目标：${opt.parameters.repair_objective==='function_loss_area'?'累计功能损失最小':'达到目标功能时间最短'}；目标功能 ${display(opt.parameters.target_function*100)}%。下列结果已保存，调整参数请到执行审查中重新校验和批准。</p></header>${tableHTML({columns:[['name','恢复策略'],['loss_area_days','累计功能损失（功能损失·天）'],['target_time_days','达到目标功能（天）'],['total_days','本轮修复任务完工（天）']].map(([key,label])=>({key,label})),rows:opt.strategies.map(s=>({...s,target_time_days:s.target_reached===false?'未达到':s.target_time_days}))})}<label>查看已保存策略 <select data-approved-strategy>${opt.strategies.map(s=>`<option value="${esc(s.id)}" ${s.id===opt.recommended_strategy?'selected':''}>${esc(s.name)}${s.id===opt.recommended_strategy?' · 本轮推荐':''}</option>`).join('')}</select></label>${powerSystem?'<p class="reading-muted">'+(coordinationEnabled?'地图跟随所选电网恢复策略展示设施恢复与可关联的供电分区变化；应急电源和配送决策请查看多主体协同结果。':'地图跟随所选电网恢复策略展示设施恢复与可关联的供电分区变化，队伍安排见下方排程。')+'</p>'+(regional?'<button type="button" class="reading-evidence" data-reading-open-topic="regional">查看多主体协同全图 →</button>':''):''}<div data-approved-map></div><h4>设施修复优先级与工程队分配</h4><div data-approved-schedule></div><label>排程页码 <select data-approved-page></select></label><button class="reading-evidence" data-engineering-files>下载本轮优化工作簿与报告 →</button></section>`:'';
    const content={overview,objects:()=>analysis('objects',objects,comparison)+tables.filter(t=>t.role==='objects'||/震后损伤与功能明细/.test(t.title)).map(t=>`<section class="reading-chapter"><h3>${esc(t.title)}</h3><div data-linked-table="${tables.indexOf(t)}">${tableHTML(t)}</div><p>每页最多20条；全部 ${t.total_rows} 条可在数据与依据中翻页查看。</p></section>`).join(''),service:()=>`<header class="reading-topic-heading"><h3>${esc(service)}${powerSystem?'':'与空间分布'}</h3><p>${powerSystem?(coordinationEnabled?'本图聚焦变电站、线路和震后供电状态；人口分区见“停电范围与人口”，车辆、应急电源和配送见“多主体与应急协同”。':'本图聚焦变电站、线路和震后供电状态；人口分区见“停电范围与人口”，抢修安排与恢复回放见“恢复方案”。'):'在真实底图上查看设施、网络连接与本轮可关联的计算状态。'}</p></header><div data-network-map></div>${functions.length?analysis('service',service,functions):''}`,recovery:()=>`${optimizationHTML}${opt?'':completionHTML}${opt||d.system==='substation'?'':'<div data-network-map></div>'}${analysis('recovery','恢复过程与方案',recovery)}${tables.filter(t=>t.title==='设备修复排程'||t.title==='情景计算摘要').map(t=>`<section class="reading-chapter"><h3>${esc(t.title)}</h3><div data-linked-table="${tables.indexOf(t)}">${tableHTML(t)}</div><p>每页最多20条；完整明细见数据与依据及下载工作簿。</p></section>`).join('')}`,evidence};
    if(buildingLoss){
      const s=buildingLoss.summary;
      const rows=role=>{const table=tables.find(t=>t.role===role);if(!table)return '';const i=tables.indexOf(table);return `<section class="reading-chapter"><details class="reading-table-detail" data-table="${i}" open><summary>${esc(table.title)} · ${table.total_rows}栋</summary><div data-table-body data-linked-table="${i}">${tableHTML(table)}</div>${table.rows.length>20?`<label>页码 <select data-table-page>${Array.from({length:Math.ceil(table.rows.length/20)},(_,j)=>`<option value="${j}">${j+1}</option>`).join('')}</select></label>`:''}</details></section>`;};
      const notes=`<details class="reading-detail"><summary>计算方法与参数来源</summary><p>模型版本：${esc(buildingLoss.model_version)}。建筑面积=占地面积×层数；人口按建筑面积×用途人口密度的权重分配；伤亡期望=分配人口×对应时段在室率×结构及损伤等级伤亡率。</p><p>经济损失=建筑面积×单位面积重置成本×结构及损伤等级损失系数；采用建筑直接损失口径，以修复成本估算。</p><ul>${buildingLoss.notes.map(n=>`<li>${esc(n)}</li>`).join('')}</ul><p>人口依据：${esc(display(buildingLoss.population_basis))}</p><p>模型参数：${esc(display(buildingLoss.parameter_sources))}</p></details>`;
      content.casualties=()=>`<header class="reading-topic-heading"><h3>人员伤亡估计与日夜对比</h3><p>${s.population==null?'未提供本次建筑范围的人口，人数暂不估算；可在城市 Excel 中补充区域人口、覆盖范围与来源后重新评估。':`本次建筑范围录入人口 ${display(s.population)} 人；按用途、在室率及损伤计算模型期望，不是实际伤亡统计。`}</p></header><section class="reading-key-metrics" aria-label="日夜伤亡对比">${[['day','白天'],['night','夜晚'],['mean','昼夜平均']].map(([k,label])=>`<article><span>${label}伤亡期望</span><strong>${lossDisplay(s[k+'_expected'])}<em>人</em></strong><small>伤亡参考比：${display(s[k+'_ratio']*100)}%</small></article>`).join('')}</section><div data-network-map></div>${rows('building_casualties')}${notes}`;
      content.costs=()=>`<header class="reading-topic-heading"><h3>建筑经济损失与空间分布</h3><p>本轮估计经济损失约 ${money(s.repair_cost_yuan)}，建筑重置总值约 ${money(s.replacement_cost_yuan)}，经济损失比 ${(s.repair_cost_ratio*100).toLocaleString('zh-CN',{maximumFractionDigits:2})}%。采用建筑直接损失口径（以修复成本估算），不包含室内财产或营业中断。</p>${costExplanation(buildingLoss)}</header><div data-network-map></div>${rows('building_costs')}${notes}`;
    }
    const t=zh=>zh;
    content.regional=regional?'<div data-power-regional-results></div>':regionalNotComputed;
    content.impact='<div data-power-impact-results></div>';
    root.innerHTML=`<article class="integrated-engineering-results" aria-label="图文工程评估结果">${window.IntegratedResultsView.readingHeader({title:options.title+'评估',scopeText:options.scopeText||'本轮实际计算结果',iterations:options.iterations,options,t})}${window.IntegratedResultsView.readingNavigation(topics,t)}<p class="reading-selection-status" data-engineering-selection role="status" hidden></p>${topics.map(([key])=>`<section class="reading-panel" data-reading-panel="${key}" id="reading-panel-${key}" role="tabpanel" aria-labelledby="reading-tab-${key}" tabindex="-1" ${key==='overview'?'':'hidden'}>${typeof content[key]==='function'?content[key]():content[key]}</section>`).join('')}</article>`;
    function syncSelection(detail,source=null){
      if(state.syncing)return;state.selection=detail;state.syncing=true;
      try {root.querySelectorAll('[data-network-map],[data-approved-map],[data-power-regional-map]').forEach(el=>{if(el!==source)window.EngineeringNetworkMap?.select?.(el,{...detail,pan:false});});}finally{state.syncing=false;}
      let matches=0;
      root.querySelectorAll('[data-linked-table]').forEach(body=>{
        const table=tables[Number(body.dataset.linkedTable)];if(!table)return;
        const index=table.rows.findIndex(row=>table.columns.some(col=>matchesObject(objectIdentity(col,row,table),detail)));
        const detailRoot=body.closest('[data-table]'),pageControl=detailRoot?.querySelector('[data-table-page]');
        const page=index<0?Number(pageControl?.value||0):Math.floor(index/20);if(index>=0)matches++;
        if(pageControl)pageControl.value=String(page);
        body.innerHTML=tableHTML(table,page,detail);
      });
      const notice=root.querySelector('[data-engineering-selection]');if(notice){notice.hidden=!detail?.id;notice.textContent=detail?.id?`已选中 ${detail.name||detail.id} · ${matches?'对应明细已定位并标亮':'本轮尚无可按编号关联的对象明细'}。地图状态和恢复排程各自保留原计算口径。`:'';}
    }
    function showObjectDetails(detail){syncSelection(detail);if(buildingLoss&&['casualties','costs'].includes(state.topic)){root.querySelector(`[data-reading-panel="${state.topic}"] [data-linked-table]`)?.scrollIntoView({block:'nearest'});return;}selectTopic(topics.some(t=>t[0]==='objects')?'objects':'evidence',true);}
    state.onObjectClick=e=>{
      if(mounts.get(root)!==state)return;
      const button=e.target.closest('[data-engineering-object]');if(!button)return;
      const detail={id:button.dataset.engineeringObject,group:button.dataset.engineeringGroup,resultId:button.dataset.engineeringObject,resultGroup:button.dataset.engineeringGroup};
      const topic=buildingLoss&&['casualties','costs'].includes(state.topic)?state.topic:'service';
      state.selection=detail;selectTopic(topic,true);
      const map=root.querySelector(`[data-reading-panel="${topic}"] [data-network-map]`);
      if(map)window.EngineeringNetworkMap?.select?.(map,{...detail,pan:true});
      syncSelection(detail,map);
    };
    root.addEventListener?.('click',state.onObjectClick);
    function suspendMap(el){
      const saved=window.EngineeringNetworkMap?.captureState?.(el);
      if(saved&&el.dataset.readingMapKey)state.mapStates.set(el.dataset.readingMapKey,saved);
      window.EngineeringNetworkMap?.destroy(el);
    }
    function mountMap(el,key,settings){
      if(!el)return;
      suspendMap(el);el.dataset.readingMapKey=key;
      window.EngineeringNetworkMap?.mount(el,{sessionId:options.sessionId,iteration:options.iteration,resultRevision:options.resultRevision,powerProfile,sourceSignature:signature,selection:state.selection,...settings,initialState:state.mapStates.get(key),onSelect:detail=>syncSelection(detail,el),onDetails:showObjectDetails});
    }
    function selectTopic(topic,focus=false){
      if(!topics.some(x=>x[0]===topic))return;
      if(state.activeTopic===topic){if(focus)root.querySelector(`[data-reading-topic="${topic}"]`)?.focus({preventScroll:true});return;}
      root.querySelectorAll('[data-network-map],[data-schedule-map],[data-approved-map]').forEach(suspendMap);
      root.querySelectorAll('[data-power-impact-results]').forEach(el=>window.PowerImpactView?.suspend?.(el));
      root.querySelectorAll('[data-power-regional-results]').forEach(el=>window.PowerRestorationView?.suspend?.(el));
      state.topic=topic;state.activeTopic=topic;
      root.querySelectorAll('[data-reading-panel]').forEach(p=>p.hidden=p.dataset.readingPanel!==topic);
      root.querySelectorAll('[data-reading-topic]').forEach(b=>{const active=b.dataset.readingTopic===topic;b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;if(active&&focus)b.focus({preventScroll:true});});
      root.querySelector(`[data-reading-panel="${topic}"]`).querySelectorAll('[data-network-map]').forEach(el=>mountMap(el,topic,{showRecovery:topic==='recovery',...(buildingLoss&&['casualties','costs'].includes(topic)?{metric:topic==='costs'?'repair_cost_yuan':'mean_expected'}:{}),...(powerSystem?{view:topic==='service'?'grid':topic==='recovery'?'recovery':'overview'}:{})}));
      if(topic==='recovery'&&opt)showApprovedStrategy();
      if(topic==='regional'&&regional)window.PowerRestorationView?.mount(root.querySelector('[data-power-regional-results]'),regional,{...options,view:'coordination',sourceSignature:signature,selection:state.selection,onSelect:syncSelection,onDetails:showObjectDetails});
      if(topic==='impact'&&impact)window.PowerImpactView?.mount(root.querySelector('[data-power-impact-results]'),impact,{...options,view:'impact',sourceSignature:signature,selection:state.selection,onSelect:syncSelection,onDetails:showObjectDetails});
      root.querySelector(`[data-reading-panel="${topic}"]`).querySelectorAll('[data-reading-figures]').forEach(el=>window.PublicationGallery.mountInline(el,{sessionId:options.sessionId,iteration:options.iteration,language:options.language||'zh-CN',resultRevision:options.resultRevision,templateIds:el.dataset.templates.split(','),sourceSignature:signature}));
    }
    function showApprovedStrategy(){
      const id=root.querySelector('[data-approved-strategy]').value,s=opt.strategies.find(s=>s.id===id),page=root.querySelector('[data-approved-page]');
      const previousPage=state.approvedStrategy===id?Number(page.value||0):0;state.approvedStrategy=id;
      const table={columns:[['rank','优先顺序'],['group','类别'],['id','组件编号'],...(s.schedule.some(r=>r.asset_name)?[['asset_name','设施名称']]:[]),['team','工程队'],['start_day','开工（天）'],['end_day','完工（天）']].map(([key,label])=>({key,label})),rows:s.schedule.map(r=>({...r,group:({node:'节点',pipe:d.system==='power_system'?'电力支路':'管线',component:'道路组件'}[r.group]||r.group)}))};
      page.innerHTML=Array.from({length:Math.max(1,Math.ceil(table.rows.length/20))},(_,i)=>`<option value="${i}">${i+1}</option>`).join('');
      page.value=String(previousPage);
      const paint=()=>{root.querySelector('[data-approved-schedule]').innerHTML=tableHTML(table,Number(page.value));};page.onchange=paint;paint();
      mountMap(root.querySelector('[data-approved-map]'),'recovery:'+id,{strategy:id,sourceSignature:signature+id,...(powerSystem?{view:'recovery'}:{})});
    }
    root.querySelector('[data-approved-strategy]')?.addEventListener('change',showApprovedStrategy);
    root.querySelectorAll('[data-reading-topic],[data-reading-open-topic]').forEach(b=>b.addEventListener('click',()=>selectTopic(b.dataset.readingTopic||b.dataset.readingOpenTopic,true)));
    root.querySelectorAll('[data-reading-topic]').forEach(b=>b.addEventListener('keydown',e=>{const i=topics.findIndex(x=>x[0]===state.topic),next={ArrowRight:(i+1)%topics.length,ArrowLeft:(i-1+topics.length)%topics.length,Home:0,End:topics.length-1}[e.key];if(next!==undefined){e.preventDefault();selectTopic(topics[next][0],true);}}));
    root.querySelector('[data-reading-iteration]')?.addEventListener('change',e=>state.options.onIteration(Number(e.target.value)));
    root.querySelectorAll('[data-engineering-files]').forEach(b=>b.addEventListener('click',()=>state.options.onFiles()));
    root.querySelectorAll('[data-table]').forEach(el=>el.querySelector('[data-table-page]')?.addEventListener('change',e=>{el.querySelector('[data-table-body]').innerHTML=tableHTML(tables[Number(el.dataset.table)],Number(e.target.value),state.selection);}));
    selectTopic(topics.some(x=>x[0]===previousTopic)?previousTopic:'overview');
  }
  return {mount,destroy};
})();
