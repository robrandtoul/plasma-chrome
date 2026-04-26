#!/usr/bin/env python3
"""Generate SQL VALUES tuples for migration 000109 price_tiers.

Extends the three plastic letterpress materials to higher ink counts
using the same fixed-delta rule as migrations 000107 and 000108:

  p_n = p4 + (n - 4) * (p4 - p3) = (n - 3) * p4 - (n - 4) * p3

Per-material targets:

  plastic_translucent : 5_ink, 6_ink
  plastic_tinted      : 5_ink, 6_ink
  plastic_satin       : 5_ink, 6_ink, 7_ink, 8_ink

The delta between 3_ink and 4_ink at a given (material, currency,
quantity) is applied once for 5_ink, twice for 6_ink, and so on. Same
methodology established in 000107 (5/6 ink) and extended in 000108
(7/8 ink) for letterpress.

Source of truth: the canonical 3_ink and 4_ink rows for the three
plastic materials live entirely in seed.sql. Plastics never had any
data-gap fix-up migrations (unlike letterpress, which needed 000098,
000105, and 000106), so the generator reads a single source file.

After parsing, the script asserts that every (material, currency,
quantity) tuple has both a 3_ink and a 4_ink price. If anything is
missing it exits non-zero rather than emitting partial output.

Output shape matches the existing seed.sql convention:

  (material_code, variant_code, currency, quantity, total_price, unit_price)

Unit price = total / quantity, rounded to 4 decimals.

Usage:
  python3 scripts/generate_000109_tiers.py > /tmp/109_tiers.sql

The output is the SQL VALUES body for the migration's INSERT statement
(no leading 'values' keyword, no trailing semicolon, comma-separated
between rows).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "supabase" / "seed.sql"

# ── Regex ──────────────────────────────────────────────────────────────────

INSERT_RE = re.compile(
    r"\(\s*'(plastic_(?:translucent|tinted|satin))'\s*,\s*"
    r"'(\d+_ink)'\s*,\s*"
    r"'(GBP|EUR|USD)'\s*,\s*"
    r"(\d+)\s*,\s*"
    r"([\d.]+)"
)


# ── Parse ───────────────────────────────────────────────────────────────────

def load_prices() -> dict[tuple[str, str, str, int], float]:
    prices: dict[tuple[str, str, str, int], float] = {}
    text = SEED.read_text()
    for m in INSERT_RE.finditer(text):
        material = m.group(1)
        ink      = m.group(2)
        currency = m.group(3)
        qty      = int(m.group(4))
        total    = float(m.group(5))
        if ink not in ("3_ink", "4_ink"):
            continue
        prices[(material, ink, currency, qty)] = total
    return prices


# ── Generate ────────────────────────────────────────────────────────────────

QUANTITIES = list(range(100, 5001, 25))   # 197 quantities for plastics
CURRENCIES = ("GBP", "EUR", "USD")

# Per-material list of (variant_code, ink_count) to extrapolate.
TARGETS: dict[str, list[tuple[str, int]]] = {
    "plastic_translucent": [("5_ink", 5), ("6_ink", 6)],
    "plastic_tinted":      [("5_ink", 5), ("6_ink", 6)],
    "plastic_satin":       [("5_ink", 5), ("6_ink", 6), ("7_ink", 7), ("8_ink", 8)],
}


def extrapolate(p3: float, p4: float, n: int) -> float:
    """Linear delta extrapolation: p_n = (n-3)*p4 - (n-4)*p3."""
    return (n - 3) * p4 - (n - 4) * p3


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

    for material, targets in TARGETS.items():
        for currency in CURRENCIES:
            for quantity in QUANTITIES:
                p3 = prices.get((material, "3_ink", currency, quantity))
                p4 = prices.get((material, "4_ink", currency, quantity))
                if p3 is None or p4 is None:
                    missing.append(f"{material} {currency} q{quantity}")
                    continue
                for variant_code, n in targets:
                    total = extrapolate(p3, p4, n)
                    rows.append(emit_row(
                        material, variant_code, currency, quantity, total,
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
