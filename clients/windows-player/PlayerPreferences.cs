using System.Text.Json;
using LibVLCSharp.Shared;

namespace Norva.NativePlayer;

internal sealed partial class PlayerWindow
{
    JsonElement preferences;
    bool audioPreferenceApplied, subtitlePreferenceApplied;
    string Language(MediaTrack track) {
        var language = (track.Language ?? "").ToLowerInvariant();
        return System.Text.RegularExpressions.Regex.IsMatch(language, @"^[a-z]{2,3}$")
            && language is not ("und" or "unk" or "mul") ? language : "";
    }
    string StableId(MediaTrack track) => $"vlc-v1:{track.Id}:{track.Codec}:{Language(track)}";
    void ApplyPreference(string kind, TrackType type, ref bool applied)
    {
        if (applied || media == null || preferences.ValueKind != JsonValueKind.Object
            || player.State is not (VLCState.Playing or VLCState.Paused)) return;
        if (!preferences.TryGetProperty(kind, out var preference)) { applied = true; return; }
        var tracks = media.Tracks.Where(t => t.TrackType == type).ToArray();
        if (tracks.Length == 0) return;
        if (kind == "subtitle" && preference.TryGetProperty("disabled", out var off) && off.ValueKind == JsonValueKind.True) {
            applied = player.SetSpu(-1); return;
        }
        var stable = preference.TryGetProperty("stableId", out var id) ? id.GetString() : null;
        var language = preference.TryGetProperty("language", out var lang) ? lang.GetString() : null;
        var matches = tracks.Where(t => StableId(t) == stable).ToArray();
        if (matches.Length != 1 && !string.IsNullOrEmpty(language)) matches = tracks.Where(t => Language(t) == language).ToArray();
        // Ambiguous/missing preferences preserve the file's default track.
        if (matches.Length == 1) {
            applied = type == TrackType.Audio ? player.SetAudioTrack(matches[0].Id) : player.SetSpu(matches[0].Id);
            return;
        }
        applied = true;
    }
    void EmitPreference(string kind, int selected)
    {
        if (media == null || refreshingTracks) return;
        var chosen = new Dictionary<string,object>();
        foreach(var selection in new[] { (Kind:"audio",Type:TrackType.Audio,Id:kind=="audio"?selected:player.AudioTrack),
            (Kind:"subtitle",Type:TrackType.Text,Id:kind=="subtitle"?selected:player.Spu) }) {
            if(selection.Kind=="subtitle" && selection.Id==-1) { chosen[selection.Kind]=new { disabled=true };continue; }
            var tracks=media.Tracks.Where(t=>t.TrackType==selection.Type && t.Id==selection.Id).ToArray();
            if(tracks.Length==1)chosen[selection.Kind]=new {stableId=StableId(tracks[0]),language=Language(tracks[0])};
        }
        Program.Emit(new {type="preferences",sessionId=session,preferences=chosen});
    }
}
