import asyncio
import logging
import random
import re
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urljoin

import httpx
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
]

SCRAPER_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


def _get_headers() -> Dict[str, str]:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
    }


def _clean_price(text: str) -> int:
    """Extract numeric price from text like Rs. 1,299 or 1299"""
    if not text:
        return 0
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else 0


def _clean_title(text: str) -> str:
    """Clean product title"""
    if not text:
        return "Unknown Product"
    text = re.sub(r"\s+", " ", text.strip())
    return text[:120]


async def scrape_flipkart(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Scrape Flipkart search results"""
    search_url = f"https://www.flipkart.com/search?q={quote(query)}&sort=popularity"

    async with httpx.AsyncClient(timeout=SCRAPER_TIMEOUT, follow_redirects=True) as client:
        try:
            await asyncio.sleep(random.uniform(0.3, 0.8))
            response = await client.get(search_url, headers=_get_headers())
            response.raise_for_status()
        except Exception as exc:
            logger.warning("Flipkart scrape failed: %s", exc)
            return []

    soup = BeautifulSoup(response.text, "lxml")
    products: List[Dict[str, Any]] = []

    # Flipkart product containers
    containers = soup.select("div[data-id]") or soup.select("._1AtVbE") or soup.select(".slAVV4")

    for container in containers[:limit]:
        try:
            # Title
            title_elem = (
                container.select_one("a[title]")
                or container.select_one(".IRpwTa")
                or container.select_one("._4rR01T")
                or container.select_one(".s1Q9rs")
                or container.select_one("a")
            )
            title = _clean_title(title_elem.get("title") or title_elem.get_text() if title_elem else "")
            if not title or len(title) < 3:
                continue

            # Link
            link_elem = container.select_one("a[href]")
            href = link_elem.get("href", "") if link_elem else ""
            link = urljoin("https://www.flipkart.com", href) if href else ""

            # Price
            price_elem = (
                container.select_one("._30jeq3")
                or container.select_one(".Nx9bqj")
                or container.select_one("._1_WHN1")
            )
            price = _clean_price(price_elem.get_text() if price_elem else "")

            # Original price
            original_price_elem = (
                container.select_one("._3I9_wc")
                or container.select_one(".yRaY8j")
            )
            original_price = _clean_price(original_price_elem.get_text() if original_price_elem else "")

            # Rating
            rating_elem = container.select_one("._3LWZlK") or container.select_one(".XQDdHH")
            rating_text = rating_elem.get_text() if rating_elem else ""
            rating_match = re.search(r"(\d+(?:\.\d+)?)", rating_text)
            rating = float(rating_match.group(1)) if rating_match else 0.0

            # Image
            img_elem = container.select_one("img[src]")
            image = img_elem.get("src", "") if img_elem else ""

            if price <= 0:
                continue

            discount = 0
            if original_price > price:
                discount = int(((original_price - price) / original_price) * 100)

            products.append({
                "id": f"flipkart-{hash(link) & 0x7FFFFFFF}",
                "platform": "Flipkart",
                "category": "Unknown",
                "brand": "",
                "title": title,
                "description": title,
                "original_price": original_price or price,
                "price": price,
                "discount": discount,
                "rating": rating,
                "reviews": 0,
                "image": image,
                "affiliate_url": link,
            })
        except Exception as exc:
            logger.debug("Flipkart item parse error: %s", exc)
            continue

    logger.info("Flipkart scrape: found %d products for '%s'", len(products), query)
    return products


async def scrape_amazon(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Scrape Amazon.in search results"""
    search_url = f"https://www.amazon.in/s?k={quote(query)}&s=review-rank"

    async with httpx.AsyncClient(timeout=SCRAPER_TIMEOUT, follow_redirects=True) as client:
        try:
            await asyncio.sleep(random.uniform(0.3, 0.8))
            response = await client.get(search_url, headers=_get_headers())
            response.raise_for_status()
        except Exception as exc:
            logger.warning("Amazon scrape failed: %s", exc)
            return []

    soup = BeautifulSoup(response.text, "lxml")
    products: List[Dict[str, Any]] = []

    containers = soup.select("[data-component-type='s-search-result']")

    for container in containers[:limit]:
        try:
            # Title
            title_elem = container.select_one("h2 a span") or container.select_one(".a-size-base-plus")
            title = _clean_title(title_elem.get_text() if title_elem else "")
            if not title or len(title) < 3:
                continue

            # Link
            link_elem = container.select_one("h2 a")
            href = link_elem.get("href", "") if link_elem else ""
            link = urljoin("https://www.amazon.in", href) if href else ""

            # Price
            price_elem = (
                container.select_one(".a-price .a-offscreen")
                or container.select_one("span.a-price-whole")
            )
            price_text = price_elem.get_text() if price_elem else ""
            price = _clean_price(price_text)

            # Original price ( struck through )
            original_elem = container.select_one("span.a-text-price .a-offscreen")
            original_price = _clean_price(original_elem.get_text() if original_elem else "")

            # Rating
            rating_elem = container.select_one("span.a-icon-alt")
            rating_text = rating_elem.get_text() if rating_elem else ""
            rating_match = re.search(r"(\d+(?:\.\d+)?)", rating_text)
            rating = float(rating_match.group(1)) if rating_match else 0.0

            # Reviews count
            reviews_elem = container.select_one("a[href*='reviews'] span")
            reviews_text = reviews_elem.get_text() if reviews_elem else ""
            reviews = _clean_price(reviews_text)

            # Image
            img_elem = container.select_one("img[src]")
            image = img_elem.get("src", "") if img_elem else ""

            if price <= 0:
                continue

            discount = 0
            if original_price > price:
                discount = int(((original_price - price) / original_price) * 100)

            products.append({
                "id": f"amazon-{hash(link) & 0x7FFFFFFF}",
                "platform": "Amazon",
                "category": "Unknown",
                "brand": "",
                "title": title,
                "description": title,
                "original_price": original_price or price,
                "price": price,
                "discount": discount,
                "rating": rating,
                "reviews": reviews,
                "image": image,
                "affiliate_url": link,
            })
        except Exception as exc:
            logger.debug("Amazon item parse error: %s", exc)
            continue

    logger.info("Amazon scrape: found %d products for '%s'", len(products), query)
    return products


async def scrape_all(query: str, limit_per_platform: int = 5) -> List[Dict[str, Any]]:
    """Scrape all supported platforms concurrently"""
    results = await asyncio.gather(
        scrape_flipkart(query, limit=limit_per_platform),
        scrape_amazon(query, limit=limit_per_platform),
        return_exceptions=True,
    )

    all_products: List[Dict[str, Any]] = []
    for result in results:
        if isinstance(result, list):
            all_products.extend(result)

    # Sort by price ascending
    all_products.sort(key=lambda x: x.get("price", float("inf")))
    return all_products
