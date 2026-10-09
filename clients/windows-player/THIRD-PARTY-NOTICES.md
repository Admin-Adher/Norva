# Native media components

Norva is licensed under GPL-3.0-only. This build dynamically links the following unmodified components distributed by their official NuGet packages:

- LibVLCSharp and LibVLCSharp.WinForms 3.10.1 — LGPL-2.1-or-later. Source: https://code.videolan.org/videolan/LibVLCSharp .
- VideoLAN.LibVLC.Windows 3.0.24 — LGPL-2.1-or-later package. Source and build scripts: https://code.videolan.org/videolan/libvlc-nuget and https://code.videolan.org/videolan/vlc .
- .NET Windows Desktop runtime 10.0 — MIT. Source and notices: https://github.com/dotnet/windowsdesktop and https://github.com/dotnet/runtime .

Native libraries are separate replaceable DLLs, not statically linked into Norva's executable. Their license texts and .NET notices are in `licenses/`. The exact NuGet graph and integrity hashes are in `packages.lock.json`.

Corresponding VideoLAN source archives, including VLC build/contrib recipes, are listed with exact versions and SHA-256 in `source-manifest.json`. They are provided alongside the Windows preview executable at https://github.com/Admin-Adher/Norva/releases . Norva source and native build instructions are in the same repository (`clients/windows-player`, `scripts/build-native-player.cjs`). LibVLCSharp is unmodified; its dynamically loaded native libraries remain replaceable.

This is a Windows x64 preview, not a claim of universal codec, network or device compatibility. It is not code-signed. The release page identifies the exact source revision and executable checksum. No change to Windows security settings is required or recommended.
