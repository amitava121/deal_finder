"""Redis cache backend for Deal Finder API.

Caches top deals and search results across server restarts.
Falls back to in-memory cache if Redis is unavailable.
"""

import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

# Try to import redis
redis_client = None
_redis_available = False

try:
    import redis
    REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    redis_client = redis.from_url(REDIS_URL, decode_responses=True, socket_connect_timeout=2, socket_timeout=2)
    redis_client.ping()
    _redis_available = True
    logger.info("Redis cache connected: %s", REDIS_URL)
except Exception as exc:
    logger.warning("Redis not available, using in-memory fallback: %s", exc)
    redis_client = None
    _redis_available = False


def get_cache(key: str) -> Optional[Any]:
    """Get cached value from Redis or fallback to memory."""
    if _redis_available and redis_client:
        try:
            data = redis_client.get(key)
            if data:
                return json.loads(data)
        except Exception as exc:
            logger.debug("Redis get failed: %s", exc)
    return None


def set_cache(key: str, data: Any, ttl_seconds: int = 3600) -> None:
    """Set cache value in Redis with TTL."""
    if _redis_available and redis_client:
        try:
            redis_client.setex(key, ttl_seconds, json.dumps(data))
        except Exception as exc:
            logger.debug("Redis set failed: %s", exc)


def delete_cache(key: str) -> None:
    """Delete cache key."""
    if _redis_available and redis_client:
        try:
            redis_client.delete(key)
        except Exception:
            pass
