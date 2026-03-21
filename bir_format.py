# bir_format.py
"""BIR DAT file formatting utilities for Philippine tax compliance.

All functions are pure — no side effects, no Odoo calls.
Encoding note: DAT files use cp1252 with CRLF line endings.
"""

from __future__ import annotations


def clean_tin(raw: str | None) -> str:
    """Strip non-numeric chars, return exactly 9 digits (right-padded with 0)."""
    digits = "".join(c for c in str(raw or "") if c.isdigit())
    if not digits:
        return "000000000"
    return digits[:9].ljust(9, "0")


def clean_str(raw: str | None, max_len: int = 50) -> str:
    """Uppercase, sanitize special chars, collapse whitespace, truncate."""
    s = str(raw or "").upper()
    s = s.replace("&", "AND").replace("\u00d1", "N").replace("\u00f1", "N")
    s = " ".join(s.split())
    return s[:max_len]


def fmt_date_slsp(d: str) -> str:
    """'YYYY-MM-DD' -> 'MM/DD/YYYY' (SLSP DAT format)."""
    return f"{d[5:7]}/{d[8:10]}/{d[:4]}"


def fmt_date_qap(d: str) -> str:
    """'YYYY-MM-DD' -> 'MM/YYYY' (QAP DAT format)."""
    return f"{d[5:7]}/{d[:4]}"


def _q(s: str) -> str:
    """Quote a string field for DAT output."""
    return f'"{s}"'


def _n(v: float) -> str:
    """Format a numeric field — 2 decimal places."""
    return f"{v:.2f}"


def slp_dat_line(row: dict, filing_tin: str) -> str:
    """Build one SLP (Summary List of Purchases) DAT detail line."""
    parts = [
        "D",
        "P",
        _q(row["tin"]),
        _q(row["registered_name"]),
        _q(row.get("last_name", "")),
        _q(row.get("first_name", "")),
        _q(row.get("middle_name", "")),
        _q(row.get("street", "")),
        _q(row.get("city", "")),
        _n(row.get("exempt_amount", 0)),
        _n(row.get("zero_rated_amount", 0)),
        _n(row.get("services_amount", 0)),
        _n(row.get("capital_goods_amount", 0)),
        _n(row.get("other_goods_amount", 0)),
        _n(row.get("input_tax", 0)),
        filing_tin,
        row["date"],
    ]
    return ",".join(parts)


def sls_dat_line(row: dict, filing_tin: str) -> str:
    """Build one SLS (Summary List of Sales) DAT detail line."""
    parts = [
        "D",
        "S",
        _q(row["tin"]),
        _q(row["registered_name"]),
        _q(row.get("last_name", "")),
        _q(row.get("first_name", "")),
        _q(row.get("middle_name", "")),
        _q(row.get("street", "")),
        _q(row.get("city", "")),
        _n(row.get("exempt_amount", 0)),
        _n(row.get("zero_rated_amount", 0)),
        _n(row.get("taxable_amount", 0)),
        _n(row.get("tax_amount", 0)),
        filing_tin,
        row["date"],
    ]
    return ",".join(parts)


def qap_dat_line(row: dict, seq: int) -> str:
    """Build one QAP (Quarterly Alphalist of Payees) DAT detail line."""
    parts = [
        "D1",
        "1601EQ",
        str(seq),
        row["tin"],
        "0000",
        _q(row["registered_name"]),
        _q(row.get("last_name", "")),
        _q(row.get("first_name", "")),
        _q(row.get("middle_name", "")),
        row["date"],
        str(row.get("atc", "")),
        str(row.get("tax_rate", 0)),
        _n(row.get("gross_income", 0)),
        _n(row.get("tax_withheld", 0)),
    ]
    return ",".join(parts)


def write_dat(lines: list[str], filepath: str) -> None:
    """Write DAT lines to file with BIR-required encoding and line endings."""
    with open(filepath, "w", encoding="cp1252", errors="replace", newline="") as f:
        f.write("\r\n".join(lines) + "\r\n")
