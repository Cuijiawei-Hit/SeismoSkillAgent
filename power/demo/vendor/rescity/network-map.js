/* Shared medical basemap/style, with engineering network geometry and saved states. */
window.EngineeringNetworkMap=(()=>{
  const mounts=new WeakMap(),cache=new Map();
  const resultRevision=options=>/^[a-f0-9]{64}$/.test(options?.resultRevision||'')?options.resultRevision:null;
  const TOPIC_MAP_VIEWS=new Set(['overview','grid','impact','recovery','coordination']);
  function mapView(c){return c.options?.view || c.data?.map_view || null;}
  function controlledMapView(c){return Boolean(c.data?.regional_layers)||(c.data?.system==='power_system'&&TOPIC_MAP_VIEWS.has(mapView(c)));}
  function trimMapCache(){
    for(const [key,entry] of cache){if(cache.size<=4)break;if(entry.settled&&!entry.users.size)cache.delete(key);}
  }
  function acquireMapRequest(key,url,c){
    let entry=cache.get(key);
    if(entry){cache.delete(key);cache.set(key,entry);}
    else{
      entry={controller:new AbortController(),users:new Set(),settled:false};
      entry.promise=fetch(url,{cache:c.options.reload?'reload':!c.options.datasetId&&resultRevision(c.options)?'force-cache':'no-store',credentials:'same-origin',signal:entry.controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'地图数据暂不可用');return data;}).then(data=>{entry.settled=true;trimMapCache();return data;},error=>{entry.settled=true;if(cache.get(key)===entry)cache.delete(key);throw error;});
      cache.set(key,entry);
    }
    entry.users.add(c);c.mapRequest=entry;trimMapCache();return entry;
  }
  function releaseMapRequest(c){
    const entry=c.mapRequest;if(!entry)return;entry.users.delete(c);c.mapRequest=null;
    if(!entry.settled&&!entry.users.size){if(cache.get(c.key)===entry)cache.delete(c.key);entry.controller.abort();}
    trimMapCache();
  }
  // Choose from the entire research extent, never a cropped or zoomed viewport.
  // Heavy terrain scenes use the shared service limits. The regional power
  // analysis view renders the same saved geometry on a lightweight ellipsoid.
  const THREE_D_LIMITS=Object.freeze({areaKm2:2500,edgeKm:80});
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const value=v=>v==null?'未记录':typeof v==='number'?v.toLocaleString('zh-CN',{maximumFractionDigits:4}):String(v);
  const safeLink=url=>{try{const u=new URL(url);return ['http:','https:'].includes(u.protocol)?u.href:'';}catch{return '';}};
  const current=c=>mounts.get(c.root)===c&&!c.disposed&&c.root.isConnected!==false;
  function hydrateRegionalGeometry(data,options={}){
    const regional=data?.regional_layers;if(!Array.isArray(regional?.frames))return data;
    const profile=options.powerProfile || window.ResCityPowerProfile || data.power_profile,core=data.system==='power_system'&&profile?.regional_restoration_enabled===false;
    const allowed=feature=>!core||['zone','zone_node'].includes(feature?.kind);
    const geometries=data.geometry_by_id||regional.geometry_by_id||{},coverage=(Array.isArray(regional.coverage_features)?regional.coverage_features:[]).filter(allowed),records=regional.feature_by_ref||{},shared=new Map();
    const hydrate=feature=>{if(shared.has(feature))return shared.get(feature);const value={...feature,geometry:feature.geometry||geometries[feature.geometry_ref||feature.id]||null};shared.set(feature,value);return value;};
    return {...data,...(core?{power_impact_has_resources:false,...(data.power_impact?{power_impact:{...data.power_impact,has_resources:false}}:{})}:{}),regional_layers:{...regional,...(core?{feature_by_ref:Object.fromEntries(Object.entries(records).filter(([,row])=>allowed(row))),coverage_features:coverage,unlocated:(regional.unlocated||[]).filter(allowed)}:{}),frames:regional.frames.map(frame=>{
      const result={...frame};let features;
      if(core)result.unlocated=(frame.unlocated||[]).filter(allowed);
      // Keep long histories compact until a frame is selected or played. Fixed
      // roads/features share the same immutable object across all viewed times.
      Object.defineProperty(result,'features',{enumerable:true,get(){if(features)return features;const rows=(Array.isArray(frame.features)?frame.features:Array.isArray(frame.feature_refs)?frame.feature_refs.map(ref=>{if(!Object.hasOwn(records,ref))throw new Error('地图保存帧引用缺失：'+ref);return records[ref];}):[]).filter(allowed),ids=new Set(rows.map(feature=>feature.id));features=[...rows,...coverage.filter(feature=>!ids.has(feature.id))].map(hydrate);if(core)result.summary={...Object.fromEntries(Object.entries(frame.summary||{}).filter(([key])=>!/^facilit|^resource_/.test(key))),feature_count:features.length,unlocated_count:result.unlocated.length,resource_feature_count:0};return features;}});
      return result;
    })}};
  }
  function visible(c){const canvas=c.root.querySelector('[data-canvas]');const size=canvas?.getBoundingClientRect();return current(c)&&!document.hidden&&!c.root.closest('[hidden]')&&size?.width>0&&size?.height>0;}
  function destroy(root){const c=mounts.get(root);if(c){stopClock(root);c.disposed=true;c.setupSerial++;mounts.delete(root);releaseMapRequest(c);c.observer?.disconnect();c.visibilityObserver?.disconnect();document.removeEventListener('visibilitychange',c.onVisibility);c.sceneController?.abort();c.layout?.destroy();c.fullscreen?.destroy();c.sandbox?.destroy();c.presentationOff?.();c.map?.remove();}}
  function isObservationNode(node){
    if(!node||typeof node!=='object')return false;
    const NodeType=node.ownerDocument?.defaultView?.Node||window.Node;
    return NodeType?node instanceof NodeType:Number.isInteger(node.nodeType)&&node.nodeType>0;
  }
  function observationParent(node){
    const NodeType=node.ownerDocument?.defaultView?.Node||window.Node;
    const getter=NodeType&&Object.getOwnPropertyDescriptor(NodeType.prototype,'parentElement')?.get;
    // Use the DOM getter rather than a form's named property, which may be a collection.
    return getter?getter.call(node):node.parentElement;
  }
  function observeNode(observer,node,options){
    if(!isObservationNode(node))return false;
    try{observer.observe(node,options);return true;}catch(error){
      // A node removed/replaced during rendering must not abort the usable map.
      if(error?.name==='TypeError'||error?.name==='InvalidStateError')return false;
      throw error;
    }
  }
  function refreshObservationTargets(c){
    if(!c.visibilityObserver)return;
    const targets=[],seen=new Set();
    for(let node=c.root;isObservationNode(node)&&!seen.has(node);node=observationParent(node)){seen.add(node);targets.push(node);}
    if(c.visibilityTargets?.length===targets.length&&targets.every((node,index)=>node===c.visibilityTargets[index]))return;
    c.visibilityObserver.disconnect();c.visibilityTargets=targets;
    for(const node of targets)observeNode(c.visibilityObserver,node,{attributes:true,attributeFilter:['hidden','class','style'],childList:true});
  }
  function observeVisibility(c){
    const root=c.root;c.canvas=root.querySelector('[data-canvas]');
    if(!current(c)||!isObservationNode(c.canvas)){if(mounts.get(root)===c)destroy(root);return false;}
    c.onVisibility=()=>{
      if(mounts.get(root)!==c||c.disposed)return;
      if(root.isConnected===false||c.canvas?.isConnected===false||root.querySelector('[data-canvas]')!==c.canvas){destroy(root);return;}
      refreshObservationTargets(c);
      if(!visible(c))pause(root);else resize(c);
    };
    document.addEventListener('visibilitychange',c.onVisibility);
    if(window.ResizeObserver){c.observer=new window.ResizeObserver(c.onVisibility);observeNode(c.observer,c.canvas);}
    if(window.MutationObserver){c.visibilityObserver=new window.MutationObserver(c.onVisibility);refreshObservationTargets(c);}
    return true;
  }
  function stopClock(root){const c=mounts.get(root);if(c){clearInterval(c.timer);c.timer=null;c.playing=false;if(c.playRAF!=null)window.cancelAnimationFrame?.(c.playRAF);c.playRAF=null;const b=root.querySelector('[data-play]');if(b){b.textContent='播放恢复过程';b.setAttribute('aria-pressed','false');}setRegionalPlaybackClasses(c);if(c.data?.regional_layers)syncSandbox(c);}}
  function pause(root){stopClock(root);mounts.get(root)?.sandbox?.pause();}
  function mount(root,options){
    options={...options,powerProfile:options.powerProfile || window.ResCityPowerProfile};
    let url=options.datasetId?`/api/engineering/datasets/${encodeURIComponent(options.datasetId)}/network-map`:`/api/engineering/native/sessions/${encodeURIComponent(options.sessionId)}/network-map?iteration=${options.iteration||1}${options.strategy?`&strategy=${encodeURIComponent(options.strategy)}`:""}${TOPIC_MAP_VIEWS.has(options.view)?`&view=${encodeURIComponent(options.view)}`:''}`;
    const revision=!options.datasetId&&resultRevision(options);if(revision)url+='&revision='+encodeURIComponent(revision);
    const key=url+':'+(options.sourceSignature||'')+':'+(options.powerProfile?.profile||'full');
    const old=mounts.get(root);if(old?.key===key){old.options=options;resize(old);return;}
    destroy(root);const c={root,key,options,index:-1,metric:'function',layers:[],timer:null,setupSerial:0};mounts.set(root,c);
    root.innerHTML='<div class="medical-map-state">正在加载本轮网络地图…</div>';
    if(options.data){c.data=hydrateRegionalGeometry(options.data,options);render(c);return;}
    const request=acquireMapRequest(key,url,c);
    request.promise.then(data=>{if(!current(c))return;if(options.sessionId&&(data.session_id!==options.sessionId||data.iteration!==Number(options.iteration||1)))throw new Error('地图结果与当前任务轮次不一致');if(options.datasetId&&data.dataset_id!==options.datasetId)throw new Error('地图与当前数据集不一致');if(options.view&&data.map_view&&options.view!==data.map_view)throw new Error('地图内容与当前分项不一致');if(revision&&data.display_revision!==revision)throw new Error('地图结果版本已变化，请重新打开本轮结果。');c.data=hydrateRegionalGeometry(data,options);render(c);}).catch(e=>{if(cache.get(key)===request)cache.delete(key);if(!current(c))return;root.innerHTML=`<div class="medical-map-state">${esc(e.message)}<button data-retry>重新加载地图</button></div>`;root.querySelector('[data-retry]')?.addEventListener('click',()=>{destroy(root);mount(root,{...options,reload:true});});}).finally(()=>{request.users.delete(c);if(c.mapRequest===request)c.mapRequest=null;trimMapCache();});
  }
  function captureState(root){
    const c=mounts.get(root);if(!c?.data)return null;
    const center=c.map?.getCenter?.();
    return {identity:c.key,index:c.index,metric:c.metric,mapPreset:c.mapPreset,regionalVisibility:{...c.regionalVisibility},
      showNodes:c.showNodes,showLinks:c.showLinks,showLabels:c.showLabels,showConnections:c.showConnections,showJunctions:c.showJunctions,voltage:c.voltage,
      showRegional3D:Boolean(c.showRegional3D),playSpeed:c.playSpeed,playWindow:c.playWindow,playTime:c.playTime,basemapMode:c.basemapMode,
      regionalSelectedId:c.regionalSelectedId,selection:c.selected?{id:c.selected.item.id,group:c.selected.group}:null,
      leafletView:center&&Number.isFinite(center.lat)&&Number.isFinite(center.lng)?{center:[center.lat,center.lng],zoom:c.map.getZoom()}:null,
      sceneView:c.sandbox?.captureView?.()||null,legendCollapsed:c.root.querySelector('[data-map-display-collapse]')?.getAttribute('aria-expanded')==='false'};
  }
  function restoreMapState(c){
    const state=c.options.initialState;if(!state||state.identity!==c.key)return;
    for(const key of ['metric','showNodes','showLinks','showLabels','showConnections','showJunctions','voltage','regionalSelectedId','playSpeed','playWindow'])if(state[key]!==undefined)c[key]=state[key];
    c.regionalVisibility={...state.regionalVisibility};
    c.index=Math.max(-1,Math.min(c.data.frames.length-1,Number.isInteger(state.index)?state.index:-1));
    if(c.data.regional_layers){const bounds=regionalPlaybackBounds(c),slider=c.root.querySelector('[data-time-slider]');if(slider)slider.max=String(Math.max(0,c.data.regional_layers.frames.findLastIndex(frame=>frame.time_hours<=bounds.last+1e-9)));if(Number.isFinite(state.playTime))advanceRegionalPlayback(c,Math.max(bounds.first,Math.min(bounds.last,state.playTime)));}
    if(['grid','emergency','combined'].includes(state.mapPreset)&&c.data.regional_layers)applyMapPreset(c,state.mapPreset);
    const field=(selector,value)=>{const node=c.root.querySelector(selector);if(node&&value!=null)node.value=String(value);};
    field('[data-metric]',c.metric);field('[data-play-speed]',c.playSpeed);field('[data-play-window]',c.playWindow);
    if(state.basemapMode&&c.basemapConfigs?.[state.basemapMode]){c.basemapMode=state.basemapMode;field('[data-engineering-basemap]',state.basemapMode);setEngineeringBasemap(c);}
    if(state.leafletView?.center?.length===2&&state.leafletView.center.every(Number.isFinite)&&Number.isFinite(state.leafletView.zoom)){c.restoredLeafletView={center:[...state.leafletView.center],zoom:state.leafletView.zoom};restoreLeafletView(c);}
    filterLayers(c,false);update(c);syncMapLayerControls(c);
    if(state.selection)select(c.root,state.selection);
    if(state.legendCollapsed){const button=c.root.querySelector('[data-map-display-collapse]');if(button?.getAttribute('aria-expanded')==='true')button.click();}
    c.restoredSceneView=state.sceneView||null;
    if(controlledMapView(c)&&state.showRegional3D)setRegionalView(c,'3d');
  }
  function restoreLeafletView(c){const view=c.restoredLeafletView;if(!view||!c.map?.setView)return;c.map.setView(view.center,view.zoom,{animate:false});c.restoredLeafletView=null;}
  function values(c,item,group){const frame=c.data.frames[c.index];const id=String(item.result_id||item.id),g=item.result_group||group;return frame?{function:frame[g]?.function?.[id]??null,damage:frame[g]?.damage?.[id]??null}:{function:item.function,damage:item.damage};}
  function metricAvailability(data){
    const meaningful=(metric,value)=>typeof value==='number'&&Number.isFinite(value)||metric==='damage'&&typeof value==='string'&&value.trim()&&!['unknown','未知','未记录'].includes(value);
    const staticHas=metric=>[...(data.nodes || []),...(data.links || [])].some(item=>meaningful(metric,item[metric]));
    const frameHas=metric=>(data.frames || []).some(frame=>['node','pipe'].some(group=>Object.values(frame[group]?.[metric] || {}).some(value=>meaningful(metric,value))));
    return {function:staticHas('function')||frameHas('function'),damage:staticHas('damage')||frameHas('damage'),staticResults:staticHas('function')||staticHas('damage')};
  }
  const LOSS_METRICS={day_expected:'白天伤亡期望（人）',night_expected:'夜晚伤亡期望（人）',mean_expected:'昼夜平均伤亡期望（人）',repair_cost_yuan:'经济损失（元）'};
  function lossMetric(c){return c.data.system==='building_complex'&&Object.hasOwn(LOSS_METRICS,c.metric);}
  function lossColor(metric,n){
    if(typeof n!=='number'||!Number.isFinite(n))return '#64748b';
    const cuts=metric==='repair_cost_yuan'?[100000,1000000]:[1,10];
    return n===0?'#087f5b':n<cuts[0]?'#b77900':n<cuts[1]?'#e45b10':'#b61134';
  }
  function lossLegend(c){
    const range=c.metric==='repair_cost_yuan'?'绿：0元；深黄：0～10万元（不含）；橙：10～100万元（不含）；红：≥100万元。':'绿：0人；深黄：0～1人（不含）；橙：1～10人（不含）；红：≥10人。';
    return LOSS_METRICS[c.metric]+' · 震后初始估计，不随修复减少。'+range+(c.metric==='repair_cost_yuan'?' 灰：未关联费用结果。':' 灰：未提供本范围人口或未关联结果。')+'点击建筑查看明细。';
  }
  function lossDetails(item){
    const r=item.loss_metrics;if(!r)return '';
    const display=n=>typeof n==='number'&&n!==0&&Math.abs(n)<.0001?n.toExponential(3):value(n);
    return '<section class="medical-map-method"><h4>震后初始伤亡与经济损失</h4><dl>'+Object.entries(LOSS_METRICS).map(([k,label])=>'<dt>'+esc(label)+'</dt><dd>'+esc(display(r[k]))+'</dd>').join('')+'</dl><p>伤亡为模型期望，保留小数；未提供人口时人数留空。经济损失仅含建筑直接损失，以修复成本估算。</p></section>';
  }
  function color(c,item,group){if(lossMetric(c))return lossColor(c.metric,item.loss_metrics?.[c.metric]);const v=values(c,item,group);if(c.metric==='geometry'){if(c.data.system==='power_system'&&item.voltage_kv)return ({220:'#ba6837',110:'#7c61a2',33:'#187f7b',22:'#397ca6'})[item.voltage_kv]||'#315f79';return group==='node'?'#315f79':'#187f7b';}if(c.data.regional_layers){if(c.metric==='damage')return ({'基本完好':'#126348','轻微破坏':'#326348','轻度破坏':'#326348','中等破坏':'#744329','中度破坏':'#744329','严重破坏':'#b91c32','完全破坏':'#b91c32','毁坏':'#b91c32'})[v.damage]||'#52616d';return typeof v.function==='number'?v.function>=.9?'#126348':v.function>=.6?'#326348':v.function>=.3?'#744329':'#b91c32':'#52616d';}if(c.metric==='damage')return ({'基本完好':'#187f7b','轻微破坏':'#72aa75','中等破坏':'#d2a648','中度破坏':'#d2a648','轻度破坏':'#72aa75','严重破坏':'#d37937','完全破坏':'#a74732','毁坏':'#a74732'})[v.damage]||'#9aa7ae';return typeof v.function==='number'?v.function>=.9?'#187f7b':v.function>=.6?'#87aa68':v.function>=.3?'#deab52':'#b9573d':'#9aa7ae';}
  function routeBasis(item){return ({documented_station_equivalent:'站内等值变压连接 · 非实测设备位置',documented_topology:'官方文献接线 · 端点虚线示意',traced_public_corridor:'沿公开GIS走廊提取 · 站内接入另画细虚线'})[item.geometry_basis]||(item.coordinates?'已录入折点几何':'端点直线 · 拓扑示意');}
  const overlayId=(item,group)=>`${group}:${String(item.id)}`;
  function sceneSource(c){
    const d=c.data,options=c.options;let source=null;
    if(options.sessionId||d.session_id)source={session_id:options.sessionId||d.session_id,iteration:Number(options.iteration||d.iteration||1)};
    else if(options.datasetVersionId||d.dataset_version_id)source={dataset_version_id:options.datasetVersionId||d.dataset_version_id};
    else{const revision=Number(d.revision||options.revision);if((options.datasetId||d.dataset_id)&&Number.isInteger(revision)&&revision>0)source={dataset_id:options.datasetId||d.dataset_id,draft_revision:revision};}
    if(!source&&d.system==='power_system'&&d.power_impact&&d.regional_layers)source={analysis_only:true};
    return source;
  }
  function networkBounds(c){
    const bounds=[Infinity,Infinity,-Infinity,-Infinity];
    const include=point=>{if(!Array.isArray(point)||!Number.isFinite(point[0])||!Number.isFinite(point[1]))return;bounds[0]=Math.min(bounds[0],point[0]);bounds[1]=Math.min(bounds[1],point[1]);bounds[2]=Math.max(bounds[2],point[0]);bounds[3]=Math.max(bounds[3],point[1]);};
    for(const node of c.data.nodes){include([node.longitude,node.latitude]);for(const point of node.footprint||[])include(point);}
    for(const link of c.data.links){for(const point of link.coordinates||[])include(point);for(const line of link.display_connections||[])if(Array.isArray(line))for(const point of line)include(point);}
    for(const frame of c.data.regional_layers?.frames || [])for(const feature of frame.features || []){const geometry=feature.geometry;if(geometry?.type==='Point')include(geometry.coordinates);else if(geometry?.type==='LineString')geometry.coordinates.forEach(include);else if(geometry?.type==='Polygon')geometry.coordinates.forEach(ring=>ring.forEach(include));else if(geometry?.type==='MultiPolygon')geometry.coordinates.forEach(polygon=>polygon.forEach(ring=>ring.forEach(include)));}
    const supplied=c.data.research_bbox;
    if(Array.isArray(supplied)&&supplied.length===4&&supplied.every(Number.isFinite)&&supplied[0]<supplied[2]&&supplied[1]<supplied[3]){include(supplied.slice(0,2));include(supplied.slice(2));}
    return bounds;
  }
  function scenePolicy(c){
    const bounds=networkBounds(c),valid=bounds.every(Number.isFinite),widthKm=valid?(bounds[2]-bounds[0])*111.32*Math.cos((bounds[1]+bounds[3])*Math.PI/360):Infinity,heightKm=valid?(bounds[3]-bounds[1])*111.32:Infinity;
    const areaKm2=widthKm*heightKm,edgeKm=Math.max(widthKm,heightKm);
    const supplied=c.data.scene_display_limits||{},limit=(value,fallback)=>Number.isFinite(value)&&value>0?Math.min(value,fallback):fallback;
    const limits={areaKm2:limit(supplied.max_region_area_km2,THREE_D_LIMITS.areaKm2),edgeKm:limit(supplied.max_region_edge_km,THREE_D_LIMITS.edgeKm)};
    const terrain3d=valid&&areaKm2<=limits.areaKm2+1e-8&&edgeKm<=limits.edgeKm+1e-8,regionalAnalysis=valid&&c.data.system==='power_system'&&controlledMapView(c);
    return {bounds,widthKm,heightKm,areaKm2,edgeKm,limits,terrain3d,regionalAnalysis,use3d:terrain3d||regionalAnalysis};
  }
  function sceneViewState(c,state){
    if(!current(c))return;const note=c.root.querySelector('[data-scene-view-note]');if(!note)return;
    const policy=c.scenePolicy,extentLabel=dimension=>dimension.toLocaleString('zh-CN',{maximumFractionDigits:1});
    const extent=`研究范围约 ${extentLabel(policy.widthKm)} × ${extentLabel(policy.heightKm)} 公里`;
    note.dataset.sceneMode=state;
    if(controlledMapView(c)&&!c.showRegional3D){note.textContent='二维与三维共用本分项保存的对象、状态和图例；切换保留灾后时刻、图层与选择。三维分析视图使用示意地表，不表示实测地形或建筑。';return;}
    if(policy.regionalAnalysis){note.textContent=state==='ready'?`完整范围三维分析视图 · ${extent}；图标与文字始终朝向屏幕，地表为示意，未建模地形与建筑。`:state==='failed'?'三维分析绘制暂未成功；保留当前时刻与图层，继续显示二维地图，可点击“重新加载三维”，无需重新评估。':state==='preparing'?'正在加载 3D 地图，请稍候；加载期间可先查看二维地图，完成后自动切换。完整范围三维分析视图使用同一批保存对象与状态，无需准备建筑地形。':`${extent}，当前坐标不足以绘制三维分析视图。`;return;}
    if(c.progressiveScene&&state==='ready'){
      const background=c.sceneBackground||{},detail=background.state==='ready'
        ?background.map_scope==='full'?'本范围建筑背景已加载':'当前局部建筑背景已加载，移动地图后继续加载附近建筑'
        :background.state==='failed'?'建筑背景暂未加载成功，评估对象与恢复状态仍可查看，可重试建筑背景'
        :'建筑背景正按视野分批加载，当前未加载区域不表示没有建筑';
      note.textContent=`完整评估对象三维视图 · ${extent}；${detail}。`+(c.data.system==='building_complex'?'彩色实体为已录入的评估建筑，灰白建筑为公开地图背景；高度来源见对象详情。':'');return;
    }
    if(c.progressiveScene&&state==='preparing'){note.textContent='正在加载 3D 地图，请稍候。先准备完整评估对象的三维视图，再按视野加载真实建筑背景；当前临时二维地图保留，准备完成后自动切换。';return;}
    note.textContent=state==='ready'?`完整范围三维沙盘 · ${extent}`+(c.data.system==='building_complex'?'；彩色实体为评估建筑，屋顶与侧面共用当前状态；灰白建筑仅作背景。高度优先采用录入值，缺失时按层数或示意高度显示，来源见对象详情。':''):state==='failed'?'本区域支持三维展示，三维背景暂未加载成功；当前显示二维地图，可点击“重新加载三维”，无需重新评估。':state==='preparing'?'正在加载 3D 地图，请稍候。正在准备完整范围的三维沙盘；加载期间先显示临时二维地图，完成后自动切换。':`${extent}，超过三维可展示范围，使用完整二维总览。${c.canPlay?'可播放地图上的恢复过程。':''}`;
  }
  function resetSandbox(c){
    if(current(c)&&c.sandbox?.retryBackground&&c.sceneBackground?.state==='failed'){
      const instance=c.sandbox;setSceneBackgroundState(c,{state:'loading'});sceneStatus(c,'正在重试建筑背景，当前评估对象、时刻与地图视角保持。');
      Promise.resolve().then(()=>instance.retryBackground()).catch(error=>{if(current(c)&&c.sandbox===instance)sceneBackgroundFailed(c,error);});return;
    }
    if(!current(c)||!c.scenePolicy?.use3d)return;c.setupSerial++;c.sceneController?.abort();c.sandbox?.destroy();c.sandbox=null;c.sandboxPending=false;c.sandboxAttempted=false;
    c.sceneBackground=null;
    if(controlledMapView(c)){c.showRegional3D=true;const picker=c.root.querySelector('[data-regional-view]');if(picker)picker.value='3d';}
    c.root.querySelector('[data-canvas]').classList.remove('has-geographic-sandbox');c.root.querySelector('[data-sandbox-canvas]').innerHTML='';
    const retry=c.root.querySelector('[data-scene-retry]');retry.hidden=true;retry.disabled=true;
    c.map?.invalidateSize({animate:false,pan:true});ensureSandbox(c);
  }
  const POWER_ROLES={source:'供电接入点',substation:'变电站节点',distribution:'配电接入点',tower:'杆塔',junction:'线路连接点',node:'电网节点',transformer:'变压连接'};
  function powerRole(item){
    const kind=String(item.asset_kind||item.properties?.asset_kind||'').toLowerCase();
    const roles={source:'source',supply:'source',generator:'source',substation:'substation',station_bus:'substation',distribution:'distribution',load:'distribution',tower:'tower',pole:'tower',junction:'junction',circuit_terminal:'junction',transformer:'transformer'};
    // Workbook sheet names are model categories, not evidence of physical facility type.
    if(roles[kind])return roles[kind];const name=String(item.name||'');
    if(/供电接入点|外部电源|发电站/.test(name))return 'source';
    if(/变电站|\bsubstation\b/i.test(name))return 'substation';
    if(/配电接入点/.test(name))return 'distribution';
    if(/中压连接点|线路连接点/.test(name))return 'junction';
    return 'node';
  }
  function powerSymbol(role,fill,selected=false){
    const size=({source:24,substation:24,distribution:12,tower:22,junction:7,node:10,transformer:22})[role]||10;
    const glyph=role==='source'?'<path d="M12 5 7.5 12h4l-1 7 6-9h-4z" fill="white"/>':role==='substation'?'<path d="M6 16V9l6-3 6 3v7M5 17h14M9 11v4m3-4v4m3-4v4" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>':role==='tower'?'<path d="m12 5-5 14m5-14 5 14M9 8h6M7 11h10M5 14h14m-10-3 6 5m-6 0 6-5M6 19h3m6 0h3" fill="none" stroke="white" stroke-width="1.5" stroke-linecap="round"/>':role==='transformer'?'<circle cx="9" cy="12" r="4" fill="none" stroke="white" stroke-width="1.5"/><circle cx="15" cy="12" r="4" fill="none" stroke="white" stroke-width="1.5"/>':'';
    const halo=selected?'<circle cx="12" cy="12" r="11.2" fill="white" stroke="#173441" stroke-width="1.2"/>':'';
    const body=['source','substation','tower','transformer'].includes(role)?`<rect x="3" y="3" width="18" height="18" rx="${role==='source'?9:4}" fill="${fill}" stroke="white" stroke-width="1.5"/><rect x="2.6" y="2.6" width="18.8" height="18.8" rx="${role==='source'?9.4:4.4}" fill="none" stroke="#233f46" stroke-opacity=".7" stroke-width=".7"/>${glyph}`:role==='distribution'?`<path d="m12 2 10 10-10 10L2 12z" fill="${fill}" stroke="white" stroke-width="2"/>`:`<circle cx="12" cy="12" r="${role==='junction'?7:8}" fill="${fill}" stroke="white" stroke-width="3"/>`;
    return {image:`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" data-power-role="${role}">${halo}${body}</svg>`,width:size,height:size};
  }
  function powerDisplaySymbol(c,item,group){
    const role=group==='pipe'?'transformer':powerRole(item),fill=color(c,item,group),selected=c.selected?.item===item,zoom=c.map?.getZoom?.()??(c.data.regional_layers?12:16);
    if(!c.map?.getZoom&&!c.data.regional_layers)return powerSymbol(role,fill,selected);
    if(zoom>=16){const symbol=powerSymbol(role,fill,selected);const size=selected?24:['junction','node','distribution'].includes(role)?symbol.width:18;return {...symbol,image:symbol.image.replace(/width="\d+" height="\d+"/,`width="${size}" height="${size}"`),width:size,height:size};}
    const size=selected?20:role==='junction'?(zoom<14?7:8):['node','distribution'].includes(role)?(zoom<14?9:10):(zoom<14?12:14),shape=role==='distribution'?`<path d="m12 3 9 9-9 9-9-9z" fill="${fill}" stroke="white" stroke-width="2"/>`:['source','substation','transformer'].includes(role)?`<rect x="4" y="4" width="16" height="16" rx="2" fill="${fill}" stroke="white" stroke-width="2"/>`:`<circle cx="12" cy="12" r="8" fill="${fill}" stroke="white" stroke-width="2"/>`;
    return {image:`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" data-power-role="${role}">${selected?'<circle cx="12" cy="12" r="11" fill="white" stroke="#182d45" stroke-width="2"/>':''}${shape}</svg>`,width:size,height:size};
  }
  function powerIcon(c,item,group){const symbol=powerDisplaySymbol(c,item,group),target=c.data.regional_layers||c.map?.getZoom?Math.max(16,symbol.width):symbol.width;return L.divIcon({className:'power-map-symbol'+(c.selected?.item===item?' power-map-focused':''),html:target===symbol.width?symbol.image:`<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center">${symbol.image}</span>`,iconSize:[target,target],iconAnchor:[target/2,target/2]});}
  function itemVisible(c,item,group){return c.mapPreset!=='emergency'&&(!c.voltage||Number(item.voltage_kv)===Number(c.voltage))&&(group!=='node'||c.showNodes!==false)&&(group!=='pipe'||c.showLinks!==false)&&!(group==='node'&&!c.showJunctions&&(c.data.system==='power_system'?powerRole(item)==='junction':item.asset_kind==='junction'));}
  function lineWidth(c,item){return c.data.system==='power_system'?(c.data.regional_layers?(item.voltage_kv>=220?2.8:item.voltage_kv>=110?2.3:1.8):(item.voltage_kv>=220?5:item.voltage_kv>=110?4.5:3.5)):4;}
  function lineDash(c,item){return item.coordinates?null:c.data.system==='power_system'?[12,4]:[7,3];}
  function circleImage(fill,radius,weight,opacity){const size=(radius+weight)*2;return {image:`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle cx="${size/2}" cy="${size/2}" r="${radius}" fill="${fill}" fill-opacity="${opacity}" stroke="${fill}" stroke-width="${weight}"/></svg>`,width:size,height:size};}
  const REGIONAL_KINDS={zone:'受影响服务区',zone_node:'服务区关联节点',facility:'关键设施',generator:'应急电源',crew:'抢修队伍',warehouse:'物资仓库',vehicle:'配送车辆',route:'运输与抢修路线',task:'维修任务'};
  const REGIONAL_STATUS={available:'可用',arrived:'已到场',in_transit:'在途',awaiting_pickup:'待取货',received:'已验收',energized:'已送电',repairing:'维修中',testing:'检验中',waiting_materials:'等待物资',waiting_work_shift:'等待工作时段',authorized:'已确认',pending:'待调度',isolating:'隔离中',crew_in_transit:'队伍在途',fuel_exhausted:'燃料耗尽',incompatible:'接入不兼容',grid:'电网供电',backup:'备用电源',generator:'移动电源',unserved:'供电不足',served:'最低需求已保障',connected:'已接入',completed:'已完成',closed:'封闭'};
  const REGIONAL_FIELDS={status:'当前状态',geometry_basis:'空间依据',source:'资料来源',node_id:'关联电网节点',node_ids:'关联电网节点',zone_id:'服务区',facility_id:'保障设施',asset_key:'维修对象',team:'队伍',warehouse_id:'仓库',vehicle_id:'车辆',generator_id:'应急电源',population:'区域人口',affected_population:'等效受影响人口',outage_population_equivalent:'等效受影响人口',unserved_ratio:'失供比例',service_ratio:'最低负荷满足比例',service_available:'最低负荷已保障',grid_supply_mw:'电网供电（MW）',backup_supply_mw:'备用供电（MW）',generator_supply_mw:'移动电源供电（MW）',served_mw:'合计供电（MW）',critical_min_mw:'最低需求（MW）',backup_remaining_mwh:'备用剩余电量（MWh）',generator_fuel_liters:'应急电源燃料（升）',remaining_fuel_liters:'剩余燃料（升）',fuel_liters:'燃料（升）',power_mw:'额定功率（MW）',stock:'实际库存',reserved:'预留库存',available:'可用库存',materials:'物资',location_id:'地点',reason:'说明',time_hours:'灾后时间（小时）',departure_hours:'出发（小时）',arrival_hours:'到场（小时）',return_hours:'返回（小时）',fraction:'行程进度',progress:'任务进度',priority:'保障优先级'};
  const REGIONAL_BASIS={recorded_coordinates:'录入坐标',explicit_coordinates:'录入坐标',recorded_polygon:'录入服务区边界',explicit_polygon:'录入服务区边界',bound_grid_node:'关联电网节点位置',linked_node_proxy:'关联节点代理，未录入服务区边界',grid_node_reference:'关联电网节点位置',dispatch_endpoint_schematic:'派遣端点连线示意，未经道路核验',interpolated_dispatch_position:'按录入行程插值，非实时车辆定位'};
  Object.assign(REGIONAL_STATUS,{unknown:'暂无保存状态',supply_deficit:'存在失供',grid_supplied:'电网供电正常',service_available:'最低用电已保障',service_interrupted:'未满足最低用电',stock_available:'有库存',stock_depleted:'库存耗尽',awaiting_dispatch:'待派遣',material_shortage:'物资不足',supplying:'正在供电',standby:'待用',travelling_to_pickup:'前往取货',delivering:'配送在途',returning:'返回途中',not_yet_available:'尚未开放',open:'可通行',connected_supply_unresolved:'已接入，供电量尚未明确'});
  Object.assign(REGIONAL_FIELDS,{facilities_available:'满足最低用电的设施数',resource_feature_count:'应急与抢修资源对象数',supply_ratio:'电网供电比例',supply_mw:'实际供电（MW）',node_supply_ratio:'关联节点供电比例',supply_basis:'供电计算依据',population_basis:'人口影响口径',inventory_basis:'库存计算依据',state_basis:'状态依据',facility_total_fuel_liters:'该设施电源燃料合计（升）',from_location_id:'起点',to_location_id:'终点',assignment_id:'配送任务',resource_kind:'资源类别',route_kind:'线路类别',travel_hours:'录入通行时间（小时）',capacity_units:'车辆容量（录入数量单位）'});
  Object.assign(REGIONAL_BASIS,{explicit_wgs84:'明确录入的 WGS84 坐标',bound_grid_node_proxy:'引用电网节点代理位置，非设施实测',user_provided_service_area:'明确录入的服务区边界',published_asset_line:'发布版本的线路几何',asset_node_target:'维修对象的电网节点位置'});
  Object.assign(REGIONAL_STATUS,{ready_to_energize:'等待送电'});
  Object.assign(REGIONAL_FIELDS,{bound_node_ids:'位置引用的节点',facility_total_supply_mw:'该设施移动电源合计供电（MW）'});
  Object.assign(REGIONAL_FIELDS,{assignment_basis:'电网关联依据',supply_assignment_basis:'电网关联依据',impact_model:'停电影响模型输出',full_outage_population:'全部失供区域人口（估计）',partial_outage_population_equivalent:'部分失供等效人口',affected_population_equivalent:'等效受影响人口',affected_population_any_outage:'存在失供区域人口',unknown_population:'供电状态未知人口',unmapped_population:'未覆盖人口',area_km2:'区域面积（km²）',outage_area_km2:'存在失供的分区面积（km²）',full_outage_area_km2:'全部失供分区面积（km²）',population_coverage_ratio:'人口分区覆盖比例',observed_population_coverage_ratio:'供电状态已知人口覆盖比例',ambiguous_overlap_population:'供电分区重叠未确定人口'});
  Object.assign(REGIONAL_BASIS,{official_service_area:'官方供电分区',official_supply_area:'官方供电分区',official_zone_substation_area:'官方变电站供电分区',published_service_area:'公开供电分区',census_polygon:'官方普查统计面',official_census_boundary:'官方普查统计面',inferred_service_area:'推断供电分区',voronoi_inferred:'按供电节点推断的分区',nearest_node_assignment:'最近节点关联推断',explicit_node_assignment:'明确录入的电网关联',official_node_assignment:'官方供电关联'});
  Object.assign(REGIONAL_STATUS,{full_outage:'全部失供',partial_outage:'部分失供'});
  Object.assign(REGIONAL_FIELDS,{population_values_complete:'人口资料完整',population_known_lower_bound:'已知人口下限',population_unknown_area_km2:'人口值未知面积（km²）',unknown_node_ids:'供电状态缺失节点',effective_geometry_basis:'有效边界处理',uncertainty:'关联不确定性',population_uncertainty:'人口不确定性'});
  Object.assign(REGIONAL_BASIS,{inferred_clipped_voronoi_nearest_node:'按最近节点推断、裁剪至研究范围的分区',inferred_nearest_node_not_verified_electrical_service:'最近节点关联推断，未经电气供电关系核验',study_clipped_exclusive_service_area:'研究范围内扣除重叠不确定部分的供电分区'});
  Object.assign(REGIONAL_BASIS,{operator_disclosed_service_area:'运营商正式披露的供电分区',exact_Vector_operator_station_code_to_existing_equivalent_network_load_node:'Vector 站点代码精确匹配至现有等值电网负荷节点',explicit_study_area_minus_exclusive_service_coverage:'研究范围扣除明确供电分区后的区域',unmapped_or_overlapping_service_assignment:'未映射或供电分区重叠，电网关联未明确'});
  function regionalFrame(c){const frames=c.data.regional_layers?.frames || [];return frames[Math.max(0,c.index)] || frames[0] || null;}
  function regionalFeatures(c){return c.mapPreset==='grid'?[]:(regionalFrame(c)?.features || []).filter(feature=>c.regionalVisibility?.[feature.kind]!==false);}
  const regionalGeometryValidity=new WeakMap();
  function validRegionalGeometry(geometry){
    const point=p=>Array.isArray(p)&&p.length>=2&&Number.isFinite(p[0])&&Number.isFinite(p[1])&&Math.abs(p[0])<=180&&Math.abs(p[1])<=90;
    if(geometry?.type==='Point')return point(geometry.coordinates);
    if(geometry?.type==='LineString')return Array.isArray(geometry.coordinates)&&geometry.coordinates.length>=2&&geometry.coordinates.every(point);
    if(['Polygon','MultiPolygon'].includes(geometry?.type)){
      // Saved geometry is immutable; state/frame changes reuse the same city boundaries.
      if(regionalGeometryValidity.has(geometry))return regionalGeometryValidity.get(geometry);
      const polygon=coordinates=>Array.isArray(coordinates)&&coordinates.length>0&&coordinates.every(ring=>Array.isArray(ring)&&ring.length>=4&&ring.every(point)),valid=geometry.type==='Polygon'?polygon(geometry.coordinates):Array.isArray(geometry.coordinates)&&geometry.coordinates.length>0&&geometry.coordinates.every(polygon);
      regionalGeometryValidity.set(geometry,valid);return valid;
    }
    return false;
  }
  // Object shape explains its role; colour and plain text explain the saved state.
  // Do not advertise a supply mode in the legend unless an enabled located object has it.
  const REGIONAL_PALETTE={outage:'#b91c32',partial:'#145fc4',grid:'#126348',backup:'#145fc4',generator:'#6735b5',resource:'#145fc4',warehouse:'#744329',task:'#744329',protected_unknown:'#243b6b',unknown:'#52616d'};
  function regionalPresentation(feature){
    const p=feature.properties || {},kind=feature.kind,type=p.coverage_gap?'未映射/关联未明确':p.impact_model?'供电分区':kind==='zone_node'?'服务区节点':REGIONAL_KINDS[kind] || kind,finite=v=>typeof v==='number'&&Number.isFinite(v);
    const state=(key,status,color)=>({key:kind+':'+key,status,color:color || REGIONAL_PALETTE[key] || REGIONAL_PALETTE.unknown,type});
    if(p.coverage_gap)return state('coverage_unknown','电网关联未明确',REGIONAL_PALETTE.unknown);
    if(p.status==='unknown')return state('unknown','暂无保存状态');
    if(kind==='zone'||kind==='zone_node'){
      if(p.impact_model){if(p.status==='full_outage')return state('outage','全部失供');if(p.status==='partial_outage')return state('partial','部分失供');if(p.status==='grid_supplied')return state('grid','无失供');if(p.status==='unknown')return state('unknown','供电状态未知');}
      const affected=finite(p.affected_population)?p.affected_population:p.outage_population_equivalent,fraction=finite(p.unserved_ratio)?p.unserved_ratio:finite(p.outage_ratio)?p.outage_ratio:finite(p.population)&&p.population>0&&finite(affected)?affected/p.population:null;
      if(fraction===null)return state('unknown','失供状态未明确');
      return fraction>.5?state('outage','严重失供'):fraction>0?state('partial','部分失供'):state('grid','无失供');
    }
    if(kind==='facility'){
      if(typeof p.service_available!=='boolean'&&!finite(p.service_ratio))return state('unknown','最低需求状态未明确');
      if(p.service_available===false || (p.service_available!==true&&finite(p.service_ratio)&&p.service_ratio<.999))return state('outage','最低需求未满足');
      if(finite(p.generator_supply_mw)&&p.generator_supply_mw>0)return state('generator','移动电源保障');
      if(finite(p.backup_supply_mw)&&p.backup_supply_mw>0)return state('backup','备用电源保障');
      if(finite(p.grid_supply_mw)&&p.grid_supply_mw>0||p.status==='grid')return state('grid','电网保障');
      return state('protected_unknown','最低需求已保障 · 电源未明确');
    }
    const failed=['closed','stock_depleted','material_shortage','fuel_exhausted'].includes(p.status),color=failed?REGIONAL_PALETTE.outage:REGIONAL_PALETTE[kind] || REGIONAL_PALETTE.resource;
    return state(p.status || 'unknown',REGIONAL_STATUS[p.status] || p.status || '暂无保存状态',color);
  }
  function regionalColor(feature){return regionalPresentation(feature).color;}
  function hasRegionalResources(c){return Boolean(c.data.power_impact?.has_resources || c.data.power_impact_has_resources || c.data.regional_layers?.frames?.some(frame=>(frame.features || []).some(feature=>!['zone','zone_node'].includes(feature.kind))));}
  function regionalName(feature){const name=feature.name || feature.id;return ({'demo-hospital':'演示医院','demo-pump':'演示泵站'})[name] || String(name).replace(/^demo-service-area-(\d+)( · 节点.*)?$/,'演示服务区 $1$2');}
  function regionalDisplayText(feature){
    const state=regionalPresentation(feature),p=feature.properties || {},finite=v=>typeof v==='number'&&Number.isFinite(v);let detail=state.status;
    if((feature.kind==='zone'||feature.kind==='zone_node')&&finite(p.unserved_ratio))detail+=' '+Math.round(p.unserved_ratio*100)+'%';
    const basis=feature.kind==='zone_node'?'关联节点 · 未录入服务区边界':p.impact_model?`边界：${regionalValue('geometry_basis',p.geometry_basis)} · 供电关联：${regionalValue('assignment_basis',p.assignment_basis || p.supply_assignment_basis)}`:['bound_grid_node_proxy','linked_node_proxy','bound_grid_node','grid_node_reference'].includes(p.geometry_basis)?'节点代理位置 · 非设施实测':'';
    return {title:`${state.type} · ${regionalName(feature)}`,detail,basis};
  }
  function regionalLabel(feature){
    const text=regionalDisplayText(feature),state=regionalPresentation(feature);
    return `<strong class="regional-map-object-title">${esc(text.title)}</strong><span class="regional-map-object-status" style="color:${state.color}">${esc(text.detail)}</span>${text.basis?`<small class="regional-map-object-basis">${esc(text.basis)}</small>`:''}`;
  }
  const REGIONAL_GLYPHS={
    zone_node:'<circle cx="15" cy="15" r="8" stroke-dasharray="3 2"/><circle cx="15" cy="15" r="2" fill="white" stroke="none"/>',
    facility:'<path d="M7 23V8h16v15M5 23h20M11 8V5h8v3M11 12h2m4 0h2m-8 4h2m4 0h2m-6 7v-4h4v4"/>',
    generator:'<path d="M6 10h18v12H6zM9 10V7h6v3m3 0V7h3m-7 6-3 4h4l-1 3 5-5h-4l1-2"/>',
    crew:'<path d="M5 16v-2a10 10 0 0 1 20 0v2M4 16h22M15 4v9M7 22h16m-13-6v3h10v-3"/>',
    warehouse:'<path d="M4 13 15 6l11 7M6 12v12h18V12M10 24V14h10v10m-10-6h10m-10 3h10"/>',
    vehicle:'<path d="M4 8h13v13H4zM17 13h6l3 5v3h-9M21 13v5h5"/><circle cx="9" cy="22" r="2" fill="white"/><circle cx="22" cy="22" r="2" fill="white"/>',
    task:'<path d="m9 7 4 4-3 3-4-4a6 6 0 0 0 8 7l7 7 3-3-7-7a6 6 0 0 0-8-7z"/>',
    route:'<path d="M5 23V8h9v14h11M21 18l4 4-4 4"/>'
  };
  const REGIONAL_ZOOM_SIZING=Object.freeze({min:12,max:26,referenceZoom:7,base:12,pixelsPerZoom:1.4,selectedBoost:3});
  function regionalMarkerSize(c,selected=false){
    const policy=REGIONAL_ZOOM_SIZING,zoom=c.map?.getZoom?.()??13;
    return Math.round((Math.max(policy.min,Math.min(policy.max,policy.base+((Number.isFinite(zoom)?zoom:13)-policy.referenceZoom)*policy.pixelsPerZoom))+(selected?policy.selectedBoost:0))*100)/100;
  }
  function regionalSymbol(feature,selected=false,size=26){
    const fill=regionalColor(feature),glyph=REGIONAL_GLYPHS[feature.kind] || REGIONAL_GLYPHS.zone_node;
    return {image:`<svg xmlns="http://www.w3.org/2000/svg" data-kind="${esc(feature.kind)}" width="${size}" height="${size}" viewBox="0 0 30 30"><rect x="1" y="1" width="28" height="28" rx="6" fill="white" stroke="#162936" stroke-width="${selected?2:1}"/><rect x="3.5" y="3.5" width="23" height="23" rx="4" fill="${fill}"/><g fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${glyph}</g></svg>`,width:size,height:size};
  }
  function regionalLegendItems(c){
    const groups=new Map();for(const feature of regionalFeatures(c)){if(!validRegionalGeometry(feature.geometry))continue;const state=regionalPresentation(feature);if(!groups.has(state.key))groups.set(state.key,{...state,count:0,features:[]});const item=groups.get(state.key);item.count++;item.features.push(feature);}
    return [...groups.values()];
  }
  function updateRegionalLegend(c){
    const legend=c.root.querySelector('[data-regional-legend]');if(!legend)return;const items=regionalLegendItems(c),frame=regionalFrame(c),missing=frame?.unlocated || c.data.regional_layers?.unlocated || [];
    const unlocated=new Map();for(const item of missing)unlocated.set(item.kind,(unlocated.get(item.kind)||0)+1);
    legend.innerHTML=items.map(item=>`<button type="button" class="regional-map-legend-item" data-regional-legend-key="${esc(item.key)}" aria-label="定位${esc(item.type)}：${esc(item.status)}（${item.count} 个）" title="点击定位；再次点击切换同类对象"><i aria-hidden="true">${regionalSymbol(item.features[0],false,22).image}</i><span>${esc(item.type)} · ${esc(item.status)}</span><strong>${item.count}</strong></button>`).join('')+`<span class="regional-map-legend-note">${c.mapPreset==='grid'?(c.data.power_impact&&!hasRegionalResources(c)?'电网视图：供电分区图层已隐藏。':'电网视图：区域与应急图层已隐藏。'):!items.length?(c.data.power_impact&&!hasRegionalResources(c)?'当前时刻没有已定位且开启的供电分区。':'当前时刻没有已定位且开启的区域或应急对象。'):''}${unlocated.size?`未定位：${[...unlocated].map(([kind,count])=>`${esc(REGIONAL_KINDS[kind] || kind)} ${count}`).join('、')}（见图层与说明）`:''}</span>`;
    legend.querySelectorAll('[data-regional-legend-key]').forEach(button=>button.addEventListener('click',()=>{const item=regionalLegendItems(c).find(item=>item.key===button.dataset.regionalLegendKey);if(!item?.features.length)return;c.regionalLegendCursor ||= new Map();const index=c.regionalLegendCursor.get(item.key) || 0;c.regionalLegendCursor.set(item.key,(index+1)%item.features.length);chooseRegionalObject(c,item.features[index%item.features.length].id);}));
  }
  function regionalMarkerLayout(c,size=regionalMarkerSize(c)){
    const groups=new Map(),layout=new Map();
    for(const feature of regionalFeatures(c)){if(feature.geometry?.type!=='Point'||!validRegionalGeometry(feature.geometry))continue;const point=c.playPositions?.get(feature.id) || feature.geometry.coordinates,key=point.join(',');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(feature);}
    for(const group of groups.values()){
      const ordered=[...group].sort((a,b)=>String(a.id).localeCompare(String(b.id))),radius=group.length>1?Math.min(size*1.8,Math.max(size*.75,group.length*size/6)):0;
      ordered.forEach((feature,index)=>{const angle=-Math.PI/2+index*2*Math.PI/ordered.length;layout.set(feature.id,radius?[radius*Math.cos(angle),radius*Math.sin(angle)]:[0,0]);});
    }
    return layout;
  }
  function chooseRegionalObject(c,id){
    const feature=(regionalFrame(c)?.features || []).find(feature=>String(feature.id)===String(id));if(!feature)return false;
    if(c.mapPreset==='grid')applyMapPreset(c,'combined');c.regionalVisibility ||= {};c.regionalVisibility[feature.kind]=true;syncMapLayerControls(c);
    updateRegional(c);regionalSelection(c,feature);const control=c.root.querySelector('[data-regional-object]');if(control)control.value=String(feature.id);syncSandbox(c);
    if(validRegionalGeometry(feature.geometry)){if(feature.geometry.type==='Point'){const xy=c.playPositions?.get(feature.id) || feature.geometry.coordinates;c.map?.panTo?.([xy[1],xy[0]]);}else{const points=[];const visit=coordinates=>{if(typeof coordinates[0]==='number'){points.push(coordinates);return;}coordinates.forEach(visit);};visit(feature.geometry.coordinates);c.map?.fitBounds?.([[Math.min(...points.map(p=>p[1])),Math.min(...points.map(p=>p[0]))],[Math.max(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0]))]],{maxZoom:17,padding:[35,35]});}if(c.showRegional3D)c.sandbox?.focus?.('regional:'+feature.id);}
    return true;
  }
  function regionalValue(key,v){if(['geometry_basis','assignment_basis','supply_assignment_basis'].includes(key))return v==null?'未知':REGIONAL_BASIS[v] || v;if(['population_coverage_ratio','observed_population_coverage_ratio'].includes(key))return typeof v==='number'&&Number.isFinite(v)?value(v*100)+'%':'未知';if(key==='status')return REGIONAL_STATUS[v] || v;if(typeof v==='boolean')return v?'是':'否';const bases={explicit_population_equivalent_exposure:'明确人口与等效失供比例',saved_single_node_supply:'保存的单节点供电状态',missing_supply_or_node_load_weights:'缺少供电状态或节点负荷权重',saved_facility_trace:'保存的设施供电轨迹',initial_stock_minus_observed_pickups:'初始库存扣除已发生取货',observed_task_events_and_stage_times:'已发生任务事件与工序时刻',demonstration_assumptions:'演示假设',user_provided:'用户明确录入',crew:'抢修队伍',generator:'应急电源',vehicle:'配送车辆',travel_edge:'录入道路关系'};if(typeof v==='string'&&bases[v])return bases[v];return v && typeof v==='object'?JSON.stringify(v):value(v);}
  function regionalSelection(c,feature){
    const changed=c.regionalSelectedId!==feature.id;c.regionalSelectedId=feature.id;c.selected=null;
    const picker=c.root.querySelector('[data-regional-object]');if(picker)picker.value=String(feature.id);
    c.root.querySelector('[data-selection]').innerHTML=`<h3>${esc(REGIONAL_KINDS[feature.kind] || feature.kind)} · ${esc(feature.name || feature.id)}</h3><dl><dt>编号</dt><dd>${esc(feature.id)}</dd>${Object.entries(feature.properties || {}).filter(([key])=>key!=='impact_model').map(([key,v])=>`<dt>${esc(REGIONAL_FIELDS[key] || key)}</dt><dd>${esc(regionalValue(key,v))}</dd>`).join('')}</dl><p>${feature.properties?.impact_model?'状态来自本轮保存电网结果与空间叠加；边界来源、电网关联及人口估算分别核查，不能当作逐户停电观测。':'状态来自本轮保存的策略与灾后时刻；缺边界的关联节点符号不代表真实停电边界。'}</p>`;
    c.sandbox?.select('regional:'+feature.id);
    styleRegionalSelection(c);
    if(changed){syncSandbox(c);c.layout?.openDetails();}
  }
  function regionalIcon(c,feature,layout){const selected=c.regionalSelectedId===feature.id,symbol=regionalSymbol(feature,selected,regionalMarkerSize(c,selected)),offset=layout.get(feature.id) || [0,0];return L.divIcon({className:'regional-map-symbol'+(selected?' regional-map-focused':''),html:symbol.image,iconSize:[symbol.width,symbol.height],iconAnchor:[symbol.width/2-offset[0],symbol.height/2-offset[1]],tooltipAnchor:offset});}
  function regionalLabelPolicy(c,feature,fewObjects=regionalFeatures(c).filter(feature=>feature.geometry?.type==='Point'&&validRegionalGeometry(feature.geometry)).length<=16,zoom=c.map?.getZoom?.()??13){
    const state=regionalPresentation(feature),selected=c.regionalSelectedId===feature.id;
    return {permanent:feature.geometry.type==='Point'&&(selected||c.showLabels===true),direction:({facility:'left',generator:'right',zone_node:'bottom',crew:'left',task:'right',vehicle:'right',warehouse:'top'})[feature.kind] || 'top',priority:selected?100:feature.kind==='facility'&&state.key==='facility:outage'?90:({facility:80,generator:75,vehicle:65,crew:60,warehouse:55,task:45,zone_node:30,zone:30,route:20})[feature.kind] || 20};
  }
  function bindRegionalTooltip(c,row,fewObjects,zoom,layout){
    const feature=row.feature,{permanent,direction}=regionalLabelPolicy(c,feature,fewObjects,zoom),distance=regionalMarkerSize(c,c.regionalSelectedId===feature.id)/2+5,offset=direction==='left'?[-distance,0]:direction==='right'?[distance,0]:[0,direction==='top'?-distance:distance],label=regionalLabel(feature),options={permanent,direction,offset,className:'regional-map-object-label',opacity:1,interactive:false},key=JSON.stringify([label,options,layout.get(feature.id)]);
    if(row.tooltipKey===key)return;
    // Rebinding a Leaflet tooltip without disposal can retain its old map layer.
    // A stable label key avoids rebuilding it during selection or layout-only work.
    row.layer.unbindTooltip?.();row.layer.bindTooltip(label,options);row.tooltipKey=key;
  }
  function styleRegionalSelection(c){
    const layout=regionalMarkerLayout(c),fewObjects=regionalFeatures(c).filter(feature=>feature.geometry?.type==='Point'&&validRegionalGeometry(feature.geometry)).length<=16,zoom=c.map?.getZoom?.()??13;
    for(const row of c.regionalLayers || []){
      if(row.layer.setIcon){const icon=regionalIcon(c,row.feature,layout),key=JSON.stringify(icon.options || icon);if(row.iconKey!==key){row.layer.setIcon(icon);row.iconKey=key;}}
      else row.layer.setStyle?.({weight:c.regionalSelectedId===row.feature.id?5:row.feature.geometry.type==='LineString'?3:2});
      if(c.regionalSelectedId===row.feature.id){row.layer.setZIndexOffset?.(1000);row.layer.bringToFront?.();}else row.layer.setZIndexOffset?.(600);
      bindRegionalTooltip(c,row,fewObjects,zoom,layout);
    }
  }
  function regionalSceneRecord(c,feature,layout){
    const state=regionalPresentation(feature),text=regionalDisplayText(feature),p=feature.properties || {},selected=c.regionalSelectedId===feature.id;
    let focusBounds;
    if(['Polygon','MultiPolygon'].includes(feature.geometry?.type)){
      c.regionalGeometryBounds ||= new WeakMap();focusBounds=c.regionalGeometryBounds.get(feature.geometry);
      if(!focusBounds){focusBounds=[Infinity,Infinity,-Infinity,-Infinity];const rings=feature.geometry.type==='Polygon'?feature.geometry.coordinates:feature.geometry.coordinates.flat();for(const ring of rings)for(const [lon,lat] of ring){focusBounds[0]=Math.min(focusBounds[0],lon);focusBounds[1]=Math.min(focusBounds[1],lat);focusBounds[2]=Math.max(focusBounds[2],lon);focusBounds[3]=Math.max(focusBounds[3],lat);}c.regionalGeometryBounds.set(feature.geometry,focusBounds);}
    }
    return {analysisRole:'regional',regionalKind:feature.kind,objectType:state.type,objectName:regionalName(feature),statusText:state.status,statusKey:state.key,color:state.color,basisText:text.basis,labelTitle:text.title,labelDetail:text.detail,label:text.title+' · '+text.detail,labelPolicy:regionalLabelPolicy(c,feature),screenOffset:layout.get(feature.id) || [0,0],markerSize:26,zoomSizing:{...REGIONAL_ZOOM_SIZING},selected,geometryBasis:p.geometry_basis || null,timeHours:regionalFrame(c)?.time_hours??null,replayTimeHours:c.playTime??regionalFrame(c)?.time_hours??null,moving:Boolean(c.playing&&!reducedRegionalMotion()&&MOVING_STATUS.has(p.status)),positionInterpolated:Boolean(c.playPositions?.has(feature.id)),...(focusBounds?{focusBounds:[...focusBounds]}:{})};
  }
  function regionalOverlays(c){const points=[],links=[],layout=regionalMarkerLayout(c,26);
    for(const feature of regionalFeatures(c)){if(!validRegionalGeometry(feature.geometry))continue;const id='regional:'+feature.id,geometry=feature.geometry,meta=regionalSceneRecord(c,feature,layout),fill=meta.color;c.overlayRecords.set(id,{feature,group:'regional'});
      if(geometry.type==='LineString')links.push({id,coordinates:geometry.coordinates,...meta,width:4,opacity:.95,dash:[8,4],casingColor:'#ffffff',casingWidth:1.5});
      else if(geometry.type==='Polygon'||geometry.type==='MultiPolygon'){const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;polygons.forEach((rings,index)=>{const partId=index?id+':part:'+index:id,first=rings[0][0];c.overlayRecords.set(partId,{feature,group:'regional'});points.push({id:partId,lon:first[0],lat:first[1],footprint:rings,...meta,fillColor:fill,fillOpacity:.28,width:2,polygonOnly:true,labelPolicy:{...meta.labelPolicy,permanent:index===0&&meta.selected}});});}
      else{const p=c.playPositions?.get(feature.id) || geometry.coordinates;points.push({id,lon:p[0],lat:p[1],longitude:p[0],latitude:p[1],...meta,...regionalSymbol(feature,meta.selected,26)});}
    }
    return {points,links};
  }
  function updateRegional(c){
    if(!c.data.regional_layers)return;
    const previous=new Map((c.regionalLayers || []).map(row=>[row.feature.id,row]));c.regionalLayers=[];
    const frame=regionalFrame(c),features=regionalFeatures(c),layout=regionalMarkerLayout(c);
    if(c.map)for(const feature of features){if(!validRegionalGeometry(feature.geometry))continue;const geometry=feature.geometry,point=c.playPositions?.get(feature.id) || geometry.coordinates,fill=regionalColor(feature),xy=geometry.type==='Point'?[point[1],point[0]]:geometry.type==='MultiPolygon'?geometry.coordinates.map(polygon=>polygon.map(ring=>ring.map(p=>[p[1],p[0]]))):geometry.type==='Polygon'?geometry.coordinates.map(ring=>ring.map(p=>[p[1],p[0]])):geometry.coordinates.map(p=>[p[1],p[0]]);
      const label=`${regionalPresentation(feature).type} · ${regionalName(feature)}`;
      let row=previous.get(feature.id);const reusable=row&&row.feature.geometry.type===geometry.type&&(geometry.type==='Point'?row.layer.setLatLng&&row.layer.setIcon:row.layer.setLatLngs&&row.layer.setStyle);
      if(reusable){previous.delete(feature.id);row.feature=feature;if(geometry.type==='Point')row.layer.setLatLng(xy);else{row.layer.setLatLngs(xy);row.layer.setStyle({color:fill,fillColor:fill});}}
      else{const layer=geometry.type==='Polygon'||geometry.type==='MultiPolygon'?L.polygon(xy,{color:fill,weight:2,fillColor:fill,fillOpacity:.25}):geometry.type==='LineString'?L.polyline(xy,{color:fill,weight:3,opacity:.95,dashArray:'9 7',className:'regional-map-route'}):L.marker(xy,{title:label,alt:label,zIndexOffset:600,icon:regionalIcon(c,feature,layout)});row={layer,feature};layer.on('click',()=>regionalSelection(c,row.feature));layer.addTo(c.map);}
      c.regionalLayers.push(row);
    }
    for(const row of previous.values())c.map?.removeLayer(row.layer);styleRegionalSelection(c);
    const selected=(frame?.features || []).find(feature=>feature.id===c.regionalSelectedId);if(selected)regionalSelection(c,selected);else if(c.regionalSelectedId){c.regionalSelectedId=null;c.root.querySelector('[data-selection]').innerHTML='<h3>该对象在本时刻没有保存空间状态</h3><p>请从当前区域对象列表重新选择。</p>';}
    const combined=Boolean(c.data.power_impact&&hasRegionalResources(c));
    const object=c.root.querySelector('[data-regional-object]');if(object){object.innerHTML=`<option value="">${c.data.power_impact&&!combined?'请选择供电分区':'请选择区域或应急对象'}</option>`+(frame?.features || []).map(feature=>`<option value="${esc(feature.id)}">${esc(c.data.power_impact?regionalPresentation(feature).type:REGIONAL_KINDS[feature.kind] || feature.kind)} · ${esc(feature.name || feature.id)}</option>`).join('');object.value=c.regionalSelectedId || '';}
    const summary=c.root.querySelector('[data-regional-summary]');if(summary){const s=frame?.summary || {},keys=['full_outage_population','partial_outage_population_equivalent','unknown_population','unmapped_population','outage_area_km2',...(combined?['facilities_available','resource_feature_count']:[])];summary.innerHTML=`<strong>灾后 ${esc(value(frame?.time_hours ?? 0))} 小时 · ${esc(value(s.feature_count ?? (frame?.features || []).length))} 个${c.data.power_impact&&!combined?'供电分区':'区域与资源对象'}</strong><span>${Object.entries(s).filter(([key])=>c.data.power_impact?keys.includes(key):!['feature_count','unlocated_count'].includes(key)).map(([key,v])=>`${esc(REGIONAL_FIELDS[key] || key)}：${esc(regionalValue(key,v))}`).join(' · ')}</span>`;}
    const invalid=(frame?.features || []).filter(feature=>!validRegionalGeometry(feature.geometry)).map(feature=>({id:feature.id,name:feature.name,kind:feature.kind,reason:'坐标或几何无效，未绘制'}));
    const unlocated=[...(frame?.unlocated || c.data.regional_layers.unlocated || []),...invalid];
    const missing=c.root.querySelector('[data-regional-unlocated]');if(missing)missing.innerHTML=`<summary>未定位对象（${unlocated.length}）</summary>${unlocated.length?`<ul>${unlocated.map(item=>`<li><strong>${esc(REGIONAL_KINDS[item.kind] || item.kind)} · ${esc(item.name || item.id)}</strong>：${esc(item.reason || '未录入位置关联')}</li>`).join('')}</ul>`:'<p>本时刻对象均有明确的位置表达。节点代理与运输插值仍是示意，见空间依据。</p>'}`;
    updateRegionalLegend(c);
    syncMapLayerControls(c);
    setRegionalPlaybackClasses(c);
  }
  function syncMapLayerControls(c){
    const regionalEnabled=c.mapPreset!=='grid',networkEnabled=c.mapPreset!=='emergency';
    c.root.querySelectorAll('[data-regional-layer]').forEach(input=>{input.checked=regionalEnabled&&c.regionalVisibility?.[input.dataset.regionalLayer]!==false;});
    c.root.querySelectorAll('[data-network-layer]').forEach(input=>{input.checked=networkEnabled&&(input.dataset.networkLayer==='nodes'?c.showNodes!==false:c.showLinks!==false);});
    c.root.querySelectorAll('[data-map-labels]').forEach(input=>{input.checked=c.showLabels===true;});
    const legend=c.root.querySelector('[data-map-display-legend]');if(!legend)return;
    const counts=new Map(),samples=new Map();for(const feature of regionalFrame(c)?.features || []){if(!validRegionalGeometry(feature.geometry))continue;counts.set(feature.kind,(counts.get(feature.kind)||0)+1);if(!samples.has(feature.kind))samples.set(feature.kind,feature);}
    counts.set('nodes',c.data.nodes.length);counts.set('links',c.data.links.length);
    legend.querySelectorAll('[data-map-layer-count]').forEach(node=>{node.textContent=String(counts.get(node.dataset.mapLayerCount)||0);});
    legend.querySelectorAll('[data-map-layer-symbol]').forEach(node=>{if(node.dataset.mapLayerSymbol==='zone')return;const feature=samples.get(node.dataset.mapLayerSymbol);if(!feature)return;const key=regionalPresentation(feature).key;if(node.dataset.stateKey!==key){node.innerHTML=regionalSymbol(feature,false,22).image;node.dataset.stateKey=key;}});
  }
  function setMapLayerVisibility(c,kind,checked){
    const network=['nodes','links'].includes(kind);
    if(checked&&(network&&c.mapPreset==='emergency'||!network&&kind!=='labels'&&c.mapPreset==='grid')){
      c.mapPreset='combined';c.root.querySelectorAll('[data-map-preset]').forEach(button=>{const active=button.dataset.mapPreset==='combined';button.setAttribute('aria-pressed',String(active));button.classList.toggle('is-active',active);});
    }
    if(kind==='nodes')c.showNodes=checked;
    else if(kind==='links')c.showLinks=checked;
    else if(kind==='labels')c.showLabels=checked;
    else{c.regionalVisibility ||= {};c.regionalVisibility[kind]=checked;}
    filterLayers(c,false);styleLayers(c);updateRegional(c);syncMapLayerControls(c);syncSandbox(c);
  }
  function installMapDisplayLegend(c,kinds){
    const names={zone:'停电范围 / 供电分区',zone_node:'服务区关联节点',facility:'关键设施',warehouse:'物资仓库',task:'抢修任务',crew:'抢修队伍',vehicle:'物资运送车辆',generator:'移动应急电源',route:'调度运输路线'};
    const samples=new Map();for(const feature of regionalFrame(c)?.features || [])if(!samples.has(feature.kind))samples.set(feature.kind,feature);
    const icon=kind=>['zone'].includes(kind)?'<svg width="22" height="22" viewBox="0 0 28 28" aria-hidden="true"><path d="M4 7 13 3l11 6-3 13-13 3-5-9z" fill="#b91c3238" stroke="#b91c32" stroke-width="2"/></svg>':regionalSymbol(samples.get(kind)||{kind,properties:{}},false,22).image;
    const row=(kind,name,symbol,attribute)=>`<label class="network-map-display-item"><input type="checkbox" ${attribute} aria-label="显示${esc(name)}"><i data-map-layer-symbol="${esc(kind)}" aria-hidden="true">${symbol}</i><span>${esc(name)}</span><b data-map-layer-count="${esc(kind)}">0</b></label>`;
    const panel=document.createElement('section');panel.className='network-map-display-legend';panel.setAttribute('data-map-display-legend','');panel.setAttribute('aria-label','地图图例与显示开关');
    const roles=new Map();for(const item of c.data.nodes){const role=powerRole(item);roles.set(role,(roles.get(role)||0)+1);}if(c.data.links.some(item=>item.asset_kind==='transformer'))roles.set('transformer',true);
    const resourceKinds=kinds.filter(kind=>!['zone','zone_node'].includes(kind)),hasResources=resourceKinds.length>0;
    const networkRows=(c.data.nodes.length?row('nodes','电网节点',powerSymbol('substation','#165480').image,'data-network-layer="nodes"'):'')+(c.data.links.length?row('links','输电线路','<span class="network-map-line-key"></span>','data-network-layer="links"'):'');
    const stateKey=kinds.includes('zone')||hasResources?`<div class="network-map-state-key" aria-label="供电状态颜色说明"><span><i style="background:#b91c32"></i>${hasResources?'失供 / 需求未满足':'全部失供'}</span><span><i style="background:#145fc4"></i>${hasResources?'部分失供 / 备用供电':'部分失供'}</span><span><i style="background:#126348"></i>电网供电</span>${hasResources?'<span><i style="background:#6735b5"></i>移动电源供电</span>':''}<span><i style="background:#52616d"></i>状态未知</span></div>`:'';
    panel.innerHTML=`<div class="network-map-display-heading"><div><strong>图例与显示</strong><small>勾选显示，取消隐藏</small></div><button type="button" data-map-display-collapse aria-expanded="true" aria-label="收起地图图例">收起</button></div><div data-map-display-body><div class="network-map-display-grid">${networkRows}${['zone','zone_node','facility','warehouse','crew','vehicle','generator','task','route',...kinds.filter(kind=>!Object.hasOwn(names,kind))].filter(kind=>kinds.includes(kind)).map(kind=>row(kind,names[kind]||REGIONAL_KINDS[kind]||kind,icon(kind),`data-regional-layer="${esc(kind)}"`)).join('')}${hasResources?'<label class="network-map-display-item network-map-label-toggle"><input type="checkbox" data-map-labels aria-label="资源名称常显"><i class="network-map-text-key" aria-hidden="true">文</i><span>资源名称常显</span></label>':''}</div>${roles.size?`<div class="network-map-grid-symbols" aria-label="电网节点图标说明">${Object.keys(POWER_ROLES).filter(role=>roles.has(role)).map(role=>`<span>${powerSymbol(role,'#165480').image}${esc(POWER_ROLES[role])}</span>`).join('')}</div>`:''}${stateKey}<p>${hasResources?'鼠标移到图标可看名称，点击查看详情。任务和运输路线可按需打开。':kinds.includes('zone')?'点击分区查看供电状态、人口及关联依据。':'点击节点或线路查看当前电网结果。'}</p></div>`;
    c.root.querySelector('[data-canvas]').append(panel);
    panel.querySelectorAll('[data-regional-layer]').forEach(input=>input.addEventListener('change',event=>setMapLayerVisibility(c,event.target.dataset.regionalLayer,event.target.checked)));
    panel.querySelectorAll('[data-network-layer]').forEach(input=>input.addEventListener('change',event=>setMapLayerVisibility(c,event.target.dataset.networkLayer,event.target.checked)));
    panel.querySelector('[data-map-labels]')?.addEventListener('change',event=>setMapLayerVisibility(c,'labels',event.target.checked));
    panel.querySelector('[data-map-display-collapse]').addEventListener('click',event=>{const collapsed=event.currentTarget.getAttribute('aria-expanded')==='true';event.currentTarget.setAttribute('aria-expanded',String(!collapsed));event.currentTarget.setAttribute('aria-label',collapsed?'展开地图图例':'收起地图图例');event.currentTarget.textContent=collapsed?'展开':'收起';panel.querySelector('[data-map-display-body]').hidden=collapsed;panel.classList.toggle('is-collapsed',collapsed);});
    for(const type of ['pointerdown','mousedown','dblclick','wheel'])panel.addEventListener(type,event=>event.stopPropagation());
    syncMapLayerControls(c);
  }
  function applyMapPreset(c,preset){
    if(!['grid','emergency','combined'].includes(preset))return false;c.mapPreset=preset;
    c.root.querySelectorAll('[data-map-preset]').forEach(button=>{const active=button.dataset.mapPreset===preset;button.setAttribute('aria-pressed',String(active));active?button.classList.add('is-active'):button.classList.remove('is-active');});
    filterLayers(c,false);updateRegional(c);syncMapLayerControls(c);syncSandbox(c);return true;
  }
  const MOVING_STATUS=new Set(['in_transit','crew_in_transit','travelling_to_pickup','delivering','returning']);
  function regionalMovementRoute(frame,feature){
    const p=feature.properties || {},key=feature.kind==='crew'?'team':feature.kind==='generator'?'generator_id':'vehicle_id';
    if(p[key]==null)return null;return (frame?.features || []).find(route=>route.kind==='route'&&route.geometry?.type==='LineString'&&validRegionalGeometry(route.geometry)&&route.properties?.resource_kind===feature.kind&&String(route.properties[key])===String(p[key])&&route.properties.status===p.status&&route.properties.from_location_id&&route.properties.to_location_id&&(!p.assignment_id||route.properties.assignment_id===p.assignment_id)&&(!p.asset_key||route.properties.asset_key===p.asset_key)&&(!p.facility_id||route.properties.facility_id===p.facility_id));
  }
  function interpolatedRegionalPositions(c,time){
    const positions=new Map(),frames=c.data.regional_layers?.frames || [],a=frames[Math.max(0,c.index)],b=frames[Math.max(0,c.index)+1];if(!a||!b||!(b.time_hours>a.time_hours)||!(time>a.time_hours&&time<b.time_hours))return positions;
    const amount=(time-a.time_hours)/(b.time_hours-a.time_hours),next=new Map((b.features || []).map(feature=>[feature.id,feature]));
    for(const feature of a.features || []){const other=next.get(feature.id),p=feature.properties || {},q=other?.properties || {};
      if(!['crew','vehicle','generator'].includes(feature.kind)||feature.geometry?.type!=='Point'||other?.geometry?.type!=='Point'||!validRegionalGeometry(feature.geometry)||!validRegionalGeometry(other.geometry)||!MOVING_STATUS.has(p.status)||feature.kind!==other.kind||p.geometry_basis!=='interpolated_dispatch_position')continue;
      const identity=feature.kind==='crew'?'asset_key':feature.kind==='generator'?'facility_id':'assignment_id',resource=feature.kind==='crew'?'team':feature.kind==='generator'?'generator_id':'vehicle_id';if(p[identity]==null||p[identity]!==q[identity]||p[resource]==null||p[resource]!==q[resource])continue;
      const first=regionalMovementRoute(a,feature),last=regionalMovementRoute(b,other);if(!first)continue;
      if(p.status===q.status){if(q.geometry_basis!=='interpolated_dispatch_position'||!last||first.id!==last.id||first.properties.from_location_id!==last.properties.from_location_id||first.properties.to_location_id!==last.properties.to_location_id||JSON.stringify(first.geometry.coordinates)!==JSON.stringify(last.geometry.coordinates))continue;}
      else{const endpoint=first.geometry.coordinates[first.geometry.coordinates.length-1];if(!endpoint.every((v,i)=>Math.abs(v-other.geometry.coordinates[i])<1e-9))continue;}
      const from=feature.geometry.coordinates,to=other.geometry.coordinates;positions.set(feature.id,[from[0]+(to[0]-from[0])*amount,from[1]+(to[1]-from[1])*amount]);
    }return positions;
  }
  function reducedRegionalMotion(){return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);}
  function setRegionalPlaybackClasses(c){
    const animate=Boolean(c.playing&&!reducedRegionalMotion());
    for(const row of c.regionalLayers || []){const element=row.layer.getElement?.();if(!element)continue;const moving=MOVING_STATUS.has(row.feature.properties?.status);const className=row.feature.kind==='route'?'regional-map-route-animated':'regional-map-moving';animate&&moving?element.classList.add(className):element.classList.remove(className);}
  }
  function updateRegionalMotion(c,time){
    c.playTime=time;c.playPositions=reducedRegionalMotion()?new Map():interpolatedRegionalPositions(c,time);
    for(const row of c.regionalLayers || []){const xy=c.playPositions.get(row.feature.id);if(xy)row.layer.setLatLng?.([xy[1],xy[0]]);}
    const layout=regionalMarkerLayout(c),layoutKey=JSON.stringify([...layout]),layoutChanged=c.regionalMotionLayoutKey!==layoutKey;if(layoutChanged){c.regionalMotionLayoutKey=layoutKey;styleRegionalSelection(c);}
    const label=c.root.querySelector('[data-play-time]');if(label)label.textContent=`仿真时间 ${time.toFixed(2)} 小时`;
    const wallTime=typeof performance==='object'&&typeof performance.now==='function'?performance.now():Date.now();
    if(c.showRegional3D&&c.sandbox?.updatePointPositions&&(!c.data.power_impact||hasRegionalResources(c))&&(c.lastMotionSync==null||wallTime-c.lastMotionSync>=50)){
      c.lastMotionSync=wallTime;const updates=[],sceneLayout=layoutChanged?regionalMarkerLayout(c,26):null;
      for(const feature of regionalFeatures(c)){
        if(feature.geometry?.type!=='Point'||!validRegionalGeometry(feature.geometry))continue;
        const transport=['crew','vehicle','generator'].includes(feature.kind);if(!transport&&!layoutChanged)continue;
        const point=c.playPositions.get(feature.id) || feature.geometry.coordinates;
        updates.push({id:'regional:'+feature.id,...(transport?{lon:point[0],lat:point[1],replayTimeHours:time,moving:Boolean(c.playing&&!reducedRegionalMotion()&&MOVING_STATUS.has(feature.properties?.status)),positionInterpolated:c.playPositions.has(feature.id)}:{}),...(layoutChanged?{screenOffset:sceneLayout.get(feature.id) || [0,0]}:{})});
      }
      c.sandbox.updatePointPositions(updates);
    }
  }
  function advanceRegionalPlayback(c,time){
    const frames=c.data.regional_layers?.frames || [];if(!frames.length)return;const {first,last}=regionalPlaybackBounds(c),clamped=Math.max(first,Math.min(last,time));let next=0;while(next+1<frames.length&&frames[next+1].time_hours<=clamped+1e-9)next++;
    if(next!==c.index){c.index=next;c.playPositions=new Map();update(c);}updateRegionalMotion(c,clamped);if(clamped>=last)stopClock(c.root);
  }
  function regionalPlaybackBounds(c){
    const frames=c.data.regional_layers?.frames || [],first=frames[0]?.time_hours??0,last=frames[frames.length-1]?.time_hours??first;
    return {first,last:c.playWindow==='emergency24'?Math.min(last,first+24):last};
  }
  function setRegionalPlaybackWindow(c,mode){
    if(!['all','emergency24'].includes(mode))return false;stopClock(c.root);c.playWindow=mode;
    const picker=c.root.querySelector('[data-play-window]');if(picker)picker.value=mode;
    const {first,last}=regionalPlaybackBounds(c),frames=c.data.regional_layers?.frames || [],slider=c.root.querySelector('[data-time-slider]');
    if(slider)slider.max=String(Math.max(0,frames.findLastIndex(frame=>frame.time_hours<=last+1e-9)));
    advanceRegionalPlayback(c,first);return true;
  }
  function startRegionalPlayback(c){
    const frames=c.data.regional_layers?.frames || [];if(frames.length<2)return;const {first,last}=regionalPlaybackBounds(c);if(last<=first)return;if(c.playTime==null||c.playTime<first||c.playTime>=last)c.playTime=first;
    c.playing=true;c.root.querySelector('[data-play]').textContent='暂停';c.root.querySelector('[data-play]').setAttribute('aria-pressed','true');setRegionalPlaybackClasses(c);
    const rate=(last-first)/30,step=(timestamp)=>{if(!c.playing||!visible(c)){stopClock(c.root);return;}const delta=c.lastPlayTimestamp==null?0:Math.min(.12,Math.max(0,(timestamp-c.lastPlayTimestamp)/1000));c.lastPlayTimestamp=timestamp;advanceRegionalPlayback(c,c.playTime+delta*rate*(c.playSpeed || 1));if(c.playing)c.playRAF=window.requestAnimationFrame(step);};
    c.lastPlayTimestamp=null;c.lastMotionSync=null;advanceRegionalPlayback(c,c.playTime);
    if(c.playing&&(reducedRegionalMotion()||!window.requestAnimationFrame)){c.timer=setInterval(()=>{if(!visible(c)){stopClock(c.root);return;}advanceRegionalPlayback(c,c.playTime+.25*rate*(c.playSpeed || 1));},250);}else if(c.playing)c.playRAF=window.requestAnimationFrame(step);
  }
  function resetRegionalPlayback(c){stopClock(c.root);c.index=0;c.playTime=c.data.regional_layers?.frames[0]?.time_hours??0;c.playPositions=new Map();update(c);updateRegionalMotion(c,c.playTime);}
  function setRegionalView(c,view){
    const wants3d=view==='3d'&&Boolean(c.scenePolicy?.use3d);c.showRegional3D=wants3d;
    const picker=c.root.querySelector('[data-regional-view]');if(picker)picker.value=wants3d?'3d':'2d';
    if(wants3d){c.lastMotionSync=null;if(c.sandbox){syncSandbox(c);c.root.querySelector('[data-canvas]').classList.add('has-geographic-sandbox');c.sandbox.resume?.();c.sandbox.resize();}else ensureSandbox(c);}
    else{c.sandbox?.pause();c.root.querySelector('[data-canvas]').classList.remove('has-geographic-sandbox');c.map?.invalidateSize({animate:false,pan:true});}
    sceneViewState(c,wants3d?(c.sandbox?'ready':'preparing'):'regional2d');return wants3d;
  }
  function installRegionalControls(c){
    if(!c.data.regional_layers)return;c.root.querySelector('.engineering-network-map').classList.add('has-regional-layers');c.regionalVisibility ||= {};const kinds=[...new Set(c.data.regional_layers.feature_by_ref?Object.values(c.data.regional_layers.feature_by_ref).map(feature=>feature.kind):c.data.regional_layers.frames.flatMap(frame=>(frame.features || []).map(feature=>feature.kind)))];
    for(const kind of kinds)if(c.regionalVisibility[kind]===undefined)c.regionalVisibility[kind]=!['task','route'].includes(kind);
    c.showNodes??=true;c.showLinks??=true;c.showLabels??=false;
    const block=document.createElement('section');block.className='regional-map-controls';block.innerHTML=`<div class="regional-map-heading"><h3>停电影响与应急处置地图</h3><label>地图方式 <select data-regional-view><option value="2d">二维地图</option><option value="3d">三维分析地图</option></select></label></div><p>二维与三维使用相同图标、状态和图例。图标形状表示对象类别，文字和颜色表示当前保存状态。虚线圆心图标是服务区关联节点，未录入边界时不会画停电范围；配送连线与沿线位置是录入行程示意，不是道路或 GPS 实测。图例仅列当前已定位且开启的对象，点击可定位。</p><div class="regional-map-layers">${kinds.map(kind=>`<label><input type="checkbox" checked data-regional-layer="${esc(kind)}">${esc(REGIONAL_KINDS[kind] || kind)}</label>`).join('')}</div><div class="regional-map-legend" data-regional-legend aria-label="当前区域与应急对象图例"></div><div class="regional-map-summary" data-regional-summary role="status"></div><details data-regional-unlocated></details><details><summary>空间结果表达说明</summary>${(c.data.regional_layers.limitations || []).map(note=>`<p>${esc(note)}</p>`).join('')}</details>`;
    const combined=Boolean(c.data.power_impact&&hasRegionalResources(c));
    if(c.data.power_impact){block.querySelector('h3').textContent=combined?'停电人口与应急协同处置地图':'停电范围与人口地图';block.querySelector('p').textContent='区域面边界来自保存的空间资料，供电状态来自关联节点的计算结果。红色：全部失供，蓝色：部分失供，绿色：无失供，灰色：供电状态未知。每个分区独立记录边界与电网关联依据；人口影响是所用人口资料上的估计，未知及未覆盖部分另外报告。二维与三维共用区域、状态和灾后时刻。'+(combined?' 关键设施、抢修队、应急电源、物资和车辆同步使用本策略、本时刻的区域协同结果；图标形状区分类别，车辆位置按保存行程插值。设施移动电源保障不表示整片电网恢复。':'');block.querySelector('[data-regional-legend]').setAttribute('aria-label',combined?'当前供电分区与应急资源状态图例':'当前供电分区状态图例');block.querySelector('.regional-map-layers').innerHTML=kinds.map(kind=>`<label><input type="checkbox" checked data-regional-layer="${esc(kind)}">${esc(kind==='zone'?'供电分区（含未映射区）':REGIONAL_KINDS[kind] || kind)}</label>`).join('');}
    c.root.querySelector('.network-recovery-controls').after(block);
    const objectLabel=document.createElement('label');objectLabel.className='regional-object-picker';objectLabel.innerHTML=c.data.power_impact&&!combined?'<span>选择供电分区</span><select data-regional-object aria-label="选择供电分区"><option value="">请选择供电分区</option></select><small>分区边界与电网关联依据分别保留，未映射区域另行标注。</small>':'<span>选择区域与应急对象</span><select data-regional-object aria-label="选择区域与应急对象"><option value="">请选择</option></select><small>同一坐标的图标仅在屏幕上错位展开，真实坐标和导出数据保持原值。</small>';c.root.querySelector('.regional-map-heading').after(objectLabel);
    c.root.querySelector('[data-regional-object]').addEventListener('change',event=>chooseRegionalObject(c,event.target.value));
    const presets=document.createElement('div');presets.className='regional-map-presets';presets.setAttribute('role','group');presets.setAttribute('aria-label',c.data.power_impact?'停电影响地图视图':'调度地图视图');presets.innerHTML=`<button type="button" data-map-preset="grid" aria-pressed="false">电网</button><button type="button" data-map-preset="emergency" aria-pressed="false">${combined?'停电与应急':c.data.power_impact?'停电范围':'应急'}</button><button type="button" data-map-preset="combined" aria-pressed="true" class="is-active">综合</button>`;if(c.data.nodes.length||c.data.links.length)c.root.querySelector('.regional-map-heading').after(presets);c.mapPreset='combined';
    c.root.querySelectorAll('[data-map-preset]').forEach(button=>button.addEventListener('click',()=>applyMapPreset(c,button.dataset.mapPreset)));
    c.root.querySelectorAll('[data-regional-layer]').forEach(input=>input.addEventListener('change',event=>setMapLayerVisibility(c,event.target.dataset.regionalLayer,event.target.checked)));
    c.root.querySelector('[data-regional-view]').addEventListener('change',event=>setRegionalView(c,event.target.value));
    installMapDisplayLegend(c,kinds);
  }
  function installGridViewControl(c){
    if(!controlledMapView(c)||c.data.regional_layers)return;
    c.showRegional3D=false;c.showNodes??=true;c.showLinks??=true;
    const label=document.createElement('label');label.className='network-map-view-control';
    label.innerHTML='地图方式 <select data-regional-view aria-label="电网地图方式"><option value="2d">二维地图</option><option value="3d">三维分析地图</option></select>';
    c.root.querySelector('.medical-map-toolbar').append(label);
    label.querySelector('[data-regional-view]').addEventListener('change',event=>setRegionalView(c,event.target.value));
    installMapDisplayLegend(c,[]);
  }
  function overlays(c){
    const nodes=new Map(c.data.nodes.map(item=>[String(item.id),item])),points=[],links=[];c.overlayRecords=new Map();
    for(const item of c.data.nodes){if(!itemVisible(c,item,'node'))continue;const id=overlayId(item,'node'),selected=c.selected?.item===item,fill=color(c,item,'node');c.overlayRecords.set(id,{item,group:'node'});
      if(c.data.system==='power_system')points.push({id,lon:item.longitude,lat:item.latitude,longitude:item.longitude,latitude:item.latitude,...powerDisplaySymbol(c,item,'node'),...(item.footprint?.length>=4?{footprint:item.footprint,fillColor:fill,fillOpacity:.6,color:fill}:{}),...networkSceneRecord(c,item,'node'),selected});
      else if(item.footprint?.length>=4)points.push({id,lon:item.longitude,lat:item.latitude,longitude:item.longitude,latitude:item.latitude,footprint:item.footprint,fillColor:fill,fillOpacity:c.data.system==='building_complex'?1:.6,color:fill,width:1.5,selected,label:item.name||String(item.id),...(c.data.system==='building_complex'?{buildingVolume:true,height_m:item.height_m,height_source:item.height_source,source_building_id:item.source_building_id}: {})});
      else points.push({id,lon:item.longitude,lat:item.latitude,longitude:item.longitude,latitude:item.latitude,...circleImage(fill,c.data.nodes.length>100?2.5:6,c.data.nodes.length>100?.6:1.5,.95),selected,label:item.name||String(item.id)});
    }
    for(const item of c.data.links){if(!itemVisible(c,item,'pipe'))continue;const a=nodes.get(String(item.from_node)),b=nodes.get(String(item.to_node));if(!a||!b)continue;const id=overlayId(item,'pipe'),selected=c.selected?.item===item,fill=color(c,item,'pipe');c.overlayRecords.set(id,{item,group:'pipe'});
      if(item.asset_kind==='transformer'){const point=[(a.longitude+b.longitude)/2,(a.latitude+b.latitude)/2];points.push({id,lon:point[0],lat:point[1],longitude:point[0],latitude:point[1],...(c.data.system==='power_system'?{...powerDisplaySymbol(c,item,'pipe'),...networkSceneRecord(c,item,'pipe')}:circleImage(fill,9,2,0)),selected,label:item.name||String(item.id)});}
      else links.push({id,coordinates:item.coordinates||[[a.longitude,a.latitude],[b.longitude,b.latitude]],color:fill,width:lineWidth(c,item),opacity:c.data.system==='power_system'?1:.85,dash:lineDash(c,item),...(c.data.system==='power_system'?{casingColor:'#f7fbff',casingWidth:1.5,...networkSceneRecord(c,item,'pipe')}:{}),selected,label:item.name||String(item.id)});
      if(c.showConnections!==false)(item.display_connections||[]).forEach((coordinates,index)=>{if(Array.isArray(coordinates)&&coordinates.length>=2&&coordinates.every(p=>Array.isArray(p)&&p.length>=2&&p.every(Number.isFinite)))links.push({id:`connection:${String(item.id)}:${index}`,coordinates,color:fill,width:c.data.system==='power_system'?1.8:1.2,opacity:.65,dash:[3,3],...(c.data.system==='power_system'?{casingColor:'#f7fbff',casingWidth:.8}:{}),interactive:false});});
    }
    if(c.data.regional_layers){const regional=regionalOverlays(c);points.push(...regional.points);links.push(...regional.links);}return {points,links};
  }
  function networkSceneRecord(c,item,group){
    const role=group==='node'?powerRole(item):item.asset_kind==='transformer'?'transformer':'line',type=POWER_ROLES[role] || '输配电线路',v=values(c,item,group),selected=c.selected?.item===item,status=c.metric==='damage'?v.damage || '未关联损伤结果':c.metric==='geometry'?item.voltage_kv?`${item.voltage_kv} kV`:'已录入网络位置':typeof v.function==='number'?`功能值 ${value(v.function)}`:'未关联功能结果',name=item.name||String(item.id),title=type+' · '+name;
    return {analysisRole:'network',networkRole:role,objectType:type,objectName:name,statusText:status,color:color(c,item,group),labelTitle:title,labelDetail:status,basisText:group==='pipe'?routeBasis(item):'',label:title+' · '+status,labelPolicy:{permanent:selected,direction:'top',priority:selected?95:10},timeHours:regionalFrame(c)?.time_hours??null,replayTimeHours:c.playTime??regionalFrame(c)?.time_hours??null};
  }
  function syncSandbox(c){if(!c.sandbox)return;const data=overlays(c);c.sandbox.setPoints(data.points);c.sandbox.setLinks(data.links);c.sandbox.select?.(c.regionalSelectedId?'regional:'+c.regionalSelectedId:c.selected?overlayId(c.selected.item,c.selected.group):null);}
  function exportFeatures(c){
    const nodes=new Map(c.data.nodes.map(item=>[String(item.id),item])),records=c.data.nodes.map(item=>({item,group:'node',geometry:item.footprint?.length>=4?{type:'Polygon',coordinates:[item.footprint]}:{type:'Point',coordinates:[item.longitude,item.latitude]}}));
    for(const item of c.data.links){const a=nodes.get(String(item.from_node)),b=nodes.get(String(item.to_node));if(!a||!b)continue;records.push({item,group:'pipe',geometry:item.asset_kind==='transformer'?{type:'Point',coordinates:[(a.longitude+b.longitude)/2,(a.latitude+b.latitude)/2]}:{type:'LineString',coordinates:item.coordinates||[[a.longitude,a.latitude],[b.longitude,b.latitude]]}});}
    const savedTime=regionalFrame(c)?.time_hours,replayTime=c.playTime??savedTime;
    const regional=regionalFeatures(c).filter(feature=>validRegionalGeometry(feature.geometry)).map(feature=>{const position=c.playPositions?.get(feature.id);return {type:'Feature',geometry:position?{type:'Point',coordinates:[...position]}:feature.geometry,properties:{id:feature.id,name:feature.name,kind:feature.kind,time_hours:savedTime,...feature.properties,replay_time_hours:replayTime,saved_time_hours:savedTime,position_interpolated:Boolean(position)}};});
    return regional.concat(records.map(({item,group,geometry})=>({type:'Feature',geometry,properties:{...item.properties,id:item.id,name:item.name,result_id:item.result_id||item.id,result_group:item.result_group||group,from_node:item.from_node,to_node:item.to_node,asset_kind:item.asset_kind,voltage_kv:item.voltage_kv,display_connections:item.display_connections,geometry_basis:item.geometry_basis||(group==='node'?'recorded_coordinates':item.coordinates?'recorded_polyline':'endpoint_topology'),...(item.loss_metrics?{initial_building_losses:item.loss_metrics,building_loss_model_version:c.data.building_losses?.model_version}:{}),...values(c,item,group)}})));
  }
  function sceneStatus(c,message){if(!current(c))return;const el=c.root.querySelector('[data-sandbox-status]');if(el){el.textContent=message;el.hidden=!message;}}
  function setSceneBackgroundState(c,state){
    if(!current(c))return;c.sceneBackground={...c.sceneBackground,...state};
    const retry=c.root.querySelector('[data-scene-retry]');
    if(retry){retry.hidden=state.state!=='failed';retry.disabled=state.state==='loading';retry.textContent=state.state==='failed'?'重试建筑背景':'重新加载三维';}
    if(c.sandbox)sceneViewState(c,'ready');
  }
  function sceneBackgroundFailed(c,error){
    if(!current(c))return;setSceneBackgroundState(c,{state:'failed',error});
    sceneStatus(c,`${sceneFailureMessage(error)}。已显示的三维评估对象、恢复时刻与视角保留；点击“重试建筑背景”，无需重新评估。`);
  }
  function sceneFailureMessage(error){
    const detail=[error?.message,error?.error?.message,error?.cause?.message].filter(Boolean).join(' ');
    const stage=error?.stage||error?.cause?.stage,code=error?.code||error?.error_code||error?.cause?.code;
    if(stage==='engine')return /timeout|超时/i.test(detail)?'本地三维引擎加载超时，可重新加载三维':'本地三维引擎资源暂不可用，可重新加载三维';
    if(stage==='render')return '三维图形绘制未完成，可减少图层后重试';
    if(code==='source_capacity')return '当前建筑背景数据量较大，请放大至更小范围后重试';
    if(stage==='source')return /timeout|time[ -]?out|504|超时|超过\s*\d+\s*秒/i.test(detail)?'建筑与道路背景下载超时，已完成分块会保留':'建筑与道路背景暂时无法下载，可稍后续载';
    if(stage==='request')return '城市地图范围或任务状态读取暂未成功，请检查连接后重试';
    if(/webgl|gpu|图形|graphics|context[\s_-]*(?:lost|unavailable|creation|failed)/i.test(detail))return '浏览器三维图形暂不可用';
    if(/timeout|time[ -]?out|504|超时|超过\s*\d+\s*秒/i.test(detail))return '三维地图加载超时，可稍后重试';
    if(/HTTPStatusError|https?:\/\/|502|503|Bad Gateway|network|fetch|网络|地图源|无法加载|暂时无法/i.test(detail))return '三维地图源暂时不可用，请检查网络后重试';
    return '三维地图资料或绘制暂未完成，可稍后重试';
  }
  function resize(c){if(!visible(c)){c.sandbox?.pause();return;}if(!c.map&&!c.leafletInitialized)initializeLeaflet(c);c.map?.scrollWheelZoom?.enable?.();c.map?.invalidateSize({animate:false,pan:true});if(!controlledMapView(c)||c.showRegional3D)c.sandbox?.resize();ensureSandbox(c);}
  function ensureSandbox(c){
    if(controlledMapView(c)&&!c.showRegional3D)return;if(!c.scenePolicy?.use3d||!visible(c)||c.sandbox||c.sandboxPending||c.sandboxAttempted)return;const source=sceneSource(c);if(!source||!window.GeographicSandbox?.create)return;
    c.sandboxAttempted=true;c.sandboxPending=true;c.progressiveScene=!c.scenePolicy.regionalAnalysis;const serial=++c.setupSerial;const retry=c.root.querySelector('[data-scene-retry]');retry.hidden=true;retry.disabled=true;retry.textContent='重新加载三维';sceneViewState(c,'preparing');sceneStatus(c,'正在加载 3D 地图，请稍候。当前可先查看二维地图，完成后自动切换。');
    const target=c.root.querySelector('[data-sandbox-canvas]');c.sceneController=new AbortController();
    const onStatus=progress=>{if(current(c)&&serial===c.setupSerial){const message=typeof progress==='string'?progress:progress?.message||progress?.label||'';sceneStatus(c,c.sandbox?message:`正在加载 3D 地图，请稍候。${message?message+'。':''}当前可先查看二维地图，完成后自动切换。`);}};
    const onBackgroundState=state=>{if(current(c)&&serial===c.setupSerial)setSceneBackgroundState(c,state);};
    const onBackgroundReady=state=>{if(current(c)&&serial===c.setupSerial){setSceneBackgroundState(c,{...state,state:'ready'});sceneStatus(c,'');}};
    const onBackgroundError=error=>{if(current(c)&&serial===c.setupSerial)sceneBackgroundFailed(c,error);};
    const fallback=error=>{if(!current(c)||serial!==c.setupSerial)return;console.warn('工程网络三维地图加载失败',error);c.setupSerial++;c.sceneController?.abort();c.sandboxPending=false;c.sandbox?.destroy();c.sandbox=null;c.root.querySelector('[data-canvas]').classList.remove('has-geographic-sandbox');target.innerHTML='';c.map?.invalidateSize({animate:false,pan:true});retry.hidden=false;retry.disabled=false;if(c.scenePolicy.regionalAnalysis){c.showRegional3D=false;const picker=c.root.querySelector('[data-regional-view]');if(picker)picker.value='2d';}sceneViewState(c,'failed');sceneStatus(c,`${sceneFailureMessage(error)}。继续显示二维地图并保留当前评估结果；点击“重新加载三维”仅重试地图，无需重新评估。`);};
    const analysisBounds=[...c.scenePolicy.bounds];
    if(analysisBounds[0]===analysisBounds[2]){analysisBounds[0]=Math.max(-180,analysisBounds[0]-.0005);analysisBounds[2]=Math.min(180,analysisBounds[2]+.0005);}
    if(analysisBounds[1]===analysisBounds[3]){analysisBounds[1]=Math.max(-90,analysisBounds[1]-.0005);analysisBounds[3]=Math.min(90,analysisBounds[3]+.0005);}
    const basemap=c.basemapConfigs?.[c.basemapMode||'analysis'] || c.basemapConfigs?.analysis || window.MedicalMap?.basemapConfig?.(c.data);
    const analysisOptions=c.scenePolicy.regionalAnalysis?{powerRegionalMode:true,lightweightAnalysis:true,analysisBounds,analysisBasemap:basemap}:{progressiveBackground:true,analysisBounds,analysisBasemap:basemap,...(c.data.system==='building_complex'?{assessmentStyle:'building',assessmentBuildings:c.data.nodes.filter(item=>item.footprint?.length>=4)}:{})};
    Promise.resolve().then(()=>{if(!current(c)||serial!==c.setupSerial)return null;return window.GeographicSandbox.create(target,{...source,source,...analysisOptions,signal:c.sceneController.signal,onProgress:onStatus,onStatus,onBackgroundState,onBackgroundReady,onBackgroundError,onError:fallback,onSelect:detail=>{if(!current(c)||serial!==c.setupSerial)return;const id=typeof detail==='string'?detail:detail?.id;const record=c.overlayRecords?.get(String(id));if(record?.feature)regionalSelection(c,record.feature);else if(record)selection(c,record.item,record.group);}});}).then(instance=>{
      if(!instance)return;if(!current(c)||serial!==c.setupSerial){instance.destroy();return;}c.sandboxPending=false;c.sandbox=instance;syncSandbox(c);if(c.restoredSceneView){instance.restoreView?.(c.restoredSceneView);c.restoredSceneView=null;}if(!controlledMapView(c)||c.showRegional3D)c.root.querySelector('[data-canvas]').classList.add('has-geographic-sandbox');sceneViewState(c,'ready');if(c.sceneBackground?.state!=='failed')sceneStatus(c,'');if(visible(c)&&(!controlledMapView(c)||c.showRegional3D))instance.resize();else instance.pause();
    }).catch(fallback);
  }
  function fit(c){if(c.sandbox&&(!controlledMapView(c)||c.showRegional3D)){c.sandbox.fit();return;}const bounds=c.scenePolicy?.bounds;if(c.map&&bounds?.every(Number.isFinite))c.map.fitBounds([[bounds[1],bounds[0]],[bounds[3],bounds[2]]],{padding:[28,28],maxZoom:17});}
  function engineeringBasemapConfigs(c){
    const original=window.MedicalMap.basemapConfig(c.data);
    // Neutral cartography has no terrain/POI symbols competing with model objects.
    // Keep the supplied source selectable, including private/local basemap services.
    const points=c.data.nodes||[],newZealand=points.length>0&&points.every(n=>n.longitude>=165&&n.longitude<=180&&n.latitude>=-48&&n.latitude<=-33);
    return {original,analysis:{tileUrl:'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',referenceUrl:'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',maxZoom:Math.max(19,original.maxZoom),maxNativeZoom:newZealand?16:13,attribution:'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'}};
  }
  function setEngineeringBasemap(c){
    if(!c.map)return;for(const layer of c.basemapLayers||[])c.map.removeLayer(layer);c.basemapLayers=[];
    const source=c.basemapConfigs?.[c.basemapMode||'analysis']||window.MedicalMap.basemapConfig(c.data);
    const config=window.ResCityPresentationMask?.basemap?.(source)||source;let errors=0;
    for(const url of [config.tileUrl,config.referenceUrl].filter(Boolean)){
      const tiles=L.tileLayer(url,{attribution:url===config.tileUrl?config.attribution:'',maxZoom:config.maxZoom,maxNativeZoom:config.maxNativeZoom,referrerPolicy:'strict-origin-when-cross-origin'});
      tiles.on('tileerror',()=>{if(!current(c))return;errors++;const note=c.root.querySelector('[data-tile-status]');note.hidden=false;note.textContent='部分地理底图暂未加载，评估对象与坐标仍有效；可切换底图。';});
      tiles.on('load',()=>{if(current(c)&&!errors)c.root.querySelector('[data-tile-status]').hidden=true;});tiles.addTo(c.map);window.ResCityPresentationMask?.decorateLeaflet?.(tiles,config);c.basemapLayers.push(tiles);
    }
  }
  function installEngineeringBasemapControl(c){
    if(c.data.system!=='power_system'||!controlledMapView(c))return;
    c.basemapConfigs=engineeringBasemapConfigs(c);c.basemapMode='analysis';
    const label=document.createElement('label');label.className='network-map-basemap-control';label.innerHTML='<span>底图</span><select data-engineering-basemap aria-label="电力地图底图"><option value="analysis">清爽分析底图</option><option value="original">原始地理底图</option></select>';label.title='底图仅提供道路与地名参照；地形和地物符号不属于电力评估结果。';
    c.root.querySelector('.medical-map-toolbar').append(label);
    label.querySelector('[data-engineering-basemap]').addEventListener('change',event=>{if(!['analysis','original'].includes(event.target.value))return;c.basemapMode=event.target.value;setEngineeringBasemap(c);c.sandbox?.setBasemap?.(c.basemapConfigs[c.basemapMode]);});
  }
  function initializeLeaflet(c){
    if(!visible(c)||c.leafletInitialized)return;c.leafletInitialized=true;const root=c.root,d=c.data,canvas=root.querySelector('[data-leaflet-canvas]');
    if(!window.L){canvas.textContent='二维地图组件未加载，正在尝试准备三维地理场景。';return;}
    const sourceConfig=c.basemapConfigs?.analysis||window.MedicalMap.basemapConfig(d),config=window.ResCityPresentationMask?.basemap?.(sourceConfig)||sourceConfig;c.map=L.map(canvas,{scrollWheelZoom:true,preferCanvas:true,maxZoom:config.maxZoom,minZoom:2});
    if(c.basemapConfigs)setEngineeringBasemap(c);else{
      const tiles=L.tileLayer(config.tileUrl,{attribution:config.attribution,maxZoom:config.maxZoom});let errors=0;
      tiles.on('tileerror',()=>{if(!current(c))return;errors++;const el=root.querySelector('[data-tile-status]');el.hidden=false;el.textContent='部分底图加载失败，坐标和网络仍有效；请检查网络后重试。';});tiles.on('loading',()=>{errors=0;});tiles.on('load',()=>{if(current(c)&&!errors)root.querySelector('[data-tile-status]').hidden=true;});tiles.addTo(c.map);window.ResCityPresentationMask?.decorateLeaflet?.(tiles,config);c.basemapLayers=[tiles];
    }
    c.presentationOff=window.ResCityPresentationMask?.subscribe?.(()=>{if(current(c))setEngineeringBasemap(c);});
    const nodes=new Map(d.nodes.map(n=>[String(n.id),n])),power=d.system==='power_system';c.connections=[];c.casings=[];
    d.links.forEach(item=>{
      const a=nodes.get(String(item.from_node)),b=nodes.get(String(item.to_node));if(!a||!b)return;
      const xy=item.coordinates?item.coordinates.map(p=>[p[1],p[0]]):[[a.latitude,a.longitude],[b.latitude,b.longitude]],dashArray=lineDash(c,item)?.join(' ')||null;
      if(power&&item.asset_kind!=='transformer'){const casing=L.polyline(xy,{weight:lineWidth(c,item)+3,color:'#f7fbff',opacity:1,dashArray,interactive:false}).addTo(c.map);c.casings.push({layer:casing,item,group:'pipe'});}
      const layer=(item.asset_kind==='transformer'?(power?L.marker([(a.latitude+b.latitude)/2,(a.longitude+b.longitude)/2],{icon:powerIcon(c,item,'pipe')}):L.circleMarker([(a.latitude+b.latitude)/2,(a.longitude+b.longitude)/2],{radius:9,weight:2,fillOpacity:0})):L.polyline(xy,{weight:lineWidth(c,item),opacity:power?1:.85,dashArray})).addTo(c.map);
      layer.bindTooltip(esc(item.name||item.id));layer.on('click',()=>selection(c,item,'pipe'));c.layers.push({layer,item,group:'pipe'});
      (item.display_connections||[]).forEach(points=>{if(!Array.isArray(points)||points.length<2||!points.every(p=>Array.isArray(p)&&p.length>=2&&p.every(Number.isFinite)))return;const coordinates=points.map(p=>[p[1],p[0]]);
        if(power){const casing=L.polyline(coordinates,{weight:3.4,color:'#f7fbff',opacity:.65,dashArray:'3 3',interactive:false}).addTo(c.map);c.casings.push({layer:casing,item,group:'pipe',connection:true});}
        const join=L.polyline(coordinates,{weight:power?1.8:1.2,opacity:.65,dashArray:'3 3',interactive:false}).addTo(c.map);c.connections.push({layer:join,item});
      });
    });
    d.nodes.forEach(item=>{
      if(power&&item.footprint?.length>=4){const footprint=L.polygon(item.footprint.map(p=>[p[1],p[0]]),{weight:1.5,fillOpacity:.6}).addTo(c.map);footprint.on('click',()=>selection(c,item,'node'));c.layers.push({layer:footprint,item,group:'node'});}
      const layer=(power?L.marker([item.latitude,item.longitude],{icon:powerIcon(c,item,'node')}):item.footprint?.length>=4?L.polygon(item.footprint.map(p=>[p[1],p[0]]),{weight:1.5,fillOpacity:.6}):L.circleMarker([item.latitude,item.longitude],{radius:d.nodes.length>100?2.5:6,weight:d.nodes.length>100?.6:1.5,fillOpacity:.95})).addTo(c.map);
      layer.bindTooltip(esc(item.name||item.id));layer.on('click',()=>selection(c,item,'node'));c.layers.push({layer,item,group:'node'});
    });
    fit(c);restoreLeafletView(c);c.map.on?.('zoom',()=>{if(current(c))styleRegionalSelection(c);});c.map.on?.('zoomend',()=>{if(current(c)){styleLayers(c);styleRegionalSelection(c);syncSandbox(c);}});filterLayers(c);update(c);
  }
  function selection(c,item,group){const changed=c.selected?.item!==item;const v=values(c,item,group);c.regionalSelectedId=null;c.selected={item,group};c.root.querySelector('[data-selection]').innerHTML=`<h3>${group==='node'?(c.data.system==='building_complex'?'建筑':'节点 / 设施'):item.asset_kind==='transformer'?'站内变压连接':'网络连线'} · ${esc(item.name||item.id)}</h3><dl><dt>编号</dt><dd>${esc(item.id)}</dd>${item.voltage_kv?`<dt>电压层级</dt><dd>${esc(item.voltage_kv)} kV</dd>`:''}${group==='node'?`<dt>经纬度（WGS84）</dt><dd>${esc(item.longitude)}, ${esc(item.latitude)}</dd>`:`<dt>连接</dt><dd>${esc(item.from_node)} → ${esc(item.to_node)}</dd><dt>路线依据</dt><dd>${esc(routeBasis(item))}</dd>`}${c.data.system==='building_complex'&&group==='node'?`<dt>展示高度</dt><dd>${esc(value(Number.isFinite(item.height_m)&&item.height_m>0?item.height_m:12))} m</dd><dt>高度依据</dt><dd>${esc(item.height_source||'缺少有效高度；采用12米示意高度')}</dd>`:''}<dt>功能值</dt><dd>${esc(value(v.function))}</dd><dt>损伤状态</dt><dd>${esc(value(v.damage))}</dd></dl>${lossDetails(item)}<button type="button" data-network-details>查看对应结果明细 →</button>${item.properties?`<details><summary>源数据属性与计算假设</summary><dl>${Object.entries(item.properties).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(value(v))}</dd>`).join('')}</dl></details>`:''}`;
    if(c.data.system==='power_system'){const heading=c.root.querySelector('[data-selection] h3');if(heading)heading.textContent=`${group==='node'?POWER_ROLES[powerRole(item)]:item.asset_kind==='transformer'?'变压连接':'电力线路'} · ${item.name||item.id}`;}
    const detail={id:String(item.id),group,resultId:String(item.result_id||item.id),resultGroup:item.result_group||group,name:item.name||String(item.id),sessionId:c.options.sessionId,iteration:Number(c.options.iteration||1),strategy:c.options.strategy||null};
    c.root.querySelector('[data-network-details]').onclick=()=>c.options.onDetails?.(detail);
    if(changed){styleLayers(c);styleRegionalSelection(c);syncSandbox(c);c.sandbox?.select(overlayId(item,group));c.layout?.openDetails();c.options.onSelect?.(detail);}
  }
  function select(root,record={}){
    const c=mounts.get(root);if(!c)return false;
    c.options.selection=record;
    if(!c.data)return false;
    if(record.group==='regional'){
      if(record.pan===true)return chooseRegionalObject(c,record.id);
      const feature=(regionalFrame(c)?.features || []).find(feature=>String(feature.id)===String(record.id));if(!feature)return false;
      regionalSelection(c,feature);return true;
    }
    if(record.id===null){c.selected=null;styleLayers(c);syncSandbox(c);c.sandbox?.select(null);c.root.querySelector('[data-selection]').innerHTML='<h3>点击节点或连线查看结果</h3><p>按原始编号关联计算状态；灰色表示暂无可关联结果。</p>';return true;}
    const group=record.group==='node'?'node':'pipe',items=group==='node'?c.data.nodes:c.data.links;
    const matches=items.filter(item=>String(item.id)===String(record.id)||(record.resultId!=null&&String(item.result_id||item.id)===String(record.resultId)&&(item.result_group||group)===(record.resultGroup||group)));
    if(matches.length!==1)return false;
    const item=matches[0];selection(c,item,group);
    if(record.pan===true){c.sandbox?.focus?.(overlayId(item,group));const layer=c.layers.find(row=>row.item===item)?.layer;if(!c.sandbox&&layer){if(layer.getLatLng)c.map?.panTo(layer.getLatLng());else c.map?.fitBounds(layer.getBounds(),{maxZoom:17});}}
    return true;
  }
  function styleLayers(c){
    const power=c.data.system==='power_system';
    c.layers.forEach(row=>{const {layer,item,group}=row;if(layer.setIcon){const icon=powerIcon(c,item,group),key=JSON.stringify(icon.options || icon);if(row.iconKey!==key){layer.setIcon(icon);row.iconKey=key;}return;}const fill=color(c,item,group),selected=c.selected?.item===item;layer.setStyle({color:fill,fillColor:fill,...(power&&group==='pipe'?{weight:lineWidth(c,item)*(selected?1.35:1),opacity:c.data.regional_layers?.8:1}:{})});});
    (c.casings||[]).forEach(({layer,item,connection})=>layer.setStyle({weight:connection?3.4:lineWidth(c,item)*(c.selected?.item===item?1.35:1)+3}));
    (c.connections||[]).forEach(({layer,item})=>layer.setStyle({color:color(c,item,'pipe')}));
  }
  function update(c){const controls=c.root.querySelector('.network-recovery-controls');if(controls)controls.hidden=lossMetric(c);styleLayers(c);updateRegional(c);if(c.selected)selection(c,c.selected.item,c.selected.group);const frame=c.data.frames[c.index];c.root.querySelector('[data-time]').textContent=frame?`恢复时刻：${value(frame.time)} ${frame.time_unit}`:c.hasResults?'震后初始结果':'网络位置预览 · 未关联计算';const slider=c.root.querySelector('[data-time-slider]');if(slider)slider.value=String(Math.max(0,c.index));c.root.querySelector('[data-legend]').textContent=c.metric==='geometry'?(c.data.system==='power_system'?'线路颜色区分已录入电压层级；实线：已录入线路路径，虚线：端点接线示意。':'蓝色：节点；绿色：连线。'):c.metric==='damage'?(c.data.regional_layers?'绿：基本完好；棕：中等破坏；红：严重或完全破坏；灰：未关联结果。':'绿：基本完好 → 黄：中等破坏 → 红：完全破坏；灰：未关联结果。'):(c.data.regional_layers?'功能值：深绿 ≥0.9；绿 ≥0.6；棕 ≥0.3；红 <0.3；灰：未关联结果。':'功能值：绿 ≥0.9；浅绿 ≥0.6；黄 ≥0.3；红 <0.3；灰：未关联结果。');if(lossMetric(c))c.root.querySelector('[data-legend]').textContent=lossLegend(c);if(c.data.power_impact&&!c.data.nodes.length&&!c.data.links.length)c.root.querySelector('[data-legend]').textContent='红：全部失供；蓝：部分失供；绿：无失供；灰：供电状态未知。';syncSandbox(c);c.options.onFrame?.({index:Math.max(0,c.index),frame:regionalFrame(c),savedTimeHours:regionalFrame(c)?.time_hours??null});}
  function filterLayers(c,synchronize=true){const visible=(item,group)=>itemVisible(c,item,group);(c.casings||[]).forEach(({layer,item,group,connection})=>visible(item,group)&&(!connection||c.showConnections!==false)?layer.addTo(c.map):c.map.removeLayer(layer));c.layers.forEach(({layer,item,group})=>visible(item,group)?layer.addTo(c.map):c.map.removeLayer(layer));(c.connections||[]).forEach(({layer,item})=>visible(item,'pipe')&&c.showConnections!==false?layer.addTo(c.map):c.map.removeLayer(layer));if(synchronize)syncSandbox(c);}
  function render(c){
    const d=c.data,root=c.root,source=d.source||{},link=safeLink(source.url);
    if(d.power_impact)c.index=Math.max(0,c.index);
    c.canPlay=(Boolean(d.regional_layers)||c.options.showRecovery!==false)&&(d.playback?.can_play??(new Set(d.frames.map(f=>f.time)).size>1));
    const available=metricAvailability(d);const hasLoss=d.system==='building_complex'&&d.nodes.some(n=>n.loss_metrics);c.hasResults=available.function||available.damage||hasLoss;
    if(!available.staticResults&&c.hasResults&&c.index<0&&d.frames.length)c.index=0;
    const areaOnly=Boolean(d.power_impact&&!d.nodes.length&&!d.links.length);
    const notes=`<details class="medical-map-method"><summary>地图数据与计算口径</summary>${d.map_view_note?`<p>${esc(d.map_view_note)}</p>`:''}<p>${esc(source.note||'位置来自所选数据版本；地图底图不参与工程计算。')}</p><ul>${(d.limitations||[]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul><p>${esc(source.title)} ${link?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">查看原始来源 ↗</a>`:''}</p><p>${esc(source.license||'')}</p></details>`;
    if(!d.nodes.length&&!d.regional_layers?.frames.some(frame=>(frame.features || []).some(feature=>validRegionalGeometry(feature.geometry)))){root.innerHTML=`<section class="medical-map"><div class="medical-map-state"><h3>补充坐标后即可查看真实地图</h3><p>在数据库的“地图坐标与网络”中录入节点经纬度、起终点编号，保存并发布版本。</p><button data-open-data>打开平台数据库</button></div>${notes}</section>`;root.querySelector('[data-open-data]').onclick=()=>window.ResCityNativeBridge?.openDatabase({sessionId:d.session_id});return;}
    root.innerHTML=`<section class="medical-map engineering-network-map" aria-label="工程系统真实网络地图"><div class="medical-map-toolbar"><div class="medical-map-control-group"><span>查看</span><select data-metric aria-label="网络地图指标"><option value="geometry">节点与网络</option><option value="function">功能状态</option><option value="damage">损伤状态</option>${hasLoss?Object.entries(LOSS_METRICS).map(([key,label])=>`<option value="${key}">${label}</option>`).join(''):''}</select><button data-initial>震后初始状态</button></div><div class="medical-map-control-group"><button data-fit>显示全部网络</button><button data-full>展开地图</button><button data-export>导出 GeoJSON</button></div></div>${d.visualization_only?'<p class="medical-map-warning">公开管线地图示例 · 未关联本任务的工程计算，未模拟灾害或恢复。</p>':''}<div class="network-recovery-controls"><strong data-time></strong>${c.canPlay?`<button data-play>播放恢复过程</button><input type="range" min="0" max="${d.frames.length-1}" value="0" data-time-slider aria-label="网络恢复时间点"><span>${d.frames.length} 个回放时刻</span>`:'<span>仅展示已有位置和已关联结果</span>'}</div><div class="medical-map-layout"><div class="medical-map-cartography"><div class="medical-map-canvas network-map-viewport" data-canvas aria-label="网络地图，可缩放和平移" role="region"><div class="network-leaflet-canvas" data-leaflet-canvas></div><div class="network-sandbox-canvas" data-sandbox-canvas></div></div><p data-sandbox-status class="network-sandbox-status" role="status" hidden></p><p data-tile-status class="medical-map-tile-status" hidden></p><div class="medical-map-map-footer"><p data-legend></p><p>全部网络：${d.nodes.length} 个节点 · ${d.links.length} 条连线 · WGS84</p></div></div><aside class="medical-map-sidebar"><div class="medical-map-selection" data-selection><h3>点击节点或连线查看结果</h3><p>按原始编号关联计算状态；灰色表示暂无可关联结果。</p></div><label>查找对象<select data-object aria-label="选择地图对象"><option value="">请选择</option>${d.nodes.map((n,i)=>`<option value="n:${i}">节点 · ${esc(n.name||n.id)}</option>`).join('')}${d.links.map((n,i)=>`<option value="l:${i}">连线 · ${esc(n.name||n.id)}</option>`).join('')}</select></label></aside></div>${notes}</section>`;
    if(source.topology_summary){const summary=document.createElement('p');summary.className='medical-map-warning';summary.textContent=source.topology_summary;root.querySelector('.medical-map-toolbar').after(summary);}
    if(d.regional_layers&&c.canPlay){
      c.playSpeed=1;c.playWindow='all';c.playTime=d.regional_layers.frames[0]?.time_hours??0;
      const controls=document.createElement('div');controls.className='regional-playback-tools';controls.innerHTML='<button type="button" data-play-reset>重置</button><label>回放范围 <select data-play-window aria-label="回放范围"><option value="all">全程</option><option value="emergency24">应急初期24小时</option></select></label><label>速度 <select data-play-speed aria-label="回放速度"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label><span data-play-time></span>';root.querySelector('.network-recovery-controls').append(controls);
      const note=document.createElement('p');note.className='regional-playback-note';note.textContent=hasRegionalResources(c)?'调度行程仿真回放，非实时 GPS。长时域可选择“应急初期24小时”查看早期派遣，再切回全程查看恢复。每段在1×速度下约30秒；供电、库存及事件在保存时刻更新，连续时刻只移动可核验行程中的队伍和车辆。':'按当前所选策略回放保存时刻的供电状态与人口影响。每段在1×速度下约30秒；分区供电状态在保存时刻更新。';root.querySelector('.network-recovery-controls').after(note);
      root.querySelector('[data-play-reset]').addEventListener('click',()=>resetRegionalPlayback(c));root.querySelector('[data-play-speed]').addEventListener('change',event=>{const speed=Number(event.target.value);if([.5,1,2,4].includes(speed))c.playSpeed=speed;});
      root.querySelector('[data-play-window]').addEventListener('change',event=>setRegionalPlaybackWindow(c,event.target.value));
    }
    if(d.system==='power_system'&&(d.nodes.length||d.links.length)){
      const counts=new Map();for(const item of d.nodes){const role=powerRole(item);counts.set(role,(counts.get(role)||0)+1);}for(const item of d.links)if(item.asset_kind==='transformer')counts.set('transformer',(counts.get('transformer')||0)+1);
      const key=document.createElement('div');key.className='power-map-key';key.setAttribute('role','group');key.setAttribute('aria-label','电网设施图例');
      key.innerHTML=Object.keys(POWER_ROLES).filter(role=>counts.has(role)).map(role=>`<span class="power-map-key-item">${powerSymbol(role,'#165480').image}<span>${POWER_ROLES[role]} <b>${counts.get(role)}</b></span></span>`).join('')+'<span class="power-map-key-item"><i class="power-line-sample"></i>已录入线路路径</span><span class="power-map-key-item"><i class="power-line-sample power-line-sample-dashed"></i>连接关系示意</span>';
      root.querySelector('.medical-map-toolbar').after(key);
    }
    const sceneControls=document.createElement('div');sceneControls.className='medical-map-control-group network-scene-controls';
    sceneControls.innerHTML='<button type="button" data-scene-retry title="仅重新加载地图，不重新运行评估" hidden>重新加载三维</button>';
    root.querySelector('.medical-map-toolbar').append(sceneControls);
    installRegionalControls(c);
    installGridViewControl(c);
    installEngineeringBasemapControl(c);
    c.scenePolicy=scenePolicy(c);
    const viewNote=document.createElement('p');viewNote.className='network-scene-view-note';viewNote.setAttribute('data-scene-view-note','');
    root.querySelector('.network-recovery-controls').after(viewNote);
    sceneViewState(c,c.scenePolicy.use3d?'preparing':'wide');
    root.querySelector('[data-scene-retry]').onclick=()=>{if(!c.sandboxPending)resetSandbox(c);};
    if(d.playback?.message||(!c.canPlay&&d.frames.length)){
      const notice=document.createElement('p');notice.className='medical-map-warning';notice.setAttribute('role','status');
      notice.textContent=!d.regional_layers&&c.options.showRecovery===false&&d.playback?.can_play?'当前查看震后初始状态；切换“恢复方案”可播放已保存的恢复过程。':d.playback?.message||'本轮只保存了一个状态，没有可播放的时间变化。';
      root.querySelector('.network-recovery-controls').after(notice);
    }
    c.metric=hasLoss&&Object.hasOwn(LOSS_METRICS,c.options.metric)?c.options.metric:d.system==='building_complex'&&available.damage?'damage':available.function?'function':available.damage?'damage':'geometry';root.querySelector('[data-metric]').value=c.metric;
    root.querySelector('[data-metric]').onchange=e=>{c.metric=e.target.value;if(lossMetric(c)){stopClock(c.root);c.index=-1;}update(c);};root.querySelector('[data-fit]').onclick=()=>fit(c);
    if(window.MapFullscreen?.mount)c.fullscreen=window.MapFullscreen.mount(root.querySelector('.engineering-network-map'),{button:root.querySelector('[data-full]'),language:c.options.language,onResize:()=>resize(c)});
    else root.querySelector('[data-full]').onclick=e=>{root.classList.toggle('network-expanded');e.target.textContent=root.classList.contains('network-expanded')?'收起地图':'展开地图';setTimeout(()=>{if(current(c))resize(c);},0);};
    root.querySelector('[data-initial]').onclick=()=>{if(d.regional_layers){resetRegionalPlayback(c);return;}stopClock(root);c.index=-1;update(c);};
    if(!c.hasResults){root.querySelector('[data-initial]').hidden=true;root.querySelectorAll('[data-metric] option:not([value="geometry"])').forEach(option=>option.disabled=true);}
    root.querySelectorAll('[data-object] option').forEach(option=>{if(option.value){const [kind,index]=option.value.split(':');const item=(kind==='n'?d.nodes:d.links)[Number(index)];if(item.name&&item.name!==String(item.id))option.textContent+=` · ${item.id}`;}});
    if(areaOnly){root.querySelector('[data-metric]').parentElement.hidden=true;root.querySelector('[data-object]').parentElement.hidden=true;root.querySelector('[data-selection]').innerHTML='<h3>点击供电分区查看人口影响</h3><p>查看所选策略、本时刻的供电状态与人口估计。</p>';root.querySelector('[data-fit]').textContent='显示全部分区';root.querySelector('.medical-map-map-footer').lastElementChild.textContent='供电分区与人口影响 · WGS84';}
    const nodeToggle=document.createElement('label');nodeToggle.innerHTML='<input type="checkbox" checked data-network-layer="nodes"> '+(d.system==='building_complex'?'显示建筑':'显示节点');if(!areaOnly)root.querySelector('.medical-map-control-group').append(nodeToggle);
    nodeToggle.querySelector('input').onchange=e=>{if(d.regional_layers)setMapLayerVisibility(c,'nodes',e.target.checked);else{c.showNodes=e.target.checked;filterLayers(c);}};
    c.showJunctions=true;
    if(d.system==='power_system'){
      const controls=root.querySelector('.medical-map-control-group');
      if(d.links.some(x=>x.voltage_kv)){
        const voltage=document.createElement('select');voltage.setAttribute('aria-label','电网电压层级');voltage.innerHTML='<option value="">全部电压层级</option>'+[...new Set(d.links.map(x=>x.voltage_kv).filter(Boolean))].sort((a,b)=>b-a).map(v=>`<option value="${Number(v)}">${Number(v)} kV</option>`).join('');controls.append(voltage);voltage.onchange=e=>{c.voltage=e.target.value;filterLayers(c);};
      }
      for(const [label,key,checked,available] of [['显示线路连接点','showJunctions',true,d.nodes.some(item=>powerRole(item)==='junction')],['显示站内接入','showConnections',true,d.links.some(item=>item.display_connections?.length)]]){if(!available)continue;const el=document.createElement('label');el.innerHTML=`<input type="checkbox" ${checked?'checked':''}> ${label}`;controls.append(el);el.querySelector('input').onchange=e=>{c[key]=e.target.checked;filterLayers(c);};}
    }
    filterLayers(c);
    root.querySelector('[data-time-slider]')?.addEventListener('input',e=>{stopClock(root);c.index=Number(e.target.value);if(d.regional_layers){c.playPositions=new Map();c.playTime=regionalFrame(c)?.time_hours??0;}update(c);if(d.regional_layers)updateRegionalMotion(c,c.playTime);});
    root.querySelector('[data-play]')?.addEventListener('click',e=>{if(c.timer||c.playing){stopClock(root);return;}if(d.regional_layers){startRegionalPlayback(c);return;}if(c.index>=d.frames.length-1)c.index=-1;e.target.textContent='暂停';c.timer=setInterval(()=>{if(!visible(c)){pause(root);return;}c.index++;update(c);if(c.index>=d.frames.length-1)stopClock(root);},Math.max(180,Math.min(1200,8000/Math.max(1,d.frames.length-1))));});
    root.querySelector('[data-object]').onchange=e=>{const [kind,id]=e.target.value.split(':');const item=(kind==='n'?d.nodes:d.links)[Number(id)];if(!item)return;const found=c.layers.find(l=>l.item===item);selection(c,item,found?.group||(kind==='n'?'node':'pipe'));if(found&&c.map&&!c.sandbox){if(found.layer.getLatLng)c.map.panTo(found.layer.getLatLng());else c.map.fitBounds(found.layer.getBounds(),{maxZoom:17});}};
    root.querySelector('[data-export]').onclick=()=>{const features=exportFeatures(c);const url=URL.createObjectURL(new Blob([JSON.stringify({type:'FeatureCollection',metadata:{coordinate_system:'WGS84',source,session_id:d.session_id,iteration:d.iteration,map_view:d.map_view||c.options.view||null,strategy_id:d.strategy_id||c.options.strategy||null,dataset_version_id:d.dataset_version_id,dataset_id:d.dataset_id,revision:d.revision,visualization_only:d.visualization_only,limitations:d.limitations,replay_time_hours:c.playTime??null,saved_time_hours:regionalFrame(c)?.time_hours??null,time:d.frames[c.index]?.time??null,time_unit:d.frames[c.index]?.time_unit??null},features},null,2)],{type:'application/geo+json'}));const a=document.createElement('a');a.href=url;a.download='engineering-network.geojson';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
    c.layout=window.NetworkMapLayout?.mount(root.querySelector('.engineering-network-map'),{language:c.options.language,onResize:()=>resize(c)});
    if(!observeVisibility(c))return;update(c);restoreMapState(c);resize(c);if(d.regional_layers)updateRegionalMotion(c,c.playTime??regionalFrame(c)?.time_hours??0);if(c.options.selection)select(root,c.options.selection);
  }
  return {mount,destroy,pause,select,captureState,resize(root){const c=mounts.get(root);if(c)resize(c);}};
})();
