# tests/test_bir_format.py
import pytest
from bir_format import (
    clean_tin,
    clean_str,
    fmt_date_slsp,
    fmt_date_qap,
    slp_dat_line,
    qap_dat_line,
)


class TestCleanTin:
    def test_strips_non_digits(self):
        assert clean_tin("123-456-789") == "123456789"

    def test_pads_short_tin(self):
        assert clean_tin("12345") == "123450000"

    def test_truncates_long_tin(self):
        assert clean_tin("1234567890123") == "123456789"

    def test_none_returns_zeros(self):
        assert clean_tin(None) == "000000000"

    def test_empty_returns_zeros(self):
        assert clean_tin("") == "000000000"

    def test_letters_only_returns_zeros(self):
        assert clean_tin("ABCDEF") == "000000000"


class TestCleanStr:
    def test_uppercases(self):
        assert clean_str("hello world") == "HELLO WORLD"

    def test_replaces_ampersand(self):
        assert clean_str("A & B") == "A AND B"

    def test_replaces_enye(self):
        assert clean_str("Niño") == "NINO"

    def test_collapses_whitespace(self):
        assert clean_str("a   b  c") == "A B C"

    def test_truncates_to_max_len(self):
        assert clean_str("abcdefghij", max_len=5) == "ABCDE"

    def test_none_returns_empty(self):
        assert clean_str(None) == ""


class TestFmtDateSlsp:
    def test_formats_correctly(self):
        assert fmt_date_slsp("2026-01-15") == "01/15/2026"

    def test_end_of_year(self):
        assert fmt_date_slsp("2026-12-31") == "12/31/2026"


class TestFmtDateQap:
    def test_formats_correctly(self):
        assert fmt_date_qap("2026-01-15") == "01/2026"

    def test_end_of_year(self):
        assert fmt_date_qap("2026-12-31") == "12/2026"


class TestSlpDatLine:
    def test_produces_correct_format(self):
        row = {
            "tin": "123456789",
            "registered_name": "ACME CORP",
            "last_name": "",
            "first_name": "",
            "middle_name": "",
            "street": "123 MAIN ST",
            "city": "MAKATI",
            "exempt_amount": 0,
            "zero_rated_amount": 0,
            "services_amount": 10000.00,
            "capital_goods_amount": 0,
            "other_goods_amount": 0,
            "input_tax": 1200.00,
            "date": "01/15/2026",
        }
        line = slp_dat_line(row, filing_tin="999888777")
        assert line.startswith('D,P,"123456789","ACME CORP"')
        assert "10000.00" in line
        assert "1200.00" in line
        assert line.endswith("999888777,01/15/2026")


class TestQapDatLine:
    def test_produces_correct_format(self):
        row = {
            "tin": "123456789",
            "registered_name": "ACME CORP",
            "last_name": "",
            "first_name": "",
            "middle_name": "",
            "date": "01/2026",
            "atc": "WI010",
            "tax_rate": 10,
            "gross_income": 50000.00,
            "tax_withheld": 5000.00,
        }
        line = qap_dat_line(row, seq=1)
        assert line.startswith("D1,1601EQ,1,123456789,0000")
        assert "WI010" in line
        assert "50000.00" in line
        assert "5000.00" in line
