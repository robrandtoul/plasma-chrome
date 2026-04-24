#!/usr/bin/env python3
"""Generate SQL VALUES tuples for migration 000098 price_tiers.

Reads the six source CSVs for letterpress (with gilding) and carbon
fibre (with CNC cutting) across GBP, EUR, USD. Emits VALUES rows
shaped as:

  (material_code, variant_code, currency, quantity, total_price, unit_price)

which slot into the migration's INSERT ... SELECT FROM (VALUES ...)
pattern. Unit price = total / quantity rounded to 4 decimals, matching
the existing seed.sql convention.

Currency handling per source (see recon report for details):

  Letterpress
    GBP: "Total N Ink (with gilding)" columns pre-computed
    EUR: base + "Gilded Add" surcharge, per-quantity, applies to all 4
         ink variants uniformly
    USD: base + "Optional Gilding" surcharge, only 5 tiers exist
         (100 to 200 by 25). Same data gap flagged in seed.sql for
         the non-gilded USD letterpress.

  Carbon Fibre
    GBP: "Total Price (with CNC)" pre-computed
    EUR: base "Price" + "CNC Add" surcharge
    USD: "Total with CNC" pre-computed

Surcharge regex strips the currency symbol + "add" prefix and parses
the numeric: /add\\s*[£€$]?\\s*(\\d+(?:\\.\\d+)?)/.

Usage:
  python3 scripts/generate_000098_tiers.py > /tmp/tiers.sql

The output is SQL VALUES fragments ready to paste into the migration.
Run this from the repo root; paths are resolved relative to the
Dropbox CSV source folder.
"""

from __future__ import annotations

import csv
import re
import sys
from pathlib import Path

DROPBOX_BASE = Path(
    "/Users/robrandtoul/Library/CloudStorage/"
    "Dropbox-PlasmaDesignLtd/Rob Randtoul/Pricing"
)

# ── Currency / price parsing ────────────────────────────────────────────────

_MONEY_RE = re.compile(r"[£€$]?\s*(-?\d+(?:\.\d+)?)")
_SURCHARGE_RE = re.compile(r"add\s*[£€$]?\s*(\d+(?:\.\d+)?)", re.IGNORECASE)


def parse_money(cell: str) -> float:
    """Parse a price cell like "£169" or "€1.59" or "299" into a float."""
    cell = cell.strip()
    m = _MONEY_RE.search(cell)
    if not m:
        raise ValueError(f"Could not parse money: {cell!r}")
    return float(m.group(1))


def parse_surcharge(cell: str) -> float:
    """Parse a surcharge cell like "add €60" or "add $75" into a float."""
    cell = cell.strip()
    m = _SURCHARGE_RE.search(cell)
    if not m:
        raise ValueError(f"Could not parse surcharge: {cell!r}")
    return float(m.group(1))


def emit_row(
    material_code: str,
    variant_code: str,
    currency: str,
    quantity: int,
    total_price: float,
) -> str:
    unit = round(total_price / quantity, 4)
    return (
        f"  ('{material_code}', '{variant_code}', '{currency}', "
        f"{quantity}, {total_price:.2f}, {unit:.4f})"
    )


# ── Letterpress ─────────────────────────────────────────────────────────────

LETTERPRESS_GBP = DROPBOX_BASE / "GBP" / "Paper" / "Letterpress Cards GBP.csv"
LETTERPRESS_EUR = DROPBOX_BASE / "EUR" / "Paper" / "Letterpress EUR.csv"
LETTERPRESS_USD = DROPBOX_BASE / "USD" / "Paper" / "Letterpress USD.csv"

MAT_GILDED = "paper_letterpress_gilded"
INK_VARIANTS = [
    (1, "1_ink"),
    (2, "2_ink"),
    (3, "3_ink"),
    (4, "4_ink"),
]


def process_letterpress_gbp() -> list[str]:
    """GBP CSV has pre-computed totals in `Total N Ink (with gilding)`."""
    rows = []
    with LETTERPRESS_GBP.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            for n, variant_code in INK_VARIANTS:
                col = f"Total {n} Ink{'s' if n > 1 else ''} (with gilding)"
                total = parse_money(r[col])
                rows.append(emit_row(MAT_GILDED, variant_code, "GBP", qty, total))
    return rows


def process_letterpress_eur() -> list[str]:
    """EUR CSV: base + Gilded Add surcharge (same surcharge applies to
    every ink variant at a given quantity)."""
    rows = []
    with LETTERPRESS_EUR.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            surcharge = parse_surcharge(r["Gilded Add"])
            for n, variant_code in INK_VARIANTS:
                col = f"{n} ink{'s' if n > 1 else ''}"
                base = parse_money(r[col])
                total = base + surcharge
                rows.append(emit_row(MAT_GILDED, variant_code, "EUR", qty, total))
    return rows


def process_letterpress_usd() -> list[str]:
    """USD CSV: base + Optional Gilding surcharge. Only 5 tiers.
    Same data gap as existing seed.sql's non-gilded USD letterpress."""
    rows = []
    with LETTERPRESS_USD.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            surcharge = parse_surcharge(r["Optional Gilding"])
            for n, variant_code in INK_VARIANTS:
                col = f"{n} Ink{'s' if n > 1 else ''}"
                base = parse_money(r[col])
                total = base + surcharge
                rows.append(emit_row(MAT_GILDED, variant_code, "USD", qty, total))
    return rows


# ── Carbon Fibre ────────────────────────────────────────────────────────────

CARBON_GBP = DROPBOX_BASE / "GBP" / "Carbon Fibre" / "Carbon Fibre Cards GBP.csv"
CARBON_EUR = DROPBOX_BASE / "EUR" / "Carbon Fibre" / "Carbon Fibre EUR.csv"
CARBON_USD = DROPBOX_BASE / "USD" / "Carbon Fibre" / "Carbon Fibre USD.csv"

MAT_CNC = "carbon_fibre_cnc"
CNC_VARIANT = "default"


def process_carbon_gbp() -> list[str]:
    rows = []
    with CARBON_GBP.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            total = parse_money(r["Total Price (with CNC)"])
            rows.append(emit_row(MAT_CNC, CNC_VARIANT, "GBP", qty, total))
    return rows


def process_carbon_eur() -> list[str]:
    rows = []
    with CARBON_EUR.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            base = parse_money(r["Price"])
            surcharge = parse_surcharge(r["CNC Add"])
            total = base + surcharge
            rows.append(emit_row(MAT_CNC, CNC_VARIANT, "EUR", qty, total))
    return rows


def process_carbon_usd() -> list[str]:
    rows = []
    with CARBON_USD.open() as f:
        reader = csv.DictReader(f)
        for r in reader:
            qty = int(r["Quantity"])
            total = parse_money(r["Total with CNC"])
            rows.append(emit_row(MAT_CNC, CNC_VARIANT, "USD", qty, total))
    return rows


# ── Main ────────────────────────────────────────────────────────────────────


def main() -> None:
    all_rows: list[str] = []

    all_rows += process_letterpress_gbp()
    all_rows += process_letterpress_eur()
    all_rows += process_letterpress_usd()
    all_rows += process_carbon_gbp()
    all_rows += process_carbon_eur()
    all_rows += process_carbon_usd()

    sys.stderr.write(f"Generated {len(all_rows)} tier rows.\n")

    # Emit the VALUES body. Trailing comma on every line except the last.
    for i, row in enumerate(all_rows):
        if i < len(all_rows) - 1:
            print(row + ",")
        else:
            print(row)


if __name__ == "__main__":
    main()
