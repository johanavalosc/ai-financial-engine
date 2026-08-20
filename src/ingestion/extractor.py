import os
import json
import logging
from typing import Dict, Any, Optional
from pydantic import BaseModel, Field
import google.generativeai as genai

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class InvoiceData(BaseModel):
    emisor_nombre: str = Field(description="Name or company name of the invoice issuer")
    emisor_cedula: Optional[str] = Field(None, description="Tax ID / Cedula of issuer")
    receptor_nombre: Optional[str] = Field(None, description="Recipient customer name")
    fecha_emision: str = Field(description="ISO format date YYYY-MM-DD")
    consecutivo: Optional[str] = Field(None, description="Invoice sequential number")
    monto_subtotal: float = Field(0.0, description="Subtotal before tax")
    monto_impuesto: float = Field(0.0, description="VAT or total tax amount")
    monto_total: float = Field(description="Grand total amount")
    moneda: str = Field("CRC", description="Currency code (CRC or USD)")
    categoria: str = Field("GASTO_GENERAL", description="Expense category")

class MultimodalInvoiceExtractor:
    """
    Production-grade AI extraction engine for unstructured financial documents.
    """
    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise ValueError("GEMINI_API_KEY environment variable is not set.")
        genai.configure(api_key=api_key)
        self.model = genai.GenerativeModel("gemini-1.5-flash")

    def extract_from_bytes(self, file_bytes: bytes, mime_type: str = "application/pdf") -> Dict[str, Any]:
        """
        Extracts structured financial records from raw PDF or image bytes.
        """
        prompt = """
        You are an expert financial data extraction system.
        Analyze the provided document and extract the structured invoice details according to the required schema.
        Ensure exact decimal precision for subtotal, taxes, and total amounts.
        Return ONLY a valid JSON object matching the requested schema.
        """
        try:
            response = self.model.generate_content(
                contents=[
                    {"mime_type": mime_type, "data": file_bytes},
                    prompt
                ],
                generation_config={"response_mime_type": "application/json"}
            )
            raw_data = json.loads(response.text)
            validated_record = InvoiceData(**raw_data)
            return validated_record.model_dump()
        except Exception as e:
            logger.error(f"AI Extraction failed: {str(e)}")
            raise RuntimeError(f"Document parsing error: {str(e)}")
