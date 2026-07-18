# Knowledge graph — guía universal (cross-modelo)

Este repo tiene un **grafo de conocimiento** generado con [graphify](https://github.com/safishamsi/graphify):
qué conecta con qué, sin leer todo el código. Está pensado para que **cualquier modelo/agente lo use**
como capa de contexto — **no solo Claude**. Pronto el desarrollo migra a otro modelo (probablemente uno
chino vía opencode: DeepSeek / Qwen / GLM / Kimi u otro), así que esta guía es **model-agnóstica** a
propósito.

## Qué queda versionado (portable)

- **`graphify-out/graph.json`** — el grafo (nodos + edges) en JSON. **Esto es lo que un modelo consume.**
- **`graphify-out/GRAPH_REPORT.md`** — mapa legible: god-nodes (núcleos más conectados), comunidades,
  conexiones sorpresa, preguntas sugeridas.
- Estos dos se commitean; el resto de `graphify-out/` (cache, `graph.html`, manifests, temp) está
  gitignored — es local/regenerable.

## Cómo lo usa OTRO modelo (de más a menos universal)

### 1) Leer el reporte — cero dependencias
`GRAPH_REPORT.md` es markdown plano. Cualquier modelo lo lee y capta la estructura (núcleos, módulos,
qué está acoplado, qué planes viejos siguen colgando). **Empezá acá.**

### 2) Consultar `graph.json` directo — la opción MÁS universal (solo JSON + ~15 líneas)
No necesita graphify, ni Claude, ni internet. Snippet portable (Python) para vecinos de un nodo:

```python
import json, collections
g = json.load(open('graphify-out/graph.json'))
adj = collections.defaultdict(list)
for e in g['links']:
    adj[e['source']].append((e['target'], e['relation']))
    adj[e['target']].append((e['source'], e['relation']))
def neighbors(substr, depth=2):
    seen = {n['id'] for n in g['nodes'] if substr.lower() in n['label'].lower()}
    frontier = list(seen)
    for _ in range(depth):
        nxt = []
        for n in frontier:
            for t, r in adj[n]:
                if t not in seen:
                    seen.add(t); nxt.append(t); print(f'{n} --{r}--> {t}')
        frontier = nxt
neighbors('CloudflareBindings')   # o cualquier concepto/símbolo
```

En JS/Go/cualquier lenguaje es lo mismo: cargar el JSON y recorrer `links`. **Schema de `graph.json`:**
- `nodes[]`: `{ id, label, file_type (code|document|image|concept|rationale), source_file, community }`
- `links[]`: `{ source, target, relation, confidence (EXTRACTED|INFERRED|AMBIGUOUS), confidence_score }`
- `hyperedges[]`: grupos de 3+ nodos que participan de un mismo concepto/flujo.

### 3) `graphify query` — si graphify está instalado
```bash
uv tool install graphifyy    # o: pip install graphifyy
graphify query "how does the tracking API reach InsForge?"
graphify path "TrackingPortal" "InsForge"     # camino más corto entre 2 conceptos
graphify explain "IngestService"              # explicación de un nodo
```
La traversal **no usa modelo** — corre sola. Sirve en cualquier harness que pueda ejecutar un CLI.

### 4) MCP — si tu herramienta lo soporta
```bash
graphify --mcp   # levanta un servidor MCP stdio; el agente lo consulta como tool
```
Depende de que el modelo/tool soporte MCP. Menos universal que #2/#3.

## Mantenerlo fresco (CRÍTICO)

**Un grafo viejo miente** — peor que no tenerlo. Después de cambios de código:
```bash
graphify . --update     # incremental: re-extrae solo lo que cambió
```
o cableá el **hook post-commit** de graphify para que se regenere solo. Si dudás de la frescura, borrá
`graphify-out/` y reconstruí con `graphify .` (el AST/código es gratis; la parte semántica de docs
necesita un modelo — el host agent, o `GEMINI_API_KEY` si tenés Gemini).

## Cuánto confiar en cada edge

- Edges de **código (AST)** → deterministas, **confiables** (imports, calls reales).
- Edges **semánticos / `INFERRED`** (docs, similitudes) → **pistas, no verdad**. ~3% pueden quedar
  colgantes (IDs que no calzan exacto). Verificá contra el código antes de actuar. Regla de la casa:
  *verificar con evidencia, no asumir* — sobre todo con un modelo más barato.

## Para el cambio de modelo (opencode / modelo chino)

- El grafo es **JSON + un CLI** → **cero dependencia de Claude/Anthropic**. Funciona con cualquier
  modelo/harness.
- La ruta **más robusta y universal es la #2** (parsear `graph.json`): no requiere instalar nada.
  Arrancá por ahí; `graphify query` y MCP son comodidad, no requisito.
- Úsalo como **contexto pre-computado**: antes de que el agente lea medio repo, que consulte el grafo
  para ubicar qué archivos/símbolos importan y cómo conectan. Baja tokens y alucinación — el punto
  central del harness/loop que buscamos al bajar de modelo. Ver también
  [`scaling-and-hosting.md`](scaling-and-hosting.md) §"Migración a opencode".
