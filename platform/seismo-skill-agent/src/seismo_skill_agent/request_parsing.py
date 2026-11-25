from __future__ import annotations

import re
from typing import Any


_NUMBER = r"(?:\d+(?:\.\d+)?|\.\d+)"
_PGA_VALUE = re.compile(rf"(?<![\d.])(?P<value>{_NUMBER})\s*[gG](?![A-Za-z])")
_PGA_NAMED = re.compile(rf"\bPGA\b\s*(?:为|=|:|：)?\s*(?P<value>{_NUMBER})(?![\d.]|\s*[gG])", re.I)
_PGA_RANGE = re.compile(rf"{_NUMBER}\s*[gG]?\s*(?:至|到|—|–|-|~|～)\s*{_NUMBER}\s*[gG](?![A-Za-z])")
_CREW = r"(?P<n>\d+|[一二两三四五六七八九]?十[一二三四五六七八九]?|[零一二两三四五六七八九])"


def _crew_number(value: str) -> int:
    if value.isdecimal():
        return int(value)
    digits = {char: idx for idx, char in enumerate("零一二三四五六七八九")}
    digits["两"] = 2
    if "十" in value:
        left, right = value.split("十", 1)
        return 10 * digits.get(left, 1) + digits.get(right, 0)
    return digits[value]


def extract_scenario_selection(user_message: str) -> dict[str, Any] | None:
    """Compatibility utility; power execution uses one explicit pga_g per run."""
    values = list(dict.fromkeys(float(m["value"]) for p in (_PGA_VALUE, _PGA_NAMED) for m in p.finditer(user_message)))
    return {"pga_values_g": values} if values else None


def unsupported_request_details(message: str) -> list[str]:
    issues = []
    selection = extract_scenario_selection(message)
    if _PGA_RANGE.search(message) or selection and len(selection["pga_values_g"]) > 1:
        issues.append("当前每轮电力模型只接受一个明确PGA；请将多强度比较拆成独立任务或明确本轮强度。")
    if re.search(r"(?:\bmcs\b|蒙特卡洛|monte carlo|\d+\s*个样本|样本数)", message, re.I):
        issues.append("当前电力模型支持最大概率状态或固定种子单次抽样，不支持多样本蒙特卡洛风险统计。")
    if re.search(r"快速模式|快速(?:损伤|功能|震害)?评估|混合模式|混合评估|\b(?:rapid|hybrid)\s+(?:mode|assessment)", message, re.I):
        issues.append("当前电力案例尚未接入快速/混合观测评估；请选择最大概率状态或固定种子单次抽样。")
    if re.search(r"(?:最多|上限|不超过|at most|no more than)\s*" + _CREW + r"\s*(?:支|个|crews?\b|teams?\b)", message, re.I):
        issues.append("本模型以投入队伍数量和任务允许队伍执行排程，独立资源总上限需结构化确认，不能直接当作投入数量。")
    if re.search(r"(?:全部|所有|全网|all).{0,15}(?:\d+\s*天内|第\s*\d+\s*天|deadline|完工期限)", message, re.I):
        issues.append("当前原生优化器没有系统总完工期限字段；请明确是否改用受支持的队伍/任务约束或另作期限可行性核验。")
    return issues


def extract_explicit_request_parameters(message: str) -> dict[str, Any]:
    """Bind explicit supported values without inventing model capabilities."""
    text = message.lower()
    patch = {}
    selection = extract_scenario_selection(message)
    if selection and len(selection["pga_values_g"]) == 1 and not _PGA_RANGE.search(message):
        patch["pga_g"] = selection["pga_values_g"][0]
    if re.search(r"最大概率|最可能损伤|most[_ ]likely", text):
        patch["power_damage_mode"] = "most_likely"
    if re.search(r"概率抽样|随机抽样|单次抽样|固定种子.*抽样|\bsampled\b", text):
        patch["power_damage_mode"] = "sampled"
    for field, pattern in (
        ("seed", r"(?:随机种子|种子|\bseed)\s*(?:为|设为|[:=])?\s*(?P<n>\d+)"),
        ("ga_population", r"(?:种群(?:数量|大小)?|population)\s*(?:为|设为|[:=])?\s*(?P<n>\d+)"),
        ("ga_generations", r"(?:迭代|generations?)\s*(?:为|设为|[:=])?\s*(?P<n>\d+)\s*(?:代)?"),
    ):
        values = {int(m["n"]) for m in re.finditer(pattern, text)}
        if len(values) == 1:
            patch[field] = values.pop()
    crew = re.finditer(rf"(?:投入|安排|采用|使用|用|deploy\s+|use\s+)\s*{_CREW}\s*(?:支|个|crews?\b|teams?\b)", text)
    counts = {_crew_number(m["n"]) for m in crew}
    if len(counts) == 1:
        patch["team_count"] = counts.pop()
    hours = {float(m["n"]) for m in re.finditer(rf"(?:每天|每日|daily)\s*(?:工作|工时|work)?\s*(?P<n>{_NUMBER})\s*(?:小时|h\b|hours?)", text)}
    if len(hours) == 1:
        patch["daily_work_hours"] = hours.pop()
    efficiency = {float(m["n"]) for m in re.finditer(rf"(?:队伍效率|施工效率|team_efficiency)\s*(?:为|设为|[:=])?\s*(?P<n>{_NUMBER})", text)}
    if len(efficiency) == 1:
        patch["team_efficiency"] = efficiency.pop()
    targets = {float(m["n"]) / 100 for m in re.finditer(rf"(?:恢复(?:到|至)?|达到|目标(?:功能)?|target(?: function)?)\s*(?:震前(?:供电|功能)?的?)?\s*(?P<n>{_NUMBER})\s*[%％]", text)}
    if len(targets) == 1:
        patch["target_function"] = targets.pop()
    if re.search(r"累计功能损失(?:最小|最少)|function_loss_area", text):
        patch["repair_objective"] = "function_loss_area"
    elif re.search(r"达(?:到|标).*时间(?:最短|最小)|target_time", text):
        patch["repair_objective"] = "target_time"
    return patch


def needs_comparison_scope(message: str, parameters: dict[str, Any]) -> bool:
    if "pga_g" not in parameters:
        return False
    return bool(re.search(r"比较|对比|对照|并排|\bcompar(?:e|ison)\b", message, re.I)) and not bool(re.search(
        r"损伤|易损|供电|功率|潮流|停电|人口|修复|恢复|工期|韧性|报告|完整评估|damage|supply|power|outage|population|repair|recovery|resilience|report", message, re.I))


def explicitly_excludes_full_report(message: str) -> bool:
    return bool(re.search(r"(?:无需|不需(?:要)?|不要|不用|不(?:生成|出|做|提交))\s*(?:一份\s*)?(?:完整|综合|全套)(?:韧性)?报告|\b(?:no|without|skip|do not (?:produce|generate|write))\s+(?:(?:a|the)\s+)?(?:full|complete|comprehensive)\s+(?:resilience\s+)?report\b", message, re.I))


def requires_full_resilience_report(user_message: str, requested_outputs: list[str], target_skill_ids: list[str]) -> bool:
    return not explicitly_excludes_full_report(user_message) and bool(re.search(
        r"完整报告|综合报告|韧性报告|完整(?:抗震)?韧性评估|full report|complete report|comprehensive report|resilience report|full resilience assessment", user_message, re.I))


def explicitly_requests_resilience_quantification(message: str) -> bool:
    if re.search(r"(?:不|不需要|无需|不要)\s*(?:再)?(?:量化|计算|评估).{0,8}韧性|do not.*resilience", message, re.I):
        return False
    return bool(re.search(r"(?:量化|计算|测算|对比|比较|评估|给出|报告)[^。！？；]{0,55}韧性|(?:quantify|compute|calculate|assess|report).*resilience", message, re.I))


def explicit_partial_target_skill_ids(user_message: str) -> list[str]:
    text = user_message.lower()
    negative_recovery = bool(re.search(r"(?:暂不|不|不要|无需|不用|不必)\s*(?:跑|做|计算|执行|安排|开展|进行)?\s*(?:恢复|修复|抢修)|(?:do not|don't|no|without)\s+(?:run\s+)?(?:recovery|repairs?|restoration)", text))
    if not negative_recovery and not re.search(r"只(?:需|需要)?(?:评估|分析|输出|计算|看|给出)|仅(?:需|需要)?(?:评估|分析|输出|计算|看)|only (?:assess|analy[sz]e|compute|show)|(?:assessment|analysis|damage|supply) only", text):
        return []
    bounded = re.findall(r"(?:只|仅)(?:需|需要)?(?:评估|分析|计算|输出|给出|看)?[^，。；;]*", text)
    scoped = " ".join(bounded) if bounded else re.split(r"\b(?:and\s+)?(?:do\s+not|without)\b", text, maxsplit=1)[0]
    if negative_recovery:
        scoped = re.split(r"(?:但|，|；|。)?(?:暂不|不要|无需|不用|不必|不)\s*(?:跑|做|计算|执行|安排|开展|进行)?\s*(?:恢复|修复|抢修)", scoped, maxsplit=1)[0]
    patterns = (
        ("power_system.input_preparation", r"数据清单|输入检查|电网清单|inventory|input preparation"),
        ("power_system.damage_assessment", r"损伤|易损性|受损|damage|fragility"),
        ("power_system.function_assessment", r"供电|潮流|supply|power flow|function"),
        ("power_system.outage_impact", r"停电范围|人口影响|停电影响|outage impact|affected population"),
        ("power_system.recovery_optimization", r"恢复优化|修复顺序|抢修顺序|队伍排程|抢修排程|recovery optimization|repair order|repair schedule"),
        ("power_system.recovery_assessment", r"基础恢复|依次修复|并行修复|basic recovery"),
        ("power_system.resilience_assessment", r"韧性指标|韧性指数|韧性量化|resilience (?:index|assessment|quantification)"),
    )
    return [skill for skill, pattern in patterns if re.search(pattern, scoped, re.I)]
