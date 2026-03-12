# Everest Scraper & API Plan - Hit Cargo (v3 - Cloudflare All-in)

Este plan detalla la estrategia definitiva para construir un sistema de scraping inteligente y un ecosistema de API para Hit Cargo, aprovechando la infraestructura de Cloudflare y Supabase para máxima velocidad y cero mantenimiento de servidores.

## Prólogo: Estado del Proyecto
- **Versión Actual**: v2.1.0 (Astro 5 + Preact).
- **Meta**: Lanzamiento de Tracking Dinámico y Sistema Interno en **Abril**.
- **Hito Próximo**: Prototipo funcional para el **15 de Marzo**.

---

## Decisiones de Arquitectura (Modern Stack)

### 1. Cloudflare Ecosystem
Aprovechando **Cloudflare Browser Rendering**, eliminamos la necesidad de servidores externos (Railway/Vercel).
- **API**: Hono corriendo en Cloudflare Workers.
- **Scraper**: Playwright conectado vía Remote Browser a Cloudflare.
- **Ventaja**: El tráfico de scraping sale de la red de Cloudflare, reduciendo el riesgo de bloqueo por IP y bajando la latencia a casi cero.

### 2. Persistencia y Usuarios (Supabase)
Supabase no solo será nuestro historial, sino el núcleo del **sistema de clientes**:
- **Auth**: Gestión de usuarios/empresas (Hit Cargo Clients).
- **PostgreSQL**: Tablas para envíos, histórico de >1 año y el futuro sistema de puntos.
- **Backups**: Automatizados dentro del tier gratuito inicial.

### 3. El Sistema de Clientes: ¿Hono?
**Ba dum tss... ¡Sí!** Usaremos Hono también para el sistema de clientes.
- **Escalabilidad**: Hono maneja miles de SRPS (Requests per Second) con un cold-start casi inexistente.
- **Features**: Al usar Hono con Supabase Auth, podemos crear un portal de clientes robusto donde empresas de alto nivel vean sus envíos, ganen libras y gestionen sus puntos con una lógica moderna.

---

## Notas Técnicas: Scrapeando Everest (Classic ASP)

Basado en el sistema `everest.cargotrack.net` (Classic ASP):
- **Identificadores**: El HTML es "viejito" pero consistente. Usaremos selectores como `td` y clases específicas para capturar el número de almacén (ej. "852786").
- **Cookie Vault**: La sesión depende de `ASPSESSIONID...`. 
  - Guardaremos estas cookies en **Upstash Redis**.
  - El Worker las inyectará en cada sesión de Cloudflare Browser para omitir el login.
- **IA Parsing**: No perderemos tiempo con selectores CSS frágiles para cada campo. Playwright capturará el bloque `<table id="Almacen...">` y se lo pasará a **GPT-4o-mini** para extraer el JSON estructurado.

---

## Plan Paso a Paso (Roadmap)

### Paso 1: Infraestructura Cloudflare & Supabase
1. **Cloudflare**: Habilitar "Browser Rendering API" en el dashboard.
2. **Supabase**: 
   - Crear tabla `shipments` (guia, warehouse_id, weight, status, etc.).
   - Crear tabla `points_ledger` para el sistema de libras/incentivos.
3. **Environment**: Configurar secretos en Cloudflare (API Keys de OpenAI, Supabase URL y Session Redis).

### Paso 2: El Scraper "Invisible" (Meta: 15 de Marzo 🎂)
1. **Login Flow**: Script en Playwright que maneja el form de `default.asp` y extrae las cookies de sesión.
2. **Multi-Session**: Lógica en la Worker para rotar sesiones o refrescarlas cada 12-15 minutos automáticamente.
3. **Data Extraction**: Navegar directamente a las vistas de "Almacén" y capturar los eventos de seguimiento.

### Paso 3: API Hono para Clientes y Web
1. **Endpoint `/track/:id`**: 
   - 1. Busca en Supabase (Cache hit).
   - 2. Si no está o es viejo, dispara Cloudflare Browser.
   - 3. IA limpia la data -> Guarda en Supabase -> Responde al sitio Astro.
2. **Endpoint `/points`**: Primera versión de la lógica de acumulado de libras por cliente.

### Paso 4: Integración Hit Cargo (Abril)
1. **Portal de Cliente**: Nueva sección en la web de Astro protegida por Supabase Auth.
2. **Internal Dashboard**: Vista de control para Hit Cargo para gestionar envíos silenciosamente procesados.

---

## Plan de Verificación y Futuro
- **Silent Processing**: El sistema debería procesar los nuevos envíos en segundo plano (Cloudflare Cron Triggers) para que cuando el cliente consulte, la data ya esté lista.
- **Escalabilidad**: Preparado para manejar empresas con volumen masivo compartiendo el mismo núcleo de API.
