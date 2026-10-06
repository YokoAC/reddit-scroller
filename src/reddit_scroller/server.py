"""The loopback HTTP server the userscript long-polls for commands."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from aiohttp import web

from .bus import EventBus
from .config import ConfigError, KeyBinding, resolve_codes

# Typed keys rather than bare strings: aiohttp warns on the latter, and these
# let the checker verify what goes in and comes back out of the app store.
BUS: web.AppKey[EventBus] = web.AppKey("bus")
SETTINGS: web.AppKey[dict[str, Any]] = web.AppKey("settings")
POLL_TIMEOUT: web.AppKey[float] = web.AppKey("poll_timeout")
ON_BINDINGS: web.AppKey[Callable[[dict[str, KeyBinding]], None] | None] = web.AppKey(
    "on_bindings"
)

_LOOPBACK = frozenset({"127.0.0.1", "localhost"})


def _cursor_from(request: web.Request) -> int:
    try:
        return max(0, int(request.query.get("cursor", "0")))
    except (TypeError, ValueError):
        return 0


async def _health(request: web.Request) -> web.Response:
    # The cursor lets a freshly loaded page start from the present. Polling
    # from 0 would replay every command still in the log at it.
    return web.json_response(
        {
            "ok": True,
            "settings": request.app[SETTINGS],
            "cursor": request.app[BUS].cursor,
        }
    )


async def _events(request: web.Request) -> web.Response:
    bus = request.app[BUS]
    cursor = _cursor_from(request)
    # A cursor ahead of our own means the client outlived a previous daemon,
    # whose sequence started over at 0. Snap it to the present rather than
    # stalling until the new sequence catches up. Resetting to 0 instead would
    # replay the log at it -- including 'open', which navigates the page.
    cursor = min(cursor, bus.cursor)
    events = await bus.wait_for(cursor, timeout=request.app[POLL_TIMEOUT])
    new_cursor = events[-1].seq if events else cursor
    return web.json_response(
        {"cursor": new_cursor, "events": [event.as_dict() for event in events]}
    )


async def _post_state(request: web.Request) -> web.Response:
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        return web.json_response(
            {"ok": False, "error": "body is not valid JSON"}, status=400
        )
    if not isinstance(payload, dict):
        return web.json_response(
            {"ok": False, "error": "body must be a JSON object"}, status=400
        )
    request.app[BUS].set_state(payload)
    return web.json_response({"ok": True})


def _refusal(request: web.Request) -> str | None:
    """Why this request may not change the keys, or None if it may.

    The loopback bind keeps other machines out, but not the pages open in the
    user's own browser. Those cannot hide what they are: the browser attaches
    Origin to a page's POST, and page script can neither remove nor forge it.
    A userscript manager sends none, or its extension's.
    """
    origin = request.headers.get("Origin")
    if origin is not None and not origin.split("://")[0].endswith("-extension"):
        return f"requests from {origin} are not accepted"
    # DNS rebinding makes a hostile name same-origin with us; Host gives it away.
    if request.host.rsplit(":", 1)[0] not in _LOOPBACK:
        return f"unexpected Host {request.host}"
    # The types a plain HTML form can send skip the CORS preflight.
    if request.content_type != "application/json":
        return "the body must be sent as application/json"
    return None


def _bad_request(message: str) -> web.Response:
    return web.json_response({"ok": False, "error": message}, status=400)


async def _post_bindings(request: web.Request) -> web.Response:
    refusal = _refusal(request)
    if refusal is not None:
        return web.json_response({"ok": False, "error": refusal}, status=403)
    try:
        payload = await request.json()
    except (json.JSONDecodeError, ValueError):
        return _bad_request("body is not valid JSON")
    if not isinstance(payload, dict) or "bindings" not in payload:
        return _bad_request('body must be an object with a "bindings" key')
    try:
        resolved = resolve_codes(payload["bindings"])
    except ConfigError as exc:
        return _bad_request(str(exc))

    apply = request.app[ON_BINDINGS]
    if apply is None:
        return web.json_response(
            {"ok": False, "error": "no keyboard listener to apply them to"},
            status=503,
        )
    apply(resolved.bindings)
    # /health describes the keys in effect, so a page that has none of its own
    # shows these rather than config.json's.
    settings = request.app[SETTINGS]
    settings["binding_codes"] = resolved.codes
    settings["bindings"] = resolved.names()
    return web.json_response({"ok": True, "unsupported": resolved.unsupported})


async def _get_state(request: web.Request) -> web.Response:
    return web.json_response(request.app[BUS].get_state())


def create_app(
    bus: EventBus,
    settings: dict[str, Any],
    poll_timeout: float = 25.0,
    on_bindings: Callable[[dict[str, KeyBinding]], None] | None = None,
) -> web.Application:
    app = web.Application()
    app[BUS] = bus
    app[SETTINGS] = settings
    app[POLL_TIMEOUT] = poll_timeout
    app[ON_BINDINGS] = on_bindings
    app.add_routes(
        [
            web.get("/health", _health),
            web.get("/events", _events),
            web.get("/state", _get_state),
            web.post("/state", _post_state),
            web.post("/bindings", _post_bindings),
        ]
    )
    return app
