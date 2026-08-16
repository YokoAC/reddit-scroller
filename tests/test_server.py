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


async def test_events_returns_as_soon_as_a_command_arrives(client, bus):
    app = client.app
    app["poll_timeout"] = 5.0

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
