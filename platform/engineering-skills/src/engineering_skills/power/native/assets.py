"""Optional explicit branch classes for multivoltage power benchmarks."""
import numpy as np
from scipy.stats import lognorm

SHEET='支路建模属性'

def branch_properties(rows,bus,branch,repair_times):
    """Validate the complete optional inventory; never infer transformers by X."""
    kinds=['line']*len(branch)
    days=np.tile(np.asarray(repair_times[1],dtype=float),(len(branch),1))
    if rows is None:return kinds,days
    seen=set()
    for row in rows:
        if len(row)!=4:raise ValueError('支路建模属性应为编号、类别和严重/完全损伤修复天数四列。')
        number,kind,serious,complete=row
        if isinstance(number,(bool,np.bool_)) or not np.isfinite(float(number)) or float(number)!=int(float(number)):
            raise ValueError('支路属性编号必须为整数。')
        i=int(number)-1
        if i<0 or i>=len(branch) or i in seen:raise ValueError('支路属性编号重复或不存在。')
        seen.add(i)
        if kind not in {'line','transformer'}:raise ValueError('支路类别仅支持line或transformer。')
        times=np.asarray([serious,complete],dtype=float)
        if not np.isfinite(times).all() or (times<=0).any():raise ValueError('支路修复天数必须为正有限数。')
        u,v=int(branch[i,1])-1,int(branch[i,2])-1
        a,b=float(bus[u,6]),float(bus[v,6]);kv=float(branch[i,5])
        if kind=='transformer':
            if a==b or kv!=max(a,b):raise ValueError('变压连接两侧电压应不同，电抗须按高压侧电压折算。')
        elif a!=b or kv!=a:raise ValueError('普通线路两端与支路电压须一致；不同电压应通过变压连接。')
        kinds[i]=kind;days[i,3:5]=times
    if len(seen)!=len(branch):raise ValueError('支路建模属性必须覆盖全部支路。')
    return kinds,days

def classified_branch_damage(pga,bus,branch,fragility,kinds):
    """Use voltage-equipment proxy curves for transformer banks, line curve otherwise.

    Fragility is still a documented proxy, not claimed to be calibrated locally.
    Spatial line PGA uses its two endpoint values, not the first city node.
    """
    pga=np.asarray(pga,dtype=float)
    if pga.shape!=(len(bus),) or not np.isfinite(pga).all() or (pga<0).any():raise ValueError('节点PGA必须为非负有限数。')
    states=[]
    for i,kind in enumerate(kinds):
        u,v=int(branch[i,1])-1,int(branch[i,2])-1
        demand=(pga[u]+pga[v])/2
        kv=float(branch[i,5]);row=(2 if kv<=115 else 3 if kv<=235 else 4) if kind=='transformer' else 5
        curve=np.asarray(fragility[row],dtype=float)
        exceedance=lognorm.cdf(demand,s=curve[4:8],scale=curve[:4])
        probability=np.concatenate(([1-exceedance[0]],exceedance[:-1]-exceedance[1:],[exceedance[-1]]))
        if not np.isfinite(probability).all() or probability.min() < -1e-9:raise ValueError('易损性曲线无效或损伤超越概率不单调。')
        states.append(int(np.argmax(probability))+1)
    states=np.asarray(states,dtype=int)
    return (states<4).astype(int),states
