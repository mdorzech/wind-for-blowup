"""Phone push notifications through ntfy."""

from __future__ import annotations

from typing import Any, Callable

from .http import HttpError, request_json


class NotifyError(Exception):
    """The notification could not be delivered."""


class Notifier:
    def __init__(
        self,
        server: str,
        topic: str,
        click_url: str = "",
        fetch: Callable[..., Any] = request_json,
    ):
        self._server = server
        self._topic = topic
        self._click_url = click_url
        self._fetch = fetch

    def send(self, title: str, message: str, *, urgent: bool = False, tag: str = "wind_face") -> None:
        body: dict[str, Any] = {
            "topic": self._topic,
            "title": title,
            "message": message,
            "priority": 5 if urgent else 3,
            "tags": [tag],
        }
        if self._click_url:
            body["click"] = self._click_url
        try:
            self._fetch("POST", self._server + "/", body=body)
        except HttpError as exc:
            raise NotifyError(str(exc)) from exc
