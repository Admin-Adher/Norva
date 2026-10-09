using System.Globalization;
using System.Runtime.InteropServices;

namespace Norva.NativePlayer;

// A real child HWND fills the catalogue window's client area. No second
// top-level video window, URL in argv, or renderer-selected embedding target.
internal sealed class NativeHost : IDisposable
{
    internal readonly nint Handle;
    readonly uint processId;
    readonly NativeWindow surface = new();
    int width = -1, height = -1;
    NativeHost(nint handle, uint pid) { Handle = handle; processId = pid; }
    internal static NativeHost? FromArguments(string[] args)
    {
        if (args.Length == 0) return null; // isolated decoder fixtures
        if (args.Length != 4 || args[0] != "--parent-window" || args[2] != "--parent-process"
            || !long.TryParse(args[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var handle) || handle <= 0
            || !uint.TryParse(args[3], out var pid) || pid == 0) throw new InvalidDataException();
        var host = new NativeHost((nint)handle, pid);
        if (!host.IsAlive()) throw new InvalidDataException();
        if (SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(host.Handle)) == 0) throw new InvalidDataException();
        return host;
    }
    internal bool IsAlive() => IsWindow(Handle) && GetWindowThreadProcessId(Handle, out var pid) != 0 && pid == processId;
    internal void Attach(Form child)
    {
        if (!IsAlive()) throw new InvalidDataException();
        if (!GetClientRect(Handle, out var initial)) throw new InvalidDataException();
        // Chromium's composition-only root does not redirect GDI controls.
        // An opaque layered child gives this native subtree its own surface,
        // preserving Chromium acceleration and LibVLC's Direct3D11 output.
        surface.CreateHandle(new CreateParams { Parent=Handle, Style=0x56000000, ExStyle=0x00080000, X=0, Y=0, Width=initial.Right, Height=initial.Bottom });
        if (!SetLayeredWindowAttributes(surface.Handle, 0, 255, 2)) throw new InvalidDataException();
        var style = GetWindowLong(child.Handle, -16);
        SetWindowLong(child.Handle, -16, (style & ~unchecked((int)0x80CF0000)) | 0x46000000);
        SetParent(child.Handle, surface.Handle);
        if (GetParent(child.Handle) != surface.Handle) throw new InvalidDataException();
        SetWindowLong(Handle, -16, GetWindowLong(Handle, -16) | 0x02000000); // parent clips real native children
        SetWindowPos(child.Handle, 0, 0, 0, 0, 0, 0x0073);
        Fit(child);
        child.Invalidate(true); child.Update();
    }
    internal void Fit(Form child)
    {
        if (!IsAlive() || !GetClientRect(Handle, out var rect)) { child.Close(); return; }
        if (rect.Right == width && rect.Bottom == height) return;
        width = rect.Right; height = rect.Bottom;
        // GetClientRect gives device pixels in the same per-monitor DPI context.
        MoveWindow(surface.Handle, 0, 0, rect.Right, rect.Bottom, true);
        SetWindowPos(surface.Handle, 0, 0, 0, 0, 0, 0x0013);
        MoveWindow(child.Handle, 0, 0, rect.Right, rect.Bottom, true);
        SetWindowPos(child.Handle, 0, 0, 0, 0, 0, 0x0013); // top, no move/size/activate
    }
    public void Dispose() { if (surface.Handle != 0) surface.DestroyHandle(); }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool IsWindow(nint hwnd);
    [DllImport("user32.dll")] static extern nint SetParent(nint child, nint parent);
    [DllImport("user32.dll")] static extern nint GetParent(nint child);
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(nint hwnd, int index);
    [DllImport("user32.dll", EntryPoint="SetWindowLongW")] static extern int SetWindowLong(nint hwnd, int index, int value);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(nint hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool GetClientRect(nint hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool MoveWindow(nint hwnd, int x, int y, int width, int height, bool repaint);
    [DllImport("user32.dll")] static extern bool SetWindowPos(nint hwnd, nint after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern nint GetWindowDpiAwarenessContext(nint hwnd);
    [DllImport("user32.dll")] static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(nint hwnd, uint key, byte alpha, uint flags);
}
