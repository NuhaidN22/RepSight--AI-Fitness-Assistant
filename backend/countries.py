"""Country calling codes and the length of the national number (digits after the country code, without any leading trunk 0).
Lengths are deliberately a little loose where a country has several formats; the hard limit is the ITU rule that the whole number
(country code + national number) is at most 15 digits. The page loads this list from /api/meta/countries, so there is one source of truth."""

# (ISO code, name, calling code, min national digits, max national digits)
COUNTRIES = [
    ("IN", "India", "91", 10, 10), ("US", "United States", "1", 10, 10), ("CA", "Canada", "1", 10, 10),
    ("GB", "United Kingdom", "44", 9, 10), ("AU", "Australia", "61", 9, 9), ("NZ", "New Zealand", "64", 8, 10),
    ("IE", "Ireland", "353", 7, 9), ("AE", "United Arab Emirates", "971", 8, 9), ("SA", "Saudi Arabia", "966", 8, 9),
    ("QA", "Qatar", "974", 7, 8), ("KW", "Kuwait", "965", 7, 8), ("OM", "Oman", "968", 7, 8), ("BH", "Bahrain", "973", 8, 8),
    ("PK", "Pakistan", "92", 9, 10), ("BD", "Bangladesh", "880", 9, 10), ("LK", "Sri Lanka", "94", 9, 9), ("NP", "Nepal", "977", 8, 10),
    ("SG", "Singapore", "65", 8, 8), ("MY", "Malaysia", "60", 8, 10), ("ID", "Indonesia", "62", 8, 12), ("PH", "Philippines", "63", 9, 10),
    ("TH", "Thailand", "66", 8, 9), ("VN", "Vietnam", "84", 9, 10), ("CN", "China", "86", 10, 11), ("HK", "Hong Kong", "852", 8, 8),
    ("JP", "Japan", "81", 9, 10), ("KR", "South Korea", "82", 8, 10), ("TW", "Taiwan", "886", 8, 9),
    ("DE", "Germany", "49", 6, 13), ("FR", "France", "33", 9, 9), ("ES", "Spain", "34", 9, 9), ("IT", "Italy", "39", 6, 11),
    ("NL", "Netherlands", "31", 9, 9), ("BE", "Belgium", "32", 8, 9), ("CH", "Switzerland", "41", 9, 9), ("AT", "Austria", "43", 4, 13),
    ("SE", "Sweden", "46", 7, 13), ("NO", "Norway", "47", 8, 8), ("DK", "Denmark", "45", 8, 8), ("FI", "Finland", "358", 5, 12),
    ("PT", "Portugal", "351", 9, 9), ("PL", "Poland", "48", 9, 9), ("RU", "Russia", "7", 10, 10), ("TR", "Turkey", "90", 10, 10),
    ("UA", "Ukraine", "380", 9, 9), ("GR", "Greece", "30", 10, 10), ("IL", "Israel", "972", 8, 9), ("EG", "Egypt", "20", 9, 10),
    ("ZA", "South Africa", "27", 9, 9), ("NG", "Nigeria", "234", 7, 10), ("KE", "Kenya", "254", 9, 9), ("GH", "Ghana", "233", 9, 9),
    ("MA", "Morocco", "212", 9, 9), ("BR", "Brazil", "55", 10, 11), ("MX", "Mexico", "52", 10, 10), ("AR", "Argentina", "54", 10, 11),
    ("CL", "Chile", "56", 9, 9), ("CO", "Colombia", "57", 10, 10), ("PE", "Peru", "51", 8, 9),
]

BY_CODE = {c[0]: {"code": c[0], "name": c[1], "dial": c[2], "min": c[3], "max": c[4]} for c in COUNTRIES}


def listing() -> list[dict]:
    return list(BY_CODE.values())


def normalize_phone(country: str, raw: str) -> tuple[str | None, str | None]:
    """Returns (E.164 number like '+919876543210', None) or (None, a message for the user)."""
    info = BY_CODE.get(country.strip().upper())
    if not info:
        return None, "Choose a country code"
    text = raw.strip()
    if text.startswith("+") or not all(ch.isdigit() or ch in " -(). " for ch in text):
        return None, "Type the number without the country code, using digits only"
    digits = "".join(ch for ch in text if ch.isdigit())
    if digits.startswith("0"):
        digits = digits[1:]  # the trunk prefix (07..., 098...) is not part of the international number
    if digits.startswith(info["dial"]) and len(digits) > info["max"]:
        digits = digits[len(info["dial"]):]  # they typed the country code again
    if not info["min"] <= len(digits) <= info["max"]:
        want = str(info["min"]) if info["min"] == info["max"] else f"{info['min']} to {info['max']}"
        return None, f"Phone numbers in {info['name']} have {want} digits (without the +{info['dial']} country code)"
    if len(info["dial"]) + len(digits) > 15:
        return None, "That phone number is too long"
    return f"+{info['dial']}{digits}", None
