# Knowledge Graph — Universal Cross-Model Guide

This repo ships a **knowledge graph** built with [graphify](https://github.com/safishamsi/graphify):
what connects to what, without reading the whole codebase. It is meant to be used by **any
model/agent — not just Claude**. Development is moving to a different model soon (likely a Chinese
model via opencode: DeepSeek / Qwen / GLM / Kimi, or similar), so this guide is intentionally
**model-agnostic**.

## What is committed (portable)

- **`graphify-out/graph.json`** — the graph (nodes + edges) as JSON. **This is what a model consumes.**
- **`graphify-out/GRAPH_REPORT.md`** — a readable map: god-nodes (most-connected core abstractions),
  communities, surprising connections, suggested questions.
- Only these two are committed. The rest of `graphify-out/` (cache, `graph.html`, manifests, temp) is
  gitignored — it is local and regenerable.

## How another model uses it (most → least universal)

### 1) Read the report — zero dependencies
`GRAPH_REPORT.md` is plain Markdown. Any model can read it and grasp the structure (core modules, what
is coupled, which legacy plans still linger). **Start here.**

### 2) Query `graph.json` directly — the MOST universal option (JSON + ~15 lines)
Needs no graphify, no Claude, no network. Portable snippet (Python) to walk a node's neighborhood:

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
neighbors('CloudflareBindings')   # any concept or symbol
```

Same idea in JS/Go/any language: load the JSON, walk `links`. **`graph.json` schema:**
- `nodes[]`: `{ id, label, file_type (code|document|image|concept|rationale), source_file, community }`
- `links[]`: `{ source, target, relation, confidence (EXTRACTED|INFERRED|AMBIGUOUS), confidence_score }`
- `hyperedges[]`: groups of 3+ nodes that participate in one shared concept/flow.

### 3) `graphify query` — if graphify is installed
```bash
uv tool install graphifyy    # or: pip install graphifyy
graphify query "how does the tracking API reach InsForge?"
graphify path "TrackingPortal" "InsForge"     # shortest path between two concepts
graphify explain "IngestService"              # plain-language node explanation
```
The traversal **does not use a model** — it runs on its own. Works in any harness that can run a CLI.

### 4) MCP — if your tool supports it
```bash
graphify --mcp   # starts an MCP stdio server; the agent queries it as a tool
```
Requires the model/tool to support MCP. Less universal than #2/#3.

## Keep it fresh (CRITICAL)

**A stale graph lies** — worse than none. After code changes:
```bash
graphify . --update     # incremental: re-extracts only what changed
```
or wire graphify's **post-commit hook** so it regenerates automatically. If in doubt about freshness,
delete `graphify-out/` and rebuild with `graphify .` (the AST/code part is free; the semantic doc part
needs a model — the host agent, or `GEMINI_API_KEY` if you have Gemini).

## How much to trust each edge

- **Code (AST) edges** → deterministic, **reliable** (real imports, calls).
- **Semantic / `INFERRED` edges** (docs, similarities) → **leads, not truth**. ~3% may be dangling (IDs
  that don't exactly match). Verify against the code before acting. House rule: *verify with evidence,
  don't assume* — especially with a cheaper model.

## For the model switch (opencode / Chinese model)

- The graph is **JSON + a CLI** → **zero Claude/Anthropic dependency**. Works with any model/harness.
- The **most robust, universal path is #2** (parse `graph.json`): installs nothing. Start there;
  `graphify query` and MCP are convenience, not requirements.
- Use it as **pre-computed context**: before the agent reads half the repo, have it query the graph to
  locate which files/symbols matter and how they connect. Cuts tokens and hallucination — the core of
  the harness/loop we want when moving to a cheaper model. See also
  [`scaling-and-hosting.md`](scaling-and-hosting.md) → "Migración a opencode".
