/* Rescity's unchanged cartography, supplied with this platform's saved outputs.
 * This adapter maps field names and joins saved states to their saved geometry.
 * It does not execute damage, power-flow, recovery or exposure calculations. */
(() => {
  'use strict';
  const nativeMap=window.EngineeringNetworkMap,nativeImpact=window.PowerImpactView;
  if(!nativeMap||!nativeImpact)throw new Error('Rescity map dependencies must load before the saved-data adapter.');
  const sceneCache=new Map(),mapRequests=new WeakMap(),impactRequests=new WeakMap();
  const list=value=>Array.isArray(value)?value:[];
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const profile={profile:'core',regional_restoration_enabled:false};
  const viewNotes={overview:'仅显示震后初始电网及供电分区，不加载应急资源和后续恢复时刻。',
    grid:'仅显示震后初始电网受损与供电状态，不加载人口分区和应急资源。',
    impact:'仅显示所选策略保存的供电分区与人口影响，不加载电网设施和应急资源。',
    recovery:'显示所选基础恢复策略保存的电网与供电分区恢复过程。'};
  const timeHours=frame=>finite(frame?.time_hours)?frame.time_hours:finite(frame?.time_day)?frame.time_day*24:null;

  async function loadScene(options={}) {
    const iteration=Number(options.iteration||1),id=String(options.sessionId||'');
    if(!id||!Number.isSafeInteger(iteration)||iteration<1)throw new Error('地图缺少已保存的任务和计算轮次。');
    const key=id+':'+iteration+':'+String(options.resultRevision||'');
    if(!sceneCache.has(key)) {
      const promise=fetch(`/api/sessions/${encodeURIComponent(id)}/power-scene?iteration=${iteration}`,{cache:'no-store',credentials:'same-origin'})
        .then(async response=>{const value=await response.json();if(!response.ok)throw new Error(value.error||value.detail||'地图保存数据暂不可用');if(Number(value.iteration)!==iteration)throw new Error('地图数据与选中计算轮次不一致');return value;})
        .catch(error=>{sceneCache.delete(key);throw error;});
      sceneCache.set(key,promise);
      while(sceneCache.size>3)sceneCache.delete(sceneCache.keys().next().value);
    }
    return sceneCache.get(key);
  }

  function savedGridFrame(frame) {
    return {time:finite(frame.time_day)?frame.time_day:timeHours(frame)/24,time_unit:'天',time_hours:timeHours(frame),
      node:{function:frame.node_function||{},damage:frame.node_damage||{}},
      pipe:{function:frame.branch_function||{},damage:frame.branch_damage||{}}};
  }
  function baseNetwork(scene,options={}) {
    const record=scene.case||{},network=scene.network||{};
    const damage=item=>item.damage_label??(typeof item.damage==='object'?item.damage.state:item.damage)??item.damage_state??null;
    return {schema_version:'engineering.network-map.v1',system:'power_system',session_id:options.sessionId,iteration:Number(options.iteration||scene.iteration||1),
      title:record.title,city:record.city,dataset_id:record.dataset_id,dataset_version_id:record.version_id,revision:record.revision,
      coordinate_system:network.coordinate_system||record.coordinate_system||'WGS84',source:network.source||{title:record.title,note:record.source_note},
      limitations:list(record.assumptions),power_profile:profile,
      nodes:list(network.nodes).map(item=>({...item,damage:damage(item)})),
      links:list(network.edges||network.links).map(item=>({...item,damage:damage(item),
        coordinates:item.geometry?.type==='LineString'?item.geometry.coordinates:item.coordinates,
        from_node:item.from_node??item.source,to_node:item.to_node??item.target})),frames:[]};
  }
  function savedAreaFeature(area,state={}) {
    const properties={...area.properties,...state,impact_model:true};
    // Ratios and exposure are saved outputs. These aliases only match the
    // original renderer's vocabulary and preserve unknown values.
    if(Object.hasOwn(state,'supply_ratio')) {
      properties.served_ratio=state.supply_ratio;
      properties.unserved_ratio=finite(state.supply_ratio)?1-state.supply_ratio:null;
    }
    if(state.status) {
      properties.full_outage_population=state.status==='full_outage'?properties.population:state.status==='unknown'?null:0;
      properties.partial_outage_population_equivalent=state.status==='partial_outage'?state.affected_population_equivalent:state.status==='unknown'?null:0;
      properties.affected_population=state.affected_population_equivalent;
      properties.affected_population_any_outage=state.status==='grid_supplied'?0:state.status==='unknown'?null:properties.population;
    }
    if(area.coverage_feature)properties.coverage_gap=true;
    return {id:area.id,name:area.name,kind:area.kind||'zone',geometry_ref:area.id,properties};
  }
  function impactArtifact(scene,options={}) {
    const impact=scene.impact||{},recovery=scene.recovery||{},network=baseNetwork(scene,options),areas=list(impact.areas);
    const geometry_by_id=Object.fromEntries(areas.filter(area=>area.geometry).map(area=>[area.id,area.geometry]));
    const coverage_features=areas.filter(area=>area.coverage_feature).map(area=>savedAreaFeature(area));
    const mapped=areas.filter(area=>!area.coverage_feature);
    const strategies=list(impact.strategies).map(strategy=>{
      const grid=list(recovery.strategies).find(row=>row.id===strategy.id);
      return {...strategy,network,grid_frames:list(grid?.frames).map(savedGridFrame),
        frames:list(strategy.frames).map(frame=>({...frame,features:mapped.map(area=>savedAreaFeature(area,frame.area_states?.[area.id]||{})),unlocated:[]}))};
    });
    return {...impact,schema_version:'engineering.power-impact.v1',city:scene.case?.city,title:impact.title||scene.case?.title,
      session_id:options.sessionId,iteration:Number(options.iteration||scene.iteration||1),source_run_id:scene.run_id,
      power_profile:profile,calculation:{...scene.scenario,...recovery.parameters,damage_mode:scene.scenario?.power_damage_mode},
      network,geometry_by_id,coverage_features,strategies,recommended_strategy:impact.recommended_strategy||recovery.recommended_strategy,
      assumptions:list(impact.assumptions),warnings:[]};
  }
  function networkData(scene,options={}) {
    const recovery=scene.recovery||{},all=list(recovery.strategies),requested=String(options.strategy||'').replace(/^impact:/,'');
    const strategy=all.find(row=>String(row.id)===requested)||all.find(row=>row.id===recovery.recommended_strategy)||all[0];
    const initialOnly=options.showRecovery===false||['overview','grid'].includes(options.view);
    let data;
    if(options.view!=='grid'&&list(scene.impact?.areas).length&&list(scene.impact?.strategies).length) {
      data=nativeImpact.toNetworkMap(impactArtifact(scene,options),strategy?.id,{view:options.view||'overview'});
    } else {
      data={...baseNetwork(scene,options),frames:list(strategy?.frames).map(savedGridFrame),
        playback:{can_play:list(strategy?.frames).length>1}};
    }
    data={...data,map_view:options.view||'overview',map_view_note:viewNotes[options.view||'overview'],strategy_id:strategy?.id,power_profile:profile};
    if(initialOnly) {
      data.frames=list(data.frames).slice(0,1);
      if(data.regional_layers)data.regional_layers={...data.regional_layers,frames:list(data.regional_layers.frames).slice(0,1)};
      data.playback={can_play:false,message:'这里只展示本轮震后初始状态；恢复过程在“恢复方案”中查看。'};
    }
    return data;
  }
  function showFailure(root,error,retry) {
    root.innerHTML=`<div class="medical-map-state">${escape(error.message||'地图保存数据暂不可用')}<button type="button" data-reference-map-retry>重新加载地图</button></div>`;
    root.querySelector('[data-reference-map-retry]')?.addEventListener('click',retry);
  }
  function indexedRegionalData(data) {
    const regional=data?.regional_layers;
    if(!regional||Object.keys(regional.feature_by_ref||{}).length)return data;
    const feature_by_ref={};
    const frames=list(regional.frames).map((frame,index)=>{
      const feature_refs=list(frame.features).map((feature,position)=>{
        const ref=`saved:${index}:${position}:${feature.id}`;feature_by_ref[ref]=feature;return ref;
      });
      const value={...frame,feature_refs};delete value.features;return value;
    });
    return {...data,regional_layers:{...regional,feature_by_ref,frames}};
  }
  function mountMap(root,options={}) {
    if(!root)return;
    if(options.data){mapRequests.delete(root);nativeMap.mount(root,{...options,data:indexedRegionalData(options.data)});return;}
    const request={};mapRequests.set(root,request);
    root.innerHTML='<div class="medical-map-state">正在加载本轮网络地图…</div>';
    loadScene(options).then(scene=>{
      if(mapRequests.get(root)!==request||!root.isConnected)return;
      nativeMap.mount(root,{...options,powerProfile:options.powerProfile||profile,data:indexedRegionalData(networkData(scene,options))});
    }).catch(error=>{if(mapRequests.get(root)===request&&root.isConnected)showFailure(root,error,()=>mountMap(root,options));});
  }
  function mountImpact(root,artifact,options={}) {
    if(!root)return;
    if(list(artifact?.strategies).some(strategy=>list(strategy.frames).some(frame=>Array.isArray(frame.features)))){
      impactRequests.delete(root);nativeImpact.mount(root,artifact,options);return;
    }
    const request={};impactRequests.set(root,request);
    root.innerHTML='<div class="medical-map-state">正在加载本轮停电范围与人口保存结果…</div>';
    loadScene(options).then(scene=>{
      if(impactRequests.get(root)!==request||!root.isConnected)return;
      nativeImpact.mount(root,impactArtifact(scene,options),{...options,powerProfile:options.powerProfile||profile,
        savedSceneIdentity:[scene.run_id,scene.iteration,scene.case?.dataset_fingerprint].join(':')});
    }).catch(error=>{if(impactRequests.get(root)===request&&root.isConnected)showFailure(root,error,()=>mountImpact(root,artifact,options));});
  }
  window.EngineeringNetworkMap={...nativeMap,mount:mountMap,destroy(root){mapRequests.delete(root);nativeMap.destroy(root);}};
  window.PowerImpactView={...nativeImpact,mount:mountImpact,destroy(root){impactRequests.delete(root);nativeImpact.destroy(root);},suspend(root){impactRequests.delete(root);nativeImpact.suspend(root);}};
  const roots=scope=>{
    const selector='[data-network-map],[data-approved-map],[data-schedule-map],[data-power-impact-map],[data-power-regional-map]';
    return [...(scope?.matches?.(selector)?[scope]:[]),...listScope(scope,selector)];
  };
  function listScope(scope,selector){return [...(scope?.querySelectorAll?.(selector)||[])];}
  window.ReferencePowerMaps={loadScene,networkData,impactArtifact,
    resize(scope=document){for(const root of roots(scope))nativeMap.resize?.(root);},
    pause(scope=document){for(const root of roots(scope))nativeMap.pause(root);},
    destroy(scope=document){for(const root of roots(scope))window.EngineeringNetworkMap.destroy(root);}};
})();
