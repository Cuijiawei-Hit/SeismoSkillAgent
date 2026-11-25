import numpy as np
import pandas as pd

def xiufu(PD0, bus0, branch0, gen0, funcbus00, statebus00, funcbranch00, stateline00, xiufudata, slack0):
    """
    模拟灾后的修复过程和系统功能的恢复。

    参数:
        PD0 (float): 震后初始时刻的系统供电量。
        // ... 其余参数为系统数据 ...
        xiufudata (np.ndarray): 纯数值的修复时间数据。

    返回:
        tuple: 包含模拟过程中的多种结果的元组,
               关键结果是恢复曲线 (yici, bingxing)，
               同时增加每个时间点的节点和线路损伤状态及功能状态。
    """
    nb0 = bus0.shape[0]
    nbra0 = branch0.shape[0]
    damagebus, tbus, damageline, tline = ([], [], [], [])
    bus_damage_status_over_time_yici = []
    branch_damage_status_over_time_yici = []
    bus_function_status_over_time_yici = []
    branch_function_status_over_time_yici = []
    bus_damage_status_over_time_yici.append({f'节点{i + 1}': damage_state_to_string(statebus00[i]) for i in range(nb0)})
    branch_damage_status_over_time_yici.append({f'线路{i + 1}': damage_state_to_string(stateline00[i]) for i in range(nbra0)})
    bus_function_status_over_time_yici.append({f'节点{i + 1}': funcbus00[i] for i in range(nb0)})
    branch_function_status_over_time_yici.append({f'线路{i + 1}': funcbranch00[i] for i in range(nbra0)})
    bus_damage_status_over_time_bingxing = []
    branch_damage_status_over_time_bingxing = []
    bus_function_status_over_time_bingxing = []
    branch_function_status_over_time_bingxing = []
    bus_damage_status_over_time_bingxing.append({f'节点{i + 1}': damage_state_to_string(statebus00[i]) for i in range(nb0)})
    branch_damage_status_over_time_bingxing.append({f'线路{i + 1}': damage_state_to_string(stateline00[i]) for i in range(nbra0)})
    bus_function_status_over_time_bingxing.append({f'节点{i + 1}': funcbus00[i] for i in range(nb0)})
    branch_function_status_over_time_bingxing.append({f'线路{i + 1}': funcbranch00[i] for i in range(nbra0)})
    for ii in range(nb0):
        if funcbus00[ii] == 0:
            damagebus.append(ii + 1)
            if statebus00[ii] == 4:
                tbus.append(xiufudata[0, 3])
            elif statebus00[ii] == 5:
                tbus.append(xiufudata[0, 4])
    bus_info = np.array([damagebus, tbus]).T
    for ii in range(nbra0):
        if funcbranch00[ii] == 0:
            damageline.append(ii + 1)
            if stateline00[ii] == 4:
                tline.append(branch_repair_days[ii, 3])
            elif stateline00[ii] == 5:
                tline.append(branch_repair_days[ii, 4])
    line_info = np.array([damageline, tline]).T
    t_all = np.concatenate((tbus, tline))
    sorted_indices = np.argsort(t_all)
    tseq = t_all[sorted_indices]
    pd_list, PD = ([], np.zeros(len(tseq)))
    funcbus1, funcbranch1 = (funcbus00.copy(), funcbranch00.copy())
    statebus1, stateline1 = (statebus00.copy(), stateline00.copy())
    num_tbus = len(tbus)
    damagebus_arr = np.array(damagebus)
    damageline_arr = np.array(damageline)
    for jj, original_idx in enumerate(sorted_indices):
        if original_idx < num_tbus:
            bus_to_repair = damagebus_arr[original_idx]
            funcbus1[bus_to_repair - 1] = 1
            statebus1[bus_to_repair - 1] = 1
        else:
            line_to_repair = damageline_arr[original_idx - num_tbus]
            funcbranch1[line_to_repair - 1] = 1
            stateline1[line_to_repair - 1] = 1
        current_bus_status = {f'节点{i + 1}': damage_state_to_string(statebus1[i]) for i in range(nb0)}
        current_branch_status = {f'线路{i + 1}': damage_state_to_string(stateline1[i]) for i in range(nbra0)}
        current_funcbus = {f'节点{i + 1}': funcbus1[i] for i in range(nb0)}
        current_funcbranch = {f'线路{i + 1}': funcbranch1[i] for i in range(nbra0)}
        bus_damage_status_over_time_yici.append(current_bus_status)
        branch_damage_status_over_time_yici.append(current_branch_status)
        bus_function_status_over_time_yici.append(current_funcbus)
        branch_function_status_over_time_yici.append(current_funcbranch)
        pd1 = dc_opf(bus0, gen0, branch0, funcbus1, funcbranch1, slack0)
        pd_list.append(pd1)
        PD[jj] = np.sum(pd1)
    bus_damage_status_over_time_yici[-1] = {f'节点{i + 1}': damage_state_to_string(funcbus1[i]) for i in range(nb0)}
    branch_damage_status_over_time_yici[-1] = {f'节点{i + 1}': damage_state_to_string(funcbranch1[i]) for i in range(nbra0)}
    t_para = np.unique(t_all)
    pd2_list, PD2 = ([], np.zeros(len(t_para)))
    funcbus2, funcbranch2 = (funcbus00.copy(), funcbranch00.copy())
    statebus2, stateline2 = (statebus00.copy(), stateline00.copy())
    for jj, current_time in enumerate(t_para):
        bus_indices_to_repair = np.where(np.array(tbus) == current_time)[0]
        for kk in bus_indices_to_repair:
            funcbus2[damagebus_arr[kk] - 1] = 1
            statebus2[bus_to_repair - 1] = 1
        line_indices_to_repair = np.where(np.array(tline) == current_time)[0]
        for kk in line_indices_to_repair:
            funcbranch2[damageline_arr[kk] - 1] = 1
            stateline2[line_to_repair - 1] = 1
        current_bus_status = {f'节点{i + 1}': damage_state_to_string(statebus2[i]) for i in range(nb0)}
        current_branch_status = {f'线路{i + 1}': damage_state_to_string(stateline2[i]) for i in range(nbra0)}
        current_funcbus = {f'节点{i + 1}': funcbus2[i] for i in range(nb0)}
        current_funcbranch = {f'线路{i + 1}': funcbranch2[i] for i in range(nbra0)}
        bus_damage_status_over_time_bingxing.append(current_bus_status)
        branch_damage_status_over_time_bingxing.append(current_branch_status)
        bus_function_status_over_time_bingxing.append(current_funcbus)
        branch_function_status_over_time_bingxing.append(current_funcbranch)
        pd1 = dc_opf(bus0, gen0, branch0, funcbus2, funcbranch2, slack0)
        pd2_list.append(pd1)
        PD2[jj] = np.sum(pd1)
    bus_damage_status_over_time_bingxing[-1] = {f'节点{i + 1}': damage_state_to_string(funcbus2[i]) for i in range(nb0)}
    branch_damage_status_over_time_bingxing[-1] = {f'节点{i + 1}': damage_state_to_string(funcbranch2[i]) for i in range(nbra0)}
    if len(tseq) == 0:
        yici = np.array([[0, PD0]])
    else:
        cumulative_time = np.cumsum(tseq)
        yici_steps = np.vstack([cumulative_time, PD]).T
        yici = np.vstack([np.array([0, PD0]), yici_steps])
    if len(t_para) == 0:
        bingxing = np.array([[0, PD0]])
    else:
        bingxing_steps = np.vstack([t_para, PD2]).T
        bingxing = np.vstack([np.array([0, PD0]), bingxing_steps])
    return (bus_info, line_info, tseq, sorted_indices, t_para, pd_list, PD, pd2_list, PD2, yici, bingxing, bus_damage_status_over_time_yici, branch_damage_status_over_time_yici, bus_function_status_over_time_yici, branch_function_status_over_time_yici, bus_damage_status_over_time_bingxing, branch_damage_status_over_time_bingxing, bus_function_status_over_time_bingxing, branch_function_status_over_time_bingxing)


def read_resilience_criteria(file_path):
    """读取韧性指标目标值及韧性等级划分"""
    resilience_target_df = pd.read_excel(file_path, sheet_name='韧性指标目标值')
    resilience_grade_df = pd.read_excel(file_path, sheet_name='韧性等级划分')
    return (resilience_target_df, resilience_grade_df)


def evaluate_resilience_grade(rf, recovery_time, resilience_grade_df):
    """评估韧性等级（使用一级/二级/三级）"""
    fl = 1.0 - rf
    fl_grade = '一级'
    for idx, row in resilience_grade_df.iterrows():
        grade = row['韧性等级']
        fl_str = str(row['功能损失率'])
        if '≤' in fl_str:
            threshold = float(fl_str.replace('≤', ''))
            if fl <= threshold:
                fl_grade = grade
                break
        elif '-' in fl_str:
            parts = fl_str.split('-')
            low = float(parts[0])
            high = float(parts[1])
            if low < fl <= high:
                fl_grade = grade
                break
        elif '>' in fl_str:
            threshold = float(fl_str.replace('>', ''))
            if fl > threshold:
                fl_grade = grade
                break
    rt_grade = '一级'
    for idx, row in resilience_grade_df.iterrows():
        grade = row['韧性等级']
        rt_str = str(row['恢复时间（天）'])
        if '≤' in rt_str:
            threshold = float(rt_str.replace('≤', ''))
            if recovery_time <= threshold:
                rt_grade = grade
                break
        elif '-' in rt_str:
            parts = rt_str.split('-')
            low = float(parts[0])
            high = float(parts[1])
            if low < recovery_time <= high:
                rt_grade = grade
                break
        elif '>' in rt_str:
            threshold = float(rt_str.replace('>', ''))
            if recovery_time > threshold:
                rt_grade = grade
                break
    grade_order = ['三级', '二级', '一级']
    fl_idx = grade_order.index(fl_grade) if fl_grade in grade_order else len(grade_order) - 1
    rt_idx = grade_order.index(rt_grade) if rt_grade in grade_order else len(grade_order) - 1
    overall_grade = grade_order[max(fl_idx, rt_idx)]
    return (fl_grade, rt_grade, overall_grade)


def damage_state_to_string(state):
    """将损伤状态数字转换为文字描述"""
    damage_states = {1: '基本完好', 2: '轻度破坏', 3: '中度破坏', 4: '严重破坏', 5: '完全破坏'}
    return damage_states.get(state, '未知状态')


