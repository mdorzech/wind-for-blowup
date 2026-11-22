"""Govee Open API client. It can read plug state and switch plugs OFF, never on."""

from __future__ import annotations

import uuid
from typing import Any, Callable

from .config import Device
from .http import HttpError, request_json

BASE_URL = "https://openapi.api.govee.com/router/api/v1"
ON_OFF = "devices.capabilities.on_off"


class GoveeError(Exception):
    """A Govee API call failed."""


class GoveeClient:
    def __init__(self, api_key: str, fetch: Callable[..., Any] = request_json):
        self._headers = {"Govee-API-Key": api_key}
        self._fetch = fetch

    def _call(self, method: str, path: str, body: Any = None) -> dict:
        try:
            reply = self._fetch(method, f"{BASE_URL}{path}", headers=self._headers, body=body)
        except HttpError as exc:
            raise GoveeError(str(exc)) from exc
        if not isinstance(reply, dict) or reply.get("code") != 200:
            code = reply.get("code") if isinstance(reply, dict) else "?"
            raise GoveeError(f"Govee rejected the request (code {code})")
        return reply

    def list_devices(self) -> list[dict[str, Any]]:
        """Return every device on the account and whether it has an on/off switch."""
        data = self._call("GET", "/user/devices").get("data") or []
        devices = []
        for item in data:
            capabilities = item.get("capabilities") or []
            devices.append(
                {
                    "name": item.get("deviceName", ""),
                    "sku": item.get("sku", ""),
                    "device_id": item.get("device", ""),
                    "switchable": any(c.get("type") == ON_OFF for c in capabilities),
                }
            )
        return devices

    def is_on(self, device: Device) -> bool | None:
        """True/False for the plug's power state, or None when Govee does not report it."""
        body = {
            "requestId": str(uuid.uuid4()),
            "payload": {"sku": device.sku, "device": device.device_id},
        }
        payload = self._call("POST", "/device/state", body).get("payload") or {}
        for capability in payload.get("capabilities") or []:
            if capability.get("type") == ON_OFF:
                value = (capability.get("state") or {}).get("value")
                if value in (0, 1):
                    return bool(value)
        return None

    def turn_off(self, device: Device) -> None:
        body = {
            "requestId": str(uuid.uuid4()),
            "payload": {
                "sku": device.sku,
                "device": device.device_id,
                "capability": {"type": ON_OFF, "instance": "powerSwitch", "value": 0},
            },
        }
        self._call("POST", "/device/control", body)
