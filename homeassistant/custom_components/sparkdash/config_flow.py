"""Config flow for sparkDash."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import urlparse

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import DEFAULT_URL, DOMAIN, auth_headers


class SparkDashConfigFlow(ConfigFlow, domain=DOMAIN):
    """Ask for the sparkDash base URL and check /api/sparks."""

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            url = str(user_input["url"]).strip().rstrip("/")
            token = str(user_input.get("token") or "").strip()
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.netloc:
                errors["base"] = "invalid_url"
            else:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                try:
                    session = async_get_clientsession(self.hass)
                    async with asyncio.timeout(15):
                        async with session.get(
                            f"{url}/api/sparks",
                            headers=auth_headers(token),
                            allow_redirects=False,
                        ) as resp:
                            # 401 is a rejected token; 403 is the hub's Host/remote
                            # guard refusing the request, which no token fixes.
                            if resp.status == 401:
                                errors["base"] = "invalid_auth"
                            else:
                                resp.raise_for_status()
                                body = await resp.json(content_type=None)
                                if not isinstance(body, dict) or "sparks" not in body:
                                    errors["base"] = "cannot_connect"
                                else:
                                    count = len(body.get("sparks") or [])
                                    data: dict[str, str] = {"url": url}
                                    if token:
                                        data["token"] = token
                                    return self.async_create_entry(
                                        title=f"sparkDash ({count})",
                                        data=data,
                                    )
                except Exception:
                    errors["base"] = "cannot_connect"
            user_input = {"url": url, "token": token}
        entered = user_input or {}
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required("url", default=entered.get("url", DEFAULT_URL)): str,
                    vol.Optional("token", default=entered.get("token", "")): str,
                }
            ),
            errors=errors,
        )
