/* ==========================================================================
   NAUTILUS DASHBOARD - APP LOGIC
   ========================================================================== */

// 1. Configuración de Supabase
const SUPABASE_URL = 'https://itktqibbuqmqpvonnwsw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml0a3RxaWJidXFtcXB2b25ud3N3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NDQ4MTksImV4cCI6MjA5OTIyMDgxOX0.33XzASB838k_RMdS1FncOmjRgVeypjUSQ3ZSX4-ex1Q';
const { createClient } = window.supabase;
const dbClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// Helper para parsear fechas UTC en local evitando desfase de Timezone
function parseUTCDate(dateString) {
    if (!dateString) return null;
    const datePart = dateString.includes('T') ? dateString.split('T')[0] : dateString;
    const [year, month, day] = datePart.split('-');
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

function getSaldoPendiente(f) {
    const isPaid = f.estado === 'PAGADA' || f.estado === 'APROBADA';
    if (isPaid) return 0;
    
    const total = parseFloat(f.total || 0);
    const pagado = parseFloat(f.monto_pagado !== undefined && f.monto_pagado !== null ? f.monto_pagado : 0);
    return Math.max(0, total - pagado);
}

function getTiempoRestanteHTML(vencimiento, estado) {
    if (!vencimiento) return '';
    const isPaid = estado === 'PAGADA' || estado === 'APROBADA';
    if (isPaid) return ''; // No mostrar días faltantes para facturas ya canceladas
    
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    
    const vDate = new Date(vencimiento);
    vDate.setHours(0, 0, 0, 0);
    
    const diffTime = vDate - hoy;
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    let text = '';
    let color = 'var(--gray-400)';
    
    if (diffDays === 0) {
        text = 'vence hoy';
        color = 'var(--status-coral)';
    } else if (diffDays === 1) {
        text = 'vence mañana';
        color = '#F59E0B'; // Amber
    } else if (diffDays === -1) {
        text = 'venció ayer';
        color = 'var(--status-coral)';
    } else if (diffDays < -1) {
        text = `hace ${Math.abs(diffDays)} días`;
        color = 'var(--status-coral)';
    } else {
        text = `faltan ${diffDays} días`;
        if (diffDays <= 3) {
            color = '#F59E0B';
        } else {
            color = 'var(--gray-400)';
        }
    }
    
    return `<div style="font-size: 0.75rem; color: ${color}; margin-top: 0.15rem; font-weight: 500;">${text}</div>`;
}

// 2. Estado de la Aplicación
let currentSession = null;
let currentEmpresaId = null;
let currentMonth = new Date(2026, 6, 1); // Empezamos en Julio 2026 por defecto
let expenseChartInstance = null;
let currentTab = 'pendientes';
let facturasList = [];
let historialFacturasList = [];
let proveedoresList = [];
let selectedProveedor = null;

// 3. Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    // Adjuntar eventos PRIMERO para evitar que el form recargue la página si hay error
    setupEventListeners();
    setupLinksModalLogic();

    try {
        // Revisar sesión activa
        const { data: { session }, error } = await dbClient.auth.getSession();
        
        if (session) {
            currentSession = session;
            await loadUserData();
            showDashboard();
        } else {
            showLogin();
        }
    } catch(err) {
        console.error("Error inicializando sesión:", err);
        showLogin();
    }
});

// ==========================================================================
// AUTENTICACIÓN
// ==========================================================================

function showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-container').classList.add('hidden');
    const chatContainer = document.getElementById('nautilus-chat-container');
    if (chatContainer) chatContainer.classList.add('hidden');
    if (typeof limpiarChatLocal === 'function') limpiarChatLocal();
}

function showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    const chatContainer = document.getElementById('nautilus-chat-container');
    if (chatContainer) {
        chatContainer.classList.remove('hidden');
        if (typeof inicializarChat === 'function') inicializarChat();
    }
    refreshDashboardData();
    refreshHistorialData();
}

async function loadUserData() {
    try {
        if (!currentSession?.user) return;
        const userEmail = currentSession.user.email;
        const userId = currentSession.user.id;

        // 1. Obtener la relación del usuario con su empresa (por ID o email)
        let { data: userRow } = await dbClient
            .from('usuarios')
            .select('empresa_id')
            .eq('id', userId)
            .limit(1)
            .maybeSingle();

        if (!userRow) {
            const { data: userByEmail } = await dbClient
                .from('usuarios')
                .select('empresa_id')
                .eq('email', userEmail)
                .limit(1)
                .maybeSingle();
            userRow = userByEmail;
        }

        // 2. Si el usuario tiene empresa vinculada, cargar nombre
        if (userRow?.empresa_id) {
            currentEmpresaId = userRow.empresa_id;
            const { data: empRow } = await dbClient
                .from('empresas')
                .select('nombre')
                .eq('id', userRow.empresa_id)
                .limit(1)
                .maybeSingle();

            if (empRow?.nombre) {
                document.getElementById('company-name').textContent = empRow.nombre;
                return;
            }
            // Empresa vinculada pero sin nombre (raro) — mostrar ID como fallback seguro
            document.getElementById('company-name').textContent = 'Mi Empresa';
            return;
        }

        // 3. Sin empresa vinculada — error explícito, nunca asignar empresa aleatoria
        currentEmpresaId = null;
        console.error(`[Nautilus] Usuario ${userEmail} no tiene empresa vinculada en la tabla 'usuarios'. Contactar al administrador.`);
        document.getElementById('company-name').innerHTML =
            `Sin empresa <span style="color:var(--status-coral); font-size:0.85rem; display:block;">Cuenta no vinculada. Contacta al admin.</span>`;

    } catch (e) {
        console.error("Error cargando perfil:", e);
        document.getElementById('company-name').innerHTML = `Mi Empresa <span style="color:var(--status-coral); font-size:1rem; display:block;">Error: ${e.message || JSON.stringify(e)}</span>`;
    }
}


// ==========================================================================
// EVENT LISTENERS
// ==========================================================================

function setupEventListeners() {
    // Olvidaste tu contraseña
    const forgotLink = document.getElementById('forgot-password-link');
    if (forgotLink) {
        forgotLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const emailInput = document.getElementById('email').value.trim();
            if (!emailInput) {
                alert('Por favor, ingresa tu correo electrónico en el campo superior.');
                return;
            }
            const err = document.getElementById('login-error');
            err.style.color = '#10b981';
            err.textContent = 'Enviando correo de recuperación...';
            try {
                const { error } = await dbClient.auth.resetPasswordForEmail(emailInput, {
                    redirectTo: window.location.origin + '/onboarding.html'
                });
                if (error) throw error;
                err.textContent = '✓ Enlace enviado. Revisa tu bandeja de entrada.';
            } catch (errRes) {
                err.style.color = 'var(--status-coral)';
                err.textContent = errRes.message || 'Error al solicitar el enlace de recuperación.';
            }
        });
    }

    // Login
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('email').value.trim();
        const password = document.getElementById('password').value;
        const btn = document.getElementById('login-btn');
        const err = document.getElementById('login-error');
        
        btn.textContent = "Conectando...";
        err.textContent = "";
        
        // Bypass instantáneo para pruebas locales en Modo Demo
        if (email.toLowerCase() === 'demo' || email.toLowerCase().startsWith('demo@')) {
            console.warn("Bypass de autenticación. Activando Modo Demo Local.");
            currentSession = { user: { email: 'demo@demo.com' } };
            currentEmpresaId = 'demo-id';
            document.getElementById('company-name').textContent = "Empresa Prueba 2 (Modo Demo)";
            facturasList = [
                { id: 'f1', numero_factura: 'F-ELEV-2026-1045', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-07-17', total: 239560, estado: 'PENDIENTE', monto_pagado: 119780 },
                { id: 'f2', numero_factura: 'F-ELEV-2026-1044', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-06-14', total: 100000, estado: 'PENDIENTE', monto_pagado: 0 },
                { id: 'f3', numero_factura: 'F-ELEV-2026-1043', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-04-10', total: 64000, estado: 'PAGADA', monto_pagado: 64000 },
                { id: 'f4', numero_factura: 'F-OBRA-2026-8801', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-05-12', total: 31000, estado: 'PAGADA', monto_pagado: 31000 },
                { id: 'f5', numero_factura: 'F-OBRA-2026-8802', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-07-15', total: 275000, estado: 'PENDIENTE', monto_pagado: 0 },
                { id: 'f6', numero_factura: 'F-OBRA-2026-8803', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-06-10', total: 224000, estado: 'PENDIENTE', monto_pagado: 0 },
                { id: 'f7', numero_factura: 'TORN-2026-0422', proveedor: 'Tornileria y Fijaciones Industriales S.A.', fecha_emision: '2026-05-08', total: 306000, estado: 'PAGADA', monto_pagado: 306000 }
            ];
            historialFacturasList = [...facturasList];
            showDashboard();
            return;
        }
        
        const { data, error } = await dbClient.auth.signInWithPassword({ email, password });
        
        if (error) {
            if (error.message === 'Failed to fetch') {
                console.warn("Red bloqueada. Activando Modo Demo.");
                currentSession = { user: { email: 'demo@demo.com' } };
                currentEmpresaId = 'demo-id';
                document.getElementById('company-name').textContent = "Empresa Prueba 2 (Modo Demo Offline)";
                facturasList = [
                    { id: 'f1', numero_factura: 'F-ELEV-2026-1045', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-07-17', total: 239560, estado: 'PENDIENTE', monto_pagado: 119780, moneda: 'CRC' },
                    { id: 'f2', numero_factura: 'F-ELEV-2026-1044', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-06-14', total: 100000, estado: 'PENDIENTE', monto_pagado: 0, moneda: 'CRC' },
                    { id: 'f3', numero_factura: 'F-ELEV-2026-1043', proveedor: 'Equipos de Elevación y Carga S.A.', fecha_emision: '2026-04-10', total: 64000, estado: 'PAGADA', monto_pagado: 64000, moneda: 'CRC' },
                    { id: 'f4', numero_factura: 'F-OBRA-2026-8801', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-05-12', total: 31000, estado: 'PAGADA', monto_pagado: 31000, moneda: 'CRC' },
                    { id: 'f5', numero_factura: 'F-OBRA-2026-8802', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-07-15', total: 275000, estado: 'PENDIENTE', monto_pagado: 0, moneda: 'CRC' },
                    { id: 'f6', numero_factura: 'F-OBRA-2026-8803', proveedor: 'Materiales y Agregados del Sur S.A.', fecha_emision: '2026-06-10', total: 224000, estado: 'PENDIENTE', monto_pagado: 0, moneda: 'CRC' },
                    { id: 'f7', numero_factura: 'TORN-2026-0422', proveedor: 'Tornileria y Fijaciones Industriales S.A.', fecha_emision: '2026-05-08', total: 306000, estado: 'PAGADA', monto_pagado: 306000, moneda: 'CRC' }
                ];
                historialFacturasList = [...facturasList];
                showDashboard();
                return;
            }
            err.textContent = `Error: ${error.message}`;
            btn.textContent = "Acceder al Dashboard";
        } else {
            currentSession = data.session;
            await loadUserData();
            showDashboard();
        }
    });

    // Logout
    document.getElementById('logout-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        await dbClient.auth.signOut();
        currentSession = null;
        currentEmpresaId = null;
        showLogin();
    });

    // Sidebar Navigation
    const navItems = document.querySelectorAll('.sidebar-nav .nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            const viewId = item.getAttribute('data-view');
            document.querySelectorAll('.view-section').forEach(section => {
                section.classList.add('hidden');
                section.classList.remove('active');
            });
            const targetView = document.getElementById(`view-${viewId}`);
            if(targetView) {
                targetView.classList.remove('hidden');
                targetView.classList.add('active');
            }

            // Si es la vista de Historial Facturas, cargar datos históricos
            if (viewId === 'facturas') {
                refreshHistorialData();
            } else if (viewId === 'proveedores') {
                refreshProveedoresData();
            } else if (viewId === 'precios') {
                refreshPreciosData();
            }
        });
    });

    // Historial Filters & Search
    const hSearch = document.getElementById('historial-search');
    const hFilterPeriodo = document.getElementById('historial-filter-periodo');
    const hFilterFechaExacta = document.getElementById('historial-filter-fecha-exacta');
    const hFilterEstado = document.getElementById('historial-filter-estado');
    const hFilterMoneda = document.getElementById('historial-filter-moneda');
    const btnLimpiar = document.getElementById('btn-limpiar-filtros');
    
    if (hSearch) hSearch.addEventListener('input', filterAndRenderHistorial);
    if (hFilterPeriodo) hFilterPeriodo.addEventListener('change', () => {
        if (hFilterFechaExacta) hFilterFechaExacta.value = '';
        filterAndRenderHistorial();
    });
    if (hFilterFechaExacta) hFilterFechaExacta.addEventListener('input', () => {
        if (hFilterPeriodo && hFilterFechaExacta.value) hFilterPeriodo.value = 'TODOS';
        filterAndRenderHistorial();
    });
    if (hFilterEstado) hFilterEstado.addEventListener('change', filterAndRenderHistorial);
    if (hFilterMoneda) hFilterMoneda.addEventListener('change', filterAndRenderHistorial);
    if (btnLimpiar) {
        btnLimpiar.addEventListener('click', () => {
            if (hSearch) hSearch.value = '';
            if (hFilterPeriodo) hFilterPeriodo.value = 'TODOS';
            if (hFilterFechaExacta) hFilterFechaExacta.value = '';
            if (hFilterEstado) hFilterEstado.value = 'TODOS';
            if (hFilterMoneda) hFilterMoneda.value = 'TODAS';
            filterAndRenderHistorial();
        });
    }

    // Proveedores Search
    const pSearch = document.getElementById('proveedores-search');
    if (pSearch) pSearch.addEventListener('input', filterAndRenderProveedores);

    // Precios Filters & Actions
    const prSearch = document.getElementById('precios-search');
    const prFilterProv = document.getElementById('precios-filter-proveedor');
    const prFilterTend = document.getElementById('precios-filter-tendencia');
    const prDetailClose = document.getElementById('precios-detail-close');
    
    if (prSearch) prSearch.addEventListener('input', filterAndRenderPrecios);
    if (prFilterProv) prFilterProv.addEventListener('change', filterAndRenderPrecios);
    if (prFilterTend) prFilterTend.addEventListener('change', filterAndRenderPrecios);
    if (prDetailClose) prDetailClose.addEventListener('click', () => {
        const panel = document.getElementById('precios-detail-panel');
        if (panel) panel.classList.add('hidden');
        selectedProductoKey = null;
        document.querySelectorAll('.insumo-card').forEach(card => card.classList.remove('selected'));
    });

    // Month Selector
    updateMonthDisplay();
    document.getElementById('prev-month').addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() - 1);
        onMonthChanged();
    });
    document.getElementById('next-month').addEventListener('click', () => {
        currentMonth.setMonth(currentMonth.getMonth() + 1);
        onMonthChanged();
    });

    // Tabs
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.getAttribute('data-tab');
            renderInvoicesTable();
        });
    });

    // Toggle Password
    const togglePwd = document.getElementById('toggle-password');
    if(togglePwd) {
        togglePwd.addEventListener('click', () => {
            const pwdInput = document.getElementById('password');
            if (pwdInput.type === 'password') {
                pwdInput.type = 'text';
                togglePwd.innerHTML = '<i data-lucide="eye"></i>';
            } else {
                pwdInput.type = 'password';
                togglePwd.innerHTML = '<i data-lucide="eye-off"></i>';
            }
            lucide.createIcons();
        });
    }

    // Modal Close
    const invoiceModal = document.getElementById('invoice-modal');
    const invoiceCloseBtn = document.getElementById('modal-close');
    if (invoiceCloseBtn) invoiceCloseBtn.addEventListener('click', closeModal);
    if (invoiceModal) {
        invoiceModal.addEventListener('click', (e) => {
            if (e.target === invoiceModal) closeModal();
        });
    }

    // Provider Invoices Modal Close
    const providerModal = document.getElementById('provider-invoices-modal');
    const providerModalClose = document.getElementById('provider-modal-close');
    if (providerModalClose) {
        providerModalClose.addEventListener('click', () => {
            if (providerModal) providerModal.classList.add('hidden');
        });
    }
    if (providerModal) {
        providerModal.addEventListener('click', (e) => {
            if (e.target === providerModal) providerModal.classList.add('hidden');
        });
    }
}

function updateMonthDisplay() {
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    document.getElementById('current-month-display').textContent = `${meses[currentMonth.getMonth()]} ${currentMonth.getFullYear()}`;
}

function onMonthChanged() {
    updateMonthDisplay();
    
    // 1. Recargar Dashboard
    refreshDashboardData();
    
    // 2. Recargar Proveedores (filtrando por currentMonth)
    refreshProveedoresData();
    
    // 3. Sincronizar Historial de Facturas
    const periodSelect = document.getElementById('historial-filter-periodo');
    if (periodSelect) {
        const anio = currentMonth.getFullYear();
        const mesStr = String(currentMonth.getMonth()).padStart(2, '0');
        const key = `${anio}-${mesStr}`;
        
        let optionExists = false;
        for (let i = 0; i < periodSelect.options.length; i++) {
            if (periodSelect.options[i].value === key) {
                optionExists = true;
                break;
            }
        }
        
        if (optionExists) {
            periodSelect.value = key;
        } else {
            periodSelect.value = 'TODOS';
        }
        filterAndRenderHistorial();
    }
}

// ==========================================================================
// DATA FETCHING & RENDERING
// ==========================================================================

async function refreshDashboardData() {
    if (!currentEmpresaId) return;
    
    // Obtener primer y último día del mes
    if (currentEmpresaId !== 'demo-id') {
        const year = currentMonth.getFullYear();
        const month = String(currentMonth.getMonth() + 1).padStart(2, '0');
        const lastDayNum = new Date(year, currentMonth.getMonth() + 1, 0).getDate();
        
        const firstDay = `${year}-${month}-01`;
        const lastDay = `${year}-${month}-${String(lastDayNum).padStart(2, '0')}`;

        const { data: facturas, error } = await dbClient
            .from('facturas')
            .select('*')
            .eq('empresa_id', currentEmpresaId)
            .gte('fecha_emision', firstDay)
            .lte('fecha_emision', lastDay)
            .order('fecha_emision', { ascending: false });

        if (error) {
            console.error("Error fetching facturas:", error);
            return;
        }
        facturasList = facturas || [];

        // Query adicional: todas las facturas PENDIENTES (sin filtro de mes) para el Centro de Alertas
        const { data: facturasPendientesGlobal } = await dbClient
            .from('facturas')
            .select('id, proveedor, total, estado, fecha_emision, fecha_vencimiento')
            .eq('empresa_id', currentEmpresaId)
            .in('estado', ['PENDIENTE', 'APROBADA']);

        window._facturasPendientesGlobal = facturasPendientesGlobal || [];
    } else {
        // En Modo Demo, filtramos facturasList de historialFacturasList según el mes seleccionado
        const year = currentMonth.getFullYear();
        const month = currentMonth.getMonth();
        
        facturasList = historialFacturasList.filter(f => {
            const d = parseUTCDate(f.fecha_emision);
            return d && d.getFullYear() === year && d.getMonth() === month;
        });
        window._facturasPendientesGlobal = historialFacturasList.filter(f => f.estado === 'PENDIENTE' || f.estado === 'APROBADA');
    }
    
    // Calcular KPIs
    calculateKPIs(facturasList);
    
    // Renderizar Proveedores
    renderTopSuppliers(facturasList);
    
    // Renderizar Tabla
    renderInvoicesTable();
    
    // Renderizar Gráfico
    renderTrendChart();
}

function formatMoney(amount) {
    return '₡' + parseFloat(amount).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calculateKPIs(facturas) {
    const mesActualYear = currentMonth.getFullYear();
    const mesActualMonth = currentMonth.getMonth();
    
    const prevMonthDate = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1);
    const mesAnteriorYear = prevMonthDate.getFullYear();
    const mesAnteriorMonth = prevMonthDate.getMonth();

    const sourceList = (historialFacturasList && historialFacturasList.length > 0) ? historialFacturasList : facturas;
    
    const facturasMesActual = sourceList.filter(f => {
        const d = parseUTCDate(f.fecha_emision);
        return d && d.getFullYear() === mesActualYear && d.getMonth() === mesActualMonth;
    });
    
    const facturasMesAnterior = sourceList.filter(f => {
        const d = parseUTCDate(f.fecha_emision);
        return d && d.getFullYear() === mesAnteriorYear && d.getMonth() === mesAnteriorMonth;
    });

    let totalGasto = 0;
    let procesadas = facturasMesActual.length;
    let pendientes = 0;

    facturasMesActual.forEach(f => {
        totalGasto += parseFloat(f.total || 0);
        if (f.estado === 'PENDIENTE') pendientes++;
    });

    let totalGastoAnterior = 0;
    let procesadasAnterior = facturasMesAnterior.length;

    facturasMesAnterior.forEach(f => {
        totalGastoAnterior += parseFloat(f.total || 0);
    });

    // Animación de conteo suave (opcional, por ahora directo)
    document.getElementById('kpi-gasto').textContent = formatMoney(totalGasto);
    document.getElementById('kpi-procesadas').textContent = procesadas;
    document.getElementById('kpi-pendientes-count').textContent = pendientes;
    document.getElementById('tab-count-pendientes').textContent = pendientes;

    // Actualizar leyenda de Gasto
    const gastoDesc = document.getElementById('kpi-gasto-desc');
    if (gastoDesc) {
        const diffGasto = totalGasto - totalGastoAnterior;
        if (totalGastoAnterior === 0 && totalGasto === 0) {
            gastoDesc.innerHTML = 'Sin gastos registrados en este periodo ni en el anterior.';
        } else if (totalGastoAnterior === 0) {
            gastoDesc.innerHTML = `Has gastado <strong>${formatMoney(totalGasto)}</strong> (primer mes con registros).`;
        } else {
            const absoluteDiff = Math.abs(diffGasto);
            if (diffGasto > 0) {
                gastoDesc.innerHTML = `Has gastado <strong style="color: #F87171;">${formatMoney(absoluteDiff)} más</strong> que el mes anterior.`;
            } else if (diffGasto < 0) {
                gastoDesc.innerHTML = `Has gastado <strong style="color: #34D399;">${formatMoney(absoluteDiff)} menos</strong> que el mes anterior.`;
            } else {
                gastoDesc.innerHTML = 'Gastaste exactamente la misma cantidad que el mes anterior.';
            }
        }
    }

    // Actualizar leyenda de Facturas Procesadas
    const procesadasDesc = document.getElementById('kpi-procesadas-desc');
    if (procesadasDesc) {
        const diffFacturas = procesadas - procesadasAnterior;
        if (procesadasAnterior === 0 && procesadas === 0) {
            procesadasDesc.innerHTML = 'Sin transacciones en este periodo ni en el anterior.';
        } else if (procesadasAnterior === 0) {
            procesadasDesc.innerHTML = `Son <strong>${procesadas} facturas</strong> procesadas en total.`;
        } else {
            const absoluteDiff = Math.abs(diffFacturas);
            if (diffFacturas > 0) {
                procesadasDesc.innerHTML = `Son <strong>${absoluteDiff} facturas más</strong> que el mes anterior.`;
            } else if (diffFacturas < 0) {
                procesadasDesc.innerHTML = `Son <strong>${absoluteDiff} facturas menos</strong> que el mes anterior.`;
            } else {
                procesadasDesc.innerHTML = 'Misma cantidad de facturas que el mes anterior.';
            }
        }
    }

    // Diagnósticos y Recomendaciones — Centro de Alertas
    // Pasamos facturas COMPLETAS para detectar vencimientos de todos los meses
    updateAIDiagnostics(facturasMesActual, facturasMesAnterior, sourceList, window._facturasPendientesGlobal || sourceList);
}

// ============================================================
// CENTRO DE ALERTAS — Ticker rotativo con priorización
// ============================================================

let _alertasActuales = [];
let _alertaIndice = 0;
let _alertaIntervalId = null;

const ALERTA_COLORES = {
    critico:    { borde: '#EF4444', iconBg: 'rgba(239,68,68,0.1)',    texto: '#991B1B' },
    advertencia:{ borde: '#F59E0B', iconBg: 'rgba(245,158,11,0.1)',   texto: '#92400E' },
    info:       { borde: '#3B82F6', iconBg: 'rgba(59,130,246,0.1)',   texto: '#1E3A8A' },
    ok:         { borde: '#10B981', iconBg: 'rgba(16,185,129,0.1)',   texto: '#065F46' },
};

function getVencimientoDate(f) {
    if (f.fecha_vencimiento) {
        return parseUTCDate(f.fecha_vencimiento);
    }
    if (f.fecha_emision) {
        const em = parseUTCDate(f.fecha_emision);
        if (em) {
            const d = new Date(em);
            d.setDate(d.getDate() + 30);
            return d;
        }
    }
    return null;
}

function buildAlertas(facturasMesActual, facturasMesAnterior, sourceList, todasLasFacturas) {
    const alertas = [];
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);

    let totalActual = 0;
    facturasMesActual.forEach(f => totalActual += parseFloat(f.total || 0));
    let totalAnterior = 0;
    facturasMesAnterior.forEach(f => totalAnterior += parseFloat(f.total || 0));

    // Usar lista completa para detectar vencimientos (no solo el mes visible)
    const listaVencimientos = (todasLasFacturas && todasLasFacturas.length > 0) ? todasLasFacturas : sourceList;

    // Clasificar facturas pendientes por vencimiento efectivo
    let vencidasHaceXDias = [];
    let vencenHoy = [];
    let vencenPronto = []; // ≤ 7 días
    let saldoTotalPendiente = 0;

    listaVencimientos.forEach(f => {
        if (f.estado === 'PENDIENTE' || f.estado === 'APROBADA' || f.estado === null) {
            saldoTotalPendiente += parseFloat(f.total || 0);
            const venc = getVencimientoDate(f);
            if (!venc) return;
            const diff = Math.round((venc - hoy) / (1000 * 60 * 60 * 24));
            if (diff < 0)       vencidasHaceXDias.push({ ...f, diasVencida: Math.abs(diff) });
            else if (diff === 0) vencenHoy.push(f);
            else if (diff <= 7)  vencenPronto.push({ ...f, diasRestantes: diff });
        }
    });

    // Proveedor principal
    const suppliers = {};
    facturasMesActual.forEach(f => {
        const p = f.proveedor || 'Desconocido';
        suppliers[p] = (suppliers[p] || 0) + parseFloat(f.total || 0);
    });
    const sorted = Object.entries(suppliers).sort((a, b) => b[1] - a[1]);
    const topProv = sorted[0] ? { name: sorted[0][0], total: sorted[0][1] } : null;
    const topProvPct = totalActual > 0 && topProv ? Math.round((topProv.total / totalActual) * 100) : 0;

    // ---- GENERAR ALERTAS ESPECÍFICAS POR FACTURA ----

    // 1. Alertas individuales por cada factura VENCIDA (CRÍTICO)
    vencidasHaceXDias.forEach(f => {
        const numFactura = f.numero_factura ? `<strong>${f.numero_factura}</strong> ` : '';
        const prov = f.proveedor || 'Proveedor desglosado';
        alertas.push({
            nivel: 'critico',
            emoji: '🚨',
            mensaje: `La factura ${numFactura}de <strong>${prov}</strong> está vencida hace <strong>${f.diasVencida} día${f.diasVencida > 1 ? 's' : ''}</strong> — monto pendiente: <strong>${formatMoney(f.total)}</strong>.`,
            accion: `Gestiona el pago de ${formatMoney(f.total)} a ${prov} para evitar cargos por mora.`
        });
    });

    // 2. Alertas individuales para facturas que VENCEN HOY (CRÍTICO)
    vencenHoy.forEach(f => {
        const numFactura = f.numero_factura ? `<strong>${f.numero_factura}</strong> ` : '';
        const prov = f.proveedor || 'Proveedor';
        alertas.push({
            nivel: 'critico',
            emoji: '⏰',
            mensaje: `La factura ${numFactura}de <strong>${prov}</strong> vence <strong>HOY</strong> — monto: <strong>${formatMoney(f.total)}</strong>.`,
            accion: `Confirma la transferencia a ${prov} antes del cierre de día.`
        });
    });

    // 3. Alertas individuales para facturas PRÓXIMAS A VENCER (ADVERTENCIA)
    vencenPronto.forEach(f => {
        const numFactura = f.numero_factura ? `<strong>${f.numero_factura}</strong> ` : '';
        const prov = f.proveedor || 'Proveedor';
        alertas.push({
            nivel: 'advertencia',
            emoji: '⚠️',
            mensaje: `La factura ${numFactura}de <strong>${prov}</strong> vence en <strong>${f.diasRestantes} día${f.diasRestantes > 1 ? 's' : ''}</strong> — monto: <strong>${formatMoney(f.total)}</strong>.`,
            accion: `Agenda el pago de ${formatMoney(f.total)} antes del vencimiento.`
        });
    });

    // 4. Saldo total acumulado pendiente
    if (saldoTotalPendiente > 0 && (vencidasHaceXDias.length > 0 || vencenPronto.length > 0)) {
        alertas.push({
            nivel: 'advertencia',
            emoji: '💰',
            mensaje: `Tienes un <strong>saldo total pendiente por cancelar de ${formatMoney(saldoTotalPendiente)}</strong> acumulado en tus cuentas por pagar.`,
            accion: 'Verifica tu flujo de caja antes de comprometer nuevos gastos.'
        });
    }

    // 5. Concentración de proveedor principal
    if (topProv && topProvPct >= 20 && facturasMesActual.length >= 1) {
        alertas.push({
            nivel: 'info',
            emoji: '🏢',
            mensaje: `<strong>${topProv.name}</strong> es tu principal proveedor este mes, acumulando el <strong>${topProvPct}%</strong> de tus gastos (${formatMoney(topProv.total)}).`,
            accion: 'Revisa periódicamente las condiciones comerciales con tus principales emisores.'
        });
    }

    // 6. Resumen del mes
    if (facturasMesActual.length > 0) {
        alertas.push({
            nivel: 'info',
            emoji: '📊',
            mensaje: `Has registrado <strong>${facturasMesActual.length} facturas</strong> este mes por un total de <strong>${formatMoney(totalActual)}</strong>.`,
            accion: 'Consulta al Asistente Nautilus para un análisis detallado de partidas.'
        });
    }

    // 7. Gasto vs Mes Anterior
    if (totalAnterior > 0) {
        const variacion = ((totalActual - totalAnterior) / totalAnterior) * 100;
        if (variacion > 20) {
            alertas.push({
                nivel: 'advertencia',
                emoji: '📈',
                mensaje: `Tu gasto subió un <strong>+${Math.round(variacion)}%</strong> vs el mes anterior — <strong>${formatMoney(totalActual - totalAnterior)} más</strong>.`,
                accion: 'Revisa el historial por proveedor para detectar el origen del aumento.'
            });
        } else if (variacion < -15) {
            alertas.push({
                nivel: 'ok',
                emoji: '💚',
                mensaje: `Gastaste <strong>${Math.abs(Math.round(variacion))}% menos</strong> que el mes anterior — un ahorro de <strong>${formatMoney(Math.abs(totalActual - totalAnterior))}</strong>.`,
                accion: 'Mantén este ritmo y considera invertir el excedente.'
            });
        }
    }

    // 8. Mes sin facturas
    if (facturasMesActual.length === 0) {
        alertas.push({
            nivel: 'info',
            emoji: '📭',
            mensaje: `No hay facturas registradas para este mes. Sube documentos por Telegram o espera la ingesta de correo.`,
            accion: 'Cambia el mes en el selector o sube una factura por Telegram.'
        });
    }

    // 9. Fallback Todo OK
    if (alertas.length === 0) {
        alertas.push({
            nivel: 'ok',
            emoji: '✅',
            mensaje: `Todo en orden. Sin facturas pendientes ni urgencias registradas.`,
            accion: 'Sigue monitoreando desde aquí o consulta al Asistente Nautilus.'
        });
    }

    return alertas;
}

function aplicarEstiloNivel(nivel) {
    const widget = document.getElementById('centro-alertas-widget');
    const iconBg = document.getElementById('alerta-icon-bg');
    if (!widget) return;
    const colores = ALERTA_COLORES[nivel] || ALERTA_COLORES.ok;
    widget.style.borderLeftColor = colores.borde;
    if (iconBg) iconBg.style.background = colores.iconBg;
}

function renderAlertaActiva(alertas, indice) {
    const alerta = alertas[indice];
    if (!alerta) return;

    const display = document.getElementById('alerta-display');
    const emoji   = document.getElementById('alerta-emoji');
    const mensaje = document.getElementById('alerta-mensaje');
    const accion  = document.getElementById('alerta-accion');

    if (!display || !emoji || !mensaje) return;

    // Fade out
    display.style.opacity = '0';

    setTimeout(() => {
        emoji.textContent = alerta.emoji;
        mensaje.innerHTML = alerta.mensaje;
        if (accion) accion.textContent = alerta.accion || '';
        aplicarEstiloNivel(alerta.nivel);
        actualizarDots(alertas.length, indice);

        // Fade in
        display.style.opacity = '1';
    }, 400);
}

function actualizarDots(total, activo) {
    const dots = document.getElementById('alertas-dots');
    if (!dots) return;
    dots.innerHTML = '';
    if (total <= 1) return;
    for (let i = 0; i < total; i++) {
        const dot = document.createElement('div');
        dot.style.cssText = `
            width: ${i === activo ? '18px' : '7px'}; height: 7px; border-radius: 9999px;
            background: ${i === activo ? 'var(--teal-dark)' : 'var(--gray-300)'};
            transition: all 0.35s ease; cursor: pointer;
        `;
        dot.addEventListener('click', () => {
            _alertaIndice = i;
            renderAlertaActiva(_alertasActuales, _alertaIndice);
            reiniciarInterval();
        });
        dots.appendChild(dot);
    }
}

function reiniciarInterval() {
    if (_alertaIntervalId) clearInterval(_alertaIntervalId);
    if (_alertasActuales.length > 1) {
        _alertaIntervalId = setInterval(() => {
            _alertaIndice = (_alertaIndice + 1) % _alertasActuales.length;
            renderAlertaActiva(_alertasActuales, _alertaIndice);
        }, 5000);
    }
}

// ---- MODAL PANEL COMPLETO DE ALERTAS ----

const NIVEL_CONFIG = {
    critico: { 
        bg: '#FEF2F2', 
        borde: '#EF4444', 
        tagBg: '#FEE2E2', 
        tagColor: '#DC2626', 
        etiqueta: 'CRÍTICO', 
        texto: '#1E293B', 
        accionColor: '#B91C1C' 
    },
    advertencia: { 
        bg: '#FFFBEB', 
        borde: '#F59E0B', 
        tagBg: '#FEF3C7', 
        tagColor: '#D97706', 
        etiqueta: 'ADVERTENCIA', 
        texto: '#1E293B', 
        accionColor: '#B45309' 
    },
    info: { 
        bg: '#F0F9FF', 
        borde: '#0284C7', 
        tagBg: '#E0F2FE', 
        tagColor: '#0369A1', 
        etiqueta: 'AVISO', 
        texto: '#1E293B', 
        accionColor: '#0284C7' 
    },
    ok: { 
        bg: '#ECFDF5', 
        borde: '#10B981', 
        tagBg: '#D1FAE5', 
        tagColor: '#059669', 
        etiqueta: 'OK', 
        texto: '#1E293B', 
        accionColor: '#047857' 
    },
};

function abrirModalAlertas() {
    const modal = document.getElementById('modal-alertas');
    const lista = document.getElementById('modal-alertas-lista');
    if (!modal || !lista || _alertasActuales.length === 0) return;

    lista.innerHTML = _alertasActuales.map((alerta, i) => {
        const cfg = NIVEL_CONFIG[alerta.nivel] || NIVEL_CONFIG.ok;
        const esActiva = i === _alertaIndice;
        return `
        <div style="
            display: flex; gap: 1rem; align-items: flex-start;
            background: ${cfg.bg};
            border: 1px solid ${cfg.borde}33;
            border-left: 4px solid ${cfg.borde};
            border-radius: 14px; padding: 1rem 1.15rem;
            ${esActiva ? `box-shadow: 0 4px 14px -2px ${cfg.borde}40, 0 0 0 2px ${cfg.borde};` : 'box-shadow: 0 2px 5px rgba(0,0,0,0.03);'}
            transition: all 0.2s ease;
        ">
            <span style="font-size: 1.5rem; line-height: 1; flex-shrink: 0; margin-top: 0.1rem;">${alerta.emoji}</span>
            <div style="flex: 1;">
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem;">
                    <span style="font-size: 0.68rem; font-weight: 800; letter-spacing: 0.05em; color: ${cfg.tagColor}; background: ${cfg.tagBg}; border: 1px solid ${cfg.borde}44; padding: 0.15rem 0.6rem; border-radius: 9999px; text-transform: uppercase;">${cfg.etiqueta}</span>
                    ${esActiva ? `<span style="font-size: 0.7rem; font-weight: 700; color: var(--teal-dark); background: rgba(13,110,110,0.1); padding: 0.15rem 0.5rem; border-radius: 6px;">Mostrando ahora ●</span>` : ''}
                </div>
                <div style="font-size: 0.9rem; color: ${cfg.texto}; line-height: 1.5; font-weight: 600;">${alerta.mensaje}</div>
                ${alerta.accion ? `<div style="font-size: 0.8rem; color: ${cfg.accionColor}; margin-top: 0.4rem; font-weight: 500; font-style: italic;">→ ${alerta.accion}</div>` : ''}
            </div>
        </div>`;
    }).join('');

    modal.classList.remove('hidden');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    if (_alertaIntervalId) clearInterval(_alertaIntervalId); // Pausa mientras el modal está abierto
}


function cerrarModalAlertas() {
    const modal = document.getElementById('modal-alertas');
    if (modal) modal.classList.add('hidden');
    reiniciarInterval(); // Reanuda el ticker
}

// Inicializar los event listeners del modal una sola vez
document.addEventListener('DOMContentLoaded', () => {
    const widget  = document.getElementById('centro-alertas-widget');
    const cerrar  = document.getElementById('modal-alertas-close');
    const overlay = document.getElementById('modal-alertas');

    if (widget) {
        widget.style.cursor = 'pointer';
        widget.title = 'Clic para ver todas las alertas';
        widget.addEventListener('click', abrirModalAlertas);
    }
    if (cerrar)  cerrar.addEventListener('click', cerrarModalAlertas);
    if (overlay) overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrarModalAlertas(); });
});


function updateAIDiagnostics(facturasMesActual, facturasMesAnterior, sourceList, todasLasFacturas) {
    // Actualizar KPI Principal Emisor (se mantiene)
    const elEmisorNombre = document.getElementById('kpi-principal-emisor-nombre');
    const elEmisorMonto  = document.getElementById('kpi-principal-emisor-monto');
    const elVencimientosBadge  = document.getElementById('alert-vencimientos-badge');
    const elVencimientosMonto  = document.getElementById('alert-vencimientos-monto');
    const elVencimientosDetail = document.getElementById('alert-vencimientos-detail');
    const elSaldoPendiente     = document.getElementById('card-saldo-total-pendiente');

    let totalActual = 0;
    facturasMesActual.forEach(f => totalActual += parseFloat(f.total || 0));

    // KPI emisor principal
    const suppliers = {};
    facturasMesActual.forEach(f => {
        const p = f.proveedor || 'Desconocido';
        suppliers[p] = (suppliers[p] || 0) + parseFloat(f.total || 0);
    });
    const sorted = Object.entries(suppliers).sort((a, b) => b[1] - a[1]);
    const topProv = sorted[0] ? { name: sorted[0][0], total: sorted[0][1] } : { name: 'Sin datos', total: 0 };
    const topPct  = totalActual > 0 ? Math.round((topProv.total / totalActual) * 100) : 0;
    if (elEmisorNombre) elEmisorNombre.textContent = topProv.name;
    if (elEmisorMonto)  elEmisorMonto.textContent  = `${formatMoney(topProv.total)} (${topPct}% del total)`;

    // Vencimientos en tarjeta derecha
    let cntVence = 0, montoVence = 0, saldoPend = 0;
    const hoy = new Date(); hoy.setHours(0,0,0,0);
    sourceList.forEach(f => {
        if (f.estado !== 'PAGADA') {
            saldoPend += parseFloat(f.total || 0);

            if (f.fecha_vencimiento) {
                const venc = parseUTCDate(f.fecha_vencimiento);
                if (venc) {
                    const diff = Math.round((venc - hoy) / (1000 * 60 * 60 * 24));
                    if (diff <= 3) { cntVence++; montoVence += parseFloat(f.total || 0); }
                }
            }
        }
    });
    if (elVencimientosBadge)  elVencimientosBadge.textContent  = cntVence;
    if (elVencimientosMonto)  elVencimientosMonto.textContent  = formatMoney(montoVence);
    if (elVencimientosDetail) {
        elVencimientosDetail.innerHTML = cntVence > 0
            ? `<strong style="color:#DC2626;">🚨 ${cntVence} facturas vencen en ≤ 3 días.</strong> Haz clic para filtrar.`
            : 'Sin facturas críticas por vencer en los próximos 3 días.';
    }
    if (elSaldoPendiente) elSaldoPendiente.textContent = formatMoney(saldoPend);

    // ---- CÁLCULO DE COBERTURA DE DEUDA (MONTO PAGADO / DEUDA TOTAL) ----
    let totalDeudaAcumulada = 0;
    let totalPagadoAcumulado = 0;

    const listaBase = (todasLasFacturas && todasLasFacturas.length > 0) ? todasLasFacturas : sourceList;
    listaBase.forEach(f => {
        const tot = parseFloat(f.total || 0);
        totalDeudaAcumulada += tot;
        if (f.estado === 'PAGADA') {
            totalPagadoAcumulado += tot;
        } else {
            totalPagadoAcumulado += parseFloat(f.monto_pagado || 0);
        }
    });

    const saldoPendienteCalc = Math.max(0, totalDeudaAcumulada - totalPagadoAcumulado);
    const pctCobertura = totalDeudaAcumulada > 0 ? Math.min(100, Math.max(0, (totalPagadoAcumulado / totalDeudaAcumulada) * 100)) : 100;

    const elRatioText = document.getElementById('card-deuda-ratio-text');
    const elProgressBar = document.getElementById('card-deuda-progress-bar');
    const elMontoPagado = document.getElementById('card-deuda-monto-pagado');
    const elMontoPendiente = document.getElementById('card-deuda-monto-pendiente');

    if (elRatioText) elRatioText.textContent = `${formatMoney(totalPagadoAcumulado)} / ${formatMoney(totalDeudaAcumulada)}`;
    if (elProgressBar) elProgressBar.style.width = `${pctCobertura}%`;
    if (elMontoPagado) elMontoPagado.textContent = formatMoney(totalPagadoAcumulado);
    if (elMontoPendiente) elMontoPendiente.textContent = formatMoney(saldoPendienteCalc);

    // ---- TICKER DE ALERTAS ----

    _alertasActuales = buildAlertas(facturasMesActual, facturasMesAnterior, sourceList, todasLasFacturas);
    _alertaIndice = 0;

    const contador = document.getElementById('alertas-contador');
    if (contador) {
        const criticas = _alertasActuales.filter(a => a.nivel === 'critico').length;
        contador.textContent = criticas > 0
            ? `${criticas} alerta${criticas > 1 ? 's' : ''} crítica${criticas > 1 ? 's' : ''}`
            : `${_alertasActuales.length} aviso${_alertasActuales.length > 1 ? 's' : ''}`;
        contador.style.background = criticas > 0 ? 'rgba(239,68,68,0.1)' : 'rgba(13,110,110,0.1)';
        contador.style.color      = criticas > 0 ? '#DC2626'              : 'var(--teal-dark)';
    }

    renderAlertaActiva(_alertasActuales, _alertaIndice);
    reiniciarInterval();
}


function renderTopSuppliers(facturas) {
    const list = document.getElementById('top-suppliers-list');
    if (!list) return; // El elemento puede no estar visible en esta vista
    
    // Agrupar por proveedor
    const suppliers = {};
    let maxAmount = 0;
    
    facturas.forEach(f => {
        const prov = f.proveedor || 'Desconocido';
        const val = parseFloat(f.total || 0);
        if (!suppliers[prov]) suppliers[prov] = 0;
        suppliers[prov] += val;
    });

    const sortedSuppliers = Object.entries(suppliers)
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total); // Mostrar todos los proveedores para permitir scroll

    if (sortedSuppliers.length > 0) {
        maxAmount = sortedSuppliers[0].total;
    }

    list.innerHTML = '';
    
    if (sortedSuppliers.length === 0) {
        list.innerHTML = '<div class="empty-state" style="font-size:0.875rem;">No hay datos este mes</div>';
        return;
    }

    sortedSuppliers.forEach(sup => {
        const pct = maxAmount > 0 ? (sup.total / maxAmount) * 100 : 0;
        list.innerHTML += `
            <div class="supplier-item">
                <div class="supplier-header">
                    <span>${sup.name}</span>
                    <span>${formatMoney(sup.total)}</span>
                </div>
                <div class="supplier-bar-bg">
                    <div class="supplier-bar-fill" style="width: ${pct}%"></div>
                </div>
            </div>
        `;
    });
}

function renderInvoicesTable() {
    const tbody = document.getElementById('invoices-table-body');
    const loading = document.getElementById('table-loading');
    const empty = document.getElementById('table-empty');
    
    loading.classList.add('hidden');
    
    const targetStatus = currentTab === 'pendientes' ? 'PENDIENTE' : 'PAGADA';
    // Mapeamos APROBADA como PAGADA para efectos del demo si fuera necesario, o usamos PENDIENTE vs CANCELADA.
    
    let filtered = facturasList.filter(f => {
        if (targetStatus === 'PENDIENTE') return f.estado === 'PENDIENTE' || f.estado === null;
        return f.estado === 'PAGADA' || f.estado === 'APROBADA'; // Asumimos Aprobada = Pagada
    });
    
    tbody.innerHTML = '';
    
    if (filtered.length === 0) {
        empty.classList.remove('hidden');
    } else {
        empty.classList.add('hidden');
        
        filtered.forEach(f => {
            const tr = document.createElement('tr');
            
            // Simular vencimiento a 30 días de la emisión
            const emision = parseUTCDate(f.fecha_emision);
            const vencimiento = emision ? new Date(emision) : null;
            if (vencimiento) {
                vencimiento.setDate(vencimiento.getDate() + 30);
            }
            
            // Determinar urgencia (dot)
            const hoy = new Date();
            const diasFaltantes = vencimiento ? Math.ceil((vencimiento - hoy) / (1000 * 60 * 60 * 24)) : 999;
            
            let dotClass = 'dot-gray';
            if (f.estado === 'PENDIENTE') {
                if (diasFaltantes <= 0) dotClass = 'dot-coral';
                else if (diasFaltantes <= 3) dotClass = 'dot-amber';
                else dotClass = 'dot-sage';
            } else {
                dotClass = 'dot-sage';
            }

            const isPaid = f.estado === 'PAGADA' || f.estado === 'APROBADA';
            const total = parseFloat(f.total || 0);
            const saldo = getSaldoPendiente(f);
            const pagado = total - saldo;

            // Detectar moneda
            const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
            
            const totalFormateado = esUSD 
                ? '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : formatMoney(total);
                
            const saldoFormateado = esUSD 
                ? '$' + saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : formatMoney(saldo);
                
            const pagadoFormateado = esUSD 
                ? '$' + pagado.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : formatMoney(pagado);

            let montoHTML = '';
            if (saldo > 0 && pagado > 0) {
                montoHTML = `
                    <div class="monto-saldo" style="color: var(--status-coral); font-weight: 800; font-size: 1.1rem; line-height: 1.2;">${saldoFormateado}</div>
                    <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">
                        Abono: ${pagadoFormateado} / Total: ${totalFormateado}
                    </div>
                `;
            } else if (saldo > 0) {
                montoHTML = `
                    <div class="monto-saldo" style="color: var(--status-coral); font-weight: 800; font-size: 1.1rem; line-height: 1.2;">${saldoFormateado}</div>
                    <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">Pendiente total</div>
                `;
            } else {
                montoHTML = `
                    <div class="monto-saldo" style="color: var(--teal-dark); font-weight: 700; font-size: 1.1rem; line-height: 1.2;">${totalFormateado}</div>
                    <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">Pagado completo</div>
                `;
            }

            tr.innerHTML = `
                <td>
                    <div class="invoice-num">${f.numero_factura}</div>
                </td>
                <td class="supplier-name">${f.proveedor}</td>
                <td>${emision ? emision.toLocaleDateString('es-CR') : 'N/A'}</td>
                <td>
                    <span class="status-dot">
                        <span class="dot ${dotClass}"></span>
                        ${vencimiento ? vencimiento.toLocaleDateString('es-CR') : 'N/A'}
                    </span>
                    ${getTiempoRestanteHTML(vencimiento, f.estado)}
                </td>
                <td class="text-right amount">${montoHTML}</td>
                <td class="text-center" style="vertical-align: middle;">
                    <span style="font-size: 0.82rem; font-weight: 700; display: inline-block; padding: 0.35rem 0.75rem; border-radius: 9999px; letter-spacing: 0.05em; background-color: ${isPaid ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; color: ${isPaid ? '#10B981' : '#EF4444'}">
                        ${isPaid ? 'CANCELADA' : 'PENDIENTE'}
                    </span>
                </td>
                <td class="text-center" style="vertical-align: middle;">
                    <button class="check-btn ${isPaid ? 'paid' : ''}" data-id="${f.id}" title="${isPaid ? 'Cancelada' : 'Marcar como pagada'}">
                        <i data-lucide="check"></i>
                    </button>
                </td>
            `;
            
            // Click en la fila para abrir modal (ignorando si se hace clic en el botón de check)
            tr.addEventListener('click', (e) => {
                if(!e.target.closest('.check-btn')) {
                    openModal(f);
                }
            });
            
            tbody.appendChild(tr);
        });
        
        lucide.createIcons();
        
        // Asignar eventos a los botones de check
        tbody.querySelectorAll('.check-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation(); // Evitar abrir modal
                const id = btn.getAttribute('data-id');
                const factura = facturasList.find(f => f.id === id);
                const currentStatus = factura ? factura.estado : 'PENDIENTE';
                await toggleInvoiceStatus(id, currentStatus);
            });
        });
    }
}

function showConfirmModal(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        const msgEl = document.getElementById('confirm-message');
        const acceptBtn = document.getElementById('confirm-accept-btn');
        const cancelBtn = document.getElementById('confirm-cancel-btn');
        
        msgEl.textContent = message;
        modal.classList.remove('hidden');
        
        const onAccept = () => {
            cleanUp();
            resolve(true);
        };
        
        const onCancel = () => {
            cleanUp();
            resolve(false);
        };
        
        const cleanUp = () => {
            modal.classList.add('hidden');
            acceptBtn.removeEventListener('click', onAccept);
            cancelBtn.removeEventListener('click', onCancel);
        };
        
        acceptBtn.addEventListener('click', onAccept);
        cancelBtn.addEventListener('click', onCancel);
    });
}

async function toggleInvoiceStatus(id, currentStatus) {
    const isPaid = currentStatus === 'PAGADA' || currentStatus === 'APROBADA';
    const message = isPaid 
        ? "¿Deseas volver a colocar esta factura como PENDIENTE de pago?"
        : "¿Deseas marcar esta factura como CANCELADA?";
        
    const confirmed = await showConfirmModal(message);
    if (!confirmed) return;
    
    const newStatus = isPaid ? 'PENDIENTE' : 'PAGADA';
    
    try {
        const facturaHist = historialFacturasList.find(f => f.id === id);
        const totalFactura = facturaHist ? parseFloat(facturaHist.total || 0) : 0;
        
        const updateData = { estado: newStatus };
        if (newStatus === 'PAGADA') {
            updateData.monto_pagado = totalFactura;
        } else {
            updateData.monto_pagado = 0;
        }

        if (currentEmpresaId !== 'demo-id') {
            const { error } = await dbClient
                .from('facturas')
                .update(updateData)
                .eq('id', id);
            if (error) throw error;
        }
        
        // Actualizar estado localmente en el Dashboard
        const factura = facturasList.find(f => f.id === id);
        if(factura) {
            factura.estado = newStatus;
            factura.monto_pagado = updateData.monto_pagado;
        }

        // Actualizar estado localmente en el Historial
        if(facturaHist) {
            facturaHist.estado = newStatus;
            facturaHist.monto_pagado = updateData.monto_pagado;
        }
        
        // Refrescar vistas
        calculateKPIs(facturasList);
        renderInvoicesTable();
        
        // Refrescar historial si está activo
        const viewFacturas = document.getElementById('view-facturas');
        if (viewFacturas && !viewFacturas.classList.contains('hidden')) {
            filterAndRenderHistorial();
        }
    } catch(e) {
        console.error("Error actualizando factura:", e);
        alert("Hubo un error al actualizar el estado de la factura.");
    }
}

// ==========================================================================
// CHART.JS
// ==========================================================================

function renderTrendChart() {
    const canvasEl = document.getElementById('expenseChart');
    if (!canvasEl) return;
    const ctx = canvasEl.getContext('2d');
    
    // Si ya existe el gráfico, lo destruimos para redibujar
    if (expenseChartInstance) {
        expenseChartInstance.destroy();
    }
    
    // Simular datos de los últimos 6 meses basados en el mes actual
    const labels = [];
    const data = [];
    for(let i=5; i>=0; i--) {
        const d = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - i, 1);
        const mesesStr = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
        labels.push(mesesStr[d.getMonth()]);
        // Data simulada: entre 1M y 4M
        data.push(Math.floor(Math.random() * 3000000) + 1000000);
    }
    
    // Si hay datos reales este mes, los usamos en el último punto
    const totalGasto = facturasList.reduce((sum, f) => sum + parseFloat(f.total||0), 0);
    data[5] = totalGasto > 0 ? totalGasto : data[5];

    // Gradiente de Naranja a Transparente (Tema Charcoal)
    const gradient = ctx.createLinearGradient(0, 0, 0, 300);
    gradient.addColorStop(0, 'rgba(234, 88, 12, 0.5)'); // Naranja #EA580C
    gradient.addColorStop(1, 'rgba(234, 88, 12, 0)');

    expenseChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Gastos ₡',
                data: data,
                borderColor: '#EA580C',
                backgroundColor: gradient,
                borderWidth: 2,
                pointBackgroundColor: '#1C1917',
                pointBorderColor: '#EA580C',
                pointBorderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#FFFFFF',
                    titleColor: '#1C1917',
                    bodyColor: '#6B7280',
                    borderColor: '#E5E7EB',
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return formatMoney(context.raw);
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false, drawBorder: false },
                    ticks: { color: 'rgba(255,255,255,0.6)', font: { family: 'Inter', size: 12 } }
                },
                y: {
                    grid: { color: 'rgba(255,255,255,0.1)', drawBorder: false },
                    ticks: { 
                        color: 'rgba(255,255,255,0.6)',
                        callback: function(value) { return '₡' + (value/1000000).toFixed(1) + 'M'; }
                    },
                    beginAtZero: true
                }
            }
        }
    });
}

// ==========================================================================
// MODAL (VISOR DE FACTURA)
// ==========================================================================

async function openModal(factura) {
    document.getElementById('modal-factura-num').textContent = `#${factura.numero_factura}`;
    document.getElementById('modal-proveedor').textContent = factura.proveedor;
    
    const emision = parseUTCDate(factura.fecha_emision);
    document.getElementById('modal-fecha').textContent = emision ? emision.toLocaleDateString('es-CR') : 'N/A';
    
    // Calcular desgloses financieros de abonos
    const total = parseFloat(factura.total || 0);
    const saldo = getSaldoPendiente(factura);
    const pagado = total - saldo;

    const esUSD = factura.moneda === 'USD' || (total < 20000 && factura.moneda !== 'CRC');
    
    const totalFormateado = esUSD 
        ? '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : formatMoney(total);
        
    const saldoFormateado = esUSD 
        ? '$' + saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : formatMoney(saldo);
        
    const pagadoFormateado = esUSD 
        ? '$' + pagado.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : formatMoney(pagado);

    const amountsContainer = document.getElementById('modal-amounts-container');
    if (amountsContainer) {
        if (saldo > 0 && pagado > 0) {
            amountsContainer.innerHTML = `
                <div class="detail-group">
                    <label>Total Factura</label>
                    <div class="detail-value" style="font-size: 1.1rem; font-weight: 600; color: var(--gray-600);">${totalFormateado}</div>
                </div>
                <div class="detail-group" style="border-left: 3px solid #10B981; padding-left: 0.75rem;">
                    <label style="color: #10B981; font-weight: 600;">Monto Abonado</label>
                    <div class="detail-value" style="font-size: 1.1rem; font-weight: 700; color: #10B981;">${pagadoFormateado}</div>
                </div>
                <div class="detail-group" style="border-left: 3px solid var(--status-coral); padding-left: 0.75rem;">
                    <label style="color: var(--status-coral); font-weight: 600;">Saldo por Pagar</label>
                    <div class="detail-value" style="font-size: 1.45rem; font-weight: 800; color: var(--status-coral);">${saldoFormateado}</div>
                </div>
            `;
        } else if (saldo > 0) {
            amountsContainer.innerHTML = `
                <div class="detail-group">
                    <label>Total por Pagar</label>
                    <div class="detail-value highlight-amount" style="color: var(--status-coral); font-weight: 800; font-size: 1.45rem;">${totalFormateado}</div>
                </div>
            `;
        } else {
            amountsContainer.innerHTML = `
                <div class="detail-group">
                    <label>Total Pagado (Cancelada)</label>
                    <div class="detail-value highlight-amount" style="color: var(--teal-dark); font-weight: 800; font-size: 1.45rem;">${totalFormateado}</div>
                </div>
            `;
        }
    }
    
    // Configurar visor PDF
    const iframe = document.getElementById('modal-pdf-viewer');
    const downloadBtn = document.getElementById('modal-download-btn');
    
    if (factura.url_s3) {
        // Compatibilidad: si es un link viejo completo (S3), cargarlo directo
        if (factura.url_s3.startsWith('http')) {
            iframe.src = factura.url_s3;
            downloadBtn.href = factura.url_s3;
        } else {
            // Si es ruta relativa en Supabase Storage, generar URL firmada por 60 segundos
            try {
                const { data, error } = await dbClient
                    .storage
                    .from('facturas')
                    .createSignedUrl(factura.url_s3, 60);
                
                if (error || !data) throw error || new Error("Error en URL firmada");
                
                iframe.src = data.signedUrl;
                downloadBtn.href = data.signedUrl;
            } catch (err) {
                console.error("Error generando URL firmada:", err);
                iframe.src = 'about:blank';
                downloadBtn.href = '#';
            }
        }
    } else {
        iframe.src = 'about:blank';
        downloadBtn.href = '#';
    }

    // Cargar lineas de factura
    const tbody = document.getElementById('modal-lines-body');
    tbody.innerHTML = '<tr><td colspan="3" class="text-center"><div class="loading" style="padding:1rem;">Cargando líneas...</div></td></tr>';
    
    // Mostrar modal con transición CSS
    const modal = document.getElementById('invoice-modal');
    modal.classList.remove('hidden');

    if (currentEmpresaId === 'demo-id') {
        tbody.innerHTML = `
            <tr>
                <td>10</td>
                <td>Sacos de Abono Especial 50kg</td>
                <td class="text-right">₡45,000.00</td>
            </tr>
            <tr>
                <td>1</td>
                <td>Flete y Transporte a finca</td>
                <td class="text-right">₡150,000.00</td>
            </tr>
        `;
        return;
    }

    try {
        const { data: lineas, error } = await dbClient
            .from('lineas_factura')
            .select('*')
            .eq('factura_id', factura.id);
            
        tbody.innerHTML = '';
        
        if (error || !lineas || lineas.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="color:var(--gray-500);">No se extrajeron detalles de líneas para esta factura.</td></tr>';
        } else {
            lineas.forEach(l => {
                tbody.innerHTML += `
                    <tr>
                        <td>${l.cantidad}</td>
                        <td>${l.descripcion}</td>
                        <td class="text-right">${formatMoney(l.total_item)}</td>
                    </tr>
                `;
            });
        }
    } catch (e) {
        console.error("Error cargando líneas:", e);
        tbody.innerHTML = '<tr><td colspan="3" class="text-center" style="color:var(--status-coral);">Error cargando líneas.</td></tr>';
    }
}

function closeModal() {
    const modal = document.getElementById('invoice-modal');
    modal.classList.add('hidden');
    document.getElementById('modal-pdf-viewer').src = ''; // Limpiar iframe
}

// ==========================================================================
// VISTA: HISTORIAL DE FACTURAS (LÓGICA Y RENDERING)
// ==========================================================================

async function refreshHistorialData() {
    if (!currentEmpresaId) return;

    const loading = document.getElementById('historial-loading');
    const empty = document.getElementById('historial-empty');
    const tbody = document.getElementById('historial-table-body');

    tbody.innerHTML = '';
    loading.classList.remove('hidden');
    empty.classList.add('hidden');

    if (currentEmpresaId === 'demo-id') {
        loading.classList.add('hidden');
        populatePeriodFilter();
        filterAndRenderHistorial();
        return;
    }

    try {
        // Traer TODO el histórico de la empresa en Supabase sin límite de fechas
        const { data: facturas, error } = await dbClient
            .from('facturas')
            .select('*')
            .eq('empresa_id', currentEmpresaId)
            .order('fecha_emision', { ascending: false });

        if (error) throw error;

        historialFacturasList = facturas || [];
    } catch (e) {
        console.error("Error cargando histórico:", e);
    } finally {
        loading.classList.add('hidden');
        populatePeriodFilter();
        filterAndRenderHistorial();
    }
}

function populatePeriodFilter() {
    const periodSelect = document.getElementById('historial-filter-periodo');
    if (!periodSelect) return;

    const currentValue = periodSelect.value;
    
    // Select limpio y directo
    let optionsHtml = '<option value="TODOS">Todos los períodos</option>';

    // Extraer combinaciones únicas de Año-Mes
    const periodosMap = {};
    const mesesNombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    historialFacturasList.forEach(f => {
        if (!f.fecha_emision) return;
        const fecha = parseUTCDate(f.fecha_emision);
        const anio = fecha.getFullYear();
        const mesIdx = fecha.getMonth();
        const key = `${anio}-${String(mesIdx).padStart(2, '0')}`;
        
        if (!periodosMap[key]) {
            periodosMap[key] = {
                label: `${mesesNombres[mesIdx]} ${anio}`,
                anio: anio,
                mes: mesIdx
            };
        }
    });

    // Ordenar períodos cronológicamente descendente (lo más reciente arriba)
    const keysSorted = Object.keys(periodosMap).sort().reverse();
    keysSorted.forEach(key => {
        optionsHtml += `<option value="${key}">${periodosMap[key].label}</option>`;
    });

    periodSelect.innerHTML = optionsHtml;

    // Restaurar valor previo si existe, sino TODOS
    if (currentValue && (currentValue === 'TODOS' || keysSorted.includes(currentValue))) {
        periodSelect.value = currentValue;
    } else {
        periodSelect.value = 'TODOS';
    }
}

function filterAndRenderHistorial() {
    const searchVal = document.getElementById('historial-search').value.toLowerCase().trim();
    const periodoVal = document.getElementById('historial-filter-periodo').value;
    const fechaExactaEl = document.getElementById('historial-filter-fecha-exacta');
    const fechaExactaVal = fechaExactaEl ? fechaExactaEl.value : '';
    const estadoVal = document.getElementById('historial-filter-estado').value;
    const monedaVal = document.getElementById('historial-filter-moneda').value;
    const btnLimpiar = document.getElementById('btn-limpiar-filtros');

    // Mostrar botón limpiar si algún filtro está activo
    const hayFiltrosActivos = Boolean(searchVal || (periodoVal && periodoVal !== 'TODOS') || fechaExactaVal || (estadoVal && estadoVal !== 'TODOS') || (monedaVal && monedaVal !== 'TODAS'));
    if (btnLimpiar) {
        btnLimpiar.style.display = hayFiltrosActivos ? 'inline-flex' : 'none';
    }

    let filtered = historialFacturasList.filter(f => {
        // 1. Filtro de Búsqueda (Emisor, Número de Factura o Monto)
        let matchSearch = true;
        if (searchVal) {
            const proveedorMatch = f.proveedor && f.proveedor.toLowerCase().includes(searchVal);
            const numMatch = f.numero_factura && f.numero_factura.toLowerCase().includes(searchVal);
            const totalStr = f.total ? String(f.total).toLowerCase() : '';
            const totalMatch = totalStr.includes(searchVal);
            matchSearch = proveedorMatch || numMatch || totalMatch;
        }

        // 2. Filtro de Fecha Exacta (Calendario) o Período (Mes/Año)
        let matchFecha = true;
        if (fechaExactaVal) {
            // Comparar día exacto en formato YYYY-MM-DD
            matchFecha = Boolean(f.fecha_emision && String(f.fecha_emision).startsWith(fechaExactaVal));
        } else if (periodoVal !== 'TODOS') {
            if (!f.fecha_emision) {
                matchFecha = false;
            } else {
                const fecha = parseUTCDate(f.fecha_emision);
                const [anioSel, mesSel] = periodoVal.split('-').map(Number);
                matchFecha = (fecha.getFullYear() === anioSel && fecha.getMonth() === mesSel);
            }
        }

        // 3. Filtro de Estado
        let matchEstado = true;
        if (estadoVal !== 'TODOS') {
            if (estadoVal === 'PENDIENTE') {
                matchEstado = (f.estado === 'PENDIENTE' || f.estado === null);
            } else {
                matchEstado = (f.estado === 'PAGADA' || f.estado === 'APROBADA');
            }
        }

        // 4. Filtro de Moneda
        let matchMoneda = true;
        if (monedaVal !== 'TODAS') {
            const monedaFactura = f.moneda || (parseFloat(f.total) < 20000 ? 'USD' : 'CRC');
            matchMoneda = (monedaFactura === monedaVal);
        }

        return matchSearch && matchFecha && matchEstado && matchMoneda;
    });

    updateHistorialKPIs(filtered);
    renderHistorialTable(filtered);
}

function updateHistorialKPIs(filtered) {
    const kpiTotales = document.getElementById('kpi-hist-totales');
    const kpiPendientes = document.getElementById('kpi-hist-pendientes');
    const kpiMontoPendiente = document.getElementById('kpi-hist-monto-pendiente');
    const kpiMontoPagado = document.getElementById('kpi-hist-monto-pagado');
    
    if (!kpiTotales || !kpiPendientes || !kpiMontoPendiente || !kpiMontoPagado) return;
    
    const totalCount = filtered.length;
    const pendingCount = filtered.filter(f => f.estado === 'PENDIENTE' || f.estado === null).length;
    
    let totalPendienteColones = 0;
    let totalPagadoColones = 0;
    
    filtered.forEach(f => {
        const total = parseFloat(f.total || 0);
        const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
        
        const saldo = getSaldoPendiente(f);
        const pagado = total - saldo;
        
        const saldoColones = esUSD ? saldo * 520 : saldo;
        const pagadoColones = esUSD ? pagado * 520 : pagado;
        
        totalPendienteColones += saldoColones;
        totalPagadoColones += pagadoColones;
    });
    
    kpiTotales.textContent = totalCount;
    kpiPendientes.textContent = pendingCount;
    kpiMontoPendiente.textContent = formatMoney(totalPendienteColones);
    kpiMontoPagado.textContent = formatMoney(totalPagadoColones);
}

function renderHistorialTable(filtered) {
    const tbody = document.getElementById('historial-table-body');
    const empty = document.getElementById('historial-empty');

    tbody.innerHTML = '';

    if (!filtered || filtered.length === 0) {
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');

    // Ordenar automáticamente por fecha de emisión más reciente (orden de llegada)
    const sorted = [...filtered].sort((a, b) => {
        const fechaA = a.fecha_emision ? new Date(a.fecha_emision) : new Date(0);
        const fechaB = b.fecha_emision ? new Date(b.fecha_emision) : new Date(0);
        return fechaB - fechaA;
    });

    sorted.forEach(f => {
        const tr = document.createElement('tr');
        if (f.id) tr.setAttribute('data-factura-id', f.id);
        const emision = parseUTCDate(f.fecha_emision);
        
        // Simular vencimiento a 30 días
        const vencimiento = emision ? new Date(emision) : null;
        if (vencimiento) {
            vencimiento.setDate(vencimiento.getDate() + 30);
        }

        // Estado del badge de vencimiento
        const hoy = new Date();
        const diasFaltantes = vencimiento ? Math.ceil((vencimiento - hoy) / (1000 * 60 * 60 * 24)) : 999;
        let dotClass = 'dot-gray';
        
        if (f.estado === 'PENDIENTE' || f.estado === null) {
            if (diasFaltantes <= 0) dotClass = 'dot-coral';
            else if (diasFaltantes <= 3) dotClass = 'dot-amber';
            else dotClass = 'dot-sage';
        } else {
            dotClass = 'dot-sage';
        }

        const isPaid = f.estado === 'PAGADA' || f.estado === 'APROBADA';
        const total = parseFloat(f.total || 0);
        const saldo = getSaldoPendiente(f);
        const pagado = total - saldo;

        // Detectar moneda
        const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
        
        const totalFormateado = esUSD 
            ? '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : formatMoney(total);
            
        const saldoFormateado = esUSD 
            ? '$' + saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : formatMoney(saldo);
            
        const pagadoFormateado = esUSD 
            ? '$' + pagado.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : formatMoney(pagado);

        let montoHTML = '';
        if (saldo > 0 && pagado > 0) {
            montoHTML = `
                <div class="monto-saldo" style="color: var(--status-coral); font-weight: 800; font-size: 1.1rem; line-height: 1.2;">${saldoFormateado}</div>
                <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">
                    Abono: ${pagadoFormateado} / Total: ${totalFormateado}
                </div>
            `;
        } else if (saldo > 0) {
            montoHTML = `
                <div class="monto-saldo" style="color: var(--status-coral); font-weight: 800; font-size: 1.1rem; line-height: 1.2;">${saldoFormateado}</div>
                <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">Pendiente total</div>
            `;
        } else {
            montoHTML = `
                <div class="monto-saldo" style="color: var(--teal-dark); font-weight: 700; font-size: 1.1rem; line-height: 1.2;">${totalFormateado}</div>
                <div class="monto-desglose" style="font-size: 0.75rem; color: var(--gray-400); margin-top: 0.15rem; font-weight: 500;">Pagado completo</div>
            `;
        }

        tr.innerHTML = `
            <td>
                <div class="invoice-num">${f.numero_factura || 'Sin N°'}</div>
            </td>
            <td class="supplier-name">${f.proveedor || 'Proveedor Desconocido'}</td>
            <td>${emision ? emision.toLocaleDateString('es-CR') : 'N/A'}</td>
            <td>
                <span class="status-dot">
                    <span class="dot ${dotClass}"></span>
                    ${vencimiento ? vencimiento.toLocaleDateString('es-CR') : 'N/A'}
                </span>
                ${getTiempoRestanteHTML(vencimiento, f.estado)}
            </td>
            <td class="text-right amount">${montoHTML}</td>
            <td class="text-center" style="vertical-align: middle;">
                <span style="font-size: 0.82rem; font-weight: 700; display: inline-block; padding: 0.35rem 0.75rem; border-radius: 9999px; letter-spacing: 0.05em; background-color: ${isPaid ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)'}; color: ${isPaid ? '#10B981' : '#EF4444'}">
                    ${isPaid ? 'CANCELADA' : 'PENDIENTE'}
                </span>
            </td>
            <td class="text-center">
                <button class="check-btn ${isPaid ? 'paid' : ''}" data-id="${f.id}" title="${isPaid ? 'Cancelada' : 'Marcar como pagada'}">
                    <i data-lucide="check"></i>
                </button>
            </td>
        `;

        // Click en fila abre modal (visor PDF y líneas de factura)
        tr.addEventListener('click', (e) => {
            if (!e.target.closest('.check-btn')) {
                openModal(f);
            }
        });

        tbody.appendChild(tr);
    });

    lucide.createIcons();

    // Evento para el check interactivo rápido
    tbody.querySelectorAll('.check-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.getAttribute('data-id');
            const factura = historialFacturasList.find(f => f.id === id);
            const currentStatus = factura ? factura.estado : 'PENDIENTE';
            await toggleInvoiceStatus(id, currentStatus);
        });
    });
}

// ==========================================================================
// VISTA: DIRECTORIO DE PROVEEDORES (LÓGICA Y RENDERING)
// ==========================================================================

async function refreshProveedoresData() {
    if (!currentEmpresaId) return;

    selectedProveedor = null;
    updateProveedoresKPIs();

    const loading = document.getElementById('proveedores-loading');
    const empty = document.getElementById('proveedores-empty');
    const tbody = document.getElementById('proveedores-table-body');

    tbody.innerHTML = '';
    loading.classList.remove('hidden');
    empty.classList.add('hidden');

    // 1. Asegurar que tenemos todas las facturas de la empresa
    if (historialFacturasList.length === 0) {
        if (currentEmpresaId === 'demo-id') {
            historialFacturasList = [
                { id: 'demo-1', numero_factura: 'F-1001', proveedor: 'Fertilizantes del Norte', fecha_emision: '2026-07-05', total: 450000, estado: 'PENDIENTE', moneda: 'CRC' },
                { id: 'demo-2', numero_factura: 'F-1002', proveedor: 'Maquinaria Automotriz CR', fecha_emision: '2026-07-10', total: 1250000, estado: 'PENDIENTE', moneda: 'CRC' },
                { id: 'demo-3', numero_factura: 'F-1003', proveedor: 'Transportes Rápidos', fecha_emision: '2026-07-11', total: 150000, estado: 'PAGADA', moneda: 'CRC' },
                { id: 'demo-4', numero_factura: 'F-1004', proveedor: 'Suministros Agrícolas', fecha_emision: '2026-07-01', total: 320000, estado: 'PENDIENTE', moneda: 'CRC' },
                { id: 'demo-5', numero_factura: 'F-1005', proveedor: 'Repuestos Automotores', fecha_emision: '2026-07-08', total: 75000, estado: 'PENDIENTE', moneda: 'CRC' },
                { id: 'demo-6', numero_factura: 'F-1006', proveedor: 'Fertilizantes del Norte', fecha_emision: '2026-07-12', total: 200000, estado: 'PENDIENTE', moneda: 'CRC' },
                { id: 'demo-7', numero_factura: 'FC00036319AS01', proveedor: 'CoopeAgri R.L.', fecha_emision: '2026-06-16', total: 30150, estado: 'PAGADA', moneda: 'CRC' },
                { id: 'demo-8', numero_factura: 'INV-0092', proveedor: 'John Deere USA', fecha_emision: '2026-06-20', total: 2169.60, estado: 'PENDIENTE', moneda: 'USD' },
                { id: 'demo-9', numero_factura: 'FE-8899', proveedor: 'NEXUSTEC S.A.', fecha_emision: '2026-05-14', total: 1500, estado: 'PAGADA', moneda: 'USD' }
            ];
        } else {
            try {
                const { data: facturas, error } = await dbClient
                    .from('facturas')
                    .select('*')
                    .eq('empresa_id', currentEmpresaId);
                if (error) throw error;
                historialFacturasList = facturas || [];
            } catch (e) {
                console.error("Error cargando facturas para proveedores:", e);
            }
        }
    }

    // 2. Procesar agregados de proveedores
    const proveedoresMap = {};
    let totalGastoEmpresa = 0;

    const facturasDelMes = historialFacturasList.filter(f => {
        if (!f.fecha_emision) return false;
        const fecha = parseUTCDate(f.fecha_emision);
        return fecha.getFullYear() === currentMonth.getFullYear() && fecha.getMonth() === currentMonth.getMonth();
    });

    facturasDelMes.forEach(f => {
        const nombre = f.proveedor || 'Emisor Desconocido';
        const total = parseFloat(f.total || 0);
        
        // Conversión básica a CRC para KPIs agregados si es USD
        const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
        const totalEnColones = esUSD ? total * 520 : total; // Tipo de cambio promedio simulado 520

        totalGastoEmpresa += totalEnColones;

        const esPendiente = f.estado === 'PENDIENTE' || f.estado === null;

        if (!proveedoresMap[nombre]) {
            proveedoresMap[nombre] = {
                nombre: nombre,
                facturasEmitidas: 0,
                totalFacturadoColones: 0,
                totalPendienteColones: 0,
                monedaPrincipal: esUSD ? 'USD' : 'CRC',
                ultimaFactura: f.numero_factura,
                ultimaFecha: parseUTCDate(f.fecha_emision)
            };
        }

        proveedoresMap[nombre].facturasEmitidas += 1;
        proveedoresMap[nombre].totalFacturadoColones += totalEnColones;
        
        const saldo = getSaldoPendiente(f);
        const saldoEnColones = esUSD ? saldo * 520 : saldo;
        proveedoresMap[nombre].totalPendienteColones += saldoEnColones;

        const fechaFactura = parseUTCDate(f.fecha_emision);
        if (fechaFactura > proveedoresMap[nombre].ultimaFecha) {
            proveedoresMap[nombre].ultimaFecha = fechaFactura;
            proveedoresMap[nombre].ultimaFactura = f.numero_factura;
        }
    });

    proveedoresList = Object.values(proveedoresMap).sort((a, b) => b.totalFacturadoColones - a.totalFacturadoColones);

    // 3. Renderizar KPIs Bento
    const provActivos = proveedoresList.length;
    let mayorProv = 'N/A';
    let maxGasto = 0;

    proveedoresList.forEach(p => {
        if (p.totalFacturadoColones > maxGasto) {
            maxGasto = p.totalFacturadoColones;
            mayorProv = p.nombre;
        }
    });

    const gastoPromedio = provActivos > 0 ? totalGastoEmpresa / provActivos : 0;

    document.getElementById('kpi-prov-activos').textContent = provActivos;
    document.getElementById('kpi-prov-mayor').textContent = mayorProv;
    document.getElementById('kpi-prov-promedio').textContent = '₡' + gastoPromedio.toLocaleString('es-CR', { maximumFractionDigits: 0 });

    loading.classList.add('hidden');
    filterAndRenderProveedores();
}

function filterAndRenderProveedores() {
    const searchVal = document.getElementById('proveedores-search').value.toLowerCase().trim();

    const filtered = proveedoresList.filter(p => {
        return !searchVal || p.nombre.toLowerCase().includes(searchVal);
    });

    renderProveedoresTable(filtered);
}

function renderProveedoresTable(filtered) {
    const tbody = document.getElementById('proveedores-table-body');
    const empty = document.getElementById('proveedores-empty');

    tbody.innerHTML = '';

    if (filtered.length === 0) {
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');

    filtered.forEach(p => {
        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        
        // Destacar si está seleccionado
        if (selectedProveedor === p.nombre) {
            tr.classList.add('selected-row');
        }
        
        const tienePendiente = p.totalPendienteColones > 0.01; // Tolerancia a flotantes
        const pendienteText = tienePendiente 
            ? `₡${p.totalPendienteColones.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : '—';
        const colorPendiente = tienePendiente ? 'var(--status-coral)' : 'var(--gray-300)';

        tr.innerHTML = `
            <td class="supplier-name font-bold" style="font-weight: 700;">${p.nombre}</td>
            <td class="text-center" style="font-size:1.15rem; font-weight: 600;">${p.facturasEmitidas}</td>
            <td class="text-right amount text-teal" style="color:var(--teal-dark); font-weight:700;">
                ₡${p.totalFacturadoColones.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td class="text-right amount" style="color: ${colorPendiente}; font-weight: ${tienePendiente ? '800' : '500'};">
                ${pendienteText}
            </td>
            <td style="color: var(--gray-800); font-weight: 600;">${p.ultimaFactura}</td>
            <td>${p.ultimaFecha.toLocaleDateString('es-CR')}</td>
            <td class="text-center">
                <button class="view-provider-details-btn btn-secondary" style="padding: 0.4rem 0.8rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem; cursor: pointer;">
                    <i data-lucide="list" style="width: 14px; height: 14px;"></i> Facturas
                </button>
            </td>
        `;

        // Abrir listado de facturas al hacer clic en la fila
        tr.addEventListener('click', (e) => {
            selectedProveedor = p.nombre;
            renderProveedoresTable(filtered);
            updateProveedoresKPIs();
            openProviderInvoicesModal(p.nombre);
        });

        // Evento para el botón de facturas detalladas
        tr.querySelector('.view-provider-details-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            selectedProveedor = p.nombre;
            renderProveedoresTable(filtered);
            updateProveedoresKPIs();
            openProviderInvoicesModal(p.nombre);
        });

        tbody.appendChild(tr);
    });
    
    lucide.createIcons();
}

function updateProveedoresKPIs() {
    const labelActivos = document.getElementById('label-prov-activos');
    const valActivos = document.getElementById('kpi-prov-activos');
    
    const labelMayor = document.getElementById('label-prov-mayor');
    const valMayor = document.getElementById('kpi-prov-mayor');
    
    const labelPromedio = document.getElementById('label-prov-promedio');
    const valPromedio = document.getElementById('kpi-prov-promedio');
    
    const greenSelectedPanel = document.getElementById('kpi-green-selected');
    const greenFacturasCount = document.getElementById('kpi-prov-facturas-seleccionadas');
    const greenProviderInfo = document.getElementById('kpi-green-provider-info');
    const greenProviderName = document.getElementById('kpi-selected-provider-name');
    
    if (!labelActivos || !valActivos || !labelMayor || !valMayor || !labelPromedio || !valPromedio) return;

    if (selectedProveedor) {
        const p = proveedoresList.find(prov => prov.nombre === selectedProveedor);
        if (p) {
            const provActivos = proveedoresList.length;
            
            // Achicar proveedores activos y meterlos en la misma etiqueta
            labelActivos.innerHTML = `Proveedores Activos: <span style="font-weight: 800; color: var(--white); font-size: 1rem; margin-left: 0.25rem;">${provActivos}</span>`;
            valActivos.classList.add('hidden'); // Ocultar el valor gigante
            
            // Mostrar nombre del proveedor en grande en el centro de la tarjeta verde
            if (greenProviderInfo && greenProviderName) {
                greenProviderInfo.classList.remove('hidden');
                greenProviderName.textContent = p.nombre;
                
                // Ajustar fuente según la longitud del nombre
                if (p.nombre.length > 25) {
                    greenProviderName.style.fontSize = "1.05rem";
                } else {
                    greenProviderName.style.fontSize = "1.25rem";
                }
            }
            
            if (greenSelectedPanel && greenFacturasCount) {
                greenSelectedPanel.classList.remove('hidden');
                greenFacturasCount.textContent = p.facturasEmitidas;
            }
            
            // Tarjeta morada: Total Facturado
            labelMayor.textContent = "Total Facturado";
            valMayor.style.fontSize = "2.25rem";
            valMayor.textContent = '₡' + p.totalFacturadoColones.toLocaleString('es-CR', { maximumFractionDigits: 0 });
            
            // Tarjeta naranja: Pendiente de Pago
            labelPromedio.textContent = "Pendiente de Pago";
            valPromedio.style.fontSize = "2.25rem";
            valPromedio.textContent = '₡' + p.totalPendienteColones.toLocaleString('es-CR', { maximumFractionDigits: 0 });
            valPromedio.style.color = "var(--white)";
        }
    } else {
        // Ocultar secciones del proveedor seleccionado
        if (greenProviderInfo) {
            greenProviderInfo.classList.add('hidden');
        }
        if (greenSelectedPanel) {
            greenSelectedPanel.classList.add('hidden');
        }
        
        // Resetear a los valores globales de la empresa
        labelActivos.textContent = "Proveedores Activos";
        valActivos.classList.remove('hidden'); // Mostrar el valor gigante
        
        const provActivos = proveedoresList.length;
        let mayorProv = 'N/A';
        let maxGasto = 0;
        let totalGastoEmpresa = 0;

        proveedoresList.forEach(prov => {
            totalGastoEmpresa += prov.totalFacturadoColones;
            if (prov.totalFacturadoColones > maxGasto) {
                maxGasto = prov.totalFacturadoColones;
                mayorProv = prov.nombre;
            }
        });

        const gastoPromedio = provActivos > 0 ? totalGastoEmpresa / provActivos : 0;

        valActivos.textContent = provActivos;
        
        // Ajustar el tamaño si el mayor emisor tiene un nombre muy largo
        if (mayorProv.length > 25) {
            valMayor.style.fontSize = "1.35rem";
        } else {
            valMayor.style.fontSize = "2.25rem";
        }
        valMayor.textContent = mayorProv;
        
        valPromedio.style.fontSize = "2.25rem";
        valPromedio.textContent = '₡' + gastoPromedio.toLocaleString('es-CR', { maximumFractionDigits: 0 });
        valPromedio.style.color = "";
    }
}

async function openProviderInvoicesModal(providerName) {
    const modal = document.getElementById('provider-invoices-modal');
    if (!modal) return;

    document.getElementById('provider-modal-name').textContent = providerName;
    
    // Asegurar que tenemos todas las facturas de este proveedor
    let facturas = historialFacturasList.filter(f => (f.proveedor || '').trim().toLowerCase() === providerName.trim().toLowerCase());
    
    // Si la lista local está vacía pero tenemos sesión real en Supabase, consultar
    if (facturas.length === 0 && currentEmpresaId && currentEmpresaId !== 'demo-id') {
        try {
            const { data: dbFacturas } = await dbClient
                .from('facturas')
                .select('*')
                .eq('empresa_id', currentEmpresaId)
                .ilike('proveedor', providerName);
            if (dbFacturas && dbFacturas.length > 0) {
                facturas = dbFacturas;
            }
        } catch (err) {
            console.error("Error consultando facturas de proveedor:", err);
        }
    }

    // Ordenar de más reciente a más antigua
    facturas.sort((a, b) => {
        const fechaA = a.fecha_emision ? new Date(a.fecha_emision) : new Date(0);
        const fechaB = b.fecha_emision ? new Date(b.fecha_emision) : new Date(0);
        return fechaB - fechaA;
    });

    // Calcular acumulados del proveedor
    let totalAcumuladoCRC = 0;
    let totalPendienteCRC = 0;
    let tieneUSD = false;
    let totalAcumuladoUSD = 0;
    let totalPendienteUSD = 0;

    facturas.forEach(f => {
        const total = parseFloat(f.total || 0);
        const saldo = getSaldoPendiente(f);
        const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
        
        if (esUSD) {
            tieneUSD = true;
            totalAcumuladoUSD += total;
            totalPendienteUSD += saldo;
        } else {
            totalAcumuladoCRC += total;
            totalPendienteCRC += saldo;
        }
    });

    const elTotal = document.getElementById('provider-total-amount');
    const elPending = document.getElementById('provider-pending-amount');

    if (tieneUSD && totalAcumuladoCRC > 0) {
        elTotal.textContent = `₡${totalAcumuladoCRC.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + $${totalAcumuladoUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        elPending.textContent = `₡${totalPendienteCRC.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} + $${totalPendienteUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else if (tieneUSD) {
        elTotal.textContent = `$${totalAcumuladoUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        elPending.textContent = `$${totalPendienteUSD.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    } else {
        elTotal.textContent = `₡${totalAcumuladoCRC.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        elPending.textContent = `₡${totalPendienteCRC.toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    const tbody = document.getElementById('provider-modal-table-body') || document.getElementById('provider-invoices-tbody');
    const empty = document.getElementById('provider-modal-empty');
    if (tbody) tbody.innerHTML = '';

    if (facturas.length === 0) {
        if (empty) empty.classList.remove('hidden');
    } else {
        if (empty) empty.classList.add('hidden');
        facturas.forEach(f => {
            const tr = document.createElement('tr');
            tr.style.cursor = 'pointer';

            const total = parseFloat(f.total || 0);
            const saldo = getSaldoPendiente(f);
            const pagado = total - saldo;
            const esUSD = f.moneda === 'USD' || (total < 20000 && f.moneda !== 'CRC');
            
            const totalFormateado = esUSD 
                ? '$' + total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : formatMoney(total);
                
            const emision = parseUTCDate(f.fecha_emision);
            const emisionStr = emision ? emision.toLocaleDateString('es-CR') : 'N/A';
            
            const vencimiento = f.fecha_vencimiento ? parseUTCDate(f.fecha_vencimiento) : null;
            const vencimientoStr = vencimiento ? vencimiento.toLocaleDateString('es-CR') : '—';
            
            const esPagada = (f.estado === 'PAGADA' || f.estado === 'APROBADA') || (saldo <= 0.01 && total > 0);
            const badgeClass = esPagada ? 'badge-pagada' : 'badge-pendiente';
            const badgeText = esPagada ? 'PAGADA' : 'PENDIENTE';
            
            tr.innerHTML = `
                <td class="invoice-num font-bold">${f.numero_factura || 'Sin N°'}</td>
                <td>${emisionStr}</td>
                <td>${vencimientoStr}</td>
                <td class="text-right amount text-teal" style="font-weight: 700;">
                    ${totalFormateado}
                    ${!esPagada && pagado > 0.01 ? `<div style="font-size:0.75rem; color:var(--status-coral); font-weight:600;">Saldo: ${esUSD ? '$' + saldo.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : formatMoney(saldo)}</div>` : ''}
                </td>
                <td class="text-center">
                    <span class="badge ${badgeClass}">${badgeText}</span>
                </td>
                <td class="text-center">
                    <button class="view-invoice-btn btn-secondary" style="padding: 0.35rem 0.7rem; font-size: 0.8rem; display: inline-flex; align-items: center; gap: 0.35rem; cursor: pointer;">
                        <i data-lucide="eye" style="width: 14px; height: 14px;"></i> Ver
                    </button>
                </td>
            `;

            // Al tocar la fila o el botón, abrir el visor completo 360° con PDF y líneas
            tr.addEventListener('click', () => {
                openModal(f);
            });

            if (tbody) tbody.appendChild(tr);
        });
    }

    modal.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

// ==========================================================================
// CHATBOT DE IA INTERACTIVO (GEMINI COPIOT)
// ==========================================================================

let chatHistory = [];
const ANALISTA_API_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? '/api/analista' : 'https://dukf7ywloe.execute-api.us-west-2.amazonaws.com/default/nautilus-bot-facturas01';

function inicializarChat() {
    const bubble = document.getElementById('chat-bubble');
    const closeBtn = document.getElementById('chat-close-btn');
    const panel = document.getElementById('chat-panel');
    const form = document.getElementById('chat-input-form');
    
    if (!bubble || !closeBtn || !panel || !form) return;
    
    // Clonar nodos para remover listeners previos del Dashboard
    const newBubble = bubble.cloneNode(true);
    bubble.parentNode.replaceChild(newBubble, bubble);
    
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);

    // Cargar historial previo de localStorage limpiando entradas defectuosas
    const savedHistory = localStorage.getItem(`nautilus_chat_history_${currentEmpresaId}`);
    if (savedHistory) {
        try {
            const parsed = JSON.parse(savedHistory);
            chatHistory = Array.isArray(parsed) ? parsed.filter(item => item && item.role && item.text && typeof item.text === 'string' && !item.text.startsWith('❌')) : [];
            renderChatHistory();
        } catch(e) {
            chatHistory = [];
        }
    } else {
        chatHistory = [];
        resetChatVisual();
    }


    // Abrir o cerrar el chat mediante el botón lateral
    const navAsistente = document.getElementById('nav-asistente');
    if (navAsistente) {
        const newNav = navAsistente.cloneNode(true);
        navAsistente.parentNode.replaceChild(newNav, navAsistente);
        
        newNav.addEventListener('click', (e) => {
            e.preventDefault();
            panel.classList.toggle('hidden');
            if (!panel.classList.contains('hidden')) {
                scrollChatToBottom();
                document.getElementById('chat-input-text').focus();
                newNav.classList.add('active');
            } else {
                newNav.classList.remove('active');
            }
        });
    }

    // Abrir o cerrar el chat mediante la burbuja
    newBubble.addEventListener('click', () => {
        panel.classList.toggle('hidden');
        const mainContent = document.querySelector('.main-content');
        if (!panel.classList.contains('hidden')) {
            if (mainContent) mainContent.classList.add('chat-open');
            scrollChatToBottom();
            document.getElementById('chat-input-text').focus();
            const navAs = document.getElementById('nav-asistente');
            if (navAs) navAs.classList.add('active');
        } else {
            if (mainContent) mainContent.classList.remove('chat-open');
            const navAs = document.getElementById('nav-asistente');
            if (navAs) navAs.classList.remove('active');
        }
        if (typeof renderTrendChart === 'function') renderTrendChart();
    });

    // Cerrar panel de chat
    newCloseBtn.addEventListener('click', () => {
        panel.classList.add('hidden');
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.classList.remove('chat-open');
        const navAs = document.getElementById('nav-asistente');
        if (navAs) navAs.classList.remove('active');
        if (typeof renderTrendChart === 'function') renderTrendChart();
    });

    // Enviar consulta a la Lambda de AWS y Gemini
    newForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = document.getElementById('chat-input-text');
        const text = input.value.trim();
        if (!text) return;

        // Mostrar el mensaje en el chat visual
        appendChatMessage('user', text);
        chatHistory.push({ role: 'user', text: text });
        input.value = '';
        scrollChatToBottom();

        // Mostrar burbuja de carga animada
        const loadingId = appendChatLoading();
        scrollChatToBottom();

        try {
            const companyNameStr = document.getElementById('company-name').textContent.replace("(Modo Demo Offline)", "").trim();
            const currentTab = document.querySelector('.sidebar-nav .nav-item.active')?.getAttribute('data-view') || 'dashboard';
            
            const response = await fetch(ANALISTA_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    question: text,
                    empresa_id: currentEmpresaId,
                    nombre_empresa: companyNameStr,
                    pestana_actual: currentTab,
                    history: chatHistory.slice(-10), // Mantener historial de últimos 10 mensajes
                    auth_token: currentSession?.access_token || ''
                })
            });

            removeChatLoading(loadingId);

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || `HTTP ${response.status}`);
            }

            const data = await response.json();
            let botResponse = data.response;
            let actionObj = data.action;
            
            if (!botResponse && data.body) {
                try {
                    const parsed = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
                    botResponse = parsed.response || parsed.error;
                    if (!actionObj && parsed.action) actionObj = parsed.action;
                } catch(e) {}
            }
            if (!botResponse) {
                botResponse = typeof data === 'string' ? data : (data.error || JSON.stringify(data));
            }

            // Renderizar respuesta en pantalla
            appendChatMessage('model', botResponse);
            chatHistory.push({ role: 'model', text: botResponse });

            // Ejecutar acción de interfaz si el asistente la solicitó
            if (actionObj) {
                ejecutarAccionesUI(actionObj);
            }

            // Persistir historial localmente
            localStorage.setItem(`nautilus_chat_history_${currentEmpresaId}`, JSON.stringify(chatHistory));
            scrollChatToBottom();

        } catch (error) {
            console.error("Error consultando al analista de IA:", error);
            removeChatLoading(loadingId);
            
            // Capturar errores específicos de cuotas de Gemini (429) o fallos de red
            let errorMessage = "❌ **Fallo de Conexión:** No logré procesar tu consulta en este momento. ";
            if (error.message.includes("429") || error.message.includes("quota") || error.message.includes("RESOURCE_EXHAUSTED")) {
                errorMessage = "❌ **Límite Excedido (429):** La API Key gratuita de Gemini superó el límite diario de 20 consultas. Por favor, asocia una tarjeta para el plan *Pay-as-you-go* en tu Google AI Studio y el analista web funcionará de forma ilimitada de inmediato.";
            } else {
                errorMessage += `Detalles: ${error.message}`;
            }
            
            appendChatMessage('model', errorMessage);
            scrollChatToBottom();
        }
    });

    lucide.createIcons();
}

function ejecutarAccionesUI(action) {
    if (!action || typeof action !== 'object') return;
    
    if (action.type === 'DESTACAR_FACTURAS' && Array.isArray(action.factura_ids)) {
        // 1. Cambiar a la vista de historial de facturas si no estamos en ella
        const navFacturas = document.querySelector('.sidebar-nav .nav-item[data-view="facturas"]');
        if (navFacturas && !navFacturas.classList.contains('active')) {
            navFacturas.click();
        }
        
        // 2. Esperar 250ms a que la tabla se renderice
        setTimeout(() => {
            const allRows = document.querySelectorAll('#historial-table-body tr[data-factura-id]');
            const targetIds = new Set(action.factura_ids.map(id => String(id)));
            let primeraFila = null;
            let totalEncontradas = 0;

            allRows.forEach(tr => {
                const fid = tr.getAttribute('data-factura-id');
                if (targetIds.has(fid)) {
                    tr.classList.remove('hidden');
                    tr.classList.add('highlight-glow');
                    if (!primeraFila) primeraFila = tr;
                    totalEncontradas++;
                } else {
                    tr.classList.remove('highlight-glow');
                    tr.classList.add('hidden');
                }
            });

            // 3. Renderizar badge de filtro de IA arriba de la tabla
            const badgeContainer = document.getElementById('historial-ia-filter-badge');
            if (badgeContainer) {
                badgeContainer.innerHTML = `
                    <span class="ia-filter-badge">
                        ✨ Filtrado por IA (${totalEncontradas} de ${allRows.length})
                        <button id="btn-limpiar-filtro-ia">✕ Mostrar Todas</button>
                    </span>
                `;
                badgeContainer.classList.remove('hidden');

                const btnLimpiar = document.getElementById('btn-limpiar-filtro-ia');
                if (btnLimpiar) {
                    btnLimpiar.addEventListener('click', () => {
                        allRows.forEach(tr => {
                            tr.classList.remove('hidden');
                            tr.classList.remove('highlight-glow');
                        });
                        badgeContainer.classList.add('hidden');
                        badgeContainer.innerHTML = '';
                    });
                }
            }
            
            if (primeraFila) {
                primeraFila.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 250);
    }
}


function appendChatMessage(role, text) {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;

    const messageDiv = document.createElement('div');
    messageDiv.className = `message message-${role === 'user' ? 'user' : 'bot'}`;
    
    // Formatear negritas Markdown y saltos de línea
    const formattedText = text
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');

    messageDiv.innerHTML = `
        <div class="message-content">
            ${formattedText}
        </div>
    `;
    container.appendChild(messageDiv);
}

function appendChatLoading() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return "";

    const id = 'loading-' + Date.now();
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'message message-loading';
    loadingDiv.id = id;
    loadingDiv.innerHTML = `
        <div class="message-content">
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
        </div>
    `;
    container.appendChild(loadingDiv);
    return id;
}

function removeChatLoading(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
}

function scrollChatToBottom() {
    const container = document.getElementById('chat-messages-container');
    if (container) container.scrollTop = container.scrollHeight;
}

function renderChatHistory() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;
    
    resetChatVisual();
    chatHistory.forEach(msg => {
        appendChatMessage(msg.role, msg.text);
    });
    scrollChatToBottom();
}

function resetChatVisual() {
    const container = document.getElementById('chat-messages-container');
    if (!container) return;
    
    container.innerHTML = `
        <div class="message message-bot">
            <div class="message-content">
                ¡Hola! Soy tu asistente de finanzas, desarrollado por Nautilus. Puedo responder preguntas sobre tus facturas, proveedores o estados de cuenta. ¿Qué deseas analizar hoy?
            </div>
        </div>
    `;
}

function limpiarChatLocal() {
    chatHistory = [];
    localStorage.removeItem(`nautilus_chat_history_${currentEmpresaId}`);
    resetChatVisual();
    const navAs = document.getElementById('nav-asistente');
    if (navAs) navAs.classList.remove('active');
}

// =========================================================================
// MÓDULO: AUDITORÍA E HISTORIAL DE PRECIOS
// =========================================================================
let lineasFacturaList = [];
let productosNormalizados = {}; 
let selectedProductoKey = null;
let preciosChartInstance = null;

// Traducir diferencias de fechas a tiempo relativo en español
function getTiempoRelativo(fechaString) {
    if (!fechaString) return '';
    const fecha = new Date(fechaString + 'T00:00:00');
    const hoy = new Date();
    hoy.setHours(0,0,0,0);
    fecha.setHours(0,0,0,0);
    
    const diffTime = hoy - fecha;
    const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return 'Hoy';
    if (diffDays === 1) return 'Ayer';
    if (diffDays < 30) return `Hace ${diffDays} días`;
    
    const diffMonths = Math.round(diffDays / 30.5);
    if (diffMonths === 1) return 'Hace 1 mes';
    return `Hace ${diffMonths} meses`;
}

// Estandarización léxica de descripciones
function normalizarDescripcion(desc) {
    if (!desc) return '';
    let str = desc.toLowerCase().trim();
    // Eliminar acentos
    str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    // Limpieza de ruidos comunes
    str = str.replace(/sacos de\s+/g, '')
             .replace(/saco de\s+/g, '')
             .replace(/sacos\s+/g, '')
             .replace(/saco\s+/g, '')
             .replace(/unidades de\s+/g, '')
             .replace(/unidad de\s+/g, '')
             .replace(/unidades\s+/g, '')
             .replace(/unidad\s+/g, '')
             .replace(/[\.\,\-\/\#]/g, ' ')
             .replace(/\s+/g, ' ');
    return str.trim();
}

async function refreshPreciosData() {
    console.log("=== Cargando Historial de Precios ===");
    
    // Rellenar combobox de proveedores en el filtro
    const pSelect = document.getElementById('precios-filter-proveedor');
    if (pSelect) {
        pSelect.innerHTML = '<option value="TODOS">Todos los proveedores</option>';
        const proveedores = [...new Set(historialFacturasList.map(f => f.proveedor))].sort();
        proveedores.forEach(prov => {
            pSelect.innerHTML += `<option value="${prov}">${prov}</option>`;
        });
    }

    if (currentEmpresaId === 'demo-id') {
        cargarDatosDemoPrecios();
        filterAndRenderPrecios();
        return;
    }

    if (!historialFacturasList || historialFacturasList.length === 0) {
        renderPreciosEmpty();
        return;
    }

    try {
        const ids = historialFacturasList.map(f => f.id);
        const { data: lineas, error } = await dbClient
            .from('lineas_factura')
            .select('*')
            .in('factura_id', ids);

        if (error) {
            console.error("Error obteniendo lineas:", error);
            renderPreciosEmpty();
            return;
        }

        lineasFacturaList = lineas || [];
        procesarLineasDeFactura();
        filterAndRenderPrecios();
    } catch (e) {
        console.error("Excepción cargando precios:", e);
        renderPreciosEmpty();
    }
}

function cargarDatosDemoPrecios() {
    // Generamos datos simulados realistas para el entorno demo
    lineasFacturaList = [
        // Compras de Varilla con Equipos de Elevación
        { id: "l1", factura_id: "f1", descripcion: "Varilla de construcción #4", cantidad: 300, precio_unitario: 1033.33, total_linea: 310000.00 },
        { id: "l2", factura_id: "f2", descripcion: "Varilla de construcción #4", cantidad: 300, precio_unitario: 333.33, total_linea: 100000.00 },
        { id: "l3", factura_id: "f3", descripcion: "Varilla de construcción #4", cantidad: 200, precio_unitario: 320.00, total_linea: 64000.00 },
        // Mismo material comprado con otro proveedor más barato
        { id: "l4", factura_id: "f4", descripcion: "Varilla de construcción #4", cantidad: 100, precio_unitario: 310.00, total_linea: 31000.00 },
        
        // Compras de Cemento con Materiales y Agregados del Sur
        { id: "l5", factura_id: "f5", descripcion: "Cemento Gris Holcim 50kg", cantidad: 50, precio_unitario: 5500.00, total_linea: 275000.00 },
        { id: "l6", factura_id: "f6", descripcion: "Cemento Gris Holcim 50kg", cantidad: 40, precio_unitario: 5600.00, total_linea: 224000.00 },
        { id: "l7", factura_id: "f7", descripcion: "Cemento Gris Holcim 50kg", cantidad: 60, precio_unitario: 5100.00, total_linea: 306000.00 }
    ];

    // Simular el mapeo de facturas ficticias para vincular fecha y proveedor
    const facturasSimuladas = {
        "f1": { proveedor: "Equipos de Elevación y Carga S.A.", fecha_emision: "2026-07-17", moneda: "CRC" },
        "f2": { proveedor: "Equipos de Elevación y Carga S.A.", fecha_emision: "2026-06-14", moneda: "CRC" },
        "f3": { proveedor: "Equipos de Elevación y Carga S.A.", fecha_emision: "2026-04-10", moneda: "CRC" },
        "f4": { proveedor: "Materiales y Agregados del Sur S.A.", fecha_emision: "2026-05-12", moneda: "CRC" },
        "f5": { proveedor: "Materiales y Agregados del Sur S.A.", fecha_emision: "2026-07-15", moneda: "CRC" },
        "f6": { proveedor: "Materiales y Agregados del Sur S.A.", fecha_emision: "2026-06-10", moneda: "CRC" },
        "f7": { proveedor: "Tornileria y Fijaciones Industriales S.A.", fecha_emision: "2026-05-08", moneda: "CRC" }
    };

    procesarLineasConMetadata(facturasSimuladas);
}

function procesarLineasDeFactura() {
    // Mapear facturas reales
    const facturasMap = {};
    historialFacturasList.forEach(f => {
        facturasMap[f.id] = {
            proveedor: f.proveedor,
            fecha_emision: f.fecha_emision,
            moneda: f.moneda
        };
    });
    procesarLineasConMetadata(facturasMap);
}

function procesarLineasConMetadata(facturasMap) {
    productosNormalizados = {};
    
    lineasFacturaList.forEach(linea => {
        const fact = facturasMap[linea.factura_id];
        if (!fact) return; // Línea huérfana de filtro

        const key = normalizarDescripcion(linea.descripcion);
        if (!key) return;

        // Estructura del artículo
        if (!productosNormalizados[key]) {
            productosNormalizados[key] = {
                nombre_mostrado: linea.descripcion,
                compras: []
            };
        }

        // Si no viene precio unitario en la base de datos, lo calculamos
        let pUnit = parseFloat(linea.precio_unitario);
        if (isNaN(pUnit) || pUnit <= 0) {
            pUnit = parseFloat(linea.total_linea) / parseInt(linea.cantidad);
        }

        productosNormalizados[key].compras.push({
            fecha: fact.fecha_emision,
            proveedor: fact.proveedor,
            cantidad: parseInt(linea.cantidad),
            precio_unitario: pUnit,
            moneda: fact.moneda
        });
    });

    // Ordenar cronológicamente las compras de cada producto
    for (const key in productosNormalizados) {
        productosNormalizados[key].compras.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
        
        const compras = productosNormalizados[key].compras;
        const ultima = compras[compras.length - 1];
        
        // Buscar el precio de la compra anterior
        let anterior = null;
        for (let i = compras.length - 2; i >= 0; i--) {
            if (compras[i].proveedor === ultima.proveedor) {
                anterior = compras[i];
                break;
            }
        }

        // Variación porcentual
        let variacion = 0;
        if (anterior && anterior.precio_unitario > 0) {
            variacion = ((ultima.precio_unitario - anterior.precio_unitario) / anterior.precio_unitario) * 100;
        }

        // Buscar proveedor recomendado (tarifa mínima)
        let recomendado = ultima;
        compras.forEach(c => {
            if (c.precio_unitario < recomendado.precio_unitario) {
                recomendado = c;
            }
        });

        productosNormalizados[key].ultima_compra = ultima;
        productosNormalizados[key].compra_anterior = anterior;
        productosNormalizados[key].variacion = variacion;
        productosNormalizados[key].recomendado = recomendado;
    }
}

function filterAndRenderPrecios() {
    let totalMostrados = 0;
    let totalAlertas = 0;
    
    const gridAlerts = document.getElementById('precios-top-alerts-grid');
    const tableTbody = document.getElementById('precios-table-tbody');
    const alertsContainer = document.getElementById('precios-alerts-container');
    const empty = document.getElementById('precios-empty');
    
    if (gridAlerts) gridAlerts.innerHTML = '';
    if (tableTbody) tableTbody.innerHTML = '';

    const searchVal = document.getElementById('precios-search').value.toLowerCase().trim();
    const filterProv = document.getElementById('precios-filter-proveedor').value;
    const filterTend = document.getElementById('precios-filter-tendencia').value;

    let productoMayorImpacto = null;
    let mayorVariacion = -999;

    // 1. Filtrar productos de la base de datos local
    const productosFiltrados = [];
    for (const key in productosNormalizados) {
        const prod = productosNormalizados[key];
        
        // Filtro de búsqueda
        if (searchVal && !prod.nombre_mostrado.toLowerCase().includes(searchVal)) {
            continue;
        }

        // Filtro de Proveedor
        if (filterProv !== 'TODOS' && prod.ultima_compra.proveedor !== filterProv) {
            continue;
        }

        // Filtro de Tendencia
        if (filterTend !== 'TODOS') {
            if (filterTend === 'ALTA' && prod.variacion < 10) continue;
            if (filterTend === 'ESTABLE' && Math.abs(prod.variacion) >= 10) continue;
        }

        productosFiltrados.push({ key, ...prod });
        totalMostrados++;

        // Encontrar producto de mayor impacto para autoselección
        if (prod.variacion > mayorVariacion) {
            mayorVariacion = prod.variacion;
            productoMayorImpacto = key;
        }
    }

    // 2. Identificar el Top 5 de Alertas Críticas (variacion >= 10.0%)
    const alertasCriticas = productosFiltrados
        .filter(p => p.variacion >= 10.0)
        .sort((a, b) => b.variacion - a.variacion)
        .slice(0, 5);

    const keysAlertasCriticas = new Set(alertasCriticas.map(p => p.key));
    totalAlertas = alertasCriticas.length;

    // 3. Renderizar las Bento Cards detalladas de Alertas
    alertasCriticas.forEach(prod => {
        const isSelected = selectedProductoKey === prod.key ? 'selected' : '';
        const diffCRC = prod.ultima_compra.precio_unitario - prod.compra_anterior.precio_unitario;
        const escapedKey = prod.key.replace(/'/g, "\\'").replace(/"/g, "&quot;");

        gridAlerts.innerHTML += `
            <div class="insumo-card ${isSelected}" onclick="showProductoDetail('${escapedKey}', this)" style="border-left: 5px solid var(--status-coral); display: flex; flex-direction: column; justify-content: space-between; height: 180px; padding: 1.25rem;">
                <div>
                    <div style="font-weight: 800; color: var(--charcoal); margin-bottom: 0.25rem; line-height: 1.2; font-size: 0.95rem;">
                        ${prod.nombre_mostrado}
                    </div>
                    <div style="font-size: 0.78rem; color: var(--gray-500);">
                        Último emisor: <span style="font-weight: 600; color: var(--gray-600);">${prod.ultima_compra.proveedor}</span>
                    </div>
                </div>
                
                <div style="margin-top: auto;">
                    <div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 0.5rem;">
                        <div>
                            <div style="font-size: 0.7rem; text-transform: uppercase; font-weight: 700; color: var(--gray-400); letter-spacing: 0.05em; margin-bottom: 0.1rem;">Costo Actual</div>
                            <div style="font-size: 1.35rem; font-weight: 800; color: var(--charcoal); letter-spacing: -0.02em; line-height: 1.1;">
                                ${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(prod.ultima_compra.precio_unitario)}
                            </div>
                        </div>
                        
                        <div style="padding: 0.35rem 0.5rem; background: rgba(220, 38, 38, 0.08); border: 1px solid rgba(220, 38, 38, 0.15); border-radius: 6px; display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; font-weight: 700; color: var(--status-coral);">
                            <i data-lucide="arrow-up" style="width: 14px; height: 14px; stroke-width: 3px;"></i>
                            +${prod.variacion.toFixed(1)}%
                        </div>
                    </div>
                    
                    <div style="font-size: 0.76rem; font-weight: 600; color: var(--gray-500); border-top: 1px solid var(--gray-100); padding-top: 0.4rem; display: flex; justify-content: space-between;">
                        <span>Costo anterior:</span>
                        <span style="font-weight: 700; color: var(--gray-600);">${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(prod.compra_anterior.precio_unitario)}</span>
                    </div>
                </div>
            </div>
        `;
    });

    // 4. Renderizar el resto de insumos en la Tabla Compacta
    productosFiltrados.forEach(prod => {
        // Si ya está en la tarjeta de alerta superior, no duplicar en la tabla compacta a menos que filtre
        if (keysAlertasCriticas.has(prod.key) && filterTend !== 'ESTABLE') {
            return;
        }

        const isSelected = selectedProductoKey === prod.key ? 'selected-insumo-row' : '';
        
        let varClase = 'timeline-variation stable';
        let varSimbolo = 'Estable';
        let costoAnteriorHTML = '-';
        let esSubida = prod.variacion > 0;

        const costoActual = prod.ultima_compra.precio_unitario;
        const costoAnterior = prod.compra_anterior ? prod.compra_anterior.precio_unitario : 0;
        const diff = costoActual - costoAnterior;

        if (!prod.compra_anterior) {
            varSimbolo = 'Inicial';
            varClase = '';
            costoAnteriorHTML = '-';
        } else if (diff > 0) {
            varClase = 'text-coral-important';
            varSimbolo = `Subió ${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(diff)}`;
            costoAnteriorHTML = `${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoAnterior)}`;
        } else if (diff < 0) {
            varClase = 'text-teal-important';
            varSimbolo = `Bajó ${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(Math.abs(diff))}`;
            costoAnteriorHTML = `${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoAnterior)}`;
        } else {
            varSimbolo = 'Estable';
            varClase = '';
            costoAnteriorHTML = `${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoAnterior)}`;
        }

        const escapedKey = prod.key.replace(/'/g, "\\'").replace(/"/g, "&quot;");

        tableTbody.innerHTML += `
            <tr class="prices-row ${isSelected}" onclick="showProductoDetail('${escapedKey}', this)">
                <td style="font-weight: 700; color: var(--charcoal); padding: 0.85rem 1rem;">
                    ${prod.nombre_mostrado}
                </td>
                <td style="font-weight: 600; color: var(--gray-600); padding: 0.85rem 1rem;">
                    ${prod.ultima_compra.proveedor}
                </td>
                <td class="text-right ${esSubida ? 'text-coral-important' : ''}" style="font-weight: 700; padding: 0.85rem 1rem;">
                    ${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoActual)}
                </td>
                <td class="text-right" style="font-weight: 600; color: var(--gray-600); padding: 0.85rem 1rem;">
                    ${costoAnteriorHTML}
                </td>
                <td class="text-center ${varClase}" style="padding: 0.85rem 1rem; font-weight: 700;">
                    ${varSimbolo}
                </td>
            </tr>
        `;
    });

    lucide.createIcons();

    // Mostrar/ocultar contenedor de alertas críticas
    if (totalAlertas > 0 && alertsContainer) {
        alertsContainer.classList.remove('hidden');
    } else if (alertsContainer) {
        alertsContainer.classList.add('hidden');
    }

    if (totalMostrados === 0) {
        if (empty) empty.classList.remove('hidden');
    } else {
        if (empty) empty.classList.add('hidden');
        
        // Autoseleccionar el producto de mayor variación en la carga inicial
        if (selectedProductoKey === null && productoMayorImpacto) {
            setTimeout(() => {
                // Buscar si está en las Bento Cards superiores o en la Tabla inferior
                let targetCard = Array.from(document.querySelectorAll('.insumo-card')).find(c => 
                    c.getAttribute('onclick') && c.getAttribute('onclick').includes(productoMayorImpacto)
                );
                
                if (!targetCard) {
                    targetCard = Array.from(document.querySelectorAll('.prices-row')).find(c => 
                        c.getAttribute('onclick') && c.getAttribute('onclick').includes(productoMayorImpacto)
                    );
                }
                
                showProductoDetail(productoMayorImpacto, targetCard);
            }, 50);
        }
    }
}

function showProductoDetail(key, element) {
    selectedProductoKey = key;
    
    // Resaltar tarjeta o fila seleccionada
    document.querySelectorAll('.insumo-card').forEach(card => card.classList.remove('selected'));
    document.querySelectorAll('.prices-row').forEach(row => row.classList.remove('selected-insumo-row'));
    
    if (element) {
        if (element.classList.contains('prices-row')) {
            element.classList.add('selected-insumo-row');
        } else {
            element.classList.add('selected');
        }
    }

    const panel = document.getElementById('precios-detail-panel');
    if (!panel) return;

    panel.classList.remove('hidden');
    panel.style.display = 'flex';

    const prod = productosNormalizados[key];
    document.getElementById('precios-detail-title').innerText = prod.nombre_mostrado;

    // Llenar Ficha del Material y Proveedores Históricos
    const infoCard = document.getElementById('precios-detail-info-card');
    if (infoCard) {
        const totalUnidades = prod.compras.reduce((acc, c) => acc + c.cantidad, 0);
        const totalTransacciones = prod.compras.length;

        // Agrupar compras por proveedor
        const comprasPorProv = {};
        prod.compras.forEach(c => {
            if (!comprasPorProv[c.proveedor]) {
                comprasPorProv[c.proveedor] = [];
            }
            comprasPorProv[c.proveedor].push(c);
        });

        let proveedoresHTML = '';
        for (const provName in comprasPorProv) {
            const list = comprasPorProv[provName];
            const totalComprado = list.reduce((acc, c) => acc + c.cantidad, 0);
            
            const costoActual = list[list.length - 1].precio_unitario;
            const costoAnterior = list.length >= 2 ? list[list.length - 2].precio_unitario : null;
            const moneda = list[list.length - 1].moneda;

            let varHTML = '';
            let costoAnteriorTexto = '-';

            if (costoAnterior === null) {
                varHTML = `<span style="color: var(--gray-400); font-weight: 700;">Inicial</span>`;
                costoAnteriorTexto = '-';
            } else {
                const diff = costoActual - costoAnterior;
                costoAnteriorTexto = `${moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoAnterior)}`;
                
                if (diff > 0) {
                    varHTML = `<span class="text-coral-important">▲ Subió ${moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(diff)}</span>`;
                } else if (diff < 0) {
                    varHTML = `<span class="text-teal-important">▼ Bajó ${moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(Math.abs(diff))}</span>`;
                } else {
                    varHTML = `<span style="color: var(--gray-400); font-weight: 700;">Estable</span>`;
                }
            }

            proveedoresHTML += `
                <div style="border-top: 1px solid var(--gray-100); padding-top: 0.6rem; margin-top: 0.6rem; display: flex; flex-direction: column; gap: 0.25rem;">
                    <div style="font-weight: 800; color: var(--charcoal); display: flex; justify-content: space-between; font-size: 0.82rem;">
                        <span>${provName}</span>
                        <span style="font-size: 0.72rem; color: var(--gray-400); font-weight: 600;">Adquirido: ${totalComprado} uds</span>
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; text-align: left; font-size: 0.78rem; font-weight: 600; color: var(--gray-500); margin-top: 0.1rem;">
                        <div>
                            <span style="font-size: 0.68rem; color: var(--gray-400); display: block; text-transform: uppercase;">Actual</span>
                            <span style="font-weight: 800; color: var(--charcoal);">${moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(costoActual)}</span>
                        </div>
                        <div>
                            <span style="font-size: 0.68rem; color: var(--gray-400); display: block; text-transform: uppercase;">Anterior</span>
                            <span>${costoAnteriorTexto}</span>
                        </div>
                        <div style="text-align: right;">
                            <span style="font-size: 0.68rem; color: var(--gray-400); display: block; text-transform: uppercase; text-align: right;">Variación</span>
                            ${varHTML}
                        </div>
                    </div>
                </div>
            `;
        }

        infoCard.innerHTML = `
            <div style="font-weight: 800; color: var(--charcoal); font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.05em; display: flex; justify-content: space-between; align-items: center;">
                <span>Ficha del Insumo</span>
                <span style="font-size: 0.75rem; color: var(--gray-400); font-weight: 600; text-transform: none;">Total: ${totalUnidades} uds (${totalTransacciones} facturas)</span>
            </div>
            ${proveedoresHTML}
        `;
    }

    // Llenar recomendador de proveedor más barato
    const savingText = document.getElementById('precios-saving-text');
    const savingBox = document.getElementById('precios-saving-box');

    const tieneOtrosProveedores = prod.compras.some(c => c.proveedor !== prod.ultima_compra.proveedor);

    if (tieneOtrosProveedores && prod.recomendado.proveedor !== prod.ultima_compra.proveedor) {
        const diferencia = prod.ultima_compra.precio_unitario - prod.recomendado.precio_unitario;
        const difPorc = (diferencia / prod.recomendado.precio_unitario) * 100;
        
        savingBox.style.background = 'rgba(16, 185, 129, 0.06)';
        savingBox.style.borderLeftColor = 'var(--teal)';
        savingText.innerHTML = `
            Puedes ahorrar <span style="color: var(--teal-dark); font-weight:800;">${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(diferencia)}</span> por unidad (${difPorc.toFixed(1)}%) si le compras a 
            <span style="font-weight: 800; color: var(--charcoal);">${prod.recomendado.proveedor}</span> (Tarifa: ${prod.recomendado.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(prod.recomendado.precio_unitario)}).
        `;
    } else if (tieneOtrosProveedores) {
        savingBox.style.background = 'rgba(16, 185, 129, 0.06)';
        savingBox.style.borderLeftColor = 'var(--teal)';
        savingText.innerHTML = `
            ¡Excelente! Le estás comprando al proveedor más económico registrado: 
            <span style="font-weight: 800; color: var(--teal-dark);">${prod.ultima_compra.proveedor}</span> (Tarifa: ${prod.ultima_compra.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(prod.ultima_compra.precio_unitario)}).
        `;
    } else {
        savingBox.style.background = 'rgba(234, 88, 12, 0.06)';
        savingBox.style.borderLeftColor = 'var(--coral)';
        savingText.innerHTML = `
            Sólo tienes registrado a <span style="font-weight: 800; color: var(--charcoal);">${prod.ultima_compra.proveedor}</span> para este material. Se necesita registrar compras de otros proveedores para habilitar la comparación.
        `;
    }

    // Llenar Línea de Tiempo Narrativa (Invertida: Más reciente primero)
    const timelineContainer = document.getElementById('precios-timeline-container');
    if (timelineContainer) {
        timelineContainer.innerHTML = '';
        
        // Mapear variaciones en orden cronológico ascendente primero
        const comprasProcesadas = prod.compras.map((c, index) => {
            let diff = 0;
            let porc = 0;
            let esInicial = index === 0;

            if (index > 0) {
                const prev = prod.compras[index - 1];
                diff = c.precio_unitario - prev.precio_unitario;
                porc = (diff / prev.precio_unitario) * 100;
            }

            return { ...c, diff, porc, esInicial };
        });

        // Invertir compras para mostrar la más reciente primero
        const comprasInvertidas = [...comprasProcesadas].reverse();

        comprasInvertidas.forEach(c => {
            const dateObj = new Date(c.fecha + 'T00:00:00');
            const formattedDate = dateObj.toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const tiempoRelativo = getTiempoRelativo(c.fecha);
            
            let variacionText = '';
            let claseVar = 'stable';
            let claseNode = 'active-node';

            if (c.esInicial) {
                variacionText = `Compra inicial de referencia a ${c.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(c.precio_unitario)} la unidad con el proveedor ${c.proveedor}.`;
                claseVar = 'stable';
                claseNode = 'active-node';
            } else {
                if (c.diff > 0) {
                    variacionText = `▲ La unidad de ${prod.nombre_mostrado} subió ${c.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(c.diff)} (+${c.porc.toFixed(1)}%) con el proveedor ${c.proveedor}.`;
                    claseVar = 'up';
                    claseNode = 'alert-node';
                } else if (c.diff < 0) {
                    variacionText = `▼ La unidad de ${prod.nombre_mostrado} bajó ${c.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(Math.abs(c.diff))} (-${Math.abs(c.porc).toFixed(1)}%) con el proveedor ${c.proveedor}.`;
                    claseVar = 'down';
                    claseNode = 'active-node';
                } else {
                    variacionText = `Mantuvo exactamente el mismo costo unitario con el proveedor ${c.proveedor}.`;
                    claseVar = 'stable';
                    claseNode = 'active-node';
                }
            }

            timelineContainer.innerHTML += `
                <div class="timeline-node ${claseNode}">
                    <div style="font-size: 0.72rem; font-weight: 700; color: var(--gray-400); text-transform: uppercase; display: flex; justify-content: space-between;">
                        <span style="color: var(--teal-dark); font-weight: 800;">${tiempoRelativo} (${formattedDate})</span>
                    </div>
                    <div style="font-size: 0.95rem; font-weight: 800; color: var(--charcoal); margin-top: 0.15rem;">
                        ${c.moneda === 'CRC' ? '₡' : '$'}${formatMoneyValue(c.precio_unitario)}
                        <span style="font-size: 0.75rem; font-weight: 500; color: var(--gray-400); margin-left: 0.25rem;">(${c.cantidad} unidades compradas)</span>
                    </div>
                    <div class="timeline-variation ${claseVar}" style="margin-top: 0.15rem; line-height: 1.3;">
                        ${variacionText}
                    </div>
                </div>
            `;
        });
    }
}

function formatMoneyValue(val) {
    return parseFloat(val).toLocaleString('es-CR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderPreciosEmpty() {
    const tableTbody = document.getElementById('precios-table-tbody');
    const empty = document.getElementById('precios-empty');
    if (tableTbody) tableTbody.innerHTML = '';
    if (empty) empty.classList.remove('hidden');
}

// ==========================================================================
// LÓGICA DE MODAL DE GENERACIÓN DE LINKS DE INVITACIÓN Y PERMISOS
// ==========================================================================
function setupLinksModalLogic() {
    const btnOpen = document.getElementById('btn-open-links-modal');
    const btnClose = document.getElementById('btn-close-links-modal');
    const modal = document.getElementById('modal-generar-links');
    const form = document.getElementById('form-generar-link');
    const resultContainer = document.getElementById('link-result-container');

    if (!btnOpen || !modal) return;

    btnOpen.addEventListener('click', (e) => {
        e.preventDefault();
        modal.classList.remove('hidden');
        if (resultContainer) resultContainer.classList.add('hidden');
    });

    if (btnClose) {
        btnClose.addEventListener('click', () => {
            modal.classList.add('hidden');
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
        }
    });

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btnSubmit = document.getElementById('btn-submit-generar-link');
            
            try {
                btnSubmit.disabled = true;
                btnSubmit.textContent = 'Generando enlaces...';

                const etiqueta = document.getElementById('link-etiqueta').value.trim();
                const maxUsos = parseInt(document.getElementById('link-max-usos').value || 1);

                const permisos = {
                    ver_dashboard: document.getElementById('perm-ver-dashboard')?.checked || false,
                    ver_facturas: document.getElementById('perm-ver-facturas')?.checked || false,
                    descargar_files: document.getElementById('perm-descargar-files')?.checked || false,
                    ver_proveedores: document.getElementById('perm-ver-proveedores')?.checked || false,
                    ver_precios: document.getElementById('perm-ver-precios')?.checked || false,
                    exportar_reportes: document.getElementById('perm-exportar-reportes')?.checked || false,
                    consultar_ia: document.getElementById('perm-consultar-ia')?.checked || false,
                    generar_links: document.getElementById('perm-generar-links')?.checked || false,
                    subir_telegram: document.getElementById('perm-subir-telegram')?.checked || false
                };

                if (!currentEmpresaId) {
                    throw new Error("No se detectó una empresa activa en la sesión.");
                }

                // Invocar función RPC segura en Supabase
                const { data: rpcData, error: rpcError } = await dbClient.rpc('crear_link_personalizado', {
                    p_empresa_id: currentEmpresaId,
                    p_etiqueta: etiqueta,
                    p_permisos: permisos,
                    p_max_usos: maxUsos
                });

                if (rpcError) throw new Error("Error en Supabase: " + rpcError.message);
                if (!rpcData || rpcData.length === 0) throw new Error("No se generó el enlace.");

                const resRow = rpcData[0];

                const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
                const urlWeb = isLocal ? resRow.url_local : resRow.url_onboarding;
                const urlTelegram = resRow.telegram_link;

                document.getElementById('res-link-web').value = urlWeb;
                document.getElementById('res-link-telegram').value = urlTelegram;

                resultContainer.classList.remove('hidden');

            } catch (err) {
                console.error("Error generando enlace:", err);
                alert("Ocurrió un error al crear el enlace: " + (err.message || err));
            } finally {
                btnSubmit.disabled = false;
                btnSubmit.textContent = '🚀 Generar Enlace Único';
            }
        });
    }

    // Botones de Copiar
    function setupCopyBtn(btnId, inputId) {
        const btn = document.getElementById(btnId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            btn.addEventListener('click', () => {
                input.select();
                navigator.clipboard.writeText(input.value);
                const originalText = btn.textContent;
                btn.textContent = '✓ Copiado';
                setTimeout(() => btn.textContent = originalText, 2500);
            });
        }
    }

    setupCopyBtn('btn-copy-web-link', 'res-link-web');
    setupCopyBtn('btn-copy-telegram-link', 'res-link-telegram');
}

