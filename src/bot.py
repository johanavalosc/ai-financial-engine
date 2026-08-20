import os
import sys

os.environ["PYTHONUTF8"] = "1"
os.environ["PYTHONIOENCODING"] = "utf-8"
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except Exception:
        pass

import re
import logging
import psycopg2
import json
import urllib.request
import urllib.error
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
env_file = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(dotenv_path=env_file)
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")


def upload_file_to_s3(local_file_path, s3_key):
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_KEY")
    if not (supabase_url and supabase_key):
        logging.error("[Supabase Storage] Faltan variables de entorno SUPABASE_URL o SUPABASE_KEY")
        return None
        
    url = f"{supabase_url}/storage/v1/object/facturas/{s3_key}"
    
    try:
        with open(local_file_path, "rb") as f:
            file_data = f.read()
            
        headers = {
            "Authorization": f"Bearer {supabase_key}",
            "Content-Type": "application/pdf" if s3_key.lower().endswith(".pdf") else "image/jpeg"
        }
        
        req = urllib.request.Request(url, data=file_data, headers=headers, method="POST")
        with urllib.request.urlopen(req) as response:
            res_code = response.getcode()
            if res_code in (200, 201):
                logging.info(f"[Supabase Storage] Archivo subido con éxito: {s3_key}")
                # Guardamos la clave relativa del archivo en la base de datos
                return s3_key
            else:
                logging.error(f"[Supabase Storage] Error en la subida. Código: {res_code}")
                return None
    except Exception as e:
        logging.error(f"[Supabase Storage] Error al subir a Supabase: {e}")
        return None
from pydantic import BaseModel, Field
from typing import List, Optional
from google import genai
from google.genai import types
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    CallbackQueryHandler,
    filters,
    ContextTypes
)

# Configurar Logging
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Cargar variables de entorno
load_dotenv()

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# Asegurar que existe directorio temporal (usar /tmp en AWS Lambda)
TEMP_DIR = "/tmp" if os.name != "nt" else os.path.join(os.path.dirname(__file__), "temp")
if os.name == "nt":
    os.makedirs(TEMP_DIR, exist_ok=True)

# Inicializar cliente de Gemini
client = genai.Client(api_key=GEMINI_API_KEY)

# Esquema de la base de datos para consultas analíticas de Gemini
DB_SCHEMA_PROMPT = """
Eres un asistente analista experto en finanzas y base de datos PostgreSQL para la empresa "{nombre_empresa}" (ID: {empresa_id}).
Tu tarea es traducir las preguntas del usuario a consultas SQL de tipo SELECT, ejecutarlas usando la herramienta proveída, y luego responder conversacionalmente.

Tienes acceso a las siguientes tablas de Supabase:

1. Tabla `facturas`:
   - `id` (uuid, PRIMARY KEY)
   - `empresa_id` (uuid, FOREIGN KEY): ID de la empresa.
   - `proveedor` (varchar)
   - `numero_factura` (varchar)
   - `fecha_emision` (date): Fecha de la factura (AAAA-MM-DD).
   - `fecha_vencimiento` (date): Fecha de vencimiento de la factura (AAAA-MM-DD).
   - `subtotal` (numeric)
   - `impuestos` (numeric)
   - `total` (numeric)
   - `monto_pagado` (numeric): Monto ya abonado o pagado de la factura (por defecto es 0).
   - `moneda` (varchar): Moneda de la factura ('CRC' para colones o 'USD' para dólares).
   - `estado` (varchar): Estado de la factura ('PENDIENTE' o 'PAGADA').
   - `url_s3` (varchar): Ruta del PDF.

2. Tabla `lineas_factura`:
   - `id` (uuid, PRIMARY KEY)
   - `factura_id` (uuid, FOREIGN KEY a facturas)
   - `descripcion` (varchar): Nombre o descripción detallada del artículo comprado.
   - `cantidad` (integer)
   - `precio_unitario` (numeric)
   - `total_linea` (numeric): Total de la línea (cantidad * precio_unitario).

Reglas semánticas críticas para traducir a SQL:
- "Facturas pendientes", "adeudadas" o "que debemos" son aquellas que tienen `estado = 'PENDIENTE'` o `estado IS NULL`. Para estas facturas, su saldo pendiente o deuda real es `total - COALESCE(monto_pagado, 0)`.
- "Facturas canceladas", "saldadas" o "pagadas" son aquellas que tienen `estado = 'PAGADA'`. Para estas facturas, su saldo deudor o pendiente es incondicionalmente 0.
- "El total por pagar", "la suma adeudada", "lo que debemos en total" o "saldo pendiente total" se calcula sumando la deuda real de todas las facturas que no estén canceladas: `SUM(total - COALESCE(monto_pagado, 0)) FROM facturas WHERE (estado != 'PAGADA' OR estado IS NULL)`.
- "Lo que debemos menos" o "menor deuda" significa buscar las facturas pendientes ordenadas por su deuda restante (`total - COALESCE(monto_pagado, 0)`) de forma ascendente: `ORDER BY (total - COALESCE(monto_pagado, 0)) ASC LIMIT 1`.
- "Lo que debemos más" o "mayor deuda" significa buscar las facturas pendientes ordenadas por su deuda restante (`total - COALESCE(monto_pagado, 0)`) de forma descendente: `ORDER BY (total - COALESCE(monto_pagado, 0)) DESC LIMIT 1`.
- Manejo Estricto de Moneda y Divisas ('CRC' vs 'USD'): NUNCA compares ni mezcles montos en Colones ('CRC') y Dólares ('USD') dentro de un mismo `ORDER BY total` o agregación sin filtrar. Si el usuario pide "la factura con menos costo", "más cara", "mayor monto" o similar SIN especificar la divisa, debes consultar la correspondiente separando por divisa o especificar explícitamente en la respuesta la moneda de cada factura devuelta, distinguiendo claramente Colones ('CRC') de Dólares ('USD'). Si el usuario especifica la divisa (ej. "en dólares" o "en colones"), filtra de forma estricta usando `WHERE moneda = 'USD'` o `WHERE moneda = 'CRC'`.
- Si el usuario te hace una pregunta de seguimiento referida a "esa factura", "ese proveedor" o "ese monto" que mencionaste en el mensaje anterior del historial, extrae los datos de la factura que se discutió y haz la consulta SQL directa usando su número de factura o ID.

Contexto de la Interfaz Web:
- El usuario está navegando actualmente en la pestaña "{pestana_actual}" de la plataforma (valores posibles: 'dashboard', 'facturas', 'proveedores', 'precios'). Si el usuario dice "esta vista", "lo que veo aquí" o "en esta pantalla", haz referencia a esa sección.

Acciones de Interfaz (UI Actions):
- Al consultar la tabla facturas, incluye SIEMPRE la columna `id` (para que la interfaz web pueda resaltar automáticamente las facturas devueltas en pantalla de forma instantánea). Si el usuario pide mostrar, filtrar o señalar facturas, la consulta SQL con `id` activará el marcado en pantalla. Si lo consideras necesario, también puedes invocar la herramienta `destacar_facturas_en_pantalla`.

Restricciones Críticas:
- Solo tienes permitido consultar datos de la empresa actual (empresa_id = '{empresa_id}'). Todas tus consultas SQL DEBEN filtrar de forma estricta por `empresa_id = '{empresa_id}'`.
- NUNCA generes comandos de modificación o escritura (INSERT, UPDATE, DELETE, etc.). Solo consultas de selección (SELECT).
- En tus consultas sobre textos de productos (como mangueras, tornillos, etc.), usa siempre comparaciones insensibles a mayúsculas/minúsculas como `ILIKE '%termino%'` para tolerar typos y variaciones de capitalización.
- Usa funciones estándar de PostgreSQL para agrupaciones por fecha o sumas (ej. `SUM`, `AVG`, `EXTRACT`, etc.).

Formato y Estándar de Respuesta (Copiloto Financiero Brillante):
- Eres el Copiloto Inteligente de Nautilus. Tu tono es conciso, profesional, seguro y analítico (estilo JARVIS financiero).
- NUNCA devuelvas respuestas vacías, genéricas ni te limites a invocar las herramientas visuales.
- SIEMPRE que respondas tras consultar la base de datos o invocar `destacar_facturas_en_pantalla`, DEBES redactar una síntesis ejecutiva completa en Markdown estructurado que:
  1. Desglose los hallazgos distinguiendo explícitamente Colones (₡ CRC) y Dólares ($ USD).
  2. Presente los datos ordenados en listas o tarjetas limpias con número de factura, proveedor, monto formateado con moneda y fecha de vencimiento.
  3. Incluya una observación financiera o recomendación de valor al final (ej. estado de vencimiento o impacto en caja).
"""

# === Modelos de Datos para Estructuración con Gemini ===
class ProductoItem(BaseModel):
    descripcion: str = Field(description="Nombre o descripción del producto o servicio comprado")
    cantidad: int = Field(description="Cantidad de unidades")
    precio_unitario: float = Field(description="Precio unitario del producto/servicio")
    total_item: float = Field(description="Total cobrado por esta línea (cantidad * precio_unitario)")

class FacturaExtraida(BaseModel):
    calidad: str = Field(description="Indica si el documento es una factura legible o comprobante procesable. Debe ser estrictamente 'LEGIBLE' o 'ILEGIBLE' (si está borrosa, cortada, no tiene datos, o no es una factura/comprobante).")
    tipo_documento: Optional[str] = Field('FACTURA', description="Tipo de documento detectado: 'FACTURA' (factura de compra/gasto) o 'COMPROBANTE_PAGO' (si es un comprobante de transferencia bancaria, SINPE Móvil, recibo de pago o voucher de abono/cancelación).")
    proveedor: Optional[str] = Field(None, description="Nombre del proveedor o emisor de la factura o destinatario de la transferencia.")
    numero_factura: Optional[str] = Field(None, description="Número de factura o comprobante/referencia bancaria.")
    fecha_emision: Optional[str] = Field(None, description="Fecha de emisión o fecha de transferencia en formato YYYY-MM-DD.")
    fecha_vencimiento: Optional[str] = Field(None, description="Fecha de vencimiento en formato YYYY-MM-DD. Búscala directamente en el documento. Si no está explícita pero hay un plazo de pago de crédito (ej. Crédito 15 días, Crédito 30 días, etc.), calcúlala sumándola a la fecha de emisión.")
    subtotal: Optional[float] = Field(None, description="Subtotal de la factura (antes de impuestos).")
    impuestos: Optional[float] = Field(None, description="Total de impuestos cobrados (ej. IVA).")
    total: Optional[float] = Field(None, description="Total final facturado o total transferido en el comprobante.")
    moneda: Optional[str] = Field('CRC', description="Moneda de la factura o transferencia. Debe ser estrictamente 'CRC' (para colones) o 'USD' (para dólares).")
    estado: Optional[str] = Field('PENDIENTE', description="Clasificación del estado de pago: 'PAGADA' (si indica que fue cancelada, pagada, al contado, transferencia realizada, o saldo pendiente es 0) o 'PENDIENTE' (si dice pendiente de pago, crédito, o saldo por pagar).")
    monto_pagado: Optional[float] = Field(0.0, description="Monto efectivamente pagado, transferido o abonado.")
    productos: Optional[List[ProductoItem]] = Field(None, description="Desglose detallado de los productos o servicios cobrados.")

# === Funciones de Base de Datos ===
def get_db_connection():
    db_url = os.getenv("DATABASE_URL")
    if db_url:
        return psycopg2.connect(db_url)
    return psycopg2.connect(
        host=os.getenv("DB_HOST", "localhost"),
        port=os.getenv("DB_PORT", "5432"),
        database=os.getenv("DB_NAME", "facturas_db"),
        user=os.getenv("DB_USER", "app_user"),
        password=os.getenv("DB_PASSWORD", "app_secure_password")
    )

_shared_db_conn = None

def get_shared_db_connection():
    global _shared_db_conn
    try:
        if _shared_db_conn and not _shared_db_conn.closed:
            with _shared_db_conn.cursor() as cur:
                cur.execute("SELECT 1;")
            return _shared_db_conn
    except Exception:
        if _shared_db_conn:
            try:
                _shared_db_conn.close()
            except Exception:
                pass
        _shared_db_conn = None

    _shared_db_conn = get_db_connection()
    _shared_db_conn.autocommit = True
    return _shared_db_conn


def get_empresa_by_chat_id(chat_id: str):
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, nombre FROM empresas WHERE telegram_chat_id = %s AND estado = 'ACTIVO';", (chat_id,))
    res = cur.fetchone()
    cur.close()
    conn.close()
    return res  # Retorna (id, nombre) o None

def associate_chat_with_empresa(codigo_activacion: str, chat_id: str):
    conn = get_db_connection()
    cur = conn.cursor()
    
    # Buscar si existe el código de activación
    cur.execute("SELECT id, nombre FROM empresas WHERE codigo_activacion = %s;", (codigo_activacion,))
    empresa = cur.fetchone()
    
    if empresa:
        # Vincular el chat_id a la empresa
        cur.execute(
            "UPDATE empresas SET telegram_chat_id = %s WHERE codigo_activacion = %s;",
            (chat_id, codigo_activacion)
        )
        conn.commit()
        nombre = empresa[1]
    else:
        nombre = None
        
    cur.close()
    conn.close()
    return nombre

def save_factura_db(empresa_id: str, data: dict):
    conn = get_db_connection()
    cur = conn.cursor()
    try:
        # Habilitar RLS en la sesión estableciendo el ID del Tenant actual
        cur.execute(f"SET app.current_empresa_id = '{empresa_id}';")
        
        tipo_doc = data.get("tipo_documento", "FACTURA")
        monto_pago = float(data.get("monto_pagado") or data.get("total") or 0.0)
        num_factura = str(data.get("numero_factura", "")).strip()
        proveedor = str(data.get("proveedor", "")).strip()

        # Si es un comprobante de pago o transferencia, verificar si existe una factura pendiente que coincida
        if tipo_doc == "COMPROBANTE_PAGO" or data.get("estado") == "PAGADA":
            query_match = """
                SELECT id, total, COALESCE(monto_pagado, 0) as pagado 
                FROM facturas 
                WHERE empresa_id = %s AND estado = 'PENDIENTE'
                AND (
                    (numero_factura = %s AND numero_factura != 'S/N' AND numero_factura != '')
                    OR (proveedor ILIKE %s AND total = %s)
                )
                ORDER BY fecha_emision DESC LIMIT 1;
            """
            cur.execute(query_match, (empresa_id, num_factura, f"%{proveedor}%", monto_pago))
            match_row = cur.fetchone()

            if match_row:
                fid, total_fac, pagado_prev = match_row
                nuevo_pagado = float(pagado_prev) + monto_pago
                nuevo_estado = 'PAGADA' if nuevo_pagado >= float(total_fac) else 'PENDIENTE'
                
                cur.execute(
                    """
                    UPDATE facturas 
                    SET monto_pagado = %s, estado = %s, url_s3 = COALESCE(%s, url_s3)
                    WHERE id = %s;
                    """,
                    (nuevo_pagado, nuevo_estado, data.get("url_s3"), fid)
                )
                conn.commit()
                return True

        # Inserción estándar si es una factura nueva
        cur.execute(
            """
            INSERT INTO facturas (empresa_id, proveedor, numero_factura, fecha_emision, fecha_vencimiento, subtotal, impuestos, total, moneda, estado, url_s3, monto_pagado)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id;
            """,
            (
                empresa_id,
                data.get("proveedor", "Desconocido"),
                data.get("numero_factura", "S/N"),
                data.get("fecha_emision"),
                data.get("fecha_vencimiento"),
                data.get("subtotal", 0.0),
                data.get("impuestos", 0.0),
                data.get("total", 0.0),
                data.get("moneda", "CRC"),
                data.get("estado", "PENDIENTE"),
                data.get("url_s3"),
                data.get("monto_pagado", 0.0)
            )
        )
        factura_id = cur.fetchone()[0]
        
        # Insertar líneas de detalle si existen
        productos = data.get("productos", [])
        if productos:
            for prod in productos:
                cur.execute(
                    """
                    INSERT INTO lineas_factura (factura_id, descripcion, cantidad, precio_unitario, total_item)
                    VALUES (%s, %s, %s, %s, %s);
                    """,
                    (
                        factura_id,
                        prod.get("descripcion", "Artículo"),
                        prod.get("cantidad", 1),
                        prod.get("precio_unitario", 0.0),
                        prod.get("total_item", 0.0)
                    )
                )
        
        conn.commit()
        success = True
    except Exception as e:
        conn.rollback()
        logger.error(f"Error al guardar en base de datos: {e}")
        success = False
    finally:
        cur.close()
        conn.close()
    return success

# === Handlers de Telegram ===

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    empresa = get_empresa_by_chat_id(chat_id)
    
    if empresa:
        empresa_id, nombre_empresa = empresa
        await update.message.reply_text(
            f"¡Hola! Este chat está registrado y autorizado para **{nombre_empresa}**.\n\n"
            "Puedes enviarme fotos o documentos PDF de facturas y los procesaré de forma inmediata."
        )
    else:
        await update.message.reply_text(
            "¡Hola de parte de Nautilus!\n\n"
            "Este chat grupal no está registrado. Para vincularlo a tu empresa, por favor escribe el comando de activación:\n"
            "`/activar TU_CODIGO_DE_ACTIVACION`"
        )

async def activar(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    
    if not context.args:
        await update.message.reply_text(
            "Por favor, proporciona el código de activación de tu empresa. Ejemplo:\n"
            "`/activar ACT-ALFA-900`"
        )
        return
        
    codigo = context.args[0].strip()
    nombre_empresa = associate_chat_with_empresa(codigo, chat_id)
    
    if nombre_empresa:
        await update.message.reply_text(
            f"¡Enlace completado con éxito!\n\n"
            f"Este chat grupal de Telegram ha sido asociado a **{nombre_empresa}**.\n"
            "A partir de este momento, ya pueden empezar a subir facturas de compras."
        )
    else:
        await update.message.reply_text(
            "❌ Código de activación no válido o ya utilizado.\n"
            "Por favor, verifica el código de tu contrato o comunícate con soporte."
        )

def get_confirmation_keyboard():
    keyboard = [
        [
            InlineKeyboardButton("✅ Sí, Guardar", callback_data="confirm_save"),
        ],
        [
            InlineKeyboardButton("📝 Editar Total", callback_data="edit_total"),
            InlineKeyboardButton("📅 Editar Fecha", callback_data="edit_fecha")
        ]
    ]
    return InlineKeyboardMarkup(keyboard)

def format_summary_message(data: dict):
    # Detectar símbolo de moneda dinámico
    moneda = data.get("moneda", "CRC")
    simbolo = "₡" if moneda == "CRC" else "$"

    # Formatear el desglose de productos si existe
    productos_text = ""
    productos = data.get("productos", [])
    if productos:
        productos_text = "\n📦 **Desglose de Artículos:**\n"
        for idx, item in enumerate(productos, 1):
            productos_text += f"  {idx}. {item.get('descripcion')} (x{item.get('cantidad')}) - {simbolo}{item.get('total_item'):.2f}\n"

    msg = (
        "📄 **FACTURA DETECTADA**\n\n"
        f"• **Proveedor:** {data.get('proveedor', 'No detectado')}\n"
        f"• **Nro. Factura:** {data.get('numero_factura', 'No detectado')}\n"
        f"• **Fecha de Emisión:** {data.get('fecha_emision', 'No detectada')}\n"
        f"• **Subtotal:** {simbolo}{data.get('subtotal', 0.0):.2f}\n"
        f"• **Impuestos:** {simbolo}{data.get('impuestos', 0.0):.2f}\n"
        f"• **Monto Total:** {simbolo}{data.get('total', 0.0):.2f} {moneda}\n"
        f"{productos_text}\n"
        "¿Confirmas que los datos de arriba son correctos?"
    )
    return msg

async def process_invoice(update: Update, context: ContextTypes.DEFAULT_TYPE):
    chat_id = str(update.effective_chat.id)
    empresa = get_empresa_by_chat_id(chat_id)
    
    if not empresa:
        await update.message.reply_text(
            "❌ Este chat no está vinculado a ninguna empresa registrada.\n"
            "Usa `/activar <código>` para empezar."
        )
        return
        
    empresa_id, nombre_empresa = empresa
    
    # Determinar si es foto o documento (PDF)
    is_photo = bool(update.message.photo)
    is_doc = bool(update.message.document)
    
    if not (is_photo or is_doc):
        return
        
    status_msg = await update.message.reply_text("📥 Recibí el archivo. Analizándolo con Gemini...")
    
    try:
        # Descargar el archivo
        if is_photo:
            # Obtener la foto de mayor resolución
            file_id = update.message.photo[-1].file_id
            ext = ".jpg"
            mime_type = "image/jpeg"
        else:
            file_id = update.message.document.file_id
            ext = os.path.splitext(update.message.document.file_name)[1]
            # Forzar mime_type correcto — Telegram a veces reporta application/octet-stream para PDFs
            raw_mime = update.message.document.mime_type
            if ext.lower() == ".pdf":
                mime_type = "application/pdf"
            elif raw_mime and raw_mime != "application/octet-stream":
                mime_type = raw_mime
            else:
                mime_type = "application/pdf"  # fallback seguro
            
        new_file = await context.bot.get_file(file_id)
        temp_file_name = f"{file_id}{ext}"
        temp_file_path = os.path.join(TEMP_DIR, temp_file_name)
        await new_file.download_to_drive(temp_file_path)
        
        # Subir archivo a S3 en la ruta tenants/{empresa_id}/landing/
        s3_key = f"tenants/{empresa_id}/landing/{temp_file_name}"
        s3_url = upload_file_to_s3(temp_file_path, s3_key)
        
        # Leer los bytes del archivo para enviarlo a Gemini
        with open(temp_file_path, "rb") as f:
            file_bytes = f.read()
            
        # Llamar a Gemini usando el SDK oficial
        response = client.models.generate_content(
            model='gemini-2.5-flash',
            contents=[
                types.Part.from_bytes(data=file_bytes, mime_type=mime_type),
                "Analiza este documento y extrae todos los datos requeridos. "
                "Si el documento no es una factura de compra legible, o está borroso, "
                "debes establecer el campo calidad como ILEGIBLE."
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=FacturaExtraida,
                system_instruction=(
                    "Eres un auditor contable experto. Tu tarea es extraer la información de las facturas de proveedores. "
                    "Asegúrate de estructurar detalladamente la cabecera e identificar y listar cada producto o línea de servicio. "
                    "Al extraer las descripciones de los productos o artículos, límpialas, corrige errores ortográficos obvios (typos) "
                    "y normalízalas de modo que la primera letra de cada producto esté siempre en mayúscula y las demás en minúscula "
                    "(ejemplo: si lees 'MANGERUAS' o 'manguera de PVC', debes normalizarlo como 'Manguera' o 'Manguera de pvc'). "
                    "Si no logras leer el documento debido a mala calidad de imagen, establece calidad = 'ILEGIBLE' y los demás campos vacíos."
                )
            )
        )
        
        # Eliminar archivo temporal local
        try:
            os.remove(temp_file_path)
        except Exception:
            pass
            
        # Analizar respuesta
        import json
        factura_data = json.loads(response.text)
        
        if factura_data.get("calidad") == "ILEGIBLE":
            await status_msg.edit_text(
                "⚠️ **Calidad Insuficiente:**\n"
                "La foto está borrosa o el archivo no es legible. "
                "Por favor, vuelve a tomar la foto con mejor iluminación y encuadre, o envía el PDF original."
            )
            return
            
        # Guardar en memoria temporal
        context.chat_data["active_factura"] = {
            "data": factura_data,
            "empresa_id": empresa_id,
            "s3_url": s3_url
        }
        context.chat_data["state"] = None
        
        # Enviar tarjeta de confirmación
        await status_msg.delete()
        await update.message.reply_text(
            text=format_summary_message(factura_data),
            reply_markup=get_confirmation_keyboard(),
            parse_mode="Markdown"
        )
        
    except Exception as e:
        error_detail = str(e)[:300]
        logger.error(f"Error procesando factura: {e}")
        await status_msg.edit_text(
            f"❌ Error al procesar la factura con Gemini.\n\n"
            f"🔍 *Detalle (debug):*\n`{error_detail}`"
        )

def ejecutar_analisis_conversacional(user_question: str, empresa_id: str, nombre_empresa: str, history: list, pestana_actual: str = "dashboard"):
    action_captured = None

    # Definir la herramienta SQL local para Gemini
    def run_sql_query(sql_query: str) -> str:
        # Validar seguridad sintáctica básica (solo SELECT)
        sql_upper = sql_query.upper()
        forbidden_words = ["INSERT ", "UPDATE ", "DELETE ", "DROP ", "ALTER ", "CREATE ", "TRUNCATE "]
        if any(word in sql_upper for word in forbidden_words):
            return json.dumps({"error": "Solo se permiten consultas de tipo SELECT."})

        try:
            conn = get_shared_db_connection()
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                # Habilitar RLS en la sesión transaccional
                cur.execute(f"SET LOCAL app.current_empresa_id = '{empresa_id}';")
                cur.execute(sql_query)
                rows = cur.fetchall()
                result = json.loads(json.dumps(rows, default=str))

                # Auto-capturar los IDs para la UI si la consulta devolvió facturas
                nonlocal action_captured
                if rows and isinstance(rows, list):
                    ids = [str(r["id"]) for r in rows if isinstance(r, dict) and "id" in r]
                    if ids:
                        action_captured = {
                            "type": "DESTACAR_FACTURAS",
                            "factura_ids": ids
                        }

                return json.dumps(result)
        except Exception as e:
            return json.dumps({"error": f"Error de base de datos: {str(e)}"})

    def destacar_facturas_en_pantalla(factura_ids: List[str]) -> str:
        """Invoca esta herramienta cuando el usuario solicite explícitamente resaltar, marcar, mostrar o ver en pantalla facturas específicas (ej. las 2 facturas más altas, las facturas pendientes de X proveedor, etc.). Debe recibir la lista de IDs UUID de las facturas devueltas por la consulta SQL."""
        nonlocal action_captured
        clean_ids = [str(fid) for fid in factura_ids]
        action_captured = {
            "type": "DESTACAR_FACTURAS",
            "factura_ids": clean_ids
        }
        return f"Se enviará la orden a la interfaz web para resaltar las facturas con IDs: {clean_ids}"

    # Reconstruir la lista de contenidos mezclando historial limpio + pregunta actual (evitando duplicar la pregunta)
    contents_payload = []
    if isinstance(history, list):
        # Filtrar el historial eliminando la pregunta actual si ya fue agregada por el cliente web
        clean_history = [
            h for h in history 
            if isinstance(h, dict) and h.get("text") and not str(h.get("text")).startswith("❌")
        ]
        # Si el último elemento del historial es idéntico a la pregunta actual, lo omitimos para no duplicar el turno
        if clean_history and clean_history[-1].get("text", "").strip() == user_question.strip():
            clean_history = clean_history[:-1]

        # Tomar los últimos 4 mensajes para mantener la latencia ultrabaja (<3s)
        for h in clean_history[-4:]:
            role = "user" if h.get("role") == "user" else "model"
            contents_payload.append(types.Content(
                role=role,
                parts=[types.Part.from_text(text=str(h["text"]))]
            ))

    contents_payload.append(types.Content(
        role="user",
        parts=[types.Part.from_text(text=user_question)]
    ))

    try:
        # Invocar a Gemini 2.5 Flash con AFC (Automatic Function Calling) activado automáticamente por el SDK
        sys_prompt = DB_SCHEMA_PROMPT.format(
            empresa_id=empresa_id,
            nombre_empresa=nombre_empresa,
            pestana_actual=pestana_actual
        )
        
        response = client.models.generate_content(
            model='gemini-2.5-flash-lite',
            contents=contents_payload,
            config=types.GenerateContentConfig(
                system_instruction=sys_prompt,
                tools=[run_sql_query, destacar_facturas_en_pantalla],
                temperature=0.1
            )
        )
        
        # Extracción ultrasegura de texto evitando TypeError si parts es None
        text_res = None
        try:
            if hasattr(response, "text") and response.text:
                text_res = response.text
        except Exception:
            pass

        if not text_res and hasattr(response, "candidates") and response.candidates:
            for cand in response.candidates:
                content = getattr(cand, "content", None)
                if content and getattr(content, "parts", None):
                    parts_text = [p.text for p in content.parts if getattr(p, "text", None)]
                    if parts_text:
                        text_res = "\n".join(parts_text)
                        break

        if not text_res or not text_res.strip():
            if action_captured:
                text_res = "He analizado tus facturas y resaltado los resultados correspondientes en tu pantalla."
            else:
                text_res = "He procesado tu consulta correctamente."

        if action_captured:
            return {"response": text_res, "action": action_captured}
        return text_res

    except Exception as e:
        print(f"[ERROR Gemini Analista] {e}")
        return f"Ocurrió un error al procesar tu consulta con Gemini: {str(e)}"



async def handle_text_response(update: Update, context: ContextTypes.DEFAULT_TYPE):
    state = context.chat_data.get("state")
    active = context.chat_data.get("active_factura")
    
    if not active or not state:
        # Procesar consulta analítica en lenguaje natural con Gemini
        chat_id = str(update.effective_chat.id)
        empresa = get_empresa_by_chat_id(chat_id)
        if not empresa:
            # Si el chat no está registrado en la base de datos, ignoramos
            return
            
        empresa_id, nombre_empresa = empresa
        user_question = update.message.text.strip()
        
        # Avisar al usuario que estamos analizando los datos
        status_msg = await update.message.reply_text("🔍 Analizando datos...")
        
        try:
            # Obtener el historial conversacional actual del chat (máximo 10 mensajes)
            history = context.chat_data.setdefault("analista_historial", [])
            
            # Invocar la función refactorizada para obtener la respuesta de Gemini
            final_text = ejecutar_analisis_conversacional(user_question, empresa_id, nombre_empresa, history)
            
            # Guardar en memoria de sesión el intercambio exitoso
            if final_text:
                history.append({"role": "user", "text": user_question})
                history.append({"role": "model", "text": final_text})
                # Limitar historial a los últimos 10 mensajes (5 turnos de pregunta/respuesta)
                if len(history) > 10:
                    context.chat_data["analista_historial"] = history[-10:]
                else:
                    context.chat_data["analista_historial"] = history
            
            await status_msg.edit_text(final_text, parse_mode="Markdown")
            
        except Exception as err:
            logger.error(f"Error en analista de lenguaje natural: {err}")
            await status_msg.edit_text("❌ No logré procesar tu consulta en este momento. Inténtalo de nuevo con otra pregunta.")
        return
        
    user_input = update.message.text.strip()
    
    if state == "AWAITING_TOTAL":
        # Validar y parsear total
        try:
            # Remover signos de dólar, comas de miles si existen
            clean_input = user_input.replace("$", "").replace(",", "").strip()
            new_total = float(clean_input)
            
            # Actualizar datos
            active["data"]["total"] = new_total
            context.chat_data["state"] = None
            
            await update.message.reply_text("✅ Monto total actualizado.")
            
            # Volver a enviar la tarjeta de confirmación actualizada
            await update.message.reply_text(
                text=format_summary_message(active["data"]),
                reply_markup=get_confirmation_keyboard(),
                parse_mode="Markdown"
            )
        except ValueError:
            await update.message.reply_text(
                "❌ Entrada inválida. Por favor, ingresa un número válido para el total. Ejemplo: `145.50`"
            )
            
    elif state == "AWAITING_FECHA":
        # Validar formato YYYY-MM-DD
        if re.match(r"^\d{4}-\d{2}-\d{2}$", user_input):
            active["data"]["fecha_emision"] = user_input
            context.chat_data["state"] = None
            
            await update.message.reply_text("✅ Fecha de emisión actualizada.")
            
            # Volver a enviar la tarjeta de confirmación actualizada
            await update.message.reply_text(
                text=format_summary_message(active["data"]),
                reply_markup=get_confirmation_keyboard(),
                parse_mode="Markdown"
            )
        else:
            await update.message.reply_text(
                "❌ Formato de fecha inválido. Debe ser YYYY-MM-DD. Ejemplo: `2026-07-09`"
            )

async def handle_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    chat_id = str(update.effective_chat.id)
    active = context.chat_data.get("active_factura")
    
    if not active:
        await query.edit_message_text("❌ No hay ninguna factura activa esperando validación en esta sesión.")
        return
        
    action = query.data
    
    if action == "confirm_save":
        # Registrar en la Base de Datos con RLS
        empresa_id = active["empresa_id"]
        data = active["data"]
        data["url_s3"] = active.get("s3_url")
        
        success = save_factura_db(empresa_id, data)
        
        if success:
            # Limpiar memoria
            context.chat_data["active_factura"] = None
            context.chat_data["state"] = None
            
            moneda = data.get("moneda", "CRC")
            simbolo = "₡" if moneda == "CRC" else "$"
            
            await query.edit_message_text(
                text=(
                    f"✅ **Factura Registrada con Éxito**\n\n"
                    f"• **Proveedor:** {data.get('proveedor')}\n"
                    f"• **Factura Nro:** {data.get('numero_factura')}\n"
                    f"• **Monto Total:** {simbolo}{data.get('total'):.2f} {moneda}\n\n"
                    "Los datos han sido validados e ingresados de forma inmutable en el sistema."
                ),
                parse_mode="Markdown"
            )
        else:
            await query.message.reply_text("❌ Error al guardar la factura en la base de datos. Inténtalo de nuevo.")
            
    elif action == "edit_total":
        context.chat_data["state"] = "AWAITING_TOTAL"
        # Eliminar el markup anterior para evitar clics duplicados
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text(
            "Por favor, escribe el nuevo monto total para esta factura (ejemplo: `150.00`):"
        )
        
    elif action == "edit_fecha":
        context.chat_data["state"] = "AWAITING_FECHA"
        # Eliminar el markup anterior para evitar clics duplicados
        await query.edit_message_reply_markup(reply_markup=None)
        await query.message.reply_text(
            "Por favor, escribe la nueva fecha en formato YYYY-MM-DD (ejemplo: `2026-07-09`):"
        )

def main():
    if not TELEGRAM_BOT_TOKEN:
        print("[ERROR] No se configuró el TELEGRAM_BOT_TOKEN en el archivo .env.")
        return
        
    print("=== Iniciando Nautilus Billing Bot en Desarrollo Local ===")
    
    # Construir la aplicación del bot
    application = Application.builder().token(TELEGRAM_BOT_TOKEN).build()
    
    # Añadir manejadores
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("activar", activar))
    application.add_handler(CallbackQueryHandler(handle_callback))
    
    # Manejar imágenes y documentos
    application.add_handler(MessageHandler(filters.PHOTO | filters.Document.ALL, process_invoice))
    
    # Manejar respuestas de texto para ediciones
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text_response))
    
    # Ejecutar en modo Polling
    application.run_polling()

if __name__ == "__main__":
    main()
