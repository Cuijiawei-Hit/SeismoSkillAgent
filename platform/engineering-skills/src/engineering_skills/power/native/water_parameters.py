import heapq

import math

import random

PARAMETERS = {'team_count', 'daily_work_hours', 'team_efficiency', 'repair_objective',
              'target_function', 'ga_population', 'ga_generations'}

DEFAULTS = dict(team_count=1, daily_work_hours=24., team_efficiency=1.,
                repair_objective='function_loss_area', target_function=.9, ga_population=16, ga_generations=20)

LABELS = {'id_order': '编号顺序基准', 'importance': '功能增益/工时排序', 'ga': '遗传算法搜索'}

def parameters(values):
    result = {key: values.get(key, default) for key, default in DEFAULTS.items()}
    # A cleared/blank optional field means that no crew count was specified.
    # Preserve explicit counts, while still rejecting zero, booleans and text.
    if result['team_count'] is None:
        result['team_count'] = DEFAULTS['team_count']
    count = result['team_count']
    if type(count) is not int or not 1 <= count <= 50:
        raise ValueError('工程队数量须为 1～50 的整数；未指定时默认 1 支。')
    for key, lo, hi in [('daily_work_hours', 1, 24), ('team_efficiency', .1, 10), ('target_function', .01, 1)]:
        value = result[key]
        if type(value) not in (int, float) or not math.isfinite(value) or not lo <= value <= hi:
            raise ValueError(f'{key} 须为 {lo}～{hi} 的有限数值。')
    for key, lo, hi in [('ga_population', 4, 64), ('ga_generations', 1, 100)]:
        if type(result[key]) is not int or not lo <= result[key] <= hi:
            raise ValueError(f'{key} 须为 {lo}～{hi} 的整数。')
    if result['repair_objective'] not in {'function_loss_area', 'target_time'}:
        raise ValueError('优化目标仅支持累计功能损失最小或达到目标功能的时间最短。')
    return result

