-- ====================================================================
-- SECURITY: Row-Level Security (RLS) Policies
-- Strict tenant isolation at the database layer
-- ====================================================================

-- 1. Enable RLS on core tables
ALTER TABLE public.empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facturas ENABLE ROW LEVEL SECURITY;

-- 2. Tenant Isolation Policy for Invoices
-- Users can only SELECT and INSERT records belonging to their assigned enterprise
CREATE POLICY "RLS_facturas_tenant_isolation_select"
ON public.facturas
FOR SELECT
USING (
    empresa_id IN (
        SELECT u.empresa_id 
        FROM public.usuarios u 
        WHERE u.id = auth.uid()
    )
);

CREATE POLICY "RLS_facturas_tenant_isolation_insert"
ON public.facturas
FOR INSERT
WITH CHECK (
    empresa_id IN (
        SELECT u.empresa_id 
        FROM public.usuarios u 
        WHERE u.id = auth.uid()
    )
);

-- 3. Service Role Bypass for Background Workers / Pipelines
CREATE POLICY "RLS_service_role_full_access"
ON public.facturas
FOR ALL
USING (auth.jwt() ->> 'role' = 'service_role');
