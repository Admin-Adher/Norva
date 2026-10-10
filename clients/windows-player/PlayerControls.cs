using System.Drawing.Drawing2D;
using System.Text.Json;
using System.ComponentModel;

namespace Norva.NativePlayer;

internal sealed class PlayerMenuRenderer : ToolStripProfessionalRenderer
{
    protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
    {
        using var brush=new SolidBrush(PlayerTheme.Color(e.Item.Selected?"color-bg-hover":"color-bg-secondary"));
        e.Graphics.FillRectangle(brush,new Rectangle(Point.Empty,e.Item.Size));
    }
    protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
    {
        using var pen=new Pen(PlayerTheme.Color("color-border-light"));
        e.Graphics.DrawRectangle(pen,0,0,e.ToolStrip.Width-1,e.ToolStrip.Height-1);
    }
    protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
    {
        using var pen=new Pen(PlayerTheme.Color("color-accent"),2);
        var r=e.ImageRectangle;
        e.Graphics.DrawLines(pen,[new Point(r.Left+2,r.Top+r.Height/2),new Point(r.Left+r.Width/3,r.Bottom-3),new Point(r.Right-2,r.Top+3)]);
    }
}

internal sealed class PlayerIconButton : Button
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)] internal string Icon { get; set; }
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)] internal bool Round { get; set; }
    bool hover, pressed;
    record Glyph(string[] Paths, bool Stroke, float StrokeWidth);
    static readonly Dictionary<string,Glyph> Glyphs = JsonSerializer.Deserialize<Dictionary<string,Glyph>>(
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory,"norva-player-icons.json")),Program.Json)!;
    internal PlayerIconButton(string icon, Action action, int size=44, bool round=false)
    {
        Icon=icon;Round=round;Size=new Size(size,size);MinimumSize=Size;FlatStyle=FlatStyle.Flat;
        FlatAppearance.BorderSize=0;BackColor=Color.Black;ForeColor=PlayerTheme.Color("color-text-primary");
        Cursor=Cursors.Hand;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer,true);
        Click+=(_,_)=>action();
        MouseEnter+=(_,_)=>{hover=true;Invalidate();};MouseLeave+=(_,_)=>{hover=false;pressed=false;Invalidate();};
        MouseDown+=(_,_)=>{pressed=true;Invalidate();};MouseUp+=(_,_)=>{pressed=false;Invalidate();};
        GotFocus+=(_,_)=>Invalidate();LostFocus+=(_,_)=>Invalidate();
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g=e.Graphics;g.Clear(BackColor);g.SmoothingMode=SmoothingMode.AntiAlias;
        var color=Enabled?ForeColor:PlayerTheme.Color("color-text-muted");
        using var surface=new SolidBrush(pressed?PlayerTheme.Color("color-bg-active"):hover?PlayerTheme.Color("color-bg-hover"):PlayerTheme.Color("color-bg-tertiary"));
        var box=new Rectangle(1,1,Width-2,Height-2);
        if(Round)g.FillEllipse(surface,box);else if(hover||pressed)g.FillRectangle(surface,box);
        if(Focused&&ShowFocusCues){using var ring=new Pen(PlayerTheme.Color("color-accent"),2);if(Round)g.DrawEllipse(ring,new Rectangle(3,3,Width-6,Height-6));else g.DrawRectangle(ring,new Rectangle(3,3,Width-6,Height-6));}
        if(!Glyphs.TryGetValue(Icon,out var glyph))return;
        var size=(Round&&Width>48?32:24)*DeviceDpi/96f;
        var state=g.Save();g.TranslateTransform((Width-size)/2,(Height-size)/2);g.ScaleTransform(size/24,size/24);
        foreach(var data in glyph.Paths) {
            // Windows' native geometry parser handles the same SVG paths, including arcs.
            var geometry=System.Windows.Media.Geometry.Parse("F1 "+data).GetFlattenedPathGeometry();
            using var path=new GraphicsPath(FillMode.Winding);
            foreach(var figure in geometry.Figures) {
                path.StartFigure();var previous=new PointF((float)figure.StartPoint.X,(float)figure.StartPoint.Y);
                foreach(var segment in figure.Segments) {
                    var points=segment is System.Windows.Media.PolyLineSegment poly?poly.Points.ToArray():segment is System.Windows.Media.LineSegment line?[line.Point]:[];
                    foreach(var point in points){var next=new PointF((float)point.X,(float)point.Y);path.AddLine(previous,next);previous=next;}
                }
                if(figure.IsClosed)path.CloseFigure();
            }
            using var brush=new SolidBrush(color);using var pen=new Pen(color,glyph.StrokeWidth){StartCap=LineCap.Round,EndCap=LineCap.Round,LineJoin=LineJoin.Round};
            if(glyph.Stroke)g.DrawPath(pen,path);else g.FillPath(brush,path);
        }
        g.Restore(state);
    }
}

internal sealed class PlayerSlider : Control
{
    int value;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)] internal int Maximum { get; set; }=10000;
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)] internal int Minimum { get; set; }
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Hidden)] internal int Value { get=>value;set{var next=Math.Clamp(value,Minimum,Maximum);if(this.value==next)return;this.value=next;Invalidate();ValueChanged?.Invoke(this,EventArgs.Empty);} }
    internal event EventHandler? ValueChanged;
    internal event EventHandler? Committed;
    internal PlayerSlider(){Height=44;TabStop=true;AccessibleRole=AccessibleRole.Slider;BackColor=Color.Black;Cursor=Cursors.Hand;SetStyle(ControlStyles.UserPaint|ControlStyles.OptimizedDoubleBuffer|ControlStyles.Selectable,true);}
    protected override void OnPaint(PaintEventArgs e){
        var g=e.Graphics;g.Clear(BackColor);g.SmoothingMode=SmoothingMode.AntiAlias;var y=Height/2;var inset=8*DeviceDpi/96f;
        var x=inset+(Width-inset*2)*(Value-Minimum)/Math.Max(1f,Maximum-Minimum);
        using var track=new Pen(PlayerTheme.Color("color-border"),4*DeviceDpi/96f){StartCap=LineCap.Round,EndCap=LineCap.Round};
        using var filled=new Pen(PlayerTheme.Color("color-accent"),track.Width){StartCap=LineCap.Round,EndCap=LineCap.Round};
        g.DrawLine(track,inset,y,Width-inset,y);g.DrawLine(filled,inset,y,x,y);
        using var thumb=new SolidBrush(Enabled?PlayerTheme.Color("color-accent"):PlayerTheme.Color("color-text-muted"));g.FillEllipse(thumb,x-inset,y-inset,inset*2,inset*2);
        if(Focused&&ShowFocusCues){using var focus=new Pen(PlayerTheme.Color("color-accent"),2);g.DrawRectangle(focus,1,1,Width-3,Height-3);}
    }
    void Position(int x){var inset=8*DeviceDpi/96f;Value=Minimum+(int)Math.Round(Math.Clamp((x-inset)/Math.Max(1,Width-inset*2),0,1)*(Maximum-Minimum));}
    protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);if(e.Button!=MouseButtons.Left)return;Focus();Capture=true;Position(e.X);}
    protected override void OnMouseMove(MouseEventArgs e){base.OnMouseMove(e);if(Capture)Position(e.X);}
    protected override void OnMouseUp(MouseEventArgs e){base.OnMouseUp(e);if(!Capture)return;Position(e.X);Capture=false;Committed?.Invoke(this,EventArgs.Empty);}
    protected override bool IsInputKey(Keys key)=>key is Keys.Left or Keys.Right or Keys.Home or Keys.End || base.IsInputKey(key);
    protected override void OnKeyDown(KeyEventArgs e){base.OnKeyDown(e);if(e.KeyCode is Keys.Left or Keys.Right or Keys.Home or Keys.End){Value=e.KeyCode switch{Keys.Home=>Minimum,Keys.End=>Maximum,Keys.Left=>Value-Math.Max(1,Maximum/100),_=>Value+Math.Max(1,Maximum/100)};Committed?.Invoke(this,EventArgs.Empty);e.Handled=true;}}
    protected override AccessibleObject CreateAccessibilityInstance()=>new SliderAccessible(this);
    sealed class SliderAccessible(PlayerSlider owner):ControlAccessibleObject(owner){public override string? Value{get=>owner.Value.ToString();set{if(int.TryParse(value,out var number)){owner.Value=number;owner.Committed?.Invoke(owner,EventArgs.Empty);}}}public override AccessibleRole Role=>AccessibleRole.Slider;}
}
