#Requires AutoHotkey v2.0
#SingleInstance Force
; ActivityWatch's tray icon, with "Open Dashboard" going to the TimeTracker
; dashboard on the relay instead of localhost:5600. aw-tray.ps1 installs it.
;
; aw-qt hardcodes its dashboard URL (http://localhost:<port>, nothing in
; aw-qt.toml changes it), so this replaces only its tray: aw-qt still starts
; the server and watchers, but runs with --no-gui so its own icon is hidden.
; --no-gui also drops aw-qt's restarts of crashed watchers, so Watch() below
; restarts aw-qt when one of them is gone.

ini := A_ScriptDir "\aw-tray.ini"
Dashboard := IniRead(ini, "tray", "dashboard", "")
AwDir := IniRead(ini, "tray", "awdir", EnvGet("LOCALAPPDATA") "\Programs\ActivityWatch")
Modules := StrSplit(IniRead(ini, "tray", "modules", "aw-server,aw-watcher-afk,aw-watcher-window"), ",")
AwQt := AwDir "\aw-qt.exe"
LocalUi := "http://localhost:5600/"

Misses := 0
LastRestart := 0

A_IconTip := "ActivityWatch"
try TraySetIcon(AwQt)
tray := A_TrayMenu
tray.Delete()
tray.Add("Open Dashboard", (*) => Run(Dashboard != "" ? Dashboard : LocalUi))
tray.Add("Open ActivityWatch (local)", (*) => Run(LocalUi))
tray.Add()
tray.Add("Restart ActivityWatch", (*) => RestartAw())
tray.Add("Quit ActivityWatch", (*) => ExitApp())
tray.Default := "Open Dashboard"
tray.ClickCount := 2

OnExit((*) => StopAw())
StartAw()
SetTimer(Watch, 30000)

StartAw() {
    ; One aw-qt at a time: it holds a lock and a second copy exits anyway.
    if !ProcessExist("aw-qt.exe")
        Run('"' AwQt '" --no-gui', AwDir, "Hide")
}

StopAw() {
    ; /T takes the server and watchers down with aw-qt.
    RunWait('taskkill /IM aw-qt.exe /T /F', , "Hide")
}

RestartAw() {
    global Misses, LastRestart
    StopAw()
    Sleep(1000)
    StartAw()
    Misses := 0
    LastRestart := A_TickCount
}

Watch() {
    global Misses
    if !ProcessExist("aw-qt.exe") {
        StartAw()
        return
    }
    for name in Modules {
        if !ProcessExist(Trim(name) ".exe") {
            ; Two misses in a row, so a watcher that's still starting isn't
            ; counted, and at most one restart every 5 minutes, so one that
            ; crashes on start doesn't loop.
            Misses += 1
            if (Misses >= 2 && A_TickCount - LastRestart > 300000)
                RestartAw()
            return
        }
    }
    Misses := 0
}
