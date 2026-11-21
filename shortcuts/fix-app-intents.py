"""Unwraps the AppIntentDescriptor that Cherri writes for the TimeTracker app's
actions (tt-actions.cherri). Cherri turns every nested dictionary into a
Shortcuts dictionary value; Shortcuts wants the descriptor as a plain one.

    python3 fix-app-intents.py IN.shortcut OUT.plist   (OUT is XML)
"""
import plistlib
import sys


def plain(value):
    """A WFDictionaryFieldValue of plain strings -> a plain dict."""
    if not (isinstance(value, dict) and value.get("WFSerializationType") == "WFDictionaryFieldValue"):
        return value
    out = {}
    for item in value["Value"]["WFDictionaryFieldValueItems"]:
        key, val = item["WFKey"], item["WFValue"]
        key = key["Value"]["string"] if isinstance(key, dict) else key
        val = val["Value"]["string"] if isinstance(val, dict) else val
        out[key] = val
    return out


with open(sys.argv[1], "rb") as f:
    shortcut = plistlib.load(f)
fixed = 0
for action in shortcut["WFWorkflowActions"]:
    params = action.get("WFWorkflowActionParameters", {})
    if "AppIntentDescriptor" in params:
        params["AppIntentDescriptor"] = plain(params["AppIntentDescriptor"])
        fixed += 1
with open(sys.argv[2], "wb") as f:
    plistlib.dump(shortcut, f, fmt=plistlib.FMT_XML)
print(f"{sys.argv[1]}: {fixed} app actions fixed")
