-- Repair partial invoices: line items pointing at a package without an invoice_packages link.
-- Incident 2026-10-24 (original-express): invoices created before the Worker's 50-subrequest
-- budget was fixed died mid link-loop, leaving header + line items but missing links
-- (e.g. invoice #85 has 11 lines / 3 links, so 8 packages look un-invoiced and can be
-- double-billed). This repairs LIVE invoices only, one link per (invoice, package) line,
-- never touching a package that already has an active link in another invoice.
-- Idempotent: re-running inserts nothing (the not-exists guards + on conflict do nothing).
-- Rollback for the repaired rows: delete from invoice_packages where created_by = 'system:repair-links';

insert into public.invoice_packages
  (invoice_id, package_id, source, matched_oc, created_by, organization_id, active)
select li.invoice_id, li.package_id, 'manual', li.package_guia, 'system:repair-links',
       i.organization_id, true
from public.invoice_line_items li
join public.invoices i on i.id = li.invoice_id
where i.deleted_at is null
  and li.package_id is not null
  and not exists (
    select 1 from public.invoice_packages ip
    where ip.invoice_id = li.invoice_id and ip.package_id = li.package_id)
  and not exists (
    select 1 from public.invoice_packages ip2
    where ip2.package_id = li.package_id and ip2.active = true)
on conflict (invoice_id, package_id) do nothing;
