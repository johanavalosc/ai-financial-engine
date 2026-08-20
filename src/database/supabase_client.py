import os
import logging
from typing import Dict, Any
from supabase import create_client, Client

logger = logging.getLogger(__name__)

class DatabaseService:
    """
    Supabase database interaction service with Row-Level Security enforcement.
    """
    def __init__(self):
        url = os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
        if not url or not key:
            raise ValueError("Supabase configuration missing in environment variables.")
        self.client: Client = create_client(url, key)

    def insert_invoice(self, empresa_id: str, invoice_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Inserts a validated invoice record into the tenant partition.
        """
        payload = {**invoice_data, "empresa_id": empresa_id}
        response = self.client.table("facturas").insert(payload).execute()
        return response.data

    def fetch_monthly_kpis(self, empresa_id: str) -> Dict[str, Any]:
        """
        Executes RPC function to retrieve aggregated business metrics.
        """
        response = self.client.rpc("obtener_kpis_empresa", {"p_empresa_id": empresa_id}).execute()
        return response.data
