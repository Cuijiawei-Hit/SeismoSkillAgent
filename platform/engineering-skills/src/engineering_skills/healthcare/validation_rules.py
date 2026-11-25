"""Explicit, deterministic validation of healthcare adapter interfaces and results.

These functions validate existing model outputs. They do not alter values,
derive new earthquake results, or validate the scientific model's calibration.
"""
from __future__ import annotations

import json
import hashlib
from pathlib import Path
import numpy as np

from engineering_skills.core.models import ValidationIssue
from engineering_skills.core.exceptions import ModelNotApplicableError


# Content quantities, not dimensions of the file path. Units follow the actual
# model fields and the project's existing time/EDP definitions.
ARTIFACT_UNITS = {
    'hazard_demand_artifact': {'edp_selected.PFA':'g', 'edp_selected.PFV':'m/s',
        'edp_selected.PFD':'m', 'edp_selected.IDR':'1', 'scenario_pga_g':'g'},
    'damage_artifact': {'max_idr':'1', 'repair_time':'day', 'component_failure':'1'},
    'hospital_function_artifact': {'function_ratio':'1', 'function_loss':'1',
        'post_capacity_1h':'person', 'post_capacity_72h':'person'},
    'accessibility_artifact': {'travel_time':'minute', 'service_radius_minutes':'minute',
        'decay_weight':'1', 'covered_population':'person', 'unreachable_population':'person'},
    'casualty_artifact': {'sampled_demand':'person', 'dispatch':'person',
        'treated_capacity':'person', 'survivor_adjusted':'person'},
    'system_function_artifact': {'initial_function':'1', 'node_accessibility_ratio':'1',
        'combined_treatment_rate':'1'},
    'recovery_artifact': {'*__curve':'1', '*__resilience':'1', '*__recovery_time':'day',
        '*__schedule.start':'day', '*__schedule.finish':'day'},
    'resilience_summary_artifact': {'mean_resilience_index':'1',
        'mean_functionality_loss_area':'day', 'mean_downtime_to_threshold_days':'day'},
    'metrics_artifact': {'*__resilience_index':'1', '*__functionality_loss_area':'day',
        '*__downtime_to_threshold':'day'},
    'report_summary_artifact': {'resilience_index':'1', 'recovery_time_days':'day'},
}


def label_artifact(artifact, slot):
    """Label only quantities known by this adapter; never infer unknown units."""
    artifact.units = dict(ARTIFACT_UNITS[slot])
    artifact.units_source = 'healthcare.validation_rules.ARTIFACT_UNITS:v1'
    return artifact


def restore_proven_units(payload):
    """Normalize a COPY of a checksum-verified old case artifact reference.

    Known legacy NPZ stamps plus the concrete field layout establish that this
    is the existing adapter's representation. Unknown files are never labelled.
    JSON summaries additionally require their stored run result's time-unit and
    model-version evidence. No original file or historical result is written.
    """
    if not isinstance(payload,dict): return payload
    result=dict(payload)
    needed={
        'hazard_demand_artifact':['edp_selected','source_code'],
        'damage_artifact':['repair_time','damage_state','component_failure'],
        'hospital_function_artifact':['available_resources','function_ratio','function_loss'],
        'accessibility_artifact':['travel_time','decay_weight','covered_population'],
        'casualty_artifact':['sampled_demand','dispatch','treated_capacity'],
        'system_function_artifact':['initial_function','node_accessibility_ratio'],
        'recovery_artifact':[],
    }
    for slot, units in ARTIFACT_UNITS.items():
        ref=result.get(slot)
        if hasattr(ref,'model_dump'): ref=ref.model_dump(mode='json')
        if not isinstance(ref,dict) or ref.get('units') or not ref.get('checksum_sha256'):
            continue
        path=Path(ref['path'])
        if not path.is_file():continue
        actual=hashlib.sha256(path.read_bytes()).hexdigest()
        if actual!=ref['checksum_sha256']:continue
        proven=False
        try:
            if path.suffix=='.npz' and slot in needed:
                with np.load(path,allow_pickle=False) as a:
                    proven=(a['_edp_units'].tolist()==['g','m/s','m','ratio']
                        and '_dataset_fingerprint' in a and '_model_profile' in a
                        and all(k in a for k in needed[slot]))
                    if slot=='recovery_artifact':
                        proven=proven and any(k.endswith('__curve') for k in a.files)
            elif path.suffix=='.json' and slot=='resilience_summary_artifact':
                previous=json.loads((path.parent.parent/'result.json').read_text(encoding='utf-8'))
                summary=json.loads(path.read_text(encoding='utf-8'))
                proven=(previous.get('skill_id')=='resilience_quantification'
                    and previous.get('data',{}).get('time_unit')=='day'
                    and previous.get('provenance',{}).get('model_versions',{}).get('quantification')=='normalized_functionality_integral_v1'
                    and isinstance(summary.get('curves'),list))
        except (OSError,ValueError,KeyError,TypeError):
            proven=False
        if proven:
            result[slot]={**ref,'units':dict(units),'units_source':'verified_legacy_adapter_contract:'+actual}
    return result


def _issue(message, field=None, category='result_invalid', severity='error'):
    return ValidationIssue(code='healthcare_contract', message=message, field=field,
                           category=category, severity=severity)


class Checks:
    def __init__(self):
        self.issues = []

    def require(self, condition, message, field=None):
        if not bool(condition): self.issues.append(_issue(message, field))

    def bounded(self, values, field, upper=None):
        a = np.asarray(values, dtype=float)
        self.require(np.all(np.isfinite(a)) and np.all(a >= -1e-7),
                     f'{field}: values must be finite and nonnegative', field)
        if upper is not None:
            self.require(np.all(a <= upper + 1e-7), f'{field}: exceeds {upper}', field)


def _arrays(value, slot, checks, request=None):
    ref = value[slot]
    path = Path(ref['path'])
    with np.load(path, allow_pickle=False) as archive:
        arrays = {k:archive[k].copy() for k in archive.files}
    if '_edp_units' in arrays:
        checks.require(arrays['_edp_units'].tolist()==['g','m/s','m','ratio'],
                       'NPZ EDP dimensions are inconsistent with the declared adapter contract')
    if request and request.get('model_profile') and '_model_profile' in arrays:
        checks.require(arrays['_model_profile'].tolist()==[request['model_profile']],
                       'NPZ profile differs from the requested model profile')
    return arrays


def validate_data_applicability(value, component, request=None):
    """Reuse the real data/model-mode checks before calculation, without sampling."""
    from .data import load_dataset_reference
    from .observations import validate_observation_mode
    from .skills.recovery_optimization.constraints import RecoveryConstraintInputError, bind_constraints
    try:
        parsed = component.request_model.model_validate(value)
        if not hasattr(parsed, 'dataset_source'):
            return []
        dataset = load_dataset_reference(parsed.dataset_source, parsed.dataset_artifacts)
        validate_observation_mode(dataset, parsed.assessment_mode, parsed.model_profile)
        preferences = getattr(parsed, 'decision_preferences', None)
        if preferences and preferences.required_first_hospital_id not in (None,*dataset.hospital_ids):
            return [_issue('Required first hospital is not present in this inventory',
                'decision_preferences.required_first_hospital_id', 'input_invalid')]
        if preferences is not None:
            hard = bind_constraints(preferences, dataset.hospital_ids, getattr(parsed, 'team_count', None))
            if hard is not None and (parsed.model_profile != 'constrained_v2' or 'ga_legacy' in getattr(parsed, 'strategies', [])):
                return [_issue('Hard recovery constraints require constrained_v2 with importance or robust_ga.',
                               'decision_preferences.recovery_constraints', 'model_not_applicable')]
        return []
    except RecoveryConstraintInputError as exc:
        return [ValidationIssue(code=exc.reason_code, message=str(exc), field='decision_preferences.recovery_constraints')]
    except ModelNotApplicableError as exc:
        return [_issue(str(exc), category='model_not_applicable')]
    except (ValueError, FileNotFoundError, KeyError) as exc:
        return [_issue(str(exc), category='input_invalid')]


def validate_hazard(value, component, request=None):
    c=Checks(); a=_arrays(value,'hazard_demand_artifact',c,request)
    selected=a['edp_selected']; c.bounded(selected,'edp_selected')
    c.require(selected.ndim==4 and selected.shape[-1]==4, 'EDP requires scenario x sample x floor x 4 dimensions')
    c.require(value['demand_units']==['g','m/s','m','ratio'], 'Output EDP units must be explicitly declared')
    c.require(selected.shape[1]==value['mcs']==(request or {}).get('mcs',value['mcs']), 'EDP sample count differs from request')
    c.require(a['source_code'].shape==(selected.shape[0],), 'Every scenario needs an EDP source code')
    c.require(a['observed_edp_mask'].shape==(selected.shape[0],*selected.shape[2:]), 'Observed/predicted EDP field mask has wrong shape')
    c.require(all(s['selected_source'] and s['input_edp_source'] for s in value['scenarios']), 'EDP scenario provenance is missing')
    return c.issues


def validate_damage(value, component, request=None):
    c=Checks(); a=_arrays(value,'damage_artifact',c,request)
    # NaN marks an unsupported/uncomputed component (e.g. rapid mode); it is
    # intentionally not an asserted zero failure probability.
    finite=a['component_failure'][np.isfinite(a['component_failure'])]
    c.bounded(finite,'component_failure',1)
    c.bounded(a['repair_time'],'repair_time')
    c.bounded(a['hospital_failure'],'hospital_failure',1); c.bounded(a['system_failure'],'system_failure',1)
    c.require(np.all((a['damage_state']>=0)&(a['damage_state']<=4)), 'Hospital damage state is outside 0..4')
    for s in value['scenarios']:
        p=np.asarray(s['hospital_damage_probabilities']); c.bounded(p,'hospital_damage_probabilities',1)
        c.require(np.allclose(p.sum(axis=-1),1), 'Mutually exclusive damage-state probabilities do not sum to one')
        c.bounded(s['hospital_failure_probability'],'hospital_failure_probability',1)
        c.bounded([s['system_failure_probability']],'system_failure_probability',1)
    # This is a conditional component formula check, not an assertion that
    # independently sampled regional failure frequencies must be monotone.
    from .skills.hospital_damage_assessment.model import component_failure_probability
    grid=np.logspace(-4,2,17).reshape(-1,1,1)
    edp=np.repeat(grid,4,axis=-1)
    conditional,_=component_failure_probability(edp,[{'demand_type':'IDR',
        'states':[{'median':.01,'beta':.6}]}],'first_state')
    c.require(np.all(np.diff(conditional[:,0,0])>=-1e-12),
              'Conditional lognormal component exceedance must be nondecreasing in EDP for positive median/beta')
    return c.issues


def validate_hospital_function(value, component, request=None):
    c=Checks(); a=_arrays(value,'hospital_function_artifact',c,request)
    for key in ['pre_resources','pre_capacity_72h','available_resources','post_capacity_1h','post_capacity_72h']:
        c.bounded(a[key],key)
    c.require(np.all(a['available_resources']<=a['pre_resources'][None,:,:,None]+1e-7), 'Retained resources exceed baseline inventory')
    c.bounded(a['function_ratio'],'function_ratio',1); c.bounded(a['function_loss'],'function_loss',1)
    c.require(np.allclose(a['function_ratio']+a['function_loss'],1), 'Function ratio and loss must sum to one')
    c.require(a['department_method'].ndim==3 and a['resource_source'].ndim==3, 'Model method/source trace arrays are missing')
    c.require(np.all(np.isin(a['department_method'],[0,1,2])), 'Unrecognized department computation method')
    return c.issues


def validate_accessibility(value, component, request=None):
    c=Checks(); a=_arrays(value,'accessibility_artifact',c,request)
    # Positive infinity is the explicit unreachable-route representation.
    c.require(not np.any(np.isnan(a['travel_time'])|(a['travel_time']<0)), 'Travel time must be nonnegative or +inf')
    c.bounded(a['decay_weight'],'decay_weight'); c.bounded(a['covered_population'],'covered_population')
    c.bounded(a['unreachable_population'],'unreachable_population')
    c.require(np.all(np.isin(a['reachable'],[0,1])), 'Reachability must be boolean')
    from .data import load_dataset_reference
    parsed=component.request_model.model_validate(request)
    dataset=load_dataset_reference(parsed.dataset_source,parsed.dataset_artifacts)
    c.require(np.allclose(a['covered_population']+a['unreachable_population'],dataset.node_population.sum()), 'Covered and unreachable populations do not conserve the population')
    c.require(np.all(a['covered_population']<=dataset.node_population.sum()+1e-7), 'Coverage exceeds total population')
    return c.issues


def validate_casualty(value, component, request=None):
    c=Checks(); a=_arrays(value,'casualty_artifact',c,request)
    for key in ['dispatch','sampled_demand','hospital_demand','treated_capacity','unmet_demand','survivor_adjusted']:
        c.bounded(a[key],key)
    c.require(np.allclose(a['treated_capacity']+a['unmet_demand'],a['hospital_demand']), 'Hospital dispatched demand is not conserved')
    c.require(np.all(a['survivor_adjusted']<=a['treated_capacity']+1e-6), 'Expected survivors exceed treated casualties')
    if 'unassigned_demand' in a:
        c.require(np.array_equal(a['dispatch'].sum(axis=4)+a['unassigned_demand']+a['excluded_demand'],a['sampled_demand']), 'Source demand != dispatched + unassigned + out-of-scope demand')
    else:
        c.require(np.array_equal(a['dispatch'].sum(axis=4),a['sampled_demand']), 'Legacy dispatch does not conserve source demand')
    if 'treatment_start_by_slot' in a:
        starts=a['treatment_start_by_slot']; arrivals=a['arrival_by_slot']
        c.require(np.all(np.cumsum(starts,axis=-2)<=np.cumsum(arrivals,axis=-2)+1e-6), 'Treatment begins before arrival')
        # Independently reconstruct occupancy for ALL samples including the tail,
        # rather than trusting the model's scalar max_resource_excess summary.
        from .parameters import TreatmentParameters
        parameters=TreatmentParameters.model_validate((request or {})['treatment_parameters'])
        from .data import load_dataset_reference
        parsed=component.request_model.model_validate(request)
        dataset=load_dataset_reference(parsed.dataset_source,parsed.dataset_artifacts)
        from .engineering_checks import load_bound_artifact
        hospital=load_bound_artifact(
            parsed.hospital_function_artifact, dataset, parsed.model_profile,
            horizon_hours=parsed.treatment_horizon_hours,
        )
        dt=float(a['time_step_hours'][0]); durations=np.ceil(a['occupancy_hours']/dt).astype(int)
        requirements=a['resource_requirements']; slots=starts.shape[-2]
        c.require(np.isclose(slots * dt, parsed.treatment_horizon_hours, rtol=0, atol=1e-9),
                  'Treatment scheduling slots do not span the requested evaluation window')
        if parsed.treatment_horizon_hours == 60:
            c.require(np.array_equal(a['supplied_survival_probability'], parameters.survival_curve_probabilities),
                      'The 60-hour treatment artifact does not use the supplied survival curves')
        resources=hospital['available_resources'].transpose(0,3,1,2)[None,...]
        peak=np.zeros((*starts.shape[:-2],requirements.shape[1]))
        for resource in range(requirements.shape[1]):
            tail=max(1,int(durations[:,resource].max())); use=np.zeros((*starts.shape[:-2],slots+tail-1))
            for severity in range(3):
                for offset in range(int(durations[severity,resource])):
                    use[...,offset:offset+slots]+=starts[...,severity]*requirements[severity,resource]
            peak[...,resource]=np.max(use,axis=-1)
        c.require(np.all(peak<=resources+1e-6), 'Shared resource capacity is exceeded, including occupancy after the start window')
        c.require(np.allclose(peak,a['resource_peak_occupancy'],atol=1e-6), 'Stored peak resource occupancy differs from reconstructed schedule')
        if parameters.integer_admissions:
            c.require(np.allclose(starts,np.rint(starts),atol=1e-6), 'Integer admission constraint is violated')
    elif request:
        # The legacy branch has no shared-resource starts array. Its actual
        # model uses independently accumulated hourly capacities, so re-check
        # that existing capacity definition rather than applying the new model.
        from .data import load_dataset_reference
        from .engineering_checks import load_bound_artifact
        parsed=component.request_model.model_validate(request)
        dataset=load_dataset_reference(parsed.dataset_source,parsed.dataset_artifacts)
        hospital=load_bound_artifact(
            parsed.hospital_function_artifact, dataset, parsed.model_profile,
            horizon_hours=parsed.treatment_horizon_hours,
        )
        hourly=hospital['post_capacity_1h'].transpose(0,3,1,2)[None,...]
        c.require(np.all(a['treated_capacity']<=hourly*parsed.treatment_horizon_hours+1e-6),
                  'Legacy treated casualties exceed the existing independent hourly-capacity horizon limit')
    return c.issues


def validate_system_function(value, component, request=None):
    c=Checks(); a=_arrays(value,'system_function_artifact',c,request)
    for key in ['initial_function','initial_loss','node_accessibility_ratio','emergency_fulfillment',
                'combined_treatment_rate','treatment_fulfillment_by_severity','instantaneous_treatment_rate_by_severity']:
        c.bounded(a[key],key,1)
    c.require(np.allclose(a['initial_function']+a['initial_loss'],1), 'System functionality and loss must sum to one')
    c.bounded(a['pre_accessibility'],'pre_accessibility'); c.bounded(a['pre_node_accessibility'],'pre_node_accessibility')
    return c.issues


def validate_recovery(value, component, request=None):
    c=Checks(); a=_arrays(value,'recovery_artifact',c,request)
    team_count=value['team_count']
    hard_params = ((request or {}).get('decision_preferences') or {}).get('recovery_constraints')
    bound = None
    if hard_params:
        from .data import load_dataset_reference
        from .engineering_checks import EngineeringConstraintError, load_bound_artifact
        from .skills.recovery_optimization.constraints import bind_constraints
        parsed = component.request_model.model_validate(request)
        dataset = load_dataset_reference(parsed.dataset_source, parsed.dataset_artifacts)
        bound = bind_constraints(parsed.decision_preferences, dataset.hospital_ids, parsed.team_count)
        if bound is not None:
            damage = load_bound_artifact(
                parsed.damage_artifact, dataset, parsed.model_profile,
                horizon_hours=parsed.treatment_horizon_hours,
            )
            expected = parsed.decision_preferences.recovery_constraints.model_dump(mode='json', exclude_none=True)
            c.require('recovery_constraints_json' in a and json.loads(str(a['recovery_constraints_json'][0])) == expected
                      and value.get('recovery_constraints') == expected, 'Hard recovery constraint provenance differs from the approved request')
    for strategy in value['strategies']:
        curve=a[strategy+'__curve']; c.bounded(curve,strategy+' curve',1)
        c.require(np.all(np.diff(curve,axis=-1)>=-1e-9), 'Recovery curve decreases')
        c.bounded(a[strategy+'__recovery_time'],strategy+' recovery_time')
        order=a[strategy+'__order']; n=order.shape[-1]
        c.require(np.all(np.sort(order,axis=-1)==np.arange(n)), 'Repair order is not a facility permutation')
        for rows in a[strategy+'__schedule'].reshape(-1,n,5):
            active=rows[np.isfinite(rows[:,0])]
            c.require(np.all(np.isfinite(active)), 'Active repair jobs contain nonfinite fields')
            c.require(np.all((active[:,2]>=1)&(active[:,2]<=team_count)), 'Repair job uses an undeclared engineering team')
            c.require(np.all(active[:,4]>=active[:,3]), 'Repair finish precedes repair start')
            for team in np.unique(active[:,2]):
                jobs=active[active[:,2]==team]; jobs=jobs[np.argsort(jobs[:,3])]
                c.require(np.all(jobs[1:,3]>=jobs[:-1,4]-1e-9), 'Engineering-team tasks overlap')
        if strategy=='robust_ga':
            c.require(np.all(a[strategy+'__training_improvement']>=-1e-12), 'Robust objective is below its retained training baseline')
        if bound is not None:
            checked = a[strategy+'__schedule']
            try:
                for scenario_idx, samples in enumerate(checked):
                    for sample_idx, schedule in enumerate(samples):
                        bound.verify_schedule(order[scenario_idx, sample_idx], schedule, damage['repair_time'][scenario_idx, :, sample_idx])
                        finish = np.max(schedule[np.isfinite(schedule[:,0]),4], initial=0)
                        c.require(np.isclose(finish, a[strategy+'__recovery_time'][scenario_idx,sample_idx]), 'Recorded makespan differs from the repair schedule')
            except EngineeringConstraintError as exc:
                c.issues.append(_issue(str(exc), field='recovery_artifact'))
    return c.issues


def validate_resilience(value, component, request=None):
    c=Checks()
    c.require(value['time_unit']=='day', 'Resilience time quantities must be expressed in days')
    for curve in value['curves']:
        for key in ['mean_resilience_index','p05_resilience_index','p95_resilience_index','threshold_reached_fraction']:
            c.bounded([curve[key]],key,1)
        c.bounded([curve['mean_functionality_loss_area']],'mean_functionality_loss_area')
        downtime=curve['mean_downtime_to_threshold_days']
        if downtime is not None: c.bounded([downtime],'downtime_to_threshold')
        if (request or {}).get('require_monotonic',True):
            c.require(curve['monotonic_violation_count']==0, 'A required monotonic recovery curve decreased')
    for source in (request or {}).get('functionality_curves') or []:
        points=source['points']; t=np.asarray([p['time_day'] for p in points]); f=[p['functionality'] for p in points]
        c.require(np.all(np.diff(t)>0), 'Functionality curve times must be strictly increasing')
        c.bounded(f,'input functionality',1)
    return c.issues


def validate_scenario(value, component, request=None):
    c=Checks()
    c.require(len(value['scenario_ids'])==len(set(value['scenario_ids']))==len(value['scenarios']), 'Scenario identities are duplicated or inconsistent')
    c.require(value['hospital_count']==len(value['hospitals']), 'Hospital identity count is inconsistent')
    c.require(len({x['hospital_id'] for x in value['hospitals']})==value['hospital_count'], 'Hospital identities must be unique')
    c.require(all(h['parameter_profile_id'] for h in value['hospitals']), 'Every hospital needs a parameter-profile binding')
    c.require(bool(value['parameter_provenance']) and bool(value['source_precedence']), 'Scenario source and parameter binding provenance must be retained')
    from .data import load_dataset_reference
    from .schemas import DatasetArtifacts
    dataset=load_dataset_reference(None,DatasetArtifacts.model_validate(value['dataset_artifacts']))
    dataset.validate()
    c.require([h['hospital_id'] for h in value['hospitals']]==dataset.hospital_ids,
              'Output hospital identities differ from the canonical inventory')
    c.require([h['parameter_profile_id'] for h in value['hospitals']]==dataset.parameter_profile_ids,
              'Output parameter-profile bindings differ from the canonical inventory')
    c.require(dataset.scenario_ids==value['scenario_ids'], 'Canonical data and selected scenario identities differ')
    c.require(dataset.total_floors==value['total_floor_count'] and dataset.num_nodes==value['demand_node_count'], 'Canonical data and output dimensions differ')
    return c.issues


def validate_report(value, component, request=None):
    c=Checks(); summary=json.loads(Path(value['summary_artifact']['path']).read_text(encoding='utf-8'))
    for evidence in (request or {}).get('knowledge_evidence',[]):
        c.require(bool(evidence.get('citation') or evidence.get('evidence_id')), 'Knowledge evidence must retain citation or evidence_id')
    c.require('warnings' in summary and 'provenance' in summary, 'Structured report must include warnings and upstream provenance')
    c.require(summary.get('provenance')==(request or {}).get('upstream_provenance',[]), 'Report provenance differs from the supplied upstream records')
    request=request or {}
    with np.load(request['recovery_artifact']['path'],allow_pickle=False) as a:
        recovery={k:a[k] for k in a.files}
    metrics=json.loads(Path(request['resilience_summary_artifact']['path']).read_text(encoding='utf-8'))
    scenarios=recovery['_scenario_ids'].tolist()
    for row in summary['recovery_strategy_summary']:
        strategy=row['strategy']; scenario=row['scenario_id']; index=scenarios.index(scenario)
        metric=next(x for x in metrics['curves'] if x['scenario_id']==scenario and x['strategy']==strategy)
        c.require(np.isclose(row['mean_resilience'],metric['mean_resilience_index']), 'Report resilience differs from the upstream quantified metric')
        c.require(np.isclose(row['mean_recovery_time_days'],np.mean(recovery[strategy+'__recovery_time'][index])), 'Report recovery duration differs from the upstream schedule')
    return c.issues


def validate_workflow(value, component, request=None):
    c=Checks(); run_id=Path(value['run_directory']).name
    c.require(set(value['child_result_files'])==set(value['executed_components']), 'Workflow child result references differ from executed components')
    for name,path in value['child_result_files'].items():
        child=json.loads(Path(path).read_text(encoding='utf-8'))
        c.require(child['skill_id']==name and child['run_id']==run_id, 'Workflow child identity/run binding differs')
        c.require(child['provenance']['assessment_mode']==value['assessment_mode'], 'Workflow child assessment modes differ')
    return c.issues
