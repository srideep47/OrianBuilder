"""LLM client for change summaries.

Two endpoints are supported, chosen at request time by the WATCHDOG_LLM_MODE
environment variable:

  - "openai"  (default when embedded in OrianBuilder) → POSTs to
                ${WATCHDOG_LLM_URL}/v1/chat/completions with the OpenAI shape.
                OrianBuilder's bundled llama-server speaks this on port 11435.

  - "ollama"  (default in the standalone repo)        → POSTs to
                ${WATCHDOG_LLM_URL}/api/generate with the Ollama shape on 11434.

If the LLM endpoint is unreachable we raise; the FastAPI route already catches
that and substitutes a fallback summary so the rest of the app keeps working.
"""

from __future__ import annotations

import os

import requests

LLM_MODE = os.environ.get("WATCHDOG_LLM_MODE", "ollama").lower()
LLM_URL = os.environ.get(
    "WATCHDOG_LLM_URL",
    "http://127.0.0.1:11435" if LLM_MODE == "openai" else "http://127.0.0.1:11434",
)
MODEL_NAME = os.environ.get("WATCHDOG_LLM_MODEL", "qwen3.5:4b")

REQUEST_TIMEOUT_SECONDS = 120


def _build_prompt(old_text: str, new_text: str) -> str:
    return (
        "Compare the old and new website text below and return exactly one sentence "
        "describing what changed.\n\n"
        f"OLD TEXT:\n{old_text[:4000]}\n\nNEW TEXT:\n{new_text[:4000]}"
    )


def _summarize_ollama(prompt: str) -> str:
    payload = {"model": MODEL_NAME, "prompt": prompt, "stream": False}
    response = requests.post(
        f"{LLM_URL}/api/generate", json=payload, timeout=REQUEST_TIMEOUT_SECONDS
    )
    response.raise_for_status()
    data = response.json()
    return (data.get("response") or "").strip()


def _summarize_openai(prompt: str) -> str:
    payload = {
        "model": MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "stream": False,
        "temperature": 0.3,
    }
    response = requests.post(
        f"{LLM_URL}/v1/chat/completions",
        json=payload,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    data = response.json()
    choices = data.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    return (message.get("content") or "").strip()


def summarize_changes(old_text: str, new_text: str) -> str:
    prompt = _build_prompt(old_text, new_text)
    text = (
        _summarize_openai(prompt) if LLM_MODE == "openai" else _summarize_ollama(prompt)
    )
    return text or "No meaningful change detected."
