"""Tiny JSON-over-HTTPS client with retries (standard library only)."""

from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from typing import Any, Callable

log = logging.getLogger(__name__)

RETRY_STATUS = {429, 500, 502, 503, 504}


class HttpError(Exception):
    """A request failed after all retries, or returned an unusable response."""


def request_json(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: Any = None,
    timeout: float = 15.0,
    attempts: int = 4,
    sleep: Callable[[float], None] = time.sleep,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> Any:
    """Send a request and return the decoded JSON response.

    Retries network errors and 429/5xx responses with a short backoff.
    URLs and header values are never logged: they can carry the location,
    the notification topic or an API key.
    """
    if not url.lower().startswith("https://"):
        raise HttpError("refusing to send a request to a non-HTTPS URL")

    data = None
    all_headers = {"Accept": "application/json", "User-Agent": "windguard"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        all_headers["Content-Type"] = "application/json"
    all_headers.update(headers or {})

    host = url.split("/")[2]
    last_error = "no attempts made"
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, data=data, headers=all_headers, method=method)
        wait = 2.0 * attempt
        try:
            with opener(request, timeout=timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            last_error = f"HTTP {exc.code}"
            if exc.code not in RETRY_STATUS:
                raise HttpError(f"{host} answered {last_error}") from None
            if exc.code == 429:
                # Rate limited (shared cloud machines hit this): back off much longer.
                wait = _retry_after(exc, default=15.0 * attempt)
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = type(exc).__name__
        else:
            try:
                return json.loads(raw.decode("utf-8")) if raw else {}
            except (ValueError, UnicodeDecodeError):
                raise HttpError(f"{host} returned a response that is not JSON") from None
        log.warning("%s %s failed (%s), attempt %d of %d", method, host, last_error, attempt, attempts)
        if attempt < attempts:
            sleep(wait)
    raise HttpError(f"{host} unreachable after {attempts} attempts ({last_error})")


def _retry_after(exc: urllib.error.HTTPError, default: float) -> float:
    """Seconds to wait from a Retry-After header, capped at 60; default when absent or unreadable."""
    try:
        value = float(exc.headers.get("Retry-After", "")) if exc.headers else default
    except (TypeError, ValueError):
        value = default
    return min(max(value, 1.0), 60.0)
