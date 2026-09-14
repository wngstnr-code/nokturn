#!/usr/bin/env python3
"""
Nokturn — NYSE calendar + US Eastern DST boundary fixture generator.

Generates the reference data required by docs/rencana-uji.md section 8
(exhaustive calendar-boundary testing) and docs/desain-session-engine.md
sections 5-6 (explicit DST table + holiday/early-close table).

Pure stdlib, deterministic, no network. Output is DATA, not protocol code.
"""

import csv
import json
from datetime import date, datetime, timedelta, timezone

YEAR_START, YEAR_END = 2020, 2035

# US Eastern Time offsets
EST_OFFSET = -5  # hours from UTC
EDT_OFFSET = -4

# NYSE regular session, in local Eastern wall-clock
OPEN_H, OPEN_M = 9, 30
CLOSE_H, CLOSE_M = 16, 0
EARLY_CLOSE_H, EARLY_CLOSE_M = 13, 0

# NYSE first observed Juneteenth in 2022 (federal holiday signed June 2021,
# but the exchange did not close for it that year).
JUNETEENTH_FIRST_YEAR = 2022


# ---------------------------------------------------------------- date helpers

def nth_weekday(year, month, weekday, n):
    """n-th <weekday> of month. weekday: Mon=0 .. Sun=6."""
    d = date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + timedelta(days=offset + 7 * (n - 1))


def last_weekday(year, month, weekday):
    """Last <weekday> of month."""
    if month == 12:
        d = date(year, 12, 31)
    else:
        d = date(year, month + 1, 1) - timedelta(days=1)
    return d - timedelta(days=(d.weekday() - weekday) % 7)


def easter_sunday(year):
    """Gregorian Easter — Meeus/Jones/Butcher algorithm."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def observed(d, is_new_years=False):
    """
    NYSE weekend observation rule for fixed-date holidays.
      Saturday -> observed the preceding Friday
      Sunday   -> observed the following Monday
    EXCEPTION: New Year's Day falling on Saturday is NOT observed on the
    preceding Friday (that Friday is the last trading day of the prior year).
    Returns None when the holiday is not observed at all.
    """
    if d.weekday() == 5:  # Saturday
        return None if is_new_years else d - timedelta(days=1)
    if d.weekday() == 6:  # Sunday
        return d + timedelta(days=1)
    return d


# ---------------------------------------------------------------- DST boundaries

def dst_boundaries(year):
    """
    US DST since the Energy Policy Act of 2005:
      starts  2nd Sunday of March,    02:00 local EST (= 07:00 UTC)
      ends    1st Sunday of November, 02:00 local EDT (= 06:00 UTC)
    Returns (spring_forward_utc, fall_back_utc) as aware datetimes.
    """
    spring = nth_weekday(year, 3, 6, 2)   # Sunday = 6
    fall = nth_weekday(year, 11, 6, 1)
    sf = datetime(spring.year, spring.month, spring.day, 7, 0, tzinfo=timezone.utc)
    fb = datetime(fall.year, fall.month, fall.day, 6, 0, tzinfo=timezone.utc)
    return sf, fb


def is_dst(d):
    """Is this calendar date on EDT (daylight time)?"""
    spring = nth_weekday(d.year, 3, 6, 2)
    fall = nth_weekday(d.year, 11, 6, 1)
    return spring <= d < fall


def et_offset(d):
    return EDT_OFFSET if is_dst(d) else EST_OFFSET


def to_utc(d, hour, minute):
    """Eastern wall-clock -> UTC epoch seconds."""
    off = et_offset(d)
    naive = datetime(d.year, d.month, d.day, hour, minute, tzinfo=timezone.utc)
    return int((naive - timedelta(hours=off)).timestamp())


# ---------------------------------------------------------------- holidays

def holidays(year):
    """NYSE full-day closures, rule-derived. Returns {date: name}."""
    out = {}

    ny = observed(date(year, 1, 1), is_new_years=True)
    if ny and ny.year == year:
        out[ny] = "New Year's Day"

    out[nth_weekday(year, 1, 0, 3)] = "Martin Luther King Jr. Day"
    out[nth_weekday(year, 2, 0, 3)] = "Washington's Birthday"
    out[easter_sunday(year) - timedelta(days=2)] = "Good Friday"
    out[last_weekday(year, 5, 0)] = "Memorial Day"

    if year >= JUNETEENTH_FIRST_YEAR:
        j = observed(date(year, 6, 19))
        if j:
            out[j] = "Juneteenth National Independence Day"

    i = observed(date(year, 7, 4))
    if i:
        out[i] = "Independence Day"

    out[nth_weekday(year, 9, 0, 1)] = "Labor Day"
    out[nth_weekday(year, 11, 3, 4)] = "Thanksgiving Day"

    c = observed(date(year, 12, 25))
    if c:
        out[c] = "Christmas Day"

    return out


def early_closes(year, hols):
    """
    NYSE 13:00 ET early closes:
      - Friday after Thanksgiving (always)
      - July 3, when it is a weekday and not itself a holiday
      - December 24, when it is a weekday and not itself a holiday
    """
    out = {}

    out[nth_weekday(year, 11, 3, 4) + timedelta(days=1)] = "Day after Thanksgiving"

    for d, label in ((date(year, 7, 3), "Day before Independence Day"),
                     (date(year, 12, 24), "Christmas Eve")):
        if d.weekday() < 5 and d not in hols:
            out[d] = label

    return out


# ---------------------------------------------------------------- validation

# Independently known NYSE closures/early closes, used as regression anchors.
KNOWN_HOLIDAYS = {
    2020: ["2020-01-01", "2020-01-20", "2020-02-17", "2020-04-10", "2020-05-25",
           "2020-07-03", "2020-09-07", "2020-11-26", "2020-12-25"],
    2021: ["2021-01-01", "2021-01-18", "2021-02-15", "2021-04-02", "2021-05-31",
           "2021-07-05", "2021-09-06", "2021-11-25", "2021-12-24"],
    2022: ["2022-01-17", "2022-02-21", "2022-04-15", "2022-05-30", "2022-06-20",
           "2022-07-04", "2022-09-05", "2022-11-24", "2022-12-26"],
    2023: ["2023-01-02", "2023-01-16", "2023-02-20", "2023-04-07", "2023-05-29",
           "2023-06-19", "2023-07-04", "2023-09-04", "2023-11-23", "2023-12-25"],
    2024: ["2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
           "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25"],
    2025: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
           "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25"],
    2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
           "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
}

KNOWN_EARLY = {
    2020: ["2020-11-27", "2020-12-24"],
    2021: ["2021-11-26"],
    2022: ["2022-11-25"],
    2023: ["2023-07-03", "2023-11-24"],
    2024: ["2024-07-03", "2024-11-29", "2024-12-24"],
    2025: ["2025-07-03", "2025-11-28", "2025-12-24"],
    2026: ["2026-11-27", "2026-12-24"],
}

# Closures that NO rule can derive. These must be inserted by hand, via the
# 48h time-lock, when they are announced.
UNSCHEDULED = {
    "2025-01-09": "National Day of Mourning — funeral of Jimmy Carter",
    "2018-12-05": "National Day of Mourning — funeral of George H. W. Bush",
    "2012-10-29": "Hurricane Sandy",
    "2012-10-30": "Hurricane Sandy",
}


def validate():
    errs = []
    for year, expected in KNOWN_HOLIDAYS.items():
        got = sorted(d.isoformat() for d in holidays(year))
        if got != sorted(expected):
            errs.append(f"  {year} holidays:\n    expected {sorted(expected)}\n    got      {got}")
    for year, expected in KNOWN_EARLY.items():
        got = sorted(d.isoformat() for d in early_closes(year, holidays(year)))
        if got != sorted(expected):
            errs.append(f"  {year} early closes:\n    expected {sorted(expected)}\n    got      {got}")
    return errs


# ---------------------------------------------------------------- emit

def build():
    rows, dst_rows = [], []
    for year in range(YEAR_START, YEAR_END + 1):
        hols = holidays(year)
        early = early_closes(year, hols)

        sf, fb = dst_boundaries(year)
        dst_rows.append({"year": year, "kind": "EST->EDT", "utc": sf.isoformat(),
                         "epoch": int(sf.timestamp()), "local": "02:00 EST -> 03:00 EDT"})
        dst_rows.append({"year": year, "kind": "EDT->EST", "utc": fb.isoformat(),
                         "epoch": int(fb.timestamp()), "local": "02:00 EDT -> 01:00 EST"})

        d = date(year, 1, 1)
        while d.year == year:
            if d.weekday() >= 5:
                kind, name = "weekend", ""
            elif d in hols:
                kind, name = "holiday", hols[d]
            elif d in early:
                kind, name = "early_close", early[d]
            else:
                kind, name = "normal", ""

            close_h, close_m = ((EARLY_CLOSE_H, EARLY_CLOSE_M) if kind == "early_close"
                                else (CLOSE_H, CLOSE_M))
            row = {
                "date": d.isoformat(),
                "dow": d.strftime("%a"),
                "kind": kind,
                "name": name,
                "et_offset": et_offset(d),
                "tz": "EDT" if is_dst(d) else "EST",
            }
            if kind in ("normal", "early_close"):
                row["open_utc"] = to_utc(d, OPEN_H, OPEN_M)
                row["close_utc"] = to_utc(d, close_h, close_m)
            else:
                row["open_utc"] = ""
                row["close_utc"] = ""
            rows.append(row)
            d += timedelta(days=1)
    return rows, dst_rows


def main():
    errs = validate()
    print("=" * 68)
    if errs:
        print("VALIDASI GAGAL:")
        print("\n".join(errs))
        raise SystemExit(1)
    print(f"VALIDASI LULUS — {len(KNOWN_HOLIDAYS)} tahun hari libur, "
          f"{len(KNOWN_EARLY)} tahun early close cocok persis")
    print("=" * 68)

    rows, dst_rows = build()
    import os
    out = os.environ.get("OUT_DIR", ".")
    os.makedirs(out, exist_ok=True)

    with open(f"{out}/nyse-sessions.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    with open(f"{out}/dst-boundaries.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(dst_rows[0].keys()))
        w.writeheader()
        w.writerows(dst_rows)

    hol = [r for r in rows if r["kind"] == "holiday"]
    ear = [r for r in rows if r["kind"] == "early_close"]

    with open(f"{out}/calendar-entries.json", "w") as f:
        json.dump({
            "_comment": "CalendarEntry input for SessionManager. kind: 1=holiday, 2=early close.",
            "_official_through": 2028,
            "_warning": "Entries after 2028 are RULE-DERIVED, not published by NYSE. "
                        "Do not load them onchain; use for test fixtures only.",
            "unscheduled_closures_not_derivable": UNSCHEDULED,
            "entries": [
                {"date": r["date"], "days_since_epoch": (date.fromisoformat(r["date"]) - date(1970, 1, 1)).days,
                 "kind": 1 if r["kind"] == "holiday" else 2,
                 "close_time_et_seconds": 0 if r["kind"] == "holiday" else EARLY_CLOSE_H * 3600,
                 "name": r["name"]}
                for r in hol + ear
            ],
        }, f, indent=2)

    trading = [r for r in rows if r["kind"] in ("normal", "early_close")]
    print(f"Rentang            : {YEAR_START}-{YEAR_END} ({YEAR_END - YEAR_START + 1} tahun)")
    print(f"Total hari         : {len(rows)}")
    print(f"Hari dagang        : {len(trading)}")
    print(f"Hari libur         : {len(hol)}")
    print(f"Early close        : {len(ear)}")
    print(f"Batas DST          : {len(dst_rows)}")
    print(f"Penutupan tak terjadwal (tak bisa diturunkan dari aturan): {len(UNSCHEDULED)}")
    print()
    print("Contoh early close (paling sering terlewat):")
    for r in ear[:6]:
        print(f"  {r['date']} {r['dow']}  {r['name']}  tutup {r['close_utc']} UTC")


if __name__ == "__main__":
    main()
