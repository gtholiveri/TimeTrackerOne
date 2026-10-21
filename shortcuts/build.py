#!/usr/bin/env python3
"""Build the test shortcuts as .shortcut files, so nobody has to assemble them
in the Shortcuts editor (stdlib only).

    python3 shortcuts/build.py            # write unsigned files to shortcuts/build/
    python3 shortcuts/build.py --sign     # also sign them into shortcuts/dist/

The action and parameter names match what the Shortcuts app itself writes (taken
from a shortcut built on the phone and shared through iCloud). Signing uses
RoutineHub's HubSign service, the same one the Cherri compiler uses; iOS only
imports signed shortcuts.

Each shortcut appends lines like
    tt|src=ios|kind=poll|run=482913|ts=2026-10-21 14:03:11.123-07:00|tick=3|bright=0.42
to a file in On My iPhone > UniversalTimeTracker. Key=value lines instead of
JSON keep the text plain; test-harness/analyze.py reads both.
"""

from __future__ import annotations

import argparse
import json
import os
import plistlib
import sys
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
HUBSIGN_URL = "https://hubsign.routinehub.services/sign"
TS_FORMAT = "yyyy-MM-dd HH:mm:ss.SSSXXX"

# "On My iPhone > UniversalTimeTracker", as referenced by the TT Poll shortcut
# built on the phone. The reference is specific to that iPhone.
PHONE_FOLDER = {
    "fileLocation": {
        "WFFileLocationType": "LocalStorage",
        "fileProviderDomainID": "com.apple.FileProvider.LocalStorage",
        "crossDeviceItemID": "deviceSpecific:036D40A6-6693-4A90-A1E7-4B431FF9AD2E:fp:/GTuN0odH_G8d0EBEDn7UNsPgiw8gRsY_pjHtLmnRo6c=/com.apple.FileProvider.LocalStorage//fid=34788078",
        "relativeSubpath": "UniversalTimeTracker",
    },
    "filename": "UniversalTimeTracker",
    "displayName": "UniversalTimeTracker",
}


# ---------------------------------------------------------------- values

def output(ref: tuple[str, str]) -> dict:
    """An action's output, as an attachment."""
    action_uuid, name = ref
    return {"OutputUUID": action_uuid, "Type": "ActionOutput", "OutputName": name}


def variable(name: str) -> dict:
    return {"VariableName": name, "Type": "Variable"}


def attachment(value: dict) -> dict:
    return {"Value": value, "WFSerializationType": "WFTextTokenAttachment"}


def token_string(*parts) -> dict:
    """Text with variables in it. Parts are plain strings or attachments
    (from output() / variable()); each attachment takes one U+FFFC slot, and
    ranges are counted in UTF-16 units, like NSString."""
    text, ranges = "", {}
    for part in parts:
        if isinstance(part, str):
            text += part
        else:
            ranges[f"{{{len(text.encode('utf-16-le')) // 2}, 1}}"] = part
            text += "￼"
    return {
        "Value": {"string": text, "attachmentsByRange": ranges},
        "WFSerializationType": "WFTextTokenString",
    }


# ---------------------------------------------------------------- builder

class Shortcut:
    def __init__(self, name: str) -> None:
        self.name = name
        self.actions: list[dict] = []
        self.groups: list[str] = []

    def _add(self, ident: str, params: dict, output_name: str | None = None):
        params = dict(params)
        ref = None
        if output_name:
            params["UUID"] = str(uuid.uuid4()).upper()
            ref = (params["UUID"], output_name)
        self.actions.append({
            "WFWorkflowActionIdentifier": f"is.workflow.actions.{ident}",
            "WFWorkflowActionParameters": params,
        })
        return ref

    # Values
    def text(self, *parts):
        params = {"WFTextActionText": token_string(*parts)} if parts else {}
        return self._add("gettext", params, "Text")

    def timestamp(self):
        date = self._add("date", {"WFDateActionMode": "Current Date"}, "Date")
        return self._add("format.date", {
            "WFDateFormatStyle": "Custom",
            "WFDateFormat": TS_FORMAT,
            "WFDate": token_string(output(date)),
        }, "Formatted Date")

    def device_detail(self, detail: str):
        # Output names match the detail: "Device Is Locked", "Current Brightness".
        return self._add("getdevicedetails", {"WFDeviceDetail": detail}, detail)

    def current_app(self, scope: str = "Current"):
        name = "Current App" if scope == "Current" else "Visible Apps"
        return self._add("getcurrentapp", {"WFVisibleAppScope": scope}, name)

    def random_number(self, lo: int, hi: int):
        return self._add("number.random", {
            "WFRandomNumberMinimum": str(lo),
            "WFRandomNumberMaximum": str(hi),
        }, "Random Number")

    # Variables and files
    def set_var(self, name: str, ref) -> None:
        self._add("setvariable", {"WFInput": attachment(output(ref)), "WFVariableName": name})

    def add_to_var(self, name: str, ref) -> None:
        self._add("appendvariable", {"WFInput": attachment(output(ref)), "WFVariableName": name})

    def append_line(self, filename: str, *parts) -> None:
        self._add("file.append", {
            "WFFile": PHONE_FOLDER,
            "WFFilePath": filename,
            "WFInput": token_string(*parts),
            "WFAppendOnNewLine": True,
        }, "Appended File")

    def wait(self, seconds: float) -> None:
        self._add("delay", {"WFDelayTime": float(seconds)})

    # Control flow
    def repeat(self, count: int) -> None:
        group = str(uuid.uuid4()).upper()
        self.groups.append(group)
        self._add("repeat.count", {"WFRepeatCount": float(count), "GroupingIdentifier": group, "WFControlFlowMode": 0})

    def end_repeat(self) -> None:
        self._add("repeat.count", {"GroupingIdentifier": self.groups.pop(), "WFControlFlowMode": 2}, "Repeat Results")

    def if_text_is(self, ref, value: str) -> None:
        group = str(uuid.uuid4()).upper()
        self.groups.append(group)
        self._add("conditional", {
            "WFInput": {"Type": "Variable", "Variable": attachment(output(ref))},
            "WFCondition": 4,  # "is"
            "WFConditionalActionString": value,
            "GroupingIdentifier": group,
            "WFControlFlowMode": 0,
        })

    def otherwise(self) -> None:
        self._add("conditional", {"GroupingIdentifier": self.groups[-1], "WFControlFlowMode": 1})

    def end_if(self) -> None:
        self._add("conditional", {"GroupingIdentifier": self.groups.pop(), "WFControlFlowMode": 2}, "If Result")

    def plist(self) -> dict:
        assert not self.groups, f"{self.name}: unclosed repeat/if"
        return {
            "WFWorkflowMinimumClientVersionString": "1106",
            "WFWorkflowMinimumClientVersion": 1106,
            "WFWorkflowIcon": {"WFWorkflowIconStartColor": -615917313, "WFWorkflowIconGlyphNumber": 61440},
            "WFWorkflowClientVersion": "4711",
            "WFWorkflowHasOutputFallback": False,
            "WFWorkflowOutputContentItemClasses": [],
            "WFWorkflowInputContentItemClasses": ["WFStringContentItem"],
            "WFWorkflowImportQuestions": [],
            "WFWorkflowTypes": [],
            "WFQuickActionSurfaces": [],
            "WFWorkflowHasShortcutInputVariables": False,
            "WFWorkflowActions": self.actions,
        }


# ---------------------------------------------------------------- the shortcuts

def tt_brightness() -> Shortcut:
    """Does Current Brightness drop to 0 when the screen is off? No Is Locked
    here, so writing while locked should work (it did in T1)."""
    s = Shortcut("TT Brightness")
    run = s.random_number(100000, 999999)
    s.set_var("Run", run)
    s.repeat(120)  # about 4 minutes at a 2 s wait
    ts = s.timestamp()
    bright = s.device_detail("Current Brightness")
    cur = s.current_app()
    s.append_line("tt-bright.txt",
                  "tt|src=ios|kind=poll|ctx=brightness|run=", variable("Run"),
                  "|ts=", output(ts), "|tick=", variable("Repeat Index"),
                  "|cur=", output(cur), "|bright=", output(bright))
    s.wait(2)
    s.end_repeat()
    end = s.timestamp()
    s.append_line("tt-bright.txt", "tt|src=ios|kind=poll.end|ctx=brightness|run=", variable("Run"), "|ts=", output(end))
    return s


def tt_lock_buffer() -> Shortcut:
    """Is it Is Locked itself, or writing to a file while locked, that brings up
    the privacy banner and stops the loop? While locked, lines only go into a
    variable; once unlocked they're written out, then the current line."""
    s = Shortcut("TT Lock Buffer")
    s.set_var("Buffer", s.text())
    run = s.random_number(100000, 999999)
    s.set_var("Run", run)
    s.repeat(150)  # about 5 minutes at a 2 s wait
    ts = s.timestamp()
    locked = s.device_detail("Device Is Locked")
    bright = s.device_detail("Current Brightness")
    cur = s.current_app()
    line = s.text("tt|src=ios|kind=poll|ctx=lock-buffer|run=", variable("Run"),
                  "|ts=", output(ts), "|tick=", variable("Repeat Index"),
                  "|locked=", output(locked), "|cur=", output(cur), "|bright=", output(bright))
    locked_text = s.text(output(locked))
    s.if_text_is(locked_text, "Yes")
    s.add_to_var("Buffer", line)
    s.otherwise()
    s.append_line("tt-lockbuf.txt", variable("Buffer"))
    s.append_line("tt-lockbuf.txt", output(line))
    s.set_var("Buffer", s.text())
    s.end_if()
    s.wait(2)
    s.end_repeat()
    end = s.timestamp()
    s.append_line("tt-lockbuf.txt", variable("Buffer"))
    s.append_line("tt-lockbuf.txt", "tt|src=ios|kind=poll.end|ctx=lock-buffer|run=", variable("Run"), "|ts=", output(end))
    return s


SHORTCUTS = [tt_brightness, tt_lock_buffer]


# ---------------------------------------------------------------- output

def hubsign(name: str, plist_xml: bytes) -> bytes:
    payload = json.dumps({"shortcutName": name, "shortcut": plist_xml.decode("utf-8")}).encode()
    req = urllib.request.Request(HUBSIGN_URL, data=payload, method="POST", headers={
        "Content-Type": "application/json",
        "User-Agent": "TimeTrackerOne-shortcuts",
    })
    with urllib.request.urlopen(req, timeout=60) as res:
        body = res.read()
    if body[:4] != b"AEA1":
        raise RuntimeError(f"{name}: signing service returned something that isn't a signed shortcut: {body[:120]!r}")
    return body


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sign", action="store_true", help="sign with HubSign into shortcuts/dist/")
    args = ap.parse_args()

    build_dir, dist_dir = os.path.join(HERE, "build"), os.path.join(HERE, "dist")
    os.makedirs(build_dir, exist_ok=True)
    for make in SHORTCUTS:
        s = make()
        filename = s.name.replace(" ", "-") + ".shortcut"
        data = s.plist()
        with open(os.path.join(build_dir, filename), "wb") as f:
            plistlib.dump(data, f, fmt=plistlib.FMT_BINARY)
        print(f"built  {filename}: {len(s.actions)} actions")
        if args.sign:
            os.makedirs(dist_dir, exist_ok=True)
            signed = hubsign(s.name, plistlib.dumps(data, fmt=plistlib.FMT_XML))
            with open(os.path.join(dist_dir, filename), "wb") as f:
                f.write(signed)
            print(f"signed {filename}: {len(signed)} bytes")


if __name__ == "__main__":
    sys.exit(main())
