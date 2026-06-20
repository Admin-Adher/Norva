type JsonRecord = Record<string, unknown>;

export type LiveCatalogItem = {
  id?: string;
  source_id?: string;
  sourceId?: string;
  item_type?: string;
  external_id?: string;
  externalId?: string;
  parent_external_id?: string | null;
  title?: string;
  name?: string;
  subtitle?: string | null;
  poster_url?: string | null;
  posterUrl?: string | null;
  stream_icon?: string | null;
  metadata?: JsonRecord | null;
  playback_hint?: JsonRecord | null;
  playbackHint?: JsonRecord | null;
  available?: boolean;
};

type ParsedName = {
  coreStr: string;
  quals: string[];
  codec: boolean;
  foreign: string | null;
};

type LineupEntry = {
  key: string;
  lcn?: number;    // national channel number where it exists (Europe/Maghreb TNT)
  rank?: number;   // curated popularity order where there is no channel number (US/IN)
  name: string;
  aliases: string[];
  logo?: string;   // curated real logo, used when the provider logo is dead/empty
};

type LiveVariant = {
  id: string;
  media_item_id: string | null;
  mediaItemId: string | null;
  label: string;
  rank: number;
  healthRank: number;
  source_id: string;
  sourceId: string;
  stream_id: string;
  streamId: string;
  external_id: string;
  item_type: "live";
  raw: string;
  title: string;
  name: string;
  poster_url: string;
  stream_icon: string;
  category_id: string;
  category_name: string;
  playback_hint: JsonRecord;
  playbackHint: JsonRecord;
  metadata: JsonRecord;
  container_extension: string;
};

type LiveBucket = {
  key: string;
  name: string;
  section: string;
  groupId: string;
  groupName: string;
  lcn?: number;
  logo?: string;
  firstIndex: number;
  variants: LiveVariant[];
};

const TVLOGO = "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/";

const COUNTRY_LINEUPS: Record<string, LineupEntry[]> = {
  FR: [
    { key: "tf1", lcn: 1, name: "TF1", aliases: ["tf1"], logo: TVLOGO + "france/tf1-fr.png" },
    { key: "france2", lcn: 2, name: "France 2", aliases: ["france 2"], logo: TVLOGO + "france/france-2-fr.png" },
    { key: "france3", lcn: 3, name: "France 3", aliases: ["france 3"], logo: TVLOGO + "france/france-3-fr.png" },
    { key: "france4", lcn: 4, name: "France 4", aliases: ["france 4"], logo: TVLOGO + "france/france-4-fr.png" },
    { key: "france5", lcn: 5, name: "France 5", aliases: ["france 5"], logo: TVLOGO + "france/france-5-fr.png" },
    { key: "m6", lcn: 6, name: "M6", aliases: ["m6"], logo: TVLOGO + "france/m6-fr.png" },
    { key: "arte", lcn: 7, name: "Arte", aliases: ["arte"], logo: TVLOGO + "france/arte-fr.png" },
    { key: "c8", lcn: 8, name: "C8", aliases: ["c8"], logo: TVLOGO + "france/c8-fr.png" },
    { key: "w9", lcn: 9, name: "W9", aliases: ["w9"], logo: TVLOGO + "france/w9-fr.png" },
    { key: "tmc", lcn: 10, name: "TMC", aliases: ["tmc"], logo: TVLOGO + "france/tmc-fr.png" },
    { key: "tfx", lcn: 11, name: "TFX", aliases: ["tfx"], logo: TVLOGO + "france/tfx-fr.png" },
    { key: "nrj12", lcn: 12, name: "NRJ 12", aliases: ["nrj 12", "nrj12"], logo: TVLOGO + "france/nrj-12-fr.png" },
    { key: "lcp", lcn: 13, name: "LCP", aliases: ["lcp", "public senat"], logo: TVLOGO + "france/lcp-fr.png" },
    { key: "bfmtv", lcn: 15, name: "BFM TV", aliases: ["bfm tv", "bfmtv"], logo: TVLOGO + "france/bfm-tv-fr.png" },
    { key: "cnews", lcn: 16, name: "CNews", aliases: ["cnews"], logo: TVLOGO + "france/c-news-fr.png" },
    { key: "cstar", lcn: 17, name: "CStar", aliases: ["cstar"], logo: TVLOGO + "france/c-star-fr.png" },
    { key: "gulli", lcn: 18, name: "Gulli", aliases: ["gulli"], logo: TVLOGO + "france/gulli-fr.png" },
    { key: "tf1sf", lcn: 19, name: "TF1 Series Films", aliases: ["tf1 series films", "tf1 series film", "tf1 series et films"], logo: TVLOGO + "france/tf1-series-films-fr.png" },
    { key: "lequipe", lcn: 21, name: "L'Equipe", aliases: ["l equipe", "lequipe"], logo: TVLOGO + "france/lequipe-fr.png" },
    { key: "6ter", lcn: 22, name: "6ter", aliases: ["6ter"], logo: TVLOGO + "france/6ter-fr.png" },
    { key: "rmcstory", lcn: 23, name: "RMC Story", aliases: ["rmc story"], logo: TVLOGO + "france/rmc-story-fr.png" },
    { key: "rmcdecouverte", lcn: 24, name: "RMC Decouverte", aliases: ["rmc decouverte"], logo: TVLOGO + "france/rmc-decouverte-fr.png" },
    { key: "cherie25", lcn: 25, name: "Cherie 25", aliases: ["cherie 25", "cherie25"] },
    { key: "lci", lcn: 26, name: "LCI", aliases: ["lci"], logo: TVLOGO + "france/lci-fr.png" },
    { key: "franceinfo", lcn: 27, name: "Franceinfo", aliases: ["france info", "franceinfo"], logo: TVLOGO + "france/franceinfo-fr.png" },
  ],
  US: [
    { key: "abc", rank: 1, name: "ABC", aliases: ["abc"], logo: TVLOGO + "united-states/abc-us.png" },
    { key: "cbs", rank: 2, name: "CBS", aliases: ["cbs"], logo: TVLOGO + "united-states/cbs-logo-white-us.png" },
    { key: "nbc", rank: 3, name: "NBC", aliases: ["nbc"], logo: TVLOGO + "united-states/nbc-us.png" },
    { key: "fox", rank: 4, name: "FOX", aliases: ["fox"], logo: TVLOGO + "united-states/fox-us.png" },
    { key: "thecw", rank: 5, name: "The CW", aliases: ["the cw", "cw"], logo: TVLOGO + "united-states/the-cw-us.png" },
    { key: "pbs", rank: 6, name: "PBS", aliases: ["pbs"], logo: TVLOGO + "united-states/pbs-us.png" },
    { key: "cnn", rank: 7, name: "CNN", aliases: ["cnn"], logo: TVLOGO + "united-states/cnn-us.png" },
    { key: "foxnews", rank: 8, name: "Fox News", aliases: ["fox news"], logo: TVLOGO + "united-states/fox-news-us.png" },
    { key: "msnbc", rank: 9, name: "MSNBC", aliases: ["msnbc"], logo: TVLOGO + "united-states/msnbc-hz-us.png" },
    { key: "cnbc", rank: 10, name: "CNBC", aliases: ["cnbc"], logo: TVLOGO + "united-states/cnbc-us.png" },
    { key: "espn", rank: 11, name: "ESPN", aliases: ["espn"], logo: TVLOGO + "united-states/espn-us.png" },
    { key: "espn2", rank: 12, name: "ESPN2", aliases: ["espn 2", "espn2"], logo: TVLOGO + "united-states/espn-2-us.png" },
    { key: "fs1", rank: 13, name: "Fox Sports 1", aliases: ["fox sports 1", "fs1"], logo: TVLOGO + "united-states/fox-sports-1-us.png" },
    { key: "hbo", rank: 14, name: "HBO", aliases: ["hbo"], logo: TVLOGO + "united-states/hbo-us.png" },
    { key: "amc", rank: 15, name: "AMC", aliases: ["amc"], logo: TVLOGO + "united-states/amc-us.png" },
    { key: "tnt", rank: 16, name: "TNT", aliases: ["tnt"], logo: TVLOGO + "united-states/tnt-us.png" },
    { key: "tbs", rank: 17, name: "TBS", aliases: ["tbs"], logo: TVLOGO + "united-states/tbs-us.png" },
    { key: "discovery", rank: 18, name: "Discovery", aliases: ["discovery", "discovery channel"], logo: TVLOGO + "united-states/discovery-channel-us.png" },
    { key: "history", rank: 19, name: "History", aliases: ["history", "history channel"], logo: TVLOGO + "united-states/history-channel-us.png" },
    { key: "cartoonnetwork", rank: 20, name: "Cartoon Network", aliases: ["cartoon network"], logo: TVLOGO + "united-states/cartoon-network-us.png" },
    { key: "nickelodeon", rank: 21, name: "Nickelodeon", aliases: ["nickelodeon"], logo: TVLOGO + "united-states/nickelodeon-us.png" },
    { key: "disneychannel", rank: 22, name: "Disney Channel", aliases: ["disney channel"], logo: TVLOGO + "united-states/disney-channel-us.png" },
    { key: "hgtv", rank: 23, name: "HGTV", aliases: ["hgtv"], logo: TVLOGO + "united-states/hgtv-us.png" },
    { key: "foodnetwork", rank: 24, name: "Food Network", aliases: ["food network"], logo: TVLOGO + "united-states/food-network-us.png" },
    { key: "comedycentral", rank: 25, name: "Comedy Central", aliases: ["comedy central"], logo: TVLOGO + "united-states/comedy-central-us.png" },
    { key: "mtv", rank: 26, name: "MTV", aliases: ["mtv"], logo: TVLOGO + "united-states/mtv-us.png" },
    { key: "tlc", rank: 27, name: "TLC", aliases: ["tlc"], logo: TVLOGO + "united-states/tlc-us.png" },
    { key: "bravo", rank: 28, name: "Bravo", aliases: ["bravo"], logo: TVLOGO + "united-states/bravo-us.png" },
    { key: "bet", rank: 29, name: "BET", aliases: ["bet"], logo: TVLOGO + "united-states/bet-us.png" },
    { key: "paramountnetwork", rank: 30, name: "Paramount Network", aliases: ["paramount network"], logo: TVLOGO + "united-states/paramount-network-us.png" },
  ],
  IN: [
    { key: "starplus", rank: 1, name: "Star Plus", aliases: ["star plus"], logo: TVLOGO + "india/star-plus-in.png" },
    { key: "colors", rank: 2, name: "Colors", aliases: ["colors"], logo: TVLOGO + "india/colors-in.png" },
    { key: "sonytv", rank: 3, name: "Sony Entertainment Television", aliases: ["sony entertainment television", "sony tv"], logo: TVLOGO + "india/sony-entertainment-television-in.png" },
    { key: "zeetv", rank: 4, name: "Zee TV", aliases: ["zee tv"], logo: TVLOGO + "india/zee-tv-in.png" },
    { key: "starbharat", rank: 5, name: "Star Bharat", aliases: ["star bharat"], logo: TVLOGO + "india/star-bharat-in.png" },
    { key: "sonysab", rank: 6, name: "Sony SAB", aliases: ["sony sab", "sab tv"], logo: TVLOGO + "india/sony-sab-in.png" },
    { key: "andtv", rank: 7, name: "&TV", aliases: ["and tv"], logo: TVLOGO + "india/and-tv-in.png" },
    { key: "stargold", rank: 8, name: "Star Gold", aliases: ["star gold"], logo: TVLOGO + "india/star-gold-in.png" },
    { key: "zeecinema", rank: 9, name: "Zee Cinema", aliases: ["zee cinema"], logo: TVLOGO + "india/zee-cinema-in.png" },
    { key: "sonymax", rank: 10, name: "Sony Max", aliases: ["sony max"], logo: TVLOGO + "india/sony-max-in.png" },
    { key: "aajtak", rank: 11, name: "Aaj Tak", aliases: ["aaj tak"], logo: TVLOGO + "india/aaj-tak-in.png" },
    { key: "ndtv24x7", rank: 12, name: "NDTV 24x7", aliases: ["ndtv 24x7", "ndtv 24 7"], logo: TVLOGO + "india/ndtv-24x7-in.png" },
    { key: "indiatoday", rank: 13, name: "India Today", aliases: ["india today"], logo: TVLOGO + "india/india-today-in.png" },
    { key: "republictv", rank: 14, name: "Republic TV", aliases: ["republic tv"], logo: TVLOGO + "india/republic-tv-in.png" },
    { key: "timesnow", rank: 15, name: "Times Now", aliases: ["times now"], logo: TVLOGO + "india/times-now-in.png" },
    { key: "zeenews", rank: 16, name: "Zee News", aliases: ["zee news"], logo: TVLOGO + "india/zee-news-in.png" },
    { key: "ndtvindia", rank: 17, name: "NDTV India", aliases: ["ndtv india"], logo: TVLOGO + "india/ndtv-india-in.png" },
    { key: "starsports1", rank: 18, name: "Star Sports 1", aliases: ["star sports 1"], logo: TVLOGO + "india/star-sports-1-in.png" },
    { key: "sonyten1", rank: 19, name: "Sony Ten 1", aliases: ["sony ten 1"], logo: TVLOGO + "india/sony-ten-1-in.png" },
    { key: "starmaa", rank: 20, name: "Star Maa", aliases: ["star maa"], logo: TVLOGO + "india/star-maa-in.png" },
    { key: "asianet", rank: 21, name: "Asianet", aliases: ["asianet"], logo: TVLOGO + "india/asianet-in.png" },
    { key: "zeebangla", rank: 22, name: "Zee Bangla", aliases: ["zee bangla"], logo: TVLOGO + "india/zee-bangla-in.png" },
  ],
};

const GROUPS = {
  primary: { id: "primary", name: "Chaines principales", priority: 1, defaultCollapsed: false },
  regional: { id: "regional", name: "Chaines regionales", priority: 2, defaultCollapsed: true },
  multiplex: { id: "multiplex", name: "Multiplex et evenements", priority: 3, defaultCollapsed: true },
};

const QUALITY_TOKENS: Record<string, string> = {
  "4k": "4K",
  uhd: "4K",
  hdr: "HDR",
  fhd: "FHD",
  superhd: "Super HD",
  hd: "HD",
  sd: "SD",
};
const CODEC_TOKENS = new Set(["h265", "hevc", "h264", "avc"]);
const FOREIGN_PREFIXES = new Set([
  "ar",
  "br",
  "ca",
  "de",
  "it",
  "pl",
  "es",
  "us",
  "uk",
  "nl",
  "be",
  "ch",
  "pt",
  "ro",
  "tr",
  "ru",
  "gr",
  "dz",
  "ma",
  "tn",
  "sa",
  "ae",
  "qa",
  "al",
  "rs",
  "bg",
  "hu",
  "cz",
  "in",
  "pk",
]);

export function buildLiveCatalog(
  rows: LiveCatalogItem[],
  options: {
    country?: string;
    sourceId?: string | null;
    categoryId?: string | null;
    includeVariants?: boolean;
  } = {},
) {
  const country = String(options.country || "FR").toUpperCase();
  const includeVariants = options.includeVariants === true;
  const buckets = buildBuckets(rows, country);
  let channels = buckets
    .map((bucket) => makeLogicalChannel(bucket, includeVariants))
    .filter((channel): channel is JsonRecord => Boolean(channel));
  const categoryId = stringOrNull(options.categoryId);
  if (categoryId) {
    channels = channels.filter((channel) => String(channel.category_id) === categoryId);
  }

  const groupsById = new Map<string, JsonRecord>();
  for (const channel of channels) {
    const id = String(channel.category_id || "uncategorized");
    if (!groupsById.has(id)) {
      const fixed = GROUPS[id as keyof typeof GROUPS];
      groupsById.set(id, {
        id,
        category_id: id,
        name: channel.category_name || fixed?.name || id,
        category_name: channel.category_name || fixed?.name || id,
        priority: fixed?.priority ?? 20,
        defaultCollapsed: fixed?.defaultCollapsed ?? true,
        count: 0,
      });
    }
    const group = groupsById.get(id)!;
    group.count = Number(group.count || 0) + 1;
  }

  return {
    contract: "norva.live.logical.v1",
    country,
    sourceId: options.sourceId || null,
    channels,
    groups: [...groupsById.values()].sort((a, b) =>
      (Number(a.priority || 20) - Number(b.priority || 20)) ||
      String(a.category_name || a.name).localeCompare(String(b.category_name || b.name), undefined, { sensitivity: "base" })
    ),
    count: channels.length,
    rawCount: rows.length,
  };
}

export function findLiveChannel(catalog: ReturnType<typeof buildLiveCatalog>, logicalId: string) {
  return catalog.channels.find((channel) => String(channel.id) === String(logicalId)) || null;
}

function buildBuckets(rows: LiveCatalogItem[], country: string) {
  const { lineup, aliasMap } = buildAliasMap(country);
  const targetCc = country.toLowerCase();
  const buckets = new Map<string, LiveBucket>();

  rows.forEach((row, index) => {
    const title = row.title || row.name || "";
    const parsed = parseName(title);
    const sourceId = sourceIdOf(row);
    const variant = variantFrom(row, parsed);
    if (!sourceId || !variant.streamId) return;

    // A "XX |" prefix only marks a foreign feed when it differs from the
    // user's own country (e.g. for a US user, "US | ESPN" is NOT foreign).
    const isForeign = Boolean(parsed.foreign) && parsed.foreign !== targetCc;

    let bucket: LiveBucket | null = null;
    const national = !isForeign ? aliasMap[parsed.coreStr] : null;
    if (national) {
      const key = `${sourceId}:primary:${national.key}`;
      bucket = ensureBucket(buckets, key, {
        key,
        name: national.name,
        section: "primary",
        groupId: GROUPS.primary.id,
        groupName: GROUPS.primary.name,
        lcn: national.lcn ?? national.rank,
        logo: national.logo,
        firstIndex: index,
      });
    } else if (!isForeign) {
      const parent = findParent(parsed.coreStr, lineup);
      if (parent) {
        const section = classifyExtra(parsed.coreStr);
        const cleanName = stripProviderPrefix(title) || title;
        const key = `${sourceId}:${section}:${parent.key}:${parsed.coreStr || normalizeKey(cleanName)}`;
        const group = GROUPS[section as "regional" | "multiplex"];
        bucket = ensureBucket(buckets, key, {
          key,
          name: cleanName,
          section,
          groupId: group.id,
          groupName: group.name,
          firstIndex: index,
        });
      }
    }

    if (!bucket) {
      const category = categoryOf(row);
      const keyName = parsed.coreStr || normalizeKey(title) || variant.streamId;
      const key = `${sourceId}:other:${category.id}:${keyName}`;
      bucket = ensureBucket(buckets, key, {
        key,
        name: cleanLogicalName(title),
        section: "other",
        groupId: category.id,
        groupName: category.name,
        firstIndex: index,
      });
    }
    bucket.variants.push(variant);
  });

  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, variants: dedupeVariants(bucket.variants) }))
    .filter((bucket) => bucket.variants.length > 0)
    .sort((a, b) =>
      sectionPriority(a.section) - sectionPriority(b.section) ||
      ((a.lcn ?? 9999) - (b.lcn ?? 9999)) ||
      a.groupName.localeCompare(b.groupName, undefined, { sensitivity: "base" }) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) ||
      a.firstIndex - b.firstIndex
    );
}

function ensureBucket(buckets: Map<string, LiveBucket>, key: string, value: Omit<LiveBucket, "variants">) {
  const existing = buckets.get(key);
  if (existing) return existing;
  const bucket = { ...value, variants: [] };
  buckets.set(key, bucket);
  return bucket;
}

function makeLogicalChannel(bucket: LiveBucket, includeVariants: boolean): JsonRecord | null {
  const variants = bucket.variants;
  const defaultVariant = pickDefault(variants);
  if (!defaultVariant) return null;
  const id = makeLogicalId(bucket.key);
  const channel: JsonRecord = {
    id,
    logical_id: id,
    logical_key: bucket.key,
    source_id: defaultVariant.source_id,
    sourceId: defaultVariant.sourceId,
    item_type: "live",
    type: "live",
    external_id: defaultVariant.external_id,
    stream_id: defaultVariant.stream_id,
    streamId: defaultVariant.streamId,
    title: bucket.name,
    name: bucket.name,
    lcn: bucket.lcn ?? null,
    num: bucket.lcn ?? null,
    section: bucket.section,
    category_id: bucket.groupId,
    category_name: bucket.groupName,
    group_id: bucket.groupId,
    group_name: bucket.groupName,
    poster_url: bucket.logo || defaultVariant.poster_url,
    stream_icon: bucket.logo || defaultVariant.stream_icon,
    variant_count: variants.length,
    variantCount: variants.length,
    variant_preview: variants.map(summaryVariant),
    default_variant: summaryVariant(defaultVariant),
    defaultVariant: summaryVariant(defaultVariant),
    playback_hint: defaultVariant.playback_hint,
    playbackHint: defaultVariant.playbackHint,
    metadata: {
      logical: true,
      sourceCategoryId: defaultVariant.category_id,
      sourceCategoryName: defaultVariant.category_name,
      section: bucket.section,
    },
  };
  if (includeVariants) {
    channel.variants = variants.map(summaryVariant);
  }
  return channel;
}

function summaryVariant(variant: LiveVariant) {
  return {
    id: variant.id,
    media_item_id: variant.media_item_id,
    mediaItemId: variant.mediaItemId,
    label: variant.label,
    rank: variant.rank,
    healthRank: variant.healthRank,
    source_id: variant.source_id,
    sourceId: variant.sourceId,
    stream_id: variant.stream_id,
    streamId: variant.streamId,
    external_id: variant.external_id,
    item_type: "live",
    raw: variant.raw,
    title: variant.title,
    name: variant.name,
    poster_url: variant.poster_url,
    stream_icon: variant.stream_icon,
    category_id: variant.category_id,
    category_name: variant.category_name,
    playback_hint: variant.playback_hint,
    playbackHint: variant.playbackHint,
    metadata: variant.metadata,
    container_extension: variant.container_extension,
  };
}

function buildAliasMap(country: string) {
  const lineup = COUNTRY_LINEUPS[country] || [];
  const aliasMap: Record<string, LineupEntry> = {};
  for (const entry of lineup) {
    for (const alias of entry.aliases) aliasMap[alias] = entry;
  }
  return { lineup, aliasMap };
}

function parseName(raw: string): ParsedName {
  let work = destyle(raw).toLowerCase();
  let prefix = "";
  const prefixMatch = work.match(/^([a-z0-9 -]+?)\s*\|\s*/);
  if (prefixMatch) {
    prefix = prefixMatch[1].trim();
    work = work.slice(prefixMatch[0].length);
  }
  const codecHint = /\b(h265|hevc)\b/.test(work) || /\b(h265|hevc)\b/.test(prefix);
  work = work.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");

  const quals: string[] = [];
  let codec = codecHint;
  let foreign: string | null = null;
  for (const token of prefix.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (QUALITY_TOKENS[token]) quals.push(QUALITY_TOKENS[token]);
    else if (token === "fr" || token === "kids") {
      // National/context tags, not channel identity.
    } else if (FOREIGN_PREFIXES.has(token)) foreign = token;
  }

  const core: string[] = [];
  for (const token of work.replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)) {
    if (QUALITY_TOKENS[token]) quals.push(QUALITY_TOKENS[token]);
    else if (CODEC_TOKENS.has(token)) codec = token === "h265" || token === "hevc" || codec;
    else core.push(token);
  }
  return { coreStr: core.join(" "), quals, codec, foreign };
}

function destyle(value: string) {
  let out = "";
  for (const char of String(value || "")) {
    const code = char.codePointAt(0) || 0;
    if (code >= 0x24b6 && code <= 0x24cf) out += String.fromCharCode(65 + (code - 0x24b6));
    else if (code >= 0x24d0 && code <= 0x24e9) out += String.fromCharCode(97 + (code - 0x24d0));
    else if (code >= 0x1d400 && code <= 0x1d419) out += String.fromCharCode(65 + (code - 0x1d400));
    else if (code >= 0x1d41a && code <= 0x1d433) out += String.fromCharCode(97 + (code - 0x1d41a));
    else out += char;
  }
  return out.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function qualityLabel(parsed: ParsedName) {
  let base = "HD";
  if (parsed.quals.includes("4K")) base = "4K";
  else if (parsed.quals.includes("FHD")) base = "FHD";
  else if (parsed.quals.includes("Super HD")) base = "Super HD";
  else if (parsed.quals.includes("HD")) base = "HD";
  else if (parsed.quals.includes("SD")) base = "SD";
  if (parsed.quals.includes("HDR")) base += " HDR";
  if (parsed.codec) base += " - H265";
  return base;
}

function rankOf(label: string) {
  if (label.startsWith("4K")) return 0;
  if (label.startsWith("Super HD") || label.startsWith("FHD")) return 1;
  if (label.startsWith("HD")) return 2;
  if (label.startsWith("SD")) return 3;
  return 2;
}

function healthRank(item: LiveCatalogItem) {
  const metadata = recordOrEmpty(item.metadata);
  const mode = String(metadata.playbackMode || metadata.playback_mode || metadata.playbackStatus || metadata.playback_status || "unknown");
  if (mode === "broken" || mode === "hs") return 3;
  if (mode === "directHls" || mode === "transcoding" || mode === "ok") return 0;
  return 1;
}

function pickDefault(variants: LiveVariant[]) {
  const ok = variants.filter((variant) => variant.healthRank < 3);
  const pool = (ok.length ? ok : variants).slice();
  const capped = pool.filter((variant) => variant.rank >= 1);
  const list = capped.length ? capped : pool;
  list.sort((a, b) => (a.healthRank - b.healthRank) || (a.rank - b.rank));
  return list[0] || variants[0] || null;
}

function livePlaybackContainer(playbackHint: JsonRecord, metadata: JsonRecord) {
  const stored = String(playbackHint.container || metadata.container || "ts");
  const explicit = Boolean(
    playbackHint.containerExplicit ||
    playbackHint.container_explicit ||
    metadata.containerExplicit ||
    metadata.container_explicit
  );
  if (stored.toLowerCase() === "m3u8" && !explicit) return "ts";
  return stored;
}

function variantFrom(item: LiveCatalogItem, parsed: ParsedName): LiveVariant {
  const label = qualityLabel(parsed);
  const metadata = recordOrEmpty(item.metadata);
  const playbackHint = recordOrEmpty(item.playback_hint ?? item.playbackHint);
  const sourceId = sourceIdOf(item);
  const streamId = String(item.external_id || item.externalId || item.id || "");
  const title = String(item.title || item.name || "Norva");
  const category = categoryOf(item);
  const poster = String(item.poster_url || item.posterUrl || item.stream_icon || "");
  const container = livePlaybackContainer(playbackHint, metadata);
  return {
    id: `${sourceId}:${streamId}`,
    media_item_id: stringOrNull(item.id),
    mediaItemId: stringOrNull(item.id),
    label,
    rank: rankOf(label),
    healthRank: healthRank(item),
    source_id: sourceId,
    sourceId,
    stream_id: streamId,
    streamId,
    external_id: streamId,
    item_type: "live",
    raw: title,
    title,
    name: title,
    poster_url: poster,
    stream_icon: poster,
    category_id: category.id,
    category_name: category.name,
    playback_hint: playbackHint,
    playbackHint,
    metadata,
    container_extension: container,
  };
}

function dedupeVariants(variants: LiveVariant[]) {
  const byLabel = new Map<string, LiveVariant>();
  for (const variant of variants.slice().sort((a, b) => (a.healthRank - b.healthRank) || (a.rank - b.rank))) {
    if (!byLabel.has(variant.label)) byLabel.set(variant.label, variant);
  }
  return [...byLabel.values()].sort((a, b) => (a.healthRank - b.healthRank) || (a.rank - b.rank) || a.label.localeCompare(b.label));
}

function findParent(coreStr: string, lineup: LineupEntry[]) {
  for (const entry of lineup) {
    if (entry.aliases.some((alias) => coreStr.startsWith(`${alias} `))) return entry;
  }
  return null;
}

function classifyExtra(coreStr: string) {
  if (/\b(corse|via stella|noa|alsace|bretagne|paris ile|cote d azur|aquitaine|occitanie|nord|grand est|africa|afrique)\b/.test(coreStr)) {
    return "regional";
  }
  if (/\b(live|event|foot|sport|multiplex|hd \d+|\d+)$/.test(coreStr) || /\blive\b/.test(coreStr)) {
    return "multiplex";
  }
  return "regional";
}

function categoryOf(item: LiveCatalogItem) {
  const metadata = recordOrEmpty(item.metadata);
  const rawId = item.parent_external_id ?? metadata.categoryId ?? metadata.group ?? "uncategorized";
  const id = String(rawId || "uncategorized");
  const rawName = item.subtitle ?? metadata.categoryName ?? metadata.group ?? (id === "uncategorized" ? "Uncategorized" : `Category ${id}`);
  return {
    id,
    name: String(rawName || id),
  };
}

function sourceIdOf(item: LiveCatalogItem) {
  return String(item.source_id || item.sourceId || "");
}

function sectionPriority(section: string) {
  if (section === "primary") return 1;
  if (section === "regional") return 2;
  if (section === "multiplex") return 3;
  return 20;
}

function stripProviderPrefix(value: string) {
  return String(value || "").replace(/^[^|]*\|\s*/, "").trim();
}

function cleanLogicalName(value: string) {
  return stripProviderPrefix(value) || String(value || "Norva").trim() || "Norva";
}

function normalizeKey(value: string) {
  return destyle(value)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeLogicalId(key: string) {
  return `lc_${btoa(key).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}
