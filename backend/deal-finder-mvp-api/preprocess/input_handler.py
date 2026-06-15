"""
Input Handler - Expands shortened URLs and parses user input
Supports: text queries, URLs, shortened links (bitly, tinyurl, etc.)
"""

import re
import requests
from urllib.parse import urlparse, parse_qs
import logging
import sys
from pathlib import Path
from functools import lru_cache
import hashlib

logger = logging.getLogger(__name__)


class InputHandler:
    """Handles user input processing and URL expansion"""

    # Common URL shorteners (expanded list)
    URL_SHORTENERS = [
        'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly',
        'is.gd', 'buff.ly', 'adf.ly', 'short.io', 'rb.gy',
        'l1nq.com', 'short.link', 'clck.ru', 'cutt.ly',
        'rebrand.ly', 'bl.ink', 't2m.io', 'shorturl.at'
    ]

    # URL noise words to skip when extracting product names
    URL_NOISE_WORDS = {
        'dp', 'gp', 'product', 'item', 'p', 'itm', 'buy', 'shop',
        'products', 'details', 'pid', 'lid', 'ref', 'sr', 'keywords',
        'search', 'store', 'marketplace', 'www', 'com', 'in', 'html'
    }

    # Class-level cache for scraped products (shared across instances)
    _product_cache = {}
    _cache_max_size = 1000  # Cache up to 1000 products

    def __init__(self, timeout=5):
        """
        Initialize Input Handler

        Args:
            timeout (int): Timeout for URL expansion requests
        """
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })

    def extract_product_info(self, url: str) -> dict:
        """
        Extract ONLY product info from URL: name, price, rating, platform.

        FAST PATH (no network):
        1. Platform from domain (instant)
        2. Product name from URL path parsing (instant)

        NOTE: Price/rating extraction via meta tags is unreliable for
        major e-commerce sites (Flipkart, Amazon, etc.) as they load
        prices dynamically and block scrapers. Product name is sufficient
        for cross-platform price comparison via RapidAPI.

        Returns:
            {
                'product_name': str or None,
                'price': str or None,
                'rating': str or None,
                'platform': str or None
            }
        """
        result = {
            'product_name': None,
            'price': None,
            'rating': None,
            'platform': None
        }

        if not url or not url.strip():
            return result

        url = url.strip()

        # Expand shortened URL if needed
        url_to_process = url
        if self._is_shortened_url(url):
            expanded = self._expand_url(url)
            if expanded and expanded != url:
                url_to_process = expanded

        # Extract platform from domain (instant)
        platform_info = self._extract_platform_info(url_to_process)
        result['platform'] = platform_info.get('platform')

        # INSTANT: Get product name from URL path (no network)
        product_data = self._scrape_product_url(url_to_process)
        if product_data and product_data.get('name'):
            result['product_name'] = product_data['name']

        # NOTE: Skipping meta tag extraction for price/rating.
        # Major e-commerce sites (Flipkart, Amazon, Myntra) intentionally
        # block scrapers and load prices via JavaScript. The product name
        # extracted from URL is sufficient to search for prices across
        # all platforms using RapidAPI.

        return result

    def process(self, user_input: str) -> dict:
        """
        Process user input - fast URL extraction or pass-through text

        FAST PATH: Text queries (<1ms)
        URL PATH:  Extract product name from URL path (5-10ms, no HTTP requests)

        Args:
            user_input (str): Raw user input (text, URL, or shortened link)

        Returns:
            dict: Processed input with query_text ready for LLM rewriter
        """
        user_input = user_input.strip()

        # FAST PATH: Text query (no URL indicators)
        if not self._looks_like_url_fast(user_input):
            return {
                'input_type': 'text',
                'original_input': user_input,
                'query_text': user_input,
                'platform': None,
                'product_id': None
            }

        # URL PATH: Extract product name from URL
        if self._is_url(user_input):
            url_to_process = user_input
            platform_info = self._extract_platform_info(user_input)

            # Step 1: Try to expand shortened URL (fast timeout)
            if self._is_shortened_url(user_input):
                expanded = self._expand_url(user_input)
                if expanded and expanded != user_input:
                    expanded_info = self._extract_platform_info(expanded)
                    if expanded_info.get('platform'):
                        url_to_process = expanded
                        platform_info = expanded_info

            # FAST PATH: Instant URL path parsing (no network, <10ms)
            product_data = self._scrape_product_url(url_to_process)
            url_name = product_data.get('name') if product_data else None

            # Check if URL name looks like SEO spam (Amazon puts marketing words in URL)
            seo_spam_words = {'smartphone', 'precision', 'ultra', 'sleek', 'premium',
                              'advanced', 'original', 'authentic', 'genuine', 'official',
                              'model', 'series', 'edition', 'variant', 'product', 'device',
                              'mobile', 'phone', 'cellphone', 'handset', 'gadget'}
            looks_like_seo = False
            if url_name:
                name_lower = url_name.lower()
                spam_count = sum(1 for w in seo_spam_words if w in name_lower)
                # If >2 spam words or >40 chars, likely SEO slug
                looks_like_seo = spam_count >= 2 or len(url_name) > 40

            # Clean SEO words from URL name for better search query
            if url_name and looks_like_seo:
                words = url_name.split()
                cleaned_words = [w for w in words if w.lower() not in seo_spam_words]
                if len(cleaned_words) >= 2:
                    url_name = ' '.join(cleaned_words)

            # If name looks good and not SEO spam, use it directly
            if url_name and not looks_like_seo:
                return {
                    'input_type': 'url',
                    'original_input': user_input,
                    'query_text': url_name,
                    'platform': platform_info.get('platform'),
                    'product_id': platform_info.get('product_id')
                }

            # Try meta extraction for better name (Amazon, some product pages)
            # This is fast when name looks like SEO, or when URL parsing failed
            try:
                from meta_extractor import extract_product_info
                meta_info = extract_product_info(url_to_process, timeout=1.2)
                if meta_info and meta_info.get('name'):
                    # Use meta name if available (usually more accurate)
                    meta_name = meta_info['name']
                    # Clean up common suffixes
                    meta_name = re.sub(r'\s*[:|\-]\s*Amazon\.in.*$', '', meta_name, flags=re.IGNORECASE)
                    meta_name = re.sub(r'\s*[:|\-]\s*Flipkart\.com.*$', '', meta_name, flags=re.IGNORECASE)
                    meta_name = re.sub(r'\s*[:|\-]\s*Myntra.*$', '', meta_name, flags=re.IGNORECASE)
                    meta_name = meta_name.strip()

                    parts = [meta_name]
                    if meta_info.get('brand'):
                        parts.append(meta_info['brand'])
                    return {
                        'input_type': 'url',
                        'original_input': user_input,
                        'query_text': ' '.join(parts),
                        'platform': platform_info.get('platform'),
                        'product_id': platform_info.get('product_id')
                    }
            except Exception:
                pass

            # Fallback to URL name even if it looked like SEO
            if url_name:
                return {
                    'input_type': 'url',
                    'original_input': user_input,
                    'query_text': url_name,
                    'platform': platform_info.get('platform'),
                    'product_id': platform_info.get('product_id')
                }

            # Final fallback
            return {
                'input_type': 'url',
                'original_input': user_input,
                'query_text': user_input,
                'platform': platform_info.get('platform'),
                'product_id': platform_info.get('product_id')
            }

        # Default: pass through as text
        return {
            'input_type': 'text',
            'original_input': user_input,
            'query_text': user_input,
            'platform': None,
            'product_id': None
        }

    def _looks_like_url_fast(self, text: str) -> bool:
        """
        Fast check if text might be a URL (before expensive regex)

        Checks for common URL indicators:
        - Starts with http:// or https://
        - Contains www.
        - Contains .com, .in, .org, etc.

        Returns:
            bool: True if text might be a URL (needs full check)
        """
        text_lower = text.lower()
        return (
            text_lower.startswith('http://') or
            text_lower.startswith('https://') or
            text_lower.startswith('www.') or
            '.com' in text_lower or
            '.in' in text_lower or
            '.org' in text_lower or
            '.ly' in text_lower  # bit.ly
        )

    def _is_url(self, text: str) -> bool:
        """Check if text is a URL"""
        url_pattern = re.compile(
            r'^https?://'  # http:// or https://
            r'|^www\.'  # or starts with www.
            r'|\.[a-z]{2,}/'  # or contains domain extension
        , re.IGNORECASE)
        return bool(url_pattern.search(text))

    def _is_shortened_url(self, url: str) -> bool:
        """Check if URL is from a known shortener service"""
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower().replace('www.', '')
            return any(domain == shortener or domain.endswith('.' + shortener) for shortener in self.URL_SHORTENERS)
        except Exception as e:
            logger.error(f"Error checking shortened URL: {e}")
            return False

    def _expand_url(self, short_url: str) -> str:
        """
        Expand shortened URL by following redirects

        Args:
            short_url (str): Shortened URL

        Returns:
            str: Expanded/final URL
        """
        try:
            # Ensure URL has scheme
            if not short_url.startswith('http'):
                short_url = 'https://' + short_url

            # Follow redirects to get final URL
            response = self.session.head(
                short_url,
                allow_redirects=True,
                timeout=self.timeout
            )

            final_url = response.url
            logger.info(f"Expanded URL: {short_url} -> {final_url}")
            return final_url

        except requests.RequestException as e:
            logger.warning(f"Failed to expand URL {short_url}: {e}")
            return short_url
        except Exception as e:
            logger.error(f"Unexpected error expanding URL: {e}")
            return short_url

    def _extract_platform_info(self, url: str) -> dict:
        """
        Extract platform and product ID from e-commerce URL

        Args:
            url (str): E-commerce product URL

        Returns:
            dict: Platform name and product ID if found
        """
        result = {'platform': None, 'product_id': None}

        try:
            parsed = urlparse(url)
            domain = parsed.netloc.lower().replace('www.', '')

            # Detect platform
            if 'amazon' in domain:
                result['platform'] = 'amazon'
                # Extract ASIN from Amazon URL
                asin_match = re.search(r'/dp/([A-Z0-9]{10})', url)
                if asin_match:
                    result['product_id'] = asin_match.group(1)

            elif 'flipkart' in domain:
                result['platform'] = 'flipkart'
                # Extract product ID from Flipkart URL
                pid_match = re.search(r'pid=([A-Z0-9]+)', url)
                if pid_match:
                    result['product_id'] = pid_match.group(1)

            elif 'myntra' in domain:
                result['platform'] = 'myntra'
                # Extract product ID from Myntra URL
                pid_match = re.search(r'/(\d+)/buy', url)
                if pid_match:
                    result['product_id'] = pid_match.group(1)

            elif any(platform in domain for platform in ['snapdeal', 'ajio', 'meesho']):
                for platform in ['snapdeal', 'ajio', 'meesho']:
                    if platform in domain:
                        result['platform'] = platform
                        break

            logger.info(f"Extracted platform info: {result}")

        except Exception as e:
            logger.error(f"Error extracting platform info: {e}")

        return result

    def _scrape_product_url(self, url: str) -> dict:
        """
        Universal product name extractor from ANY e-commerce URL.
        Works for all platforms without hardcoding.

        Strategy:
        1. Parse URL path segments
        2. Skip noise words (dp, p, itm, pid, etc.)
        3. Find segment that looks like a product name:
           - Contains hyphens (URL slugs use hyphens for spaces)
           - Longest readable segment
           - Not pure random IDs
        4. Clean: hyphens → spaces
        """
        try:
            from urllib.parse import urlparse, unquote
            parsed = urlparse(url)
            path = unquote(parsed.path)

            segments = [s for s in path.strip('/').split('/') if s]
            if not segments:
                return None

            candidates = []
            for segment in segments:
                segment_lower = segment.lower()

                if segment_lower in self.URL_NOISE_WORDS:
                    continue
                if re.match(r'^[a-z]?[a-z0-9]{10,20}$', segment_lower):
                    continue
                if len(segment) < 5:
                    continue

                score = 0
                if '-' in segment:
                    score += 10
                words = segment.replace('-', ' ').replace('_', ' ').split()
                score += len(words) * 5
                if re.match(r'^[A-Z0-9]{5,15}$', segment):
                    score -= 5

                candidates.append((segment, score))

            if not candidates:
                return None

            candidates.sort(key=lambda x: x[1], reverse=True)
            best = candidates[0][0]

            product_name = best.replace('-', ' ').replace('_', ' ')
            product_name = re.sub(r'\s+', ' ', product_name).strip().title()

            if len(product_name) >= 3:
                return {'name': product_name}

            return None

        except Exception as e:
            logger.error(f"Error extracting product from URL: {e}")
            return None

    def _cache_product(self, cache_key: str, product_data: dict):
        """
        Cache scraped product data for fast future lookups

        Uses LRU eviction when cache size exceeds limit

        Args:
            cache_key (str): Cache key (platform:product_id)
            product_data (dict): Scraped product data
        """
        # Check if cache is full
        if len(self._product_cache) >= self._cache_max_size:
            # Remove oldest entry (FIFO eviction)
            oldest_key = next(iter(self._product_cache))
            del self._product_cache[oldest_key]
            logger.debug(f"Cache full, evicted: {oldest_key}")

        # Add to cache
        self._product_cache[cache_key] = product_data
        logger.debug(f"Cached product: {cache_key} (cache size: {len(self._product_cache)})")

    @classmethod
    def clear_cache(cls):
        """Clear the product cache (useful for testing or memory management)"""
        cls._product_cache.clear()
        logger.info("Product cache cleared")

    @classmethod
    def get_cache_stats(cls):
        """Get cache statistics"""
        return {
            'size': len(cls._product_cache),
            'max_size': cls._cache_max_size,
            'products': list(cls._product_cache.keys())
        }

    def _product_to_text(self, product_data: dict) -> str:
        """
        Convert product data to searchable text for preprocessing pipeline

        Args:
            product_data (dict): Scraped product information
                {
                    'name': str,
                    'price': float,
                    'specs': dict,
                    'category': str,
                    'brand': str,
                    'rating': float
                }

        Returns:
            str: Text representation for feature extraction and embedding
        """
        parts = []

        # Product name (most important - includes brand, model, variant)
        if product_data.get('name'):
            parts.append(product_data['name'])

        # Specifications (RAM, Storage, Screen Size, etc.)
        if product_data.get('specs') and isinstance(product_data['specs'], dict):
            for key, value in product_data['specs'].items():
                if value:
                    # Format: "RAM 8GB" or "Storage 128GB"
                    parts.append(f"{key} {value}")

        # Price (important for price-based queries)
        if product_data.get('price'):
            parts.append(f"price {product_data['price']}")

        # Category (helps with categorization)
        if product_data.get('category'):
            parts.append(product_data['category'])

        # Brand (if not already in name)
        if product_data.get('brand'):
            brand = product_data['brand']
            name = product_data.get('name', '')
            if brand.lower() not in name.lower():
                parts.append(brand)

        # Rating (quality indicator)
        if product_data.get('rating'):
            parts.append(f"rating {product_data['rating']}")

        text = ' '.join(parts)
        logger.debug(f"Product converted to text: {text[:200]}")

        return text

    def close(self):
        """Close session"""
        if self.session:
            self.session.close()
