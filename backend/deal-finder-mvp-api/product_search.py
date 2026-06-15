import asyncio
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv

# Load .env from same directory as this module
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_env_path)

logger = logging.getLogger(__name__)

RAPIDAPI_KEY = os.getenv("RAPIDAPI_KEY", "")
RAPIDAPI_HOST = "real-time-product-search.p.rapidapi.com"
RAPIDAPI_BASE = "https://real-time-product-search.p.rapidapi.com"

TIMEOUT = 30.0


def _sync_call(endpoint: str, params: Dict[str, Any]) -> Dict[str, Any]:
    """Generic synchronous RapidAPI call."""
    headers = {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": RAPIDAPI_HOST,
    }
    url = f"{RAPIDAPI_BASE}/{endpoint.lstrip('/')}"
    try:
        response = httpx.get(url, headers=headers, params=params, timeout=TIMEOUT)
        response.raise_for_status()
        return response.json()
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 429:
            logger.warning("RapidAPI quota exceeded (429)")
        else:
            logger.warning("RapidAPI HTTP error %s: %s", exc.response.status_code, exc)
        return {}
    except Exception as exc:
        logger.warning("RapidAPI call failed: %s", exc)
        return {}


def _parse_api_products(raw_results: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    """Parse raw API results into unified product format."""
    products: List[Dict[str, Any]] = []
    for item in raw_results[:limit]:
        try:
            title = item.get("product_title") or item.get("title", "Unknown Product")

            offer_data = item.get("offer") or {}
            price_raw = offer_data.get("price", "")
            price = _extract_price(price_raw)

            # Get original price: offer.original_price → typical_price_range upper bound → current price
            original_price_raw = offer_data.get("original_price", "")
            original_price = _extract_price(original_price_raw)

            if original_price == 0:
                typical_range = item.get("typical_price_range", [])
                if typical_range and len(typical_range) >= 2:
                    original_price = _extract_price(typical_range[1])

            if original_price == 0:
                original_price = price

            # Calculate discount percentage
            discount = 0
            if original_price > 0 and price > 0 and original_price > price:
                discount = int(round((original_price - price) / original_price * 100))

            link = offer_data.get("offer_page_url") or item.get("product_page_url") or item.get("url", "")
            image = item.get("product_photos", [""])[0] if item.get("product_photos") else item.get("thumbnail", "")
            rating = item.get("product_rating") or item.get("rating", 0)
            reviews = item.get("product_num_reviews") or item.get("reviews_count", 0)
            source = offer_data.get("store_name") or item.get("source") or item.get("merchant", {}).get("name", "Unknown")

            if not title or not link:
                continue

            platform = _map_source_to_platform(str(source).lower())

            products.append({
                "id": f"api-{hash(link) & 0x7FFFFFFF}",
                "platform": platform,
                "category": "Unknown",
                "brand": "",
                "title": title,
                "description": title,
                "original_price": original_price,
                "price": price,
                "discount": discount,
                "rating": float(rating) if rating else 0,
                "reviews": int(reviews) if reviews else 0,
                "image": image,
                "affiliate_url": link,
            })
        except Exception as exc:
            logger.debug("Product parse error: %s", exc)
            continue
    return products


async def search_products_api(
    query: str,
    limit: int = 10,
    country: str = "in",
    language: str = "en",
) -> List[Dict[str, Any]]:
    """
    Search real products via RapidAPI /search-v2 (full details).
    """
    if not RAPIDAPI_KEY:
        logger.warning("RAPIDAPI_KEY not set; skipping live product search")
        return []

    data = await asyncio.to_thread(
        _sync_call,
        "search",
        {"q": query, "country": country, "language": language, "limit": str(min(limit, 20))},
    )

    raw_results = data.get("data", {}).get("products", []) or data.get("products", []) or []
    products = _parse_api_products(raw_results, limit)
    logger.info("RapidAPI search: found %d products for '%s'", len(products), query)
    return products


async def search_deals_api(
    query: str = "deals",
    limit: int = 10,
    country: str = "in",
    language: str = "en",
) -> List[Dict[str, Any]]:
    """
    Search deals via RapidAPI /search endpoint with deals query.
    """
    if not RAPIDAPI_KEY:
        return []

    data = await asyncio.to_thread(
        _sync_call,
        "search",
        {"q": query, "country": country, "language": language, "limit": str(min(limit, 20))},
    )

    raw_results = data.get("data", {}).get("products", []) or data.get("products", []) or []
    products = _parse_api_products(raw_results, limit)
    logger.info("RapidAPI deals search: found %d deals for '%s'", len(products), query)
    return products


def _extract_price(price_text: Any) -> int:
    """Extract numeric price from string like 'Rs. 79,900' or '$999'"""
    import re
    if isinstance(price_text, (int, float)):
        return int(price_text)
    if not price_text:
        return 0
    text = str(price_text)
    # Remove currency symbols and commas, extract digits
    cleaned = re.sub(r"[^\d.]", "", text.replace(",", ""))
    try:
        return int(float(cleaned))
    except ValueError:
        return 0


def _map_source_to_platform(source: str) -> str:
    """Map API source name to internal platform name"""
    source_lower = source.lower()
    if "flipkart" in source_lower:
        return "Flipkart"
    if "amazon" in source_lower:
        return "Amazon"
    if "myntra" in source_lower:
        return "Myntra"
    if "ajio" in source_lower:
        return "Ajio"
    if "tatacliq" in source_lower:
        return "TataCliq"
    if "reliance" in source_lower:
        return "RelianceDigital"
    # Capitalize first letter as fallback
    return source.capitalize() if source else "Unknown"
