import os
import json
import asyncio
import urllib.request
import urllib.error
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    CallbackQueryHandler,
    MessageHandler,
    filters
)
from bot import (
    start,
    activar,
    handle_callback,
    process_invoice,
    handle_text_response
)

# Obtener token de Telegram desde variables de entorno
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")

# Aplicación global del bot (Singleton para reutilizar conexiones en ejecuciones calientes de Lambda)
application = None

def get_application():
    global application
    if application is None:
        # Construir la aplicación usando el token
        application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
        
        # Registrar los mismos manejadores de eventos que definimos en bot.py
        application.add_handler(CommandHandler("start", start))
        application.add_handler(CommandHandler("activar", activar))
        application.add_handler(CallbackQueryHandler(handle_callback))
        
        # Manejar imágenes y documentos (facturas)
        application.add_handler(MessageHandler(filters.PHOTO | filters.Document.ALL, process_invoice))
        
        # Manejar texto para ediciones de montos/fechas
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text_response))
        
    return application

# ==========================================================================
# SEGURIDAD — Verificación de Token de Supabase para peticiones web
# ==========================================================================

def verify_supabase_token(token: str) -> bool:
    """
    Verifica un token de sesión de Supabase Auth llamando a su API.
    Acepta el token raw (sin prefijo Bearer).
    Devuelve True si el token es válido, False si no lo es.
    Si las variables de entorno no están configuradas, deja pasar (fail-open).
    """
    if not token:
        return False
    supabase_url = os.getenv("SUPABASE_URL", "")
    supabase_key = os.getenv("SUPABASE_KEY", "")
    if not supabase_url or not supabase_key:
        print("[AUTH] SUPABASE_URL o SUPABASE_KEY no configurados en Lambda. Saltando verificación.")
        return True  # Fail-open para no bloquear si faltan las vars
    try:
        req = urllib.request.Request(
            f"{supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": supabase_key
            },
            method="GET"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        print(f"[AUTH] Token inválido o expirado. Código: {e.code}")
        return False
    except Exception as e:
        print(f"[AUTH] Error verificando token de Supabase: {e}")
        return False  # Fail-closed ante errores inesperados

# Estado de inicialización del bot en Lambda
is_initialized = False

async def process_event(event):
    global is_initialized
    try:
        app = get_application()
        
        # Inicializar y arrancar la aplicación si es la primera invocación de la Lambda
        if not is_initialized:
            await app.initialize()
            await app.start()
            is_initialized = True
        
        # Parsear el evento JSON de forma robusta
        body_json = {}
        if isinstance(event, dict):
            if "update_id" in event:
                body_json = event
            else:
                body_str = event.get("body", "{}")
                if body_str:
                    body_json = json.loads(body_str)
        
        # Reconstruir el objeto Update oficial de Telegram
        update = Update.de_json(body_json, app.bot)
        
        # Procesar la actualización a través de los manejadores registrados
        await app.process_update(update)
        
        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"status": "success"})
        }
    except Exception as e:
        print(f"[ERROR Lambda Webhook] Error al procesar update: {e}")
        return {
            "statusCode": 500,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps({"error": str(e)})
        }

def webhook(event, context):
    try:
        # Obtener el método HTTP de forma robusta (compatible con REST API v1 y HTTP API v2)
        http_method = event.get("httpMethod")
        if not http_method and isinstance(event, dict) and "requestContext" in event:
            http_method = event.get("requestContext", {}).get("http", {}).get("method")

        # Manejo de preflight OPTIONS para navegadores web
        if http_method == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Allow-Methods": "POST,OPTIONS"
                },
                "body": ""
            }

        # Parsear el payload JSON de forma robusta (compatible con integración clásica y proxy)
        body_json = {}
        if isinstance(event, dict):
            if "question" in event or "update_id" in event:
                body_json = event
            else:
                body_str = event.get("body", "{}")
                if body_str:
                    try:
                        body_json = json.loads(body_str)
                    except Exception:
                        body_json = {}

        # Si la petición viene del chat del Dashboard (contiene la clave 'question')
        if "question" in body_json:
            # --- Verificación de autenticación (token en el body) ---
            auth_token = body_json.get("auth_token", "")
            if not verify_supabase_token(auth_token):
                return {
                    "statusCode": 401,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    },
                    "body": json.dumps({"error": "No autorizado. Tu sesión es inválida o expiró. Recarga la página e inicia sesión de nuevo."})
                }
            # --- Fin verificación ---
            try:
                from bot import ejecutar_analisis_conversacional

                question = body_json.get("question", "")
                empresa_id = body_json.get("empresa_id", "")
                nombre_empresa = body_json.get("nombre_empresa", "Mi Empresa")
                history = body_json.get("history", [])

                if not question or not empresa_id:
                    return {
                        "statusCode": 400,
                        "headers": {
                            "Access-Control-Allow-Origin": "*",
                            "Content-Type": "application/json"
                        },
                        "body": json.dumps({"error": "Faltan parámetros obligatorios: 'question' y 'empresa_id'."})
                    }

                # Procesar consulta interactiva de Gemini
                respuesta = ejecutar_analisis_conversacional(
                    user_question=question,
                    empresa_id=empresa_id,
                    nombre_empresa=nombre_empresa,
                    history=history
                )

                return {
                    "statusCode": 200,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Headers": "Content-Type,Authorization",
                        "Access-Control-Allow-Methods": "POST,OPTIONS"
                    },
                    "body": json.dumps({
                        "response": respuesta
                    })
                }
            except Exception as web_err:
                print(f"[ERROR Lambda Analista Web] Error: {web_err}")
                return {
                    "statusCode": 500,
                    "headers": {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    },
                    "body": json.dumps({"error": str(web_err)})
                }

    except Exception as e:
        print(f"[Webhook Híbrido] Error al procesar JSON inicial: {e}")

    # Si es una actualización de Telegram, ejecutar el flujo original asíncrono
    loop = asyncio.get_event_loop()
    return loop.run_until_complete(process_event(event))

def ingesta_correo(event, context):
    from ingesta_correo import ejecutar_ingesta_general
    ejecutar_ingesta_general()
    return {
        "statusCode": 200,
        "body": json.dumps("Ingesta de correo completada con éxito.")
    }

def analista_web(event, context):
    try:
        # Manejo de preflight OPTIONS para navegadores web
        if event.get("httpMethod") == "OPTIONS":
            return {
                "statusCode": 200,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type,Authorization",
                    "Access-Control-Allow-Methods": "POST,OPTIONS"
                },
                "body": ""
            }

        # Importación tardía para optimizar tiempos de arranque frío
        from bot import ejecutar_analisis_conversacional

        body_str = event.get("body", "{}")
        body_json = json.loads(body_str)

        question = body_json.get("question", "")
        empresa_id = body_json.get("empresa_id", "")
        nombre_empresa = body_json.get("nombre_empresa", "Mi Empresa")
        history = body_json.get("history", [])

        if not question or not empresa_id:
            return {
                "statusCode": 400,
                "headers": {
                    "Access-Control-Allow-Origin": "*",
                    "Content-Type": "application/json"
                },
                "body": json.dumps({"error": "Faltan parámetros obligatorios: 'question' y 'empresa_id'."})
            }

        # Ejecutar análisis interactivo de Gemini + Supabase SQL
        respuesta = ejecutar_analisis_conversacional(
            user_question=question,
            empresa_id=empresa_id,
            nombre_empresa=nombre_empresa,
            history=history
        )

        return {
            "statusCode": 200,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type,Authorization",
                "Access-Control-Allow-Methods": "POST,OPTIONS"
            },
            "body": json.dumps({
                "response": respuesta
            })
        }

    except Exception as e:
        print(f"[ERROR Lambda Analista Web] Error: {e}")
        return {
            "statusCode": 500,
            "headers": {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            "body": json.dumps({"error": str(e)})
        }
