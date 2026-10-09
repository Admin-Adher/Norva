using System.Text.Json;

namespace Norva.NativePlayer;
internal static class PlayerStrings
{
    static readonly Dictionary<string,Dictionary<string,string>> Labels = JsonSerializer.Deserialize<Dictionary<string,Dictionary<string,string>>>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"norva-labels.json")))!;
    internal static string Language = "en";
    internal static string Get(string key) {
        var values = Labels[key];
        return values.GetValueOrDefault(Language) ?? values.GetValueOrDefault(Language.Split('-')[0]) ?? values["en"];
    }
}
