"""Language projection of saved power results; no numerical model is rerun."""
from copy import deepcopy
import json
from pathlib import Path
import threading
from .result_delivery import ResultDeliveryBuilder, power_summary, TITLES

def contains_cjk(value):
    return any('\u3400' <= char <= '\u9fff' for char in str(value or ''))

def english_objective(analysis, plan, request_context):
    payload=(plan or {}).get('request_payload',request_context) or request_context
    pga=payload.get('pga_g',request_context.get('pga_g'))
    targets=(plan or {}).get('target_skill_ids') or (analysis or {}).get('target_skill_ids') or []
    names=[TITLES.get(str(i).rsplit('.',1)[-1],(i,i))[1] for i in targets]
    return 'Auckland electricity-grid assessment'+(f' at an explicit PGA of {pga}g' if pga is not None else '')+(': '+', '.join(names) if names else '')+'.'

def english_session_title(analysis, plan, request_context):
    return english_objective(analysis,plan,request_context)

def sanitize_visible(value):
    # Source labels, citations and proper names are retained rather than erased.
    return deepcopy(value)

def project_task_analysis(analysis, plan, request_context):
    if not isinstance(analysis,dict): return None
    value=deepcopy(analysis);value['objective']=english_objective(analysis,plan,request_context)
    value['engineering_scope']='Electric-grid assets, supply and the requested recovery/impact capabilities.'
    return value

def project_plan(plan, analysis, request_context):
    if not isinstance(plan,dict): return None
    value=deepcopy(plan);value['task_objective']=english_objective(analysis,plan,request_context)
    value['rationale']='The Registry compiles declared power capabilities and typed dependencies. Only the approved input version may execute.'
    # This is a display copy, not a new approved numerical request.
    return value

def project_validation(validation, objective): return deepcopy(validation)
def project_knowledge_evidence(items): return deepcopy(items) if isinstance(items,list) else []
def project_review(review, interpretation=None): return deepcopy(review)
def project_events(events, objective): return deepcopy(events)
def project_follow_ups(items): return deepcopy(items)
def project_audit_files(items): return deepcopy(items)
def sanitize_execution_trace(trace): return deepcopy(trace) if isinstance(trace,list) else []

def project_iterations(items, *, analysis, request_context, projection):
    result=deepcopy(items)
    for item in result:
        if not isinstance(item,dict): continue
        item['plan']=project_plan(item.get('plan'),analysis,request_context)
        if projection and str(item.get('run_id'))==str(projection.get('source_signature',{}).get('run_id')):
            for key in ('interpretation','report_summary','result_delivery','execution_trace'):
                item[key]=deepcopy(projection.get(key))
    return result

def presentation_cache_directory(skill_run_root,run_id):
    return Path(skill_run_root)/str(run_id)/'_presentation'/'en-US'

class EnglishPresentationBuilder:
    def __init__(self): self._lock=threading.RLock()
    def build(self,*,skill_result,analysis,plan,evidence,request_context):
        data=skill_result.get('data',{});nodes=data.get('node_results')
        if not isinstance(nodes,dict) or not data.get('run_directory'): return None
        run=Path(data['run_directory']).resolve();run_id=str(skill_result.get('run_id') or run.name)
        source=data.get('delivery_bundle') or {}
        payload=(plan or {}).get('request_payload') or request_context
        title=source.get('report_title') or payload.get('report_title')
        instructions=source.get('presentation_instructions') or payload.get('presentation_instructions')
        revision_id=data.get('presentation_revision_id')
        directory=presentation_cache_directory(run.parent,run_id)
        if revision_id:directory=directory/('revision-'+str(revision_id))
        cache=directory/'presentation.json'
        signature={'run_id':run_id,'input_hash':(skill_result.get('provenance') or {}).get('input_hash'),'schema':'power_en_v2',
            'presentation_revision_id':revision_id,'report_title':title,'presentation_instructions':instructions,
            'source_output_language':source.get('output_language') or payload.get('output_language'),'display_language':'en-US'}
        with self._lock:
            if cache.is_file():
                try:
                    old=json.loads(cache.read_text(encoding='utf-8'))
                    if old.get('source_signature')==signature and all(Path(a['path']).is_file() for a in old.get('artifacts',[])):return old
                except (OSError,ValueError,KeyError):pass
            directory.mkdir(parents=True,exist_ok=True)
            requested=source.get('requested_skill_ids') or data.get('requested_skill_ids') or data.get('target_skill_ids') or list(nodes)
            objective=english_objective(analysis,plan,request_context)
            delivery,refs=ResultDeliveryBuilder().build(run_directory=directory,run_id=run_id+'-en',objective=objective,
                assessment_mode=data.get('assessment_mode','predictive'),output_language='en-US',requested_skill_ids=requested,
                execution_target_skill_ids=data.get('execution_target_skill_ids',requested),executed_components=data.get('executed_components',list(nodes)),
                node_results=nodes,node_trace=source.get('execution_trace',data.get('node_trace',[])),source_artifacts=[],warnings=skill_result.get('warnings',[]),assumptions=skill_result.get('assumptions',[]),
                report_title=title,presentation_instructions=instructions)
            artifacts=[{'path':str(ref.path),'name':ref.path.name,'media_type':ref.media_type,'description':ref.description,'checksum_sha256':ref.checksum_sha256,'size_bytes':ref.size_bytes} for ref in refs]
            for artifact in skill_result.get('artifacts',[]):
                if isinstance(artifact,dict) and Path(str(artifact.get('path',''))).name in {'input_preparation.json','damage_assessment.json','function_assessment.json','recovery_assessment.json','recovery_optimization.json','resilience_assessment.json','outage_impact.json'}:
                    artifacts.append({**deepcopy(artifact),'name':Path(artifact['path']).name})
            payload={'source_signature':signature,'display_language':'en-US','objective':objective,'report_summary':power_summary(nodes,requested,language='en-US'),'result_delivery':delivery,'interpretation':delivery['narrative'],'execution_trace':source.get('execution_trace',data.get('node_trace',[])),'artifacts':artifacts}
            cache.write_text(json.dumps(payload,ensure_ascii=False,indent=2,default=str),encoding='utf-8');return payload

def presentation_artifact_views(projection,session_id):
    result=[]
    for index,artifact in enumerate(projection.get('artifacts',[])):
        item={key:deepcopy(value) for key,value in artifact.items() if key!='path'}
        media=str(item.get('media_type',''));name=str(item.get('name',''))
        item.update(index=index,url=f'/api/sessions/{session_id}/presentation/en-US/artifacts/{index}',kind='image' if media.startswith('image/') else 'file',category='figure' if media.startswith('image/') else 'report' if name.endswith('.docx') else 'table' if name.endswith('.xlsx') else 'data')
        result.append(item)
    return result
