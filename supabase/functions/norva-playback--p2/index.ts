// Lane de pool (audit capacité 2026-07-17) : un isolate V8 est monothread, et le routeur
// self-host (main/index.ts) n'accorde qu'UN worker par chemin de service. Ce module d'une
// ligne donne au runtime un chemin distinct -> un worker distinct, avec exactement la
// sémantique upstream (création par requête, dédoublonnage par chemin, respawn transparent).
// Le round-robin des lanes vit dans main/index.ts (HOT_POOL_SIZES).
import "../norva-playback/index.ts";
