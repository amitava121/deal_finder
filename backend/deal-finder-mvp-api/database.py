"""PostgreSQL database for storing search results and top deals."""

import logging
import os
from pathlib import Path
from typing import Any, List, Optional

from dotenv import load_dotenv

# Load .env before reading DATABASE_URL
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_env_path)

import psycopg2
from psycopg2.extras import RealDictCursor
from psycopg2.pool import SimpleConnectionPool

logger = logging.getLogger(__name__)

_pool: Optional[SimpleConnectionPool] = None
# No hard limit — show all results
MAX_TOP_DEALS = 99999


def _get_pool() -> SimpleConnectionPool:
    global _pool
    if _pool is None:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            logger.error("DATABASE_URL not set")
            raise RuntimeError("DATABASE_URL not set")
        _pool = SimpleConnectionPool(1, 5, dsn)
        logger.info("PostgreSQL pool created")
    return _pool


def get_conn():
    return _get_pool().getconn()


def release_conn(conn):
    _get_pool().putconn(conn)


def init_db() -> None:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS search_results (
                    id SERIAL PRIMARY KEY,
                    query TEXT NOT NULL,
                    title TEXT NOT NULL,
                    brand TEXT,
                    platform TEXT NOT NULL,
                    category TEXT,
                    description TEXT,
                    original_price INTEGER DEFAULT 0,
                    price INTEGER NOT NULL,
                    discount INTEGER DEFAULT 0,
                    rating REAL DEFAULT 0,
                    reviews INTEGER DEFAULT 0,
                    image TEXT,
                    affiliate_url TEXT,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sr_platform ON search_results(platform)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sr_created ON search_results(created_at DESC)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sr_discount ON search_results(discount DESC)"
            )

            # Wishlist table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS wishlists (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    product_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    brand TEXT,
                    platform TEXT,
                    category TEXT,
                    original_price INTEGER DEFAULT 0,
                    price INTEGER DEFAULT 0,
                    discount INTEGER DEFAULT 0,
                    rating REAL DEFAULT 0,
                    reviews INTEGER DEFAULT 0,
                    image TEXT,
                    affiliate_url TEXT,
                    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    UNIQUE(user_id, product_id)
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_wl_user ON wishlists(user_id)"
            )

            # Search history table
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS search_history (
                    id SERIAL PRIMARY KEY,
                    user_id TEXT NOT NULL,
                    query TEXT NOT NULL,
                    platform TEXT,
                    category TEXT,
                    brand TEXT,
                    min_discount INTEGER,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sh_user ON search_history(user_id)"
            )
            cur.execute(
                "CREATE INDEX IF NOT EXISTS idx_sh_created ON search_history(created_at DESC)"
            )

            # Users table (synced from Firebase Auth)
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    uid TEXT PRIMARY KEY,
                    email TEXT,
                    display_name TEXT,
                    photo_url TEXT,
                    provider TEXT DEFAULT 'firebase',
                    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
                """
            )
            conn.commit()
        logger.info("Database initialized")
    except Exception as exc:
        conn.rollback()
        logger.error("DB init failed: %s", exc)
        raise
    finally:
        release_conn(conn)


def save_search_results(query: str, products: List[dict]) -> int:
    if not products:
        return 0
    conn = get_conn()
    inserted = 0
    try:
        with conn.cursor() as cur:
            for p in products:
                cur.execute(
                    """
                    INSERT INTO search_results
                    (query, title, brand, platform, category, description,
                     original_price, price, discount, rating, reviews, image, affiliate_url)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        query,
                        p.get("title", ""),
                        p.get("brand", ""),
                        p.get("platform", "Unknown"),
                        p.get("category", ""),
                        p.get("description", ""),
                        p.get("original_price", 0) or 0,
                        p.get("price", 0) or 0,
                        p.get("discount", 0) or 0,
                        p.get("rating", 0) or 0,
                        p.get("reviews", 0) or 0,
                        p.get("image", ""),
                        p.get("affiliate_url", ""),
                    ),
                )
                inserted += 1
            conn.commit()
        logger.info("Saved %d products for query '%s'", inserted, query)
        return inserted
    except Exception as exc:
        conn.rollback()
        logger.error("Save search results failed: %s", exc)
        return 0
    finally:
        release_conn(conn)


def get_top_deals(page: int = 1, per_page: int = 30) -> dict:
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Total count (no cap)
            cur.execute("SELECT COUNT(*) FROM search_results")
            total = cur.fetchone()["count"]

            # Paginated results, ordered by discount desc (best deals first)
            offset = (page - 1) * per_page
            cur.execute(
                """
                SELECT id, title, brand, platform, category, description,
                       original_price, price, discount, rating, reviews, image, affiliate_url
                FROM search_results
                ORDER BY discount DESC, price ASC
                LIMIT %s OFFSET %s
                """,
                (per_page, offset),
            )
            rows = cur.fetchall()

        products = [dict(r) for r in rows]
        return {
            "success": True,
            "count": len(products),
            "total": total,
            "page": page,
            "per_page": per_page,
            "products": products,
        }
    except Exception as exc:
        logger.error("Get top deals failed: %s", exc)
        return {
            "success": False,
            "count": 0,
            "total": 0,
            "page": page,
            "per_page": per_page,
            "products": [],
        }
    finally:
        release_conn(conn)


def trim_old_results() -> int:
    """Keep only the best MAX_TOP_DEALS results. Returns rows deleted."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                DELETE FROM search_results
                WHERE id NOT IN (
                    SELECT id FROM search_results
                    ORDER BY discount DESC, price ASC
                    LIMIT %s
                )
                """,
                (MAX_TOP_DEALS,),
            )
            deleted = cur.rowcount
            conn.commit()
        logger.info("Trimmed %d old results, keeping top %d", deleted, MAX_TOP_DEALS)
        return deleted
    except Exception as exc:
        conn.rollback()
        logger.error("Trim failed: %s", exc)
        return 0
    finally:
        release_conn(conn)


# ═══════════════════════════════════════════════════════════════
# WISHLIST
# ═══════════════════════════════════════════════════════════════

def get_wishlist(user_id: str) -> List[dict]:
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT product_id, title, brand, platform, category,
                       original_price, price, discount, rating, reviews, image, affiliate_url, added_at
                FROM wishlists
                WHERE user_id = %s
                ORDER BY added_at DESC
                """,
                (user_id,),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("Get wishlist failed: %s", exc)
        return []
    finally:
        release_conn(conn)


def add_to_wishlist(user_id: str, product: dict) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO wishlists
                (user_id, product_id, title, brand, platform, category,
                 original_price, price, discount, rating, reviews, image, affiliate_url)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (user_id, product_id) DO NOTHING
                """,
                (
                    user_id,
                    product.get("id", ""),
                    product.get("title", ""),
                    product.get("brand", ""),
                    product.get("platform", ""),
                    product.get("category", ""),
                    product.get("original_price", 0) or 0,
                    product.get("price", 0) or 0,
                    product.get("discount", 0) or 0,
                    product.get("rating", 0) or 0,
                    product.get("reviews", 0) or 0,
                    product.get("image", ""),
                    product.get("affiliate_url", ""),
                ),
            )
            conn.commit()
        return True
    except Exception as exc:
        logger.error("Add to wishlist failed: %s", exc)
        return False
    finally:
        release_conn(conn)


def remove_from_wishlist(user_id: str, product_id: str) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM wishlists WHERE user_id = %s AND product_id = %s",
                (user_id, product_id),
            )
            conn.commit()
        return True
    except Exception as exc:
        logger.error("Remove from wishlist failed: %s", exc)
        return False
    finally:
        release_conn(conn)


# ═══════════════════════════════════════════════════════════════
# SEARCH HISTORY
# ═══════════════════════════════════════════════════════════════

def get_search_history(user_id: str, limit: int = 20) -> List[dict]:
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, query, platform, category, brand, min_discount, created_at
                FROM search_history
                WHERE user_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (user_id, limit),
            )
            return [dict(r) for r in cur.fetchall()]
    except Exception as exc:
        logger.error("Get search history failed: %s", exc)
        return []
    finally:
        release_conn(conn)


def add_search_history(user_id: str, entry: dict) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO search_history
                (user_id, query, platform, category, brand, min_discount)
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    user_id,
                    entry.get("query", ""),
                    entry.get("platform") or None,
                    entry.get("category") or None,
                    entry.get("brand") or None,
                    entry.get("minDiscount") or None,
                ),
            )
            conn.commit()
        return True
    except Exception as exc:
        logger.error("Add search history failed: %s", exc)
        return False
    finally:
        release_conn(conn)


def clear_search_history(user_id: str) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM search_history WHERE user_id = %s",
                (user_id,),
            )
            conn.commit()
        return True
    except Exception as exc:
        logger.error("Clear search history failed: %s", exc)
        return False
    finally:
        release_conn(conn)


# ═══════════════════════════════════════════════════════════════
# USERS (synced from Firebase Auth)
# ═══════════════════════════════════════════════════════════════

def sync_user(user_data: dict) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO users (uid, email, display_name, photo_url, provider, updated_at)
                VALUES (%s, %s, %s, %s, %s, NOW())
                ON CONFLICT (uid) DO UPDATE SET
                    email = EXCLUDED.email,
                    display_name = EXCLUDED.display_name,
                    photo_url = EXCLUDED.photo_url,
                    updated_at = NOW()
                """,
                (
                    user_data.get("uid"),
                    user_data.get("email"),
                    user_data.get("display_name"),
                    user_data.get("photo_url"),
                    user_data.get("provider", "firebase"),
                ),
            )
            conn.commit()
        return True
    except Exception as exc:
        logger.error("Sync user failed: %s", exc)
        return False
    finally:
        release_conn(conn)


def get_user(uid: str) -> Optional[dict]:
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT uid, email, display_name, photo_url, provider, created_at, updated_at FROM users WHERE uid = %s",
                (uid,),
            )
            row = cur.fetchone()
            return dict(row) if row else None
    except Exception as exc:
        logger.error("Get user failed: %s", exc)
        return None
    finally:
        release_conn(conn)
