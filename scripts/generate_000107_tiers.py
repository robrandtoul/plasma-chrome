#!/usr/bin/env python3
"""Generate SQL VALUES tuples for migration 000107 price_tiers.

Extends letterpress (plain and gilded) to 5 and 6 ink runs using the
fixed delta rule:

  p5 = 2 * p4 - p3
  p6 = 3 * p4 - 2 * p3

The delta between 3_ink and 4_ink at a given (material, currency,
quantity) is applied again to extend the ladder. For gilded letterpress
the rule applies cleanly because the gilded surcharge is per-quantity
(invariant across ink counts), so it cancels out of the p4 - p3 delta.
This means we read gilded p3 and p4 directly without referencing the
plain table.

Source of truth: the canonical 3_ink and 4_ink rows already in the
database, derived by parsing the SQL files that seeded them:

  seed.sql                     plain GBP/EUR full + plain USD q100-q200
  000098 INSERT                gilded GBP/EUR/USD initial
  000105 INSERT                plain + gilded USD anchor quantities
                               (q250, q500, q750, q1000, q1500, q2000)
  000106 UPDATE                gilded USD q125-q200 surcharge smoothing
                               (overrides 000098 at those four quantities)
  000106 INSERT                plain + gilded USD interpolated quantities
                               (q225, q275, q300...q1975 by 25, ex. above)

After parsing, the script asserts that every (material, currency,
quantity) tuple has both a 3_ink and a 4_ink price. If anything is
missing it exits non-zero rather than emitting partial output.

Output shape matches the existing seed.sql convention:

  (material_code, variant_code, currency, quantity, total_price, unit_price)

Unit price = total / quantity, rounded to 4 decimals.

Usage:
  python3 scripts/generate_000107_tiers.py > /tmp/107_tiers.sql

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

# INSERT VALUES tuple:
#   ('paper_letterpress',        '3_ink', 'GBP', 100, 179.00, 1.7900)
INSERT_RE = re.compile(
    r"\(\s*'(paper_letterpress(?:_gilded)?)'\s*,\s*"
    r"'(\d+_ink)'\s*,\s*"
    r"'(GBP|EUR|USD)'\s*,\s*"
    r"(\d+)\s*,\s*"
    r"([\d.]+)"
)

# UPDATE VALUES tuple in 000106 (paper_letterpress_gilded USD only):
#   ('1_ink', 125, 239.00::numeric, 1.9120::numeric)
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
    # The UPDATE statement runs after the original INSERT in 000098 was
    # applied, so its values are the canonical post-migration state.
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

QUANTITIES  = list(range(100, 2001, 25))   # 77 quantities
CURRENCIES  = ("GBP", "EUR", "USD")
MATERIALS   = ("paper_letterpress", "paper_letterpress_gilded")
NEW_VARIANTS = (
    ("5_ink", lambda p3, p4: 2 * p4 - p3),
    ("6_ink", lambda p3, p4: 3 * p4 - 2 * p3),
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
