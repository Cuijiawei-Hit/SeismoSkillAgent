"""Finite-team scheduling using a domain solver after every completion event.

No damage is resampled while comparing orders. All candidates share the same
inventory, initial state, resources and comparison horizon.
"""
import math
import random
from .water_parameters import parameters as common_parameters

SYSTEMS = {'heating_system', 'drainage_system', 'gas_system', 'power_system',
           'communication_system', 'building_complex', 'transportation_system', 'rail_transit_system'}
PARAMETERS = {'team_count', 'daily_work_hours', 'team_efficiency', 'repair_objective',
              'target_function', 'ga_population', 'ga_generations', 'repair_constraints'}


def parameters(values):
    result = common_parameters(values)
    constraints = values.get('repair_constraints', {})
    if not isinstance(constraints, dict):
        raise ValueError('修复约束必须为以 group:id 为键的对象。')
    for key, row in constraints.items():
        if not isinstance(key, str) or not isinstance(row, dict) or set(row)-{'predecessors','release_day','allowed_teams'}:
            raise ValueError('修复约束仅支持 predecessors、release_day、allowed_teams。')
        if 'predecessors' in row and (not isinstance(row['predecessors'], list) or any(not isinstance(x,str) for x in row['predecessors'])):
            raise ValueError('前置修复任务必须为编号数组。')
        if type(row.get('release_day',0)) not in (int,float) or not math.isfinite(row.get('release_day',0)) or row.get('release_day',0)<0:
            raise ValueError('最早可开工时间须为有限非负天数。')
        if 'allowed_teams' in row and (not isinstance(row['allowed_teams'],list) or not row['allowed_teams'] or any(type(x) is not int or x<1 or x>result['team_count'] for x in row['allowed_teams'])):
            raise ValueError('可用工程队编号须在本轮队伍范围内，且不能为空。')
    return {**result, 'repair_constraints': constraints}


def optimize(jobs, evaluate_state, values, *, system, service, initial_state, notes=()):
    config = parameters(values)
    jobs = [dict(j) for j in jobs]
    by_key = {}
    for i, job in enumerate(jobs):
        key = job['group']+':'+job['id']
        if key in by_key: raise ValueError('修复任务编号重复：'+key)
        by_key[key] = i
        duration = job['repair_hours']
        if not math.isfinite(duration) or duration<=0: raise ValueError('受损组件缺少正修复工时：'+key)
        job.update(key=key, duration_days=duration/config['daily_work_hours']/config['team_efficiency'])
    if len(jobs)>1000: raise ValueError('当前单次优化最多支持1000个修复任务，请划分区域。')
    constraints = config['repair_constraints']
    if set(constraints)-set(by_key): raise ValueError('修复约束包含本轮不存在的受损任务。')
    for job in jobs:
        rule = constraints.get(job['key'],{})
        if set(rule.get('predecessors',[]))-set(by_key): raise ValueError('前置约束引用不存在的修复任务。')
        job.update(predecessors=rule.get('predecessors',[]), release_day=rule.get('release_day',0),
                   allowed_teams=rule.get('allowed_teams',list(range(1,config['team_count']+1))))
    cache = {}
    def state(done):
        key = frozenset(done)
        if key not in cache:
            value = float(evaluate_state(key))
            if not math.isfinite(value) or not -1e-8<=value<=1+1e-6:
                raise ValueError('系统功能回算不在0～1范围内，不能生成恢复优化结论。')
            cache[key] = min(1.,max(0.,value))
        return cache[key]
    initial = state(set())
    horizon = sum(j['duration_days'] for j in jobs)+max((j['release_day'] for j in jobs),default=0.)
    def evaluate(order, detail=False):
        free = {i:0. for i in range(1,config['team_count']+1)}
        finish, schedule, remaining = {}, [], list(order)
        while remaining:
            index = next((i for i in remaining if all(k in finish for k in jobs[i]['predecessors'])),None)
            if index is None: raise ValueError('修复任务前置依赖存在循环。')
            remaining.remove(index); job = jobs[index]
            earliest = max([job['release_day'], *[finish[k] for k in job['predecessors']]])
            team = min(job['allowed_teams'],key=lambda t:(max(free[t],earliest),t))
            start = max(free[team],earliest); end = start+job['duration_days']
            free[team]=end; finish[job['key']]=end
            schedule.append({**job,'rank':len(schedule)+1,'team':team,'start_day':start,'end_day':end})
        events = {}
        for row in schedule: events.setdefault(row['end_day'],set()).add(row['key'])
        done=set(); last=0.; function=initial; area=0.; target=0. if initial>=config['target_function'] else None
        curve=[{'time':0.,'function':initial}]
        for time, repaired in sorted(events.items()):
            area+=(time-last)*(1-function);done.update(repaired);function=state(done)
            if target is None and function+1e-10>=config['target_function']:target=time
            curve.append({'time':time,'function':function});last=time
        area+=(horizon-last)*(1-function)
        score=(area, target if target is not None else math.inf,last)
        if config['repair_objective']=='target_time':score=(score[1],area,last)
        return score,dict(loss_area_days=area,target_time_days=target,total_days=last,
            target_reached=target is not None,final_function=function,comparison_horizon_days=horizon,
            resilience_index=1-area/horizon if horizon>0 else initial,
            curve=curve if detail else [],schedule=schedule if detail else [])
    baseline=sorted(range(len(jobs)),key=lambda i:jobs[i]['key'])
    evaluate(baseline)  # Validate constraints before searching.
    gains={i:(state({jobs[i]['key']})-initial)/jobs[i]['duration_days'] for i in baseline}
    important=sorted(baseline,key=lambda i:(-gains[i],jobs[i]['duration_days'],jobs[i]['key']))
    rng=random.Random(values.get('seed',0)); scores={}
    def score(order):
        key=tuple(order)
        if key not in scores:scores[key]=evaluate(order)[0]
        return scores[key]
    population=[baseline,important]
    for _ in range(config['ga_population']-2):
        order=baseline[:];rng.shuffle(order);population.append(order)
    # Bound expensive network solves deterministically. Always finish the two
    # references; report the actual search rather than pretending all requested
    # generations ran. Cached states also count toward the same work budget.
    budget=200 if system=='transportation_system' else 6000
    score(baseline);score(important)
    tested=[baseline,important];stopped=False
    def admit(order):
        nonlocal stopped
        if tuple(order) in scores:return True
        if len(cache)+len(jobs)>budget:
            stopped=True;return False
        score(order);tested.append(order[:]);return True
    population=[order for order in population if admit(order)]
    best=min(population,key=score)[:];history=[]
    for generation in range(config['ga_generations']):
        population.sort(key=score)
        if score(population[0])<score(best):best=population[0][:]
        history.append({'generation':generation,'objective_value':score(best)[0] if math.isfinite(score(best)[0]) else None})
        if len(jobs)<2:break
        following=[best[:],baseline[:],important[:]]
        while len(following)<config['ga_population']:
            a,b=(min(rng.sample(population,min(3,len(population))),key=score) for _ in range(2))
            lo,hi=sorted(rng.sample(range(len(jobs)+1),2));segment=a[lo:hi];kept=set(segment)
            rest=[i for i in b if i not in kept];child=rest[:lo]+segment+rest[lo:]
            if rng.random()<.35:
                x,y=rng.sample(range(len(child)),2);child[x],child[y]=child[y],child[x]
            following.append(child)
        population=[order for order in following if admit(order)]
        if stopped:break
    candidate=min(tested+[best],key=score)
    strategies=[]
    for key,name,order in [('id_order','编号顺序基准',baseline),('importance','系统功能增益每工时排序',important),('ga','遗传算法搜索',candidate)]:
        _,report=evaluate(order,True);strategies.append(dict(id=key,name=name,**report))
    recommended=min(range(3),key=lambda i:score([baseline,important,candidate][i]))
    return dict(schema_version='engineering.recovery-optimization.v1',system=system,service=service,
        parameters=config,seed=values.get('seed',0),strategies=strategies,recommended_strategy=strategies[recommended]['id'],
        search_history=history,initial_state=initial_state,state_evaluations=len(cache),
        search_limits={'state_budget':budget,'budget_reached':stopped,'evaluated_orders':len(scores),'completed_generations':len(history)},
        assumptions=[*notes,'每队同一时间仅修复一个任务；支持前置修复、最早开工时间和指定可用队伍约束。',
            '参考修复天数按24小时折成等效工时，再按每日工时及效率计算日历天；未模拟逐日班次、路程或材料库存。',
            '组件完成后恢复至该模型的完好状态；每个完成事件调用本系统功能模型重新计算。',
            '同一损伤样本和资源约束下比较三个候选；遗传算法不保证全局最优。',
            f'搜索已评价 {len(scores)} 种顺序、{len(cache)} 个功能状态；'+('达到计算预算，保留已评价的最佳方案。' if stopped else '在本轮搜索范围内选择最佳方案。'),
            '韧性指数采用共同对比期内功能曲线面积比，不替代原模型的等级划分。'])


def frames(result, strategy_id, max_frames=121):
    strategy=next((s for s in result['strategies'] if s['id']==strategy_id),None)
    if strategy is None:raise ValueError('未找到本轮恢复策略。')
    if 'map_frames' in strategy:return strategy['map_frames']
    ends={(r['group'],r['id']):r['end_day'] for r in strategy['schedule']}
    curve=strategy['curve']
    if len(curve)>max_frames:
        curve=[curve[round(i*(len(curve)-1)/(max_frames-1))] for i in range(max_frames)]
    return [{'time':p['time'],'time_unit':'天',**{group:{
        'function':{k:1. if (group,k) in ends and ends[group,k]<=p['time'] else row['function'] for k,row in rows.items()},
        'damage':{k:'基本完好' if (group,k) in ends and ends[group,k]<=p['time'] else row['damage'] for k,row in rows.items()}}
        for group,rows in result['initial_state'].items()}} for p in curve]
