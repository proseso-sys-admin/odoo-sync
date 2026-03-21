# tests/test_odoo_client.py
import pytest
from unittest.mock import MagicMock
from odoo_client import (
    OdooConnection,
    fetch_posted_bills,
    fetch_journal_entries_with_wht,
    fetch_partner_details,
    classify_purchase,
    fetch_companies,
)


@pytest.fixture
def mock_conn():
    """Create a mock OdooConnection with stubbed XML-RPC."""
    conn = OdooConnection.__new__(OdooConnection)
    conn.url = "https://test.odoo.com"
    conn.db = "test-db"
    conn.uid = 2
    conn.api_key = "test-key"
    conn.models = MagicMock()
    conn.company_id = None
    return conn


class TestFetchPostedBills:
    def test_returns_bills_with_correct_domain(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {
                "id": 1,
                "name": "BILL/2026/0001",
                "date": "2026-01-15",
                "partner_id": [10, "Acme Corp"],
                "amount_total": 11200.00,
                "amount_untaxed": 10000.00,
                "line_ids": [100, 101],
            }
        ]
        bills = fetch_posted_bills(
            mock_conn,
            move_types=["in_invoice", "in_refund"],
            date_from="2026-01-01",
            date_to="2026-03-31",
        )
        assert len(bills) == 1
        assert bills[0]["name"] == "BILL/2026/0001"
        call_args = mock_conn.models.execute_kw.call_args
        domain = call_args[0][4][0]
        assert ("move_type", "in", ["in_invoice", "in_refund"]) in domain
        assert ("state", "=", "posted") in domain

    def test_returns_empty_when_no_bills(self, mock_conn):
        mock_conn.models.execute_kw.return_value = []
        bills = fetch_posted_bills(
            mock_conn,
            move_types=["in_invoice"],
            date_from="2026-01-01",
            date_to="2026-03-31",
        )
        assert bills == []


class TestFetchJournalEntriesWithWht:
    def test_returns_only_entries_with_atc(self, mock_conn):
        mock_conn.models.execute_kw.side_effect = [
            # First call: search_read on account.move
            [
                {
                    "id": 5,
                    "name": "JE/2026/0001",
                    "date": "2026-02-10",
                    "partner_id": [10, "Acme Corp"],
                    "line_ids": [200, 201],
                }
            ],
            # Second call: search_read on account.move.line (for move 5)
            [
                {
                    "id": 200,
                    "name": "WHT Payment",
                    "debit": 0,
                    "credit": 1000.00,
                    "partner_id": [10, "Acme Corp"],
                    "account_id": [601, "Professional Fees"],
                    "tax_ids": [50],
                    "price_subtotal": 10000.00,
                }
            ],
            # Third call: read on account.tax
            [
                {
                    "id": 50,
                    "name": "WI010 - 10%",
                    "amount": -10.0,
                    "l10n_ph_atc": "WI010",
                    "type_tax_use": "purchase",
                }
            ],
        ]
        entries = fetch_journal_entries_with_wht(
            mock_conn,
            date_from="2026-01-01",
            date_to="2026-03-31",
        )
        assert len(entries) == 1
        assert entries[0]["name"] == "JE/2026/0001"
        assert len(entries[0]["enriched_lines"]) == 1
        assert entries[0]["enriched_lines"][0]["tax_details"][0]["l10n_ph_atc"] == "WI010"


class TestFetchPartnerDetails:
    def test_returns_partner_fields(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {
                "id": 10,
                "name": "Acme Corp",
                "vat": "123-456-789",
                "first_name": "John",
                "middle_name": "M",
                "last_name": "Doe",
                "street": "123 Main St",
                "city": "Makati",
            }
        ]
        partner = fetch_partner_details(mock_conn, partner_id=10)
        assert partner["vat"] == "123-456-789"
        assert partner["city"] == "Makati"

    def test_returns_empty_dict_when_not_found(self, mock_conn):
        mock_conn.models.execute_kw.return_value = []
        partner = fetch_partner_details(mock_conn, partner_id=999)
        assert partner == {}


class TestClassifyPurchase:
    def test_asset_account_returns_capital_goods(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {"id": 100, "code": "15100", "name": "Equipment"}
        ]
        assert classify_purchase(mock_conn, account_id=100) == "capital_goods"

    def test_expense_account_returns_services(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {"id": 601, "code": "60100", "name": "Professional Fees"}
        ]
        assert classify_purchase(mock_conn, account_id=601) == "services"

    def test_other_account_returns_other(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {"id": 200, "code": "20100", "name": "Accounts Payable"}
        ]
        assert classify_purchase(mock_conn, account_id=200) == "other_than_capital_goods"


class TestFetchCompanies:
    def test_returns_all_accessible_companies(self, mock_conn):
        mock_conn.models.execute_kw.return_value = [
            {"id": 1, "name": "Proseso Ventures", "vat": "009562751", "street": "1 Main St", "city": "Makati"},
            {"id": 2, "name": "Proseso Realty", "vat": "009562752", "street": "2 Side St", "city": "BGC"},
        ]
        companies = fetch_companies(mock_conn)
        assert len(companies) == 2
        assert companies[0]["vat"] == "009562751"
        assert companies[1]["name"] == "Proseso Realty"

    def test_returns_empty_list_when_no_companies(self, mock_conn):
        mock_conn.models.execute_kw.return_value = []
        companies = fetch_companies(mock_conn)
        assert companies == []

    def test_company_id_context_injected(self, mock_conn):
        """Connection with company_id should inject allowed_company_ids into execute_kw."""
        mock_conn.company_id = 2
        mock_conn.models.execute_kw.return_value = [
            {"id": 2, "name": "Proseso Realty", "vat": "009562752", "street": "", "city": ""}
        ]
        fetch_companies(mock_conn)
        call_kwargs = mock_conn.models.execute_kw.call_args[0][6]
        assert call_kwargs.get("context", {}).get("allowed_company_ids") == [2]
