from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from bs4 import BeautifulSoup
from cloudscraper import create_scraper

_scraper = create_scraper()

# Robust headers to bypass anti-bot protections
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Cache-Control": "max-age=0",
}

# Currency symbol detection + numeric price extraction.
# Supports: $, £, €, ₹. The value group accepts both US (1,234,567.89) and
# Indian (4,99,990 / 12,34,56,789) comma grouping; commas are stripped during
# post-processing in extract_price_and_currency.
PRICE_PATTERN = re.compile(
    r"(?P<currency>₹|\$|£|€)\s*(?P<value>[0-9][0-9,]*(?:\.[0-9]{1,2})?)"
)

# If anti-bot challenges are detected, we *do not* hard-fail.
# Instead we return whatever HTML we received so downstream extraction can
# still succeed on pages that don't fully block.
CAPTCHA_PATTERNS = (
    "captcha",
    "enter the characters you see below",
    "type the characters you see in this image",
    "sorry, we just need to make sure you're not a robot",
    "to discuss automated access to amazon data",
    "checking your browser before accessing",
)


def _is_blocked_page(html: str) -> bool:
    lowered = html.lower()
    return any(p in lowered for p in CAPTCHA_PATTERNS)


# Below this absolute amount, a "price" match is almost always garbage
# (a stray "₹4" in a footer, a sticker count, an icon size, etc.).
MIN_PLAUSIBLE_PRICE = 10.0



def fetch_url(url: str) -> str:
    response = _scraper.get(url, timeout=25, headers=HEADERS)
    response.raise_for_status()
    html = response.text
    lowered = html.lower()
    if any(pattern in lowered for pattern in CAPTCHA_PATTERNS):
        # Do not fail hard on CAPTCHA blocks; return the HTML so extraction
        # can still attempt to find price/text if the blocking page contains it.
        return html
    return html



def fetch_url_text(url: str) -> str:
    html = fetch_url(url)
    soup = BeautifulSoup(html, "html.parser")

    for tag in soup(["script", "style", "noscript"]):
        tag.extract()

    return " ".join(soup.get_text(" ", strip=True).split())


def extract_price_and_currency(text: str) -> Tuple[Optional[float], Optional[str]]:
    """Extract a currency-prefixed price from text. Returns (None, None) if no
    explicit currency symbol is present — bare numbers are too ambiguous (they
    catch ratings, dates, ids) and produced false prices before."""
    match = PRICE_PATTERN.search(text)
    if not match:
        return None, None
    numeric = match.group("value").replace(",", "")
    try:
        return float(numeric), match.group("currency")
    except ValueError:
        return None, None


CURRENCY_CODE_TO_SYMBOL = {
    "INR": "₹",
    "USD": "$",
    "GBP": "£",
    "EUR": "€",
    "CAD": "$",
    "AUD": "$",
    "SGD": "$",
}


def _coerce_price(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        cleaned = re.sub(r"[^0-9.]", "", value.replace(",", ""))
        try:
            return float(cleaned) if cleaned else None
        except ValueError:
            return None
    return None


def _iter_json_offers(node: Any) -> Iterable[dict]:
    if isinstance(node, list):
        for item in node:
            yield from _iter_json_offers(item)
    elif isinstance(node, dict):
        offers = node.get("offers")
        if offers is not None:
            yield from _iter_json_offers(offers)
        if "price" in node or "lowPrice" in node:
            yield node
        for key in ("@graph", "itemListElement", "hasOfferCatalog"):
            if key in node:
                yield from _iter_json_offers(node[key])


def _extract_from_jsonld(soup: BeautifulSoup) -> Tuple[Optional[float], Optional[str]]:
    """Collects every offer in every JSON-LD block on the page, then picks the
    highest plausible price. Pages often embed offers for accessories, cashbacks,
    and bank promos in addition to the main product; on a real product page the
    main item is almost always the most expensive offer."""
    candidates: list[Tuple[float, Optional[str]]] = []
    for tag in soup.find_all("script", type="application/ld+json"):
        raw = tag.string or tag.get_text() or ""
        if not raw.strip():
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        for offer in _iter_json_offers(data):
            price = _coerce_price(offer.get("price") or offer.get("lowPrice"))
            if price is None or price < MIN_PLAUSIBLE_PRICE:
                continue
            currency_code = offer.get("priceCurrency") or offer.get("currency")
            symbol = (
                CURRENCY_CODE_TO_SYMBOL.get(str(currency_code).upper())
                if currency_code
                else None
            )
            candidates.append((price, symbol))
    if not candidates:
        return None, None
    return max(candidates, key=lambda c: c[0])


def _extract_from_meta(soup: BeautifulSoup) -> Tuple[Optional[float], Optional[str]]:
    price_props = (
        "product:price:amount",
        "og:price:amount",
        "twitter:data1",
    )
    currency_props = ("product:price:currency", "og:price:currency")
    price: Optional[float] = None
    for prop in price_props:
        node = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
        if node and node.get("content"):
            price = _coerce_price(node.get("content"))
            if price is not None:
                break
    if price is None:
        return None, None
    symbol: Optional[str] = None
    for prop in currency_props:
        node = soup.find("meta", attrs={"property": prop}) or soup.find("meta", attrs={"name": prop})
        if node and node.get("content"):
            symbol = CURRENCY_CODE_TO_SYMBOL.get(str(node.get("content")).upper())
            if symbol:
                break
    return price, symbol


def _plausible(price: Optional[float]) -> Optional[float]:
    if price is None or price < MIN_PLAUSIBLE_PRICE:
        return None
    return price


def extract_price_and_currency_from_html(html: str) -> Tuple[Optional[float], Optional[str]]:
    soup = BeautifulSoup(html, "html.parser")
    blocked = _is_blocked_page(html)

    # Structured data (schema.org Product / Offer) — most reliable on real shops.
    price, currency = _extract_from_jsonld(soup)
    price = _plausible(price)
    if price is not None:
        return price, currency

    # Open Graph / product price meta tags.
    price, currency = _extract_from_meta(soup)
    price = _plausible(price)
    if price is not None:
        return price, currency

    # Amazon-specific selectors.
    amazon_selectors = (
        "span.a-price span.a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "#price_inside_buybox",
        ".a-price .a-offscreen",
    )
    for selector in amazon_selectors:
        node = soup.select_one(selector)
        if node and node.get_text(strip=True):
            price, currency = extract_price_and_currency(node.get_text(" ", strip=True))
            price = _plausible(price)
            if price is not None:
                return price, currency

    # Amazon split whole/fraction.
    whole = soup.select_one(".a-price-whole")
    fraction = soup.select_one(".a-price-fraction")
    if whole and whole.get_text(strip=True):
        combined = whole.get_text(" ", strip=True).replace(",", "")
        if fraction and fraction.get_text(strip=True):
            combined = f"{combined}.{fraction.get_text(strip=True)}"
        try:
            value = _plausible(float(re.sub(r"[^0-9.]", "", combined)))
            if value is not None:
                return value, "₹"
        except ValueError:
            pass

    # If the response is a CAPTCHA / bot wall, do NOT fall back to scanning visible
    # text — those pages contain random "₹4" / "$1" tokens that produce garbage.
    if blocked:
        return None, None

    # Generic fallback: scan visible text for a currency-prefixed price.
    price, currency = extract_price_and_currency(" ".join(soup.stripped_strings))
    price = _plausible(price)
    if price is None:
        return None, None
    return price, currency


def extract_price(text: str) -> float | None:
    price, _currency = extract_price_and_currency(text)
    return price


def extract_price_from_html(html: str) -> float | None:
    price, _currency = extract_price_and_currency_from_html(html)
    return price


def extract_product_image(html: str) -> Optional[str]:
    soup = BeautifulSoup(html, "html.parser")

    # Strategy 1: Open Graph image (most reliable)
    og_image = soup.find("meta", property="og:image")
    if og_image and og_image.get("content"):
        img_url = og_image.get("content").strip()
        if img_url:
            return img_url

    # Strategy 2: Amazon-specific landing image
    landing_image = soup.select_one("#landingImage")
    if landing_image:
        src = landing_image.get("src")
        if src:
            return src.strip()
        # Fallback: check data-old-hires attribute (Amazon uses this for high-res images)
        data_hires = landing_image.get("data-old-hires")
        if data_hires:
            return data_hires.strip()

    # Strategy 3: Look for images with data-old-hires attribute
    img_with_hires = soup.find("img", attrs={"data-old-hires": True})
    if img_with_hires and img_with_hires.get("data-old-hires"):
        return img_with_hires.get("data-old-hires").strip()

    # Sometimes Amazon exposes the image through data-a-dynamic-image.
    dynamic_image = soup.find("img", attrs={"data-a-dynamic-image": True})
    if dynamic_image:
        src = dynamic_image.get("src")
        if src:
            return src.strip()

    # Strategy 4: First large-ish image (generic fallback)
    for img in soup.find_all("img"):
        src = img.get("src")
        if src and src.strip() and ("image" in src.lower() or "product" in src.lower() or src.startswith("http")):
            return src.strip()

    # Strategy 5: Any image as last resort
    img = soup.find("img")
    if img and img.get("src"):
        return img.get("src").strip()

    return None


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def extract_website_summary(html: str) -> Optional[str]:
    """Builds a short human-readable description of a freshly-added website:
    og:title — og:description, falling back to <title> and meta description."""
    soup = BeautifulSoup(html, "html.parser")

    def meta_content(*queries: dict) -> Optional[str]:
        for q in queries:
            node = soup.find("meta", attrs=q)
            if node and node.get("content"):
                text = " ".join(node.get("content").split())
                if text:
                    return text
        return None

    title = meta_content({"property": "og:title"}, {"name": "twitter:title"})
    if not title:
        title_tag = soup.find("title")
        if title_tag:
            title = " ".join(title_tag.get_text(" ", strip=True).split())

    description = meta_content(
        {"property": "og:description"},
        {"name": "description"},
        {"name": "twitter:description"},
    )

    parts = [p for p in (title, description) if p]
    if not parts:
        return None
    summary = " — ".join(parts)
    if len(summary) > 220:
        summary = summary[:217].rstrip() + "…"
    return summary


# ---------- Article / "recent posts" extraction ----------

_SKIP_LINK_PATTERNS = re.compile(
    r"^(home|news|reviews|videos|search|login|sign[- ]?in|subscribe|menu|about|contact|privacy|terms|cookies?|advert|categories?|tags?|next|prev|previous|more)$",
    re.IGNORECASE,
)


def _absolutize(base: str, href: str) -> Optional[str]:
    if not href or href.startswith("#") or href.startswith("javascript:") or href.startswith("mailto:"):
        return None
    try:
        absolute = urljoin(base, href)
    except ValueError:
        return None
    parsed = urlparse(absolute)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return absolute


def extract_articles(html: str, base_url: str, limit: int = 12) -> List[dict]:
    """Pull article/post-like links out of a listing page.

    Heuristics, in priority order:
      1. <article> elements — take the first anchor with substantial text.
      2. Anchors inside <h1>..<h4> headings.
      3. Anchors inside elements whose class/id hints at posts/articles.
    Filters out nav junk by length and a skip-word list, dedupes by href.
    """
    soup = BeautifulSoup(html, "html.parser")
    seen: set[str] = set()
    items: List[dict] = []

    def push(title: str, href: str) -> None:
        title = " ".join(title.split())
        if len(title) < 18:
            return
        if _SKIP_LINK_PATTERNS.match(title):
            return
        url = _absolutize(base_url, href)
        if not url or url in seen:
            return
        seen.add(url)
        items.append({"title": title, "url": url})

    # 1) <article> tags.
    for article in soup.find_all("article"):
        anchor = article.find("a", href=True)
        if anchor:
            push(anchor.get_text(" ", strip=True), anchor["href"])
        if len(items) >= limit:
            return items

    # 2) Headings with anchors.
    for level in ("h1", "h2", "h3", "h4"):
        for heading in soup.find_all(level):
            anchor = heading.find("a", href=True)
            if anchor:
                push(anchor.get_text(" ", strip=True), anchor["href"])
            if len(items) >= limit:
                return items

    # 3) Class/id hints (post, article, entry, news-item, story).
    hint = re.compile(r"(post|article|entry|story|news[-_ ]?item|listing)", re.IGNORECASE)
    for container in soup.find_all(class_=hint):
        anchor = container.find("a", href=True)
        if anchor:
            push(anchor.get_text(" ", strip=True), anchor["href"])
        if len(items) >= limit:
            return items
    for container in soup.find_all(id=hint):
        anchor = container.find("a", href=True)
        if anchor:
            push(anchor.get_text(" ", strip=True), anchor["href"])
        if len(items) >= limit:
            return items

    return items


# ---------- Rating extraction ----------

def _coerce_int(value: Any) -> Optional[int]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        digits = re.sub(r"[^0-9]", "", value)
        try:
            return int(digits) if digits else None
        except ValueError:
            return None
    return None


def _rating_from_jsonld(soup: BeautifulSoup) -> Tuple[Optional[float], Optional[int]]:
    for tag in soup.find_all("script", type="application/ld+json"):
        raw = tag.string or tag.get_text() or ""
        if not raw.strip():
            continue
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue

        def walk(node: Any) -> Tuple[Optional[float], Optional[int]]:
            if isinstance(node, list):
                for item in node:
                    rv, rc = walk(item)
                    if rv is not None:
                        return rv, rc
            elif isinstance(node, dict):
                agg = node.get("aggregateRating")
                if isinstance(agg, dict):
                    rv = _coerce_price(agg.get("ratingValue"))
                    rc = _coerce_int(agg.get("reviewCount") or agg.get("ratingCount"))
                    if rv is not None:
                        return rv, rc
                for key in ("@graph", "itemListElement"):
                    if key in node:
                        rv, rc = walk(node[key])
                        if rv is not None:
                            return rv, rc
            return None, None

        rv, rc = walk(data)
        if rv is not None:
            return rv, rc
    return None, None


def extract_rating(html: str) -> Tuple[Optional[float], Optional[int]]:
    """Returns (ratingValue, reviewCount) — uses JSON-LD AggregateRating first,
    then Amazon's customer-review markup, then a generic 'X out of 5' pattern.
    Returns (None, None) on CAPTCHA/bot pages to avoid garbage ratings."""
    if _is_blocked_page(html):
        return None, None
    soup = BeautifulSoup(html, "html.parser")

    rating, count = _rating_from_jsonld(soup)
    if rating is not None:
        return rating, count

    # Amazon
    star_node = soup.select_one("span.a-icon-alt") or soup.select_one("#acrPopover .a-icon-alt")
    if star_node:
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*out of\s*5", star_node.get_text(" ", strip=True), re.IGNORECASE)
        if match:
            rating = float(match.group(1))
    count_node = soup.select_one("#acrCustomerReviewText")
    if count_node:
        count = _coerce_int(count_node.get_text(" ", strip=True))
    if rating is not None:
        return rating, count

    # Generic "X out of 5" anywhere in visible text (first match only).
    visible = " ".join(soup.stripped_strings)[:5000]
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(?:out of|/)\s*5\b", visible, re.IGNORECASE)
    if match:
        try:
            rating = float(match.group(1))
            if 0 <= rating <= 5:
                return rating, count
        except ValueError:
            pass

    return None, None

