namespace Norva.NativePlayer;

// WatchPage's hierarchy: back/title above, timeline and transport below, and
// compact track menus. LibVLC still owns all demuxing, decoding and seeking.
internal sealed partial class PlayerWindow
{
    readonly Panel topBar=new(){BackColor=Color.Black};
    readonly Panel bottomBar=new(){BackColor=Color.Black};
    readonly Label titleLabel=new(){AutoEllipsis=true,TextAlign=ContentAlignment.MiddleLeft,BackColor=Color.Black};
    readonly Label timeCurrent=new(){Text="0:00",TextAlign=ContentAlignment.MiddleLeft,BackColor=Color.Black};
    readonly Label timeTotal=new(){Text="0:00",TextAlign=ContentAlignment.MiddleRight,BackColor=Color.Black};
    readonly ToolTip tooltips=new(){ShowAlways=true};
    readonly ContextMenuStrip trackMenu=new(){ShowImageMargin=false,ShowCheckMargin=true};
    readonly List<PlayerIconButton> leftActions=[],rightActions=[];
    PlayerIconButton audioButton=null!,subtitleButton=null!;
    long controlsActivity=Environment.TickCount64;
    Point previousCursor;
    bool keyboardControls;
    void BuildControls()
    {
        Controls.Add(view);Controls.Add(topBar);Controls.Add(bottomBar);
        topBar.Controls.Add(back);topBar.Controls.Add(titleLabel);
        titleLabel.Font=PlayerTheme.Font(15,FontStyle.Bold);timeCurrent.Font=timeTotal.Font=PlayerTheme.Font(10);
        status.Dock=DockStyle.None;status.TextAlign=ContentAlignment.MiddleCenter;status.BackColor=PlayerTheme.Color("color-bg-secondary");Controls.Add(status);
        var restart=new PlayerIconButton("restart",()=>Seek(0));LabelControl(restart,"restart");
        var backward=new PlayerIconButton("backward",()=>Seek(player.Time-10000));LabelControl(backward,"backward");
        var forward=new PlayerIconButton("forward",()=>Seek(player.Time+10000));LabelControl(forward,"forward");
        leftActions.AddRange([restart,backward,pause,forward]);
        var mute=new PlayerIconButton("volume",()=>volume.Value=volume.Value==0?lastVolume:0);LabelControl(mute,"mute");
        audioButton=new PlayerIconButton("audio",()=>ShowTrackMenu(audio,audioButton));
        subtitleButton=new PlayerIconButton("subtitles",()=>ShowTrackMenu(subtitles,subtitleButton));
        var speed=new PlayerIconButton("speed",()=>ShowSpeedMenu());LabelControl(speed,"speed");
        rightActions.AddRange([mute,audioButton,subtitleButton,speed,fullscreen]);
        foreach(var control in leftActions.Concat(rightActions))bottomBar.Controls.Add(control);
        bottomBar.Controls.Add(volume);bottomBar.Controls.Add(timeCurrent);bottomBar.Controls.Add(timeline);bottomBar.Controls.Add(timeTotal);
        Resize+=(_,_)=>LayoutControls();
        view.MouseDoubleClick+=(_,_)=>ToggleFullScreen();
        view.MouseClick+=(_,_)=>{ShowControls();if(opened&&!failed)player.Pause();};
        trackMenu.BackColor=PlayerTheme.Color("color-bg-secondary");trackMenu.ForeColor=ForeColor;trackMenu.Font=Font;
        trackMenu.Renderer=new PlayerMenuRenderer();
        trackMenu.Closed+=(_,_)=>ShowControls();
        LayoutControls();topBar.BringToFront();bottomBar.BringToFront();status.BringToFront();
    }
    int lastVolume=100;
    void LabelControl(PlayerIconButton button,string key){button.Text=button.AccessibleName=PlayerStrings.Get(key);tooltips.SetToolTip(button,button.Text);}
    void LayoutControls()
    {
        var s=DeviceDpi/96f;int Px(int value)=>(int)Math.Round(value*s);
        var w=ClientSize.Width;var h=ClientSize.Height;
        topBar.SetBounds(0,0,w,Px(96));bottomBar.SetBounds(0,h-Px(136),w,Px(136));
        back.SetBounds(Px(24),Px(24),Px(48),Px(48));
        titleLabel.SetBounds(Px(88),Px(24),Math.Max(0,w-Px(112)),Px(48));
        timeCurrent.SetBounds(Px(24),0,Px(64),Px(44));timeTotal.SetBounds(w-Px(96),0,Px(72),Px(44));
        timeline.SetBounds(Px(88),0,Math.Max(Px(44),w-Px(192)),Px(44));
        var x=Px(24);foreach(var button in leftActions){var size=button==pause?64:44;button.SetBounds(x,Px(48)+(button==pause?0:Px(10)),Px(size),Px(size));x+=Px(size+8);}
        var rightWidth=Px(5*44+5*8+100);x=w-Px(24)-rightWidth;
        for(var i=0;i<rightActions.Count;i++){var button=rightActions[i];button.SetBounds(x,Px(58),Px(44),Px(44));x+=Px(52);if(i==0){volume.SetBounds(x,Px(58),Px(100),Px(44));x+=Px(108);}}
        status.SetBounds(Math.Max(Px(24),(w-Px(440))/2),Math.Max(Px(96),(h-Px(96))/2),Math.Min(Px(440),w-Px(48)),Px(96));
    }
    void ShowControls(){controlsActivity=Environment.TickCount64;topBar.Visible=bottomBar.Visible=true;}
    void UpdateControls(long position,long length)
    {
        static string Time(long ms){var span=TimeSpan.FromMilliseconds(ms);return span.TotalHours>=1?$"{(int)span.TotalHours}:{span.Minutes:00}:{span.Seconds:00}":$"{span.Minutes}:{span.Seconds:00}";}
        timeCurrent.Text=Time(position);timeTotal.Text=Time(length);
        pause.Icon=player.IsPlaying?"pause":"play";pause.Invalidate();
        LabelControl(pause,player.IsPlaying?"pause":"play");
        audioButton.Enabled=audio.Enabled;subtitleButton.Enabled=subtitles.Enabled;
        var cursor=PointToClient(Cursor.Position);
        if(cursor!=previousCursor&&ClientRectangle.Contains(cursor)){previousCursor=cursor;keyboardControls=false;ShowControls();}
        if(volume.Value>0)lastVolume=volume.Value;
        var visible=!player.IsPlaying||dragging||trackMenu.Visible||keyboardControls||Environment.TickCount64-controlsActivity<3000;
        topBar.Visible=bottomBar.Visible=visible;
        status.Visible=player.State is not (LibVLCSharp.Shared.VLCState.Playing or LibVLCSharp.Shared.VLCState.Paused);
    }
    void ShowTrackMenu(ComboBox combo,PlayerIconButton trigger)
    {
        ShowControls();trackMenu.Items.Clear();
        foreach(var choice in combo.Items.Cast<TrackChoice>()){
            var item=new ToolStripMenuItem(choice.Label){Checked=choice.Id==(combo==audio?player.AudioTrack:player.Spu),AutoSize=false,Width=280,Height=44};
            item.Click+=(_,_)=>{combo.SelectedItem=choice;trigger.Focus();};trackMenu.Items.Add(item);
        }
        OpenMenu(trigger);
    }
    void ShowSpeedMenu()
    {
        ShowControls();trackMenu.Items.Clear();
        foreach(var speed in new[]{0.5f,0.75f,1f,1.25f,1.5f,2f}){var item=new ToolStripMenuItem($"{speed:0.##}×"){Checked=Math.Abs(player.Rate-speed)<0.01,AutoSize=false,Width=180,Height=44};item.Click+=(_,_)=>player.SetRate(speed);trackMenu.Items.Add(item);}
        OpenMenu(rightActions[3]);
    }
    void OpenMenu(PlayerIconButton trigger)
    {
        trackMenu.MaximumSize=new Size((int)(320*DeviceDpi/96f),Math.Min(ClientSize.Height-96,(int)(360*DeviceDpi/96f)));
        trackMenu.Closed+=Restore;
        void Restore(object? sender,ToolStripDropDownClosedEventArgs args){trackMenu.Closed-=Restore;trigger.Focus();}
        var size=trackMenu.GetPreferredSize(Size.Empty);
        trackMenu.Show(trigger,new Point(trigger.Width-size.Width,-size.Height));
    }
}
