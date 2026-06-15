import asyncio
import logging
import os
import time
from collections import OrderedDict
from collections import deque
from pathlib import Path
from typing import Deque, Dict, Optional
from urllib.parse import urlparse

import httpx
from dotenv import load_dotenv

# Load .env from the same directory as this module
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(dotenv_path=_env_path)

logger = logging.getLogger(__name__)

EARNKARO_CONVERTER_URL = "https://ekaro-api.affiliaters.in/api/converter/public"
def _earnkaro_api_key() -> str:
    # Read on demand so environment changes are picked up without code changes.
    return os.getenv("EARNKARO_API_KEY", "").strip()
MAX_RETRIES = 2
REQUESTS_PER_MINUTE = 60
REQUEST_WINDOW_SECONDS = 60.0

MAX_AFFILIATE_CACHE_SIZE = 1000
affiliate_cache: "OrderedDict[str, str]" = OrderedDict()

_request_times: Deque[float] = deque()
_rate_lock = asyncio.Lock()
_cache_lock = asyncio.Lock()
_client_lock = asyncio.Lock()
_client: Optional[httpx.AsyncClient] = None


async def _get_http_client() -> httpx.AsyncClient:
    global _client
    if _client is not None:
        return _client

    async with _client_lock:
        if _client is None:
            _client = httpx.AsyncClient(
                timeout=httpx.Timeout(8.0),
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=40),
            )
    return _client


async def close_affiliate_http_client() -> None:
    global _client
    async with _client_lock:
        if _client is not None:
            await _client.aclose()
            _client = None


async def _wait_for_rate_limit_slot() -> None:
    while True:
        sleep_for = 0.0
        now = time.monotonic()

        async with _rate_lock:
            while _request_times and now - _request_times[0] >= REQUEST_WINDOW_SECONDS:
                _request_times.popleft()

            if len(_request_times) < REQUESTS_PER_MINUTE:
                _request_times.append(now)
                return

            oldest = _request_times[0]
            sleep_for = max(0.05, REQUEST_WINDOW_SECONDS - (now - oldest))

        await asyncio.sleep(sleep_for)


def _looks_like_valid_url(url: str) -> bool:
    parsed = urlparse((url or "").strip())
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _add_fallback_affiliate_params(url: str) -> str:
    if not url or not _looks_like_valid_url(url):
        return url

    separator = "&" if "?" in url else "?"
    utm_params = "utm_source=smartdealfinder&utm_medium=affiliate&utm_campaign=search"
    return f"{url}{separator}{utm_params}"


async def _read_cache(url: str) -> Optional[str]:
    async with _cache_lock:
        cached = affiliate_cache.get(url)
        if cached is not None:
            affiliate_cache.move_to_end(url)
        return cached


async def _write_cache(url: str, affiliate_url: str) -> None:
    async with _cache_lock:
        if url in affiliate_cache:
            affiliate_cache.move_to_end(url)
        affiliate_cache[url] = affiliate_url
        while len(affiliate_cache) > MAX_AFFILIATE_CACHE_SIZE:
            affiliate_cache.popitem(last=False)


async def convert_to_affiliate(url: str) -> str:
    original_url = (url or "").strip()
    if not original_url or not _looks_like_valid_url(original_url):
        return original_url

    cached = await _read_cache(original_url)
    if cached:
        return cached

    api_key = _earnkaro_api_key()
    if not api_key:
        fallback_link = _add_fallback_affiliate_params(original_url)
        await _write_cache(original_url, fallback_link)
        return fallback_link

    payload = {
        "deal": original_url,
        "convert_option": "convert_only",
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    client = await _get_http_client()

    for attempt in range(MAX_RETRIES + 1):
        try:
            await _wait_for_rate_limit_slot()
            response = await client.post(EARNKARO_CONVERTER_URL, json=payload, headers=headers)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            logger.warning("EarnKaro request failed on attempt %s: %s", attempt + 1, exc)
            if attempt < MAX_RETRIES:
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        if response.status_code == 401:
            logger.error("Invalid API key for EarnKaro API")
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        if response.status_code == 400:
            logger.info("EarnKaro conversion skipped due to invalid URL payload")
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            try:
                wait_seconds = float(retry_after) if retry_after else 1.0
            except ValueError:
                wait_seconds = 1.0
            logger.warning("EarnKaro rate limit hit; waiting %.2fs before retry", wait_seconds)
            if attempt < MAX_RETRIES:
                await asyncio.sleep(wait_seconds)
                continue
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        if response.status_code >= 500:
            logger.warning("EarnKaro server error %s", response.status_code)
            if attempt < MAX_RETRIES:
                await asyncio.sleep(0.4 * (attempt + 1))
                continue
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        try:
            body = response.json()
        except ValueError:
            logger.warning("EarnKaro returned non-JSON response")
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        logger.debug("EarnKaro response for %s: %s", original_url, body)

        if body.get("success") == 1:
            affiliate_url = body.get("data")
            if isinstance(affiliate_url, str) and affiliate_url.strip() and _looks_like_valid_url(affiliate_url):
                affiliate_url = affiliate_url.strip()
                await _write_cache(original_url, affiliate_url)
                return affiliate_url

            logger.info("EarnKaro returned non-URL data; using fallback link")
            fallback_link = _add_fallback_affiliate_params(original_url)
            await _write_cache(original_url, fallback_link)
            return fallback_link

        logger.info("EarnKaro conversion did not return success=1; using fallback link")
        fallback_link = _add_fallback_affiliate_params(original_url)
        await _write_cache(original_url, fallback_link)
        return fallback_link

    fallback_link = _add_fallback_affiliate_params(original_url)
    await _write_cache(original_url, fallback_link)
    return fallback_link
