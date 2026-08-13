import asyncio

import pytest

from reddit_scroller.bus import EventBus


def test_empty_bus_has_a_zero_cursor():
    assert EventBus().cursor == 0


def test_sequence_numbers_start_at_one_and_increase():
    bus = EventBus()
    assert bus.append("toggle").seq == 1
    assert bus.append("faster").seq == 2
    assert bus.cursor == 2


def test_since_returns_exactly_the_unseen_tail():
    bus = EventBus()
    bus.append("toggle")
    bus.append("faster")
    bus.append("next")
    assert [e.command for e in bus.since(0)] == ["toggle", "faster", "next"]
    assert [e.command for e in bus.since(2)] == ["next"]
    assert bus.since(3) == []


def test_two_cursors_advance_independently():
    bus = EventBus()
    bus.append("toggle")
    slow, fast = 0, bus.cursor
    bus.append("next")
    assert len(bus.since(slow)) == 2
    assert len(bus.since(fast)) == 1


def test_the_log_is_bounded():
    bus = EventBus(max_events=3)
    for _ in range(10):
        bus.append("toggle")
    assert len(bus.since(0)) == 3
    assert bus.cursor == 10


def test_event_serialises_for_the_wire():
    assert EventBus().append("open").as_dict() == {"seq": 1, "command": "open"}


async def test_wait_for_returns_immediately_when_events_are_pending():
    bus = EventBus()
    bus.append("toggle")
    events = await asyncio.wait_for(bus.wait_for(0, timeout=5.0), timeout=1.0)
    assert [e.command for e in events] == ["toggle"]


async def test_wait_for_wakes_on_a_later_append():
    bus = EventBus()

    async def append_soon():
        await asyncio.sleep(0.01)
        bus.append("faster")

    asyncio.create_task(append_soon())
    events = await asyncio.wait_for(bus.wait_for(0, timeout=5.0), timeout=1.0)
    assert [e.command for e in events] == ["faster"]


async def test_wait_for_returns_empty_on_timeout():
    bus = EventBus()
    assert await bus.wait_for(0, timeout=0.01) == []


async def test_every_waiter_wakes_on_one_append():
    bus = EventBus()
    waiters = [asyncio.create_task(bus.wait_for(0, timeout=5.0)) for _ in range(3)]
    await asyncio.sleep(0.01)
    bus.append("back")
    results = await asyncio.wait_for(asyncio.gather(*waiters), timeout=1.0)
    assert all([e.command for e in r] == ["back"] for r in results)


async def test_append_threadsafe_reaches_a_waiter_from_another_thread():
    bus = EventBus()
    bus.bind_loop(asyncio.get_running_loop())
    waiter = asyncio.create_task(bus.wait_for(0, timeout=5.0))
    await asyncio.sleep(0.01)
    await asyncio.to_thread(bus.append_threadsafe, "slower")
    events = await asyncio.wait_for(waiter, timeout=1.0)
    assert [e.command for e in events] == ["slower"]


def test_append_threadsafe_without_a_loop_is_an_error():
    with pytest.raises(RuntimeError, match="loop"):
        EventBus().append_threadsafe("toggle")


def test_state_round_trips_and_defaults_to_empty():
    bus = EventBus()
    assert bus.get_state() == {}
    bus.set_state({"running": True, "speed": 90})
    assert bus.get_state() == {"running": True, "speed": 90}
