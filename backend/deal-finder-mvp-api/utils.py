import json
import logging
import os
import re
import time
from urllib.parse import quote, unquote, urlparse

logger = logging.getLogger(__name__)

SUPPORTED_PLATFORMS = {
    "amazon": ["amazon.in", "www.amazon.in"],
    "flipkart": ["flipkart.com", "www.flipkart.com"],
    "myntra": ["myntra.com", "www.myntra.com"],
    "ajio": ["ajio.com", "www.ajio.com"],
    "tatacliq": ["tatacliq.com", "www.tatacliq.com"],
    "reliancedigital": ["reliancedigital.in", "www.reliancedigital.in"],
    "zomato": ["zomato.com", "www.zomato.com"],
    "swiggy": ["swiggy.com", "www.swiggy.com"],
}


def is_probable_url(value: str) -> bool:
    parsed = urlparse((value or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_search_input(value: str) -> str:
    cleaned = (value or "").strip()
    if not cleaned:
        raise ValueError("URL or keyword is required")

    if is_probable_url(cleaned):
        return cleaned

    # Accept plain-text search terms.
    normalized = re.sub(r"\s+", " ", cleaned)
    if len(normalized) < 2:
        raise ValueError("Please enter a more specific keyword")
    return normalized

ALLOWED_HOST_TO_PLATFORM = {
    "amazon.in": "amazon",
    "www.amazon.in": "amazon",
    "flipkart.com": "flipkart",
    "www.flipkart.com": "flipkart",
    "myntra.com": "myntra",
    "www.myntra.com": "myntra",
    "ajio.com": "ajio",
    "www.ajio.com": "ajio",
    "tatacliq.com": "tatacliq",
    "www.tatacliq.com": "tatacliq",
    "reliancedigital.in": "reliancedigital",
    "www.reliancedigital.in": "reliancedigital",
    "zomato.com": "zomato",
    "www.zomato.com": "zomato",
    "swiggy.com": "swiggy",
    "www.swiggy.com": "swiggy",
}


def normalize_and_validate_url(url: str) -> str:
    cleaned = (url or "").strip()
    if not cleaned:
        raise ValueError("URL is required")

    parsed = urlparse(cleaned)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("URL must start with http:// or https://")
    if not parsed.netloc:
        raise ValueError("Invalid URL")

    host = parsed.netloc.lower().split(":", 1)[0]
    # Accept app-generated and direct store URLs
    valid_hosts = list(ALLOWED_HOST_TO_PLATFORM.keys())
    if host not in valid_hosts:
        raise ValueError(
            "Only supported store URLs (Amazon, Flipkart, Myntra, Ajio, etc.) are accepted"
        )

    return cleaned


CATEGORY_TO_PLATFORMS = {
    "smartphones": {"flipkart", "amazon", "myntra"},
    "laptops": {"flipkart", "amazon"},
    "electronics": {"flipkart", "amazon"},
    "watches": {"flipkart", "myntra", "ajio"},
    "headphones": {"flipkart", "amazon", "myntra"},
    "shoes": {"myntra", "ajio", "flipkart"},
    "t-shirts": {"myntra", "ajio", "flipkart"},
    "clothing": {"myntra", "ajio", "flipkart"},
    "apparel": {"myntra", "ajio", "flipkart"},
}


def get_platforms_for_category(category: str) -> set[str]:
    category_key = (category or "").strip().lower()
    for key, platforms in CATEGORY_TO_PLATFORMS.items():
        if key in category_key:
            return platforms.copy()
    return {"flipkart", "amazon", "myntra", "ajio"}


def detect_platform(url: str) -> str:
    parsed = urlparse((url or "").strip())
    host = parsed.netloc.lower().split(":", 1)[0]
    platform = ALLOWED_HOST_TO_PLATFORM.get(host)
    if platform:
        return platform
    return "unknown"


def extract_readable_slug(url: str) -> str:
    """Extract product name from various store URL formats."""
    parsed = urlparse(url)
    path = unquote(parsed.path or "")
    parts = [part for part in path.split("/") if part]

    if not parts:
        return ""

    # Skip known technical path fragments and ID-like tokens.
    blacklist = {"dp", "p", "gp", "product", "itm", "s", "b", "browse"}
    id_pattern = re.compile(r"^(itm[a-z0-9]+|[a-z0-9]{8,}|[a-z0-9]{12,})$", re.IGNORECASE)

    # For Flipkart URLs, the product slug is typically the first segment
    # Format: /{product-name}/p/{product-id}
    # We want to extract the product name cleanly
    product_slug = None
    for i, part in enumerate(parts):
        lowered = part.lower()
        if lowered in blacklist:
            continue
        if id_pattern.match(lowered):
            continue

        product_slug = part
        break

    if not product_slug:
        return ""

    # Clean the slug: remove dashes, underscores, convert to readable text
    candidate = product_slug.replace("-", " ").replace("_", " ")
    candidate = re.sub(r"[^a-zA-Z0-9\s]", " ", candidate)
    candidate = re.sub(r"\s+", " ", candidate).strip()

    if not candidate:
        return ""

    # For URLs, take more words to preserve brand + product type
    # e.g., "giordano analog watch men color variant..." -> extract ~4-5 key words
    words = candidate.split()
    if len(words) > 3:
        # Keep brand + main descriptor, skip style/color modifiers like "men", "color", "variant"
        exclude_modifiers = {"men", "women", "color", "variant", "stylish", "pack", "set", "piece", "pieces"}
        filtered = [w for w in words if w.lower() not in exclude_modifiers]
        if filtered:
            return " ".join(filtered[:4])

    return " ".join(words[:4])


def estimate_reference_price(url: str) -> int:
    # Try to infer a realistic price from URL tokens, then fallback to category heuristics.
    price_candidates = [int(match) for match in re.findall(r"\d{3,6}", url)]
    sensible = [value for value in price_candidates if 500 <= value <= 300000]
    if sensible:
        return sensible[0]

    name = extract_readable_slug(url).lower()
    if any(word in name for word in ["iphone", "samsung", "mobile", "phone"]):
        return 30000
    if any(word in name for word in ["laptop", "notebook", "macbook"]):
        return 55000
    if any(word in name for word in ["shoe", "sneaker", "running"]):
        return 3500
    if any(word in name for word in ["headphone", "earbud", "speaker"]):
        return 2500

    return 5000


# ═══════════════════════════════════════════════════════════════
# URL BUILDERS
# ═══════════════════════════════════════════════════════════════
def build_flipkart_url(query: str, brand: str = None, price_min: int = 0,
                       price_max: int = 999999, discount: int = 0) -> str:
    """Build Flipkart URL with accurate filters"""
    search_terms = []
    if brand and brand.lower() not in ["all", "all brands", ""]:
        search_terms.append(brand)
    search_terms.append(query)
    q = quote(" ".join(search_terms))

    url = f"https://www.flipkart.com/search?q={q}"

    if price_max < 999999:
        url += f"&p%5B%5D=facets.price_range.from%3D{price_min}"
        url += f"&p%5B%5D=facets.price_range.to%3D{price_max}"

    if discount:
        url += f"&p%5B%5D=facets.discount_range%5B%5D%3D{discount}%25+or+more"

    url += "&sort=popularity"
    return url


def build_myntra_url(search: str, brand: str = None, price_min: int = 0,
                     price_max: int = 999999, discount: int = 0, color: str = None) -> str:
    """Build Myntra URL with accurate filters"""
    search_path = search.lower().replace(" ", "-").replace("'", "")
    url = f"https://www.myntra.com/{search_path}"

    params = []

    if brand and brand.lower() not in ["all", "all brands", ""]:
        params.append(f"f=Brand%3A{quote(brand)}")

    if price_max < 999999:
        params.append(f"price={price_min}%2C{price_max}")

    if discount:
        params.append(f"discount={discount}%3A100")

    if color and color.lower() != "any":
        params.append(f"f=Color%3A{quote(color)}")

    params.append("sort=popularity")

    if params:
        url += "?" + "&".join(params)

    return url


def build_ajio_url(query: str, brand: str = None, price_min: int = 0,
                   price_max: int = 999999, discount: int = 0) -> str:
    """Build Ajio URL with filters - simplified to avoid blocks"""
    search_query = query
    if brand and brand.lower() not in ["all", "all brands", ""]:
        search_query = f"{brand} {query}"

    url = f"https://www.ajio.com/search/?text={quote(search_query)}"
    return url


# ═══════════════════════════════════════════════════════════════
# INPUT SANITIZATION
# ═══════════════════════════════════════════════════════════════
def sanitize_input(text: str, max_length: int = 200) -> str:
    """Sanitize user input to prevent injection attacks"""
    if not text:
        return ""
    text = re.sub(r'[<>"\\;{}|]', '', text)
    text = text.strip()[:max_length]
    return text


# ═══════════════════════════════════════════════════════════════
# PRODUCT LOADER (cached)
# ═══════════════════════════════════════════════════════════════
_products_cache = None
_products_loaded_time = 0


def load_products():
    """Return empty list - backend uses live RapidAPI search only."""
    return []
