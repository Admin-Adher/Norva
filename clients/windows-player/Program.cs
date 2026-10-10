using System.Text;
using System.Text.Json;

namespace Norva.NativePlayer;

internal static class Program
{
    static readonly object OutputLock = new();
    internal static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true };

    [STAThread]
    static void Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = new UTF8Encoding(false);
        ApplicationConfiguration.Initialize();
        NativeHost? host;
        try { host = NativeHost.FromArguments(args); } catch { return; }
        using var hostLifetime = host;
        using var window = new PlayerWindow(host);
        window.Shown += (_, _) => _ = Task.Run(async () => {
            try {
                while (await ReadBoundedLine() is { } line) {
                    using var message = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 8 });
                    var copy = message.RootElement.Clone();
                    window.BeginInvoke(() => window.Receive(copy));
                }
            } catch { /* Never print incoming URLs or native decoder diagnostics. */ }
            try { window.BeginInvoke(() => window.CloseWithReason("parent_closed")); } catch { }
        });
        Application.Run(window);
    }

    static async Task<string?> ReadBoundedLine()
    {
        var text = new StringBuilder();
        var character = new char[1];
        while (await Console.In.ReadAsync(character, 0, 1) != 0) {
            if (character[0] == '\n') return text.ToString();
            if (character[0] != '\r') text.Append(character[0]);
            if (text.Length > 32_768) throw new InvalidDataException();
        }
        return null;
    }

    internal static void Emit(object value)
    {
        lock (OutputLock) {
            Console.Out.WriteLine(JsonSerializer.Serialize(value));
            Console.Out.Flush();
        }
    }
}
