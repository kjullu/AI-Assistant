#!/usr/bin/env python3
"""Replay a deterministic tool-and-response stream on a running Pebble emulator."""

import argparse
import json
import queue
import re
import subprocess
import time
import uuid
from pathlib import Path

import png
from libpebble2.communication import PebbleConnection
from libpebble2.communication.transports.websocket import WebsocketTransport
from libpebble2.services.appmessage import AppMessageService, CString, Int32, Uint32
from libpebble2.services.screenshot import Screenshot


ROOT = Path(__file__).resolve().parents[1]


def discover_phone_endpoint():
    result = subprocess.run(
        ["pgrep", "-af", "python3 -m pypkjs"],
        check=False,
        capture_output=True,
        text=True,
    )
    ports = sorted(set(re.findall(r"--port\s+(\d+)", result.stdout)))
    if len(ports) == 1:
        return "localhost:" + ports[0]
    if not ports:
        raise RuntimeError("No running pypkjs process found; pass --phone host:port")
    raise RuntimeError("Multiple pypkjs ports found ({}); pass --phone host:port".format(", ".join(ports)))


def load_project():
    with (ROOT / "package.json").open(encoding="utf-8") as handle:
        package = json.load(handle)
    with (ROOT / "build/js/message_keys.json").open(encoding="utf-8") as handle:
        keys = json.load(handle)
    required = {
        "ReplayPrompt",
        "ToolActivity",
        "Status",
        "AssistantResponse",
        "ResponseChunkIndex",
        "ResponseChunkDone",
    }
    missing = required.difference(keys)
    if missing:
        raise RuntimeError("Build is missing replay keys; run `pebble clean && pebble build`")
    return uuid.UUID(package["pebble"]["uuid"]), keys


def save_screenshot(pebble, path):
    raw_image = Screenshot(pebble).grab_image()
    png.from_array(raw_image, mode="RGB;8").save(str(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phone", help="pypkjs WebSocket as host:port; auto-detected when unique")
    parser.add_argument("--delay", type=float, default=0.15, help="seconds between acknowledged events")
    parser.add_argument(
        "--capture-dir",
        type=Path,
        default=ROOT / "build/watch-replay",
        help="directory for a screenshot after every event",
    )
    parser.add_argument("--no-captures", action="store_true", help="send the sequence rapidly without screenshots")
    args = parser.parse_args()

    phone = args.phone or discover_phone_endpoint()
    app_uuid, keys = load_project()
    tools = ["Getting weather for Copenhagen", "Calculating 12 times 7"]
    tool_history = "".join("[tool] " + tool + "\n" for tool in tools)
    sequence = [
        (
            "01-thinking",
            {keys["ReplayPrompt"]: CString("Find the weather and calculate 12 times 7")},
        ),
        ("02-tool-one", {keys["ToolActivity"]: CString(tools[0])}),
        ("03-tool-two", {keys["ToolActivity"]: CString(tools[1])}),
        (
            "04-first-chunk",
            {
                keys["Status"]: CString("Receiving..."),
                keys["AssistantResponse"]: CString(tool_history + "It is currently "),
                keys["ResponseChunkIndex"]: Int32(0),
                keys["ResponseChunkDone"]: Uint32(0),
            },
        ),
        (
            "05-streaming",
            {
                keys["Status"]: CString("Receiving..."),
                keys["AssistantResponse"]: CString("12 C and the calculation gives "),
                keys["ResponseChunkIndex"]: Int32(1),
                keys["ResponseChunkDone"]: Uint32(0),
            },
        ),
        (
            "06-done",
            {
                keys["Status"]: CString("Done"),
                keys["AssistantResponse"]: CString("84."),
                keys["ResponseChunkIndex"]: Int32(2),
                keys["ResponseChunkDone"]: Uint32(1),
            },
        ),
    ]

    if not args.no_captures:
        args.capture_dir.mkdir(parents=True, exist_ok=True)

    pebble = PebbleConnection(WebsocketTransport("ws://{}/".format(phone)))
    pebble.connect()
    pebble.run_async()
    app_messages = AppMessageService(pebble)
    outcomes = queue.Queue()
    ack_handle = app_messages.register_handler("ack", lambda transaction_id, _uuid: outcomes.put(("ack", transaction_id)))
    nack_handle = app_messages.register_handler("nack", lambda transaction_id, _uuid: outcomes.put(("nack", transaction_id)))

    try:
        for name, message in sequence:
            accepted = False
            last_outcome = "timeout"
            for attempt in range(3):
                last_outcome = "timeout"
                transaction_id = app_messages.send_message(app_uuid, message)
                deadline = time.monotonic() + 5
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    try:
                        outcome, received_id = outcomes.get(timeout=remaining)
                    except queue.Empty:
                        break
                    if received_id != transaction_id:
                        continue
                    last_outcome = outcome
                    accepted = outcome == "ack"
                    break
                if accepted:
                    break
                if attempt < 2:
                    time.sleep(0.5)
            if not accepted:
                raise RuntimeError("Watch {} {} after 3 attempts".format(last_outcome, name))
            if not args.no_captures:
                time.sleep(args.delay)
            if not args.no_captures:
                save_screenshot(pebble, args.capture_dir / (name + ".png"))
            print(name)
    finally:
        app_messages.unregister_handler(ack_handle)
        app_messages.unregister_handler(nack_handle)
        app_messages.shutdown()
        websocket = getattr(pebble.transport, "ws", None)
        if websocket is not None:
            websocket.close()


if __name__ == "__main__":
    main()
