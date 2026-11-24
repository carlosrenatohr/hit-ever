# Features por agencia (feature flags)

Cómo encender una superficie opt-in para **una sola agencia** sin deploy y sin tocar
código, y qué tener en cuenta cuando se agrega un flag nuevo.

> Contrato corto: el flag es un **interruptor de producto**, no una frontera de seguridad.
> Las fronteras siguen siendo RLS y los gates del Worker (permisos + `organization_id`
> resuelto desde la sesión). Un flag nunca autoriza datos ni reemplaza un permiso.

---

## 1. Inventario actual

Los flags viven como columnas booleanas en `public.agencies` (una fila por tenant).

| Columna | Qué enciende | Default | Quién lo lee |
|---|---|---|---|
| `flexible_pricing_enabled` | Tarifas flexibles: precio de cliente vs. costo de proveedor, tarjetas fijas y snapshot de pricing al crear el paquete. | `false` | `create_package` / `create_package_v2`, `ConfigService.assertFlexiblePricing`, `GET /api/config/features` |
| `is_scrapable` | Ingesta automática desde Cargotrack. `false` = agencia solo-manual (nunca se scrapea). | `true` | `services/ingest.ts`, guard de routing de links |

`is_scrapable` es de **datos/ops**: la UI de Configuración lo muestra pero no lo edita.
`flexible_pricing_enabled` se enciende por migración o por SQL puntual (ver §3).

Branding, moneda y catálogos de pago también son por agencia, pero son datos de
configuración editables desde el panel, no flags de producto.

---

## 2. Cómo se resuelve el flag (nunca desde el cliente)

```
panel (configApi.features())
  → GET /api/config/features            (config:read)
      → ConfigService.isFlexiblePricingEnabled(session.agency)
          → agencies.flexible_pricing_enabled
```

Reglas que ya están implementadas y no hay que romper:

- El endpoint es **self-scoped**: sale de `configSession.agency`. Un `?organizationId=`
  en la URL se ignora a propósito. Un admin de una agencia no consulta el flag de otra.
- El panel usa el flag solo para **mostrar u ocultar UI**. La decisión real se revalida
  server-side en cada ruta (`assertFlexiblePricing`) y en las RPC de creación.
- Si la columna no existe o la fila no aparece, el getter devuelve `false` (fail-closed).
- Un flag encendido no cambia datos existentes: solo habilita la superficie nueva.

---

## 3. Encender / apagar para una agencia

### 3.1 Encender (procedimiento normal)

1. Crear la migración con el CLI (nunca editar prod a mano):

   ```bash
   npx @insforge/cli db migrations new enable-<feature>-<slug>
   ```

2. Escribir un `UPDATE` idempotente con rollback explícito en la cabecera. Modelo:
   [`20261124020000_enable-flexible-pricing-hit.sql`](../migrations/20261124020000_enable-flexible-pricing-hit.sql).

   ```sql
   DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM public.agencies WHERE slug = 'hit') THEN
       RAISE EXCEPTION 'agency hit not found';
     END IF;
   END $$;

   UPDATE public.agencies
     SET flexible_pricing_enabled = TRUE
     WHERE slug = 'hit'
     AND NOT flexible_pricing_enabled;
   ```

   El `WHERE ... AND NOT <columna>` mantiene la migración idempotente: re-aplicarla no
   reescribe nada ni pisa un apagado manual posterior.

3. Aplicar solo lo pendiente:

   ```bash
   npx @insforge/cli db migrations up
   ```

4. Verificar en la base y desde la API:

   ```bash
   npx @insforge/cli db query \
     "select slug, flexible_pricing_enabled from public.agencies where slug = 'hit'"
   ```

   En el panel, entrar con un usuario de esa agencia: la UI del feature aparece si el
   endpoint responde `{ "flexiblePricing": true }`. El flag se lee por sesión, así que
   hay que recargar (no hay push en vivo).

### 3.2 Apagar (rollback)

```sql
UPDATE public.agencies
  SET flexible_pricing_enabled = FALSE
  WHERE slug = 'hit';
```

Se puede correr con `db query` para un apagado de emergencia; para dejarlo versionado,
crear una migración con el mismo patrón. Apagar el flag nunca borra datos ya guardados.

### 3.3 Reglas de seguridad

- **Nunca** un `UPDATE` desde el panel ni desde el sitio: el staff no tiene políticas de
  escritura directas, y un flag editado desde el frontend sería spoofeable.
- Nunca exponer el flag como query param que el cliente pueda elegir.
- Antes de encender un feature en una agencia de producción, confirmar que la agencia
  tiene los datos que el feature necesita (ej. tarjetas de tarifas con precios > 0).
  El owner debe aprobarlo explícitamente; dejarlo escrito en la cabecera de la migración.

---

## 4. Agregar un flag nuevo (checklist)

1. **Migración**: columna `BOOLEAN NOT NULL DEFAULT FALSE` + `COMMENT ON COLUMN` que
   explique alcance y rollback. Nunca default `true`.
2. **Repo**: un getter por agencia (`select <flag> from agencies where slug = ...`, una
   sola subrequest, key de admin).
3. **Servicio**: `isXEnabled(org)` + `assertX(org)` para que cada ruta lo revalide.
4. **Endpoint**: sumar la clave a `GET /api/config/features` (self-scoped, `config:read`).
5. **Panel**: `configApi.features()` → estado local con default `false`; el feature se
   oculta hasta que el endpoint confirme. Nunca leer el flag desde PostgREST directo.
6. **Tests**: default `false` si falta la columna, `true` cuando la fila la tiene, y un
   403/422 en la ruta protegida cuando el flag está apagado.
7. **Docs**: actualizar la tabla de §1 y, si el feature toca permisos, `ROLE_PERMISSIONS`
   (los handlers piden permisos, nunca roles).

---

## 5. Ejemplo aplicado: flexible pricing en HIT Cargo

- Motivación: revisar la superficie de tarifas flexibles con una agencia real propia.
  Antes estaba pilot-only en `suite`.
- Migración: `20261124020000_enable-flexible-pricing-hit.sql` (aprobación explícita del
  owner, 2026-11-24).
- Verificación: `agencies.flexible_pricing_enabled = true` para `hit`; con sesión de HIT,
  `GET /api/config/features` devuelve `flexiblePricing: true`.
- Rollback: `UPDATE public.agencies SET flexible_pricing_enabled = FALSE WHERE slug = 'hit';`
- Ojo al revisar: HIT tiene tarjetas de tipo **peso** (no hay tarjeta fija ni default). En
  modo flexible, un paquete por peso se guarda sin snapshot de cargo (`customer_charge`
  queda `null` hasta facturar); las tarjetas fijas son las que escriben el monto al crear.
  Si se quiere ver el monto en la tabla, crear una tarjeta fija y asignarla.
