# Third-party and source notices

This document records bundled notices and known source lineage. It does not assign a license to PowerSkillAgent or relicense the SeismoSkillAgent / RescityAgent source code. A project license has not yet been selected. Confirm the distribution rights of inherited platform, numerical and reference-interface code before a public release.

## Leaflet 1.9.4

Bundled under `seismo-skill-agent/src/seismo_skill_agent/web_static/vendor/leaflet`. Keep its complete `LICENSE`, JavaScript header, CSS and image files together.

BSD 2-Clause License

Copyright (c) 2010-2023, Volodymyr Agafonkin
Copyright (c) 2010-2011, CloudMade
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Lucide 0.468.0

Bundled as `seismo-skill-agent/src/seismo_skill_agent/web_static/lucide.min.js`. Its header identifies version 0.468.0 and ISC. Preserve that header and the following notice from the supplied Lucide distribution:

ISC License

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## CesiumJS reference-map runtime

The Rescity reference interface includes CesiumJS under `seismo-skill-agent/src/seismo_skill_agent/web_static/vendor/rescity/vendor/cesium`. Its complete supplied license and third-party notices are preserved in `LICENSE.md` in that directory. The original reference CSS and map components, their source hashes and the limited adapter changes are recorded in `vendor/rescity/REFERENCE_MAP_MANIFEST.json` and `reference-results-source.json`. The independent Power platform uses these visual components with its own saved assessment outputs.

## Installed Python dependencies

Version pins are recorded in `requirements.txt` and package metadata. Python packages are installed separately; the source archive excludes virtual environments and their binary distributions. Preserve the notices supplied with the versions actually distributed if an installer or binary release is later produced. This notice does not assert a single license for every direct or transitive dependency.

## Platform and engineering source lineage

The application retains platform mechanisms from SeismoSkillAgent and numerical / reference display code from RescityAgent. Numerical origins and hashes are recorded in `engineering-skills/src/engineering_skills/power/native/source_manifest.json`. Original source-project labels inside compatibility modules do not establish a public license. No unknown-license source has been declared MIT by this project.

## Data, documents, models and map services

The small source-review export excludes data and model assets. The complete public Release download, authorized by the project owner, additionally includes the frozen Auckland inputs and parameter workbooks, 87 curated knowledge texts, their retrieval indexes, and the pinned multilingual MiniLM encoder. Original document attribution and notices are retained; these materials retain their respective source terms and are not relicensed by the application. Original PDFs and map tiles are not included.

The encoder is the `Xenova/paraphrase-multilingual-MiniLM-L12-v2` ONNX conversion of the Sentence Transformers multilingual MiniLM model. Its fixed cached revision and file hashes are in `reproducibility/knowledge.lock.json`; upstream model information is at https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2 and https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 .

The current reference geographic interface retains the Rescity basemap configuration and its visible provider attribution, including Esri and the OpenStreetMap contributors where applicable. Background tiles are fetched in the browser and are not bundled or archived. The earlier standalone map used OpenStreetMap Standard tiles; any continued use of that service must respect its [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/). A source-code export is not a license to redistribute map tiles.

A map library license does not grant rights to redistribute a provider's tiles or remove provider attribution. Any alternative provider added later needs its own current attribution and service conditions; no API-key tile service is declared to be the current default.
