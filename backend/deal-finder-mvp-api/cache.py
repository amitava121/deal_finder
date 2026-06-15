import time
from typing import Any, Dict, Optional

cache: Dict[str, Dict[str, Any]] = {}
DEFAULT_TTL_SECONDS = 600
MAX_CACHE_SIZE = 100


def cleanup_expired_cache() -> None:
    now = time.time()
    expired_keys = [key for key, value in cache.items() if value["timestamp"] + value["ttl"] <= now]
    for key in expired_keys:
        cache.pop(key, None)


def evict_oldest_if_needed() -> None:
    while len(cache) > MAX_CACHE_SIZE:
        oldest_key = min(cache, key=lambda key: cache[key]["timestamp"])
        cache.pop(oldest_key, None)


def set_cache(key: str, data: Any, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
    cleanup_expired_cache()
    cache[key] = {
        "result": data,
        "timestamp": time.time(),
        "ttl": ttl_seconds,
    }
    evict_oldest_if_needed()


def get_cache(key: str) -> Optional[Any]:
    cleanup_expired_cache()
    cached = cache.get(key)
    if not cached:
        return None
    return cached["result"]
