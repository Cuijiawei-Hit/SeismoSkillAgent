from pathlib import Path
import json
import os
from seismo_skill_agent.semantic_knowledge import SemanticKnowledgeIndex
from seismo_skill_agent.knowledge_snapshot import create_lock, verify_lock

root = Path(__file__).resolve().parents[1]
lock_path = root/'reproducibility/knowledge.lock.json'
bootstrap_pin = root/'reproducibility/embedding.bootstrap.json'
if lock_path.is_file():
    current = json.loads(lock_path.read_text(encoding='utf-8'))
    if not current.get('index',{}).get('files'):
        # This is a new release. The source embedding files were copied and
        # checked before building; no existing searchable release is unlocked.
        lock_path.replace(bootstrap_pin)
os.environ.pop('SEISMO_KNOWLEDGE_LOCK', None)
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['SEISMO_EMBEDDING_PROVIDERS'] = 'CPUExecutionProvider'
status = SemanticKnowledgeIndex(root/'knowledge-base').build()
lock = create_lock(root/'knowledge-base')
(root/'reproducibility/knowledge.lock.json').write_text(json.dumps(lock,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({k:v for k,v in status.items() if k not in ['source_signature']},ensure_ascii=False,default=str))
print(json.dumps(verify_lock(root/'knowledge-base'),ensure_ascii=False))
