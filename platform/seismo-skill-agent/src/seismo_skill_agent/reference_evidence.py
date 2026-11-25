"""Small, versioned reference records for exact methods and project contracts."""

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import re

from .models import KnowledgeEvidence


@dataclass(frozen=True)
class Reference:
    key: str
    match: str
    title: str
    citation: str
    locator: str
    content: str
    source_url: str | None = None

    def evidence(self) -> KnowledgeEvidence:
        revision = sha256(repr(self).encode("utf-8")).hexdigest()
        return KnowledgeEvidence(
            evidence_id=f"ref-{self.key}", title=self.title, source_path=str(Path(__file__).resolve()),
            citation=self.citation, source_url=self.source_url, section=self.locator, locator=self.locator,
            content=self.content, score=1.0, index_revision="curated-reference-v1",
            source_sha256=revision, document_version=self.key.rsplit("-", 1)[-1],
            source_type="curated_reference" if self.source_url else "project_contract",
        )


REFERENCES = (
    Reference(
        "assessment-modes-v1",
        r"现场观测|评估模式|(?:预测|快速|混合)(?:评估|模式)|predictive assessment|rapid (?:assessment|mode)|hybrid (?:assessment|mode)|field observations",
        "SeismoSkillAgent: seismic assessment mode contract / 地震评估模式契约",
        "SeismoSkillAgent assessment-mode input contract, seismic demand and healthcare observation adapters",
        "engineering_skills.healthcare: earthquake_scenario_interpretation and seismic_hazard_demand_analysis",
        "For this system, predictive assessment uses scenario-based prediction inputs. Rapid event assessment requires "
        "traceable event observations for the result it claims; a forecast or administrative PGA record is not an observation "
        "of floor response. Hybrid assessment gives available observations priority by field, hospital and scenario; uncovered "
        "fields use the declared predictive/reference scenario and are recorded as predictions. If observations are absent, "
        "declare the gap and do not describe a predictive estimate as a rapid, observed result. "
        "预测使用情景预测数据；快速事件评估须有可溯源的事件观测；混合评估逐字段观测优先，缺项以明确的预测输入补齐并保留来源。",
    ),
    Reference(
        "healthcare-treatment-window-60h-v1",
        r"60\s*(?:小时|h(?:ours?)?)|启动治疗|生存加权|treatment.start coverage|survival.weighted (?:fulfillment|coverage)",
        "SeismoSkillAgent: 60-hour treatment metrics / 中重伤启动治疗指标",
        "Engineering Skills metric contract healthcare_ms_60h_v1, constrained_v2",
        "engineering_skills.healthcare.metric_standard; medical_system_function/SKILL.md",
        "Under healthcare_ms_60h_v1, calculate separately by day/night and by moderate/severe injury. The denominator "
        "for both metrics is all original demand in that severity and period, including unassigned casualties. Treatment "
        "start coverage counts those scheduled to start within [0,60) hours after the event. Survival-weighted fulfilment "
        "weights each such start by the matching injury survival probability at its own start hour, not by the probability "
        "at hour 60. Pool counts across Monte Carlo samples before dividing. With no demand, report not applicable, not 0%. "
        "These are model-based estimates; the start window is not a measure of eventual cumulative recovery or observed survival. "
        "同一伤级、时段使用全部源需求为分母，含未分派者；窗口内启动人数为覆盖率分子，按各自启动时刻的存活概率加权为另一分子。",
    ),
    Reference(
        "2sfca-base-2003",
        r"2\s*sfca|floating catchment|两步浮动",
        "Luo & Wang (2003): original two-step floating catchment area",
        "Luo, W. & Wang, F. (2003). Environment and Planning B 30, 865-884. DOI: 10.1068/b29120.",
        "Original two-step FCA method; supply catchment and demand catchment",
        "In Step 1, divide each provider's supply by the population within the provider's travel-time catchment. "
        "That denominator represents competition for the same supply. In Step 2, sum those provider-level supply-to-demand "
        "ratios for providers in reach of each demand point. In the original form, a travel-time threshold determines inclusion: "
        "locations outside the catchment are excluded and those inside are not continuously down-weighted.",
        "https://pmc.ncbi.nlm.nih.gov/articles/PMC8238135/",
    ),
    Reference(
        "2sfca-enhanced-2009",
        r"2\s*sfca|floating catchment|两步浮动",
        "Luo & Qi (2009): within-catchment travel-time weights",
        "Luo, W. & Qi, Y. (2009). Health & Place 15, 1100-1107. DOI: 10.1016/j.healthplace.2009.06.002.",
        "Enhanced 2SFCA; travel-time zone weights",
        "Enhanced 2SFCA, unlike the original threshold-only form, gives distinct weights to locations inside the catchment. "
        "Different travel-time bands receive lower or higher weights, so longer trips can contribute less even when still "
        "within the service threshold. This is an extension rather than a required operation of all 2SFCA variants.",
        "https://pubmed.ncbi.nlm.nih.gov/19576837/",
    ),
    Reference(
        "fema-restoration-6.1",
        r"(?<![a-z])hazus(?![a-z])",
        "FEMA Hazus 6.1 earthquake model: essential facility restoration",
        "FEMA, Hazus 6.1 Earthquake Model Technical Manual, Section 6.8 and Table 6-20.",
        "Printed pages 6-35 to 6-36, Restoration Curves and Generic Restoration Functions for Essential Facilities",
        "Hazus represents the expected fraction of earthquake-damaged facilities that are operational at a given elapsed "
        "time. Its generic restoration curves vary by damage state and use a mean and standard deviation in days. "
        "Estimates are based on physical damage; direct utility outages, cascading effects and local contingency plans are "
        "not included. Generic hospital recovery functions are not actual repair schedules for a named Yangpu hospital.",
        "https://www.fema.gov/sites/default/files/documents/fema_hazus-earthquake-model-technical-manual-6-1.pdf",
    ),
)


def reference_evidence(question: str) -> list[KnowledgeEvidence]:
    return [entry.evidence() for entry in REFERENCES if re.search(entry.match, question, re.I)]


def refresh_reference_evidence(items: list[dict]) -> list[dict]:
    known = {f"ref-{entry.key}": entry for entry in REFERENCES}
    result = []
    for item in items:
        entry = known.get(item.get("evidence_id"))
        if entry is not None:
            current = entry.evidence()
            if current.source_sha256 == item.get("source_sha256"):
                result.append(current.model_dump(mode="json"))
    return result
