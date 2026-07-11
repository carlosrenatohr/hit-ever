-- ============================================================================
-- Dedicated billing role (SaaS-style: billing access separate from ops staff).
-- ============================================================================
-- `admin` and `billing` can read+write invoices; `staff` gets read-only billing;
-- `viewer` has none. The mapping itself lives in the Worker auth middleware
-- (src/modules/billing/middleware/auth.ts); this only adds the enum value.
alter type staff_role add value if not exists 'billing';
