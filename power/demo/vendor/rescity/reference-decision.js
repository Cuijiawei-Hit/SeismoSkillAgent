/* Read the selected round using ResCity's impact -> allocation -> recovery flow.
 * This is an editorial view of saved values and schedules, not an engineering
 * calculation. The full saved interpretation and citations remain available.
 * The receiving ResCity component escapes every returned string.
 */
(function () {
  'use strict';
  const list = value => Array.isArray(value) ? value : [];

  function plain(value) {
    return String(value ?? '')
      .replace(/<\/?[A-Za-z][^>]*>/g, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`+([^`]*?)`+/g, '$1')
      .replace(/\*\*([^*]*?)\*\*/g, '$1')
      .replace(/__([^_]*?)__/g, '$1')
      .replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|[，。；：！？,.!?;:]|$)/g, '$1$2')
      .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function sections(text) {
    const output = [];
    let current = {title: '', lines: []}, fenced = false;
    for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const heading = line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
      if (heading) { output.push(current); current = {title: plain(heading[1]), lines: []}; }
      else current.lines.push(line);
    }
    output.push(current);
    return output;
  }

  function paragraphs(lines) {
    const output = [];
    let pending = [];
    const flush = () => {
      const text = plain(pending.join(' '));
      if (text && !/[：:]$/.test(text) && !/^(说明|重要说明|模型边界)$/.test(text)) output.push(text);
      pending = [];
    };
    for (const line of lines) {
      if (!line.trim() || /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
      if (/^\s*\|/.test(line)) { flush(); continue; }
      const bullet = line.match(/^\s*(?:[-+*]|\d+[.)、])\s+(.+)$/);
      if (bullet) { flush(); pending.push(bullet[1]); }
      else pending.push(line.trim());
    }
    flush();
    return output;
  }

  function tableFacts(section) {
    if (!/(?:震前与震后|供电功率|停电影响|人口影响)/.test(section.title)) return [];
    const groups = [];
    let group = [];
    const flush = () => { if (group.length) groups.push(group.join('；') + '。'); group = []; };
    for (const line of section.lines) {
      if (!/^\s*\|/.test(line)) { flush(); continue; }
      const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(item => item.trim());
      if (cells.length !== 2 || /^[\s:|-]+$/.test(cells.join(''))) continue;
      const label = plain(cells[0].replace(/`[^`]+`/g, ''));
      const value = plain(cells[1]);
      if (/^(震前供电功率|震后供电功率|功能比|瞬时未供功率|系统需求|完全停电人口|部分停电等效人口|等效受影响人口|未知人口|未映射人口|停电面积|人口覆盖率|已映射人口|研究人口)$/.test(label) && value) group.push(label + '：' + value);
    }
    flush();
    return groups;
  }

  function numberedAdvice(section) {
    const items = [];
    let active = null;
    for (const line of section.lines) {
      const marker = line.match(/^\s*(\d+)[.)、]\s+(.+)$/);
      if (marker) {
        if (active) items.push(active);
        active = {number: Number(marker[1]), lines: [marker[2]]};
      } else if (active) active.lines.push(line);
    }
    if (active) items.push(active);
    return items.map(item => ({number: item.number, text: plain(item.lines.join(' ')), heading: section.title})).filter(item => item.text);
  }

  function savedText(data, iteration) {
    const rounds = list(data?.iterations), selected = iteration || rounds.at(-1);
    if (!selected) return String(data?.current_interpretation || data?.final_answer || '');
    if (selected.interpretation) return String(selected.interpretation);
    const latest = Number(selected.iteration) === Number(data?.iteration ?? rounds.at(-1)?.iteration);
    return latest ? String(data?.current_interpretation || data?.final_answer || '') : '';
  }

  function topicFor(text) {
    if (/知识库|知识证据|文献|目录|条文|引用/.test(text)) return 'evidence';
    if (/未映射|人口|停电范围/.test(text) && !/策略|方案|恢复|ga\b/i.test(text)) return 'impact';
    if (/策略|恢复|修复|抢修|队伍|搜索|\bga\b|id_order|importance/i.test(text)) return 'recovery';
    if (/供电|功率|电网/.test(text)) return 'service';
    return 'objects';
  }

  function titleFor(text) {
    const sentence = text.match(/^[^。！？]+[。！？]?/)?.[0] || text;
    const firstClause = sentence.split(/[，；]/)[0];
    return firstClause.length >= 10 && sentence.length > 45 ? firstClause : sentence.replace(/[。！？]$/, '');
  }

  const number = value => typeof value === 'number' && Number.isFinite(value);
  const fmt = (value, digits = 2) => new Intl.NumberFormat('zh-CN', {maximumFractionDigits: digits}).format(value);
  const strategyName = value => ({id_order: '编号顺序方案', importance: '功能增益排序方案', ga: '遗传算法方案'})[value.id] || value.name || value.id;

  function engineeringBrief(summary) {
    const power = summary.function || {}, damage = summary.damage || {}, recovery = summary.recovery || {};
    const config = recovery.parameters || {}, strategies = list(recovery.strategies);
    const selected = strategies.find(row => row.id === recovery.recommended_strategy);
    const baseline = strategies.find(row => row.id === 'id_order');
    const impact = summary.impact || {}, spatial = list(impact.strategies).find(row => row.id === impact.recommended_strategy) || impact;
    const initial = spatial.initial_summary || {}, coverage = spatial.coverage || impact.coverage || {};
    const prose = [], actions = [];
    const add = (title, action, topic, rationale, verification = '') => actions.push({
      id: 'engineering-action-' + (actions.length + 1), title, action, topic, rationale, verification,
      priority: actions.length ? 'next' : 'first',
      source_skill_id: 'power_system.' + ({recovery: 'recovery_optimization', service: 'function_assessment', impact: 'outage_impact'})[topic],
    });
    if (number(power.post_supply_mw)) {
      let statement = `震后供电功率为 ${fmt(power.post_supply_mw)} MW`;
      if (number(power.pre_supply_mw)) statement += `，震前为 ${fmt(power.pre_supply_mw)} MW`;
      if (number(damage.damaged_node_count) && number(damage.damaged_branch_count)) statement += `；待修复对象包括 ${fmt(damage.damaged_node_count)} 个节点和 ${fmt(damage.damaged_branch_count)} 条支路`;
      prose.push(statement + '。');
    }
    const population = [];
    if (number(initial.full_outage_population)) population.push(`初始完全失供区域人口约 ${fmt(initial.full_outage_population)} 人`);
    else if (number(initial.full_outage_population_known_lower_bound)) population.push(`初始完全失供区域已知人口至少 ${fmt(initial.full_outage_population_known_lower_bound)} 人`);
    if (number(initial.partial_outage_population_equivalent) && initial.partial_outage_population_equivalent > 0) population.push(`部分缺供等效人口约 ${fmt(initial.partial_outage_population_equivalent)} 人`);
    if (number(initial.outage_area_km2)) population.push(`缺供面积约 ${fmt(initial.outage_area_km2)} km²`);
    if (number(coverage.unmapped_population) && coverage.unmapped_population > 0) population.push(`另有 ${fmt(coverage.unmapped_population)} 人所在区域待补全供电关联`);
    if (population.length) prose.push(population.join('；') + '。');

    // Compare only strategies sharing the saved scenario and evaluation period.
    const horizons = strategies.map(row => row.comparison_horizon_days);
    const comparable = strategies.length > 1 && recovery.comparison_status?.comparable !== false
      && Boolean(recovery.scenario_digest || recovery.damage_scenario_fingerprint)
      && horizons.every(value => number(value) && value === horizons[0]);
    if (selected) {
      let choice = `本轮按${config.repair_objective === 'target_time' ? '目标功能达标时间' : '累计功能损失'}选择${strategyName(selected)}`;
      if (number(selected.loss_area_days)) choice += `，累计功能损失为 ${fmt(selected.loss_area_days)} 功能损失·天`;
      if (comparable && baseline && baseline !== selected && number(baseline.loss_area_days)) choice += `，编号顺序方案为 ${fmt(baseline.loss_area_days)} 功能损失·天`;
      if (number(selected.resilience_index)) choice += `；推荐方案的共同评价期韧性指数为 ${fmt(selected.resilience_index, 3)}`;
      prose.push(choice + '。');
      const target = number(config.target_function) ? fmt(config.target_function * 100) + '%' : '设定';
      const outcome = [];
      if (selected.target_reached !== false && number(selected.target_time_days)) outcome.push(`推荐方案预计震后第 ${fmt(selected.target_time_days)} 天达到 ${target} 功能`);
      else if (selected.target_reached === false) outcome.push('推荐方案在本轮排程结束时尚未达到设定功能目标');
      if (comparable && baseline && baseline !== selected && baseline.target_reached !== false && number(baseline.target_time_days)) outcome.push(`编号顺序方案的达标时间为第 ${fmt(baseline.target_time_days)} 天`);
      if (number(selected.total_days)) outcome.push(`推荐方案的全部修复任务于第 ${fmt(selected.total_days)} 天完成`);
      if (outcome.length) prose.push(outcome.join('；') + '。');
    }

    const network = summary.network || summary.inventory?.network || {};
    const names = new Map(list(network.nodes).map(row => [String(row.id), row.name]));
    const name = row => row.asset_name || ((row.group === 'node' ? names.get(String(row.raw_id ?? row.id)) : '') || `${row.group === 'node' ? '电力节点' : '线路'} ${row.raw_id ?? row.id}`);
    const jobs = list(selected?.schedule).filter(row => number(row.start_day) && number(row.end_day))
      .slice().sort((a, b) => a.start_day - b.start_day || (a.rank || 0) - (b.rank || 0));
    if (jobs.length) {
      const first = jobs.filter(row => row.start_day === jobs[0].start_day);
      const resources = [number(config.team_count) ? `${fmt(config.team_count)} 支工程队` : '', number(config.daily_work_hours) ? `每天 ${fmt(config.daily_work_hours)} 小时` : ''].filter(Boolean).join('、');
      add('首批队伍具体怎么安排', `${resources ? `按本轮 ${resources}的配置，` : ''}${first.slice(0, 3).map(row => `第 ${row.team} 队先修复 ${name(row)}，排程为震后第 ${fmt(row.start_day)}—${fmt(row.end_day)} 天`).join('；')}${first.length > 3 ? '；其余队伍安排见完整排程' : ''}。`,
        'recovery', `对象和顺序取自本轮${strategyName(selected)}的保存排程。`, '开工前核对设备状态、进场条件和材料；完工后复核潮流与保护。');
      const next = first.map(row => jobs.find(job => job.team === row.team && job !== row)).filter(Boolean);
      if (next.length) add('首批完成后接着修哪里', next.slice(0, 3).map(row => `第 ${row.team} 队随后转入 ${name(row)}，排程为震后第 ${fmt(row.start_day)}—${fmt(row.end_day)} 天`).join('；') + '。',
        'recovery', '沿用同一方案各队的下一项任务。', '按实际完工进度衔接后续任务，有变化时在右侧提交排程修订。');
      if (comparable && baseline && baseline !== selected && number(baseline.target_time_days) && number(selected.target_time_days)
          && baseline.target_reached !== false && selected.target_reached !== false && baseline.target_time_days !== selected.target_time_days) {
        const faster = baseline.target_time_days < selected.target_time_days ? baseline : selected;
        add('按恢复目标选择方案', `若优先尽早达到 ${number(config.target_function) ? fmt(config.target_function * 100) + '%' : '设定'} 功能，可采用${strategyName(faster)}，达标时间为第 ${fmt(faster.target_time_days)} 天；若按本轮${config.repair_objective === 'target_time' ? '目标达标时间' : '累计功能损失'}目标安排，则采用当前推荐的${strategyName(selected)}。`,
          'recovery', '两项时间来自同一损伤情景和评价期的保存结果。');
      }
    }
    if (number(power.post_supply_mw) && number(power.pre_supply_mw) && power.post_supply_mw < power.pre_supply_mw) {
      add('同步安排近期供电保障', '结合停电分区核对重要负荷的转供路径和临时电源需求，设备抢修与近期供电保障同步安排。',
        'service', '本轮存在供电缺口；重要负荷位置与需求可结合供电分区和设备明细核对。', '核对实际负荷、可用电源和接线条件。');
    }
    const scope = [summary.city || summary.inventory?.region?.city_name,
      number(summary.pga_g) ? `PGA ${fmt(summary.pga_g)}g` : '',
      number(config.team_count) ? `${fmt(config.team_count)} 支工程队` : '',
      number(config.daily_work_hours) ? `每日 ${fmt(config.daily_work_hours)} 小时` : ''].filter(Boolean).join(' · ');
    return {summary: prose, recommendations: actions, scope,
      headline: jobs.length ? `按${strategyName(selected)}安排抢修，${config.repair_objective === 'target_time' ? '尽早达到恢复目标' : '减少恢复期供电损失'}` : prose[0] || '本轮评估结果'};
  }

  function build(data = {}, summary = {}, iteration = null) {
    const text = savedText(data, iteration), parsed = sections(text);
    const adviceSections = parsed.filter(section => /(?:^|[.\s])(?:建议|工程建议|Recommendations?|Advice)(?:\s|$)/i.test(section.title));
    const advice = adviceSections.flatMap(numberedAdvice);
    const generalCondition = adviceSections.flatMap(section => {
      const firstAdvice = section.lines.findIndex(line => /^\s*\d+[.)、]\s+/.test(line));
      return paragraphs(firstAdvice < 0 ? section.lines : section.lines.slice(0, firstAdvice));
    })
      .find(line => /仅依据|审批|前提|条件|范围|saved|approval/i.test(line)) || '';
    const conclusionSections = parsed.filter(section =>
      /变电站.*损伤|震前与震后|供电功率|完工时间|达标时间|共同评价期韧性|遗传算法实际搜索|原模型等级|停电影响|人口影响|本次结论|核心结论|主要结论|Conclusion|Findings/i.test(section.title)
      && !adviceSections.includes(section));
    const conclusions = [];
    for (const section of conclusionSections) {
      conclusions.push(...tableFacts(section), ...paragraphs(section.lines));
    }
    const seen = new Set();
    const prose = conclusions.filter(value => {
      const key = value.replace(/\s+/g, '');
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
    const recommendations = advice.map((item, index) => {
      const sentences = item.text.match(/[^。！？]+[。！？]?/g)?.map(value => value.trim()).filter(Boolean) || [item.text];
      const action = sentences[0];
      const remaining = sentences.slice(1);
      const conditions = remaining.filter(value => /现场|审批|条件|不等同|不能|不得|不要|重新|不构成|需.*(?:核|验|确|审)/.test(value));
      const reasons = remaining.filter(value => !conditions.includes(value));
      const topic = topicFor(item.text);
      return {
        id: 'saved-advice-' + item.number,
        priority: index === 0 ? 'first' : index === 1 ? 'next' : 'verify',
        title: titleFor(item.text), action,
        rationale: reasons.join(' '),
        verification: conditions.join(' ') || generalCondition,
        topic,
        source_skill_id: ({recovery: 'power_system.recovery_optimization', impact: 'power_system.outage_impact', service: 'power_system.function_assessment', objects: 'power_system.damage_assessment', evidence: 'power_system.result_reporting'})[topic],
        original_text: item.text,
        source_location: item.heading + ' / ' + item.number,
        evidence_ids: [...item.text.matchAll(/\[KB:([^\]]+)\]/g)].map(match => match[1]),
      };
    });
    const brief = engineeringBrief(summary);
    // Technical scope and the original advice remain in the expanded explanation,
    // instead of being promoted into the main conclusion or repeated per action.
    const details = parsed.filter(section => /边界|范围|输入|搜索|模型|适用|口径|Scope|Model|Search/i.test(section.title))
      .flatMap(section => paragraphs(section.lines));
    const expanded = [...new Set([...prose, ...details, ...advice.map(item => item.text)])];
    return {
      headline: brief.headline,
      scope: brief.scope,
      summary: brief.summary,
      expanded_explanation: expanded,
      recommendations: brief.recommendations.length ? brief.recommendations : recommendations,
      saved_recommendations: recommendations,
      narrative_version: 'saved-engineering-brief-v2',
      interpretation_text: text,
      source_iteration: iteration?.iteration ?? data.iteration ?? null,
      source_run_id: iteration?.run_id ?? null,
    };
  }

  window.ReferencePowerDecision = Object.freeze({build});
})();
