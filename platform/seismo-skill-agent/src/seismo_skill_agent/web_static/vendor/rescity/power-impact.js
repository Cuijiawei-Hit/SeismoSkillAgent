/* Geographic outage exposure from saved engineering.power-impact.v1 artifacts.
 * Boundary provenance and electrical assignment are separate evidence fields.
 * Unknown population/supply is deliberately never displayed as zero. */
window.PowerImpactView = (() => {
  const mounts = new WeakMap();
  const savedImpact = new Map();
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
  const number = (value, digits = 1) => finite(value) ? value.toLocaleString('zh-CN', {maximumFractionDigits:digits}) : '未知';
  const percent = value => finite(value) ? number(value * 100) + '%' : '未知';
  const list = value => Array.isArray(value) ? value : [];
  const safeLink = value => { try { const url = new URL(value); return ['https:','http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
  const statuses = {full_outage:'全部失供',partial_outage:'部分失供',grid_supplied:'无失供',unknown:'供电状态未知'};
  const cityName = artifact => {
    const city = artifact.city;
    if (typeof city === 'string' && city.trim()) return city;
    if (city && typeof city === 'object') {const names = [...new Set([city.name,city.city_name,city.region_name].filter(value => typeof value === 'string' && value.trim()))];if (names.length) return names.join(' · ');}
    return typeof artifact.title === 'string' && artifact.title.trim() ? artifact.title : '本轮研究范围';
  };
  function calculationHTML(artifact) {
    const calculation = artifact.calculation || {}, damage = artifact.damage_scenario || {}, values = [];
    const pga = calculation.pga_g ?? damage.pga_g, seed = calculation.seed ?? damage.seed, mode = calculation.damage_mode ?? damage.mode;
    if (finite(pga)) values.push(`PGA ${number(pga,3)}g`);
    if (mode) values.push(({sampled:'可复现概率抽样',most_likely:'最大概率损伤等级'})[mode] || String(mode));
    if (finite(seed)) values.push(`随机种子 ${number(seed,0)}`);
    if (finite(calculation.team_count)) values.push(`${number(calculation.team_count,0)} 支抢修队`);
    if (finite(calculation.daily_work_hours)) values.push(`每天 ${number(calculation.daily_work_hours)} 小时`);
    const note = typeof calculation.note === 'string' ? calculation.note : typeof artifact.calculation_note === 'string' ? artifact.calculation_note : '';
    if (!values.length && !note) return '';
    return `<p class="power-impact-frame power-impact-calculation" data-impact-calculation><strong>本轮计算情景：</strong>${esc(values.join(' · '))}${note ? `<br><small>${esc(note)}</small>` : ''}</p>`;
  }
  function impactReference(delivery, options) {
    const ref=delivery?.power_impact;
    if(ref?.schema_version!=='engineering.power-impact.ref.v1')return null;
    const iteration=Number(options.iteration),expected=`/api/engineering/native/sessions/${encodeURIComponent(options.sessionId)}/iterations/${iteration}/power-impact`;
    if(!Number.isSafeInteger(iteration)||iteration<1||ref.session_id!==options.sessionId||ref.iteration!==iteration||
      options.iterationId&&ref.iteration_id!==options.iterationId||ref.url!==expected)throw new Error('停电影响结果引用与选中任务轮次不一致，请重新读取该轮结果。');
    return {ref,key:[options.sessionId,iteration,options.iterationId || ref.iteration_id,options.runId || delivery.source_run_id || '',ref.url,options.resultRevision || delivery.display_revision || ''].join(':')};
  }
  function readyDelivery(delivery, options) {
    if(delivery?.power_impact?.schema_version!=='engineering.power-impact.ref.v1')return delivery;
    const reference=impactReference(delivery,options),current=options.currentDelivery,revision=options.resultRevision || delivery.display_revision;
    if((!revision||current?.display_revision===revision)&&Number(options.currentIteration)===Number(options.iteration)&&current?.power_impact?.schema_version==='engineering.power-impact.v1'&&
      (!options.runId||!current.source_run_id||options.runId===current.source_run_id))return {...delivery,power_impact:current.power_impact};
    const artifact=savedImpact.get(reference.key)?.value;return artifact?{...delivery,power_impact:artifact}:null;
  }
  async function loadDelivery(delivery, options) {
    const ready=readyDelivery(delivery,options);if(ready)return ready;
    const {ref,key}=impactReference(delivery,options);
    if(!savedImpact.has(key)){
      const revision=/^[a-f0-9]{64}$/.test(options.resultRevision || delivery.display_revision || '')?(options.resultRevision || delivery.display_revision):null;
      const entry={value:null};entry.promise=Promise.resolve().then(()=>options.api(ref.url+'?view=summary'+(revision?'&revision='+encodeURIComponent(revision):''),{cache:revision?'force-cache':'no-store'})).then(artifact=>{
        if(revision&&artifact.display_revision!==revision)throw new Error('停电影响结果版本已变化，请重新打开本轮结果。');
        if(artifact?.schema_version!=='engineering.power-impact.v1')throw new Error('该轮停电影响结果的格式不完整。');
        if(options.runId&&artifact.source_run_id&&artifact.source_run_id!==options.runId)throw new Error('返回的停电影响结果属于不同运行，已停止显示。');
        entry.value=artifact;return artifact;
      }).catch(error=>{savedImpact.delete(key);throw error;});savedImpact.set(key,entry);while(savedImpact.size>2)savedImpact.delete(savedImpact.keys().next().value);
    }
    const artifact=await savedImpact.get(key).promise;return {...delivery,power_impact:artifact};
  }
  const bases = {
    official_service_area:'官方供电分区',official_supply_area:'官方供电分区',official_zone_substation_area:'官方变电站供电分区',
    published_service_area:'公开供电分区',user_provided_service_area:'明确录入的服务区边界',recorded_polygon:'明确录入的边界',
    census_polygon:'官方普查统计面',official_census_boundary:'官方普查统计面',official_statistical_area:'官方统计面',
    inferred_service_area:'推断供电分区',voronoi_inferred:'按供电节点推断的分区',nearest_node_assignment:'最近节点关联推断',
    public_network_service_area:'公开电网服务区',explicit_node_assignment:'明确录入的电网关联',official_node_assignment:'官方供电关联',
    census_area_intersection:'普查面与供电分区叠加，面内均匀分配人口',area_weighted_census:'普查面按相交面积分配人口'
  };
  Object.assign(bases,{inferred_clipped_voronoi_nearest_node:'按最近节点推断、裁剪至研究范围的分区',inferred_nearest_node_not_verified_electrical_service:'最近节点关联推断，未经电气供电关系核验',census_polygon_uniform_area_intersection_equivalent_exposure:'普查面内均匀人口，按相交面积分配及缺供比例估算',explicit_node_weights_and_saved_supply:'明确节点权重与保存供电比例',published_node_load_weights_and_saved_supply:'发布节点负荷权重与保存供电比例',study_clipped_exclusive_service_area:'研究范围内扣除重叠不确定部分的供电分区'});
  Object.assign(bases,{operator_disclosed_service_area:'运营商正式披露的供电分区',exact_Vector_operator_station_code_to_existing_equivalent_network_load_node:'Vector 站点代码精确匹配至现有等值电网负荷节点',explicit_study_area_minus_exclusive_service_coverage:'研究范围扣除明确供电分区后的区域',unmapped_or_overlapping_service_assignment:'未映射或供电分区重叠，电网关联未明确'});
  const basisText = value => value == null ? '未记录' : bases[value] || (typeof value === 'object' ? JSON.stringify(value) : String(value));
  function strategies(artifact) { return list(artifact?.strategies).length ? artifact.strategies : [{id:'saved',name:'本轮保存情景',...artifact}]; }
  function preferred(artifact, id) { const rows = strategies(artifact); return rows.find(row => String(row.id) === String(id ?? artifact.recommended_strategy)) || rows[0]; }
  function frames(strategy) { return list(strategy?.frames).filter(frame => finite(frame.time_hours)); }
  function frameTime(frame) { return frame.time_hours ?? (['天','days'].includes(frame.time_unit) ? frame.time * 24 : frame.time); }
  function toNetworkMap(artifact, strategyId, options = {}) {
    if(artifact?.display_mode==='strategy_summary')return null;
    const impactOnly=options.view==='impact';
    const strategy = preferred(artifact, strategyId), impactFrames = frames(strategy), network = {...artifact.network,...strategy.network};
    // Only bind grid numbers to an exactly corresponding saved time. A population
    // frame must not silently inherit a different grid state during recovery.
    const gridFrames = impactOnly?[]:list(strategy.network_frames ?? strategy.grid_frames ?? network.frames);
    const savedFrames = impactFrames.map(frame => {
      if(impactOnly)return {time:frame.time_hours,time_unit:'小时',node:{function:{},damage:{}},pipe:{function:{},damage:{}}};
      const saved = gridFrames.find(row => finite(frameTime(row)) && Math.abs(frameTime(row) - frame.time_hours) < 1e-8) || (!gridFrames.length && frame.time_hours === 0 ? {node:{function:Object.fromEntries(list(network.nodes).filter(node => finite(node.function) && node.function >= 0 && node.function <= 1).map(node => [String(node.result_id || node.id),node.function])),damage:Object.fromEntries(list(network.nodes).filter(node => node.damage != null).map(node => [String(node.result_id || node.id),node.damage]))},pipe:{function:Object.fromEntries(list(network.links).filter(link => finite(link.function) && link.function >= 0 && link.function <= 1).map(link => [String(link.result_id || link.id),link.function])),damage:Object.fromEntries(list(network.links).filter(link => link.damage != null).map(link => [String(link.result_id || link.id),link.damage]))}} : null);
      return {...(saved || {}),time:frame.time_hours,time_unit:'小时',node:saved?.node || {function:{},damage:{}},pipe:saved?.pipe || {function:{},damage:{}}};
    });
    const geometryById = artifact.geometry_by_id || strategy.geometry_by_id || {};
    const coverageFeatures = list(strategy.coverage_features ?? artifact.coverage_features).map(feature => ({...feature,geometry:feature.geometry || geometryById[feature.geometry_ref || feature.id] || null,kind:feature.kind || 'zone',properties:{...feature.properties,coverage_gap:true,impact_model:true}}));
    // Regional response resources belong to this exact saved strategy and time.
    // Replace its proxy exposure zones with the census-derived impact polygons,
    // while retaining facilities, crews, vehicles, stocks, routes and generators.
    const resources = impactOnly?{}:strategy.resource_layers || {}, resourceFrames = list(resources.frames);
    const isResource = feature => !['zone','zone_node'].includes(feature?.kind);
    const features = impactFrames.map(frame => {
      const resourceFrame = resourceFrames.find(row => finite(row.time_hours) && Math.abs(row.time_hours - frame.time_hours) < 1e-8);
      const savedResources = list(resourceFrame?.features).filter(isResource).map(feature => ({...feature,geometry:feature.geometry || resources.geometry_by_id?.[feature.geometry_ref || feature.id] || null}));
      const unlocated = [...list(frame.unlocated),...list(resourceFrame?.unlocated ?? resources.unlocated).filter(isResource)];
      const combined = [...list(frame.features).map(feature => ({...feature,geometry:feature.geometry || geometryById[feature.geometry_ref || feature.id] || null,kind:feature.kind || 'zone',properties:{...feature.properties,impact_model:true}})),...coverageFeatures,...savedResources];
      return {...frame,features:combined,unlocated,summary:{...resourceFrame?.summary,...frame.summary,feature_count:combined.length,resource_feature_count:savedResources.length,unlocated_count:unlocated.length}};
    });
    const hasResources = features.some(frame => frame.features.some(isResource) || frame.unlocated.some(isResource));
    return {...network,system:'power_system',...(impactOnly?{map_view:'impact'}:{}),nodes:impactOnly?[]:list(network.nodes),links:impactOnly?[]:list(network.links),frames:savedFrames,
      source:network.source || {title:cityName(artifact),note:'区域面来自保存的分区与人口叠加结果；底图不参与影响计算。'},
      limitations:[...new Set([...list(network.limitations),...list(artifact.warnings)])],
      regional_layers:{frames:features,limitations:['面边界的来源与电网关联方法分别记录；公开统计边界不能自动代表真实用户供电边界。','人口为所用年份的人口资料与面积叠加估计；部分失供等效量不表示已识别具体断电住户。','未关联的分区或缺失人口保持未知，不计作零影响。',...list(resources.limitations),...list(artifact.assumptions)]},
      power_impact:{schema_version:artifact.schema_version,strategy_id:strategy.id,coverage:artifact.coverage || strategy.coverage || {},has_resources:hasResources,regional_strategy_id:strategy.source_skill_id==='power_system.regional_restoration'?strategy.source_strategy_id:null},
      playback:{can_play:impactFrames.length > 1,message:impactFrames.length > 1 ? '' : '本轮仅保存震后初始时刻，未生成恢复预测。'}};
  }
  function metric(label, value, unit, note, key) {
    return `<article${key ? ` data-impact-metric="${esc(key)}"` : ''}><span>${esc(label)}</span><strong>${esc(number(value))}<em>${esc(unit)}</em></strong><small>${esc(note)}</small></article>`;
  }
  function frameMetrics(frame) {
    const summary = frame?.summary || {};
    const lower = key => !finite(summary[key]) && finite(summary[key + '_known_lower_bound']) ? ` 已知资料下限 ${number(summary[key + '_known_lower_bound'])} 人；总量未知。` : '';
    return metric('全部失供区域人口',summary.full_outage_population,'人','所关联区域供电比例为 0；人口叠加估计，不是逐户停电记录。' + lower('full_outage_population'),'full_outage_population') +
      metric('部分失供等效人口',summary.partial_outage_population_equivalent,'人','仅部分失供区域：区域人口 × 缺供比例。' + lower('partial_outage_population_equivalent'),'partial_outage_population_equivalent') +
      metric('存在失供区域人口',summary.affected_population_any_outage,'人','任一缺供区域内的人口；包含部分失供，不能作为精确断电人数。' + lower('affected_population_any_outage'),'affected_population_any_outage') +
      metric('供电状态未知人口',summary.unknown_population,'人','已关联空间分区，但没有足够的保存供电状态。','unknown_population') +
      metric('未覆盖人口',summary.unmapped_population,'人','研究范围内未落入有效供电分区的人口，不计作正常供电。','unmapped_population') +
      metric('存在失供的分区面积',summary.outage_area_km2,'km²','有缺供的分区总面积；不是缺供比例乘面积。','outage_area_km2');
  }
  function coverageHTML(coverage = {}) {
    const complete = coverage.population_values_complete;
    return `<p class="power-impact-coverage${complete === false ? ' power-impact-warning' : ''}" data-population-complete="${complete === true ? 'true' : complete === false ? 'false' : 'unknown'}"><strong>${complete === true ? '所用人口资料完整' : complete === false ? '人口资料不完整：总人口结果保留未知' : '人口资料完整性未记录'}</strong><span>普查面空间覆盖率 ${esc(percent(coverage.census_geometry_coverage_ratio))} · 缺少普查面的面积 ${esc(number(coverage.census_uncovered_area_km2,3))} km² · 人口值未知面积 ${esc(number(coverage.population_unknown_area_km2,3))} km²</span><small>分区覆盖率仅针对已知人口；普查面缺失或人口值缺失不会计为零人口。</small></p>`;
  }
  function integralsHTML(strategy) {
    const m = strategy.metrics || {};
    if (!finite(m.observed_duration_hours) && !finite(m.observation_end_hours)) return '';
    return `<p class="reading-muted">观察时窗 ${esc(number(m.observation_start_hours))}—${esc(number(m.observation_end_hours))} 小时；仅在保存的观察时窗内累计。</p><div class="power-impact-metrics">${metric('全部失供人口累计暴露',m.full_outage_person_hours,'人·小时','全部失供区域估计人口随时间累计。')}${metric('部分失供等效累计暴露',m.partial_outage_person_hours_equivalent,'人·小时','部分失供等效人口随时间累计。')}${metric('未知供电人口累计暴露',m.unknown_person_hours,'人·小时','未观测供电状态的人口随时间累计，单独报告。')}</div>`;
  }
  function rows(frame) {
    return list(frame?.features).map(feature => {
      const p = feature.properties || {};
      return `<tr data-impact-zone="${esc(feature.id)}"><td><button type="button" class="reading-text-button" data-impact-pick="${esc(feature.id)}">${esc(feature.name || feature.id)} ↗</button></td><td>${esc(statuses[p.status] || p.status || '供电状态未知')}</td><td>${esc(percent(p.unserved_ratio))}</td><td>${esc(number(p.population))}</td><td>${esc(number(p.full_outage_population))}</td><td>${esc(number(p.partial_outage_population_equivalent))}</td><td>${esc(number(p.area_km2,3))}</td><td>${esc(basisText(p.geometry_basis))}<small>${esc(basisText(p.assignment_basis || p.supply_assignment_basis))}</small></td></tr>`;
    });
  }
  function table(frame, page = 0) {
    const data = rows(frame);
    return `<div class="power-impact-table-wrap"><table><caption>当前保存时刻的分区供电与人口明细</caption><thead><tr>${['分区','供电状态','缺供比例','分区人口','全部失供区域人口','部分失供等效人口','分区面积（km²）','边界 / 电网关联依据'].map(label => `<th scope="col">${label}</th>`).join('')}</tr></thead><tbody>${data.slice(page * 25,page * 25 + 25).join('') || '<tr><td colspan="8">没有保存区域面；请补齐有效边界、供电关联与人口资料。</td></tr>'}</tbody></table></div>${data.length > 25 ? `<label class="power-impact-page">明细页码 <select data-impact-page>${Array.from({length:Math.ceil(data.length/25)},(_,index) => `<option value="${index}"${index === page ? ' selected' : ''}>${index+1}</option>`).join('')}</select> · ${data.length} 个分区</label>` : ''}`;
  }
  function curve(strategy) {
    const data = frames(strategy), valid = data.filter(frame => finite(frame.summary?.affected_population_equivalent));
    if (data.length < 2 || !valid.length) return '<p class="reading-muted">本轮未保存人口影响恢复序列；地图仅显示已有时刻。</p>';
    const maxTime = Math.max(1,...data.map(frame => frame.time_hours)), maxPopulation = Math.max(1,...valid.map(frame => frame.summary.affected_population_equivalent));
    const x = time => 64 + time / maxTime * 640, y = population => 168 - population / maxPopulation * 128;
    let path = '', previous = null;
    for (const frame of data) { const population = frame.summary?.affected_population_equivalent; if (!finite(population)) {previous = null;continue;} path += previous ? `H${x(frame.time_hours)} V${y(population)} ` : `M${x(frame.time_hours)} ${y(population)} `;previous = frame; }
    return `<svg class="power-impact-chart" viewBox="0 0 760 210" role="img" aria-label="已保存时刻的等效受影响人口变化；缺数据的区间不连线"><path class="power-impact-chart-grid" d="M64 40H704 M64 104H704 M64 168H704"/><text x="4" y="44">${esc(number(maxPopulation,0))} 人</text><text x="28" y="172">0</text><text x="64" y="195">0 小时</text><text x="636" y="195">${esc(number(maxTime))} 小时</text><path class="power-impact-chart-line" d="${path}"/></svg><p class="reading-muted">等效受影响人口 = 全部失供区域人口 + 部分失供等效人口；未知和未覆盖人口另外列出。</p>`;
  }
  function sourceHTML(value) {
    if (Array.isArray(value)) return value.slice(0,12).map(sourceHTML).join('') + (value.length > 12 ? `<p class="reading-muted">共 ${value.length} 条来源或关联记录；本页显示前 12 条，完整记录保存在结果文件中。</p>` : '');
    if (!value || typeof value !== 'object') {const url = safeLink(value);return value ? `<p>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(value)} ↗</a>` : esc(value)}</p>` : '';}
    if (!value.url && !value.source_url && !value.title && !value.publisher && !value.name && !value.dataset && !value.source) return Object.entries(value).filter(([key]) => ['network','operator','population','boundary','assignment','service_areas','title','note'].includes(key)).map(([key,source]) => sourceHTML(source)).join('');
    const url = safeLink(value.url || value.source_url), title = value.title || value.publisher || value.name || value.dataset || value.source || '资料来源';
    return `<p>${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)} ↗</a>` : esc(title)}${value.year != null ? ' · ' + esc(value.year) : ''}${value.note ? ' · ' + esc(value.note) : ''}</p>`;
  }
  function provenanceHTML(artifact) {
    const provenance = artifact.provenance || {}, entries = Object.entries(provenance).filter(([key]) => !['area_projection_wkt','population_records','service_assignments','files'].includes(key));
    const titles = {network:'电网',operator:'供电分区发布方',population:'人口',boundary:'边界',service_areas:'供电分区',assignment:'电网关联',population_areas:'人口统计面',study_area:'研究范围',input_source:'输入资料来源',population_sources:'人口资料来源',service_sources:'供电分区来源',area_projection:'面积计算坐标系'};
    return `<details class="reading-detail power-impact-method"><summary>边界、人口与计算方法</summary>${entries.map(([key,value]) => `<section><h4>${esc(titles[key] || key)}</h4>${sourceHTML(value)}</section>`).join('')}<p>分区缺供比例来自关联负荷节点的保存供电值；人口通过供电分区与人口统计面的空间叠加分配，人口分布在统计面内均匀的假设另列。</p><p>全部失供区域人口、部分失供等效量、存在缺供区域总人口分别报告；不能把等效人口解释为精确断电住户。</p>${list(artifact.assumptions).map(note => `<p>${esc(note)}</p>`).join('')}${list(artifact.warnings).map(note => `<p class="power-impact-warning">${esc(note)}</p>`).join('')}<pre>${esc(JSON.stringify({schema_version:artifact.schema_version,coverage:artifact.coverage,metrics:artifact.metrics},null,2))}</pre></details>`;
  }
  function suspend(root) {
    const state=mounts.get(root);if(!state?.mapMounted)return;
    const map=root.querySelector('[data-power-impact-map]'),saved=window.EngineeringNetworkMap?.captureState?.(map);
    if(saved)state.mapStates.set(state.strategyId,saved);
    window.EngineeringNetworkMap?.destroy(map);state.mapMounted=false;
  }
  function destroy(root) {suspend(root);mounts.delete(root);}
  function pause(root) { root.querySelectorAll('[data-power-impact-map]').forEach(map => window.EngineeringNetworkMap?.pause(map)); }
  function profileArtifact(artifact,profile) {
    if(profile?.regional_restoration_enabled!==false||!list(artifact.strategies).length)return artifact;
    const choices=artifact.strategies.filter(row=>!String(row.id).startsWith('regional:')&&row.source_skill_id!=='power_system.regional_restoration');
    if(!choices.length)return null;
    const selected=choices.find(row=>row.id===artifact.recommended_strategy)||choices[0];
    return {...artifact,strategies:choices,recommended_strategy:selected.id,coverage:selected.coverage||artifact.coverage,metrics:selected.metrics||artifact.metrics};
  }
  function mount(root, artifact, options = {}) {
    if (!root || !artifact) return;
    const powerProfile=options.powerProfile || window.ResCityPowerProfile || artifact.power_profile;
    const original=artifact;artifact=profileArtifact(artifact,powerProfile);
    if(!artifact){destroy(root);root.innerHTML='<section class="power-impact-view"><h3>停电范围与人口</h3><p>此历史轮次仅保存区域协同策略；当前版本可查看包含基础电网策略的其他轮次。原始结果仍保留。</p></section>';return;}
    options={...options,powerProfile};
    const old=mounts.get(root);
    if(old?.original===original&&old.powerProfile?.profile===powerProfile?.profile&&options.sourceSignature&&old.options.sourceSignature===options.sourceSignature&&root.querySelector('[data-power-impact-map]')){old.options=options;old.resumeMap();return;}
    const signature = JSON.stringify([options.resultRevision || options.savedSceneIdentity || artifact,options.sourceSignature,powerProfile]);
    if (old?.signature === signature && root.querySelector('[data-power-impact-map]')) {old.options = options;old.resumeMap();return;}
    destroy(root);
    const choices = strategies(artifact), selected = preferred(artifact), state = {signature,options,artifact,original,powerProfile,strategyId:selected.id,index:0,page:0,mapStates:new Map(),mapMounted:false};mounts.set(root,state);
    root.innerHTML = `<section class="power-impact-view"><header class="reading-topic-heading"><h3>停电影响范围与人口</h3><p>${powerProfile?.regional_restoration_enabled===false?'本图聚焦供电分区、停电状态与受影响人口，播放分区随基础电网恢复发生的变化；电网设施见供电页，抢修安排见恢复方案。区域来源、供电关联和未知部分分别报告。':'本图聚焦供电分区、停电状态与受影响人口，播放分区随恢复发生的变化；电网设施见供电页，车辆、应急电源与运输路线见多主体协同页。区域来源、供电关联和未知部分分别报告。'}</p></header><div class="power-impact-evidence-strip"><strong>${esc(cityName(artifact))}</strong><span>二维 / 三维共用保存结果</span><span>人口资料与电网时刻分开记录</span></div>${calculationHTML(artifact)}<label class="power-impact-strategy">保存情景 / 恢复策略 <select data-impact-strategy aria-label="停电影响策略">${choices.map(choice => `<option value="${esc(choice.id)}"${choice.id === selected.id ? ' selected' : ''}>${esc(choice.name || choice.id)}</option>`).join('')}</select></label><div data-impact-coverage></div><p class="power-impact-frame" data-impact-frame role="status"></p><div class="power-impact-metrics" data-impact-metrics></div><div data-power-impact-map></div><section class="reading-chapter"><h4>人口影响恢复过程</h4><div data-impact-curve></div><div data-impact-integrals></div></section><section class="reading-chapter"><h4>分区与人口明细</h4><div data-impact-table></div></section>${provenanceHTML(artifact)}</section>`;
    const showFrame = frame => {
      if (mounts.get(root) !== state) return;
      const strategy = preferred(artifact,state.strategyId), data = frames(strategy);
      state.index = Math.max(0,data.indexOf(frame));if(state.frameTimeHours!==frame?.time_hours)state.page=0;state.frameTimeHours=frame?.time_hours;
      root.querySelector('[data-impact-frame]').textContent = `灾后 ${number(frame?.time_hours)} 小时 · 已知人口的分区覆盖率 ${percent(frame?.summary?.population_coverage_ratio ?? strategy.coverage?.population_coverage_ratio ?? artifact.coverage?.population_coverage_ratio)} · 已知人口的供电状态覆盖率 ${percent(frame?.summary?.observed_population_coverage_ratio)}`;
      root.querySelector('[data-impact-metrics]').innerHTML = frameMetrics(frame);
      const target = root.querySelector('[data-impact-table]');
      const paint = () => {target.innerHTML = table(frame,state.page);target.querySelector('[data-impact-page]')?.addEventListener('change',event => {state.page = Number(event.target.value);paint();});target.querySelectorAll('[data-impact-pick]').forEach(button => button.addEventListener('click',() => window.EngineeringNetworkMap?.select(root.querySelector('[data-power-impact-map]'),{id:button.dataset.impactPick,group:'regional',pan:true})));};paint();
    };
    state.resumeMap = () => {
      if(state.mapMounted)return;
      const strategy = preferred(artifact,state.strategyId),remote=artifact.display_mode==='strategy_summary',data=remote?null:toNetworkMap(artifact,state.strategyId,{view:'impact'});
      window.EngineeringNetworkMap?.mount(root.querySelector('[data-power-impact-map]'),{...state.options,view:'impact',data,...(remote?{strategy:'impact:'+state.strategyId}:{}),initialState:state.mapStates.get(state.strategyId),sourceSignature:signature + ':' + state.strategyId,onFrame:detail => showFrame(remote&&detail.frame?{...detail.frame,features:list(detail.frame.features).filter(feature=>feature.kind==='zone')}:frames(strategy)[Math.max(0,detail.index)]),onSelect:state.options.onSelect});
      state.mapMounted=true;
    };
    const showStrategy = () => {
      suspend(root);
      state.strategyId = root.querySelector('[data-impact-strategy]').value;state.index = 0;
      const strategy = preferred(artifact,state.strategyId), remote=artifact.display_mode==='strategy_summary';
      root.querySelector('[data-impact-coverage]').innerHTML = coverageHTML(strategy.coverage || artifact.coverage);
      root.querySelector('[data-impact-curve]').innerHTML = curve(strategy);root.querySelector('[data-impact-integrals]').innerHTML = integralsHTML(strategy);showFrame(frames(strategy)[0]);
      if(remote)root.querySelector('[data-impact-table]').innerHTML='<p class="reading-muted">正在读取所选保存策略的分区明细…</p>';
      state.resumeMap();
    };
    root.querySelector('[data-impact-strategy]').addEventListener('change',showStrategy);showStrategy();
  }
  return {mount,destroy,suspend,pause,toNetworkMap,frameMetrics,table,curve,basisText,coverageHTML,calculationHTML,readyDelivery,loadDelivery};
})();
