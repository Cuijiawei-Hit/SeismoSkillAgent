# PowerSkillAgent

An electricity-grid seismic-resilience workbench with engineering calculations, evidence retrieval and human review. The interface opens in English and includes the saved Auckland example.

## Download and start

Download **PowerSkillAgent-v0.3.1.zip** from the [GitHub release](https://github.com/Cuijiawei-Hit/SeismoSkillAgent/releases/tag/power-v0.3.1). Use the release ZIP for the complete platform; GitHub's automatic “Source code” ZIP does not include the large case and knowledge assets.

On Windows, install Python 3.13, extract the ZIP and run these commands in the extracted `PowerSkillAgent` directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-power.ps1
.\start-power.cmd
```

Open **http://127.0.0.1:8785**. The saved Auckland example opens automatically. Explore conclusions, asset damage, supply states, outage population, recovery playback and reports. Viewing this example uses no model API and does not rerun the engineering analysis.

## Use your own model API

Run **configure-model.cmd**. It asks for:

| Setting | DeepSeek example |
| --- | --- |
| API base URL | `https://api.deepseek.com/v1` |
| Model name | `deepseek-v4-pro` |
| API key | Your own provider-issued key, entered in the hidden prompt |

The key is passed to the local server in its process environment. The script does not write it into source, a settings file, the website or the download archive. Other OpenAI-compatible HTTPS endpoints can be entered with their matching model names. See the provider's [current API documentation](https://api-docs.deepseek.com/) for available models.

Alternatively, set `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` in your shell, then run `start-power.ps1`. Stop an existing local server before changing those environment variables. Restarting the server is required for new credentials to take effect.

Choose **New task**, describe an assessment and review the proposed parameters. Engineering calculations run after approval. Results can be accepted or revised through the existing human-review workflow.

## Included default case

The package includes the Auckland dataset, geometry and population associations, two engineering parameter workbooks, and one saved complete assessment. The saved scenario uses PGA **0.4g**, **one repair crew**, **24 working hours per day**, and three recovery strategies. It covers **468 electrical nodes**, **562 branches** and **82 spatial supply/coverage areas**.

Saved results and new tasks are separate. The bundled example is read-only; new work is stored under `runtime/` on the user's own computer. Original geometry, model assumptions and source attribution are retained with the case.

## Included knowledge base

The complete download includes **87 curated documents**, the SQLite/FTS5 and FAISS indexes, and the pinned multilingual MiniLM ONNX encoder. No embedding-model account or first-run model download is required. The 384-dimensional encoder runs locally on CPU; only agent responses use the user's configured LLM API.

The uncompressed knowledge files are approximately 337 MiB: 5 MiB of text, 91 MiB of indexes and 241 MiB of encoder/tokenizer files. They are distributed as a Release asset rather than loaded with the project website. Source document notices, references and the content hashes in `reproducibility/knowledge.lock.json` are preserved. New user documents can be added in a separate knowledge release using `tools/build_knowledge.py`.

## macOS and Linux

Use Python 3.13 and a virtual environment:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python -m pip install --no-deps -e engineering-skills -e seismo-skill-agent
export POWER_WORKSPACE_ROOT="$PWD"
python -m seismo_skill_agent.web --host 127.0.0.1 --port 8785
```

Set your own `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` and `DEEPSEEK_MODEL` in that shell before starting the server to enable new agent tasks. Leave the key unset to explore only the saved case.

## Website and source

The [project website](https://cuijiawei-hit.github.io/SeismoSkillAgent/) provides a read-only interactive example, download links and usage instructions. GitHub Pages hosts the saved display; the Python application runs locally after download. The website has no API-key entry and does not call a shared model account.

The `platform/` directory in the GitHub repository contains the application source. Data, knowledge indexes and model weights are in the complete Release ZIP. Third-party notices and original source lineage are in `THIRD_PARTY_NOTICES.md` and the component manifests. Background map tiles are fetched from their attributed providers and are not bundled.

## 中文使用说明

下载 Release 中的完整 ZIP，解压后先运行 `install-power.ps1` 安装依赖，再运行 `start-power.cmd`。默认打开奥克兰已保存案例，不需要 API Key。需要开展新任务时运行 `configure-model.cmd`，输入自己的 API 地址、模型名和密钥，然后在平台新建任务并审核方案。中文界面可通过右上角 **ZH** 切换。完整包已包含默认知识库、索引和本地编码器。
