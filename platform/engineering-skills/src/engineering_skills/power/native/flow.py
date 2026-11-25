"""Sparse DC load-shedding optimization for geographically explicit city grids.

Angles are radians, line voltage is kV, reactance is ohms, power is MW.
Disconnected lines impose neither flow nor angle constraints. Each electrical
island has its own reference angle; an island without injection serves no load.
"""
import numpy as np
from scipy.optimize import linprog
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

class DCPowerFlow:
    def __init__(self,bus,gen,branch):
        self.n=len(bus);self.m=len(gen);self.l=len(branch)
        self.demand=np.asarray(bus[:,5],dtype=float)
        ids=np.asarray(bus[:,0],dtype=float)
        references=[np.asarray(a,dtype=float) for a in (branch[:,1],branch[:,2],gen[:,0])]
        if any(not np.isfinite(a).all() or not np.equal(a,np.floor(a)).all() for a in references):
            raise ValueError('线路与电源节点引用必须为有效整数编号。')
        self.u,self.v,self.g=[a.astype(int)-1 for a in references]
        self.capacity=np.asarray(gen[:,1],dtype=float)
        self.limit=np.asarray(branch[:,4],dtype=float)
        x=np.asarray(branch[:,3],dtype=float);kv=np.asarray(branch[:,5],dtype=float)
        if not np.array_equal(ids,np.arange(1,self.n+1)):raise ValueError('电力节点编号必须按1到N连续排列。')
        if not self.m or not self.l or not np.isfinite(self.demand).all() or (self.demand<0).any():raise ValueError('电力负荷或电源数据无效。')
        if any((a<0).any() or (a>=self.n).any() for a in (self.u,self.v,self.g)):raise ValueError('电力线路或电源引用了不存在的节点。')
        if not all(np.isfinite(a).all() and (a>0).all() for a in (x,kv,self.limit,self.capacity)):raise ValueError('线路电抗、电压、容量及电源上限必须为正有限数值。')
        self.b=kv**2/x
        self.cache={}

    def solve(self,funcbus,funcbranch):
        nodes=np.asarray(funcbus,dtype=float);lines=np.asarray(funcbranch,dtype=float)
        if nodes.shape!=(self.n,) or lines.shape!=(self.l,) or not np.isfinite(nodes).all() or not np.isfinite(lines).all():
            raise ValueError('电力组件状态维度或数值无效。')
        if not np.isin(nodes,[0,1]).all() or not np.isin(lines,[0,1]).all():raise ValueError('当前电力求解器仅接受0/1组件功能状态。')
        key=(nodes.tobytes(),lines.tobytes())
        if key in self.cache:return self.cache[key][0].copy()
        alive=(lines==1)&(nodes[self.u]==1)&(nodes[self.v]==1)
        active=np.flatnonzero(alive);u=self.u[active];v=self.v[active];a=len(active)
        graph=coo_matrix((np.ones(a),(u,v)),shape=(self.n,self.n)).tocsr()
        _,labels=connected_components(graph,directed=False)
        powered=np.isin(labels,labels[self.g[nodes[self.g]==1]]) & (nodes==1)
        if not np.any(self.demand[powered]>0):
            pd=np.zeros(self.n);self._remember(key,pd,powered,alive);return pd.copy()
        # [angles, served load, generation, active line flow]
        f0=2*self.n+self.m;size=f0+a;row=np.arange(self.n);edge=np.arange(a)
        rr=np.concatenate([row,self.g,u,v,self.n+edge,self.n+edge,self.n+edge])
        cc=np.concatenate([self.n+row,2*self.n+np.arange(self.m),f0+edge,f0+edge,f0+edge,u,v])
        vv=np.concatenate([-np.ones(self.n),np.ones(self.m),-np.ones(a),np.ones(a),np.ones(a),-self.b[active],self.b[active]])
        matrix=coo_matrix((vv,(rr,cc)),shape=(self.n+a,size)).tocsr()
        bounds=[(None,None)]*self.n+[(0,float(d*ok)) for d,ok in zip(self.demand,powered)]+[
            (0,float(c*nodes[n])) for n,c in zip(self.g,self.capacity)]+[(-float(self.limit[e]),float(self.limit[e])) for e in active]
        _,references=np.unique(labels,return_index=True)
        for ref in references:bounds[int(ref)]=(0,0)
        objective=np.zeros(size);objective[self.n:2*self.n]=-1
        solution=linprog(objective,A_eq=matrix,b_eq=np.zeros(self.n+a),bounds=bounds,method='highs')
        if not solution.success:raise ValueError('电力直流最优潮流未收敛：'+solution.message)
        pd=np.clip(solution.x[self.n:2*self.n],0,self.demand)
        self._remember(key,pd,powered,alive,dict(
            served_mw=float(pd.sum()),generation_mw=float(solution.x[2*self.n:f0].sum()),
            max_equation_residual=float(np.max(np.abs(matrix@solution.x))),
            max_capacity_excess_mw=float(max(0,np.max(np.abs(solution.x[f0:])-self.limit[active]))) if a else 0.,
            energized_nodes=int(powered.sum()),active_branches=int(alive.sum())))
        return pd.copy()

    def _remember(self,key,pd,powered,alive,diagnostic=None):
        if len(self.cache)>=6500:self.cache.pop(next(iter(self.cache)))
        self.cache[key]=(pd.copy(),powered.copy(),alive.copy(),diagnostic or dict(served_mw=0.,generation_mw=0.,
            max_equation_residual=0.,max_capacity_excess_mw=0.,energized_nodes=int(powered.sum()),active_branches=int(alive.sum())))

    def diagnostics(self,funcbus,funcbranch):
        self.solve(funcbus,funcbranch)
        key=(np.asarray(funcbus,dtype=float).tobytes(),np.asarray(funcbranch,dtype=float).tobytes())
        return dict(self.cache[key][3])

    def map_state(self,funcbus,funcbranch):
        self.solve(funcbus,funcbranch)
        pd,powered,alive,_=self.cache[(np.asarray(funcbus,dtype=float).tobytes(),np.asarray(funcbranch,dtype=float).tobytes())]
        # Loaded buses show actual supplied-load ratio. Zero-load junctions show
        # energized topology, rather than falsely treating intact as supplied.
        ratio=np.divide(pd,self.demand,out=powered.astype(float),where=self.demand>0)
        return {'node':{'function':{str(i+1):float(v) for i,v in enumerate(ratio)}},
            'pipe':{'function':{str(i+1):float(ok and powered[self.u[i]] and powered[self.v[i]]) for i,ok in enumerate(alive)}}}
