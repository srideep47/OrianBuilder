from __future__ import annotations

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from requests import RequestException
from sqlite3 import IntegrityError
import sys

from .db import get_connection, init_db
from .ollama import summarize_changes
from .schemas import ProductCreate, SummarizeRequest, WebsiteCreate
from .scraper import (
    content_hash,
    extract_articles,
    extract_price_and_currency_from_html,
    extract_product_image,
    extract_rating,
    extract_website_summary,
    fetch_url,
    fetch_url_text,
)




app = FastAPI(title="Watchdog API")
scheduler = BackgroundScheduler()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def row_to_dict(row):
    return dict(row) if row else None


def check_all_products() -> None:
    with get_connection() as conn:
        products = conn.execute("SELECT id, url FROM tracked_products").fetchall()
        for product in products:
            try:
                html = fetch_url(product["url"])
                price, currency = extract_price_and_currency_from_html(html)
                image_url = extract_product_image(html)

                if price is None:
                    print(f"WARNING: No price found for {product['url']}", file=sys.stderr)
                    continue

                rating, rating_count = extract_rating(html)
                conn.execute(
                    "UPDATE tracked_products SET current_price = ?, current_currency = ?, image_url = ?, rating = COALESCE(?, rating), rating_count = COALESCE(?, rating_count) WHERE id = ?",
                    (price, currency, image_url, rating, rating_count, product["id"]),
                )
                conn.execute(
                    "INSERT INTO price_history (product_id, price) VALUES (?, ?)",
                    (product["id"], price),
                )
            except (RequestException, RuntimeError, ValueError) as e:
                print(f"ERROR: Failed to fetch {product['url']}: {e}", file=sys.stderr)
                continue
        conn.commit()



def check_all_websites() -> None:
    with get_connection() as conn:
        websites = conn.execute(
            "SELECT id, url, last_content_hash, last_checked_text FROM tracked_websites"
        ).fetchall()
        for website in websites:
            try:
                new_text = fetch_url_text(website["url"])
                new_hash = content_hash(new_text)

                # If unchanged, avoid extra Ollama calls.
                if website["last_content_hash"] == new_hash:
                    continue

                if website["last_checked_text"]:
                    try:
                        # Truncate to avoid oversized prompts/timeouts
                        summary = summarize_changes(website["last_checked_text"], new_text[:2500])

                    except Exception as exc:
                        print(f"ERROR: Ollama summarize failed for {website['url']}: {exc}", file=sys.stderr)
                        summary = "Website changed, but AI summary failed."
                else:
                    summary = "Initial snapshot captured."

                conn.execute(
                    """
                    UPDATE tracked_websites
                    SET last_content_hash = ?, summary = ?, last_checked_text = ?
                    WHERE id = ?
                    """,
                    (new_hash, summary, new_text, website["id"]),
                )
                
                # Store update in history
                conn.execute(
                    "INSERT INTO website_updates (website_id, update_text) VALUES (?, ?)",
                    (website["id"], summary),
                )
            except (RequestException, RuntimeError, ValueError) as e:
                print(f"ERROR: Failed to fetch {website['url']}: {e}", file=sys.stderr)
                continue
        conn.commit()


@app.on_event("startup")
def startup_event() -> None:
    init_db()
    if not scheduler.running:
        scheduler.add_job(check_all_products, "interval", minutes=15, id="check-products")
        scheduler.add_job(check_all_websites, "interval", minutes=30, id="check-websites")
        scheduler.start()


@app.on_event("shutdown")
def shutdown_event() -> None:
    if scheduler.running:
        scheduler.shutdown(wait=False)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/summarize")
def summarize(payload: SummarizeRequest):
    try:
        summary = summarize_changes(payload.old_text, payload.new_text)
    except RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Ollama request failed: {exc}") from exc
    return {"summary": summary}


@app.get("/websites")
def list_websites():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, url, last_content_hash, summary FROM tracked_websites ORDER BY id DESC"
        ).fetchall()
        return [dict(row) for row in rows]


@app.post("/websites")
def add_website(payload: WebsiteCreate):
    url = str(payload.url)
    summary: str = "Newly added"
    initial_text: str | None = None
    initial_hash: str | None = None
    try:
        html = fetch_url(url)
        extracted = extract_website_summary(html)
        if extracted:
            summary = extracted
        # Seed last_checked_text / last_content_hash so the first scheduled
        # check produces a real "what changed" diff instead of another snapshot.
        initial_text = fetch_url_text(url)
        initial_hash = content_hash(initial_text)
    except (RequestException, RuntimeError, ValueError) as exc:
        print(f"WARNING: initial website fetch failed for {url}: {exc}", file=sys.stderr)

    with get_connection() as conn:
        try:
            conn.execute(
                "INSERT INTO tracked_websites (url, summary, last_checked_text, last_content_hash) VALUES (?, ?, ?, ?)",
                (url, summary, initial_text, initial_hash),
            )
            conn.commit()
        except IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Website already tracked") from exc
        row = conn.execute(
            "SELECT id, url, last_content_hash, summary FROM tracked_websites WHERE url = ?",
            (url,),
        ).fetchone()
        return row_to_dict(row)


@app.delete("/websites/{website_id}")
def remove_website(website_id: int):
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM tracked_websites WHERE id = ?", (website_id,))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Website not found")
    return {"deleted": True}


@app.post("/websites/{website_id}/check")
def check_website(website_id: int):
    with get_connection() as conn:
        website = conn.execute(
            "SELECT id, url, last_content_hash, last_checked_text FROM tracked_websites WHERE id = ?",
            (website_id,),
        ).fetchone()
        if not website:
            raise HTTPException(status_code=404, detail="Website not found")
        try:
            new_text = fetch_url_text(website["url"])
        except RequestException as exc:
            raise HTTPException(status_code=400, detail=f"Unable to fetch website: {exc}") from exc

        new_hash = content_hash(new_text)
        if website["last_content_hash"] == new_hash:
            summary = "No updates detected."
        elif website["last_checked_text"]:
            try:
                summary = summarize_changes(website["last_checked_text"], new_text[:2500])
            except Exception as exc:
                print(f"ERROR: Ollama summarize failed for {website['url']}: {exc}", file=sys.stderr)
                summary = "Website changed, but AI summary failed."
        else:
            summary = "Initial snapshot captured."

        conn.execute(
            """
            UPDATE tracked_websites
            SET last_content_hash = ?, summary = ?, last_checked_text = ?
            WHERE id = ?
            """,
            (new_hash, summary, new_text, website_id),
        )
        
        # Store update in history
        conn.execute(
            "INSERT INTO website_updates (website_id, update_text) VALUES (?, ?)",
            (website_id, summary),
        )
        
        conn.commit()
        row = conn.execute(
            "SELECT id, url, last_content_hash, summary FROM tracked_websites WHERE id = ?",
            (website_id,),
        ).fetchone()
        return row_to_dict(row)


@app.get("/websites/{website_id}/updates")
def website_updates_history(website_id: int):
    with get_connection() as conn:
        website = conn.execute("SELECT id FROM tracked_websites WHERE id = ?", (website_id,)).fetchone()
        if not website:
            raise HTTPException(status_code=404, detail="Website not found")
        rows = conn.execute(
            "SELECT id, website_id, update_text, timestamp FROM website_updates WHERE website_id = ? ORDER BY timestamp DESC LIMIT 20",
            (website_id,),
        ).fetchall()
        return [dict(row) for row in rows]


@app.get("/websites/{website_id}/items")
def website_items(website_id: int):
    """Scrape the page live and return current article/post-like links so the
    user can see what's actually 'on the radar' right now."""
    with get_connection() as conn:
        website = conn.execute(
            "SELECT id, url FROM tracked_websites WHERE id = ?", (website_id,)
        ).fetchone()
    if not website:
        raise HTTPException(status_code=404, detail="Website not found")
    try:
        html = fetch_url(website["url"])
    except (RequestException, RuntimeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Unable to fetch website: {exc}") from exc
    return extract_articles(html, website["url"])


@app.get("/products")
def list_products():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, url, current_price, current_currency, target_price, target_currency, image_url, rating, rating_count FROM tracked_products ORDER BY id DESC"
        ).fetchall()
        return [dict(row) for row in rows]


@app.post("/products")
def add_product(payload: ProductCreate):
    url = str(payload.url)
    price: float | None = None
    currency: str | None = None
    image_url: str | None = None
    rating: float | None = None
    rating_count: int | None = None
    try:
        html = fetch_url(url)
        price, currency = extract_price_and_currency_from_html(html)
        image_url = extract_product_image(html)
        rating, rating_count = extract_rating(html)
    except (RequestException, RuntimeError, ValueError) as exc:
        print(f"WARNING: initial fetch failed for {url}: {exc}", file=sys.stderr)

    with get_connection() as conn:
        try:
            conn.execute(
                "INSERT INTO tracked_products (url, current_price, current_currency, target_price, image_url, rating, rating_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (url, price, currency, payload.target_price, image_url, rating, rating_count),
            )
            if price is not None:
                conn.execute(
                    "INSERT INTO price_history (product_id, price) VALUES ((SELECT id FROM tracked_products WHERE url = ?), ?)",
                    (url, price),
                )
            conn.commit()
        except IntegrityError as exc:
            raise HTTPException(status_code=409, detail="Product already tracked") from exc

        row = conn.execute(
            "SELECT id, url, current_price, current_currency, target_price, target_currency, image_url, rating, rating_count FROM tracked_products WHERE url = ?",
            (url,),
        ).fetchone()
        return row_to_dict(row)


@app.delete("/products/{product_id}")
def remove_product(product_id: int):
    with get_connection() as conn:
        conn.execute("DELETE FROM price_history WHERE product_id = ?", (product_id,))
        cursor = conn.execute("DELETE FROM tracked_products WHERE id = ?", (product_id,))
        conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Product not found")
    return {"deleted": True}


@app.post("/products/{product_id}/check")
def check_product(product_id: int):
    with get_connection() as conn:
        product = conn.execute(
            "SELECT id, url, current_price, current_currency, target_price, target_currency, image_url, rating, rating_count FROM tracked_products WHERE id = ?",
            (product_id,),
        ).fetchone()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        try:
            html = fetch_url(product["url"])
        except (RequestException, RuntimeError, ValueError) as exc:
            print(f"ERROR: Failed to fetch product {product['url']}: {exc}", file=sys.stderr)
            raise HTTPException(status_code=400, detail=f"Unable to fetch product URL: {exc}") from exc
        
        price, currency = extract_price_and_currency_from_html(html)
        if price is None:
            print(f"ERROR: No detectable price on product page {product['url']}", file=sys.stderr)
            lowered = html.lower()
            if any(p in lowered for p in ("captcha", "are you a robot", "not a robot")):
                raise HTTPException(
                    status_code=422,
                    detail="The site returned a bot/CAPTCHA page — try the full product URL (not a shortlink) or a different site.",
                )
            raise HTTPException(
                status_code=422,
                detail="Could not detect a price on this page. The site may not expose a parseable price.",
            )

        image_url = extract_product_image(html)
        rating, rating_count = extract_rating(html)
        conn.execute(
            "UPDATE tracked_products SET current_price = ?, current_currency = ?, image_url = ?, rating = COALESCE(?, rating), rating_count = COALESCE(?, rating_count) WHERE id = ?",
            (price, currency, image_url, rating, rating_count, product_id),
        )

        conn.execute(
            "INSERT INTO price_history (product_id, price) VALUES (?, ?)",
            (product_id, price),
        )
        conn.commit()
        row = conn.execute(
            "SELECT id, url, current_price, current_currency, target_price, target_currency, image_url, rating, rating_count FROM tracked_products WHERE id = ?",
            (product_id,),
        ).fetchone()
        return row_to_dict(row)


@app.get("/products/{product_id}/history")
def product_history(product_id: int):
    with get_connection() as conn:
        product = conn.execute("SELECT id FROM tracked_products WHERE id = ?", (product_id,)).fetchone()
        if not product:
            raise HTTPException(status_code=404, detail="Product not found")
        rows = conn.execute(
            "SELECT id, product_id, price, timestamp FROM price_history WHERE product_id = ? ORDER BY timestamp ASC",
            (product_id,),
        ).fetchall()
        return [dict(row) for row in rows]
