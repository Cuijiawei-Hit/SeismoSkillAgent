/* Saved regional restoration results. Values are read from the approved run only. */
window.PowerRestorationView = (() => {
  const mounts=new WeakMap();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits:3}) : value == null ? '—' : String(value);
  const valueText = value => typeof value === 'boolean' ? (value?'是':'否') : typeof value === 'object' && value != null ? JSON.stringify(value) : number(value);
  const labels = {government:'政府应急协调',utility:'电网企业',grid_operator:'电网企业',dispatcher:'电力调度员',crew:'抢修队伍',repair_crew:'抢修队伍',supplier:'物资供应方',logistics:'物流与道路保障',facility:'关键用电设施'};
  const statuses = {completed:'已完成',energized:'已送电',pending:'等待',in_transit:'在途',delivered:'已交付',assigned:'已分配',unresolved:'未解决',fuel_exhausted:'燃料耗尽',active:'供电中',returned:'已返回',repairing:'维修中',authorized:'已确认',received:'已验收',requested:'已申请',registered:'已登记',published:'已发布',validated:'已核验',unfulfilled:'缺货',reserved:'已预留',accepted:'已验收',rejected_incompatible:'不兼容，拒绝分配',available:'可用',connected:'已接入',closed:'封闭',already_damaged:'已受损',disconnected:'已断开',confirmed:'已确认',isolation_started:'开始隔离',safe_to_repair:'可安全维修',materials_consumed:'用料已消耗',awaiting_test:'待检验',ready_to_energize:'待送电',grid_recomputed:'已送电并重算电网'};
  const eventNames = {task_request:'抢修任务申请',service_demand:'关键服务需求',service_priority_policy:'关键服务保障优先级发布',human_action:'人工角色指令',material_request:'物资需求申请',material_shortage:'物资缺货',material_reservation:'物资预留',material_pickup:'物资出库取货',material_receipt:'到场验收',material_dispatch:'物资派送',generator_assignment:'应急电源分配',generator_dispatch:'应急电源派遣',crew_dispatch:'抢修队出发',vehicle_return:'车辆返回',generator_arrival:'应急电源接入',road_closure:'道路封闭',asset_redamage:'设施再次受损',task_authorization:'抢修任务确认',crew_arrival:'抢修队到场',isolation_complete:'隔离完成',repair_start:'维修开始',repair_complete:'维修完成',test_complete:'检验完成',energize:'确认送电'};
  const eventFields = {materials:'物资',missing:'缺料',shortage:'缺料数量',facility_priorities:'设施保障优先级',generator_id:'应急电源',vehicle_id:'车辆',warehouse_id:'仓库',priority:'优先级',critical_min_mw:'最低需求（MW）',action:'人工指令',team:'队伍',from:'起点',to:'终点',arrival_hours:'到场时刻（小时）',departure_hours:'出发时刻（小时）',return_hours:'返回时刻（小时）',reason:'原因'};
  const metrics = [['unserved_energy_mwh','未供电量（MWh）'],['critical_unserved_energy_mwh','关键设施未供电量（MWh）'],['critical_service_interruption_hours','关键服务中断（设施·小时）'],['critical_service_loss_equivalent_hours','等效关键供电损失（设施·小时）'],['priority_weighted_critical_interruption_hours','优先级加权服务中断（权重·小时）'],['outage_person_hours','停电影响（人·小时）'],['facility_population_interruption_person_hours','关键设施服务人口中断（人·小时）'],['material_wait_hours','缺料等待（任务·小时）'],['crew_material_wait_hours','队伍到场后缺料等待（队·小时）'],['coordination_wait_hours','协调等待（任务·小时）'],['crew_idle_hours','队伍空闲（队·小时）'],['final_grid_served_mw','末时刻电网供电（MW）'],['completed_tasks','完成维修任务数'],['total_tasks','维修任务总数']];
  function table(columns, rows, page = 0) {
    return `<div class="power-table-wrap"><table><thead><tr>${columns.map(([key,label]) => `<th scope="col">${esc(label)}</th>`).join('')}</tr></thead><tbody>${rows.slice(page*20,page*20+20).map(row => `<tr>${columns.map(([key]) => `<td>${esc(key === 'status' ? statuses[row[key]] || row[key] || '—' : key === 'service_available' && typeof row[key] === 'boolean' ? (row[key]?'满足最低用电':'未满足最低用电') : valueText(row[key]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${columns.length}">本轮没有此类记录</td></tr>`}</tbody></table></div>`;
  }
  function chart(rows) {
    const points = rows.filter(row => Number.isFinite(Number(row.time_hours)) && Number.isFinite(Number(row.service_ratio)));
    if (!points.length) return '<p class="reading-muted">没有保存服务轨迹。</p>';
    const maxTime = Math.max(1, ...points.map(row => Number(row.time_hours)));
    const x = time => 48 + Number(time)/maxTime*670;
    const y = ratio => 172-Math.max(0, Math.min(1,Number(ratio)))*140;
    const path = points.map((row,i) => i ? `H${x(row.time_hours).toFixed(2)} V${y(row.service_ratio).toFixed(2)}` : `M${x(row.time_hours).toFixed(2)},${y(row.service_ratio).toFixed(2)}`).join(' ');
    return `<svg class="power-service-chart" viewBox="0 0 760 210" role="img" aria-label="关键设施供电服务满足比例随时间变化，详细数值见下方轨迹表"><path class="power-chart-grid" d="M48 32H718 M48 102H718 M48 172H718"/><path class="power-chart-axis" d="M48 26V172H724"/><text x="12" y="36">100%</text><text x="22" y="106">50%</text><text x="29" y="176">0%</text><text x="48" y="196">0 小时</text><text x="650" y="196">${esc(number(maxTime))} 小时</text><path class="power-chart-line" d="${path}"/>${points.map(row => `<circle cx="${x(row.time_hours).toFixed(2)}" cy="${y(row.service_ratio).toFixed(2)}" r="2.5"><title>${esc(number(row.time_hours))} 小时：${esc(number(Number(row.service_ratio)*100))}%</title></circle>`).join('')}</svg>`;
  }
  function suspend(root){
    const state=mounts.get(root);if(!state?.mapMounted)return;
    const map=root.querySelector('[data-power-regional-map]'),saved=window.EngineeringNetworkMap?.captureState?.(map);
    if(saved)state.mapStates.set(state.strategyId,saved);
    window.EngineeringNetworkMap?.destroy(map);state.mapMounted=false;
  }
  function destroy(root){suspend(root);mounts.delete(root);}
  function mount(root, result, options = {}) {
    if (!root || !result) return;
    const old=mounts.get(root);
    if(old?.result===result&&options.sourceSignature&&old.options.sourceSignature===options.sourceSignature){old.options=options;old.resumeMap();return;}
    const signature=JSON.stringify([result,options.sourceSignature]);
    if(old?.signature===signature){old.options=options;old.resumeMap();return;}
    destroy(root);
    const state={signature,result,options,strategyId:null,mapStates:new Map(),mapMounted:false};mounts.set(root,state);
    const strategies = Array.isArray(result.strategies) ? result.strategies : [];
    const roles = Array.isArray(result.roles) ? result.roles : [];
    const parameters = result.parameters || {};
    const hasZonePopulation = Array.isArray(parameters.zones) && parameters.zones.some(row => typeof row.population === 'number' && Number.isFinite(row.population) && row.population > 0);
    const hasFacilityPopulation = Array.isArray(parameters.facilities) && parameters.facilities.some(row => typeof row.population === 'number' && Number.isFinite(row.population) && row.population > 0);
    const displayedMetrics = metrics.filter(([key]) => (key !== 'outage_person_hours' || hasZonePopulation) && (key !== 'facility_population_interruption_person_hours' || hasFacilityPopulation));
    const populationNote = !hasZonePopulation || !hasFacilityPopulation ? '<p class="reading-muted">本台账不另造服务人口；居民停电影响请查看本轮供电分区与人口评估，不能将未录入人口解释为零影响。</p>' : '';
    const facilityName = id => (Array.isArray(parameters.facilities) ? parameters.facilities : []).find(row => String(row.id) === String(id))?.name || id;
    const demonstration = /demonstration|synthetic|example|演示|展示|假设|示例/i.test(`${parameters.source || ''} ${parameters.note || ''}`);
    const inventoryNote = demonstration ? `<aside class="power-resource-assumption" role="note"><strong>演示资源 · 假设台账</strong><p>${esc(parameters.note || '本轮应急资源位置、数量、容量与运输时间为演示假设，未作为奥克兰实测资源。')}</p><p>${esc((parameters.facilities || []).length)} 个关键设施 · ${esc((parameters.warehouses || []).length)} 个仓库 · ${esc((parameters.vehicles || []).length)} 辆车 · ${esc((parameters.generators || []).length)} 台移动电源</p></aside>` : '';
    root.innerHTML = `<header class="reading-topic-heading"><h3>区域恢复与多主体协同</h3><p>查看本轮已保存的资源调度、关键设施供电和角色交互。时间以灾害发生后小时计，比较策略采用相同输入与资源。</p></header>${inventoryNote}<div class="power-chain" aria-label="区域恢复链条">灾损与需求 <span>→</span> 协调与资源预留 <span>→</span> 配送和抢修 <span>→</span> 检验与送电 <span>→</span> 服务恢复与反馈</div><div data-power-map-top></div><section class="reading-chapter"><h4>角色与权限</h4>${table([['name','主体'],['authority','职责与决策权限']],roles)}<p class="reading-muted">本版为有明确权限和事件记录的规则主体仿真；人工优先级及发电机分配指令见本轮配置。角色记录不能替代现场调度操作。</p></section><section class="reading-chapter"><h4>同一情景下的策略对比</h4>${strategies.length ? table([['metric','指标'], ...strategies.map(strategy => [strategy.id,strategy.name || strategy.id])], displayedMetrics.filter(([key]) => strategies.some(strategy => strategy.metrics?.[key] != null)).map(([key,label]) => Object.fromEntries([['metric',label],...strategies.map(strategy => [strategy.id,strategy.metrics?.[key]])]))) : '<p>本轮没有可比较的策略。</p>'}${populationNote}<p class="reading-muted">人·小时依据配置中的人口和供电比例估算，不能据此判断每户的实际停电状态。规则策略比较不代表已求得全局最优解。</p></section><div class="power-result-controls"><label>查看保存策略 <select data-power-strategy>${strategies.map(strategy => `<option value="${esc(strategy.id)}" ${strategy.id===result.recommended_strategy?'selected':''}>${esc(strategy.name || strategy.id)}${strategy.id===result.recommended_strategy?' · 本轮推荐':''}</option>`).join('')}</select></label><span>评估时窗：${esc(number(parameters.horizon_hours))} 小时</span></div><div data-power-strategy-body></div><details class="reading-detail"><summary>本轮参数与模型假设</summary>${(result.assumptions || []).map(item => `<p>${esc(valueText(item))}</p>`).join('')}<pre class="power-config-snapshot">${esc(JSON.stringify(parameters,null,2))}</pre></details>`;
    function paginatedTable(target, columns, rows) {
      let page = 0;
      function paint() {
        target.innerHTML = `${table(columns,rows,page)}${rows.length>20 ? `<label class="power-page-control">页码 <select data-power-page>${Array.from({length:Math.ceil(rows.length/20)},(_,i) => `<option value="${i}" ${i===page?'selected':''}>${i+1}</option>`).join('')}</select> · 共 ${rows.length} 条</label>` : `<p class="reading-muted">${rows.length} 条保存记录</p>`}`;
        target.querySelector('[data-power-page]')?.addEventListener('change', event => {page=Number(event.target.value);paint();});
      }
      paint();
    }
    state.resumeMap=()=>{
      if(state.mapMounted||!state.options.sessionId||!window.EngineeringNetworkMap)return;
      const map=root.querySelector('[data-power-regional-map]');if(!map)return;
      window.EngineeringNetworkMap.mount(map,{...state.options,view:'coordination',strategy:'regional:'+state.strategyId,initialState:state.mapStates.get(state.strategyId),sourceSignature:(state.options.sourceSignature || '')+':regional:'+state.strategyId,onSelect:detail=>state.options.onSelect?.(detail,map)});
      state.mapMounted=true;
    };
    function showStrategy() {
      suspend(root);
      const strategy = strategies.find(item => item.id===root.querySelector('[data-power-strategy]')?.value) || strategies[0];
      const body = root.querySelector('[data-power-strategy-body]');
      if (!strategy) {body.textContent='没有保存的调度结果。';return;}
      state.strategyId=strategy.id;
      const events = Array.isArray(strategy.events) ? strategy.events : [];
      const traces = Array.isArray(strategy.facility_trace) ? strategy.facility_trace : [];
      const facilities = [...new Set(traces.map(row => row.facility_id))];
      const eventRoles = [...new Set(events.map(row => row.role).filter(Boolean))];
      const eventTypes = [...new Set(events.map(row => row.type).filter(Boolean))];
      body.innerHTML = `<section class="reading-chapter"><h4>关键设施供电服务轨迹</h4><label>关键设施 <select data-power-facility>${facilities.map(id => `<option value="${esc(id)}">${esc(facilityName(id))}</option>`).join('')}</select></label><div data-power-service-chart></div><p class="reading-muted">图示电网、备用电源和移动电源合计相对于最低用电需求的满足比例；设施自身损伤与非电力条件需另行核查。</p><details class="reading-detail"><summary>展开供电与燃料明细</summary><div data-power-facility-table></div></details></section><section class="reading-chapter"><h4>抢修工序与送电安排</h4><p class="reading-muted">队伍到场、隔离、维修、检验和送电分别记录；尚未完成的任务保留当前状态。</p><div data-power-repairs></div></section><section class="reading-chapter"><h4>物资配送与库存</h4><div data-power-shipments></div><details class="reading-detail"><summary>仓库、现场与消耗台账</summary><pre class="power-config-snapshot">${esc(JSON.stringify({...strategy.material_ledger,shipments:undefined},null,2))}</pre></details></section><section class="reading-chapter"><h4>移动应急电源安排</h4><div data-power-generators></div></section><section class="reading-chapter"><h4>多主体交互事件</h4><div class="power-result-controls"><label>角色 <select data-power-event-role><option value="">全部角色</option>${eventRoles.map(id => `<option value="${esc(id)}">${esc(roles.find(role=>role.id===id)?.name || labels[id] || id)}</option>`).join('')}</select></label><label>事件 <select data-power-event-type><option value="">全部事件</option>${eventTypes.map(type => `<option value="${esc(type)}">${esc(eventNames[type] || type)}</option>`).join('')}</select></label></div><div data-power-events></div></section><section class="reading-chapter"><h4>未解决任务与警告</h4><div data-power-unresolved></div>${(strategy.warnings || result.warnings || []).map(item=>`<p class="power-warning">${esc(valueText(item))}</p>`).join('')}</section>`;
      if(state.options.sessionId && window.EngineeringNetworkMap){
        const controls=root.querySelector('[data-power-strategy]').closest('.power-result-controls'),top=root.querySelector('[data-power-map-top]');
        top.innerHTML='<section class="reading-chapter"><h4>多主体协同与应急恢复全图</h4><p class="reading-muted">此处联动查看所选协同策略的电网、供电分区、关键设施、仓库、队伍、车辆与移动电源；任务和运输路线按图层开关查看。</p><div data-power-regional-map></div><p class="reading-muted">先在地图上选择图层、灾后时刻和处置对象。缺边界显示关联节点代理，未定位对象另列清单；二维地图无需等待三维背景。</p></section>';
        top.prepend(controls);
        state.resumeMap();
      }
      const renderFacility = () => {
        const selected = body.querySelector('[data-power-facility]').value;
        const rows = traces.filter(row=>String(row.facility_id)===selected).sort((a,b)=>a.time_hours-b.time_hours);
        body.querySelector('[data-power-service-chart]').innerHTML=chart(rows);
        paginatedTable(body.querySelector('[data-power-facility-table]'),[['time_hours','时刻（小时）'],['grid_supply_mw','电网（MW）'],['backup_supply_mw','备用电源（MW）'],['generator_supply_mw','移动电源（MW）'],['served_mw','合计（MW）'],['critical_min_mw','最低需求（MW）'],['service_ratio','满足比例（0—1）'],['service_available','最低用电保障'],['backup_remaining_mwh','备用剩余（MWh）'],['generator_fuel_liters','移动电源燃料（升）']],rows);
      };
      body.querySelector('[data-power-facility]').addEventListener('change',renderFacility);renderFacility();
      paginatedTable(body.querySelector('[data-power-repairs]'),[['asset_key','维修对象'],['team','队伍'],['location_id','地点'],['crew_arrival_hours','到场（小时）'],['isolation_end_hours','隔离完成（小时）'],['repair_start_hours','维修开始（小时）'],['repair_end_hours','维修完成（小时）'],['test_end_hours','检验完成（小时）'],['energized_hours','送电（小时）'],['material_wait_hours','缺料等待（小时）'],['status','状态']],strategy.schedules || []);
      paginatedTable(body.querySelector('[data-power-shipments]'),[['id','配送单'],['asset_key','维修对象'],['warehouse_id','仓库'],['vehicle_id','车辆'],['materials','物资与数量'],['departure_hours','出发（小时）'],['arrival_hours','交付（小时）'],['return_hours','返回（小时）'],['status','状态']],strategy.material_ledger?.shipments || []);
      paginatedTable(body.querySelector('[data-power-generators]'),[['generator_id','应急电源'],['facility_id','保障设施'],['vehicle_id','车辆'],['departure_hours','出发（小时）'],['arrival_hours','到场（小时）'],['remaining_fuel_liters','剩余燃料（升）'],['status','状态']],strategy.emergency_schedule || []);
      paginatedTable(body.querySelector('[data-power-unresolved]'),[['asset_key','维修对象'],['status','状态'],['reason','原因']],strategy.unresolved_tasks || []);
      const renderEvents=()=>{
        const role=body.querySelector('[data-power-event-role]').value,type=body.querySelector('[data-power-event-type]').value;
        const rows=events.filter(row=>(!role||row.role===role)&&(!type||row.type===type)).map(row=>({...row,role:roles.find(role=>role.id===row.role)?.name || labels[row.role] || row.role,sender:labels[row.sender] || row.sender,recipient:labels[row.recipient] || row.recipient,type:eventNames[row.type] || row.type,state:statuses[row.state] || row.state,message:row.message || Object.entries(row).filter(([key])=>!['time_hours','role','sender','recipient','type','state','asset_key','facility_id','message'].includes(key)).map(([key,value])=>`${eventFields[key] || key}：${valueText(value)}`).join('；')})).sort((a,b)=>a.time_hours-b.time_hours);
        paginatedTable(body.querySelector('[data-power-events]'),[['time_hours','时刻（小时）'],['role','角色'],['sender','发出方'],['recipient','接收方'],['type','事件'],['state','任务状态'],['asset_key','维修对象'],['facility_id','设施'],['message','决策与反馈']],rows);
      };
      body.querySelector('[data-power-event-role]').addEventListener('change',renderEvents);body.querySelector('[data-power-event-type]').addEventListener('change',renderEvents);renderEvents();
    }
    root.querySelector('[data-power-strategy]').addEventListener('change',showStrategy);showStrategy();
  }
  return {mount,destroy,suspend};
})();
