const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '../seismo-skill-agent/src/seismo_skill_agent/web_static');
const source = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('English is the initial default, including browsers with the old Chinese default', () => {
  const initial = source.slice(0, source.indexOf('const $ =')) + '\napp.language';
  const language = values => vm.runInNewContext(initial, {localStorage: {getItem: key => values[key] ?? null}});
  assert.equal(language({}), 'en-US');
  assert.equal(language({'power-skill-agent.language': 'zh-CN'}), 'en-US');
  assert.equal(language({'power-skill-agent.language.v2': 'zh-CN'}), 'zh-CN');
  assert.equal(language({'power-skill-agent.language.v2': 'en-US'}), 'en-US');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /class="active" data-language="en-US"/);
  assert.match(html, />Describe the engineering question or decision task</);
  assert.match(source, /output_language: app.language/);
});

test('native reader localization is reversible and leaves values and object identities intact', () => {
  let callback, active;
  class Element {
    constructor(attributes = {}, children = []) { this.nodeType = 1; this.attrs = {...attributes}; this.children = children; for (const child of children) child.parentElement = this; }
    closest(selector) { return selector.includes('#results-content') ? this : null; }
    hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
    getAttribute(key) { return this.attrs[key]; }
    setAttribute(key, value) { this.attrs[key] = value; }
    querySelectorAll() { return []; }
  }
  const label = {nodeType: 3, nodeValue: '结论与建议'};
  const button = new Element({'aria-label': '网络恢复时间点', 'data-engineering-object': '406', value: '896'}, [label]);
  const context = {window: {}, NodeFilter: {SHOW_ELEMENT: 1, SHOW_TEXT: 4},
    document: {body: {}, querySelectorAll: () => [button], createTreeWalker(node) {
      const children = node.children || []; let index = -1;
      return {currentNode: null, nextNode() { this.currentNode = children[++index]; return Boolean(this.currentNode); }};
    }},
    MutationObserver: class { constructor(fn) { callback = fn; } observe() { active = true; } disconnect() { active = false; } },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'vendor/rescity/reference-language.js'), 'utf8'), context);
  const language = context.window.ReferencePowerLanguage;
  language.setLanguage('en-US');
  assert.equal(label.nodeValue, 'Conclusions and recommendations');
  assert.equal(button.attrs['aria-label'], 'Saved recovery time');
  assert.equal(button.attrs['data-engineering-object'], '406');
  assert.equal(button.attrs.value, '896');
  label.nodeValue = '恢复方案';
  callback([{type: 'characterData', target: label}]);
  assert.equal(label.nodeValue, 'Recovery plans');
  language.setLanguage('zh-CN');
  assert.equal(label.nodeValue, '恢复方案');
  assert.equal(button.attrs['aria-label'], '网络恢复时间点');
  assert.equal(active, false);
});

test('generated conclusions and crew actions display in English without changing quantities', () => {
  const context = {window: {}, Intl};
  vm.createContext(context);
  for (const file of ['reference-language.js', 'reference-decision.js']) vm.runInContext(fs.readFileSync(path.join(root, 'vendor/rescity', file), 'utf8'), context);
  const summary = {city: '奥克兰（Auckland）', pga_g: 0.4,
    function: {pre_supply_mw: 850, post_supply_mw: 0}, damage: {damaged_node_count: 113, damaged_branch_count: 18},
    network: {nodes: [{id: '406', name: 'PAKURANGA 33/11kV'}]},
    recovery: {recommended_strategy: 'ga', parameters: {team_count: 1, daily_work_hours: 24, target_function: 0.9},
      strategies: [{id: 'ga', loss_area_days: 713.92, resilience_index: 0.221, target_time_days: 896, total_days: 917,
        schedule: [{group: 'node', id: '406', team: 1, start_day: 0, end_day: 7}]}]}};
  const before = JSON.stringify(summary);
  const decision = context.window.ReferencePowerDecision.build({}, summary, {iteration: 1});
  const translate = context.window.ReferencePowerLanguage.text;
  const visible = [decision.headline, decision.scope, ...decision.summary, ...decision.recommendations.flatMap(row => [row.title, row.action, row.rationale, row.verification])].map(translate).join('\n');
  assert.doesNotMatch(visible, /[\u3400-\u9fff]/);
  assert.match(visible, /0 MW.*850 MW/);
  assert.match(visible, /PAKURANGA 33\/11kV.*0–7/);
  assert.match(visible, /1 repair crew working 24 hours/);
  assert.equal(JSON.stringify(summary), before);
});
