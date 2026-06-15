import asyncio
import hashlib
import logging
import os
import time
from collections import defaultdict
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from affiliate import close_affiliate_http_client, convert_to_affiliate
from cache import get_cache, set_cache
from redis_cache import get_cache as redis_get, set_cache as redis_set
from product_search import search_deals_api, search_products_api
from search import fetch_cheaper_alternatives, fallback_discovery_results
from utils import (
    build_ajio_url,
    build_flipkart_url,
    build_myntra_url,
    estimate_reference_price,
    load_products,
    normalize_search_input,
    sanitize_input,
)
from preprocess import InputHandler, get_rewriter
import database as db

# Configure app-level logging so INFO messages are visible
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Deal Finder API",
    description="API for finding deals from Flipkart, Myntra, Amazon with affiliate links",
    version="2.0.0",
)

# ═══════════════════════════════════════════════════════════════
# RATE LIMITING
# ═══════════════════════════════════════════════════════════════
class RateLimiter:
    def __init__(self, requests_per_minute: int = 60):
        self.requests_per_minute = requests_per_minute
        self.requests = defaultdict(list)

    def is_allowed(self, client_ip: str) -> bool:
        now = time.time()
        minute_ago = now - 60
        self.requests[client_ip] = [t for t in self.requests[client_ip] if t > minute_ago]
        if len(self.requests[client_ip]) >= self.requests_per_minute:
            return False
        self.requests[client_ip].append(now)
        return True

    def cleanup(self):
        now = time.time()
        minute_ago = now - 60
        to_delete = [ip for ip, times in self.requests.items() if all(t < minute_ago for t in times)]
        for ip in to_delete:
            del self.requests[ip]


rate_limiter = RateLimiter(requests_per_minute=60)

# ═══════════════════════════════════════════════════════════════
# CORS
# ═══════════════════════════════════════════════════════════════
ALLOWED_ORIGINS = [
    "https://animeshtrader62-hash.github.io",
    "http://localhost:3000",
    "http://localhost:8000",
    "http://localhost:8080",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
    "http://127.0.0.1:8080",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:59014",
    "http://localhost:59014",
    "https://smart-deal-finder.netlify.app",
    "https://*.trycloudflare.com",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "Accept", "Authorization"],
)

# ═══════════════════════════════════════════════════════════════
# RATE LIMIT MIDDLEWARE
# ═══════════════════════════════════════════════════════════════
@app.middleware("http")
async def rate_limit_middleware(request: Request, call_next):
    client_ip = request.client.host if request.client else "unknown"
    if not rate_limiter.is_allowed(client_ip):
        return JSONResponse(
            status_code=429,
            content={"success": False, "message": "Too many requests. Please wait."},
        )
    response = await call_next(request)
    return response


class SearchRequest(BaseModel):
    query: Optional[str] = None
    url: Optional[str] = None


class DealItem(BaseModel):
    name: str
    platform: str
    price: int
    price_difference: int
    link: str


class ConvertRequest(BaseModel):
    url: str


class DirectLinkRequest(BaseModel):
    store: str  # flipkart or myntra
    query: str
    brand: Optional[str] = None
    price_min: Optional[int] = 0
    price_max: Optional[int] = 999999
    discount: Optional[int] = 0
    color: Optional[str] = None


# ═══════════════════════════════════════════════════════════════
# HEALTH
# ═══════════════════════════════════════════════════════════════
@app.get("/")
async def health() -> dict:
    products = load_products()
    return {
        "status": "ok",
        "service": "deal-finder-api",
        "version": "2.0.0",
        "total_products": len(products),
        "endpoints": {
            "search": "/search",
            "categories": "/categories",
            "platforms": "/platforms",
            "brands": "/brands",
            "deals": "/deals",
            "convert": "/convert",
            "generate-link": "/generate-link",
            "docs": "/docs",
        },
    }


# ═══════════════════════════════════════════════════════════════
# STARTUP
# ═══════════════════════════════════════════════════════════════
@app.on_event("startup")
async def startup_event() -> None:
    db.init_db()


# ═══════════════════════════════════════════════════════════════
# SHUTDOWN
# ═══════════════════════════════════════════════════════════════
@app.on_event("shutdown")
async def shutdown_event() -> None:
    await close_affiliate_http_client()


@app.post("/search", response_model=List[DealItem])
async def search_deals(payload: SearchRequest) -> List[DealItem]:
    user_input = payload.query or payload.url or ""
    try:
        normalized_input = normalize_search_input(user_input)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cache_key = f"search:v3:{normalized_input.lower()}"

    cached_result = get_cache(cache_key)
    if cached_result is not None:
        return cached_result

    from utils import is_probable_url
    is_direct_url = is_probable_url(normalized_input)

    reference_price = estimate_reference_price(normalized_input)
    results = await fetch_cheaper_alternatives(
        reference_price,
        original_url=normalized_input,
        limit=8,
        is_direct_url=is_direct_url,
    )
    if not results:
        if is_direct_url:
            raise HTTPException(
                status_code=400,
                detail="Product from this URL not found in our catalog. Try searching by product name instead."
            )
        results = fallback_discovery_results(limit=5)
        if not results:
            raise HTTPException(status_code=400, detail="No relevant products found. Try a more specific keyword or product URL.")

    for item in results:
        if item["link"]:
            item["link"] = await convert_to_affiliate(item["link"])

    set_cache(cache_key, results, ttl_seconds=600)
    return results


# ═══════════════════════════════════════════════════════════════
# CATALOG ENDPOINTS (ported from smart-product-finder-api)
# ═══════════════════════════════════════════════════════════════
@app.get("/search-catalog")
def search_catalog(
    q: Optional[str] = Query(None, description="Full text search query", max_length=200),
    platform: Optional[str] = Query(None, description="Platform: Flipkart, Myntra, Ajio"),
    category: Optional[str] = Query(None, description="Category: Smartphones, Laptops, Shoes, etc.", max_length=100),
    brand: Optional[str] = Query(None, description="Brand name", max_length=100),
    min_price: Optional[int] = Query(None, description="Minimum price", ge=0),
    max_price: Optional[int] = Query(None, description="Maximum price", ge=0),
    min_discount: Optional[int] = Query(None, description="Minimum discount percentage", ge=0, le=100),
    min_rating: Optional[float] = Query(None, description="Minimum rating", ge=0, le=5),
    sort_by: Optional[str] = Query(None, description="Sort by: price_low, price_high, discount, rating"),
    limit: Optional[int] = Query(50, description="Maximum results to return", ge=1, le=100),
):
    """
    Search products with multiple filters and full-text search.
    Returns matching products with affiliate links.
    """
    products = load_products()
    results = products.copy()

    q = sanitize_input(q) if q else None
    platform = sanitize_input(platform, 20) if platform else None
    category = sanitize_input(category, 100) if category else None
    brand = sanitize_input(brand, 100) if brand else None

    valid_sorts = ["price_low", "price_high", "discount", "rating", None]
    if sort_by not in valid_sorts:
        sort_by = None

    if q:
        q_lower = q.lower()
        results = [
            p for p in results
            if q_lower in p.get("title", "").lower()
            or q_lower in p.get("brand", "").lower()
            or q_lower in p.get("category", "").lower()
            or q_lower in p.get("description", "").lower()
        ]

    if platform:
        results = [p for p in results if p["platform"].lower() == platform.lower()]

    if category:
        results = [p for p in results if category.lower() in p["category"].lower()]

    if brand:
        results = [p for p in results if brand.lower() in p["brand"].lower()]

    if min_price is not None:
        results = [p for p in results if p["price"] >= min_price]

    if max_price is not None:
        results = [p for p in results if p["price"] <= max_price]

    if min_discount is not None:
        results = [p for p in results if p["discount"] >= min_discount]

    if min_rating is not None:
        results = [p for p in results if p["rating"] >= min_rating]

    if sort_by:
        if sort_by == "price_low":
            results.sort(key=lambda x: x["price"])
        elif sort_by == "price_high":
            results.sort(key=lambda x: x["price"], reverse=True)
        elif sort_by == "discount":
            results.sort(key=lambda x: x["discount"], reverse=True)
        elif sort_by == "rating":
            results.sort(key=lambda x: x["rating"], reverse=True)

    results = results[:limit]

    return {
        "success": True,
        "count": len(results),
        "filters_applied": {
            "q": q,
            "platform": platform,
            "category": category,
            "brand": brand,
            "min_price": min_price,
            "max_price": max_price,
            "min_discount": min_discount,
            "min_rating": min_rating,
            "sort_by": sort_by,
        },
        "products": results,
    }


@app.get("/search")
async def search_products(
    q: Optional[str] = Query(None, description="Search query", max_length=200),
    platform: Optional[str] = Query(None, description="Platform filter"),
    category: Optional[str] = Query(None, description="Category filter", max_length=100),
    brand: Optional[str] = Query(None, description="Brand filter", max_length=100),
    min_price: Optional[int] = Query(None, description="Minimum price", ge=0),
    max_price: Optional[int] = Query(None, description="Maximum price", ge=0),
    min_discount: Optional[int] = Query(None, description="Minimum discount %", ge=0, le=100),
    min_rating: Optional[float] = Query(None, description="Minimum rating", ge=0, le=5),
    sort_by: Optional[str] = Query(None, description="Sort by: price_low, price_high, discount, rating"),
    limit: Optional[int] = Query(50, ge=1, le=100),
):
    """Search products — tries live RapidAPI first, falls back to static catalog"""
    q = sanitize_input(q) if q else None
    platform = sanitize_input(platform, 20) if platform else None
    category = sanitize_input(category, 100) if category else None
    brand = sanitize_input(brand, 100) if brand else None

    valid_sorts = ["price_low", "price_high", "discount", "rating", None]
    if sort_by not in valid_sorts:
        sort_by = None

    # ═══════════════════════════════════════════════════════════════
    # PREPROCESSING PIPELINE (Steps 1-2)
    # ═══════════════════════════════════════════════════════════════
    search_query = q
    if q:
        # Check Redis for cached query transformation (10 hours)
        transform_key = f"query_transform:{q}"
        cached_transform = redis_get(transform_key)
        if cached_transform:
            logger.info("Query transform cache hit: '%s' -> '%s'", q, cached_transform)
            search_query = cached_transform
        else:
            try:
                # Step 1: Input Handler - detect URLs, extract product names
                input_handler = InputHandler()
                input_result = input_handler.process(q)
                extracted_query = input_result.get('query_text', q)
                logger.info("Input preprocessing: '%s' -> '%s' (type: %s)", q, extracted_query, input_result.get('input_type', 'text'))

                # Step 2: Query Rewriter - fix spelling, optimize for search
                rewriter = get_rewriter()
                rewritten = await rewriter.rewrite_async(extracted_query)
                if rewritten and rewritten != extracted_query:
                    logger.info("Query rewrite: '%s' -> '%s'", extracted_query, rewritten)
                    search_query = rewritten
                else:
                    search_query = extracted_query

                # Cache transformation for 10 hours
                redis_set(transform_key, search_query, ttl_seconds=36000)
            except Exception as exc:
                logger.warning("Preprocessing failed: %s", exc)
                search_query = q

    # Build cache key from TRANSFORMED query + filters + API key hash
    # Including API key hash ensures cache is invalidated when key changes
    api_key_hash = hashlib.md5(os.getenv("RAPIDAPI_KEY", "").encode()).hexdigest()[:8]
    cache_key = f"search:{api_key_hash}:{search_query}:{platform}:{category}:{brand}:{min_price}:{max_price}:{min_discount}:{min_rating}:{sort_by}:{limit}"

    # Try Redis search results cache first (10 hours)
    cached = redis_get(cache_key)
    if cached:
        return cached

    # Try live API with transformed query
    if search_query:
        try:
            api_results = await search_products_api(search_query, limit=min(limit or 20, 20), country="in")
            if api_results:
                # Convert URLs to affiliate links concurrently with timeout
                async def _convert(url: str) -> str:
                    try:
                        return await asyncio.wait_for(convert_to_affiliate(url), timeout=5.0)
                    except asyncio.TimeoutError:
                        logger.debug("Affiliate conversion timed out for %s", url)
                        return url

                conversion_tasks = [
                    _convert(item["affiliate_url"])
                    for item in api_results
                    if item.get("affiliate_url")
                ]
                converted = await asyncio.gather(*conversion_tasks, return_exceptions=True)
                idx = 0
                for item in api_results:
                    if item.get("affiliate_url"):
                        result = converted[idx]
                        if isinstance(result, str):
                            item["affiliate_url"] = result
                        idx += 1

                # Apply filters
                results = api_results
                if platform:
                    results = [p for p in results if p.get("platform", "Unknown").lower() == platform.lower()]
                if brand:
                    results = [p for p in results if brand.lower() in p.get("brand", "").lower()]
                if min_price is not None:
                    results = [p for p in results if p["price"] >= min_price]
                if max_price is not None:
                    results = [p for p in results if p["price"] <= max_price]
                if min_rating is not None:
                    results = [p for p in results if p.get("rating", 0) >= min_rating]

                # Sort
                if sort_by == "price_low":
                    results.sort(key=lambda x: x["price"])
                elif sort_by == "price_high":
                    results.sort(key=lambda x: x["price"], reverse=True)
                elif sort_by == "discount":
                    results.sort(key=lambda x: x.get("discount", 0), reverse=True)
                elif sort_by == "rating":
                    results.sort(key=lambda x: x.get("rating", 0), reverse=True)

                results = results[:limit]

                response = {
                    "success": True,
                    "count": len(results),
                    "products": results,
                }
                # Save to PostgreSQL for top-deals pagination
                await asyncio.to_thread(db.save_search_results, search_query, results)
                # Cache search results in Redis for 10 hours
                redis_set(cache_key, response, ttl_seconds=36000)
                return response
        except Exception as exc:
            logger.warning("Live API search failed for '%s': %s", q, exc)

    # Fallback to static catalog
    products = load_products()
    results = products.copy()

    if q:
        q_lower = q.lower()
        results = [
            p for p in results
            if q_lower in p.get("title", "").lower()
            or q_lower in p.get("brand", "").lower()
            or q_lower in p.get("category", "").lower()
            or q_lower in p.get("description", "").lower()
        ]

    if platform:
        results = [p for p in results if p["platform"].lower() == platform.lower()]

    if category:
        results = [p for p in results if category.lower() in p["category"].lower()]

    if brand:
        results = [p for p in results if brand.lower() in p["brand"].lower()]

    if min_price is not None:
        results = [p for p in results if p["price"] >= min_price]

    if max_price is not None:
        results = [p for p in results if p["price"] <= max_price]

    if min_discount is not None:
        results = [p for p in results if p["discount"] >= min_discount]

    if min_rating is not None:
        results = [p for p in results if p["rating"] >= min_rating]

    if sort_by:
        if sort_by == "price_low":
            results.sort(key=lambda x: x["price"])
        elif sort_by == "price_high":
            results.sort(key=lambda x: x["price"], reverse=True)
        elif sort_by == "discount":
            results.sort(key=lambda x: x["discount"], reverse=True)
        elif sort_by == "rating":
            results.sort(key=lambda x: x["rating"], reverse=True)

    results = results[:limit]

    # Save fallback results to PostgreSQL too
    await asyncio.to_thread(db.save_search_results, search_query or q or "deals", results)

    return {
        "success": True,
        "count": len(results),
        "products": results,
    }


@app.get("/categories")
def get_categories():
    """Get all available categories"""
    products = load_products()
    categories = list(set(p["category"] for p in products))
    categories.sort()
    return {"categories": categories, "count": len(categories)}


@app.get("/platforms")
def get_platforms():
    """Get all available platforms"""
    products = load_products()
    platforms = list(set(p["platform"] for p in products))
    platforms.sort()
    return {"platforms": platforms, "count": len(platforms)}


@app.get("/brands")
def get_brands(category: Optional[str] = None):
    """Get all available brands, optionally filtered by category"""
    products = load_products()
    filtered = products
    if category:
        filtered = [p for p in products if category.lower() in p["category"].lower()]

    brands = list(set(p["brand"] for p in filtered))
    brands.sort()
    return {"brands": brands, "count": len(brands)}


@app.get("/deals")
async def get_top_deals(
    page: int = Query(1, ge=1, description="Page number"),
    per_page: int = Query(30, ge=1, le=30, description="Items per page"),
):
    """Get top deals from PostgreSQL database with pagination (cached 5 min in Redis)"""
    cache_key = f"deals:page{page}:pp{per_page}"
    cached = redis_get(cache_key)
    if cached:
        return cached

    response = await asyncio.to_thread(db.get_top_deals, page, per_page)
    redis_set(cache_key, response, ttl_seconds=300)  # 5 minutes
    return response


@app.get("/product/{product_id}")
def get_product(product_id: int):
    """Get a specific product by ID"""
    products = load_products()
    for product in products:
        if product["id"] == product_id:
            return {"success": True, "product": product}
    return {"success": False, "message": "Product not found"}


# ═══════════════════════════════════════════════════════════════
# AUTH (Firebase -> Supabase sync)
# ═══════════════════════════════════════════════════════════════
class UserSyncRequest(BaseModel):
    uid: str
    email: Optional[str] = None
    display_name: Optional[str] = None
    photo_url: Optional[str] = None
    provider: str = "firebase"

@app.post("/auth/sync")
async def sync_user_data(req: UserSyncRequest):
    ok = await asyncio.to_thread(db.sync_user, req.model_dump())
    return {"success": ok}

@app.get("/auth/user/{uid}")
async def get_user_data(uid: str):
    user = await asyncio.to_thread(db.get_user, uid)
    return {"success": True, "user": user} if user else {"success": False, "user": None}


# ═══════════════════════════════════════════════════════════════
# WISHLIST
# ═══════════════════════════════════════════════════════════════
class WishlistItem(BaseModel):
    product: dict

@app.get("/wishlist/{user_id}")
async def get_user_wishlist(user_id: str):
    items = await asyncio.to_thread(db.get_wishlist, user_id)
    return {"success": True, "count": len(items), "items": items}

@app.post("/wishlist/{user_id}")
async def add_user_wishlist(user_id: str, item: WishlistItem):
    ok = await asyncio.to_thread(db.add_to_wishlist, user_id, item.product)
    return {"success": ok}

@app.delete("/wishlist/{user_id}/{product_id}")
async def delete_user_wishlist(user_id: str, product_id: str):
    ok = await asyncio.to_thread(db.remove_from_wishlist, user_id, product_id)
    return {"success": ok}


# ═══════════════════════════════════════════════════════════════
# SEARCH HISTORY
# ═══════════════════════════════════════════════════════════════
class HistoryEntry(BaseModel):
    query: str
    platform: Optional[str] = None
    category: Optional[str] = None
    brand: Optional[str] = None
    minDiscount: Optional[int] = None

@app.get("/history/{user_id}")
async def get_user_history(user_id: str, limit: int = Query(20, ge=1, le=100)):
    items = await asyncio.to_thread(db.get_search_history, user_id, limit)
    return {"success": True, "count": len(items), "history": items}

@app.post("/history/{user_id}")
async def add_user_history(user_id: str, entry: HistoryEntry):
    ok = await asyncio.to_thread(db.add_search_history, user_id, entry.model_dump())
    return {"success": ok}

@app.delete("/history/{user_id}")
async def clear_user_history(user_id: str):
    ok = await asyncio.to_thread(db.clear_search_history, user_id)
    return {"success": ok}


# ═══════════════════════════════════════════════════════════════
# AFFILIATE & LINK GENERATION
# ═══════════════════════════════════════════════════════════════
@app.post("/convert")
async def convert_url_to_affiliate(request: ConvertRequest):
    """Convert any URL to EarnKaro affiliate link"""
    try:
        affiliate_url = await convert_to_affiliate(request.url)
        return {
            "success": True,
            "affiliate_url": affiliate_url,
            "original_url": request.url,
        }
    except Exception as e:
        return {
            "success": False,
            "message": str(e),
            "original_url": request.url,
        }


@app.get("/convert")
async def convert_url_to_affiliate_get(url: str = Query(..., description="URL to convert")):
    """Convert any URL to EarnKaro affiliate link (GET version)"""
    request = ConvertRequest(url=url)
    return await convert_url_to_affiliate(request)


@app.post("/generate-link")
async def generate_direct_link(request: DirectLinkRequest):
    """Generate direct product link with filters (same as bot)"""
    try:
        store = request.store.lower()

        if store == "myntra":
            url = build_myntra_url(
                search=request.query,
                brand=request.brand,
                price_min=request.price_min,
                price_max=request.price_max,
                discount=request.discount,
                color=request.color,
            )
        elif store == "ajio":
            url = build_ajio_url(
                query=request.query,
                brand=request.brand,
                price_min=request.price_min,
                price_max=request.price_max,
                discount=request.discount,
            )
        else:  # flipkart (default)
            url = build_flipkart_url(
                query=request.query,
                brand=request.brand,
                price_min=request.price_min,
                price_max=request.price_max,
                discount=request.discount,
            )

        affiliate_url = await convert_to_affiliate(url)

        return {
            "success": True,
            "original_url": url,
            "affiliate_url": affiliate_url,
            "store": request.store,
        }
    except Exception as e:
        return {"success": False, "message": str(e)}


@app.get("/generate-link")
async def generate_direct_link_get(
    store: str = Query(..., description="Store: flipkart or myntra"),
    query: str = Query(..., description="Search query"),
    brand: Optional[str] = Query(None, description="Brand filter"),
    price_min: Optional[int] = Query(0, description="Minimum price"),
    price_max: Optional[int] = Query(999999, description="Maximum price"),
    discount: Optional[int] = Query(0, description="Minimum discount"),
    color: Optional[str] = Query(None, description="Color filter (Myntra only)"),
):
    """Generate direct product link with filters - GET version"""
    request = DirectLinkRequest(
        store=store,
        query=query,
        brand=brand,
        price_min=price_min,
        price_max=price_max,
        discount=discount,
        color=color,
    )
    return await generate_direct_link(request)
