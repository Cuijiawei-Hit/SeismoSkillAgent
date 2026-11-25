/* Bind saved PowerSkillAgent outputs to the unmodified Rescity result reader.
 * This adapter maps presentation fields only. It never runs an engineering model.
 */
(() => {
  'use strict';
  const manifests = new Map();
  const figureRequests = new Map();
  const mounted = new WeakMap();
  const list = value => Array.isArray(value) ? value : [];
  const keyFor = options => `${options.sessionId}|${Number(options.iteration || 1)}`;
  const strategyLabel = id => ({id_order:'编号顺序基准',importance:'系统功能增益排序',ga:'遗传算法搜索'}[id] || id || '未记录');
  const scalar = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const stateLabel = value => ({1:'基本完好',2:'轻微破坏',3:'中等破坏',4:'严重破坏',5:'完全破坏'}[value] || String(value ?? '未记录'));
  const column = (key,label) => ({key,label});
  const table = (title,columns,rows,source,role) => ({title,columns,rows,total_rows:rows.length,source,...(role?{role}:{})});
  function figureManifest(options) {
    const source=manifests.get(keyFor(options));
    return typeof source==='function'?source(options):source||null;
  }
  function requestFigureManifest(data,iteration,options={}) {
    const round=Number(iteration?.iteration||data.iteration||1),delivery=iteration?(iteration.result_delivery||{}):(data.result_delivery||{});
    const language=options.language||data.display_language||data.output_language||'en-US';
    const key=[data.session_id,round,language,iteration?.run_id||delivery.run_id,delivery.presentation_revision_id||''].join('|');
    if(options.force)figureRequests.delete(key);
    if(!figureRequests.has(key)) {
      const params=new URLSearchParams({iteration:String(round),language});
      const url=`/api/sessions/${encodeURIComponent(data.session_id)}/reference-figures?${params}`;
      const request=fetch(url,{headers:{Accept:'application/json'},cache:'no-store'}).then(async response=>{
        const payload=await response.json();
        if(!response.ok)throw new Error(payload.error||payload.message||`原版图册请求失败（${response.status}）。`);
        if(!payload||!Array.isArray(payload.figures))throw new Error('原版图册没有返回有效的保存图件。');
        return payload;
      }).catch(error=>{figureRequests.delete(key);throw error;});
      figureRequests.set(key,request);
      while(figureRequests.size>16)figureRequests.delete(figureRequests.keys().next().value);
    }
    return figureRequests.get(key);
  }
  function knowledgeReferences(data,interpretation) {
    return list(data.knowledge_evidence).map(item=>({
      title:item.title,quote:item.snippet||'',kind:'method',
      applies_to:`${interpretation.includes(item.evidence_id)?'本轮解读已引用':'本轮已检索，是否采纳请核对解读'}；仅用于方法解释及适用条件核对。${item.locator?' '+item.locator:''}`,
      evidence_id:item.evidence_id,source_url:item.source_url||null,
      ...(Number.isFinite(Number(item.page)) && item.page!=null?{page:Number(item.page)}:{})
    }));
  }
  function buildDelivery(data,summary,iteration) {
    const saved=iteration?(iteration.result_delivery||{}):(data.result_delivery||{});
    const recovery=summary.recovery||{},power=summary.function||{},damage=summary.damage||{},inventory=summary.inventory||{};
    const network=summary.network||inventory.network||{},names=new Map(list(network.nodes).map(node=>[String(node.id),node.name||String(node.id)]));
    const interpretation=String(iteration?.interpretation||iteration?.current_interpretation||(!iteration||Number(iteration.iteration)===Number(data.iteration)?data.current_interpretation||data.final_answer:'')||'');
    const strategies=list(recovery.strategies).map(item=>({
      ...Object.fromEntries(Object.entries(item).filter(([key])=>!['frames','network_frames'].includes(key))),
      name:item.name||strategyLabel(item.id),
      schedule:list(item.schedule).map(row=>({...row,raw_id:row.id,id:row.key||`${row.group==='node'?'node':'pipe'}:${row.id}`,group:row.group==='branch'?'pipe':row.group,
        asset_name:row.group==='node'?(names.get(String(row.id))||String(row.id)):`电力支路 ${row.id}`}))
    }));
    const charts=[];
    for(const [group,label] of [['nodes','节点'],['branches','支路']])if(list(damage[group]).length) {
      const counts=new Map();for(const row of damage[group])counts.set(row.state,(counts.get(row.state)||0)+1);
      charts.push({id:`power-damage-${group}`,title:`${label}损伤状态分布`,kind:'bar',figure_group:'damage',
        points:[...counts].sort((a,b)=>Number(a[0])-Number(b[0])).map(([state,count])=>({x:stateLabel(state),y:count})),
        x_label:'本轮保存的原模型损伤状态',y_label:`${label}数量（个）`,source:'power_system.damage_assessment',
        note:'按本轮保存的组件状态分组计数；原始状态码、组件功能及对象编号保留在明细中。'});
    }
    if(power.pre_supply_mw!=null || power.post_supply_mw!=null) charts.push({
      id:'power-supply',title:'震前与震后供电功率',kind:'bar',figure_group:'supply',
      points:[{x:'震前供电',y:power.pre_supply_mw},{x:'震后供电',y:power.post_supply_mw}].filter(point=>scalar(point.y)!=null),
      x_label:'保存情景',y_label:'供电功率（MW）',source:'power_system.function_assessment',
      note:'MW为保存的供电功率；原模型为稀疏直流供电评估，不能替代实际运行调度。'
    });
    for(const strategy of strategies)if(list(strategy.curve).length) {
      const points=[];strategy.curve.forEach((point,index)=>{
        const x=point.time??point.time_day,y=point.function??point.function_ratio;
        if(index)points.push({x,y:strategy.curve[index-1].function??strategy.curve[index-1].function_ratio});
        points.push({x,y});
      });
      charts.push({id:`power-recovery-${strategy.id}`,title:strategy.name+' · 有限队伍恢复曲线',kind:'line',figure_group:'recovery',
        points,x_label:'震后时间（天）',y_label:'相对震前供电功能',source:'power_system.recovery_optimization',
        note:'本轮已批准资源下逐事件回算；阶梯点对应保存时刻，不插值。目标达标、全部完工和累计功能损失分别比较，搜索结果不等于全局最优。'});
    }
    const tables=[];
    if(list(damage.nodes).length) tables.push(table('节点震后损伤与功能明细',[
      column('id','节点编号'),column('name','设施名称'),column('pga_g','PGA（g）'),column('state_label','损伤状态'),column('state','原始状态码'),column('availability','组件功能状态'),column('asset_type','组件类型')
    ],damage.nodes.map(row=>({id:String(row.id),name:names.get(String(row.id))||String(row.id),pga_g:row.pga_g,state:row.state,state_label:stateLabel(row.state),availability:row.function,asset_type:row.asset_type})), 'power_system.damage_assessment','objects'));
    if(list(damage.branches).length) tables.push(table('支路震后损伤与功能明细',[
      column('id','支路编号'),column('from_node','起点节点'),column('to_node','终点节点'),column('pga_g','PGA（g）'),column('state_label','损伤状态'),column('state','原始状态码'),column('availability','组件功能状态'),column('asset_type','组件类型')
    ],damage.branches.map(row=>({...row,id:String(row.id),state_label:stateLabel(row.state),availability:row.function})), 'power_system.damage_assessment','objects'));
    if(strategies.length) tables.push(table('恢复策略比较',[
      column('name','恢复策略'),column('loss_area_days','累计功能损失（功能损失·天）'),column('target_time_days','目标功能达标（天）'),column('total_days','全部修复完成（天）'),column('resilience_index','共同评价期韧性指数')
    ],strategies.map(item=>({name:item.name,loss_area_days:item.loss_area_days,target_time_days:item.target_time_days,total_days:item.total_days,resilience_index:item.resilience_index})), 'power_system.recovery_optimization'));
    for(const section of list(saved.sections)) for(const item of list(section.tables)) {
      if(!list(item.columns).length || !list(item.rows).length)continue;
      tables.push({...item,title:item.title||section.title,source:item.source||section.skill_id||section.title,
        columns:item.columns.map(c=>typeof c==='string'?column(c,c):{key:c.key,label:c.label||c.key}),
        total_rows:item.total_rows??item.rows.length});
    }
    const recommended=strategies.find(item=>item.id===recovery.recommended_strategy)||strategies[0]||{};
    const impact=summary.impact||{};
    const scope=impact.strategies?.find(item=>item.id===impact.recommended_strategy)||impact;
    const initial=scope.initial_summary||impact.initial_summary||{},coverage=scope.coverage||impact.coverage||{};
    const metrics=[
      power.pre_supply_mw!=null?{label:'震前供电功率',value:power.pre_supply_mw,unit:'MW',source:'power_system.function_assessment',note:'本轮保存的震前基准'}:null,
      power.post_supply_mw!=null?{label:'震后供电功率',value:power.post_supply_mw,unit:'MW',source:'power_system.function_assessment',note:'本轮保存的震后初始状态'}:null,
      damage.damaged_count!=null?{label:'待修复对象',value:damage.damaged_count,unit:'个',source:'power_system.damage_assessment',note:`${damage.damaged_node_count??'—'} 个节点、${damage.damaged_branch_count??'—'} 条支路`}:null,
      recommended.target_time_days!=null?{label:'推荐方案目标达标时间',value:recommended.target_time_days,unit:'天',source:'power_system.recovery_optimization',note:`全部修复完成 ${recommended.total_days??'—'} 天`}:null,
      initial.full_outage_population!=null?{label:'全部失供区域人口（估计）',value:initial.full_outage_population,unit:'人',source:'power_system.outage_impact',note:`未映射人口 ${coverage.unmapped_population??'未记录'} 人`}:null
    ].filter(Boolean);
    const decision=window.ReferencePowerDecision?.build(data,summary,iteration);
    const warnings=[...new Set([...list(summary.warnings),...list(saved.warnings)].filter(Boolean))];
    const delivery={schema_version:'engineering.presentation.v1',system:'power_system',region:inventory.region||{city_name:summary.city},
      metrics,charts,tables,warnings,findings:decision?.expanded_explanation||decision?.summary||[],decision,
      executed_components:list(summary.executed_components),source_run_id:iteration?.run_id||saved.run_id||data.skill_result?.run_id,
      optimization:strategies.length?{...recovery,strategies}:null,
      power_impact:impact.strategies?.length?{...impact,strategies:impact.strategies.map(item=>({...item,timeline:undefined}))}:null,
      power_profile:{regional_restoration_enabled:false},
      knowledge_references:knowledgeReferences(data,interpretation),
      input_basis:{source_title:inventory.title||summary.city,source_note:inventory.source_note||'',
        assumptions:list(inventory.assumptions),map_notes:list(summary.network?.notes),
        located_nodes:list(network.nodes).filter(node=>Number.isFinite(Number(node.longitude))&&Number.isFinite(Number(node.latitude))).length,
        located_links:list(network.edges||network.links||network.branches).length,endpoint_only_links:null,
        scope_note:inventory.source_note?.split(/\r?\n/)[0]||'本次冻结数据版本及录入范围。'}
    };
    if(saved.display_revision && /^[a-f0-9]{64}$/.test(saved.display_revision))delivery.display_revision=saved.display_revision;
    return delivery;
  }
  function render(host,data,summary,iteration,options={}) {
    if(!host||!summary||summary.target_system!=='power_system')return false;
    if(!window.EngineeringResultsView||!window.IntegratedResultsView)throw new Error('原版工程结果组件尚未加载。');
    const previous=mounted.get(host),delivery=buildDelivery(data,summary,iteration),round=Number(iteration?.iteration||data.iteration||1);
    manifests.set(`${data.session_id}|${round}`,figureOptions=>options.figureManifest?.(data,summary,iteration,delivery,figureOptions)||requestFigureManifest(data,iteration,figureOptions));
    while(manifests.size>16)manifests.delete(manifests.keys().next().value);
    window.EngineeringResultsView.mount(host,delivery,{
      sessionId:data.session_id,iteration:round,language:options.language||data.output_language||'zh-CN',
      resultRevision:delivery.display_revision,powerProfile:{regional_restoration_enabled:false},
      title:'电力系统',scopeText:[delivery.region?.city_name,delivery.region?.region_name].filter(Boolean).join(' · '),
      iterations:list(data.iterations),skillName:options.skillName||strategyLabel,
      onIteration:options.onIteration||(()=>{}),onFiles:options.onFiles||(()=>{})
    });
    // The reference app mounts one reader. This standalone platform also has a
    // separate spatial tab, so keep each reader's ARIA IDs local to its host.
    host.querySelectorAll('[id^="reading-"]').forEach(element=>{
      const oldId=element.id,newId=`${host.id}-${oldId}`;element.id=newId;
      host.querySelectorAll('[aria-controls],[aria-labelledby]').forEach(control=>{
        for(const name of ['aria-controls','aria-labelledby'])if(control.getAttribute(name)===oldId)control.setAttribute(name,newId);
      });
    });
    mounted.set(host,{data,summary,iteration,delivery});
    if(options.initialTopic && previous?.data?.session_id!==data.session_id)openTopic(host,options.initialTopic);
    return true;
  }
  function openTopic(host,id) {
    const topic=({network:'service',grid:'service',spatial:'service',damage:'objects',sources:'evidence'}[id]||id);
    if(!['overview','objects','service','impact','recovery','evidence'].includes(topic))return false;
    const button=host?.querySelector(`[data-reading-topic="${topic}"]`);if(!button)return false;
    button.click();return true;
  }
  function destroy(host) { if(host){window.EngineeringResultsView?.destroy(host);mounted.delete(host);} }
  function resize(host) {
    if(!host)return;
    host.querySelectorAll('[data-network-map],[data-approved-map]').forEach(el=>window.EngineeringNetworkMap?.resize?.(el));
    host.querySelectorAll('[data-power-impact-results]').forEach(el=>window.PowerImpactView?.resize?.(el));
  }
  window.ReferencePowerResults=Object.freeze({render,buildDelivery,figureManifest,openTopic,resize,destroy});
})();
