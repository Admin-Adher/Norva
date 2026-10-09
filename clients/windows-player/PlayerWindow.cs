using System.Diagnostics;
using System.Text.Json;
using LibVLCSharp.Shared;
using LibVLCSharp.WinForms;

namespace Norva.NativePlayer;

internal sealed partial class PlayerWindow : Form
{
    readonly LibVLC engine;
    readonly MediaPlayer player;
    readonly VideoView view;
    readonly Label status = new() { Dock = DockStyle.Fill, AutoSize = false, TextAlign = ContentAlignment.MiddleLeft };
    readonly TrackBar timeline = new() { Dock = DockStyle.Fill, Maximum = 10_000, TickStyle = TickStyle.None, AccessibleName = "Position de lecture" };
    readonly Button pause;
    readonly ComboBox audio = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 190, AccessibleName = "Piste audio" };
    readonly ComboBox subtitles = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 190, AccessibleName = "Sous-titres" };
    readonly System.Windows.Forms.Timer clock = new() { Interval = 500 };
    readonly Stopwatch authorization = Stopwatch.StartNew();
    string session = "", reason = "viewer_closed";
    bool opened, closing, dragging, refreshingTracks, failed, fullScreen;
    long lastProgress, initialSeek, lastPosition, lastDuration;
    Media? media;

    internal PlayerWindow()
    {
        Text = "Norva"; Width = 1120; Height = 760; MinimumSize = new Size(880, 580);
        StartPosition = FormStartPosition.CenterScreen; KeyPreview = true;
        BackColor = PlayerTheme.Color("color-bg-primary"); ForeColor = PlayerTheme.Color("color-text-primary");
        Font = new Font("Inter", 11); AutoScaleMode = AutoScaleMode.Dpi;
        engine = new LibVLC("--no-video-title-show", "--no-sub-autodetect-file", "--quiet");
        player = new MediaPlayer(engine) { EnableHardwareDecoding = true, EnableKeyInput = false, EnableMouseInput = false };
        view = new VideoView { Dock = DockStyle.Fill, MediaPlayer = player, BackColor = BackColor, TabStop = false };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4, Padding = new Padding(16) };
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 64));
        var heading = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 110));
        heading.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        heading.Controls.Add(PlayerTheme.Button("Retour", Close), 0, 0); heading.Controls.Add(status, 1, 0);
        layout.Controls.Add(heading, 0, 0); layout.Controls.Add(view, 0, 1); layout.Controls.Add(timeline, 0, 2);
        var controls = new FlowLayoutPanel { Dock = DockStyle.Fill, WrapContents = true };
        pause = PlayerTheme.Button("Pause", () => { if (opened && !failed) player.Pause(); });
        controls.Controls.Add(pause);
        controls.Controls.Add(PlayerTheme.Button("−10 s", () => Seek(player.Time - 10_000)));
        controls.Controls.Add(PlayerTheme.Button("+10 s", () => Seek(player.Time + 10_000)));
        controls.Controls.Add(audio); controls.Controls.Add(subtitles);
        controls.Controls.Add(PlayerTheme.Button("Plein écran", ToggleFullScreen));
        layout.Controls.Add(controls, 0, 3); Controls.Add(layout);
        status.Text = "Préparation de la lecture…";
        timeline.MouseDown += (_, _) => dragging = true;
        timeline.MouseUp += (_, _) => { dragging = false; Seek((long)(timeline.Value / 10_000d * player.Length)); };
        timeline.KeyUp += (_, e) => { if (e.KeyCode is Keys.Left or Keys.Right or Keys.Home or Keys.End) Seek((long)(timeline.Value / 10_000d * player.Length)); };
        audio.SelectedIndexChanged += (_, _) => { if (!refreshingTracks && audio.SelectedItem is TrackChoice t) player.SetAudioTrack(t.Id); };
        subtitles.SelectedIndexChanged += (_, _) => { if (!refreshingTracks && subtitles.SelectedItem is TrackChoice t) player.SetSpu(t.Id); };
        player.Playing += (_, _) => OnUi(() => {
            if (initialSeek > 0 && player.IsSeekable) { player.Time = initialSeek; initialSeek = 0; }
            Emit("playing");
        });
        player.EncounteredError += (_, _) => OnUi(FailPlayback);
        player.EndReached += (_, _) => OnUi(() => {
            // A truncated HTTP body can appear as EOF to a demuxer. Never mark
            // the movie watched when the last observed position is far from end.
            if (lastDuration > 0 && lastPosition >= lastDuration - 2000) CloseWithReason("ended");
            else FailPlayback();
        });
        KeyDown += (_, e) => {
            if (e.KeyCode == Keys.Escape) { if (fullScreen) ToggleFullScreen(); else Close(); }
            else if (e.KeyCode == Keys.F11) ToggleFullScreen();
            else if (e.KeyCode == Keys.Space && ActiveControl is not ComboBox) { player.Pause(); e.Handled = true; }
        };
        clock.Tick += (_, _) => Tick(); clock.Start();
        FormClosing += (_, _) => Shutdown();
        Shown += (_, _) => Program.Emit(new { type = "ready", protocol = 1 });
    }

    void OnUi(Action action) { if (!closing && IsHandleCreated) try { BeginInvoke(action); } catch { } }
    void FailPlayback() {
        if (failed || closing) return;
        failed = true; player.Stop();
        status.Text = "Cette version ne peut pas être lue. Revenez à la fiche pour choisir une autre version.";
        pause.Enabled = timeline.Enabled = audio.Enabled = subtitles.Enabled = false;
        Emit("failed");
    }
    void Seek(long milliseconds) { if (!closing && !failed && player.IsSeekable) player.Time = Math.Clamp(milliseconds, 0, Math.Max(0, player.Length - 500)); }
    void ToggleFullScreen() {
        fullScreen = !fullScreen; FormBorderStyle = fullScreen ? FormBorderStyle.None : FormBorderStyle.Sizable;
        WindowState = fullScreen ? FormWindowState.Maximized : FormWindowState.Normal;
    }
    internal void CloseWithReason(string value) { reason = value; Close(); }
    void Emit(string type) => Program.Emit(new { type, sessionId = session,
        positionSeconds = Math.Max(0, player.Time) / 1000d, durationSeconds = Math.Max(0, player.Length) / 1000d,
        playing = player.IsPlaying, savedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        decodedAudio = media?.Statistics.DecodedAudio ?? 0,
        decodedVideo = media?.Statistics.DecodedVideo ?? 0,
        displayedPictures = media?.Statistics.DisplayedPictures ?? 0,
        lostPictures = media?.Statistics.LostPictures ?? 0,
        audioTrack = player.AudioTrack, subtitleTrack = player.Spu });
    void Shutdown() {
        if (closing) return; closing = true; clock.Stop();
        Emit("progress"); player.Stop(); // Stop is synchronous in LibVLC 3; transport drains before closed.
        player.Dispose(); media?.Dispose(); engine.Dispose();
        Program.Emit(new { type = "closed", sessionId = session, reason });
    }
}
