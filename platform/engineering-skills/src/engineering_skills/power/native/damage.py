"""Frozen electric asset damage scenarios from reference fragility curves.

The default reproduces legacy modal classification. Optional sampling produces
one reproducible scenario, not an observed damage inventory or Monte Carlo risk
distribution. Recovery strategies must reuse these arrays without resampling.
"""
from __future__ import annotations

from hashlib import sha256
import json

import numpy as np
from scipy.stats import lognorm


def _curve_index(voltage, kind):
    if kind == 1:
        return 2 if voltage <= 115 else 3 if voltage <= 235 else 4
    if kind == 2:
        return 0 if voltage <= 235 else 1
    return None


def damage_probabilities(pga_g, curve, *, legacy_log_scale=False, require_valid=True):
    """Five exclusive states from ordered lognormal exceedance probabilities.

    Unequal dispersions may create crossing curves even with increasing
    medians. Such a curve is invalid for sampling at that PGA; it is not silently
    clamped or relabelled as a calibrated local model.
    """
    if isinstance(pga_g, (bool, np.bool_)) or not np.isfinite(float(pga_g)) or float(pga_g) < 0:
        raise ValueError("设备 PGA 须为非负有限数，单位 g。")
    values = np.asarray(curve, dtype=float)
    if values.shape != (8,) or not np.isfinite(values).all() or (values <= 0).any():
        raise ValueError("易损性曲线须含四个正 PGA 中值(g)和四个正对数离散参数。")
    if np.any(np.diff(values[:4]) <= 0):
        raise ValueError("易损性四级 PGA 中值须严格递增。")
    scales = np.exp(np.log(values[:4])) if legacy_log_scale else values[:4]
    exceedance = lognorm.cdf(float(pga_g), s=values[4:8], scale=scales)
    probability = np.concatenate(([1-exceedance[0]], exceedance[:-1]-exceedance[1:], [exceedance[-1]]))
    valid = bool(np.isfinite(probability).all() and probability.min() >= -1e-12 and
                 abs(probability.sum()-1.) <= 1e-12)
    if require_valid and not valid:
        raise ValueError("易损性超越曲线在当前 PGA 交叉，出现负损伤概率；不能抽样，请先核实曲线。")
    if valid:
        # Remove roundoff only; corrections above 1e-12 are explicitly rejected.
        probability = np.maximum(probability, 0.)
        probability /= probability.sum()
    return probability, exceedance, valid


def evaluate_power_damage(bus_pga, bus, branch, fragility, *, mode="most_likely", seed=0, branch_kinds=None):
    """Return legacy-named arrays plus explainable immutable scenario metadata."""
    if mode not in {"most_likely", "sampled"}:
        raise ValueError("power_damage_mode 仅支持 most_likely 或 sampled。")
    if type(seed) is not int or not 0 <= seed <= 2**64-1:
        raise ValueError("抽样 seed 须为非负整数，不能是布尔值。")
    bus = np.asarray(bus, dtype=object)
    branch = np.asarray(branch, dtype=object)
    curves = np.asarray(fragility, dtype=float)
    if bus.ndim != 2 or bus.shape[1] < 7 or len(bus) == 0:
        raise ValueError("电网 bus 须含至少七列且非空。")
    if branch.size == 0:
        branch = np.empty((0, 6))
    if branch.ndim != 2 or branch.shape[1] < 6:
        raise ValueError("电网 branch 须含至少六列。")
    if curves.ndim != 2 or curves.shape[0] < 6 or curves.shape[1] < 8:
        raise ValueError("电网易损性须覆盖原六类参考曲线的八个参数。")
    raw_pga = np.asarray(bus_pga)
    if raw_pga.shape != (len(bus),) or any(isinstance(value, (bool, np.bool_)) for value in raw_pga):
        raise ValueError("节点 PGA 须覆盖每个节点，不能是布尔值。")
    pga = np.asarray(bus_pga, dtype=float)
    if not np.isfinite(pga).all() or (pga < 0).any():
        raise ValueError("节点 PGA 须为非负有限数，单位 g。")
    explicit = branch_kinds is not None
    kinds = list(branch_kinds) if explicit else ["line"]*len(branch)
    if len(kinds) != len(branch) or any(kind not in {"line", "transformer"} for kind in kinds):
        raise ValueError("支路类别须按顺序覆盖所有支路，仅支持 line 或 transformer。")
    generator = np.random.default_rng(seed)
    statebus = np.zeros(len(bus), dtype=int)
    stateline = np.zeros(len(branch), dtype=int)
    nodes, branches = [], []
    invalid = []

    def choose(probabilities, valid):
        if mode == "sampled":
            return int(generator.choice(np.arange(1, 6), p=probabilities))
        return int(np.argmax(probabilities)) + 1

    for index, row in enumerate(bus):
        try:
            kind, voltage = float(row[2]), float(row[6])
        except (TypeError, ValueError) as error:
            raise ValueError("节点类别和电压须为有效数字。") from error
        if not np.isfinite(kind) or kind not in {0., 1., 2.} or not np.isfinite(voltage) or voltage <= 0:
            raise ValueError("节点类别须为 0/1/2，额定电压须为正有限数。")
        curve_index = _curve_index(voltage, kind)
        if kind == 0:
            probabilities, exceedance, valid = np.array([1., 0., 0., 0., 0.]), np.zeros(4), True
            state = 1
        else:
            probabilities, exceedance, valid = damage_probabilities(pga[index], curves[curve_index, :8],
                legacy_log_scale=True, require_valid=mode == "sampled")
            state = choose(probabilities, valid)
        statebus[index] = state
        identifier = str(int(float(row[0])))
        record = dict(id=identifier, pga_g=float(pga[index]), curve_index=curve_index,
            asset_type="geometry_junction_pass_through" if kind == 0 else "substation_equipment_proxy" if kind == 1 else "source_equipment_proxy",
            probabilities=probabilities.tolist() if valid else None,
            raw_state_weights=probabilities.tolist(), exceedance_probabilities=exceedance.tolist(),
            probabilities_valid=valid, state=state, function=int(state < 4))
        if not valid:
            invalid.append("node:"+identifier)
        nodes.append(record)
    for index, row in enumerate(branch):
        try:
            origin, target, voltage = float(row[1]), float(row[2]), float(row[5])
        except (TypeError, ValueError) as error:
            raise ValueError("支路端点和电压须为有效数字。") from error
        if (not np.isfinite(origin) or not np.isfinite(target) or origin != int(origin) or target != int(target) or
            not 1 <= origin <= len(bus) or not 1 <= target <= len(bus) or not np.isfinite(voltage) or voltage <= 0):
            raise ValueError("支路端点須为存在的 1-based 节点编号，电压须为正有限数。")
        u, v = int(origin)-1, int(target)-1
        local = explicit or mode == "sampled"
        demand = float((pga[u]+pga[v])/2) if local else float(pga[0])
        curve_index = (2 if voltage <= 115 else 3 if voltage <= 235 else 4) if kinds[index] == "transformer" else 5
        probabilities, exceedance, valid = damage_probabilities(demand, curves[curve_index, :8],
            legacy_log_scale=not explicit, require_valid=mode == "sampled")
        state = choose(probabilities, valid)
        stateline[index] = state
        identifier = str(int(float(row[0])))
        branches.append(dict(id=identifier, from_node=str(int(origin)), to_node=str(int(target)),
            asset_type=kinds[index], curve_index=curve_index, pga_g=demand,
            pga_basis="endpoint_mean_pga" if local else "legacy_first_node_pga",
            probabilities=probabilities.tolist() if valid else None, raw_state_weights=probabilities.tolist(),
            exceedance_probabilities=exceedance.tolist(), probabilities_valid=valid,
            state=state, function=int(state < 4)))
        if not valid:
            invalid.append("branch:"+identifier)
    function_bus, function_branch = (statebus < 4).astype(int), (stateline < 4).astype(int)
    frozen = dict(mode=mode, seed=seed if mode == "sampled" else None, node_states=statebus.tolist(),
        branch_states=stateline.tolist(), pga_g=pga.tolist(), branch_kinds=kinds,
        reference_curves=curves[:6, :8].tolist())
    assumptions = [
        "沿用项目现有六类地震易损性参考曲线；设备电压对应曲线为代理，未经当前城市当地标定。",
        "设备五态对应无损、轻微、中等、严重、完全；严重和完全损伤按不可用处理。",
        "几何连接点(type=0)保持完好通路；不作为独立变电站抽样。",
        "一次灾损状态在损伤模块生成并冻结，各恢复/应急策略必须复用同一状态，不能分别重新抽样。",
    ]
    if mode == "sampled":
        assumptions += [
            "给定 PGA 和参考曲线后，设备状态按固定 seed 条件独立抽样；未考虑设备共享结构与空间相关损伤。",
            "本轮为单个可复现随机情景，不是当地观测，也不能作为概率分布或风险分位数结论。",
            "支路 PGA 使用两个端点的均值，是无沿线地震动资料时的近似；未自动模拟场地放大与液化。",
        ]
    else:
        assumptions.append("most_likely 采用原五态最大权重分类；确定性等级不等于设备实际必然发生该级损伤。")
        if not explicit:
            assumptions.append("无显式支路建模属性时，most_likely 保留原首节点 PGA 线路口径以兼容历史结果。")
    if invalid:
        assumptions.append("参考超越曲线在当前 PGA 出现交叉，原模式保留历史最大权重等级；负权重不能解释成损伤概率，sampled 模式禁止使用。")
    metadata = dict(schema_version="engineering.power-damage-scenario.v1", mode=mode,
        seed=seed if mode == "sampled" else None, pga_unit="g", pga_range_g=[float(pga.min()), float(pga.max())],
        pga_spatial_basis="uniform_node_pga" if np.all(pga == pga[0]) else "explicit_per_node_pga",
        sampling_basis="conditional_independent_numpy_pcg64" if mode == "sampled" else "legacy_five_state_argmax",
        scenario_digest=sha256(json.dumps(frozen, sort_keys=True, allow_nan=False).encode()).hexdigest(),
        curve_source="agent/Power_system_agent/code/电力系统组件地震易损性数据.xlsx",
        reference_curves=curves[:6, :8].tolist(), locally_calibrated=False,
        probabilities_valid=not invalid, invalid_probability_assets=invalid, failure_states=[4, 5],
        nodes=nodes, branches=branches, assumptions=assumptions)
    return dict(funcbus=function_bus, statebus=statebus, funcbranch=function_branch,
                stateline=stateline, power_damage_scenario=metadata)
