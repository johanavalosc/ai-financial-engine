import os
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

from src.ingestion.extractor import MultimodalInvoiceExtractor
from src.database.supabase_client import DatabaseService

load_dotenv()

app = FastAPI(
    title="AI Financial Data Ingestion Engine",
    description="Automated document parsing and multi-tenant ingestion API",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

extractor = MultimodalInvoiceExtractor()
db_service = DatabaseService()

@app.get("/health")
def health_check():
    return {"status": "healthy", "service": "ai-financial-engine"}

@app.post("/api/v1/invoices/process")
async def process_invoice(
    empresa_id: str = Form(...),
    file: UploadFile = File(...)
):
    try:
        file_bytes = await file.read()
        mime_type = file.content_type or "application/pdf"
        
        # 1. AI Extraction
        extracted_data = extractor.extract_from_bytes(file_bytes, mime_type)
        
        # 2. Database Insertion
        stored_record = db_service.insert_invoice(empresa_id, extracted_data)
        
        return {
            "success": True,
            "data": stored_record
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/v1/analytics/kpis/{empresa_id}")
def get_kpis(empresa_id: str):
    try:
        kpis = db_service.fetch_monthly_kpis(empresa_id)
        return {"success": True, "kpis": kpis}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
