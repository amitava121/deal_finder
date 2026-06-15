import asyncio
import json
import logging
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib.parse import quote_plus

from utils import extract_readable_slug, is_probable_url, get_platforms_for_category
from affiliate import convert_to_affiliate
from scraper import scrape_all
from product_search import search_products_api

logger = logging.getLogger(__name__)

_PRODUCT_CACHE: List[Dict[str, Any]] | None = None
_PRODUCT_PATHS = (
    Path(__file__).with_name("products.json"),
    Path(__file__).resolve().parents[1] / "smart-product-finder-api" / "products.json",
)

_STOPWORDS = {
    "for",
    "with",
    "and",
    "the",
    "inch",
    "gb",
    "men",
    "women",
    "pack",
    "black",
    "blue",
    "white",
    "buy",
    "original",
    "new",
}


def _load_products() -> List[Dict[str, Any]]:
    global _PRODUCT_CACHE
    if _PRODUCT_CACHE is not None:
        return _PRODUCT_CACHE

    for path in _PRODUCT_PATHS:
        if path.exists():
            with path.open("r", encoding="utf-8") as handle:
                parsed = json.load(handle)
            if isinstance(parsed, list):
                _PRODUCT_CACHE = parsed
                return _PRODUCT_CACHE

    _PRODUCT_CACHE = []
    return _PRODUCT_CACHE


def _clean_text(text: str) -> str:
    normalized = re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _tokenize(text: str) -> List[str]:
    tokens = [token for token in _clean_text(text).split(" ") if token and token not in _STOPWORDS]
    return tokens


def _extract_query_text(user_input: str) -> str:
    candidate = (user_input or "").strip()
    if not candidate:
        return ""
    if is_probable_url(candidate):
        slug = extract_readable_slug(candidate)
        if slug:
            return slug
    return candidate


def _product_text(product: Dict[str, Any]) -> str:
    return " ".join(
        [
            str(product.get("title", "")),
            str(product.get("brand", "")),
            str(product.get("category", "")),
            str(product.get("platform", "")),
            str(product.get("description", "")),
        ]
    )


def _similarity(a: str, b: str) -> float:
    a_clean = _clean_text(a)
    b_clean = _clean_text(b)
    if not a_clean or not b_clean:
        return 0.0

    seq_score = SequenceMatcher(None, a_clean, b_clean).ratio()
    a_tokens = set(_tokenize(a_clean))
    b_tokens = set(_tokenize(b_clean))
    overlap_score = (len(a_tokens & b_tokens) / len(a_tokens)) if a_tokens else 0.0
    return (seq_score * 0.45) + (overlap_score * 0.55)


def _infer_preferred_brand(query_text: str, products: List[Dict[str, Any]]) -> str:
    query_tokens = set(_tokenize(query_text))
    if not query_tokens:
        return ""

    best_brand = ""
    best_overlap = 0
    for product in products:
        brand = str(product.get("brand", "")).strip()
        brand_tokens = set(_tokenize(brand))
        overlap = len(query_tokens & brand_tokens)
        if overlap > best_overlap:
            best_overlap = overlap
            best_brand = brand
    return best_brand if best_overlap > 0 else ""


def _find_anchor_product(
    query_text: str,
    products: List[Dict[str, Any]],
    preferred_brand: str,
) -> Tuple[Dict[str, Any], float]:
    best_product: Dict[str, Any] | None = None
    best_score = 0.0
    brand_key = _clean_text(preferred_brand)
    for product in products:
        score = _similarity(query_text, _product_text(product))
        product_brand = _clean_text(str(product.get("brand", "")))
        if brand_key:
            if product_brand == brand_key:
                score += 0.2
            else:
                score -= 0.08
        if score > best_score:
            best_score = score
            best_product = product
    return (best_product or {}), best_score


def _group_best_by_platform(
    anchor: Dict[str, Any],
    products: List[Dict[str, Any]],
    preferred_brand: str,
) -> List[Dict[str, Any]]:
    anchor_text = _product_text(anchor)
    best_by_platform: Dict[str, Tuple[float, Dict[str, Any]]] = {}
    brand_key = _clean_text(preferred_brand)

    for product in products:
        sim = _similarity(anchor_text, _product_text(product))
        if sim < 0.32:
            continue

        if brand_key:
            product_brand = _clean_text(str(product.get("brand", "")))
            if product_brand != brand_key:
                continue

        platform = str(product.get("platform", "Unknown"))
        existing = best_by_platform.get(platform)
        if existing is None or sim > existing[0] or (
            sim == existing[0] and int(product.get("price", 10**9)) < int(existing[1].get("price", 10**9))
        ):
            best_by_platform[platform] = (sim, product)

    selected = [item[1] for item in best_by_platform.values()]
    selected.sort(key=lambda item: int(item.get("price", 10**9)))
    return selected


def _group_relaxed_by_platform(query_text: str, products: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best_by_platform: Dict[str, Tuple[float, Dict[str, Any]]] = {}
    for product in products:
        sim = _similarity(query_text, _product_text(product))
        if sim < 0.16:
            continue
        platform = str(product.get("platform", "Unknown"))
        existing = best_by_platform.get(platform)
        if existing is None or sim > existing[0] or (
            sim == existing[0] and int(product.get("price", 10**9)) < int(existing[1].get("price", 10**9))
        ):
            best_by_platform[platform] = (sim, product)

    selected = [item[1] for item in best_by_platform.values()]
    selected.sort(key=lambda item: int(item.get("price", 10**9)))
    return selected


def _fill_platform_gaps(
    anchor: Dict[str, Any],
    products: List[Dict[str, Any]],
    current: List[Dict[str, Any]],
    min_platforms: int = 3,
) -> List[Dict[str, Any]]:
    return list(current)


def _synthetic_platform_cards(
    query_text: str,
    products: List[Dict[str, Any]],
    existing_platforms: set[str],
    base_price: int,
    anchor_category: str = "",
    target_platforms: int = 3,
) -> List[Dict[str, Any]]:
    synthetic_items: List[Dict[str, Any]] = []
    allowed_platforms = get_platforms_for_category(anchor_category) if anchor_category else None
    ordered_platforms: List[str] = []
    seen: set[str] = set()
    for item in products:
        platform = str(item.get("platform", "")).strip()
        if not platform:
            continue
        platform_key = platform.lower()
        if platform_key in seen:
            continue
        if allowed_platforms and platform_key not in allowed_platforms:
            continue
        seen.add(platform_key)
        ordered_platforms.append(platform)

    step = max(100, int(base_price * 0.03))
    rank = 1
    for platform in ordered_platforms:
        platform_key = platform.lower()
        if platform_key in existing_platforms:
            continue

        synthetic_items.append(
            {
                "id": f"synthetic-{platform_key}",
                "platform": platform,
                "title": f"{query_text} on {platform}",
                "price": int(base_price + (step * rank)),
                "affiliate_url": _build_store_search_link(platform, query_text, ""),
            }
        )
        rank += 1
        if len(existing_platforms) + len(synthetic_items) >= target_platforms:
            break

    return synthetic_items


def fallback_discovery_results(limit: int = 5) -> List[Dict[str, Any]]:
    products = _load_products()
    best_by_platform: Dict[str, Dict[str, Any]] = {}
    for product in products:
        platform = str(product.get("platform", "Unknown"))
        existing = best_by_platform.get(platform)
        if existing is None or int(product.get("price", 10**9)) < int(existing.get("price", 10**9)):
            best_by_platform[platform] = product

    selected = sorted(best_by_platform.values(), key=lambda item: int(item.get("price", 10**9)))
    return _to_deal_items(selected[:limit])


def _build_store_search_link(platform: str, title: str, fallback_link: str) -> str:
    platform_key = (platform or "").strip().lower()
    query = quote_plus(_clean_text(title) or title or "product")

    if platform_key == "flipkart":
        return f"https://www.flipkart.com/search?q={query}"
    if platform_key == "amazon":
        return f"https://www.amazon.in/s?k={query}"
    if platform_key == "myntra":
        return f"https://www.myntra.com/{query.replace('+', '-') }"
    if platform_key == "ajio":
        return f"https://www.ajio.com/search/?text={query}"
    if platform_key == "tatacliq":
        return f"https://www.tatacliq.com/search/?searchCategory=all&text={query}"
    if platform_key == "reliancedigital":
        return f"https://www.reliancedigital.in/search?q={query}"

    return fallback_link or ""


def _looks_reliable_product_link(platform: str, link: str) -> bool:
    value = (link or "").strip().lower()
    if not value.startswith("http"):
        return False

    platform_key = (platform or "").strip().lower()
    if platform_key == "flipkart":
        return "flipkart.com" in value and "/p/" in value
    if platform_key == "myntra":
        return "myntra.com" in value and "/buy" in value
    if platform_key == "amazon":
        return "amazon." in value and ("/dp/" in value or "/gp/" in value)
    if platform_key == "ajio":
        return "ajio.com" in value and "/p/" in value

    return True


def _to_deal_items(products: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not products:
        return []

    best_price = int(min(int(p.get("price", 0)) for p in products))
    deals: List[Dict[str, Any]] = []
    for product in products:
        price = int(product.get("price", 0))
        platform = str(product.get("platform", "Unknown"))
        product_name = str(product.get("title", "Unknown Product"))
        original_link = str(product.get("affiliate_url", "")).strip()
        final_link = _build_store_search_link(platform, product_name, original_link)
        if platform.strip().lower() != "flipkart" and _looks_reliable_product_link(platform, original_link):
            final_link = original_link

        deals.append(
            {
                "name": product_name,
                "platform": platform,
                "price": price,
                "price_difference": price - best_price,
                "link": final_link,
            }
        )
    return deals


def _scraped_to_deal_items(scraped: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert scraped product dicts to frontend DealItem format."""
    if not scraped:
        return []

    best_price = min(int(p.get("price", 0)) for p in scraped if p.get("price", 0) > 0) or 0

    deals: List[Dict[str, Any]] = []
    for product in scraped:
        price = int(product.get("price", 0))
        platform = str(product.get("platform", "Unknown"))
        product_name = str(product.get("title", "Unknown Product"))
        link = str(product.get("affiliate_url", "")).strip()

        deals.append(
            {
                "name": product_name,
                "platform": platform,
                "price": price,
                "price_difference": price - best_price if price > best_price else 0,
                "link": link,
            }
        )
    return deals


async def fetch_cheaper_alternatives(
    reference_price: int,
    original_url: str,
    limit: int = 5,
    is_direct_url: bool = False,
) -> List[Dict[str, Any]]:
    # Keep async behavior so endpoint flow remains non-blocking.
    await asyncio.sleep(0.05)

    products = _load_products()
    if not products:
        return [
            {
                "name": "Best Deal",
                "platform": "Unknown",
                "price": int(reference_price),
                "price_difference": 0,
                "link": original_url,
            }
        ][:limit]

    query_text = _extract_query_text(original_url)
    if not query_text:
        return []

    # For text queries (not URLs), try live API first for real product data
    if not is_direct_url:
        # ── Try RapidAPI product search first ──
        try:
            api_results = await search_products_api(query_text, limit=limit)
            if api_results:
                for item in api_results:
                    if item.get("affiliate_url"):
                        item["affiliate_url"] = await convert_to_affiliate(item["affiliate_url"])
                deals = _scraped_to_deal_items(api_results)
                return deals[:limit]
        except Exception as exc:
            logger.warning("Product search API failed for '%s': %s", query_text, exc)

        # ── Try web scraper as second fallback ──
        try:
            scraped = await scrape_all(query_text, limit_per_platform=3)
            if scraped:
                for item in scraped:
                    if item.get("affiliate_url"):
                        item["affiliate_url"] = await convert_to_affiliate(item["affiliate_url"])
                deals = _scraped_to_deal_items(scraped)
                return deals[:limit]
        except Exception as exc:
            logger.warning("Scraper failed for '%s': %s", query_text, exc)

    # For direct URLs or if live APIs failed, use static catalog
    preferred_brand = _infer_preferred_brand(query_text, products)
    anchor, anchor_score = _find_anchor_product(query_text, products, preferred_brand)

    # For direct URLs, require higher match confidence
    min_score = 0.30 if is_direct_url else 0.18

    if not anchor or anchor_score < min_score:
        if is_direct_url:
            return []
        # ── Final fallback to static catalog ──
        fallback_deals = _to_deal_items(_group_relaxed_by_platform(query_text, products))
        return fallback_deals[:limit]

    matched_products = _group_best_by_platform(anchor, products, preferred_brand)
    if len({str(item.get("platform", "")).lower() for item in matched_products}) < 2:
        relaxed = _group_relaxed_by_platform(query_text, products)
        merged = {str(item.get("id", "")): item for item in matched_products}
        for item in relaxed:
            merged[str(item.get("id", ""))] = item
        matched_products = list(merged.values())

    matched_products = _fill_platform_gaps(anchor, products, matched_products, min_platforms=3)

    if anchor not in matched_products:
        matched_products.insert(0, anchor)

    existing_platforms = {str(item.get("platform", "")).lower() for item in matched_products}
    anchor_category = str(anchor.get("category", "")).strip()
    if len(existing_platforms) < 3:
        anchor_price = int(anchor.get("price", reference_price) or reference_price)
        matched_products.extend(
            _synthetic_platform_cards(
                query_text=query_text,
                products=products,
                existing_platforms=existing_platforms,
                base_price=anchor_price,
                anchor_category=anchor_category,
                target_platforms=3,
            )
        )

    deals = _to_deal_items(matched_products)
    return deals[:limit]
