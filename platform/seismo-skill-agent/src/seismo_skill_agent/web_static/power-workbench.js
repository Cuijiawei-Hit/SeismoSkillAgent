/* Power assessment presentation. All numbers come from saved, approved outputs. */
(function () {
  'use strict';
  const states = new WeakMap();
  const tableStates = new WeakMap();
  const topicMemory = new Map();
  const sceneCache = new Map();
  let config = {};
  const e = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const zh = () => config.language?.() !== 'en-US';
  const t = (a,b) => zh() ? a : b;
  const number = (v,d=1) => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString(zh()?'zh-CN':'en',{maximumFractionDigits:d});
  const percent = v => v === null || v === undefined ? '—' : number(Number(v)*100,1)+'%';
  const rows = v => Array.isArray(v) ? v : [];
  const strategyName = id => ({ga:t('遗传算法搜索','Genetic algorithm'),importance:t('功能增益排序','Functional gain'),id_order:t('编号顺序基准','ID baseline')}[id] || id || '—');
  const safeURL = raw => {if(typeof raw!=='string'||!raw.trim())return null;try {const u=new URL(raw,location.origin);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}};
  const statusName = value => ({succeeded:t('已确认','Accepted'),awaiting_result_review:t('等待结果审查','Awaiting review'),awaiting_approval:t('等待执行批准','Awaiting approval'),executing:t('正在计算','Computing'),analyzing:t('正在理解任务','Analyzing'),processing_feedback:t('正在处理反馈','Processing feedback')}[value] || t('进行中','In progress'));
  function primary(summary) {
    const recovery=summary?.recovery || {};
    return rows(recovery.strategies).find(s=>s.id===(recovery.recommended_strategy||summary?.primary_strategy)) || rows(recovery.strategies).find(s=>s.id==='ga') || rows(recovery.strategies)[0] || {};
  }
  function selectedStrategy(summary, id) {
    return rows(summary?.recovery?.strategies).find(strategy=>strategy.id===id) || primary(summary);
  }
  function impact(summary, strategyId) {
    const value=summary?.impact || {};
    return rows(value.strategies).find(s=>s.id===(strategyId||value.recommended_strategy)) || rows(value.strategies)[0] || value;
  }
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const frameDays = frame => finite(frame?.time_hours) ? frame.time_hours/24 : finite(frame?.time_day) ? frame.time_day : finite(frame?.time) ? frame.time/(/小时|hour|^h$/.test(frame.time_unit||'')?24:1) : 0;
  function scheduleRows(summary, strategy) {
    const names=new Map(rows(summary.network?.nodes).map(node=>[String(node.id),node.name]));
    return rows(strategy?.schedule).map(row=>({...row,object_id:row.key||`${row.group==='node'?'node':'pipe'}:${row.id}`,name:row.group==='node'?(names.get(String(row.id))||t('节点 ','Node ')+row.id):t('支路 ','Branch ')+row.id}));
  }
  function firstRepairs(summary, strategy) {
    const ordered=scheduleRows(summary,strategy).filter(row=>finite(row.start_day)).sort((a,b)=>a.start_day-b.start_day||Number(a.team)-Number(b.team)||Number(a.rank)-Number(b.rank));
    const teams=new Set();
    return ordered.filter(row=>{const team=String(row.team);if(teams.has(team))return false;teams.add(team);return true;}).slice(0,4);
  }
  function repairState(row, day) {
    return !finite(row.start_day)||!finite(row.end_day)?t('未记录','Not recorded'):day>=row.end_day?t('已完成','Complete'):day>=row.start_day?t('修复中','In progress'):t('待开工','Pending');
  }
  function context(data,summary) {return {...(data?.plan?.request_payload||{}),...summary};}
  function metric(label,value,unit,note,tone='') {
    return `<div class="pw-metric ${tone}"><span>${e(label)}</span><strong>${e(value)}${unit?`<small>${e(unit)}</small>`:''}</strong><p>${e(note||'')}</p></div>`;
  }
  function metrics(summary) {
    const f=summary?.function||{}, d=summary?.damage||{}, im=impact(summary), c=im.coverage||summary?.impact?.coverage||{};
    return `<div class="pw-metrics">${metric(t('震后供电功率','Post-event supply'),number(f.post_supply_mw),'MW',t(`震前基准 ${number(f.pre_supply_mw)} MW`,`Pre-event ${number(f.pre_supply_mw)} MW`),'supply')}${metric(t('受损修复对象','Damaged repair objects'),number(d.damaged_count,0),t('个','assets'),t(`${number(d.damaged_node_count,0)} 节点 · ${number(d.damaged_branch_count,0)} 支路`,`${number(d.damaged_node_count,0)} nodes · ${number(d.damaged_branch_count,0)} branches`),'damage')}${metric(t('初始失供区域人口','Initial outage population'),number(im.initial_summary?.full_outage_population,0),t('人','people'),t('有供电关联分区内的空间估计','Spatial estimate in mapped supply areas'),'population')}${metric(t('人口关联覆盖率','Population mapping coverage'),percent(c.population_coverage_ratio),'',t(`未映射人口 ${number(c.unmapped_population,0)} 人`,`Unmapped population ${number(c.unmapped_population,0)}`),'coverage')}</div>`;
  }
  function brief(summary) {
    const f=summary?.function||{}, s=primary(summary), params=summary?.recovery?.parameters||{}, im=impact(summary), coverage=im.coverage||{};
    const result=[];
    if(f.post_supply_mw!==undefined)result.push(t(`本轮震前供电为 ${number(f.pre_supply_mw)} MW，震后为 ${number(f.post_supply_mw)} MW，供电保有率 ${percent(f.function_ratio)}。`,`Pre-event supply is ${number(f.pre_supply_mw)} MW; post-event supply is ${number(f.post_supply_mw)} MW (${percent(f.function_ratio)} retained).`));
    if(im.initial_summary?.full_outage_population!==undefined)result.push(t(`已关联分区内约 ${number(im.initial_summary.full_outage_population,0)} 人处于初始失供范围；另有 ${number(coverage.unmapped_population,0)} 人未建立电网关联，其影响保持未知。`,`Initial full-outage areas contain approximately ${number(im.initial_summary.full_outage_population,0)} people. Impact remains unknown for ${number(coverage.unmapped_population,0)} people without a network association.`));
    if(s.id)result.push(t(`保存的${strategyName(s.id)}方案采用 ${number(params.team_count,0)} 支工程队，达到 ${percent(params.target_function)} 供电目标需 ${number(s.target_time_days)} 天，全部修复需 ${number(s.total_days)} 天。`,`The saved ${strategyName(s.id)} plan uses ${number(params.team_count,0)} crews, reaches ${percent(params.target_function)} supply at day ${number(s.target_time_days)}, and completes repairs at day ${number(s.total_days)}.`));
    return result;
  }
  function evidenceHTML(data) {
    const evidence=rows(data.knowledge_evidence), text=data.current_interpretation||data.final_answer||'';
    if(!evidence.length)return `<section class="pw-evidence"><h3>${t('检索依据','Evidence')}</h3><p>${t('本轮尚无检索证据。','No evidence has been retrieved for this round.')}</p></section>`;
    const groups=new Map();
    evidence.forEach(item=>{const key=item.source_path||item.source_url||item.title;const group=groups.get(key)||[];group.push(item);groups.set(key,group);});
    return `<section class="pw-evidence" id="pw-evidence"><header><div><span class="pw-eyebrow">${t('检索与证据','RETRIEVAL & EVIDENCE')}</span><h3>${t('本轮知识依据','Evidence for this assessment')}</h3></div><span class="pw-count">${groups.size} ${t('份资料','documents')} · ${evidence.length} ${t('个片段','excerpts')}</span></header><p class="pw-help">${t('证据用于方法解释与适用条件核对。工程数值来自保存的模型输出。','Evidence supports method interpretation and applicability checks. Engineering values come from saved model outputs.')}</p><input class="pw-evidence-search" type="search" aria-label="${t('搜索本轮证据','Search this round’s evidence')}" placeholder="${t('按题名或摘录搜索…','Search title or excerpt…')}"><div class="pw-evidence-list">${[...groups.values()].map((items,index)=>{const first=items[0],cited=items.some(item=>text.includes(item.evidence_id)),link=safeURL(first.source_url),catalog=items.every(item=>item.retrieval_scores?.catalog_only>0||/(?:\.{5,}|…{3,})\s*\d+/.test(item.snippet||''));return `<details class="pw-source" data-source-search="${e(items.map(i=>i.title+' '+i.snippet).join(' ').toLowerCase())}" id="source-${e(first.evidence_id)}"><summary><span class="pw-source-index">${String(index+1).padStart(2,'0')}</span><span><strong>${e(first.title)}</strong><small>${e(first.source_type==='paper'?t('研究文献','Research paper'):t('规范与在线资料','Standard / online source'))} · ${catalog?t('目录摘录','Catalog excerpt'):t('检索摘录','Retrieved excerpt')} ${first.document_version?'· '+e(first.document_version):''}</small></span><span class="pw-source-state ${cited?'cited':''}">${cited?t('已引用','Cited'):t('已检索','Retrieved')}</span></summary><div class="pw-source-body">${items.map(item=>`<article id="evidence-${e(item.evidence_id)}"><div class="pw-excerpt-meta"><code>${e(item.evidence_id)}</code><span>${t('检索相关度','Retrieval score')} ${number(item.score,3)}</span>${item.locator?`<span>${e(item.locator)}</span>`:''}</div><blockquote>${e(item.snippet||t('未保存正文摘录。','No excerpt was saved.'))}</blockquote>${item.citation?`<p class="pw-help">${e(item.citation)}</p>`:''}</article>`).join('')}${link?`<a class="pw-text-link" href="${e(link)}" target="_blank" rel="noopener noreferrer">${t('打开原始来源','Open original source')} ↗</a>`:`<p class="pw-help">${t('本地文献摘录；未提供可核验的PDF页码或在线原件链接。','Local document excerpt; no verified PDF page or online original link is available.')}</p>`}</div></details>`;}).join('')}</div><p class="pw-evidence-empty" hidden>${t('没有匹配的证据片段。','No matching evidence excerpts.')}</p></section>`;
  }
  function bindEvidence(host) {
    const targets=new Map();
    host.querySelectorAll('.pw-source-body article').forEach(article=>{
      const id=article.dataset.evidenceId || article.id.replace(/^evidence-/, '');
      article.dataset.evidenceId=id;
      article.id='evidence-'+host.id+'-'+id;
      const card=article.closest('.pw-source');if(card)card.id='source-'+host.id+'-'+id;
      targets.set(id,article);
    });
    host.querySelectorAll('.markdown').forEach(markdown=>{
      const walker=document.createTreeWalker(markdown,NodeFilter.SHOW_TEXT),matches=[];
      while(walker.nextNode()) {const node=walker.currentNode;if(!node.parentElement.closest('a,button,code,pre')&&/\[KB:[A-Za-z0-9._-]+\]/.test(node.textContent))matches.push(node);}
      for(const node of matches){const value=node.textContent,fragment=document.createDocumentFragment();let end=0;for(const match of value.matchAll(/\[KB:([A-Za-z0-9._-]+)\]/g)){fragment.append(value.slice(end,match.index));const target=targets.get(match[1]);if(target){const button=document.createElement('button');button.type='button';button.className='pw-citation';button.textContent=t('查看引用依据','View cited evidence');button.addEventListener('click',()=>{target.closest('details').open=true;target.scrollIntoView({behavior:'smooth',block:'center'});});fragment.append(button);}else fragment.append(match[0]);end=match.index+match[0].length;}fragment.append(value.slice(end));node.replaceWith(fragment);}
    });
    host.querySelector('.pw-evidence-search')?.addEventListener('input',event=>{let shown=0;const query=event.target.value.trim().toLowerCase();host.querySelectorAll('[data-source-search]').forEach(el=>{el.hidden=!el.dataset.sourceSearch.includes(query);if(!el.hidden)shown++;});const empty=host.querySelector('.pw-evidence-empty');if(empty)empty.hidden=shown>0;});
    host.querySelectorAll('.markdown a').forEach(link=>{const href=link.getAttribute('href')||'';if(!href.startsWith('#evidence-'))return;link.addEventListener('click',event=>{event.preventDefault();const target=document.getElementById(href.slice(1));if(target){target.closest('details')?.setAttribute('open','');target.scrollIntoView({behavior:'smooth',block:'center'});target.classList.add('pw-highlight');}});});
  }
  function conversation(host,data,summary,iteration,{followUps='',markdown='',working='',error=''}={}) {
    const c=context(data,summary), lines=brief(summary), has=!!summary;
    host.innerHTML=`<div class="pw-question"><span class="pw-avatar">${t('我','ME')}</span><div><small>${t('评估问题','Assessment question')}</small><p>${e(data.user_message)}</p></div></div><article class="pw-answer"><header><span class="pw-agent-icon">⚡</span><div><strong>PowerSkillAgent</strong><small>${t('奥克兰电网 · 工程评估','Auckland grid · engineering assessment')}</small></div><span class="pw-status">${e(statusName(data.status))}</span></header>${has?`<div class="pw-case-line"><span>PGA <strong>${number(c.pga_g,2)}g</strong></span><span>${number(c.node_count,0)} ${t('节点','nodes')} / ${number(c.branch_count,0)} ${t('支路','branches')}</span><span>${number(c.team_count??c.recovery?.parameters?.team_count,0)} ${t('支工程队','crews')}</span><span>${t('第','Round')} ${number(iteration?.iteration||data.iteration||1,0)} ${t('轮','')}</span></div><h2>${t('供电、影响与恢复','Supply, impact and recovery')}</h2><div class="pw-answer-copy">${lines.map(line=>`<p>${e(line)}</p>`).join('')}</div>${metrics(summary)}<div class="pw-answer-actions"><button data-pw-open="results" class="pw-primary">${t('查看工程结果','Explore results')} <span>↗</span></button><button data-pw-open="spatial">${t('电网地图与恢复播放','Grid map & recovery')}</button><button data-pw-open="artifacts">${t('下载报告','Download report')}</button></div>`:working}<div class="pw-review-note">${data.status==='succeeded'?t('本轮结果已确认，计算版本和审查记录已保留。','This round has been accepted; calculation and review records are retained.'):t('工程计算须先批准，结果可继续审查或提交修改意见。','Approve the plan before computation, then review results or request revisions.')}</div></article>${markdown?`<details class="pw-interpretation"><summary><span>${t('完整结果解读与引用','Full interpretation & citations')}</span><small>${t('展开阅读','Expand')}</small></summary><div class="message-body markdown">${markdown}</div></details>`:''}${evidenceHTML(data)}${followUps}${error}`;
    host.querySelectorAll('[data-pw-open]').forEach(button=>button.addEventListener('click',()=>config.onTab?.(button.dataset.pwOpen)));
    // The citation IDs remain exactly those produced by the existing retrieval pipeline.
    host.querySelectorAll('.markdown code').forEach(code=>{const match=code.textContent.match(/^\[?KB:([^\]]+)\]?$/);if(!match)return;const id=match[1],target=document.getElementById('evidence-'+id);if(!target)return;const button=document.createElement('button');button.className='pw-citation';button.textContent=t('查看证据','View evidence');button.addEventListener('click',()=>{target.closest('details').open=true;target.scrollIntoView({behavior:'smooth',block:'center'});});code.after(button);});
    bindEvidence(host);
  }
  function curveHTML(strategies) {
    const curves=rows(strategies).filter(s=>rows(s.curve).length), palette=['#7b8798','#d89a37','#0d7b78'];
    if(!curves.length)return `<div class="pw-empty">${t('本轮未计算恢复曲线。','Recovery curves were not computed for this round.')}</div>`;
    const xmax=Math.max(1,...curves.flatMap(s=>s.curve.map(p=>Number(p.time)||0))),x=v=>48+Number(v)/xmax*696,y=v=>204-Number(v)*168;
    return `<div class="pw-chart"><div class="pw-chart-title"><h3>${t('三种策略的供电恢复','Supply recovery by strategy')}</h3><div>${curves.map((s,i)=>`<span><i style="background:${palette[i]}"></i>${e(strategyName(s.id))}</span>`).join('')}</div></div><svg viewBox="0 0 780 250" role="img" aria-label="${t('供电恢复策略对比曲线','Supply recovery strategy comparison')}">${[0,.25,.5,.75,1].map(v=>`<line x1="48" y1="${y(v)}" x2="744" y2="${y(v)}" stroke="#e4e9ee"/><text x="38" y="${y(v)+4}" text-anchor="end">${Math.round(v*100)}%</text>`).join('')}${curves.map((s,i)=>`<path d="${s.curve.map((p,j)=>`${j?'H':'M'} ${x(p.time)} ${j?'V':' '}${y(p.function)}`).join(' ')}" fill="none" stroke="${palette[i]}" stroke-width="2.6"/>`).join('')}<text x="48" y="230">0</text><text x="744" y="230" text-anchor="end">${number(xmax,0)} ${t('天','days')}</text></svg><p>${t('横轴：震后时间；纵轴：相对震前供电。各策略复用同一损伤情景。','Time since earthquake and supply relative to the intact baseline. All strategies share the same damage scenario.')}</p></div>`;
  }
  function tableHTML(columns,values,{id='table',search=true,onRow=false,pageSize=15}={}) {
    return `<div class="pw-data-table" data-table-id="${e(id)}" data-page-size="${pageSize}"><header><span>${number(values.length,0)} ${t('条记录','records')}</span>${search?`<input type="search" aria-label="${t('搜索表格','Search table')}" placeholder="${t('搜索名称或编号…','Search name or ID…')}">`:''}</header><div class="table-wrap"><table><thead><tr>${columns.map(col=>`<th scope="col">${e(col.label)}</th>`).join('')}</tr></thead><tbody>${values.map((row,i)=>`<tr data-row-index="${i}" ${onRow?`data-object-id="${e(row.object_id||row.id)}" tabindex="0" aria-selected="false"`:''} ${finite(row.start_day)?`data-start-day="${row.start_day}" data-end-day="${row.end_day}"`:''}>${columns.map(col=>`<td>${col.render?col.render(row):e(row[col.key]??'—')}</td>`).join('')}</tr>`).join('')}</tbody></table></div><footer><span data-page-label></span><div><button data-page="prev">${t('上一页','Previous')}</button><button data-page="next">${t('下一页','Next')}</button></div></footer></div>`;
  }
  function selectTableObject(host, objectId) {
    host.querySelectorAll('.pw-data-table').forEach(table=>tableStates.get(table)?.select(objectId));
  }
  function updateScheduleProgress(host, frame) {
    const day=frameDays(frame);
    host.querySelectorAll('[data-start-day]').forEach(row=>{
      const item={start_day:Number(row.dataset.startDay),end_day:Number(row.dataset.endDay)},active=day>=item.start_day&&day<item.end_day;
      row.classList.toggle('pw-active-repair',active);
      row.classList.toggle('pw-repair-complete',day>=item.end_day);
      const label=row.querySelector('.pw-repair-state');if(label)label.textContent=repairState(item,day);
    });
  }
  function bindTables(host,sceneHandle) {
    host.querySelectorAll('.pw-data-table').forEach(table=>{
      if(tableStates.has(table))return;
      let page=0,selected=null;
      const all=[...table.querySelectorAll('tbody tr')],size=Number(table.dataset.pageSize)||15,input=table.querySelector('input');
      const filtered=()=>{const query=(input?.value||'').toLowerCase();return all.filter(row=>row.textContent.toLowerCase().includes(query));};
      function paint() {
        const values=filtered();page=Math.min(Math.max(0,page),Math.max(0,Math.ceil(values.length/size)-1));
        all.forEach(row=>{row.hidden=true;const active=!!selected&&row.dataset.objectId===selected;row.classList.toggle('pw-selected-row',active);if(row.hasAttribute('aria-selected'))row.setAttribute('aria-selected',String(active));});
        values.slice(page*size,(page+1)*size).forEach(row=>row.hidden=false);
        table.querySelector('[data-page-label]').textContent=t(`第 ${page+1} / ${Math.max(1,Math.ceil(values.length/size))} 页 · 共 ${values.length} 条`,`Page ${page+1} / ${Math.max(1,Math.ceil(values.length/size))} · ${values.length} records`);
        table.querySelector('[data-page="prev"]').disabled=page===0;table.querySelector('[data-page="next"]').disabled=(page+1)*size>=values.length;
      }
      tableStates.set(table,{select(objectId){
        selected=objectId;const match=all.find(row=>row.dataset.objectId===objectId);
        if(match){if(!filtered().includes(match)&&input)input.value='';page=Math.floor(filtered().indexOf(match)/size);}
        paint();
      }});
      input?.addEventListener('input',()=>{page=0;paint();});
      table.querySelectorAll('[data-page]').forEach(button=>button.addEventListener('click',()=>{page+=button.dataset.page==='next'?1:-1;paint();}));
      table.querySelectorAll('[data-object-id]').forEach(row=>{
        const select=()=>{selected=row.dataset.objectId;paint();sceneHandle?.selectObject?.(selected);host.querySelector('.pw-scene-host')?.scrollIntoView({behavior:'smooth',block:'start'});};
        row.addEventListener('click',select);row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select();}});
      });
      paint();
    });
  }
  const topics=()=>[['overview',t('结论与建议','Overview')],['damage',t('设备损伤','Asset damage')],['grid',t('区域供电','Grid supply')],['impact',t('停电范围与人口','Outage & population')],['recovery',t('恢复方案','Recovery plans')],['sources',t('数据与依据','Data & evidence')]];
  function topicAvailable(id,summary) {
    return id==='overview'||id==='sources'||(id==='damage'&&summary.damage?.node_count!=null)||(id==='grid'&&summary.function?.post_supply_mw!=null)||(id==='impact'&&rows(summary.impact?.strategies).length>0)||(id==='recovery'&&rows(summary.recovery?.strategies).length>0);
  }
  function overviewHTML(summary,data={}) {
    const f=summary.function||{},s=primary(summary),p=summary.recovery?.parameters||{},im=impact(summary,s.id),coverage=im.coverage||{},initial=im.initial_summary||{},first=firstRepairs(summary,s);
    const headline=finite(f.function_ratio)?f.function_ratio<=0?t('震后初始失供，需分阶段推进电网恢复','Initial supply is lost; restore the grid in stages'):f.function_ratio<1?t('震后供电受限，先核对失供范围与修复顺序','Supply is constrained; review outage areas and repair order'):t('初始供电保持，继续核对设备损伤与恢复需求','Initial supply is retained; review damage and repair needs'):t('核对本轮设备、供电与恢复结果','Review this round’s damage, supply and recovery results');
    const gap=f.unserved_mw??(finite(f.pre_supply_mw)&&finite(f.post_supply_mw)?Math.max(0,f.pre_supply_mw-f.post_supply_mw):null);
    const objective=p.repair_objective==='target_time'?t('目标供电达标时间','time to target supply'):t('累计功能损失','cumulative function loss');
    const baseline=rows(summary.recovery?.strategies).find(row=>row.id==='id_order');
    const summaryText=finite(f.post_supply_mw)?t(`当前情景下供电由 ${number(f.pre_supply_mw)} MW 降至 ${number(f.post_supply_mw)} MW；已关联分区内约 ${number(initial.full_outage_population,0)} 人处于初始失供范围。`,`In this scenario supply changes from ${number(f.pre_supply_mw)} MW to ${number(f.post_supply_mw)} MW. Mapped initial full-outage areas contain approximately ${number(initial.full_outage_population,0)} people.`):t('各专题使用同一轮保存输出；先核对本轮结论，再查看地图和明细。','Each topic uses the same saved output. Review the findings before exploring maps and details.');
    const overviewMetric=(label,value,note)=>`<div class="pw-overview-metric"><span>${e(label)}</span><strong>${e(value)}</strong><small>${e(note)}</small></div>`;
    const firstSummary=first.length?t(`${first[0].name}${first.length>1?` 等 ${first.length} 处首项任务`:''}`,`${first[0].name}${first.length>1?` and ${first.length-1} other first tasks`:''}`):t('展开核对排程依据','Expand to review the saved schedule');
    const firstHTML=first.length?`<div class="pw-first-repairs">${first.map(row=>`<button type="button" data-pw-object="${e(row.object_id)}" title="${t('在地图定位修复对象','Locate repair asset on the map')}"><span>${t('队','Crew ')} ${number(row.team,0)}</span><strong>${e(row.name)}</strong><small>${number(row.start_day)}–${number(row.end_day)} ${t('天','days')} ↗</small></button>`).join('')}</div>`:`<p>${t('本轮未保存可定位的修复排程，先查看设备损伤明细。','No locatable repair schedule was saved in this round. Review the asset damage detail first.')}</p>`;
    return `<div class="pw-overview-lead"><section class="pw-overview-verdict"><div class="pw-verdict-head"><span class="pw-eyebrow">${t('核心结论','KEY FINDINGS')}</span><span class="pw-scope-badge">${number(summary.node_count,0)} ${t('节点','nodes')} · ${number(summary.branch_count,0)} ${t('支路','branches')}</span></div><h3>${headline}</h3><p class="pw-verdict-summary">${e(summaryText)}</p><div class="pw-overview-metrics">${overviewMetric(t('初始供电保有率','Initial supply retained'),percent(f.function_ratio),t(`震前 ${number(f.pre_supply_mw)} MW`,`Pre-event ${number(f.pre_supply_mw)} MW`))}${overviewMetric(t('初始供电缺口','Initial supply shortfall'),number(gap)+' MW',t('功率缺口；不等同于电量损失','Power shortfall, separate from energy loss'))}${overviewMetric(t('初始失供区域人口','Initial full-outage population'),number(initial.full_outage_population,0),t(`关联覆盖 ${percent(coverage.population_coverage_ratio)}`,`${percent(coverage.population_coverage_ratio)} mapping coverage`))}${overviewMetric(t('推荐方案目标达标','Recommended plan reaches target'),number(s.target_time_days)+t(' 天',' days'),t(`${percent(p.target_function)}供电目标 · 全部完工 ${number(s.total_days)} 天`,`${percent(p.target_function)} supply target · all repairs ${number(s.total_days)} days`))}</div><div class="pw-verdict-footer"><span>${t('同一网络、损伤情景与评价期','Same grid, damage scenario and evaluation horizon')}</span><button type="button" class="pw-text-link" data-pw-interpretation>${t('完整解读与引用','Full interpretation & citations')} ↗</button><button type="button" class="pw-text-link" data-pw-topic="sources">${t('核对数据依据','Review data & evidence')}</button></div></section><aside class="pw-action-plan"><header><div><span class="pw-eyebrow">${t('行动建议','NEXT ACTIONS')}</span><h3>${t('建议先做什么','What to review first')}</h3></div><small>${t('依据本轮输出','Saved outputs')} · ${e(statusName(data.status))}</small></header><details class="pw-priority-action"><summary><span>01</span><strong>${t('先核对首批修复对象','Review the first repair tasks')}<small class="pw-action-preview">${e(firstSummary)}</small></strong></summary><div><p>${t(`按保存的${strategyName(s.id)}方案，先核对下列各队首项任务，再确认通路、前置关系与可进场条件。`,`For the saved ${strategyName(s.id)} plan, review each crew’s first task, electrical path, prerequisites and access conditions.`)}</p>${firstHTML}<p class="pw-action-condition">${t(`落实条件：本轮输入 ${number(p.team_count??summary.team_count,0)} 支工程队、每日 ${number(p.daily_work_hours)} 小时。施工条件变更后应提交专家复核。`,`Conditions: ${number(p.team_count??summary.team_count,0)} crews and ${number(p.daily_work_hours)} hours per day. Submit changed work conditions for expert review.`)}</p><button type="button" class="pw-text-link" data-pw-topic="recovery">${t('查看完整排程','View the complete schedule')} ↗</button></div></details><details class="pw-priority-action"><summary><span>02</span><strong>${t('按既定目标比较恢复方案','Compare plans against the stated objective')}</strong></summary><div><p>${t(`本轮以${objective}为优化目标，保存的推荐方案为${strategyName(s.id)}。`,`This round optimizes ${objective}; the saved recommended plan is ${strategyName(s.id)}.`)}</p><p>${t(`推荐方案累计功能损失 ${number(s.loss_area_days,2)} 天${baseline?`，编号基准 ${number(baseline.loss_area_days,2)} 天`:''}；达到 ${percent(p.target_function)} 供电需 ${number(s.target_time_days)} 天。`,`The recommended plan has ${number(s.loss_area_days,2)} loss-area days${baseline?`, versus ${number(baseline.loss_area_days,2)} for the ID baseline`:''}; it reaches ${percent(p.target_function)} supply in ${number(s.target_time_days)} days.`)}</p><p class="pw-action-condition">${t('落实条件：区分累计损失、目标达标与全部完工。资源或目标调整后，经审查再计算。','Conditions: distinguish cumulative loss, target attainment and all-repair completion. Review changed resources or objectives before recomputing.')}</p><button type="button" class="pw-text-link" data-pw-topic="recovery">${t('对照恢复方案','Compare recovery plans')} ↗</button></div></details><details class="pw-priority-action"><summary><span>03</span><strong>${t('补核未映射范围与影响口径','Review unmapped exposure and scope')}</strong></summary><div><p>${t(`人口关联覆盖率为 ${percent(coverage.population_coverage_ratio)}，约 ${number(coverage.unmapped_population,0)} 人未建立电网关联。先核对分区来源与供电映射，再判断影响范围。`,`Population mapping coverage is ${percent(coverage.population_coverage_ratio)}; approximately ${number(coverage.unmapped_population,0)} people have no network association. Review source areas and supply mapping before judging impact.`)}</p><p class="pw-action-condition">${t('落实条件：人口为空间叠加估计，未映射范围保持未知；不将其计作已观测停电。','Conditions: population is a spatial estimate. Unmapped exposure remains unknown and is not counted as an observed outage.')}</p><button type="button" class="pw-text-link" data-pw-topic="impact">${t('查看影响范围','View outage impact')} ↗</button> <button type="button" class="pw-text-link" data-pw-topic="sources">${t('核对来源','Review sources')}</button></div></details></aside></div>`;
  }
  function sideHTML(topic,summary,state={}) {
    const s=selectedStrategy(summary,state.strategyId),im=impact(summary,s.id),f=summary.function||{},coverage=im.coverage||{},frame=state.frame,day=frameDays(frame),p=summary.recovery?.parameters||{};
    const curve=rows(s.curve).filter(point=>Number(point.time??point.time_day??0)<=day+1e-8).at(-1);
    const ratio=frame?.function_ratio??frame?.function??curve?.function??curve?.function_ratio??(frame?null:f.function_ratio);
    const supply=frame?.supply_mw??frame?.served_mw??(!frame||day===0?f.post_supply_mw:finite(ratio)&&finite(f.pre_supply_mw)?ratio*f.pre_supply_mw:null);
    const currentImpact=state.impactFrame?.summary||(!frame||day===0?im.initial_summary:{})||{};
    const entries=topic==='damage'?[[t('受损节点 / 支路','Damaged nodes / branches'),`${number(summary.damage?.damaged_node_count,0)} / ${number(summary.damage?.damaged_branch_count,0)}`],[t('初始供电保有率','Initial supply retained'),percent(f.function_ratio)],[t('供电目标','Supply target'),percent(p.target_function)]]:topic==='recovery'?[[t('目标达标','Target reached'),number(s.target_time_days)+t(' 天',' days')],[t('全部修复','All repairs'),number(s.total_days)+t(' 天',' days')],[t('当前供电保有率','Current supply retained'),percent(ratio)]]:[[t('当前供电','Current supply'),number(supply)+' MW'],[t('供电保有率','Supply retained'),percent(ratio)],[t('等效受影响人口','Equivalent affected population'),number(currentImpact.affected_population_equivalent??currentImpact.full_outage_population,0)]];
    return `<div class="pw-status-heading"><span class="pw-eyebrow">${t('当前保存时刻','SAVED EVENT')}</span><h3>${e(strategyName(s.id))} · ${number(day)} ${t('天','days')}</h3></div><dl>${entries.map(([label,value])=>`<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl><div class="pw-status-tail">${state.selectedObjectName?`<span class="pw-selected-object">${t('已选：','Selected: ')}${e(state.selectedObjectName)}</span>`:''}<span>${t('未映射','Unmapped')} ${number(coverage.unmapped_population,0)} ${t('人','people')}</span><button type="button" class="pw-text-link" data-pw-open="artifacts">${t('报告与明细','Reports & outputs')} ↗</button></div>`;
  }
  function topicHTML(topic,summary,data,state={}) {
    const net=summary.network||{}, nodes=rows(net.nodes), names=new Map(nodes.map(n=>[String(n.id),n.name])),recovery=summary.recovery||{},strategies=rows(recovery.strategies),s=selectedStrategy(summary,state.strategyId),im=impact(summary,s.id);
    const strategyCols=[{label:t('恢复策略','Strategy'),render:r=>`<strong>${e(strategyName(r.id))}</strong>`},{label:t(`${percent(summary.recovery?.parameters?.target_function)}目标 / 天`,'Target / days'),render:r=>number(r.target_time_days)},{label:t('全部完工 / 天','Complete / days'),render:r=>number(r.total_days)},{label:t('共同期韧性','Resilience'),render:r=>number(r.resilience_index,4)},{label:t('功能损失面积 / 天','Loss area / days'),render:r=>number(r.loss_area_days,2)}];
    if(topic==='overview')return `<section class="pw-section"><header><h3>${t('恢复策略对照','Strategy comparison')}</h3><span>${t('相同数据 · 相同损伤 · 相同评价期','Same data · damage · evaluation horizon')}</span></header>${tableHTML(strategyCols,strategies,{id:'strategy',search:false})}<div class="pw-notice">${t('达到供电目标与全部设备修复完成分别列报；遗传算法为给定预算内的搜索结果。','Target attainment and all-repair completion are reported separately. The genetic algorithm is a bounded search result.')}</div></section>`;
    if(topic==='damage') {
      const list=[...rows(summary.damage?.nodes).map(r=>({...r,group:'node',object_id:'node:'+r.id})),...rows(summary.damage?.branches).map(r=>({...r,group:'branch',object_id:'pipe:'+r.id}))];
      return `<section class="pw-section"><header><h3>${t('节点与支路损伤明细','Node and branch damage')}</h3><span>${t('点击记录联动地图','Select a row to locate it on the map')}</span></header>${tableHTML([{label:t('对象','Asset'),render:r=>`<strong>${e(r.group==='node'?(names.get(String(r.id))||r.id):t('支路 ','Branch ')+r.id)}</strong><small class="pw-cell-sub">${e(r.object_id)}</small>`},{label:'PGA / g',render:r=>number(r.pga_g,2)},{label:t('损伤状态','Damage state'),render:r=>e(({1:t('基本完好','Intact'),2:t('轻微破坏','Slight'),3:t('中等破坏','Moderate'),4:t('严重破坏','Severe'),5:t('完全破坏','Complete')})[r.state]||r.state)},{label:t('组件功能','Asset functionality'),render:r=>percent(r.function)},{label:t('类型','Type'),key:'asset_type'}],list,{id:'damage',onRow:true})}</section>`;
    }
    if(topic==='grid')return `<section class="pw-section"><header><h3>${t('供电状态与模型边界','Supply state & model scope')}</h3></header><div class="pw-overview-grid"><div class="pw-prose">${brief(summary).slice(0,1).map(line=>`<p>${e(line)}</p>`).join('')}<p>${t('组件自身可用性与电网实际供电状态分别显示。设备未损坏并不意味着所在电气通路仍有供电。','Asset availability and network supply are shown separately. An intact asset may still be disconnected from supply.')}</p></div><div class="pw-prose"><h4>${t('采用稀疏直流供电模型','Sparse DC supply model')}</h4><p>${t('不包含交流电压、无功及暂态分析。负荷、电抗、容量和修复工时中的参考假设保留在数据依据和对象详情。','AC voltage, reactive power and transients are outside this model. Reference load, reactance, capacity and repair assumptions remain available in data and asset details.')}</p></div></div></section>`;
    if(topic==='impact') {
      const vals=rows(summary.impact?.strategies).map(item=>({id:item.id,...(item.metrics||{}),...(item.coverage||{})}));
      return `<section class="pw-section"><header><h3>${t('三种策略的累计人口影响','Cumulative population impact by strategy')}</h3></header>${tableHTML([{label:t('策略','Strategy'),render:r=>strategyName(r.id)},{label:t('等效停电人·小时','Equivalent outage person-hours'),render:r=>number(r.outage_person_hours_equivalent,0)},{label:t('未映射人·小时','Unmapped person-hours'),render:r=>number(r.unmapped_person_hours,0)},{label:t('人口覆盖率','Population coverage'),render:r=>percent(r.population_coverage_ratio)}],vals,{id:'impact',search:false})}<div class="pw-notice">${t('完全失供、部分失供等效暴露、未知状态与未映射范围保持独立口径。切换地图时间轴可查看各保存时刻的分区状态。','Full outage, partial-outage equivalent exposure, unknown supply and unmapped areas are kept separate. Use the map timeline to inspect saved zone states.')}</div></section>`;
    }
    if(topic==='recovery') {
      const list=scheduleRows(summary,s);
      return `${curveHTML(strategies)}<section class="pw-section"><header><h3>${t('三策略比较','Compare strategies')}</h3></header>${tableHTML(strategyCols,strategies,{id:'recovery-comparison',search:false})}</section><section class="pw-section"><header><h3>${e(strategyName(s.id))} · ${t('工程队排程','Crew schedule')}</h3><span>${t('随地图所选策略与时刻联动 · 点击对象定位','Linked to the map strategy and event · select an asset to locate it')}</span></header>${tableHTML([{label:t('次序','Order'),key:'rank'},{label:t('修复对象','Repair asset'),render:r=>`<strong>${e(r.name)}</strong><small class="pw-cell-sub">${e(r.key)}</small>`},{label:t('队伍','Crew'),key:'team'},{label:t('开始 / 天','Start / day'),render:r=>number(r.start_day)},{label:t('完成 / 天','Finish / day'),render:r=>number(r.end_day)},{label:t('修复工时','Work hours'),render:r=>number(r.repair_hours)},{label:t('当前状态','Current state'),render:r=>`<span class="pw-repair-state">${repairState(r,frameDays(state.frame))}</span>`}],list,{id:'schedule',onRow:true})}</section>`;
    }
    return `<section class="pw-section"><header><h3>${t('数据版本与适用范围','Data version & applicability')}</h3></header><dl class="pw-provenance"><div><dt>${t('城市数据','City data')}</dt><dd>${e(summary.inventory?.title||summary.city)}</dd></div><div><dt>${t('发布版本','Published version')}</dt><dd><code>${e(summary.dataset_version||'—')}</code></dd></div><div><dt>${t('数据指纹','Data fingerprint')}</dt><dd><code>${e(summary.dataset_fingerprint||'—')}</code></dd></div><div><dt>${t('损伤情景指纹','Damage scenario fingerprint')}</dt><dd><code>${e(summary.damage_scenario_fingerprint||'—')}</code></dd></div></dl><details class="pw-source-note"><summary>${t('查看网络来源与建模假设','Network sources and modelling assumptions')}</summary><p>${e(summary.inventory?.source_note||'—')}</p></details></section>${evidenceHTML(data)}`;
  }
  async function fetchScene(data,iteration) {
    const url=data?`/api/sessions/${encodeURIComponent(data.session_id)}/power-scene?iteration=${encodeURIComponent(iteration?.iteration||data.iteration||1)}`:'/api/power-case';
    const key=url+'|'+(iteration?.run_id||data?.skill_result?.run_id||'case');
    if(!sceneCache.has(key)&&sceneCache.size>=4)sceneCache.delete(sceneCache.keys().next().value);
    if(!sceneCache.has(key))sceneCache.set(key,fetch(url).then(async response=>{if(!response.ok)throw new Error((await response.json()).error||`HTTP ${response.status}`);return response.json();}).catch(error=>{sceneCache.delete(key);throw error;}));
    return sceneCache.get(key);
  }
  function mountScene(host,data,iteration,{view='overview',preview=false,strategy,onFrame,onSelect,frameIndex=0}={}) {
    let handle=null,cancelled=false,pendingView=view,pendingFrame=frameIndex,pendingSelection=null;
    function load() {
      host.innerHTML=`<div class="pw-map-loading"><span></span><strong>${t('正在载入完整电网与保存结果…','Loading the complete network and saved outputs…')}</strong></div>`;
      fetchScene(data,iteration).then(scene=>{
        if(cancelled||!host.isConnected)return;
        if(!window.PowerScene)throw new Error(t('地图组件尚未载入，请刷新页面。','The map component is unavailable. Reload the page.'));
        host.innerHTML='';handle=window.PowerScene.mount(host,scene,{language:zh()?'zh-CN':'en-US',preview,view:pendingView,initialView:pendingView,strategy,onFrame,onSelect});
        if(pendingFrame!==null)handle?.setFrame?.(pendingFrame);
        if(pendingSelection){const [group,...parts]=pendingSelection.split(':');handle?.select?.(parts.join(':'),group==='pipe'?'pipe':group==='area'?'area':'node');}
      }).catch(error=>{
        if(cancelled)return;
        host.innerHTML=`<div class="pw-map-error"><strong>${t('地图数据暂未载入','Map data could not be loaded')}</strong><p>${e(error.message)}</p><button type="button">${t('重新载入','Retry')}</button></div>`;
        host.querySelector('button')?.addEventListener('click',load);
      });
    }
    load();
    return {
      destroy(){cancelled=true;handle?.destroy?.();window.PowerScene?.destroy?.(host);},
      setView(value){pendingView=value;handle?.setView?.(value);},
      setFrame(value){pendingFrame=value;handle?.setFrame?.(value);},
      selectObject(id){pendingSelection=id;const [group,...parts]=id.split(':');handle?.select?.(parts.join(':')||id,group==='pipe'?'pipe':group==='area'?'area':'node');},
      invalidateSize(){handle?.resize?.();},pause(){handle?.pause?.();}
    };
  }
  function updateFocusButtons() {
    const expanded=document.body.classList.contains('pw-result-focus');
    document.querySelectorAll('[data-pw-expand]').forEach(button=>{button.textContent=expanded?t('退出展开','Exit expanded view'):t('展开结果','Expand results');button.setAttribute('aria-pressed',String(expanded));button.setAttribute('aria-expanded',String(expanded));button.title=expanded?t('按 Esc 退出展开','Press Esc to exit'):t('扩大结果工作区','Expand the results workspace');});
  }
  function setResultFocus(expanded) {
    document.body.classList.toggle('pw-result-focus',expanded);updateFocusButtons();
    requestAnimationFrame(()=>{for(const id of ['results-content','spatial-content'])states.get(document.getElementById(id))?.scene?.invalidateSize();});
  }
  function bindResultActions(host,state) {
    host.onclick=event=>{
      const button=event.target.closest('button');if(!button||!host.contains(button))return;
      if(button.hasAttribute('data-pw-expand')){setResultFocus(!document.body.classList.contains('pw-result-focus'));return;}
      if(button.hasAttribute('data-pw-review')){setResultFocus(false);config.onReview?.();return;}
      if(button.hasAttribute('data-pw-interpretation')){
        config.onTab?.('conversation');requestAnimationFrame(()=>{const interpretation=document.querySelector('#conversation-stream .pw-interpretation');if(interpretation){interpretation.open=true;interpretation.scrollIntoView({behavior:'smooth',block:'start'});}});return;
      }
      if(button.dataset.pwTopic){state.setTopic?.(button.dataset.pwTopic);return;}
      if(button.dataset.pwObject){state.scene?.selectObject?.(button.dataset.pwObject);host.querySelector('.pw-scene-host')?.scrollIntoView({behavior:'smooth',block:'start'});return;}
      if(button.dataset.pwOpen)config.onTab?.(button.dataset.pwOpen);
    };
  }
  function resultContextHTML(summary) {
    const p=summary.recovery?.parameters||{},mode=({most_likely:t('最大概率情景','Most-likely scenario'),sampled:t('固定种子抽样','Seeded sample')})[summary.power_damage_mode]||summary.power_damage_mode;
    return `<div class="pw-result-context"><span>${e(summary.city||t('奥克兰','Auckland'))}</span><span>PGA ${number(summary.pga_g,2)}g</span>${mode?`<span>${e(mode)}</span>`:''}<span>${number(p.team_count??summary.team_count,0)} ${t('支队伍','crews')} · ${number(p.daily_work_hours)}h/${t('日','day')}</span><span>${number(summary.node_count,0)} ${t('节点','nodes')} / ${number(summary.branch_count,0)} ${t('支路','branches')}</span></div>`;
  }
  function renderResults(host,data,summary,iteration) {
    if(!summary)return;
    const key=[data.session_id,iteration?.run_id||data.skill_result?.run_id,iteration?.result_delivery?.presentation_revision_id||data.result_delivery?.presentation_revision_id,data.status,zh()].join('|');
    const previous=states.get(host);if(previous?.key===key)return;
    previous?.scene?.destroy();
    const sameSession=previous?.data?.session_id===data.session_id,runId=iteration?.run_id||data.skill_result?.run_id;
    const sameRun=sameSession&&previous.runId===runId;
    const remembered=sameSession?previous.topic:topicMemory.get(data.session_id),topic=topicAvailable(remembered,summary)?remembered:'overview';
    const strategyId=sameRun?selectedStrategy(summary,previous.strategyId).id:primary(summary).id;
    const state={key,runId,topic,data,summary,iteration,strategyId,index:sameRun?previous.index||0:0,frame:sameRun?previous.frame:null,impactFrame:sameRun?previous.impactFrame:null,painting:false};
    states.set(host,state);
    const panelId=host.id+'-topic-panel',round=iteration?.iteration||data.iteration||1,iterations=rows(data.iterations).length?rows(data.iterations):[{iteration:round}];
    host.innerHTML=`<header class="pw-results-heading pw-results-toolbar"><div class="pw-results-title"><h2>${t('电力系统评估','Power system assessment')}</h2>${resultContextHTML(summary)}</div><div class="pw-result-actions"><label>${t('轮次','Round')}<select data-pw-iteration aria-label="${t('选择计算迭代','Select computation round')}">${iterations.map(item=>`<option value="${e(item.iteration)}" ${item.iteration===round?'selected':''}>${t('第','Round')} ${e(item.iteration)} ${t('轮','')}</option>`).join('')}</select></label><button type="button" data-pw-expand aria-pressed="false">${t('展开结果','Expand results')}</button><button type="button" data-pw-review>${t('专家审查','Expert review')}</button></div></header><nav class="pw-topic-nav" role="tablist" aria-label="${t('电力结果专题','Power result topics')}">${topics().map(([id,label])=>`<button type="button" role="tab" id="${host.id}-topic-${id}" aria-controls="${panelId}" aria-selected="${id===topic}" tabindex="${id===topic?0:-1}" data-topic="${id}">${label}</button>`).join('')}</nav><section class="pw-topic-panel" id="${panelId}" role="tabpanel" aria-labelledby="${host.id}-topic-${topic}" tabindex="0"><div class="pw-overview-intro"></div><div class="pw-map-and-brief"><div class="pw-scene-host"></div></div><aside class="pw-result-status"></aside><div class="pw-topic-content"></div></section>`;
    const intro=host.querySelector('.pw-overview-intro'),detail=host.querySelector('.pw-topic-content'),status=host.querySelector('.pw-result-status'),map=host.querySelector('.pw-map-and-brief'),panel=host.querySelector('.pw-topic-panel');
    const sceneView=value=>['overview','grid'].includes(value)?'supply':value;
    const updateStatus=()=>{status.innerHTML=sideHTML(state.topic,summary,state);};
    detail.id=host.id+'-topic-content';
    const updateDetail=()=>{
      detail.innerHTML=topicHTML(state.topic,summary,data,state);bindTables(host,state.scene);bindEvidence(detail);
      if(state.selectedObjectId)selectTableObject(detail,state.selectedObjectId);updateScheduleProgress(detail,state.frame);
    };
    const repaint=(resetInitial=false)=>{
      state.painting=true;host.dataset.resultTopic=state.topic;panel.setAttribute('aria-labelledby',`${host.id}-topic-${state.topic}`);
      host.querySelectorAll('[data-topic]').forEach(button=>{const active=button.dataset.topic===state.topic;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;});
      intro.hidden=state.topic!=='overview';intro.innerHTML=state.topic==='overview'?overviewHTML(summary,data):'';
      map.hidden=state.topic==='sources';status.hidden=state.topic==='sources';updateDetail();updateStatus();
      if(state.topic==='sources')state.scene?.pause();else state.scene?.setView(sceneView(state.topic));
      if(resetInitial){state.scene?.pause();state.scene?.setFrame(0);}
      state.painting=false;updateStatus();updateScheduleProgress(detail,state.frame);
      requestAnimationFrame(()=>state.scene?.invalidateSize());
    };
    state.setTopic=value=>{
      if(!topicAvailable(value,summary)||!topics().some(([id])=>id===value)||value===state.topic)return;
      state.topic=value;topicMemory.set(data.session_id,value);if(topicMemory.size>64)topicMemory.delete(topicMemory.keys().next().value);
      repaint(['overview','damage','grid'].includes(value));
      host.closest('.tab-panel')?.scrollTo({top:0,behavior:'smooth'});
    };
    state.scene=mountScene(host.querySelector('.pw-scene-host'),data,iteration,{
      view:sceneView(topic),strategy:strategyId,frameIndex:['overview','damage','grid'].includes(topic)?0:state.index,
      onFrame:event=>{
        if(states.get(host)!==state)return;
        const strategyChanged=event.strategyId!==state.strategyId;
        state.strategyId=event.strategyId;state.index=event.index;state.frame=event.frame;state.impactFrame=event.impactFrame;
        if(state.painting)return;
        if(strategyChanged&&state.topic==='recovery')updateDetail();
        updateStatus();updateScheduleProgress(detail,state.frame);
      },
      onSelect:event=>{
        if(states.get(host)!==state)return;
        if(!event){state.selectedObjectId=null;state.selectedObjectName=null;selectTableObject(detail,null);updateStatus();return;}
        const group=['pipe','edge','branch'].includes(event.group)?'pipe':event.group==='area'?'area':'node';
        state.selectedObjectId=group+':'+event.id;state.selectedObjectName=event.item?.name||(group==='node'?t('节点 ','Node '):group==='pipe'?t('支路 ','Branch '):t('分区 ','Area '))+event.id;
        selectTableObject(detail,state.selectedObjectId);updateStatus();
      }
    });
    host.querySelectorAll('[data-topic]').forEach(button=>{button.disabled=!topicAvailable(button.dataset.topic,summary);button.title=button.disabled?t('本轮未计算此专题','Not computed in this round'):'';button.addEventListener('click',()=>state.setTopic(button.dataset.topic));});
    host.querySelector('.pw-topic-nav').addEventListener('keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
      const buttons=[...host.querySelectorAll('[data-topic]:not(:disabled)')],index=buttons.indexOf(event.target.closest('[data-topic]'));if(index<0)return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
      state.setTopic(buttons[next].dataset.topic);buttons[next].focus();
    });
    host.querySelector('[data-pw-iteration]').addEventListener('change',event=>config.onIteration?.(data,event.target.value));
    bindResultActions(host,state);repaint();updateFocusButtons();
  }
  function renderSpatial(host,data,summary,iteration) {
    const key=[data.session_id,iteration?.run_id||data.skill_result?.run_id,zh()].join('|');let state=states.get(host);if(state?.key===key)return;state?.scene?.destroy();
    host.innerHTML=`<header class="pw-results-heading pw-results-toolbar"><div class="pw-results-title"><h2>${t('电网与停电影响','Grid & outage impact')}</h2>${resultContextHTML(summary||{})}</div><div class="pw-result-actions"><button type="button" data-pw-open="results">${t('返回专题结果','Result topics')} ↗</button><button type="button" data-pw-expand aria-pressed="false">${t('展开结果','Expand results')}</button><button type="button" data-pw-review>${t('专家审查','Expert review')}</button></div></header><div class="pw-spatial-scene pw-scene-host"></div>`;
    state={key,scene:mountScene(host.querySelector('.pw-scene-host'),data,iteration,{view:'overview'})};states.set(host,state);bindResultActions(host,state);updateFocusButtons();
  }
  function renderArtifacts(host,data,iteration) {
    const all=[...(iteration?.artifacts||data.artifacts||[]),...(data.session_artifacts||[]),...(data.audit_files||[])];
    const seen=new Set(),latest=[],prior=[];
    all.forEach(item=>{if(seen.has(item.name))prior.push(item);else{seen.add(item.name);latest.push(item);}});
    const url=item=>{const value=safeURL(item.url);return value?value+(value.includes('?')?'&':'?')+'download=1':'#';};
    const size=v=>v>=1048576?number(v/1048576,1)+' MB':number(v/1024,1)+' KB';
    const featured=[['multi_round_session_report.docx',t('会话与审查报告','Session & review report'),t('汇总计算、审查意见及后续问答','Calculation, expert review and follow-up answers'),'DOCX'],['engineering_results.docx',t('本轮工程报告','Engineering report'),t('结论、曲线、参数与结果摘录','Findings, curves, parameters and result excerpts'),'DOCX'],['engineering_results.xlsx',t('完整结果工作簿','Complete results workbook'),t('设备损伤、供电、排程和人口指标','Asset damage, supply, schedule and population metrics'),'XLSX']];
    const cards=featured.map(([name,label,copy,type])=>{const item=latest.find(a=>a.name===name);return item?`<article class="pw-download-card"><span>${type}</span><h3>${label}</h3><p>${copy}</p><small>${size(item.size_bytes||0)}</small><a href="${e(url(item))}">${t('下载文件','Download')} ↓</a></article>`:'';}).join('');
    const listing=values=>tableHTML([{label:t('文件','File'),render:r=>`<strong>${e(r.name)}</strong><small class="pw-cell-sub">${e(r.description||'')}</small>`},{label:t('类型','Type'),render:r=>e(r.name.split('.').at(-1).toUpperCase())},{label:t('大小','Size'),render:r=>size(r.size_bytes||0)},{label:t('下载','Download'),render:r=>`<a class="pw-text-link" href="${e(url(r))}">${t('下载','Download')} ↓</a>`}],values,{id:'artifacts',search:true,pageSize:12});
    host.innerHTML=`<div class="pw-results-heading"><div><span class="pw-eyebrow">REPORTS & OUTPUTS</span><h2>${t('报告与可追溯文件','Reports & traceable outputs')}</h2><p>${e(iteration?.result_delivery?.report_title||data.result_delivery?.report_title||'')}</p></div><span class="pw-count">${t('第','Round')} ${iteration?.iteration||data.iteration||1} ${t('轮','')}</span></div><div class="pw-download-grid">${cards}</div><section class="pw-section"><header><h3>${t('本轮成果文件','Current output files')}</h3><span>${t('下载不会重新计算','Downloads never rerun computation')}</span></header>${listing(latest)}</section>${prior.length?`<details class="pw-interpretation"><summary><span>${t('历史呈现版本','Previous presentation versions')}</span><small>${prior.length} ${t('个文件','files')}</small></summary><div class="pw-prior-files">${listing(prior)}</div></details>`:''}`;
    bindTables(host,null);
  }
  function notifyTab(tab) {
    if(!['results','spatial'].includes(tab))setResultFocus(false);else updateFocusButtons();
    document.body.dataset.powerView=tab;
    if(['results','spatial'].includes(tab))requestAnimationFrame(()=>states.get(document.getElementById(tab==='results'?'results-content':'spatial-content'))?.scene?.invalidateSize());
    if(tab!=='spatial')states.get(document.getElementById('spatial-content'))?.scene?.pause();
    if(tab!=='results')states.get(document.getElementById('results-content'))?.scene?.pause();
  }
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('pw-result-focus'))setResultFocus(false);});
  window.PowerWorkbench={configure(value){config=value;},conversation,renderResults,renderSpatial,renderArtifacts,notifyTab,setTopic(value,host=document.getElementById('results-content')){states.get(host)?.setTopic?.(value);},evidenceHTML,bindEvidence,curveHTML};
})();
