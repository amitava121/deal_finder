"""
Query Rewriter for Price Search API
====================================

Uses Groq API (Qwen3 32B) to rewrite Indic Romanized queries into
clean English e-commerce search queries.

Falls back to local SymSpell if Groq is unavailable or rate-limited.

All configuration is loaded from environment or config files.
No hardcoded API keys.
"""

import os
import re
import json
import logging
import requests
import time
import asyncio
from typing import Optional
from pathlib import Path
from dotenv import load_dotenv

# Optional Redis cache
try:
    import redis
    REDIS_AVAILABLE = True
except ImportError:
    REDIS_AVAILABLE = False

# Load .env from project root (override=True to ensure .env values take precedence)
load_dotenv(Path(__file__).parent.parent.parent / '.env', override=True)

logger = logging.getLogger(__name__)

# Config
DATA_DIR = Path(__file__).parent / 'data'

# Cloudflare Workers AI (primary - 4,000 queries/day free, fastest)
CLOUDFLARE_API_URL = "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions"
CLOUDFLARE_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast"

# Groq (fallback - 960 queries/day free)
GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.1-8b-instant"

# Cerebras (tertiary - 1M tokens/day free)
CEREBRAS_API_URL = "https://api.cerebras.ai/v1/chat/completions"
CEREBRAS_MODEL = "gpt-oss-120b"

DEFAULT_PROMPT = """You are an ecommerce query normalizer for Indian price comparison apps.

Convert misspelled Indian Romanized search queries into the best English ecommerce search query.

CRITICAL: Return ONLY the rewritten query. No explanation. No thinking. No reasoning. Just the query.

Rules:
- Fix spelling errors
- Translate Hinglish/Banglish to English
- Preserve brand names (Samsung, boAt, Realme, etc)
- Preserve model names (S24, Airdopes, Narzo, etc)
- Remove conversational words (ami, nibo, chahiye, etc)
- Keep price numbers and currency

Examples:
Input: samsang blututh spikar
Output: samsung bluetooth speaker

Input: ami sari nibo 1000 takar
Output: saree under 1000 rupees

Input: realmi narzo phone
Output: realme narzo phone

Input: mejhe adidas boot chaiye
Output: adidas boot

Input: ladkio ke liye kurtee
Output: women kurti"""


class GroqQueryRewriter:
    """Rewrite queries using Groq API with fallback to local spell correction."""

    def __init__(self, cloudflare_key: Optional[str] = None, cloudflare_account: Optional[str] = None,
                 groq_key: Optional[str] = None, cerebras_key: Optional[str] = None):
        """
        Initialize rewriter.

        Args:
            cloudflare_key: Cloudflare API token. If None, reads from CLOUDFLARE_API_TOKEN env var.
            cloudflare_account: Cloudflare account ID. If None, reads from CLOUDFLARE_ACCOUNT_ID env var.
            groq_key: Groq API key. If None, reads from GROQ_API_KEY env var.
            cerebras_key: Cerebras API key. If None, reads from CEREBRAS_API_KEY env var.
        """
        self.cloudflare_key = cloudflare_key or os.environ.get('CLOUDFLARE_API_TOKEN')
        self.cloudflare_account = cloudflare_account or os.environ.get('CLOUDFLARE_ACCOUNT_ID')
        self.groq_key = groq_key or os.environ.get('GROQ_API_KEY')
        self.cerebras_key = cerebras_key or os.environ.get('CEREBRAS_API_KEY')
        self.timeout = 3.0  # seconds - allow time for API response
        self.prompt = self._load_prompt()
        self._cache = {}  # In-memory cache

        # Provider performance tracking (name -> [latencies])
        self._provider_stats = {}

        # Redis cache (optional, for shared caching across instances)
        self._redis = None
        self._redis_ttl = 3600  # 1 hour
        if REDIS_AVAILABLE:
            try:
                redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379/0')
                self._redis = redis.from_url(redis_url, decode_responses=True)
                self._redis.ping()
                logger.info("Redis cache connected")
            except Exception as e:
                logger.warning(f"Redis not available: {e}")

        # Import local fallback
        try:
            from spell_corrector import SpellCorrector
            self.local_corrector = SpellCorrector()
            logger.info("Local spell corrector loaded for fallback")
        except Exception as e:
            logger.warning(f"Local spell corrector not available: {e}")
            self.local_corrector = None

    def _load_prompt(self) -> str:
        """Load prompt from file or use default."""
        prompt_file = DATA_DIR / 'query_rewriter_prompt.txt'
        if prompt_file.exists():
            with open(prompt_file, 'r', encoding='utf-8') as f:
                return f.read()
        return DEFAULT_PROMPT

    def rewrite(self, query: str) -> str:
        """
        Rewrite query using fastest available API with caching.

        Args:
            query: User query (e.g., "samsang blututh spikar")

        Returns:
            str: Rewritten query (e.g., "samsung bluetooth speaker")
        """
        if not query or not query.strip():
            return ""

        query = query.strip().lower()

        # Check cache first (instant response for repeated queries)
        if query in self._cache:
            logger.debug(f"Cache hit: '{query}'")
            return self._cache[query]

        result = None

        # Try providers in parallel-ish order by expected speed
        # Tier 1: Groq (fastest, most reliable, ~300-500ms)
        if self.groq_key:
            try:
                result = self._api_rewrite(query, GROQ_API_URL, self.groq_key, GROQ_MODEL)
                if result:
                    logger.info(f"Groq rewrite: '{query}' -> '{result}'")
            except Exception as e:
                logger.warning(f"Groq failed: {e}")

        # Tier 2: Cloudflare (good fallback, ~400-800ms)
        if not result and self.cloudflare_key and self.cloudflare_account:
            try:
                cf_url = CLOUDFLARE_API_URL.format(account_id=self.cloudflare_account)
                result = self._api_rewrite(query, cf_url, self.cloudflare_key, CLOUDFLARE_MODEL)
                if result:
                    logger.info(f"Cloudflare rewrite: '{query}' -> '{result}'")
            except Exception as e:
                logger.warning(f"Cloudflare failed: {e}")

        # Tier 3: Cerebras (slowest API, ~600-1000ms)
        if not result and self.cerebras_key:
            try:
                result = self._api_rewrite(query, CEREBRAS_API_URL, self.cerebras_key, CEREBRAS_MODEL)
                if result:
                    logger.info(f"Cerebras rewrite: '{query}' -> '{result}'")
            except Exception as e:
                logger.warning(f"Cerebras failed: {e}")

        # Fallback to local spell corrector (fastest, ~5ms)
        if not result and self.local_corrector:
            result = self.local_corrector.build_api_query(query)
            logger.info(f"Local rewrite: '{query}' -> '{result}'")

        # Last resort: return original
        if not result:
            result = query

        # Cache result (keep last 100 queries)
        self._cache[query] = result
        if len(self._cache) > 100:
            self._cache.pop(next(iter(self._cache)))

        return result

    def _api_rewrite(self, query: str, api_url: str, api_key: str, model: str,
                     use_prompt_cache: bool = False) -> Optional[str]:
        """Call OpenAI-compatible API to rewrite query."""
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }

        # NOTE: Prompt caching is automatic for repeated system prompts
        # on most providers (Groq, Cloudflare). No special header needed.
        payload = {
            "model": model,
            "messages": [
                {"role": "system", "content": self.prompt},
                {"role": "user", "content": f"Input: {query}\nOutput:"}
            ],
            "temperature": 0.1,
            "max_tokens": 50
        }

        response = requests.post(
            api_url,
            headers=headers,
            json=payload,
            timeout=self.timeout
        )
        response.raise_for_status()

        data = response.json()
        if 'choices' in data and len(data['choices']) > 0:
            message = data['choices'][0]['message']
            result = message.get('content') or message.get('reasoning', '')
            result = result.strip()
            result = re.sub(r'^Output:\s*', '', result, flags=re.IGNORECASE)
            return result

        return None

    def _get_cache(self, key: str) -> Optional[str]:
        """Get from cache (Redis first, then memory)"""
        # Check Redis first
        if self._redis:
            try:
                val = self._redis.get(f"qr:{key}")
                if val:
                    return val
            except Exception:
                pass
        # Check memory cache
        return self._cache.get(key)

    def _set_cache(self, key: str, value: str):
        """Set cache (Redis + memory)"""
        self._cache[key] = value
        # Also set in Redis with TTL
        if self._redis:
            try:
                self._redis.setex(f"qr:{key}", self._redis_ttl, value)
            except Exception:
                pass
        # Keep memory cache bounded
        if len(self._cache) > 100:
            self._cache.pop(next(iter(self._cache)))

    async def rewrite_async(self, query: str) -> str:
        """
        Async rewrite using SMART sequential provider selection.
        Calls ONLY 1 API per query (fastest provider based on history).
        Falls back to next provider ONLY if first fails.
        """
        if not query or not query.strip():
            return ""

        query = query.strip().lower()

        # Check cache first
        cached = self._get_cache(query)
        if cached:
            logger.debug(f"Cache hit: '{query}'")
            return cached

        # Build list of active providers with performance stats
        providers = []
        if self.groq_key:
            providers.append(('groq', GROQ_API_URL, self.groq_key, GROQ_MODEL))
        if self.cloudflare_key and self.cloudflare_account:
            cf_url = CLOUDFLARE_API_URL.format(account_id=self.cloudflare_account)
            providers.append(('cloudflare', cf_url, self.cloudflare_key, CLOUDFLARE_MODEL))
        if self.cerebras_key:
            providers.append(('cerebras', CEREBRAS_API_URL, self.cerebras_key, CEREBRAS_MODEL))

        if not providers:
            if self.local_corrector:
                result = self.local_corrector.build_api_query(query)
                self._set_cache(query, result)
                return result
            return query

        # Sort providers by average latency (fastest first)
        def avg_latency(name):
            latencies = self._provider_stats.get(name, [])
            if not latencies:
                return 999  # Unknown = last priority
            return sum(latencies) / len(latencies)

        providers.sort(key=lambda p: avg_latency(p[0]))

        # Try providers sequentially: call ONE, if fail try next
        result = None
        provider_used = None

        for name, url, key, model in providers:
            start = time.time()
            try:
                loop = asyncio.get_event_loop()
                res = await asyncio.wait_for(
                    loop.run_in_executor(None, self._api_rewrite, query, url, key, model),
                    timeout=self.timeout
                )
                if res:
                    result = res
                    provider_used = name
                    # Track performance: only record successful calls
                    latency = (time.time() - start) * 1000
                    self._provider_stats.setdefault(name, []).append(latency)
                    # Keep last 10 measurements
                    self._provider_stats[name] = self._provider_stats[name][-10:]
                    logger.info(f"Smart {name} ({latency:.0f}ms): '{query}' -> '{result}'")
                    break
            except Exception as e:
                logger.warning(f"Smart {name} failed: {e}")
                continue

        # Fallback
        if not result and self.local_corrector:
            result = self.local_corrector.build_api_query(query)
            provider_used = 'local'
        elif not result:
            result = query

        self._set_cache(query, result)
        return result

    def rewrite_batch(self, queries: list) -> list:
        """Rewrite multiple queries."""
        return [self.rewrite(q) for q in queries]


# Singleton instance
_rewriter_instance = None

def get_rewriter(cloudflare_key: Optional[str] = None, cloudflare_account: Optional[str] = None,
               groq_key: Optional[str] = None, cerebras_key: Optional[str] = None) -> GroqQueryRewriter:
    """Get or create singleton rewriter instance."""
    global _rewriter_instance
    if _rewriter_instance is None:
        _rewriter_instance = GroqQueryRewriter(
            cloudflare_key=cloudflare_key, cloudflare_account=cloudflare_account,
            groq_key=groq_key, cerebras_key=cerebras_key
        )
    return _rewriter_instance


async def rewrite_query_async(query: str, cloudflare_key: Optional[str] = None,
                                cloudflare_account: Optional[str] = None,
                                groq_key: Optional[str] = None,
                                cerebras_key: Optional[str] = None) -> str:
    """
    Async convenience function - uses concurrent providers for fastest response.

    Calls all available APIs at once, returns the first valid result.
    """
    rewriter = get_rewriter(
        cloudflare_key=cloudflare_key, cloudflare_account=cloudflare_account,
        groq_key=groq_key, cerebras_key=cerebras_key
    )
    return await rewriter.rewrite_async(query)


def rewrite_query(query: str, cloudflare_key: Optional[str] = None,
                  cloudflare_account: Optional[str] = None,
                  groq_key: Optional[str] = None,
                  cerebras_key: Optional[str] = None) -> str:
    """
    Convenience function to rewrite a single query.

    Args:
        query: User query
        cloudflare_key: Optional Cloudflare API token
        cloudflare_account: Optional Cloudflare account ID
        groq_key: Optional Groq API key
        cerebras_key: Optional Cerebras API key

    Returns:
        str: Rewritten query
    """
    rewriter = get_rewriter(
        cloudflare_key=cloudflare_key, cloudflare_account=cloudflare_account,
        groq_key=groq_key, cerebras_key=cerebras_key
    )
    return rewriter.rewrite(query)


if __name__ == "__main__":
    # Test without API key (uses local fallback)
    test_queries = [
        "samsang blututh spikar",
        "ami sari nibo 1000 takar",
        "realmi narzo phone",
        "mejhe adidas boot chaiye",
        "ladkio ke liye kurtee",
        "mujhe samsang phone chahiye",
    ]

    rewriter = GroqQueryRewriter()

    print("Query Rewriter Test (Local Fallback Mode)")
    print("=" * 50)
    for query in test_queries:
        result = rewriter.rewrite(query)
        print(f"{query:40} -> {result}")
        print()
    print("\nTo use Groq API, set GROQ_API_KEY environment variable.")
    print("Get free API key: https://console.groq.com")
