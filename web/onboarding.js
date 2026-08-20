/* ==========================================================================
   NAUTILUS ONBOARDING - LOGIC & TELEGRAM DEEP LINKING
   ========================================================================== */

const SUPABASE_URL = 'https://itktqibbuqmqpvonnwsw.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml0a3RxaWJidXFtcXB2b25ud3N3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NDQ4MTksImV4cCI6MjA5OTIyMDgxOX0.33XzASB838k_RMdS1FncOmjRgVeypjUSQ3ZSX4-ex1Q';
const { createClient } = window.supabase;
const dbClient = createClient(SUPABASE_URL, SUPABASE_KEY);

const BOT_USERNAME = 'Nautilus_Facturas_bot';

document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    
    const stepPassword = document.getElementById('step-password');
    const stepTelegram = document.getElementById('step-telegram');
    const stepDrivers = document.getElementById('step-drivers');
    const telegramLink = document.getElementById('telegram-link');
    const driverInviteUrl = document.getElementById('driver-invite-url');

    let currentEmpresaId = null;
    let currentUserId = null;
    let tokenEmail = null;

    // Si no se pasó token en la URL, alertar al usuario
    const passwordError = document.getElementById('password-error');
    if (!token) {
        passwordError.textContent = '⚠️ Enlace incompleto: falta el parámetro ?token= en la URL.';
    }

    // Buscar correo del token mediante función segura de Supabase
    if (token) {
        try {
            const { data: rpcData, error: rpcErr } = await dbClient.rpc('validar_token_onboarding', { p_token: token });
            if (rpcData && rpcData.length > 0) {
                tokenEmail = rpcData[0].email;
                currentEmpresaId = rpcData[0].empresa_id;
            } else if (rpcErr) {
                console.warn('RPC token error (¿ejecutaste el script SQL 01_onboarding_schema.sql en Supabase?):', rpcErr);
            }
        } catch (errToken) {
            console.warn('Error consultando token:', errToken);
        }
    }

    // Si se pasa un token de onboarding, cerramos cualquier sesión vieja para asegurar la experiencia de Paso 1
    if (token) {
        try {
            await dbClient.auth.signOut();
        } catch (eSignOut) {
            console.warn('SignOut previo:', eSignOut);
        }
    } else {
        // Solo si NO hay token, verificar si ya está logueado en la app
        const { data: { session } } = await dbClient.auth.getSession();
        if (session) {
            currentUserId = session.user.id;
            stepPassword.classList.add('hidden');
            stepTelegram.classList.remove('hidden');
            await setupTelegramStep(token || session.user.id);
        }
    }

    // Toggle de Visibilidad de Contraseña (Ojito)
    function setupPasswordToggle(buttonId, inputId) {
        const btn = document.getElementById(buttonId);
        const input = document.getElementById(inputId);
        if (btn && input) {
            btn.addEventListener('click', () => {
                const isPassword = input.type === 'password';
                input.type = isPassword ? 'text' : 'password';
                btn.innerHTML = isPassword ? '<i data-lucide="eye"></i>' : '<i data-lucide="eye-off"></i>';
                if (window.lucide) window.lucide.createIcons();
            });
        }
    }

    setupPasswordToggle('toggle-new-password', 'new-password');
    setupPasswordToggle('toggle-confirm-password', 'confirm-password');

    // Manejador para guardar contraseña inicial (Paso 1)
    const formPassword = document.getElementById('form-password');
    formPassword.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newPassword = document.getElementById('new-password').value;
        const confirmPassword = document.getElementById('confirm-password').value;
        const btnSubmit = formPassword.querySelector('button[type="submit"]');

        passwordError.textContent = '';

        if (!token) {
            passwordError.textContent = 'No se puede procesar: abre esta página usando la URL de invitación recibida con su ?token=...';
            return;
        }

        if (newPassword !== confirmPassword) {
            passwordError.textContent = 'Las contraseñas no coinciden';
            return;
        }
        if (newPassword.length < 8) {
            passwordError.textContent = 'La contraseña debe tener al menos 8 caracteres';
            return;
        }

        try {
            btnSubmit.disabled = true;
            btnSubmit.textContent = 'Configurando tu cuenta...';

            // 1. Validar token y obtener información de la invitación
            const { data: valResult, error: valError } = await dbClient.rpc('validar_token_onboarding', { p_token: token });
            if (valError) throw new Error('Error validando invitación: ' + valError.message);
            if (!valResult || valResult.length === 0) throw new Error('Token no válido o expirado');

            const emailCliente = valResult[0].email;
            const empresaId = valResult[0].empresa_id;

            // 2. Registrar en Supabase Auth (crea la cuenta o recupera el estado)
            let authUserId = null;
            const { data: signUpData, error: signUpErr } = await dbClient.auth.signUp({
                email: emailCliente,
                password: newPassword
            });

            if (signUpData?.user) {
                authUserId = signUpData.user.id;
            }

            // Si falla por 'already registered' o 'rate limit', continuamos a SQL para auto-confirmar y vincular
            if (signUpErr && !signUpErr.message.includes('already registered') && !signUpErr.message.includes('rate limit')) {
                throw new Error(signUpErr.message);
            }

            // 3. Auto-confirmar email, sincronizar contraseña y vincular empresa en SQL de forma atómica
            const { data: rpcResult, error: rpcError } = await dbClient.rpc('completar_onboarding', {
                p_token: token,
                p_nueva_password: newPassword
            });

            if (rpcError) throw new Error('Error finalizando registro: ' + rpcError.message);
            if (!rpcResult?.success) throw new Error(rpcResult?.error || 'No se pudo completar el onboarding');

            // 4. Iniciar sesión inmediatamente (ya con correo verificado y perfil creado)
            const { data: signInData, error: signInErr } = await dbClient.auth.signInWithPassword({
                email: emailCliente,
                password: newPassword
            });

            if (signInErr) throw new Error('Cuenta creada, pero error al entrar: ' + (signInErr.message || JSON.stringify(signInErr)));

            if (signInData?.user) {
                authUserId = signInData.user.id;
            }

            // 5. Respaldo de vinculación en public.usuarios
            if (authUserId && empresaId) {
                await dbClient.from('usuarios').upsert({
                    id: authUserId,
                    empresa_id: empresaId,
                    email: emailCliente,
                    nombre: emailCliente.split('@')[0],
                    rol: 'DUEÑO',
                    estado: 'ACTIVO'
                });
            }

            // ✅ Avanzar al Paso 2
            stepPassword.classList.add('hidden');
            stepTelegram.classList.remove('hidden');
            await setupTelegramStep(token);

        } catch (err) {
            console.error('Error en onboarding:', err);
            passwordError.textContent = err.message || 'Error inesperado';
            btnSubmit.disabled = false;
            btnSubmit.textContent = 'Guardar Contraseña y Continuar';
        }
    });

    // Configurar Paso 2: Generación de Deep Link para Telegram
    async function setupTelegramStep(tokenOrId) {
        const uniqueToken = tokenOrId || ('DUENO_' + Math.random().toString(36).substring(2, 10));
        const deepLink = `https://t.me/${BOT_USERNAME}?start=${uniqueToken}`;
        telegramLink.href = deepLink;

        // Intentar obtener la empresa del usuario
        try {
            const { data: userRow } = await dbClient
                .from('usuarios')
                .select('empresa_id')
                .limit(1)
                .single();

            if (userRow && userRow.empresa_id) {
                currentEmpresaId = userRow.empresa_id;
                driverInviteUrl.value = `https://t.me/${BOT_USERNAME}?start=CHOFER_${currentEmpresaId}`;
            } else {
                driverInviteUrl.value = `https://t.me/${BOT_USERNAME}?start=CHOFER_DEMO`;
            }
        } catch (e) {
            driverInviteUrl.value = `https://t.me/${BOT_USERNAME}?start=CHOFER_DEMO`;
        }
    }

    // Avanzar de Paso 2 a Paso 3
    document.getElementById('btn-next-step3').addEventListener('click', () => {
        stepTelegram.classList.add('hidden');
        stepDrivers.classList.remove('hidden');
    });

    // Copiar Enlace de Choferes
    const btnCopyDriverLink = document.getElementById('btn-copy-driver-link');
    const copyStatus = document.getElementById('copy-status');
    btnCopyDriverLink.addEventListener('click', () => {
        driverInviteUrl.select();
        navigator.clipboard.writeText(driverInviteUrl.value);
        copyStatus.classList.remove('hidden');
        setTimeout(() => copyStatus.classList.add('hidden'), 3000);
    });

    // Ir al Dashboard Principal
    document.getElementById('btn-go-dashboard').addEventListener('click', () => {
        window.location.href = 'index.html';
    });
});
