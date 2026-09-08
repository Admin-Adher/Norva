import { mkdirSync, writeFileSync } from 'node:fs';
import { discoveryPlaylist } from '../supabase/functions/_shared/discovery-catalog.mjs';

// Operational source reviews stay internal; only the playback playlist is published.
const root = new URL('../public/catalog/', import.meta.url);
mkdirSync(root, { recursive: true });
writeFileSync(new URL('discovery.m3u', root), discoveryPlaylist());
