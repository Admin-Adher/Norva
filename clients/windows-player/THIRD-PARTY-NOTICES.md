# Native media components

Norva is licensed under GPL-3.0-only. This build dynamically links the following unmodified components distributed by their official NuGet packages:

- LibVLCSharp and LibVLCSharp.WinForms 3.10.1 — LGPL-2.1-or-later. Source: https://code.videolan.org/videolan/LibVLCSharp .
- VideoLAN.LibVLC.Windows 3.0.24 — LGPL-2.1-or-later package. Source and build scripts: https://code.videolan.org/videolan/libvlc-nuget and https://code.videolan.org/videolan/vlc .
- .NET Windows Desktop runtime 10.0 — MIT. Source and notices: https://github.com/dotnet/windowsdesktop and https://github.com/dotnet/runtime .

Native libraries are separate files, not linked into Norva's executable. The pinned NuGet dependency graph and integrity hashes are in packages.lock.json. This experimental build is not an official Windows release. A distribution review, complete dependency notices/source provision and package signing remain release gates.
