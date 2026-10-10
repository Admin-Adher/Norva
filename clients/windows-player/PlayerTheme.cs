using System.Text.RegularExpressions;

namespace Norva.NativePlayer;

// Read the canonical product tokens bundled with the player. No second palette.
internal static class PlayerTheme
{
    static readonly System.Drawing.Text.PrivateFontCollection Fonts = LoadFonts();
    static System.Drawing.Text.PrivateFontCollection LoadFonts(){var fonts=new System.Drawing.Text.PrivateFontCollection();fonts.AddFontFile(Path.Combine(AppContext.BaseDirectory,"fonts","Inter-Regular.ttf"));return fonts;}
    internal static Font Font(float size,FontStyle style=FontStyle.Regular)=>new(Fonts.Families[0],size,style);
    static readonly string Css = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "norva-theme.css"));
    internal static Color Color(string token)
    {
        var value = Regex.Match(Css, @"--" + Regex.Escape(token) + @":\s*(#[0-9a-fA-F]{6})\s*;");
        if (!value.Success) throw new InvalidDataException("Missing product token");
        return ColorTranslator.FromHtml(value.Groups[1].Value);
    }
    internal static Button Button(string text, Action click)
    {
        var button = new Button { Text = text, AccessibleName = text, AutoSize = true,
            MinimumSize = new Size(80, 44), FlatStyle = FlatStyle.Flat, Margin = new Padding(4),
            BackColor = Color("color-bg-tertiary"), ForeColor = Color("color-text-primary") };
        button.FlatAppearance.BorderColor = Color("color-border-light");
        button.Click += (_, _) => click();
        return button;
    }
}
