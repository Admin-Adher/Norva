# Norva profile avatars

Drop the profile avatar images here.

- **Files**: `avatar-01.png` … `avatar-12.png` (about 12).
- **Format**: PNG, square, transparent or solid background.
- **Size**: 512×512 px (stays crisp on a 4K TV).
- The app references avatars by id (`avatar-01`, `avatar-02`, …) and builds the
  path `/img/avatars/<id>.png`. Any missing file falls back to `placeholder.svg`.
- Custom user-uploaded avatars (a later phase) will be stored separately and do
  not go in this folder.
