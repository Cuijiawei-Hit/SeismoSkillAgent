const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = { window: {}, Intl };
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname,
  '../seismo-skill-agent/src/seismo_skill_agent/web_static/vendor/rescity/reference-decision.js'), 'utf8'), context);
const build = context.window.ReferencePowerDecision.build;
const interpretation = '# 模型边界\n\n不能将测试情景当作实测结果。\n\n# 建议\n\n1. 按保存排程修复。[KB:exact-source]\n\n2. 现场核对材料。';
const round = { iteration: 1, run_id: 'saved-one', interpretation };

function summary() {
  return {
    city: '示例电网', pga_g: 0.4,
    function: { pre_supply_mw: 850, post_supply_mw: 0 },
    damage: { damaged_node_count: 113, damaged_branch_count: 18 },
    network: { nodes: [{ id: '406', name: '甲站' }, { id: '454', name: '乙站' }] },
    impact: { initial_summary: { full_outage_population: 100, outage_area_km2: 5 }, coverage: { unmapped_population: 12 } },
    recovery: { recommended_strategy: 'ga', scenario_digest: 'frozen',
      parameters: { team_count: 1, daily_work_hours: 24, repair_objective: 'function_loss_area', target_function: 0.9 },
      strategies: [
        { id: 'id_order', loss_area_days: 838, target_time_days: 875, total_days: 917, comparison_horizon_days: 917 },
        { id: 'ga', loss_area_days: 714, target_time_days: 896, total_days: 917, comparison_horizon_days: 917, resilience_index: 0.221,
          schedule: [
            { group: 'node', id: '454', team: 1, start_day: 7, end_day: 14, rank: 2 },
            { group: 'node', id: '406', team: 1, start_day: 0, end_day: 7, rank: 1 },
          ] },
      ] },
  };
}

test('main conclusions explain impact, choice and timing; technical scope stays expandable', () => {
  const result = build({}, summary(), round);
  assert.equal(result.summary.length, 4);
  assert.match(result.summary[0], /震后供电功率为 0 MW/);
  assert.match(result.summary.join(''), /113 个节点和 18 条支路/);
  assert.match(result.summary.join(''), /100 人.*12 人所在区域待补全供电关联/);
  assert.match(result.summary.join(''), /714.*838/);
  assert.match(result.summary.join(''), /896.*875.*917/);
  assert.doesNotMatch(result.summary.join(''), /不能|不代表|全局最优|id_order|most_likely/);
  assert(result.expanded_explanation.includes('不能将测试情景当作实测结果。'));
  assert.equal(result.interpretation_text, interpretation);
  assert.equal(result.saved_recommendations[0].evidence_ids[0], 'exact-source');
});

test('crew actions follow the saved schedule and named assets without mutating inputs', () => {
  const input = summary(), before = JSON.stringify(input);
  const result = build({}, input, round);
  assert.match(result.recommendations[0].action, /第 1 队先修复 甲站.*0—7 天/);
  assert.match(result.recommendations[1].action, /第 1 队随后转入 乙站.*7—14 天/);
  assert.match(result.recommendations[2].action, /90%.*编号顺序方案.*875.*遗传算法方案/);
  assert.equal(JSON.stringify(input), before);
});

test('missing values are not shown as zero, while genuine zero remains visible', () => {
  const input = summary();
  input.function.post_supply_mw = null;
  input.impact.initial_summary = { full_outage_population: null, full_outage_population_known_lower_bound: 20 };
  const result = build({}, input, round);
  assert.doesNotMatch(result.summary.join(''), /震后供电功率为 0|人口约 0/);
  assert.match(result.summary.join(''), /已知人口至少 20 人/);
});

test('different evaluation periods or explicit noncomparability suppress cross-strategy advice', () => {
  for (const reason of ['horizon', 'status']) {
    const input = summary();
    if (reason === 'horizon') input.recovery.strategies[0].comparison_horizon_days = 100;
    else input.recovery.comparison_status = { comparable: false };
    const result = build({}, input, round);
    assert.doesNotMatch(result.summary.join(''), /编号顺序方案/);
    assert(!result.recommendations.some(item => item.title === '按恢复目标选择方案'));
  }
});

test('empty schedules and missing historical interpretations do not borrow current results', () => {
  const input = summary();
  input.recovery.strategies[1].schedule = [];
  const result = build({ iteration: 2, current_interpretation: 'new-round-only' }, input, { iteration: 1 });
  assert(!result.recommendations.some(item => /首批/.test(item.title)));
  assert.equal(result.interpretation_text, '');
  assert.doesNotMatch(JSON.stringify(result), /new-round-only/);
});
