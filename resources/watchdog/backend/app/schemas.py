from __future__ import annotations

from pydantic import BaseModel, HttpUrl


class WebsiteCreate(BaseModel):
    url: HttpUrl


class ProductCreate(BaseModel):
    url: HttpUrl
    target_price: float | None = None


class SummarizeRequest(BaseModel):
    old_text: str
    new_text: str
