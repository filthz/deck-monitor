#!/usr/bin/env python3
"""Add (or remove with --uninstall) the Taskmonitor hook to Claude Code and Qwen Code settings.

Existing hooks (e.g. Orca) are left untouched; a backup is written next to each settings file.
"""
import json
import os
import shutil
import sys
import time

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hook", "tm-hook.sh")
MARKER = "tm-hook.sh"

TOOL_EVENTS = {"PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"}
EVENTS = [
    "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd",
]

TARGETS = {
    "claude": os.path.expanduser("~/.claude/settings.json"),
    "qwen": os.path.expanduser("~/.qwen/settings.json"),
}


def strip_ours(hooks):
    for event in list(hooks):
        groups = []
        for group in hooks[event]:
            group = dict(group)
            group["hooks"] = [h for h in group.get("hooks", []) if MARKER not in h.get("command", "")]
            if group["hooks"]:
                groups.append(group)
        if groups:
            hooks[event] = groups
        else:
            del hooks[event]


def process(source, path, uninstall):
    if not os.path.exists(path):
        print(f"- {source}: {path} nicht gefunden, übersprungen")
        return
    with open(path) as f:
        settings = json.load(f)

    hooks = settings.setdefault("hooks", {})
    strip_ours(hooks)
    if not uninstall:
        command = f"'{HOOK}' {source}"
        for event in EVENTS:
            group = {"hooks": [{"type": "command", "command": command, "timeout": 5}]}
            if event in TOOL_EVENTS:
                group = {"matcher": "*", **group}
            hooks.setdefault(event, []).append(group)
    if not hooks:
        del settings["hooks"]

    backup = f"{path}.tm-backup-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copy2(path, backup)
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"- {source}: {'entfernt' if uninstall else 'installiert'} ({path}, Backup: {backup})")


def main():
    uninstall = "--uninstall" in sys.argv
    for source, path in TARGETS.items():
        process(source, path, uninstall)


if __name__ == "__main__":
    main()
