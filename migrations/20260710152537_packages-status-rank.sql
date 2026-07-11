-- Default "ready for pickup first" ordering for the panel.
-- status_rank is a stored generated column so PostgREST can order/index on it directly (it can't
-- express a CASE in ?order=). It mirrors effective_status (coalesce(manual_status, status)) — we
-- repeat that expression here because a generated column may not reference another generated one.
-- Lower number = shown first: packages waiting to be picked up in Nicaragua (en_destino) lead,
-- delivered ones sink to the bottom.
alter table public.packages
  add column if not exists status_rank smallint
  generated always as (
    case coalesce(manual_status, status)
      when 'en_destino'  then 1  -- arrived in Nicaragua → ready for pickup (most actionable)
      when 'en_transito' then 2  -- on the way
      when 'parcial'     then 3
      when 'en_almacen'  then 4  -- still in the Miami warehouse
      when 'excepcion'   then 5  -- held / needs attention
      when 'desconocido' then 6
      when 'entregado'   then 7  -- done → bottom
      else 6
    end
  ) stored;

-- Composite index matching the default sort (status_rank asc, then oldest Miami reception first).
create index if not exists idx_packages_status_rank_received
  on public.packages (status_rank asc, received_at asc);
