$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
if ($request.action -notin @('select', 'cancel', 'inspect') -or $request.operation -notin @('import', 'export') -or $request.pid -lt 1) { throw 'Invalid native file dialog request' }
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AnubisBrowserFileDialog {
    public delegate bool Callback(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, Callback callback, IntPtr data);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr param, string text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, int message, IntPtr wparam, IntPtr lparam);
    static bool OwnedBy(IntPtr hwnd, int browserPid) {
        for (int i = 0; i < 8 && hwnd != IntPtr.Zero; i++) {
            uint pid;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid == browserPid) return true;
            hwnd = GetWindow(hwnd, 4);
        }
        return false;
    }
    static string ClassName(IntPtr hwnd) {
        var value = new StringBuilder(128);
        GetClassName(hwnd, value, 128);
        return value.ToString();
    }
    public static bool Run(int browserPid, string file, string action, string operation) {
        var dialogs = new List<IntPtr>();
        Callback collect = (hwnd, data) => {
            if (ClassName(hwnd) == "#32770" && IsWindowVisible(hwnd) && OwnedBy(hwnd, browserPid) && !dialogs.Contains(hwnd)) dialogs.Add(hwnd);
            return true;
        };
        EnumWindows((hwnd, data) => {
            collect(hwnd, data);
            if (OwnedBy(hwnd, browserPid)) EnumChildWindows(hwnd, collect, IntPtr.Zero);
            return true;
        }, IntPtr.Zero);
        var candidates = new List<Tuple<IntPtr, IntPtr, IntPtr, IntPtr>>();
        foreach (var dialog in dialogs) {
            var title = new StringBuilder(256);
            GetWindowText(dialog, title, 256);
            bool expectedTitle = operation == "import"
                ? (title.ToString() == "Import Passwords To Chrome" || title.ToString() == "Import Passwords To Microsoft Edge")
                : (title.ToString() == "Export Passwords From Chrome" || title.ToString() == "Export Passwords From Microsoft Edge");
            if (!expectedTitle) continue;
            var edits = new List<IntPtr>();
            IntPtr accept = IntPtr.Zero;
            IntPtr cancel = IntPtr.Zero;
            EnumChildWindows(dialog, (hwnd, data) => {
                var name = ClassName(hwnd);
                var id = GetDlgCtrlID(hwnd);
                if (name == "Edit" && (id == 1148 || id == 1001)) edits.Add(hwnd);
                if (name == "Button" && id == 1) accept = hwnd;
                if (name == "Button" && id == 2) cancel = hwnd;
                return true;
            }, IntPtr.Zero);
            if (edits.Count > 1) throw new Exception("Ambiguous native filename controls");
            if (edits.Count == 1 && accept != IntPtr.Zero && cancel != IntPtr.Zero) candidates.Add(Tuple.Create(dialog, edits[0], accept, cancel));
        }
        if (candidates.Count == 0) return false;
        if (candidates.Count != 1) throw new Exception("Ambiguous native file dialogs");
        if (action == "inspect") return true;
        var selected = candidates[0];
        if (action == "select") {
            IntPtr result;
            if (SendMessageTimeout(selected.Item2, 12, IntPtr.Zero, file, 2, 2000, out result) == IntPtr.Zero || result == IntPtr.Zero)
                throw new Exception("Native filename entry failed");
            if (!PostMessage(GetParent(selected.Item2), 273, new IntPtr(GetDlgCtrlID(selected.Item2) | (0x300 << 16)), selected.Item2))
                throw new Exception("Native filename notification failed");
        }
        if (!PostMessage(action == "cancel" ? selected.Item4 : selected.Item3, 245, IntPtr.Zero, IntPtr.Zero)) throw new Exception("Native dialog action failed");
        return true;
    }
}
'@
if ($request.action -eq 'select') {
    if (-not [IO.Path]::IsPathRooted($request.path) -or [IO.Path]::GetFileName($request.path) -ne 'passwords.csv') { throw 'Invalid native transfer file' }
    $parent = Split-Path -Parent $request.path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Native transfer directory does not exist' }
    if ($request.operation -eq 'import' -and -not (Test-Path -LiteralPath $request.path -PathType Leaf)) { throw 'Native import file does not exist' }
    if ($request.operation -eq 'export' -and (Test-Path -LiteralPath $request.path)) { throw 'Native export file already exists' }
}
$acted = [AnubisBrowserFileDialog]::Run([int]$request.pid, [string]$request.path, [string]$request.action, [string]$request.operation)
@{ acted=$acted } | ConvertTo-Json -Compress
