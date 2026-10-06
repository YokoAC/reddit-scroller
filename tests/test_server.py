import asyncio

import pytest

from reddit_scroller.bus import EventBus
from reddit_scroller.config import Config
from reddit_scroller.server import create_app


@pytest.fixture
def bus():
    return EventBus()


@pytest.fixture
async def client(aiohttp_client, bus):
    app = create_app(bus, Config.default().browser_settings(), poll_timeout=0.05)
    return await aiohttp_client(app)


async def test_health_reports_ok_and_the_browser_settings(client):
    resp = await client.get("/health")
    assert resp.status == 200
    body = await resp.json()
    assert body["ok"] is True
    assert body["settings"]["default_speed"] == 90.0
    assert body["settings"]["focus_line"] == 0.25


async def test_events_returns_pending_commands_and_the_new_cursor(client, bus):
    bus.append("toggle")
    bus.append("faster")
    resp = await client.get("/events", params={"cursor": "0"})
    assert resp.status == 200
    body = await resp.json()
    assert body["cursor"] == 2
    assert [e["command"] for e in body["events"]] == ["toggle", "faster"]


async def test_events_honours_the_cursor(client, bus):
    bus.append("toggle")
    bus.append("faster")
    body = await (await client.get("/events", params={"cursor": "1"})).json()
    assert [e["command"] for e in body["events"]] == ["faster"]


async def test_events_times_out_with_an_empty_list_and_an_unchanged_cursor(client):
    body = await (await client.get("/events", params={"cursor": "0"})).json()
    assert body == {"cursor": 0, "events": []}


async def test_events_returns_as_soon_as_a_command_arrives(aiohttp_client, bus):
    # Build a client with a long poll timeout rather than mutating the shared
    # one after it has started: aiohttp deprecates changing a running app, and
    # a test that has to reach inside a started app to work is testing the
    # fixture as much as the server.
    app = create_app(bus, Config.default().browser_settings(), poll_timeout=5.0)
    client = await aiohttp_client(app)

    async def append_soon():
        await asyncio.sleep(0.01)
        bus.append("open")

    appender = asyncio.create_task(append_soon())
    body = await (await client.get("/events", params={"cursor": "0"})).json()
    await appender
    assert [e["command"] for e in body["events"]] == ["open"]


async def test_a_missing_cursor_is_treated_as_zero(client, bus):
    bus.append("back")
    body = await (await client.get("/events")).json()
    assert [e["command"] for e in body["events"]] == ["back"]


async def test_a_junk_cursor_is_treated_as_zero(client, bus):
    bus.append("back")
    body = await (await client.get("/events", params={"cursor": "abc"})).json()
    assert [e["command"] for e in body["events"]] == ["back"]


async def test_state_round_trips(client, bus):
    resp = await client.post("/state", json={"running": True, "speed": 105})
    assert resp.status == 200
    assert (await resp.json())["ok"] is True
    assert bus.get_state() == {"running": True, "speed": 105}
    assert await (await client.get("/state")).json() == {"running": True, "speed": 105}


async def test_a_non_object_state_body_is_rejected(client):
    resp = await client.post("/state", json=[1, 2, 3])
    assert resp.status == 400
    assert (await resp.json())["ok"] is False


async def test_an_invalid_json_state_body_is_rejected(client):
    resp = await client.post(
        "/state", data="{not json", headers={"Content-Type": "application/json"}
    )
    assert resp.status == 400


async def test_a_cursor_ahead_of_the_bus_resyncs_instead_of_stalling(client, bus):
    # A restarted daemon starts its sequence at 0 again while a long-lived
    # browser tab still holds a cursor from the previous session. Without a
    # resync the tab silently ignores every command until the new sequence
    # catches up to its stale cursor.
    bus.append("toggle")
    body = await (await client.get("/events", params={"cursor": "99"})).json()
    assert body == {"cursor": 1, "events": []}

    # Having resynced, the tab sees the next command immediately.
    bus.append("faster")
    body = await (await client.get("/events", params={"cursor": "1"})).json()
    assert [e["command"] for e in body["events"]] == ["faster"]


async def test_a_resync_does_not_replay_commands_from_the_old_session(client, bus):
    # Snapping the stale cursor back to 0 would re-fire whatever is still in
    # the log -- including 'open', which navigates the page.
    bus.append("open")
    bus.append("back")
    body = await (await client.get("/events", params={"cursor": "42"})).json()
    assert body["events"] == []
    assert body["cursor"] == 2


async def test_health_reports_the_current_cursor(client, bus):
    # A page that has just loaded must start from the present. Without this it
    # asks for everything since 0 and replays the whole session -- including
    # navigation commands.
    assert (await (await client.get("/health")).json())["cursor"] == 0
    bus.append("toggle")
    bus.append("next")
    assert (await (await client.get("/health")).json())["cursor"] == 2


async def test_a_fresh_client_starting_from_health_gets_no_backlog(client, bus):
    for command in ("open", "back", "prev", "prev", "faster"):
        bus.append(command)

    cursor = (await (await client.get("/health")).json())["cursor"]
    body = await (await client.get("/events", params={"cursor": str(cursor)})).json()
    assert body["events"] == []

    bus.append("toggle")
    body = await (await client.get("/events", params={"cursor": str(cursor)})).json()
    assert [e["command"] for e in body["events"]] == ["toggle"]


# --- POST /bindings -------------------------------------------------------


@pytest.fixture
def received():
    return []


@pytest.fixture
async def rebinding_client(aiohttp_client, bus, received):
    app = create_app(
        bus,
        Config.default().browser_settings(),
        poll_timeout=0.05,
        on_bindings=received.append,
    )
    return await aiohttp_client(app)


LAPTOP = {"bindings": {"toggle": "Space", "next": "ArrowDown", "open": None}}


async def test_bindings_from_the_userscript_are_applied(rebinding_client, received):
    resp = await rebinding_client.post("/bindings", json=LAPTOP)
    assert resp.status == 200
    assert await resp.json() == {"ok": True, "unsupported": []}
    assert len(received) == 1
    assert set(received[0]) == {"toggle", "next"}
    assert received[0]["toggle"].scan_code == 57


async def test_health_reports_the_keys_now_in_effect(rebinding_client):
    await rebinding_client.post("/bindings", json=LAPTOP)
    settings = (await (await rebinding_client.get("/health")).json())["settings"]
    assert settings["binding_codes"] == {"toggle": "Space", "next": "ArrowDown"}
    # The older field stays, for a userscript that predates binding_codes.
    assert settings["bindings"] == {"toggle": "Space", "next": "ArrowDown"}


async def test_a_key_the_hook_cannot_use_is_reported(rebinding_client, received):
    resp = await rebinding_client.post(
        "/bindings", json={"bindings": {"toggle": "Space", "open": "MediaStop"}}
    )
    assert (await resp.json())["unsupported"] == ["open"]
    assert set(received[0]) == {"toggle"}


@pytest.mark.parametrize(
    "origin",
    ["https://www.reddit.com", "http://evil.example", "null"],
)
async def test_a_web_page_cannot_set_the_keys(rebinding_client, received, origin):
    # A page can reach 127.0.0.1, but the browser names it in Origin and page
    # script cannot remove or forge that header.
    resp = await rebinding_client.post(
        "/bindings", json=LAPTOP, headers={"Origin": origin}
    )
    assert resp.status == 403
    assert received == []


@pytest.mark.parametrize(
    "origin",
    ["moz-extension://0a1b2c", "chrome-extension://abcdef", "safari-web-extension://x"],
)
async def test_a_userscript_manager_may(rebinding_client, received, origin):
    resp = await rebinding_client.post(
        "/bindings", json=LAPTOP, headers={"Origin": origin}
    )
    assert resp.status == 200
    assert len(received) == 1


async def test_a_rebound_host_name_is_refused(rebinding_client, received):
    # DNS rebinding: a hostile name resolving to 127.0.0.1 makes the request
    # same-origin for the page, but Host still carries that name.
    resp = await rebinding_client.post(
        "/bindings", json=LAPTOP, headers={"Host": "evil.example:8765"}
    )
    assert resp.status == 403
    assert received == []


async def test_a_body_not_declared_as_json_is_refused(rebinding_client, received):
    # The content types a plain HTML form can send skip the CORS preflight.
    import json as jsonlib

    resp = await rebinding_client.post(
        "/bindings",
        data=jsonlib.dumps(LAPTOP),
        headers={"Content-Type": "text/plain"},
    )
    assert resp.status == 403
    assert received == []


@pytest.mark.parametrize(
    "body",
    ["not json", "[]", '{"bindings": []}', '{"bindings": {"nonsense": "Space"}}', "{}"],
)
async def test_a_malformed_request_is_a_400(rebinding_client, received, body):
    resp = await rebinding_client.post(
        "/bindings", data=body, headers={"Content-Type": "application/json"}
    )
    assert resp.status == 400
    assert (await resp.json())["ok"] is False
    assert received == []


async def test_without_a_listener_to_apply_them_it_says_so(client):
    resp = await client.post("/bindings", json=LAPTOP)
    assert resp.status == 503
