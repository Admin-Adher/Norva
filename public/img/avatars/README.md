# Norva profile avatars

The 12 profile avatars live here as `avatar-01.png` … `avatar-12.png`.

- **Format**: PNG, square (currently 384×384, palette-optimised to ~30–55 KB
  each — crisp at the 140–184 px display sizes, including 4K TV).
- The app references avatars by id (`avatar-01`, `avatar-02`, …) and builds the
  path `/img/avatars/<id>.png`. Any missing file falls back to `placeholder.svg`.
- **Replacing one**: drop a square PNG at the same name. Keep it small — source
  art straight out of an image generator is often ~1.5 MB / 1254 px and should
  be downscaled to ~384 px before committing (the picker loads all 12 at once).
- Custom user-uploaded avatars (a later phase) will be stored separately and do
  not go in this folder.
