"""The loopback HTTP server the userscript long-polls for commands."""

from __future__ import annotations

import json

from aiohttp import web

from .bus import EventBus


def _cursor_from(request: web.Request) -> int:
    try:
        return max(0, int(request.query.get("cursor", "0")))
    except (TypeError, ValueError):
        return 0


async def _health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "settings": request.app["settings"]})


async def _events(request: web.Request) -> web.Response:
    bus: EventBus = request.app["bus"]
    cursor = _cursor_from(request)
    # A cursor ahead of our own means the client outlived a previous daemon,
    # whose sequence started over at 0. Snap it to the present rather than
    # stalling until the new sequence catches up. Resetting to 0 instead would
    # replay the log at it -- including 'open', which navigates the page.
    cursor = min(cursor, bus.cursor)
    events = await bus.wait_for(cursor, timeout=request.app["poll_timeout"])
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
    request.app["bus"].set_state(payload)
    return web.json_response({"ok": True})


async def _get_state(request: web.Request) -> web.Response:
    return web.json_response(request.app["bus"].get_state())


def create_app(
    bus: EventBus, settings: dict, poll_timeout: float = 25.0
) -> web.Application:
    app = web.Application()
    app["bus"] = bus
    app["settings"] = settings
    app["poll_timeout"] = poll_timeout
    app.add_routes(
        [
            web.get("/health", _health),
            web.get("/events", _events),
            web.get("/state", _get_state),
            web.post("/state", _post_state),
        ]
    )
    return app
