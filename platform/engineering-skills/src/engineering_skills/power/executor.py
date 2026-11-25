from __future__ import annotations
from hashlib import sha256
from pathlib import Path
from types import FunctionType
import numpy as np
import pandas as pd
from engineering_skills.core.base import EngineeringSkill
from engineering_skills.core.artifacts import artifact_ref, write_json
from engineering_skills.core.models import AssessmentMode, ComponentKind, SkillDataContract, SkillExecutionOutput, SkillManifest, SkillTypeDefinition, SkillWarning
from engineering_skills.core.provenance import record_check
from . import schemas
from .data import load_dataset, load_reference, network, read_json
from .metric_standard import metric_standard_record
from .native.damage import evaluate_power_damage
from .native.optimizer import optimize, frames
from .native import legacy

PREFIX = 'power_system.'
STAGES = [
 ('input_preparation','电网与地震输入准备',None,[],[],'dataset_artifact',schemas.InputRequest,'inventory'),
 ('damage_assessment','变电站与线路损伤评估','system_fragility_analysis',['input_preparation'],['dataset_artifact'],'damage_artifact',schemas.DamageRequest,'damage'),
 ('function_assessment','供电功率与系统功能评估','functionality_degradation_analysis',['damage_assessment'],['dataset_artifact','damage_artifact'],'function_artifact',schemas.FunctionRequest,'function'),
 ('recovery_assessment','原模型依次与并行恢复评估','recovery_process_analysis',['function_assessment'],['dataset_artifact','damage_artifact','function_artifact'],'basic_recovery_artifact',schemas.BasicRecoveryRequest,'basic_recovery'),
 ('recovery_optimization','有限工程队恢复优化','recovery_optimization',['function_assessment'],['dataset_artifact','damage_artifact','function_artifact'],'recovery_artifact',schemas.RecoveryRequest,'recovery'),
 ('resilience_assessment','电力系统韧性量化','resilience_quantification',['recovery_assessment','recovery_optimization'],['function_artifact','basic_recovery_artifact','recovery_artifact'],'resilience_artifact',schemas.ResilienceRequest,'resilience'),
 ('outage_impact','停电范围与人口影响评估','service_impact_analysis',['function_assessment'],['dataset_artifact','function_artifact','recovery_artifact?'],'impact_artifact',schemas.ImpactRequest,'impact'),
 ('result_reporting','电力系统完整评估报告',None,['resilience_assessment','outage_impact'],['dataset_artifact','damage_artifact','function_artifact','basic_recovery_artifact','recovery_artifact','resilience_artifact','impact_artifact'],'report_artifact',schemas.ReportRequest,'report'),
]

def contract(name, optional=False):
 return SkillDataContract(name=name,type_id='artifact.power.'+name.removesuffix('_artifact')+'.v1',required=not optional,contract_version='1.0.0',field_types={'path':'string'})

def skill_types():
 return [SkillTypeDefinition(id=t,version='1.0.0',name=n,description=n,domain='urban_power_resilience',task=s,input_semantics=[c.rstrip('?') for c in ci],output_semantics=[co],consumes=[contract(c.rstrip('?'),c.endswith('?')) for c in ci],produces=[contract(co)],invariant_rules=['同一冻结损伤情景用于各修复策略','数值结果由已注册模型产生']) for s,n,t,d,ci,co,r,f in STAGES if t]

def value(ref):
 return read_json(ref.path)

def restored(dataset, damage, repaired):
 nodes=np.asarray(damage['funcbus'],dtype=float).copy(); lines=np.asarray(damage['funcbranch'],dtype=float).copy()
 for i in range(len(nodes)):
  if f'node:{i+1}' in repaired:nodes[i]=1
 for i in range(len(lines)):
  if f'pipe:{i+1}' in repaired:lines[i]=1
 return nodes,lines

def inventory(dataset, damage):
 jobs=[]; initial={'node':{},'pipe':{}}
 for group,functions,states,row in [('node',damage['funcbus'],damage['statebus'],0),('pipe',damage['funcbranch'],damage['stateline'],1)]:
  for i,function in enumerate(functions):
   state=int(states[i]);identifier=str(i+1);days=float(dataset['repair'][row,state-1])
   if group=='pipe':days=float(dataset['branch_repair'][i,state-1])
   description=legacy.damage_state_to_string(state)
   initial[group][identifier]={'function':float(function),'damage':description}
   if function<1:jobs.append(dict(group=group,id=identifier,function=float(function),damage=description,repair_hours=days*24))
 return jobs,initial

def input_stage(request):
 ds=load_dataset(request.dataset_source);p=ds['payload'];pr=ds['provenance']
 inv=dict(city=p.get('region',{}).get('city_name',p.get('title')),region=p.get('region',{}),title=p.get('title'),dataset_id=pr.get('dataset_id'),version_id=pr.get('version_id'),revision=pr.get('revision'),node_count=len(ds['bus']),branch_count=len(ds['branch']),generator_count=len(ds['gen']),total_demand_mw=float(np.asarray(ds['bus'][:,5],dtype=float).sum()),network=network(ds),provenance=pr,source_note=p.get('source_note'),assumptions=p.get('simulation_assumptions',[]),power_profile='core',impact_available=isinstance(p.get('power_impact'),dict))
 result=dict(kind='power_dataset',dataset_source=request.dataset_source.model_dump(mode='json'),source_sha256=sha256(ds['path'].read_bytes()).hexdigest(),inventory=inv,parameter_sources={str(ds['fragility_path']):sha256(ds['fragility_path'].read_bytes()).hexdigest(),str(ds['criteria_path']):sha256(ds['criteria_path'].read_bytes()).hexdigest()})
 return ds,result,inv,[str(ds['path']),str(ds['fragility_path']),str(ds['criteria_path'])]

def damage_stage(request):
 ds=load_reference(request.dataset_artifact);pga=np.asarray(request.node_pga_g if request.node_pga_g is not None else [request.pga_g]*len(ds['bus']),dtype=float)
 kwargs={'branch_kinds':ds['branch_kinds']} if ds['explicit_branch_kinds'] else {}
 result=evaluate_power_damage(pga,ds['bus'],ds['branch'],ds['fragility'],mode=request.power_damage_mode,seed=request.seed,**kwargs)
 result={k:v.tolist() if isinstance(v,np.ndarray) else v for k,v in result.items()};m=result['power_damage_scenario']
 summary=dict(nodes=m['nodes'],branches=m['branches'],scenario=m,node_count=len(ds['bus']),branch_count=len(ds['branch']),damaged_node_count=int(np.count_nonzero(np.asarray(result['funcbus'])<1)),damaged_branch_count=int(np.count_nonzero(np.asarray(result['funcbranch'])<1)),probabilities_valid=m['probabilities_valid'],assumptions=m['assumptions'])
 summary['damaged_count']=summary['damaged_node_count']+summary['damaged_branch_count'];result['damage']=summary
 return ds,result,summary,[str(ds['path']),str(ds['fragility_path'])]

def function_stage(request):
 ds=load_reference(request.dataset_artifact);damage=value(request.damage_artifact);flow=ds['flow']
 intact=flow.solve(np.ones(len(ds['bus'])),np.ones(len(ds['branch'])));served=flow.solve(damage['funcbus'],damage['funcbranch'])
 baseline=float(intact.sum());current=float(served.sum())
 if baseline<=0:raise ValueError('完好电网可供功率须为正。')
 diagnostics=flow.diagnostics(damage['funcbus'],damage['funcbranch'])
 record_check('power_balance_and_capacity',diagnostics['max_equation_residual']<1e-6 and diagnostics['max_capacity_excess_mw']<1e-6)
 result=dict(pre_supply_mw=baseline,post_supply_mw=current,function_ratio=current/baseline,unserved_mw=baseline-current,requested_demand_mw=float(flow.demand.sum()),intact_unserved_mw=float(flow.demand.sum()-baseline),node_supply_mw={str(i+1):float(v)for i,v in enumerate(served)},network_frame={**flow.map_state(damage['funcbus'],damage['funcbranch']),'time':0,'time_unit':'天'},diagnostics=diagnostics,scenario_digest=damage['power_damage_scenario']['scenario_digest'],pga_range_g=damage['power_damage_scenario']['pga_range_g'],assumptions=['同一电网、同一负荷下的完好可供功率作分母；总额定负荷另列。','MW为功率；瞬时功率缺口不等于MWh电量。'])
 return ds,result,result,[str(request.dataset_artifact.path),str(request.damage_artifact.path)]

def recovery_stage(request):
 ds=load_reference(request.dataset_artifact);damage=value(request.damage_artifact);fn=value(request.function_artifact)
 jobs,initial=inventory(ds,damage)
 def evaluate(done):return float(ds['flow'].solve(*restored(ds,damage,done)).sum())/fn['pre_supply_mw']
 result=optimize(jobs,evaluate,request.model_dump(mode='json'),system='power_system',service='相对震前的供电功率',initial_state=initial,notes=['逐完成事件回算稀疏直流最优潮流；失效支路及失效站邻接线路断开。'])
 for strategy in result['strategies']:
  strategy['map_frames']=frames(result,strategy['id'])
  for frame in strategy['map_frames']:
   done={r['key']for r in strategy['schedule'] if r['end_day']<=frame['time']}
   for group,metrics in ds['flow'].map_state(*restored(ds,damage,done)).items():frame.setdefault(group,{}).update(metrics)
  strategy['unserved_energy_mwh_relative_to_intact']=strategy['loss_area_days']*24*fn['pre_supply_mw']
 result['scenario_digest']=fn['scenario_digest']
 record_check('strategy_damage_scenario_frozen',all(abs(s['curve'][0]['function']-fn['function_ratio'])<1e-12 for s in result['strategies']))
 return ds,result,result,[str(request.function_artifact.path),str(request.damage_artifact.path)]

def basic_stage(request):
 ds=load_reference(request.dataset_artifact);damage=value(request.damage_artifact);fn=value(request.function_artifact)
 namespace=dict(legacy.__dict__,branch_repair_days=ds['branch_repair'],dc_opf=lambda bus,gen,branch,nodes,lines,slack:ds['flow'].solve(nodes,lines))
 kernel=FunctionType(legacy.xiufu.__code__,namespace,'xiufu')
 values=kernel(fn['post_supply_mw'],ds['bus'],ds['branch'],ds['gen'],np.asarray(damage['funcbus']),np.asarray(damage['statebus']),np.asarray(damage['funcbranch']),np.asarray(damage['stateline']),ds['repair'],int(ds['gen'][0,0]))
 strategies=[dict(id=identifier,name=name,curve=[{'time':float(t),'function':float(p)/fn['pre_supply_mw']}for t,p in curve],total_days=float(curve[-1,0]),finite_team_schedule=False)for identifier,name,curve in [('sequential','原模型依次修复',values[9]),('parallel','原模型并行修复',values[10])]]
 result=dict(strategies=strategies,scenario_digest=fn['scenario_digest'],criteria_path=str(ds['criteria_path']),assumptions=['原模型依次与并行修复不代表有限工程队优化排程。'])
 return ds,result,result,[str(request.damage_artifact.path),str(request.function_artifact.path)]

def resilience_stage(request):
 fn=value(request.function_artifact);recovery=value(request.recovery_artifact);basic=value(request.basic_recovery_artifact)
 if len({fn['scenario_digest'],recovery['scenario_digest'],basic['scenario_digest']})!=1:raise ValueError('功能与恢复结果不是同一灾损情景。')
 criteria=pd.read_excel(basic['criteria_path'],sheet_name='韧性等级划分');seq=next(s for s in basic['strategies'] if s['id']=='sequential')
 grades=legacy.evaluate_resilience_grade(fn['function_ratio'],seq['total_days'],criteria)
 keys=['id','name','curve','loss_area_days','target_time_days','total_days','target_reached','comparison_horizon_days','resilience_index','unserved_energy_mwh_relative_to_intact']
 result=dict(initial_function=fn['function_ratio'],initial_loss=1-fn['function_ratio'],strategies=[{k:r.get(k)for k in keys}for r in recovery['strategies']],recommended_strategy=recovery['recommended_strategy'],legacy_grades=dict(function_loss_grade=grades[0],recovery_time_grade=grades[1],overall_grade=grades[2],basis='original_sequential_recovery',sequential_recovery_days=seq['total_days']),scenario_digest=fn['scenario_digest'],assumptions=['原模型等级基于依次修复时间；有限队伍共同期连续韧性指数另列。'])
 return None,result,result,[str(request.function_artifact.path),str(request.recovery_artifact.path),str(request.basic_recovery_artifact.path)]

def impact_stage(request):
 from .native.impact import evaluate_power_impact
 ds=load_reference(request.dataset_artifact);fn=value(request.function_artifact);config=ds['payload'].get('power_impact')
 if not isinstance(config,dict):raise ValueError('缺少有来源的供电分区及人口数据。')
 net=network(ds);recovery=value(request.recovery_artifact) if request.recovery_artifact else None
 originals=recovery['strategies'] if recovery else [dict(id='initial',name='震后初始状态',map_frames=[fn['network_frame']])]
 geometries={};records={};strategies=[]
 for strategy in originals:
  impact=evaluate_power_impact(config,net,strategy['map_frames'])
  for frame in impact['frames']:
   for feature in frame['features']:
    geometries.setdefault(feature['id'],feature.pop('geometry'));feature['geometry_ref']=feature['id']
    uncertainty=feature['properties'].get('population_uncertainty')
    if isinstance(uncertainty,list):
     records.setdefault(feature['id'],uncertainty);feature['properties']['population_uncertainty']={'record_count':len(uncertainty),'reference':'zone_provenance_by_id/'+feature['id']}
  for feature in impact['coverage_features']:
   if feature.get('geometry')is not None:geometries.setdefault(feature['id'],feature.pop('geometry'));feature['geometry_ref']=feature['id']
  strategies.append(dict(id=strategy['id'],name=strategy['name'],**impact,source_skill_id=PREFIX+('recovery_optimization'if recovery else'function_assessment')))
 recommended=recovery['recommended_strategy']if recovery else'initial';chosen=next(r for r in strategies if r['id']==recommended)
 result=dict(schema_version='engineering.power-impact.v1',title='停电影响范围与人口空间评估',strategies=strategies,recommended_strategy=recommended,coverage=chosen['coverage'],metrics=chosen['metrics'],initial_summary=chosen['frames'][0]['summary'],geometry_by_id=geometries,zone_provenance_by_id=records,network=net,provenance=ds['payload'].get('power_impact_provenance',{}),model_provenance=chosen['provenance'],scenario_digest=fn['scenario_digest'],analysis_mode='recovery_histories'if recovery else'initial_snapshot',assumptions=chosen['assumptions'])
 return ds,result,result,[str(request.dataset_artifact.path),str(request.function_artifact.path)]

def report_stage(request):
 inv=value(request.dataset_artifact)['inventory']
 result=dict(title=request.report_title,language=request.output_language,inventory=inv,damage=value(request.damage_artifact)['damage'],function=value(request.function_artifact),recovery=value(request.recovery_artifact),basic_recovery=value(request.basic_recovery_artifact),resilience=value(request.resilience_artifact),impact_reference=request.impact_artifact.model_dump(mode='json'),knowledge_evidence=request.knowledge_evidence,presentation_instructions=request.presentation_instructions)
 summary=dict(title=request.report_title,language=request.output_language,complete=True,city=inv['city'],node_count=inv['node_count'],branch_count=inv['branch_count'])
 return None,result,summary,[]

EXECUTORS=dict(input_preparation=input_stage,damage_assessment=damage_stage,function_assessment=function_stage,recovery_assessment=basic_stage,recovery_optimization=recovery_stage,resilience_assessment=resilience_stage,outage_impact=impact_stage,result_reporting=report_stage)

def public_summary(stage, original):
 summary=dict(original)
 if stage=='input_preparation':
  net=original['network']
  summary['network']={'nodes':[{k:n.get(k)for k in ('id','result_id','name','longitude','latitude','demand_mw','voltage_kv','type')}for n in net['nodes']],
   'links':[{k:e.get(k)for k in ('id','from_node','to_node','voltage_kv','capacity_mw','asset_kind')}for e in net['links']],
   'geometry_source':'Full original line geometry is retained in dataset_artifact'}
 elif stage=='damage_assessment':
  summary['scenario']={k:v for k,v in original['scenario'].items()if k not in {'nodes','branches'}}
  keys=('id','from_node','to_node','pga_g','asset_type','state','function','probabilities','probabilities_valid')
  for field in ('nodes','branches'):summary[field]=[{k:r.get(k)for k in keys if k in r}for r in original[field]]
 elif stage=='recovery_optimization':
  summary.pop('initial_state',None)
  summary['strategies']=[{k:v for k,v in row.items()if k!='map_frames'}for row in original['strategies']]
 elif stage=='outage_impact':
  for field in ('geometry_by_id','zone_provenance_by_id','network','model_provenance'):summary.pop(field,None)
  summary['strategies']=[dict(id=row['id'],name=row['name'],coverage=row['coverage'],metrics=row['metrics'],
   initial_summary=row['frames'][0]['summary'],timeline=[dict(time_hours=f['time_hours'],**f['summary'])for f in row['frames']])for row in original['strategies']]
  summary['spatial_details']='Original geometry, census records and per-zone histories are retained in impact_artifact'
 return summary

class PowerSkill(EngineeringSkill):
 output_model=schemas.PowerStageOutput
 def __init__(self,spec,index):
  stage,name,type_id,dependencies,consumes,produces,request,field=spec
  self.stage=stage;self.field=field;self.output_field=produces;self.request_model=request
  self._manifest=SkillManifest(id=PREFIX+stage,version='1.0.0',name=name,description=name,kind=ComponentKind.ENGINEERING_SKILL if type_id else ComponentKind.SUPPORT_COMPONENT,skill_type_id=type_id,skill_type_version='1.0.0'if type_id else None,target_system='power_system',domain='urban_power_resilience',capability=stage,stage=f'{index:02}_{stage}',assessment_modes=[AssessmentMode.PREDICTIVE],inputs=list(request.model_fields),outputs=[produces,'summary'],dependencies=[PREFIX+d for d in dependencies],consumes=[contract(c.rstrip('?'),c.endswith('?'))for c in consumes],produces=[contract(produces)],model_profiles=['power_dc_v1'],model_versions={'power_model':'Rescity active sparse DC core snapshot 2026-11-24'},assumptions=['现行Rescity电力数值内核；独立运行状态与产物。'],limitations=['易损性与电气参数含参考假设，未经当地运营商标定。','core不启用多主体调度；单个固定种子情景不是风险统计。'],model_source={'status':'source_snapshot','source_project':'RescityAgent','manifest':str(Path(__file__).with_name('native')/'source_manifest.json')})
 def _execute(self,request,context,skill_dir):
  ds,result,summary,sources=EXECUTORS[self.stage](request)
  metadata={}
  for field in ('dataset_artifact','damage_artifact','function_artifact','recovery_artifact'):
   reference=getattr(request,field,None)
   if reference is not None:
    upstream=value(reference)
    metadata.update({k:upstream[k]for k in ('dataset_fingerprint','pga_g','power_damage_mode','seed','damage_scenario_fingerprint')if k in upstream})
  if self.stage=='input_preparation':metadata['dataset_fingerprint']=result['source_sha256']
  if self.stage=='damage_assessment':
   scenario=result['power_damage_scenario'];bounds=scenario['pga_range_g']
   metadata.update(pga_g=bounds[0]if bounds[0]==bounds[1]else None,power_damage_mode=scenario['mode'],seed=request.seed,damage_scenario_fingerprint=scenario['scenario_digest'])
  result.update(metadata);summary.update(metadata)
  path=write_json(skill_dir/'artifacts'/f'{self.stage}.json',result);ref=artifact_ref(path,'application/json',self._manifest.name)
  summary=public_summary(self.stage,summary)
  data={'summary':summary,'metric_standard':metric_standard_record(),self.output_field:ref.model_dump(mode='json')}
  if self.field!='report':data[self.field]=summary
  warnings=[]
  if self.stage=='damage_assessment'and not summary.get('probabilities_valid',True):warnings.append(SkillWarning(code='reference_fragility_crossing',message='部分参考曲线交叉；兼容模式保留最大权重分类，负权重不能解释为概率。'))
  if ds is not None:sources.append(str(Path(__file__).with_name('native')/'source_manifest.json'))
  return SkillExecutionOutput(data=data,artifacts=[ref],warnings=warnings,assumptions=summary.get('assumptions',[]),source_files=sources,model_versions=self._manifest.model_versions)

def builtins():
 return [PowerSkill(spec,i)for i,spec in enumerate(STAGES)]
