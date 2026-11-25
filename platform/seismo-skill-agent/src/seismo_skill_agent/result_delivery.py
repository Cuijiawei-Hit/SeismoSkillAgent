"""Presentation and files built from saved electricity Skill outputs."""
from __future__ import annotations
from copy import deepcopy
from datetime import datetime, timezone
import json
import math
import re
from pathlib import Path
import threading
from typing import Any
import matplotlib
matplotlib.use("Agg")
from matplotlib.figure import Figure
from matplotlib import rcParams
from docx import Document
from docx.shared import Inches, Pt
from docx.oxml.ns import qn
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from engineering_skills.core.artifacts import artifact_ref, write_json
from engineering_skills.core.models import ArtifactRef
from engineering_skills.power.metric_standard import metric_standard_record

rcParams.update({"font.family": "sans-serif", "font.sans-serif": ["Microsoft YaHei", "DejaVu Sans"], "axes.unicode_minus": False})
_PLOT_LOCK = threading.Lock()
TITLES = {
 "input_preparation": ("电网与地震输入", "Grid and earthquake inputs"),
 "damage_assessment": ("设备与线路损伤", "Asset and line damage"),
 "function_assessment": ("电网供电功能", "Grid electricity supply"),
 "recovery_assessment": ("基础恢复过程", "Basic restoration"),
 "recovery_optimization": ("修复策略与工程队排程", "Repair strategies and crew scheduling"),
 "resilience_assessment": ("电力系统韧性", "Electricity-system resilience"),
 "outage_impact": ("停电范围与人口影响", "Outage footprint and population impact"),
 "result_reporting": ("完整评估汇总", "Complete assessment summary")}
LABELS = {
 "id": ("编号", "ID"), "name": ("名称", "Name"), "key": ("组件编号", "Asset key"), "group": ("组件类型", "Asset group"),
 "state": ("损伤状态", "Damage state"), "damage_state": ("损伤状态", "Damage state"), "function": ("功能比例", "Function ratio"),
 "team": ("工程队", "Crew"), "rank": ("次序", "Order"), "start_day": ("开工/天", "Start/day"), "end_day": ("完工/天", "Finish/day"),
 "time": ("时间/天", "Time/day"), "total_days": ("全部完工/天", "Completion/day"), "target_time_days": ("目标达标/天", "Target time/day"),
 "resilience_index": ("韧性指数", "Resilience index"), "loss_area_days": ("功能损失面积/天", "Loss area/day"),
 "comparison_horizon_days": ("共同评价期/天", "Common horizon/day"), "repair_hours": ("修复工时/h", "Repair work/h"),
 "pre_supply_mw": ("震前供电/MW", "Pre-event supply/MW"), "post_supply_mw": ("震后供电/MW", "Post-event supply/MW"),
 "function_ratio": ("供电保有率", "Supply ratio"), "unserved_mw": ("缺供功率/MW", "Unserved power/MW"),
 "node_count": ("电网节点", "Grid nodes"), "branch_count": ("电网支路", "Grid branches"), "generator_count": ("电源条目", "Generation entries"),
 "damaged_count": ("受损组件", "Damaged assets"), "pga_g": ("PGA/g", "PGA/g"), "seed": ("随机种子", "Random seed"),
 "field": ("来源字段", "Source field"), "metric": ("指标", "Metric"), "value": ("数值", "Value"), "unit": ("单位", "Unit")}

IMPACT_METRICS = {
 "study_population": ("研究区人口", "Study-area population", "人"),
 "mapped_population": ("已映射人口", "Mapped population", "人"),
 "unmapped_population": ("未映射人口", "Unmapped population", "人"),
 "population_coverage_ratio": ("人口映射覆盖率", "Population coverage ratio", ""),
 "population_values_complete": ("人口数值完整", "Population values complete", ""),
 "mapped_area_km2": ("已映射面积", "Mapped area", "km²"),
 "unmapped_area_km2": ("未映射面积", "Unmapped area", "km²"),
 "population_unknown_area_km2": ("人口未知区域面积", "Area with unknown population", "km²"),
 "full_outage_population": ("完全停电人口", "Population with full outage", "人"),
 "affected_population_equivalent": ("等效受影响人口", "Equivalent affected population", "人"),
 "affected_population_equivalent_lower_bound": ("等效受影响人口下界", "Equivalent affected population lower bound", "人"),
 "affected_population_equivalent_upper_bound": ("等效受影响人口上界", "Equivalent affected population upper bound", "人"),
 "unknown_population": ("供电状态未知人口", "Population with unknown supply status", "人"),
 "outage_area_km2": ("停电影响面积", "Outage area", "km²"),
 "full_outage_area_km2": ("完全停电面积", "Full-outage area", "km²"),
 "unknown_supply_area_km2": ("供电状态未知面积", "Area with unknown supply status", "km²"),
 "observation_start_hours": ("观察起始时刻", "Observation start", "h"),
 "observation_end_hours": ("观察结束时刻", "Observation end", "h"),
 "observed_duration_hours": ("观察时长", "Observed duration", "h"),
 "full_outage_person_hours": ("累计完全停电人时", "Cumulative full-outage person-hours", "人·h"),
 "partial_outage_person_hours_equivalent": ("累计部分停电等效人时", "Cumulative partial-outage equivalent person-hours", "人·h"),
 "outage_person_hours_equivalent": ("累计停电等效人时", "Cumulative outage equivalent person-hours", "人·h"),
 "unknown_person_hours": ("供电状态未知人时", "Person-hours with unknown supply status", "人·h"),
 "unmapped_person_hours": ("未映射人时", "Unmapped person-hours", "人·h"),
 "peak_affected_population_equivalent": ("峰值等效受影响人口", "Peak equivalent affected population", "人"),
 "peak_full_outage_population": ("峰值完全停电人口", "Peak population with full outage", "人")}

def _tr(language, zh, en): return en if language == "en-US" else zh
def _title(skill_id, language): return TITLES.get(skill_id.rsplit(".", 1)[-1], (skill_id, skill_id))[language == "en-US"]
def _rows(value):
    if isinstance(value, list): return [r for r in value if isinstance(r, dict)]
    if isinstance(value, dict): return [{"id": str(k), **(v if isinstance(v, dict) else {"value": v})} for k, v in value.items()]
    return []
def _stage(nodes, stage):
    data = nodes.get("power_system." + stage, {})
    return data.get("data", data) if isinstance(data, dict) else {}
def _data(nodes, stage, key):
    value = _stage(nodes, stage)
    result = value.get(key, value.get("summary", {}))
    return deepcopy(result) if isinstance(result, dict) else {}
def _format(value):
    if value is None: return "—"
    if isinstance(value, float): return f"{value:.6g}" if math.isfinite(value) else "—"
    if isinstance(value, (dict, list)): return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)

def power_summary(node_results, requested=None, *, language="zh-CN"):
    inventory = _data(node_results, "input_preparation", "inventory")
    requested = requested or list(node_results)
    metadata = {}
    for value in node_results.values():
        if isinstance(value, dict):
            value = {**(value.get("summary") or {}), **value}
            metadata.update({k: value[k] for k in ("dataset_fingerprint", "pga_g", "power_damage_mode", "seed", "damage_scenario_fingerprint", "comparison_horizon_days") if k in value})
    recovery = _data(node_results,"recovery_optimization","recovery")
    strategies = _rows(recovery.get("strategies"))
    chosen = next((s for s in strategies if s.get("id")==recovery.get("recommended_strategy")), strategies[0] if strategies else {})
    if chosen.get("comparison_horizon_days") is not None: metadata["comparison_horizon_days"] = chosen["comparison_horizon_days"]
    return {**metadata,
      "schema_version": "power_result_v1", "target_system": "power_system", "city": inventory.get("city", "奥克兰"),
      "metric_standard": metric_standard_record(), "model_profile": "power_dc_v1",
      "dataset_fingerprint": metadata.get("dataset_fingerprint"),
      "dataset_version": inventory.get("version_id", inventory.get("version", inventory.get("dataset_version"))),
      "scenario_ids": [f"{metadata['pga_g']:g}g"] if metadata.get("pga_g") is not None else [],
      "primary_strategy": chosen.get("id"), "team_count": recovery.get("parameters",{}).get("team_count"),
      "result_scope": "full" if "power_system.result_reporting" in requested else "multi_target" if len(requested) > 1 else "partial",
      "requested_skill_ids": requested, "executed_components": list(node_results), "assessment_mode": "predictive", "output_language": language,
      "node_count": inventory.get("node_count", 0), "branch_count": inventory.get("branch_count", 0), "generator_count": inventory.get("generator_count", 0),
      "network": inventory.get("network", {}), "inventory": inventory,
      "damage": _data(node_results, "damage_assessment", "damage"), "function": _data(node_results, "function_assessment", "function"),
      "recovery": _data(node_results, "recovery_optimization", "recovery"),
      "basic_recovery": _data(node_results, "recovery_assessment", "basic_recovery") or _data(node_results, "recovery_assessment", "recovery"),
      "resilience": _data(node_results, "resilience_assessment", "resilience"), "impact": _data(node_results, "outage_impact", "impact")}

def compact_power_interpretation(summary):
    """Select saved stage facts without network geometry or per-event tables."""
    def pick(value, keys):
        return {key:deepcopy(value[key]) for key in keys if key in value}
    def scalar_metrics(value):
        return {key:deepcopy(item) for key,item in (value or {}).items() if item is None or isinstance(item,(str,int,float,bool))}
    strategy_keys=("id","name","total_days","target_time_days","target_reached","final_function","loss_area_days","comparison_horizon_days","resilience_index","unserved_energy_mwh_relative_to_intact","finite_team_schedule")
    payload=pick(summary,("schema_version","target_system","city","metric_standard","model_profile","dataset_fingerprint","dataset_version","pga_g","power_damage_mode","seed","damage_scenario_fingerprint","comparison_horizon_days","primary_strategy","team_count","result_scope","requested_skill_ids","executed_components","assessment_mode","output_language","node_count","branch_count","generator_count"))
    inventory=summary.get("inventory") or {}
    payload["inventory"]=pick(inventory,("city","region","title","dataset_id","version_id","revision","node_count","branch_count","generator_count","total_demand_mw","source_note","assumptions","power_profile","impact_available","dataset_fingerprint"))
    damage=summary.get("damage") or {}
    payload["damage"]=pick(damage,("node_count","branch_count","damaged_node_count","damaged_branch_count","damaged_count","probabilities_valid","assumptions","pga_g","power_damage_mode","seed","damage_scenario_fingerprint"))
    payload["damage"]["asset_table_rows"]={}
    payload["damage"]["state_counts"]={}
    for group in ("nodes","branches"):
        rows=_rows(damage.get(group));counts={}
        for row in rows:
            state=str(row.get("state",row.get("damage_state","unknown")))
            counts[state]=counts.get(state,0)+1
        payload["damage"]["asset_table_rows"][group]=len(rows)
        payload["damage"]["state_counts"][group]=counts
    function=summary.get("function") or {}
    payload["function"]=pick(function,("pre_supply_mw","post_supply_mw","function_ratio","unserved_mw","requested_demand_mw","intact_unserved_mw","scenario_digest","pga_range_g","assumptions"))
    payload["function"]["diagnostics"]=scalar_metrics(function.get("diagnostics"))
    for field in ("basic_recovery","recovery","resilience"):
        stage=summary.get(field) or {}
        payload[field]=pick(stage,("recommended_strategy","initial_function","initial_loss","state_evaluations","search_limits","legacy_grades","scenario_digest","assumptions"))
        if "parameters" in stage:
            payload[field]["parameters"]=pick(stage["parameters"],("team_count","daily_work_hours","team_efficiency","repair_objective","target_function","ga_population","ga_generations","repair_constraints"))
        payload[field]["strategies"]=[pick(strategy,strategy_keys) for strategy in _rows(stage.get("strategies",stage.get("curves",[])))]
    impact=summary.get("impact") or {}
    payload["impact"]=pick(impact,("title","analysis_mode","recommended_strategy","scenario_digest","assumptions"))
    for field in ("initial_summary","metrics","coverage"):
        payload["impact"][field]=scalar_metrics(impact.get(field))
    payload["impact"]["strategies"]=[]
    for strategy in _rows(impact.get("strategies")):
        compact=pick(strategy,("id","name"))
        for field in ("initial_summary","metrics","coverage"):
            compact[field]=scalar_metrics(strategy.get(field))
        timeline=_rows(strategy.get("timeline"))
        compact["completion_summary"]=scalar_metrics(strategy.get("completion_summary") or (timeline[-1] if timeline else {}))
        payload["impact"]["strategies"].append(compact)
    return payload

def _table(table_id, title, rows, language):
    keys = list(dict.fromkeys(k for r in rows for k,v in r.items() if v is None or isinstance(v, (str,int,float,bool))))
    return {"table_id": table_id, "title": title, "columns": [{"key":k, "label":LABELS.get(k,(k,k))[language=="en-US"], "format":"auto"} for k in keys], "rows":rows}

def _impact_strategy_tables(strategy, language):
    sid=str(strategy.get("id","strategy"));name=str(strategy.get("name") or sid)
    selections={
      "coverage":("study_population","mapped_population","unmapped_population","population_coverage_ratio","population_values_complete","mapped_area_km2","unmapped_area_km2","population_unknown_area_km2"),
      "initial_summary":("affected_population_equivalent","full_outage_population","outage_area_km2","full_outage_area_km2","unknown_population","unmapped_population","unknown_supply_area_km2","affected_population_equivalent_lower_bound","affected_population_equivalent_upper_bound","population_coverage_ratio","population_values_complete"),
      "metrics":("outage_person_hours_equivalent","full_outage_person_hours","partial_outage_person_hours_equivalent","unknown_person_hours","unmapped_person_hours","observation_start_hours","observation_end_hours","observed_duration_hours","peak_affected_population_equivalent","peak_full_outage_population","population_values_complete")}
    titles={"coverage":("人口与面积覆盖","Population and area coverage"),"initial_summary":("初始停电影响","Initial outage impact"),"metrics":("累计停电影响","Cumulative outage impact")}
    tables=[]
    for field,keys in selections.items():
        values=strategy.get(field) or {};rows=[]
        for key in keys:
            if key not in values:continue
            zh,en,unit=IMPACT_METRICS[key]
            if language=="en-US":unit={"人":"people","人·h":"person·h"}.get(unit,unit)
            rows.append({"field":field+"."+key,"metric":_tr(language,zh,en),"value":deepcopy(values[key]),"unit":unit})
        if rows:tables.append(_table("impact_"+sid+"_"+field,name+" / "+_tr(language,*titles[field]),rows,language))
    return tables

def project_sections(node_results, requested, *, output_language="zh-CN"):
    summary = power_summary(node_results, requested, language=output_language)
    fields = {"input_preparation":"inventory", "damage_assessment":"damage", "function_assessment":"function", "recovery_assessment":"basic_recovery", "recovery_optimization":"recovery", "resilience_assessment":"resilience", "outage_impact":"impact"}
    ids = list(node_results) if "power_system.result_reporting" in requested else requested
    sections = []
    for skill_id in ids:
        stage = skill_id.rsplit(".",1)[-1]
        if stage not in fields: continue
        data = summary[fields[stage]]
        metrics = [{"key":k, "label":LABELS.get(k,(k.replace("_"," "),k.replace("_"," ")))[output_language=="en-US"], "value":v, "unit":"", "format":"auto"} for k,v in data.items() if (v is None or isinstance(v,(str,int,float,bool))) and k not in {"path","schema_version"}]
        section = {"skill_id":skill_id, "title":_title(skill_id,output_language), "metrics":metrics, "tables":[], "notes":[], "figure_names":[]}
        if stage == "input_preparation":
            section["tables"].append(_table("nodes",_tr(output_language,"电网节点","Grid nodes"),_rows(summary["network"].get("nodes")),output_language))
        elif stage == "damage_assessment":
            for key in ("nodes","branches"):
                section["tables"].append(_table("damage_"+key,_tr(output_language,"节点损伤" if key=="nodes" else "支路损伤","Node damage" if key=="nodes" else "Branch damage"),_rows(data.get(key)),output_language))
        elif stage in {"recovery_assessment","recovery_optimization","resilience_assessment"}:
            strategies = _rows(data.get("strategies",data.get("curves",[])))
            section["tables"].append(_table("strategies",_tr(output_language,"策略对照","Strategy comparison"),strategies,output_language))
            for s in strategies:
                sid = str(s.get("id","strategy"))
                for key in ("schedule","curve"):
                    rows = _rows(s.get(key))
                    if rows: section["tables"].append(_table(sid+"_"+key,sid+" / "+key,rows,output_language))
        elif stage == "function_assessment":
            section["tables"].append(_table("node_supply",_tr(output_language,"节点供电","Node supply"),_rows(data.get("node_supply_mw")),output_language))
        elif stage == "outage_impact":
            for field in ("initial_summary", "metrics", "coverage"):
                metrics_data = data.get(field, {})
                section["metrics"].extend({"key":field+"."+k, "label":k, "value":v, "unit":"", "format":"auto"} for k,v in metrics_data.items() if v is None or isinstance(v,(str,int,float,bool)))
            section["notes"].append(_tr(output_language,"人口影响来自有来源的供电分区和人口层，未知范围单独保留。","Population impact uses sourced supply areas and population layers; unknown areas remain explicit."))
            for key in ("strategies","areas","service_areas"):
                if _rows(data.get(key)): section["tables"].append(_table("impact_"+key,key,_rows(data[key]),output_language))
            for s in _rows(data.get("strategies")):
                section["tables"].extend(_impact_strategy_tables(s,output_language))
                if _rows(s.get("timeline")): section["tables"].append(_table("impact_"+str(s.get("id"))+"_timeline",str(s.get("id"))+" / population timeline",_rows(s.get("timeline")),output_language))
        sections.append(section)
    return sections

def _coordinates(row):
    for x,y in (("longitude","latitude"),("lon","lat"),("lng","lat"),("x","y")):
        if row.get(x) is not None and row.get(y) is not None:
            try: return float(row[x]),float(row[y])
            except (ValueError,TypeError): pass
    coords = row.get("coordinates") or (row.get("geometry") or {}).get("coordinates")
    if isinstance(coords,list) and len(coords)==2: return float(coords[0]),float(coords[1])
    return None

def _write_figures(directory, summary, language):
    figures = {}; network = summary.get("network") or {}
    points = {str(n.get("id",n.get("node_id",""))):_coordinates(n) for n in _rows(network.get("nodes"))}
    points = {k:v for k,v in points.items() if v is not None}
    with _PLOT_LOCK:
        if points:
            fig=Figure(figsize=(9,6)); ax=fig.subplots()
            for link in _rows(network.get("links",network.get("branches"))):
                a=str(link.get("source",link.get("from",link.get("from_node",link.get("from_bus","")))))
                b=str(link.get("target",link.get("to",link.get("to_node",link.get("to_bus","")))))
                if a in points and b in points: ax.plot([points[a][0],points[b][0]],[points[a][1],points[b][1]],color="#a6b6c4",linewidth=.65,zorder=1)
            ax.scatter([p[0] for p in points.values()],[p[1] for p in points.values()],s=12,color="#237f89",zorder=2)
            ax.set(xlabel=_tr(language,"经度","Longitude"),ylabel=_tr(language,"纬度","Latitude"),title=_tr(language,"奥克兰电网节点与支路","Auckland grid nodes and branches")); ax.grid(alpha=.15);fig.tight_layout()
            path=directory/"power_network.png";fig.savefig(path,dpi=160);figures["network"]=path
        strategies=_rows((summary.get("recovery") or summary.get("basic_recovery") or {}).get("strategies"))
        if any(_rows(s.get("curve")) for s in strategies):
            fig=Figure(figsize=(9,5));ax=fig.subplots()
            for s in strategies:
                curve=_rows(s.get("curve"))
                if curve: ax.step([p.get("time",p.get("time_day",0)) for p in curve],[p.get("function",p.get("functionality",0)) for p in curve],where="post",label=str(s.get("id","")))
            ax.set(xlabel=_tr(language,"震后时间/天","Time after earthquake/day"),ylabel=_tr(language,"相对震前供电功能","Supply relative to pre-event baseline"),ylim=(0,1.03));ax.legend();ax.grid(alpha=.2);fig.tight_layout()
            path=directory/"power_recovery.png";fig.savefig(path,dpi=160);figures["recovery"]=path
        supply=summary.get("function") or {}
        if supply.get("pre_supply_mw") is not None and supply.get("post_supply_mw") is not None:
            fig=Figure(figsize=(7,4));ax=fig.subplots();ax.bar([_tr(language,"震前","Pre-event"),_tr(language,"震后","Post-event")],[supply["pre_supply_mw"],supply["post_supply_mw"]],color=["#237f89","#cb7050"]);ax.set(ylabel="MW",title=_tr(language,"供电功率对照","Electricity supply comparison"));fig.tight_layout()
            path=directory/"power_supply.png";fig.savefig(path,dpi=160);figures["supply"]=path
    return figures

def _write_excel(path,bundle):
    book=Workbook();overview=book.active;overview.title="Overview";overview.append(["PowerSkillAgent",bundle["report_title"]]);overview.append(["Objective",bundle["objective"]]);overview.append(["Run",bundle["run_id"]]);overview.append(["Presentation instructions",bundle.get("presentation_instructions") or ""]);index=0
    for section in bundle["sections"]:
        overview.append([section["title"]])
        for m in section["metrics"]: overview.append([m["label"],_format(m["value"])])
        for table in section["tables"]:
            if not table["columns"]: continue
            index+=1;sheet=book.create_sheet((f"{index:02d}_"+table["table_id"])[:31]);sheet.append([c["label"] for c in table["columns"]])
            for row in table["rows"]: sheet.append([row.get(c["key"]) if not isinstance(row.get(c["key"]),(dict,list)) else _format(row[c["key"]]) for c in table["columns"]])
    for sheet in book:
        sheet.freeze_panes="A2";sheet.auto_filter.ref=sheet.dimensions
        for cell in sheet[1]: cell.font=Font(bold=True,color="FFFFFF");cell.fill=PatternFill("solid",fgColor="237F89")
        for column in sheet.columns: sheet.column_dimensions[column[0].column_letter].width=min(60,max(15,max(len(str(c.value or "")) for c in column[:200])+2))
    book.save(path)

def _write_word(path,bundle,figures):
    language=bundle["output_language"];doc=Document();section=doc.sections[0];section.page_width=Inches(8.27);section.page_height=Inches(11.69);section.left_margin=section.right_margin=Inches(.75)
    style=doc.styles["Normal"];style.font.name="Arial";style.font.size=Pt(10);style.element.rPr.rFonts.set(qn("w:eastAsia"),"Microsoft YaHei");doc.core_properties.author="PowerSkillAgent"
    doc.core_properties.title=bundle["report_title"]
    doc.add_heading(bundle["report_title"],0);doc.add_paragraph(bundle["objective"]);doc.add_paragraph("Run: "+bundle["run_id"]);doc.add_paragraph(bundle["narrative"])
    if bundle.get("presentation_instructions"):
        doc.add_paragraph(_tr(language,"本次呈现要求：","Presentation instructions: ")+bundle["presentation_instructions"])
    row_limit=bundle.get("word_table_row_limit",40)
    for image in figures.values(): doc.add_picture(str(image),width=Inches(6.6))
    for part in bundle["sections"]:
        doc.add_heading(part["title"],1)
        for m in part["metrics"]: doc.add_paragraph(f"{m['label']}：{_format(m['value'])}")
        for table in part["tables"]:
            if not table["columns"] or not table["rows"]: continue
            columns=table["columns"][:8];doc.add_heading(table["title"],2);tab=doc.add_table(rows=1,cols=len(columns));tab.style="Light Shading Accent 1"
            for cell,col in zip(tab.rows[0].cells,columns): cell.text=col["label"]
            for row in table["rows"][:row_limit]:
                for cell,col in zip(tab.add_row().cells,columns): cell.text=_format(row.get(col["key"]))
            if len(table["rows"])>row_limit or len(table["columns"])>8: doc.add_paragraph(_tr(language,f"本表节选前{row_limit}行及前8列；完整{len(table['rows'])}行、{len(table['columns'])}列见Excel和JSON。",f"Excerpt: up to {row_limit} rows and 8 columns. Complete {len(table['rows'])} rows and {len(table['columns'])} columns are retained in Excel and JSON."))
    doc.add_heading(_tr(language,"来源、约束与计算记录","Sources, constraints and execution record"),1)
    for value in bundle.get("assumptions",[]): doc.add_paragraph(str(value))
    for value in bundle.get("warnings",[]): doc.add_paragraph(str(value.get("message",value) if isinstance(value,dict) else value))
    doc.add_paragraph(_tr(language,"采用绑定的奥克兰电网版本及本轮显式PGA。抽样损伤为可复现情景，所有策略复用同一损伤情景。","The bound Auckland grid version and explicit PGA are used. Sampled damage is a reproducible scenario shared by all strategies."));doc.save(path)

class ResultDeliveryBuilder:
    schema_version="power_delivery_v1"
    def build(self,*,run_directory:Path,run_id:str,objective:str,assessment_mode:str|None,output_language:str,requested_skill_ids:list[str],execution_target_skill_ids:list[str],executed_components:list[str],node_results:dict,node_trace:list,source_artifacts:list,warnings:list,assumptions:list,report_title:str|None=None,presentation_instructions:str|None=None)->tuple[dict,list[ArtifactRef]]:
        requested=list(dict.fromkeys(requested_skill_ids or execution_target_skill_ids));summary=power_summary(node_results,requested,language=output_language)
        bundle={**summary,"schema_version":self.schema_version,"delivery_kind":"engineering_result_delivery","run_id":run_id,"objective":objective,"assessment_mode":assessment_mode,"execution_target_skill_ids":execution_target_skill_ids,"executed_components":executed_components,"sections":project_sections(node_results,requested,output_language=output_language),"warnings":warnings,"assumptions":assumptions,"execution_trace":node_trace,"generated_at":datetime.now(timezone.utc).isoformat(),"generated_files":[]}
        reporting=_stage(node_results,"result_reporting")
        default_title=(reporting.get("summary") or {}).get("title") or reporting.get("title") or _tr(output_language,"奥克兰电力系统抗震韧性评估","Auckland Electricity System Seismic Resilience Assessment")
        bundle["report_title"]=(report_title or default_title).strip()
        bundle["presentation_instructions"]=(presentation_instructions or reporting.get("presentation_instructions") or "").strip()
        bundle["presentation_changes"]=[]
        instructions=bundle["presentation_instructions"]
        if re.search(r"按.{0,8}(?:编号|ID)|sort.{0,12}(?:id|identifier)|by (?:id|identifier)",instructions,re.I):
            def identifier_key(row):
                return tuple((0,int(part)) if part.isdigit() else (1,part.lower()) for part in re.split(r"(\d+)",str(row.get("key",row.get("id","")))))
            for part in bundle["sections"]:
                for table in part["tables"]:
                    if table["rows"] and all("id" in row or "key" in row for row in table["rows"]):table["rows"].sort(key=identifier_key)
            bundle["presentation_changes"].append("table_display_sorted_by_identifier")
        bundle["word_table_row_limit"]=12 if re.search(r"简洁|简要|精简|concise|brief",instructions,re.I) else 40
        if bundle["word_table_row_limit"]==12:bundle["presentation_changes"].append("concise_word_table_excerpts")
        bundle["narrative"]=_tr(output_language,"本轮电力分析结果按所选能力列出，计算口径与来源随结果保存。","Power analysis results are organized by the selected capabilities, with saved calculation definitions and sources.")
        if summary["function"].get("post_supply_mw") is not None: bundle["narrative"]+=_tr(output_language,f" 震后供电功率为{_format(summary['function']['post_supply_mw'])} MW。",f" Post-event supply is {_format(summary['function']['post_supply_mw'])} MW.")
        if instructions:bundle["narrative"]+=_tr(output_language," 呈现要求已随本次报告版本保存。"," Presentation instructions are retained with this report version.")
        bundle["interpretation_payload"]=compact_power_interpretation(summary)
        bundle["interpretation_payload"]["result_reporting"]={"report_title":bundle["report_title"],"presentation_instructions":instructions,"result_scope":summary["result_scope"],"executed_components":executed_components}
        directory=Path(run_directory)/"result_delivery"/"artifacts";directory.mkdir(parents=True,exist_ok=True);figures=_write_figures(directory,summary,output_language)
        workbook=directory/"engineering_results.xlsx";report=directory/"engineering_results.docx";_write_excel(workbook,bundle);_write_word(report,bundle,figures)
        trace=directory/"execution_trace.json";write_json(trace,{"run_id":run_id,"nodes":node_trace});summary_path=directory/"engineering_result_summary.json";manifest=directory/"artifact_manifest.json"
        specs=[(workbook,"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",_tr(output_language,"完整电力结果工作簿","Complete power results workbook")),(report,"application/vnd.openxmlformats-officedocument.wordprocessingml.document",_tr(output_language,"电力工程评估报告","Electricity engineering report")),(summary_path,"application/json",_tr(output_language,"结构化电力结果","Structured power results")),(trace,"application/json",_tr(output_language,"逐Skill运行记录","Per-Skill execution trace"))]
        specs.extend((image,"image/png",_tr(output_language,"电力结果图件","Power result figure")) for image in figures.values())
        bundle["generated_files"]=[{"name":p.name,"media_type":m,"description":t,"category":"figure" if m.startswith("image/") else "report" if p.suffix==".docx" else "table" if p.suffix==".xlsx" else "data"} for p,m,t in specs];bundle["figures"]={k:p.name for k,p in figures.items()};write_json(summary_path,bundle)
        refs=[artifact_ref(p,m,t) for p,m,t in specs];write_json(manifest,{"run_id":run_id,"artifacts":[r.model_dump(mode="json") for r in refs],"upstream_artifacts":source_artifacts});refs.append(artifact_ref(manifest,"application/json","Artifact manifest"));return bundle,refs
