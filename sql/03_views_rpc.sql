-- ====================================================================
-- ANALYTICS & RPC: Reporting Views and Custom Database Functions
-- ====================================================================

-- 1. Aggregated Monthly Financial Reporting View (for Power BI / Dashboards)
CREATE OR REPLACE VIEW public.vw_resumen_financiero_mensual AS
SELECT 
    f.empresa_id,
    e.nombre AS empresa_nombre,
    DATE_TRUNC('month', f.fecha_emision) AS mes,
    f.moneda,
    f.categoria,
    COUNT(f.id) AS total_comprobantes,
    SUM(f.monto_subtotal) AS subtotal_acumulado,
    SUM(f.monto_impuesto) AS impuestos_acumulados,
    SUM(f.monto_total) AS total_gastos
FROM public.facturas f
JOIN public.empresas e ON f.empresa_id = e.id
GROUP BY f.empresa_id, e.nombre, DATE_TRUNC('month', f.fecha_emision), f.moneda, f.categoria;

-- 2. Secure RPC for Real-Time Dashboard KPI Retrieval
CREATE OR REPLACE FUNCTION public.obtener_kpis_empresa(p_empresa_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'total_gastos_mes', COALESCE(SUM(monto_total), 0),
        'total_impuestos_mes', COALESCE(SUM(monto_impuesto), 0),
        'cantidad_facturas', COUNT(id)
    )
    INTO v_result
    FROM public.facturas
    WHERE empresa_id = p_empresa_id
      AND fecha_emision >= DATE_TRUNC('month', CURRENT_DATE);

    RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
