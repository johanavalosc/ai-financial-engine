-- ====================================================================
-- SCHEMA: Multi-Tenant Financial & Invoicing Architecture
-- ====================================================================

-- 1. Tenants / Organizations Table
CREATE TABLE IF NOT EXISTS public.empresas (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    nombre TEXT UNIQUE NOT NULL,
    estado TEXT DEFAULT 'ACTIVO',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Users Table with Role-Based Constraints
CREATE TABLE IF NOT EXISTS public.usuarios (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    empresa_id UUID REFERENCES public.empresas(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    nombre_completo TEXT,
    rol TEXT DEFAULT 'DUEÑO' CHECK (rol IN ('DUEÑO', 'CONTADOR', 'EMPLEADO', 'ADMIN')),
    estado TEXT DEFAULT 'ACTIVO',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Invoices / Financial Transactions Table
CREATE TABLE IF NOT EXISTS public.facturas (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    empresa_id UUID REFERENCES public.empresas(id) ON DELETE CASCADE NOT NULL,
    usuario_id UUID REFERENCES public.usuarios(id) ON DELETE SET NULL,
    emisor_nombre TEXT NOT NULL,
    emisor_cedula TEXT,
    receptor_nombre TEXT,
    receptor_cedula TEXT,
    fecha_emision TIMESTAMPTZ NOT NULL,
    consecutivo TEXT,
    monto_subtotal NUMERIC(12, 2) DEFAULT 0.00,
    monto_impuesto NUMERIC(12, 2) DEFAULT 0.00,
    monto_total NUMERIC(12, 2) NOT NULL,
    moneda TEXT DEFAULT 'CRC',
    categoria TEXT DEFAULT 'GASTO_GENERAL',
    estado_pago TEXT DEFAULT 'PAGADO',
    url_comprobante TEXT,
    raw_ai_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for high-performance tenant filtering and aggregations
CREATE INDEX IF NOT EXISTS idx_facturas_empresa_id ON public.facturas(empresa_id);
CREATE INDEX IF NOT EXISTS idx_facturas_fecha_emision ON public.facturas(fecha_emision);
CREATE INDEX IF NOT EXISTS idx_usuarios_empresa_id ON public.usuarios(empresa_id);
