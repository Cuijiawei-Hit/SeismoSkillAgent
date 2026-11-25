from copy import deepcopy

STANDARD = {
    'id': 'power_dc_v1', 'model_profile': 'power_dc_v1', 'system': 'power_system',
    'power_unit': 'MW', 'energy_unit': 'MWh', 'pga_unit': 'g',
    'repair_time_unit': 'day', 'schedule_time_unit': 'day',
    'functionality': 'Served real power divided by intact-network served real power under the same demand and topology',
    'recovery': 'Same frozen damage scenario; recalculate sparse DC load shedding after each repair completion',
    'continuous_resilience': 'One minus cumulative functionality loss divided by the common explicit strategy comparison horizon',
    'damage_sampling': 'A fixed-seed single damage scenario is not Monte Carlo risk statistics or observed damage',
    'legacy_grading': 'Original sequential-recovery grading remains distinct from finite-crew continuous resilience',
    'profile': 'core',
}

def metric_standard_record(*_args, **_kwargs):
    return deepcopy(STANDARD)

def ensure_official_metric_inputs(payload):
    data = payload.model_dump() if hasattr(payload, 'model_dump') else payload
    if data.get('model_profile', 'power_dc_v1') != 'power_dc_v1':
        raise ValueError('Power model profile must be power_dc_v1')
