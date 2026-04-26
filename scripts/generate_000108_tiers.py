#!/usr/bin/env python3
"""Generate SQL VALUES tuples for migration 000108 price_tiers.

Extends letterpress (plain and gilded) to 7 and 8 ink runs, continuing
the linear ladder established by migration 000107 (5_ink and 6_ink).
Same fixed delta rule, just two more steps:

  p7 = p4 + 3 * (p4 - p3) = 4 * p4 - 3 * p3
  p8 = p4 + 4 * (p4 - p3) = 5 * p4 - 4 * p3

Equivalently (and identically): p7 = p6 + delta, p8 = p7 + delta. Either
formulation produces the same numeric result; this script computes from
3_ink and 4_ink directly, mirroring the 000107 generator.

Gilded surcharge invariance still applies (the gilded surcharge is
per-quantity, not per-ink-count, so it cancels out of the p4 - p3
delta), so we read gilded p3 and p4 directly without referencing the
plain table.

Source of truth: the canonical 3_ink and 4_ink rows already in the
database, derived by parsing the SQL files that seeded them. Same
sources as 000107:

  seed.sql                     plain GBP/EUR full + plain USD q100-q200
  000098 INSERT                gilded GBP/EUR/USD initial
  000105 INSERT                plain + gilded USD anchor quantities
  000106 UPDATE                gilded USD q125-q200 surcharge smoothing
  000106 INSERT                plain + gilded USD interpolated quantities

After parsing, the script asserts that every (material, currency,
quantity) tuple has both a 3_ink and a 4_ink price. If anything is
missing it exits non-zero rather than emitting partial output.

Output shape matches the existing seed.sql convention:

  (material_code, variant_code, currency, quantity, total_price, unit_price)

Unit price = total / quantity, rounded to 4 decimals.

Usage:
  python3 scripts/generate_000108_tiers.py > /tmp/108_tiers.sql

The output is the SQL VALUES body for the migration's INSERT statement
(no leading 'values' keyword, no trailing semicolon, comma-separated
between rows).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SOURCE_FILES = [
    ROOT / "supabase" / "seed.sql",
    ROOT / "supabase" / "migrations"
        / "000098_split_gilded_letterpress_and_cnc_carbon_fibre.sql",
    ROOT / "supabase" / "migrations"
        / "000105_fill_usd_letterpress_price_tier_gap.sql",
    ROOT / "supabase" / "migrations"
        / "000106_fill_usd_letterpress_full_granularity.sql",
]

UPDATE_FILE = ROOT / "supabase" / "migrations" \
    / "000106_fill_usd_letterpress_full_granularity.sql"

# ── Regex ──────────────────────────────────────────────────────────────────

INSERT_RE = re.compile(
    r"\(\s*'(paper_letterpress(?:_gilded)?)'\s*,\s*"
    r"'(\d+_ink)'\s*,\s*"
    r"'(GBP|EUR|USD)'\s*,\s*"
    r"(\d+)\s*,\s*"
    r"([\d.]+)"
)

UPDATE_RE = re.compile(
    r"\(\s*'(\d+_ink)'\s*,\s*"
    r"(\d+)\s*,\s*"
    r"([\d.]+)::numeric"
)

UPDATE_BLOCK_RE = re.compile(
    r"update\s+price_tiers\b.*?from\s*\(\s*values(.*?)\)\s*as\s+upd",
    re.DOTALL | re.IGNORECASE,
)

# ── Parse ───────────────────────────────────────────────────────────────────

def load_prices() -> dict[tuple[str, str, str, int], float]:
    prices: dict[tuple[str, str, str, int], float] = {}

    # First pass: every INSERT-shaped tuple across the source files. We
    # only retain 3_ink and 4_ink since those are the inputs to the
    # delta rule.
    for path in SOURCE_FILES:
        text = path.read_text()
        for m in INSERT_RE.finditer(text):
            material = m.group(1)
            ink      = m.group(2)
            currency = m.group(3)
            qty      = int(m.group(4))
            total    = float(m.group(5))
            if ink not in ("3_ink", "4_ink"):
                continue
            prices[(material, ink, currency, qty)] = total

    # Second pass: 000106 UPDATE block overrides gilded USD q125-q200.
    update_text = UPDATE_FILE.read_text()
    block_match = UPDATE_BLOCK_RE.search(update_text)
    if block_match:
        for m in UPDATE_RE.finditer(block_match.group(1)):
            ink   = m.group(1)
            qty   = int(m.group(2))
            total = float(m.group(3))
            if ink in ("3_ink", "4_ink"):
                prices[("paper_letterpress_gilded", ink, "USD", qty)] = total

    return prices


# ── Generate ────────────────────────────────────────────────────────────────

QUANTITIES   = list(range(100, 2001, 25))   # 77 quantities
CURRENCIES   = ("GBP", "EUR", "USD")
MATERIALS    = ("paper_letterpress", "paper_letterpress_gilded")
NEW_VARIANTS = (
    ("7_ink", lambda p3, p4: 4 * p4 - 3 * p3),
    ("8_ink", lambda p3, p4: 5 * p4 - 4 * p3),
)


def emit_row(
    material: str, variant: str, currency: str,
    quantity: int, total: float,
) -> str:
    unit = round(total / quantity, 4)
    return (
        f"  ('{material}', '{variant}', '{currency}', "
        f"{quantity}, {total:.2f}, {unit:.4f})"
    )


def main() -> None:
    prices = load_prices()

    rows: list[str] = []
    missing: list[str] = []

    for material in MATERIALS:
        for currency in CURRENCIES:
            for quantity in QUANTITIES:
                p3 = prices.get((material, "3_ink", currency, quantity))
                p4 = prices.get((material, "4_ink", currency, quantity))
                if p3 is None or p4 is None:
                    missing.append(f"{material} {currency} q{quantity}")
                    continue
                for variant, rule in NEW_VARIANTS:
                    total = rule(p3, p4)
                    rows.append(emit_row(
                        material, variant, currency, quantity, total,
                    ))

    if missing:
        sys.stderr.write(
            "Missing 3_ink or 4_ink data for:\n  "
            + "\n  ".join(missing) + "\n"
        )
        sys.exit(1)

    for i, row in enumerate(rows):
        suffix = "," if i < len(rows) - 1 else ""
        print(row + suffix)

    sys.stderr.write(f"Generated {len(rows)} tier rows.\n")


if __name__ == "__main__":
    main()
