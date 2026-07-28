# Norva key-page dependency trees

## Runtime conventions

- The web client is a vanilla-JavaScript SPA. It does not use ES module imports: `public/app.html` loads scripts in dependency order and controllers consume globals exposed on `window`.
- Every web page below therefore depends directly on its DOM section in `public/app.html` and on the shared styles in `public/css/main.css`.
- `public/js/app.js` is the shared shell/router. It instantiates the page controllers, owns the top and bottom navigation, global search, account sheet, mobile filter sheets, route history, notifications, and the Android bridge hand-off.
- In the Android phone client, the web SPA is hosted by `MainActivity`. Downloads and playback are native, programmatic Android views; there are no XML layout files for those two screens.
- Trees below include local files with visual or interaction impact. Cloud transport files are included where their loading/error state changes the rendered UI.

## `#home` — Home

Entry: `public/js/pages/HomePage.js`<br>
DOM entry: `public/app.html` (`#page-home`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
  - `public/js/app.js`
    - `public/js/profiles.js`
    - `public/js/components/SourceManager.js`
    - `public/js/components/ChannelList.js`
    - `public/js/components/VideoPlayer.js`
- `public/js/pages/HomePage.js`
  - `public/js/utils/mediaUtils.js`
  - `public/js/utils/catalogCache.js`
  - `public/js/utils/hoverPreview.js`
  - `public/js/utils/sourceHealth.js`
  - `public/js/icons.js`
  - `public/js/api.js`
    - `public/js/cloudApi.js`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java` (mobile WebView shell, native playback/download bridges)
- `public/img/norva-media-placeholder.png`
- `public/img/norva-ecosystem-logo.png`
- `public/img/devices/norva-device-phone.webp`
- `public/img/devices/norva-device-tablet.webp`
- `public/img/devices/norva-device-tv.webp`
- `public/img/devices/norva-device-laptop.webp`

Primary UI: ecosystem card, setup/source-health gate, hero carousel, Continue Watching, personalised media rails, My List, favourite live channels, loading/error/empty states.

## `#live` — Live TV

Entry: `public/js/pages/LivePage.js`<br>
DOM entry: `public/app.html` (`#page-live`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
  - `public/js/app.js`
- `public/js/pages/LivePage.js`
  - `public/js/components/ChannelList.js`
    - `public/js/utils/mediaUtils.js`
    - `public/js/utils/playbackHealth.js`
    - `public/js/icons.js`
    - `public/js/api.js`
      - `public/js/cloudApi.js`
  - `public/js/components/EpgGuide.js`
    - `public/js/api.js`
  - `public/js/components/LiveGuideFusion.js`
    - `public/js/components/ChannelList.js`
    - `public/js/components/EpgGuide.js`
    - `public/js/api.js`
  - `public/js/components/VideoPlayer.js`
    - `public/js/utils/mediaUtils.js`
    - `public/js/utils/playbackHealth.js`
    - `public/js/utils/castSender.js`
    - `public/js/api.js`
- `public/js/utils/tvNavigation.js`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java`
- `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java` (native hand-off in the phone APK)

Primary UI: source selector, channel search, group rail, programme rows, selected-channel preview, EPG metadata, hide-broken control, inline web player, empty/error/retry states.

## `#movies` — Movies

Entry: `public/js/pages/MoviesPage.js`<br>
DOM entry: `public/app.html` (`#page-movies`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
  - `public/js/app.js`
    - `public/js/components/SourceManager.js`
    - `public/js/profiles.js`
- `public/js/pages/MoviesPage.js`
  - `public/js/components/MultiSelect.js`
  - `public/js/utils/mediaUtils.js`
  - `public/js/utils/GenreTaxonomy.js`
  - `public/js/utils/GenreRails.js`
    - `public/js/utils/mediaUtils.js`
  - `public/js/utils/catalogCache.js`
  - `public/js/utils/hoverPreview.js`
  - `public/js/utils/playbackHealth.js`
  - `public/js/icons.js`
  - `public/js/api.js`
    - `public/js/cloudApi.js`
- `public/js/utils/tvNavigation.js`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadStore.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadService.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
- `public/img/norva-media-placeholder.png`

Primary UI: source/category filters, searchable multi-select, sort and facet controls, filter chips, genre rails or paged grid, movie cards, Continue Watching, detail hero, primary play/resume action, favourite/download/rating actions, version list, related titles.

## `#series` — Series

Entry: `public/js/pages/SeriesPage.js`<br>
DOM entry: `public/app.html` (`#page-series`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
  - `public/js/app.js`
    - `public/js/components/SourceManager.js`
    - `public/js/profiles.js`
- `public/js/pages/SeriesPage.js`
  - `public/js/components/MultiSelect.js`
  - `public/js/utils/mediaUtils.js`
  - `public/js/utils/GenreTaxonomy.js`
  - `public/js/utils/GenreRails.js`
    - `public/js/utils/mediaUtils.js`
  - `public/js/utils/catalogCache.js`
  - `public/js/utils/hoverPreview.js`
  - `public/js/utils/playbackHealth.js`
  - `public/js/icons.js`
  - `public/js/api.js`
    - `public/js/cloudApi.js`
- `public/js/utils/tvNavigation.js`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadStore.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadService.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
- `public/img/norva-media-placeholder.png`

Primary UI: source/category filters, genre rails or paged grid, series cards, Continue Watching, series detail hero, version list, season tabs, episode rows, watched/download controls, next-episode prompt, related titles.

## Global search overlay

Entry: `public/js/app.js` (`openSearch`, `buildSearchOverlay`, `runSearch`, `renderSearchResults`)<br>
DOM trigger: `public/app.html` (`#nav-search`, `#nav-search-bottom`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
- `public/js/app.js`
  - `public/js/utils/mediaUtils.js`
  - `public/js/api.js`
    - `public/js/cloudApi.js`
  - `public/js/pages/MoviesPage.js` (open result/detail or “See all”)
  - `public/js/pages/SeriesPage.js` (open result/detail or “See all”)
  - `public/js/utils/tvNavigation.js`
- `public/img/norva-media-placeholder.png`

Primary UI: modal search field, debounced loading state, movie and series result sections, result cards, “See all” actions, no-result state, focus restoration.

## `#settings` — Settings and devices

Entry: `public/js/pages/Settings.js`<br>
DOM entry: `public/app.html` (`#page-settings`)

Dependencies:
- `public/app.html`
  - `public/css/main.css`
  - `public/js/app.js`
    - `public/js/components/SourceManager.js`
    - `public/js/profiles.js`
- `public/js/pages/Settings.js`
  - `public/js/components/NorvaModal.js`
  - `public/js/components/RegionPicker.js`
    - `public/js/utils/regions.js`
  - `public/js/utils/sourceHealth.js`
  - `public/js/utils/mediaUtils.js`
  - `public/js/components/VideoPlayer.js`
  - `public/js/api.js`
    - `public/js/cloudApi.js`
- `public/js/billing-config.js`
- `public/js/billing.js`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/NorvaBilling.java`

Primary UI: account/access card, profile switch, player and discovery preferences, region picker, source-health card, source management, advanced/transcoding sections, users, trusted devices/screens, pair-code approval, status and confirmation modals.

## Profile picker and profile management overlay

Entry: `public/js/profiles.js`<br>
DOM host: injected into `public/app.html`

Dependencies:
- `public/js/profiles.js`
  - `public/js/cloudApi.js` (`window.NorvaCloud.profiles`)
  - `public/js/api.js`
  - `public/js/components/NorvaModal.js`
  - `public/js/app.js` (`applyProfileSwitch`, navigation refresh)
- `public/css/main.css`
- `public/img/avatars/avatar-01.png`
- `public/img/avatars/avatar-02.png`
- `public/img/avatars/avatar-03.png`
- `public/img/avatars/avatar-04.png`
- `public/img/avatars/avatar-05.png`
- `public/img/avatars/avatar-06.png`
- `public/img/avatars/avatar-07.png`
- `public/img/avatars/avatar-08.png`
- `public/img/avatars/avatar-09.png`
- `public/img/avatars/avatar-10.png`

Primary UI: “Who’s watching?” grid, switch/manage modes, profile editor, avatar picker, child/locked profile states, initial profile setup, delete confirmation, orientation-responsive scale fitting.

## Native Downloads library

Entry: `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java`<br>
Activity declaration: `clients/android-phone/app/src/main/AndroidManifest.xml`

Dependencies:
- `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadStore.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadService.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
    - `clients/android-phone/app/src/main/java/tv/norva/phone/EncryptedFileDataSource.java`
    - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadCrypto.java`
  - `clients/android-phone/app/src/main/res/drawable-nodpi/norva_media_placeholder.png`
  - `clients/android-phone/app/src/main/res/values/styles.xml`
  - `clients/android-phone/app/src/main/res/values/strings.xml`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java` (opens the Activity and exposes the web download bridge)

Primary UI: header and summary, Wi-Fi-only and smart-download toggles, clear-all action, movie cards, series/season accordions, episode rows, progress/status, horizontal action rows, storage-pressure dialog, empty state.

## Native VOD player

Entry: `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`<br>
Activity declaration: `clients/android-phone/app/src/main/AndroidManifest.xml`

Dependencies:
- `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/BoundedRangeDataSource.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/EncryptedFileDataSource.java`
    - `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadCrypto.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/PlaybackPreferenceStore.java`
    - `clients/android-phone/app/src/main/java/tv/norva/phone/TrackSelectionResolver.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/CastSupport.java`
    - `clients/android-phone/app/src/main/java/tv/norva/phone/CastOptionsProvider.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/NativePlaybackTelemetry.java`
  - `clients/android-phone/app/src/main/java/tv/norva/phone/NativePlayerUiTelemetry.java`
  - `clients/android-phone/app/src/main/res/drawable/ic_cast.xml`
  - `clients/android-phone/app/src/main/res/values/ids.xml`
  - `clients/android-phone/app/src/main/res/values/strings.xml`
  - `clients/android-phone/app/src/main/res/values-fr/strings.xml`
  - `clients/android-phone/app/src/main/res/values/styles.xml`
- `clients/android-phone/app/src/main/java/tv/norva/phone/MainActivity.java`
  - launches the player from `MoviesPage`/`SeriesPage` WebView messages
  - requests and applies fresh-stream recovery
  - persists progress back to the web/cloud layer
- `public/js/pages/MoviesPage.js` (movie URL, title, poster, variants, resume and preferences)
- `public/js/pages/SeriesPage.js` (episode URL, next-title, variants, resume and preferences)

Primary UI: Media3 controller, top title/back bar, play/pause/seek/timeline, compact audio/subtitle/brightness/aspect/lock actions, track and speed dialog, version picker, Cast bar, unlock affordance, gesture feedback, reconnecting feedback, retry/back error panel, picture-in-picture.
