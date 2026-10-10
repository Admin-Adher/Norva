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
    readonly NativeHost? host;
    readonly Label status = new() { Dock = DockStyle.Fill, AutoSize = false, TextAlign = ContentAlignment.MiddleLeft };
    readonly PlayerSlider timeline = new() { Maximum = 10_000, AccessibleName = "Position de lecture" };
    readonly PlayerIconButton pause;
    readonly PlayerIconButton back, fullscreen;
    readonly Label volumeLabel = new() { AutoSize=true };
    readonly PlayerSlider volume = new() { Minimum=0, Maximum=100, Value=100, Width=100 };
    readonly ComboBox audio = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 190, AccessibleName = "Piste audio" };
    readonly ComboBox subtitles = new() { DropDownStyle = ComboBoxStyle.DropDownList, Width = 190, AccessibleName = "Sous-titres" };
    readonly System.Windows.Forms.Timer clock = new() { Interval = 500 };
    readonly Stopwatch authorization = Stopwatch.StartNew();
    string session = "", reason = "viewer_closed";
    bool opened, closing, dragging, refreshingTracks, failed, fullScreen;
    long lastProgress, initialSeek, lastPosition, lastDuration;
    Media? media;

    internal PlayerWindow(NativeHost? host = null)
    {
        this.host = host;
        Text = "Norva"; Width = 1120; Height = 760; MinimumSize = new Size(880, 580);
        StartPosition = FormStartPosition.CenterScreen; KeyPreview = true;
        if (host != null) {
            ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None;
            MinimumSize = Size.Empty; StartPosition = FormStartPosition.Manual; Location = Point.Empty;
        }
        BackColor = PlayerTheme.Color("color-bg-primary"); ForeColor = PlayerTheme.Color("color-text-primary");
        Font = PlayerTheme.Font(11); AutoScaleMode = AutoScaleMode.Dpi;
        engine = new LibVLC("--no-video-title-show", "--no-sub-autodetect-file", "--quiet");
        player = new MediaPlayer(engine) { EnableHardwareDecoding = true, EnableKeyInput = false, EnableMouseInput = false };
        view = new VideoView { Dock = DockStyle.Fill, MediaPlayer = player, BackColor = BackColor, TabStop = false };
        back=new PlayerIconButton("back",Close,48,true);
        pause=new PlayerIconButton("pause",()=>{if(opened&&!failed)player.Pause();},64,true);
        fullscreen=new PlayerIconButton("fullscreen",ToggleFullScreen);
        BuildControls();
        volume.ValueChanged += (_,_) => { player.Volume=volume.Value;Program.Emit(new {type="volume",sessionId=session,value=volume.Value}); };
        status.Text = "Préparation de la lecture…";
        timeline.MouseDown += (_, _) => dragging = true;
        timeline.Committed += (_, _) => { dragging = false; Seek((long)(timeline.Value / 10_000d * player.Length)); };
        audio.SelectedIndexChanged += (_, _) => { if (!refreshingTracks && audio.SelectedItem is TrackChoice t) { player.SetAudioTrack(t.Id);audioPreferenceApplied=true;EmitPreference("audio",t.Id); } };
        subtitles.SelectedIndexChanged += (_, _) => { if (!refreshingTracks && subtitles.SelectedItem is TrackChoice t) { player.SetSpu(t.Id);subtitlePreferenceApplied=true;EmitPreference("subtitle",t.Id); } };
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
            ShowControls(); keyboardControls=true;
            if (e.KeyCode == Keys.Escape) { if (trackMenu.Visible) trackMenu.Close(); else if (fullScreen) ToggleFullScreen(); else Close(); e.SuppressKeyPress=true; }
            else if (e.KeyCode == Keys.F11) ToggleFullScreen();
            else if (e.KeyCode == Keys.Space && ActiveControl is not ComboBox) { if(opened&&!failed)player.Pause(); e.SuppressKeyPress = true; }
        };
        clock.Tick += (_, _) => Tick(); clock.Start();
        FormClosing += (_, _) => Shutdown();
        Shown += (_, _) => { try {host?.Attach(this);back.Focus();Program.Emit(new { type = "ready", protocol = 1 });} catch {CloseWithReason("embedding_failed");} };
    }

    protected override bool ProcessCmdKey(ref Message message, Keys keyData)
    {
        if ((keyData & Keys.KeyCode) == Keys.Tab) { ShowControls(); keyboardControls=true; }
        return base.ProcessCmdKey(ref message,keyData);
    }


    void OnUi(Action action) { if (!closing && IsHandleCreated) try { BeginInvoke(action); } catch { } }
    void FailPlayback() {
        if (failed || closing) return;
        failed = true; player.Stop();
        status.Text = PlayerStrings.Get("failure");
        ShowControls();status.Visible=true;
        pause.Enabled = timeline.Enabled = audio.Enabled = subtitles.Enabled = false;
        Emit("failed");
    }
    void Seek(long milliseconds) { if (!closing && !failed && player.IsSeekable) player.Time = Math.Clamp(milliseconds, 0, Math.Max(0, player.Length - 500)); }
    void ToggleFullScreen() {
        if (host != null) { Program.Emit(new { type="fullscreen", sessionId=session, enabled=!fullScreen }); return; }
        fullScreen = !fullScreen; FormBorderStyle = fullScreen ? FormBorderStyle.None : FormBorderStyle.Sizable;
        WindowState = fullScreen ? FormWindowState.Maximized : FormWindowState.Normal;
    }
    internal void CloseWithReason(string value) { reason = value; Close(); }
    void Emit(string type) => Program.Emit(new { type, sessionId = session,
        positionSeconds = (failed ? lastPosition : Math.Max(0, player.Time)) / 1000d, durationSeconds = Math.Max(lastDuration, Math.Max(0, player.Length)) / 1000d,
        playing = player.IsPlaying, savedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        decodedAudio = media?.Statistics.DecodedAudio ?? 0,
        decodedVideo = media?.Statistics.DecodedVideo ?? 0,
        displayedPictures = media?.Statistics.DisplayedPictures ?? 0,
        lostPictures = media?.Statistics.LostPictures ?? 0,
        audioTrack = player.AudioTrack, subtitleTrack = player.Spu });
    void Shutdown() {
        if (closing) return; closing = true; clock.Stop();
        Emit("progress"); player.Stop(); // Stop is synchronous in LibVLC 3; transport drains before closed.
        tooltips.Dispose();audio.Dispose();subtitles.Dispose();trackMenu.Dispose();
        player.Dispose(); media?.Dispose(); engine.Dispose();
        Program.Emit(new { type = "closed", sessionId = session, reason });
    }
}
