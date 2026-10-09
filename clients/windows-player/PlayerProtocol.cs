using System.Text.Json;
using LibVLCSharp.Shared;
using LibVLCSharp.Shared.Structures;

namespace Norva.NativePlayer;

internal sealed partial class PlayerWindow
{
    record TrackChoice(int Id, string Label) { public override string ToString() => Label; }
    internal void Receive(JsonElement message)
    {
        try {
            var type = message.GetProperty("type").GetString();
            if (type == "fullscreen" && host != null) { fullScreen = message.GetProperty("enabled").GetBoolean(); return; }
            if (type == "stop") { CloseWithReason("parent_stop"); return; }
            if (type == "authorize" && opened && message.GetProperty("sessionId").GetString() == session) {
                authorization.Restart(); return;
            }
            if (type != "open" || opened || message.GetProperty("protocol").GetInt32() != 1) return;
            var raw = message.GetProperty("url").GetString() ?? "";
            if (raw.Length > 8192 || raw.Any(char.IsControl) || !Uri.TryCreate(raw, UriKind.Absolute, out var uri)
                || uri.Scheme is not ("http" or "https") || uri.Fragment.Length != 0) throw new InvalidDataException();
            session = message.GetProperty("sessionId").GetString() ?? "";
            if (!Guid.TryParseExact(session, "D", out _)) throw new InvalidDataException();
            var seconds = message.GetProperty("resumeSeconds").GetDouble();
            if (!double.IsFinite(seconds) || seconds < 0 || seconds > 86400) throw new InvalidDataException();
            initialSeek = (long)(seconds * 1000);
            PlayerStrings.Language = message.TryGetProperty("uiLanguage",out var locale) ? locale.GetString() ?? "en" : "en";
            back.Text=back.AccessibleName=PlayerStrings.Get("back");
            fullscreen.Text=fullscreen.AccessibleName=PlayerStrings.Get("fullscreen");
            LabelControl(back,"back");LabelControl(fullscreen,"fullscreen");LabelControl(audioButton,"audio");LabelControl(subtitleButton,"subtitles");
            LabelControl(leftActions[0],"restart");LabelControl(leftActions[1],"backward");LabelControl(leftActions[3],"forward");LabelControl(rightActions[0],"mute");LabelControl(rightActions[3],"speed");
            audio.AccessibleName=PlayerStrings.Get("audio");subtitles.AccessibleName=PlayerStrings.Get("subtitles");
            timeline.AccessibleName=PlayerStrings.Get("position");volume.AccessibleName=volumeLabel.Text=PlayerStrings.Get("volume");
            status.Text=PlayerStrings.Get("preparing");
            if(message.TryGetProperty("playbackPreferences",out var selected)) preferences=selected.Clone();
            if(message.TryGetProperty("volume",out var sound) && sound.TryGetInt32(out var level)) volume.Value=Math.Clamp(level,0,100);
            Text = "Norva — " + (message.GetProperty("title").GetString() ?? "Vidéo")[..Math.Min(240, (message.GetProperty("title").GetString() ?? "Vidéo").Length)];
            titleLabel.Text=Text[8..];
            media = new Media(engine, uri);
            media.AddOption(":network-caching=1500");
            // No parse/network probe, fallback URL, transcoder or second player.
            opened = true; authorization.Restart();
            if (!player.Play(media)) throw new InvalidOperationException();
        } catch { CloseWithReason("invalid_request"); }
    }

    void Tick()
    {
        if (closing) return;
        host?.Fit(this);
        if (closing) return;
        // Authorizations originate in successful exact-session cloud heartbeats.
        if (authorization.ElapsedMilliseconds > 20_000) { CloseWithReason("authorization_expired"); return; }
        if (!opened || failed) return;
        var position = Math.Max(0, player.Time); var length = Math.Max(0, player.Length);
        lastPosition = position; lastDuration = length;
        if (!dragging && length > 0) timeline.Value = (int)Math.Clamp(position * 10_000d / length, 0, 10_000);
        timeline.Enabled = player.IsSeekable;
        pause.Text = pause.AccessibleName = PlayerStrings.Get(player.IsPlaying ? "pause" : "play");
        status.Text = PlayerStrings.Get("preparing");
        ApplyPreference("audio", TrackType.Audio, ref audioPreferenceApplied);
        ApplyPreference("subtitle", TrackType.Text, ref subtitlePreferenceApplied);
        RefreshTracks(audio, player.AudioTrackDescription, player.AudioTrack);
        RefreshTracks(subtitles, player.SpuDescription, player.Spu);
        UpdateControls(position,length);
        if (Environment.TickCount64 - lastProgress > 1000) { lastProgress = Environment.TickCount64; Emit("progress"); }
    }

    void RefreshTracks(ComboBox combo, TrackDescription[] tracks, int selected)
    {
        if (combo.DroppedDown || tracks.Length > 128) return;
        var values = tracks.Select(t => new TrackChoice(t.Id, t.Id == -1 ? PlayerStrings.Get("off") : t.Name)).ToArray();
        refreshingTracks = true;
        if (!combo.Items.Cast<TrackChoice>().SequenceEqual(values)) { combo.Items.Clear(); combo.Items.AddRange(values); }
        combo.SelectedIndex = Array.FindIndex(values, t => t.Id == selected);
        combo.Enabled = values.Length > 0; refreshingTracks = false;
    }
}
