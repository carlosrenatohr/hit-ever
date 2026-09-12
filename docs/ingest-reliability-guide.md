# Guía de confiabilidad de la ingesta Cargotrack — hit-ever2

> Guía operativa **post-incidente 2026-09-11** (guía 220643). Explica qué se implementó, qué
> **tiene que hacer el dueño** (config manual de 15 min), cómo se verifica que la ingesta está
> sana y qué dispara el escalado. Para el incidente completo y el método de auditoría, ver
> [`known-issues.md`](known-issues.md) (entrada 2026-09-11). Para la decisión de arquitectura,
> ver [ADR-012](../../docs/adr/012.md) (repo meta).

---

## 1. Qué pasó y qué se hizo (resumen)

**Incidente.** La guía GC 220643 (DANIEL VILCHEZ) nunca llegó a la BD. Causa: la ingesta de
ambos proveedores estuvo **casi muerta del 16-ago al 02-sep** (0-2 writes/día). El list-walk
del cron solo ve la **página 1 (15 filas)** con **ventana de 7 días**; cualquier paquete que
llega en un apagón y es rebasado por >15 llegadas se pierde para siempre al salir de la ventana.
Solo el email trigger o un refresh manual lo rescatan.

**Auditoría.** Walk+diff del listado `whs.asp` (backfill por páginas + diff de `almacen_id`):
**8 guías perdidas en 45 días** (GC: 220643, 218961, 220665; Everest: 977641, 977761, 976004,
976258, 976262). **Todas recuperadas** el 11-sep. El `max(almacen_id)` NO sirve para contar
faltantes: los IDs son compartidos con todos los clientes de GC.

**Fixes implementados (releases v1.2.1 → v1.4.0):**

| Release | Cambio | Archivos |
|---|---|---|
| **v1.2.1** | Incidente documentado + método de auditoría | `docs/known-issues.md` |
| **v1.3.0** | `GET /admin/health` con frescura real (503 si un proveedor activo lleva >6h sin escribir) + log de credenciales faltantes | `src/lib/health.ts`, `health.test.ts`, `insforge.ts`, `repository.ts`, `routes/admin.ts`, `services/ingest.ts` |
| **v1.4.0** | Deep-walk diario anti-overflow (barre una página más allá de la página 1, offset rotativo 15→60, ventana 10 días) reutilizando el slot de cron de GC a las 04:30 UTC | `services/ingest.ts` (+`nextDeepWalkOffset`), `index.ts`, `wrangler.jsonc`, `ingest.test.ts` |

**Decisión diferida:** ADR-012 — quedarse en Workers Free mientras no haya clientes pagantes;
escalar a Workers Paid ($5/mes) o InsForge edge function cuando el volumen lo justifique.

---

## 2. Qué TIENE que hacer el dueño (config manual, ~15 min, $0)

El único paso que no se puede automatizar sin código extra es la **alerta externa**:

1. Crear cuenta en **UptimeRobot** (o Better Stack) — free tier.
2. Nuevo monitor **HTTP(S)**:
   - URL: `https://hit-ever-scraper.nativerse.workers.dev/admin/health`
     (también funciona `.../admin/` — la raíz responde el mismo health desde v1.4.2; sirve si
     un monitor mal configurado apunta a la base).
   - Intervalo: **5 minutos**.
   - Alertas: cuando el monitor esté **DOWN** (el endpoint devuelve `503` cuando la ingesta está
     congelada → UptimeRobot lo marca down).
   - Contacto: **email** (o Telegram vía webhook).
3. Probar la alerta: con el monitor creado, el endpoint devuelve 200 (ingesta sana). Para validar
   el mecanismo, llamar `?stale_after=1` a mano no sirve si los proveedores están frescos; la
   prueba real es apagar el monitor y simular un down con un monitor temporal apuntando a una URL
   inexistente — o simplemente confiar en el 503 del código (ya cubierto por tests unitarios).

**Resultado:** un apagón de ingesta (como el de 17 días) se vuelve una alerta de email en ~5
minutos.

**Cada cuánto mirar:** el `/admin/health` ya responde por sí solo; no hace falta monitoreo manual.
Revisar los logs de errores del Worker (Observability de CF) al sonar la alerta.

---

## 3. Verificación de salud (sin logs, con datos)

```bash
# 1. Frescura de ingesta (debe ser 200; 503 = congelada)
curl -s "https://hit-ever-scraper.nativerse.workers.dev/admin/health" | python3 -m json.tool

# 2. Último scrape por proveedor (debe moverse ~cada 2h)
curl -s "https://hit-ever-scraper.nativerse.workers.dev/admin/health" \
  | grep -o '"global_connection":{[^}]*}'

# 3. DB: últimos paquetes ingeridos
#    (desde el panel o vía InsForge CLI)
npx -y @insforge/cli db query \
  "SELECT p.code, date_trunc('day', pk.scraped_at)::date d, count(*) \
   FROM packages pk JOIN providers pr ON pr.id=pk.provider_id \
   WHERE pk.scraped_at > now() - interval '7 days' GROUP BY 1,2 ORDER BY 1,2;"
```

**Síntoma → causa → acción:**

| Síntoma | Causa probable | Acción |
|---|---|---|
| `/admin/health` → 503 | Proveedor >6h sin escribir | **Control automático:** `ADMIN_SECRET=<s> pnpm tsx scripts/ops-ingest-health.ts` (chequea y auto-recupera el proveedor atrasado; `--dry-run` para simular). O ver logs del Worker |
| Health 200 pero `scraped_at` no avanza | Cron no dispara / cuenta de crons al límite | Ver `wrangler deploy` reciente; la cuenta free tiene **5 crons máximo** |
| Paquetes viejos que faltan | Overflow de página 1 durante un apagón | **Auditoría walk+diff** (sección 4) + backfill |

> **`scripts/ops-ingest-health.ts`** es la herramienta de control de fallos del lado de ops: un
> solo comando que consulta `/admin/health`, y si hay un proveedor atrasado dispara
> `refresh-open` + `ingest` (página 0) para recuperarlo, re-chequea y reporta. Exit code `1`
> si sigue atrasado (sirve para un cron local). Lee `ADMIN_SECRET` de env o `.dev.vars`.

---

## 4. Auditoría de guías perdidas (método exacto, manual)

El `almacen_id` no sirve para contar faltantes (IDs compartidos con todos los clientes de GC).
El contador exacto es **recorrer el listado hacia atrás + diff**:

```bash
# 1. Snapshot actual de almacen_ids por proveedor
npx -y @insforge/cli db query \
  "SELECT almacen_id FROM packages pk JOIN providers pr ON pr.id=pk.provider_id \
   WHERE pr.code='global_connection';" --json > /tmp/gc_before.json

# 2. Walk hacia atrás (una página por invocación; ~21 subrequests, cabe en free tier)
for OFF in 0 15 30 45 60 75 90; do
  curl -s -X POST -H "Authorization: Bearer <ADMIN_SECRET>" \
    "https://hit-ever-scraper.nativerse.workers.dev/admin/ingest?provider=global_connection&offset=$OFF&days=45"
  sleep 2
done
# Parar cuando dos páginas seguidas devuelvan "count":0 (= fuera de la ventana)

# 3. Diff: las filas nuevas son exactamente las guías perdidas
npx -y @insforge/cli db query \
  "SELECT almacen_id FROM packages pk JOIN providers pr ON pr.id=pk.provider_id \
   WHERE pr.code='global_connection';" --json > /tmp/gc_after.json
# comparar /tmp/gc_before.json vs /tmp/gc_after.json
```

El deep-walk diario (v1.4.0) reduce la necesidad de esta auditoría, pero es el método de
recuperación definitivo tras cualquier apagón. Documentado en detalle en `known-issues.md`.

---

## 5. Para futuros devs/agentes (conocimiento estructural)

- **La ingesta vive en `hit-ever2`** (`src/services/ingest.ts`), no en `scraper-service` (legacy,
  `EverestScraperService`, login roto — ver `docs/architecture.md`).
- **Patrón de crons** (4 triggers, límite free = 5/account): list-walk página 1 cada 2h por
  proveedor (`0`/`30 */2`), open-refresh cada 6h (`15`/`45 */6`), deep-walk diario en el slot de
  GC a las 04:30 UTC. **Una sola job por invocación** — nunca combinar proveedores ni jobs (revienta
  los 50 subrequests).
- **El límite de subrequests es la causa raíz** de los incidentes de julio y agosto. Siempre medir
  el costo por invocación antes de subir batches.
- **Todo debe fallar con ruido**: `credsFor` loguea, `getLastScrapeByProvider` alimenta el health
  endpoint. Si algo se puede detectar sin logs, el health endpoint lo expone.
- **Solo HIT se scrapea** (suite y solo-guegue tienen `is_scrapable=false`). GC→casillero 1538,
  Everest→casillero 37458. El routing multi-tenant vive en `provider_agencies` (ver
  `resolveProviderOrg`).
- **Escalado:** ADR-012. No agregar VPN/BaaS/DB nuevas (ADR-010). El BaaS (InsForge) nunca fue el
  problema — el cuello es el runtime del scraper.
- **Versiones:** cada fase va con su ciclo completo (rama → `pnpm check` → PR → CI → merge →
  deploy → smoke) y un release tag (`v1.2.1`…). El deploy usa `pnpm run deploy` (`pnpm deploy` es
  un comando builtin de pnpm y falla).