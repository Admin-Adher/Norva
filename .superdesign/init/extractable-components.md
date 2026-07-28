# Extractable Norva UI components

## Extraction conventions

- The web client uses imperative vanilla JavaScript rather than framework props. “Extractable props” below are the minimal state/navigation inputs a Superdesign `DraftComponent` should expose.
- Android native screens are composed programmatically. Their extraction inputs map to Activity intent extras, persisted settings, and store state.
- Labels, icon identities, CSS classes, image asset paths, and stable structural order remain hardcoded unless explicitly listed as dynamic.

## AppShellNavigation

- Source: `public/app.html`, `public/js/app.js`, `public/css/main.css`
- Category: layout
- Description: Shared Norva shell with top navigation, mobile seven-item bottom navigation, active-page state, alerts, search and profile access.
- Extractable props: `activePage` (string, default: `"home"`), `catalogReady` (boolean, default: true), `showAdmin` (boolean, default: false), `notificationCount` (number, default: 0), `downloadsCount` (number, default: 0), `profileAvatar` (string), `profileName` (string), `isTvMode` (boolean, default: false)
- Hardcoded: Norva logo treatment, page order, Home/Live TV/Movies/Series/Search/Downloads/Profile labels, SVG/icon asset identities, CSS classes, responsive breakpoints.

## MobileCatalogFilterSheet

- Source: `public/js/app.js` (`createMobileCatalogSetup`, `createMobileFilterSection`), `public/app.html`, `public/css/main.css`
- Category: layout
- Description: Phone/tablet filter sheet shared by Movies and Series with source/category controls, advanced facets and sticky actions.
- Extractable props: `mediaType` (`"movies"` or `"series"`), `isOpen` (boolean, default: false), `selectedSource` (string), `selectedCategories` (string[]), `activeFilterCount` (number, default: 0), `showApply` (boolean, default: true), `showReset` (boolean, default: true)
- Hardcoded: section order, “All Sources”, “All Categories”, Apply/Reset/Close copy, filter icon identity, panel CSS and system-navigation safe-area rules.

## AccountSheet

- Source: `public/js/app.js` (`buildAccountSheet`, `refreshAccountSheet`), `public/css/main.css`
- Category: layout
- Description: Compact account/profile action sheet opened from the mobile shell.
- Extractable props: `isOpen` (boolean, default: false), `profileName` (string), `profileAvatar` (string), `email` (string), `accessLabel` (string), `deviceCount` (number), `showScreens` (boolean, default: true)
- Hardcoded: Switch profile, Devices & screens, Settings and Sign out actions; icon asset identities; row order; modal CSS.

## GlobalSearchOverlay

- Source: `public/js/app.js` (`buildSearchOverlay`, `renderSearchResults`), `public/css/main.css`
- Category: layout
- Description: Full-catalogue movie/series search dialog with grouped results and focus restoration.
- Extractable props: `isOpen` (boolean, default: false), `query` (string), `isLoading` (boolean, default: false), `movieResults` (array), `seriesResults` (array), `noResults` (boolean, default: false), `onSelectResult` (action), `onSeeAll` (action)
- Hardcoded: 250 ms debounce, two-character threshold, Search movies & series placeholder, Movies/Series section labels, Cancel and See all copy, search icon SVG, result CSS.

## ProfileOverlay

- Source: `public/js/profiles.js`
- Category: layout
- Description: Responsive “Who’s watching?” picker and profile-management surface with avatar grid and editor modes.
- Extractable props: `mode` (`"pick"`, `"manage"`, `"edit"` or `"setup"`), `profiles` (array), `activeProfileId` (string), `selectedProfileId` (string), `canAddProfile` (boolean), `isTv` (boolean, default: false), `isLocked` (boolean, default: false)
- Hardcoded: “Who’s watching?” and management copy, twelve-avatar capacity, avatar path convention, close/back affordance, layout scale algorithm, overlay/editor CSS injected by the module.

## SettingsTabs

- Source: `public/app.html` (`#page-settings`), `public/js/pages/Settings.js`, `public/css/main.css`
- Category: layout
- Description: Tabbed settings workspace with phone-only advanced-section disclosure.
- Extractable props: `activeTab` (string, default: `"account"`), `availableTabs` (string[]), `showAdvanced` (boolean, default: false), `nativeShell` (boolean, default: false), `tvShell` (boolean, default: false)
- Hardcoded: tab labels and order, Advanced button label, account/player/content/transcoding/users/screens section markup, settings CSS.

## HomeHeroCarousel

- Source: `public/js/pages/HomePage.js` (`renderHero`, `showHeroSlide`)
- Category: basic
- Description: Cinematic rotating hero driven by recent and recommended media with backdrop, metadata and primary actions.
- Extractable props: `items` (array), `activeIndex` (number, default: 0), `autoplay` (boolean, default: true), `resumeProgress` (number), `onPlay` (action), `onDetails` (action)
- Hardcoded: rotation timing, swipe behavior, title/meta hierarchy, button labels, overlay gradient, hero CSS classes.

## EcosystemCard

- Source: `public/js/pages/HomePage.js` (`renderEcosystemCard`), `public/css/main.css`
- Category: basic
- Description: Multi-device Norva ecosystem promotion/status card for web, phone, tablet and TV.
- Extractable props: `sourceSummary` (object), `notificationPermission` (string), `showNotificationAction` (boolean), `showDeviceLinks` (boolean, default: true)
- Hardcoded: Norva ecosystem logo, four device types and imagery, ecosystem value proposition, platform icon identities, visual layout.

## SourceHealthCard

- Source: `public/js/utils/sourceHealth.js` (`cardHtml`), `public/js/pages/Settings.js`, `public/js/pages/HomePage.js`
- Category: basic
- Description: Shared source readiness/status card with progress, corrective action and compact error copy.
- Extractable props: `state` (string), `title` (string), `detail` (string), `progress` (number), `sourceName` (string), `actionLabel` (string), `showAction` (boolean, default: true)
- Hardcoded: state-to-colour/icon mapping, progress structure, CSS class names, default action routing.

## MediaRail

- Source: `public/js/utils/GenreRails.js`, `public/js/pages/HomePage.js`, `public/css/main.css`
- Category: basic
- Description: Horizontally scrollable titled media rail with arrow controls and responsive cards.
- Extractable props: `title` (string), `subtitle` (string), `items` (array), `showRank` (boolean, default: false), `showSeeAll` (boolean, default: false), `onItemClick` (action), `onSeeAll` (action)
- Hardcoded: rail DOM/CSS classes, arrow icon identities, placeholder image path, horizontal-scroll enhancement.

## MediaCard

- Source: `public/js/pages/HomePage.js` (`createRailCard`, `createHistoryCard`), `public/js/pages/MoviesPage.js` (`buildCard`), `public/js/pages/SeriesPage.js` (`buildCard`)
- Category: basic
- Description: Poster card pattern shared by home rails and movie/series catalogues.
- Extractable props: `title` (string), `posterUrl` (string), `meta` (string), `rating` (number), `languageBadge` (string), `progress` (number), `rank` (number), `isFavorite` (boolean), `isBroken` (boolean), `onOpen` (action)
- Hardcoded: placeholder asset, poster aspect ratio, badge/icon identities, progress-bar structure, hover/focus classes.

## ContinueWatchingCard

- Source: `public/js/pages/HomePage.js` (`createHistoryCard`), `public/js/pages/MoviesPage.js` (`renderContinueWatching`), `public/js/pages/SeriesPage.js` (`renderContinueWatching`)
- Category: basic
- Description: Resume-aware media card with watch progress and direct continuation behavior.
- Extractable props: `title` (string), `posterUrl` (string), `subtitle` (string), `progress` (number), `duration` (number), `itemType` (string), `onResume` (action), `onRemove` (action)
- Hardcoded: progress placement, resume affordance/icon identity, compact rail styling and media-type wording.

## MultiSelect

- Source: `public/js/components/MultiSelect.js`, `public/css/main.css`
- Category: basic
- Description: Searchable category multi-select panel used by both catalogue pages.
- Extractable props: `label` (string), `options` (array), `selectedValues` (string[]), `allLabel` (string, default: `"All Categories"`), `isOpen` (boolean, default: false), `onChange` (action)
- Hardcoded: All/Clear actions, checkbox-list structure, search behavior, panel and selected-count CSS.

## RegionPicker

- Source: `public/js/components/RegionPicker.js`, `public/js/utils/regions.js`, `public/css/main.css`
- Category: basic
- Description: Searchable, keyboard-accessible region combobox backed by a native select.
- Extractable props: `regions` (array), `selectedCode` (string), `query` (string), `isOpen` (boolean, default: false), `onChange` (action)
- Hardcoded: Countries/Regions group labels, flag-plus-name option format, combobox/listbox structure, fallback native-select behavior.

## ActiveFilterChips

- Source: `public/js/pages/MoviesPage.js` (`renderActiveFilterChips`), `public/js/pages/SeriesPage.js` (`renderActiveFilterChips`), `public/css/main.css`
- Category: basic
- Description: Removable summary chips for active movie and series filters.
- Extractable props: `filters` (array), `onRemove` (action), `onClearAll` (action)
- Hardcoded: chip close icon, media-specific filter-key ordering, CSS classes and compact spacing.

## CatalogueDetailPanel

- Source: `public/app.html` (`#movie-details`, `#series-details`), `public/js/pages/MoviesPage.js` (`showMovieDetails`), `public/js/pages/SeriesPage.js` (`showSeriesDetailsV2`)
- Category: layout
- Description: Shared cinematic detail pattern with backdrop, poster, metadata, actions, versions and recommendations.
- Extractable props: `mediaType` (string), `title` (string), `backdropUrl` (string), `posterUrl` (string), `summary` (string), `metadata` (array), `genres` (array), `primaryActionLabel` (string), `isFavorite` (boolean), `rating` (number), `canDownload` (boolean), `onPrimaryAction` (action), `onBack` (action)
- Hardcoded: hierarchy and responsive layout, Play/Favourite/Download/rating icon identities, backdrop gradient, detail CSS.

## VersionList

- Source: `public/js/pages/MoviesPage.js` (`renderMovieVersions`), `public/js/pages/SeriesPage.js` (`renderSeriesVersions`), `public/css/main.css`
- Category: basic
- Description: Provider/version selector showing language, source, container and quality metadata.
- Extractable props: `versions` (array), `selectedVersionId` (string), `summary` (string), `onSelect` (action), `focusFirst` (boolean, default: false)
- Hardcoded: selected indicator, row metadata order, “versions available” wording, list CSS.

## SeasonTabs

- Source: `public/js/pages/SeriesPage.js` (`setActiveSeason`, `_ensureSeasonBuilt`), `public/app.html`, `public/css/main.css`
- Category: basic
- Description: Season selector that lazily builds the active episode list.
- Extractable props: `seasons` (array), `activeSeason` (number), `episodeCounts` (object), `onSelectSeason` (action)
- Hardcoded: season-label format, tab structure, active-state CSS and lazy-render behavior.

## EpisodeRow

- Source: `public/js/pages/SeriesPage.js` (`_episodeListInnerHtml`, `_wireEpisodeItems`), `public/css/main.css`
- Category: basic
- Description: Episode list row with still image, number/title, duration, progress, watched state and download action.
- Extractable props: `episodeNumber` (number), `title` (string), `imageUrl` (string), `duration` (number), `progress` (number), `isWatched` (boolean), `downloadState` (string), `isFeatured` (boolean), `onPlay` (action), `onToggleWatched` (action), `onDownload` (action)
- Hardcoded: episode-number copy format, watched/download icon identities, placeholder behavior, row CSS.

## LiveGuide

- Source: `public/js/components/LiveGuideFusion.js`, `public/js/components/ChannelList.js`, `public/css/main.css`
- Category: layout
- Description: Live-TV browse surface combining groups, channel families, programme metadata and selected-channel preview.
- Extractable props: `groups` (array), `activeGroup` (string), `channels` (array), `selectedChannelId` (string), `searchQuery` (string), `hideBroken` (boolean), `isCinema` (boolean), `isLoading` (boolean), `error` (string), `onWatch` (action)
- Hardcoded: 150-row initial cap, group/row hierarchy, Watch/Favourite/Fullscreen/Cinema/TV Guide action labels, programme progress treatment, live-guide CSS.

## LiveChannelRow

- Source: `public/js/components/LiveGuideFusion.js` (`renderRow`), `public/js/components/ChannelList.js` (`buildChannelItemHtml`)
- Category: basic
- Description: Channel-family row with logo, channel title, current programme, health badge, favourite and play affordance.
- Extractable props: `channelId` (string), `logoUrl` (string), `name` (string), `programmeTitle` (string), `programmeTime` (string), `programmeProgress` (number), `qualityBadge` (string), `isFavorite` (boolean), `isSelected` (boolean), `isBroken` (boolean), `onPreview` (action), `onPlay` (action)
- Hardcoded: fallback logo generation, play/favourite icon identities, row DOM hierarchy and CSS.

## NorvaModal

- Source: `public/js/components/NorvaModal.js`, `public/css/main.css`
- Category: basic
- Description: Reusable alert/confirm/modal primitive with focus trapping, Back/Escape handling and opener-focus restoration.
- Extractable props: `type` (`"alert"` or `"confirm"`), `title` (string), `message` (string), `confirmLabel` (string), `cancelLabel` (string), `danger` (boolean, default: false), `isOpen` (boolean, default: false)
- Hardcoded: dialog structure, overlay behavior, focusable selector, keyboard/back policy and modal CSS.

## WebVideoPlayer

- Source: `public/js/components/VideoPlayer.js`, `public/app.html`, `public/css/main.css`
- Category: layout
- Description: Custom web live/VOD playback surface with HLS, overlay controls, subtitles, live-edge status and Cast integration.
- Extractable props: `title` (string), `streamUrl` (string), `posterUrl` (string), `isLive` (boolean), `isPlaying` (boolean), `currentTime` (number), `duration` (number), `volume` (number), `subtitleTracks` (array), `selectedSubtitle` (string), `error` (string)
- Hardcoded: five-second overlay timeout, 20-second live-behind threshold, control/icon identities, player DOM IDs, overlay CSS and HLS recovery policy.

## NativePlayerChrome

- Source: `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
- Category: layout
- Description: Native Media3 VOD controller augmented with Norva top bar, compact actions, track/version dialogs, Cast, gestures and lock mode.
- Extractable props: `title` (string), `posterUrl` (string), `isPlaying` (boolean), `positionSeconds` (number), `durationSeconds` (number), `audioTracks` (array), `subtitleTracks` (array), `selectedAudio` (string), `selectedSubtitle` (string), `playbackSpeed` (number), `aspectMode` (string), `brightness` (number), `controlsLocked` (boolean), `variants` (array), `isCasting` (boolean)
- Hardcoded: Media3 base control IDs/icons, 48 dp compact buttons, top-bar layout, audio/subtitle/brightness/aspect/lock action order, system drawable choices, gesture zones, immersive-mode policy.

## NativePlaybackErrorPanel

- Source: `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`
- Category: basic
- Description: Recoverable native playback error state with diagnostic text, Retry and Back actions.
- Extractable props: `isVisible` (boolean, default: false), `title` (string), `message` (string), `isRetrying` (boolean, default: false), `onRetry` (action), `onBack` (action)
- Hardcoded: localized error-title mapping, Retry/Back button order, 220 dp button width, centered vertical layout and dark overlay styling.

## NativeTrackPicker

- Source: `clients/android-phone/app/src/main/java/tv/norva/phone/PlayerActivity.java`, `clients/android-phone/app/src/main/java/tv/norva/phone/TrackSelectionResolver.java`
- Category: basic
- Description: Native dialog for audio, subtitles and playback-speed selection.
- Extractable props: `audioOptions` (array), `subtitleOptions` (array), `speedOptions` (array), `selectedAudioId` (string), `selectedSubtitleId` (string), `selectedSpeed` (number), `initialSection` (string), `onSelect` (action)
- Hardcoded: Audio/Subtitles/Playback speed section order, radio-row pattern, unsupported/burned-in copy, Close action and dialog styling.

## NativeDownloadsLibrary

- Source: `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java`
- Category: layout
- Description: Native offline-library surface with global policies, movie cards and nested series/season groups.
- Extractable props: `items` (array), `summary` (string), `activeCount` (number), `wifiOnly` (boolean), `smartDownloads` (boolean), `storageWarning` (object), `onClose` (action), `onClearAll` (action)
- Hardcoded: Downloads/Close/Clear all labels, dark palette constants, section order, programmatic padding/type sizes and scroll layout.

## DownloadItemCard

- Source: `clients/android-phone/app/src/main/java/tv/norva/phone/DownloadsActivity.java` (`movieCard`, `showCard`, `episodeRow`, `actionsRow`)
- Category: basic
- Description: Native offline movie/episode item with poster, status, progress and contextual actions.
- Extractable props: `title` (string), `subtitle` (string), `posterPath` (string), `status` (string), `progress` (number), `bytesDownloaded` (number), `totalBytes` (number), `isPlayable` (boolean), `isPaused` (boolean), `isExpanded` (boolean), `actions` (array)
- Hardcoded: poster dimensions, fallback drawable, Play/Pause/Resume/Queue/Delete wording, pill visual treatment, action-row order and season chevron.
