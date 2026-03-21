# main.py
"""Enhanced SLSP & QAP export service.

GET  /{token}/           -> renders the export form
GET  /{token}/companies  -> returns company list for a given db (AJAX)
POST /{token}/export     -> generates and returns XLSX or DAT file

All routes are guarded by ACCESS_TOKEN in the URL path.
Unknown tokens receive a 404 to avoid confirming service existence.
"""

from __future__ import annotations

import io
import json
import logging
import os
from datetime import date
from urllib.parse import quote

from fastapi import FastAPI, Form, Request, Query
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from odoo_client import (
    connect, fetch_posted_bills, fetch_journal_entries_with_wht,
    fetch_partner_details, fetch_bill_lines_with_tax,
    fetch_tax_details, classify_purchase, get_companies, get_semaphore,
)
from bir_format import clean_tin, clean_str
from slsp_builder import build_slsp_rows, write_slsp_xlsx, write_slsp_dat
from qap_builder import build_qap_rows, write_qap_xlsx, write_qap_dat

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = FastAPI(title="Enhanced BIR Reports")
templates = Jinja2Templates(directory="templates")

_ACCESS_TOKEN = os.environ.get("ACCESS_TOKEN", "")


def _check_token(token: str):
    """Return 404 for unknown tokens — avoids confirming service existence."""
    if not _ACCESS_TOKEN or token != _ACCESS_TOKEN:
        return JSONResponse({"detail": "Not found"}, status_code=404)
    return None


def _load_clients() -> list[dict]:
    raw = os.environ.get("ODOO_CLIENTS_JSON", "[]")
    return json.loads(raw)


def _default_quarter_dates() -> tuple[str, str]:
    """Return start/end of the current calendar quarter."""
    today = date.today()
    q_start_month = ((today.month - 1) // 3) * 3 + 1
    q_start = date(today.year, q_start_month, 1)
    q_end_month = q_start_month + 2
    days_in_month = {1: 31, 2: 28, 3: 31, 4: 30, 5: 31, 6: 30,
                     7: 31, 8: 31, 9: 30, 10: 31, 11: 30, 12: 31}
    q_end = date(today.year, q_end_month, days_in_month[q_end_month])
    return str(q_start), str(q_end)


def _extract_slsp_rows(conn, moves, report_type, source_label):
    """Convert fetched moves (bills or JEs) into cleaned SLSP rows."""
    rows = []
    for move in moves:
        lines = move.get("enriched_lines") or fetch_bill_lines_with_tax(conn, move["id"])
        for line in lines:
            partner_id = line.get("partner_id") or move.get("partner_id")
            if not partner_id:
                continue
            pid = partner_id[0] if isinstance(partner_id, list) else partner_id
            partner = fetch_partner_details(conn, pid)
            tax_details = line.get("tax_details") or fetch_tax_details(conn, line.get("tax_ids", []))
            for tax in tax_details:
                use = tax.get("type_tax_use", "")
                if report_type == "purchases" and use != "purchase":
                    continue
                if report_type == "sales" and use != "sale":
                    continue
                gross = abs(line.get("price_subtotal", 0))
                tax_amt = round(gross * abs(tax.get("amount", 0)) / 100, 2)
                category = classify_purchase(conn, line["account_id"][0]) if report_type == "purchases" else None
                row = {
                    "tin": clean_tin(partner.get("vat", "")),
                    "registered_name": clean_str(partner.get("name", ""), 50),
                    "last_name": clean_str(partner.get("last_name", ""), 30),
                    "first_name": clean_str(partner.get("first_name", ""), 30),
                    "middle_name": clean_str(partner.get("middle_name", ""), 30),
                    "street": clean_str(partner.get("street", ""), 30),
                    "city": clean_str(partner.get("city", ""), 30),
                    "date": move["date"],
                    "source": source_label,
                }
                if report_type == "purchases":
                    row.update({
                        "exempt_amount": 0,
                        "zero_rated_amount": 0,
                        "services_amount": gross if category == "services" else 0,
                        "capital_goods_amount": gross if category == "capital_goods" else 0,
                        "other_goods_amount": gross if category == "other_than_capital_goods" else 0,
                        "input_tax": tax_amt,
                    })
                else:
                    row.update({
                        "exempt_amount": 0,
                        "zero_rated_amount": 0,
                        "taxable_amount": gross,
                        "tax_amount": tax_amt,
                    })
                rows.append(row)
    return rows


def _extract_qap_rows(conn, moves, source_label):
    """Convert fetched moves (bills or JEs) into cleaned QAP rows."""
    rows = []
    for move in moves:
        lines = move.get("enriched_lines") or fetch_bill_lines_with_tax(conn, move["id"])
        for line in lines:
            partner_id = line.get("partner_id") or move.get("partner_id")
            if not partner_id:
                continue
            pid = partner_id[0] if isinstance(partner_id, list) else partner_id
            partner = fetch_partner_details(conn, pid)
            tax_details = line.get("tax_details") or fetch_tax_details(conn, line.get("tax_ids", []))
            for tax in tax_details:
                atc = tax.get("l10n_ph_atc")
                if not atc or tax.get("type_tax_use") != "purchase":
                    continue
                gross = abs(line.get("price_subtotal", 0))
                rows.append({
                    "tin": clean_tin(partner.get("vat", "")),
                    "registered_name": clean_str(partner.get("name", ""), 50),
                    "last_name": clean_str(partner.get("last_name", ""), 30),
                    "first_name": clean_str(partner.get("first_name", ""), 30),
                    "middle_name": clean_str(partner.get("middle_name", ""), 30),
                    "date": move["date"],
                    "atc": atc,
                    "tax_rate": abs(tax.get("amount", 0)),
                    "gross_income": gross,
                    "tax_withheld": round(gross * abs(tax["amount"]) / 100, 2),
                    "source": source_label,
                })
    return rows


@app.get("/{token}/", response_class=HTMLResponse)
def index(token: str, request: Request):
    err = _check_token(token)
    if err:
        return err
    clients = _load_clients()
    date_from, date_to = _default_quarter_dates()
    return templates.TemplateResponse("index.html", {
        "request": request,
        "clients": clients,
        "default_date_from": date_from,
        "default_date_to": date_to,
    })


@app.get("/{token}/companies")
def companies_endpoint(token: str, db: str = Query(...)):
    """AJAX endpoint — returns company list for the selected database."""
    err = _check_token(token)
    if err:
        return err
    clients = _load_clients()
    client = next((c for c in clients if c["db"] == db), None)
    if not client:
        return JSONResponse([], status_code=200)
    try:
        conn = connect(client["url"], client["db"], client["user"], client["api_key"])
        return get_companies(conn)
    except ConnectionError:
        return JSONResponse([], status_code=200)


@app.post("/{token}/export")
def export_report(
    token: str,
    report_type: str = Form(...),
    db_name: str = Form(...),
    company_id: int = Form(...),
    date_from: str = Form(...),
    date_to: str = Form(...),
    format: str = Form("xlsx"),
):
    err = _check_token(token)
    if err:
        return err
    clients = _load_clients()
    client = next((c for c in clients if c["db"] == db_name), None)
    if not client:
        return JSONResponse({"detail": f"Database not found"}, status_code=400)

    try:
        conn = connect(client["url"], client["db"], client["user"], client["api_key"],
                       company_id=company_id)
    except ConnectionError as e:
        return JSONResponse({"detail": str(e)}, status_code=502)

    companies = get_companies(conn)
    selected = next((c for c in companies if c["id"] == company_id), {})
    filing_tin = clean_tin(selected.get("vat", ""))

    with get_semaphore(client["db"]):
        if report_type in ("slsp_purchases", "slsp_sales"):
            slsp_type = "purchases" if report_type == "slsp_purchases" else "sales"
            move_types = (
                ["in_invoice", "in_refund"] if slsp_type == "purchases"
                else ["out_invoice", "out_refund"]
            )
            bills = fetch_posted_bills(conn, move_types, date_from, date_to)
            jes = fetch_journal_entries_with_wht(conn, date_from, date_to)
            bill_rows = _extract_slsp_rows(conn, bills, slsp_type, "bill")
            je_rows = _extract_slsp_rows(conn, jes, slsp_type, "journal_entry")
            merged = build_slsp_rows(bill_rows, je_rows)

            summary = f"{len(bill_rows)} bills + {len(je_rows)} journal entries = {len(merged)} total"
            label = "SLP" if slsp_type == "purchases" else "SLS"
            filename = f"{label}_{date_from}_to_{date_to}_{client['db']}"

            if format == "dat":
                content = write_slsp_dat(merged, report_type=slsp_type, filing_tin=filing_tin)
                return StreamingResponse(
                    io.BytesIO(content.encode("cp1252", errors="replace")),
                    media_type="application/octet-stream",
                    headers={
                        "Content-Disposition": f'attachment; filename="{filename}.dat"',
                        "X-Export-Summary": quote(summary),
                    },
                )
            buf = io.BytesIO()
            write_slsp_xlsx(merged, buf, report_type=slsp_type)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}.xlsx"',
                    "X-Export-Summary": quote(summary),
                },
            )

        elif report_type == "qap":
            bills = fetch_posted_bills(conn, ["in_invoice", "in_refund"], date_from, date_to)
            jes = fetch_journal_entries_with_wht(conn, date_from, date_to)
            bill_rows = _extract_qap_rows(conn, bills, "bill")
            je_rows = _extract_qap_rows(conn, jes, "journal_entry")
            merged = build_qap_rows(bill_rows, je_rows)

            summary = f"{len(bill_rows)} bills + {len(je_rows)} journal entries = {len(merged)} total"
            filename = f"QAP_{date_from}_to_{date_to}_{client['db']}"

            if format == "dat":
                content = write_qap_dat(merged)
                return StreamingResponse(
                    io.BytesIO(content.encode("cp1252", errors="replace")),
                    media_type="application/octet-stream",
                    headers={
                        "Content-Disposition": f'attachment; filename="{filename}.dat"',
                        "X-Export-Summary": quote(summary),
                    },
                )
            buf = io.BytesIO()
            write_qap_xlsx(merged, buf)
            buf.seek(0)
            return StreamingResponse(
                buf,
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}.xlsx"',
                    "X-Export-Summary": quote(summary),
                },
            )

        return JSONResponse({"detail": f"Unknown report type: {report_type}"}, status_code=400)


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8080))
    uvicorn.run(app, host="0.0.0.0", port=port)
