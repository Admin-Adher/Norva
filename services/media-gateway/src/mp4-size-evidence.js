'use strict';

// Inspect only top-level headers actually observed at their declared offsets.
// Payload bytes are never retained or mistaken for boxes. Missing/out-of-order
// ranges are inconclusive, not corruption. A caller must supply the exact
// representation length verified by its existing Content-Range/validator gate.
function createMp4SizeEvidence(total) {
    if (!Number.isSafeInteger(total) || total < 8) throw new TypeError('Invalid representation size');
    let next = 0, used = 0, boxes = 0, recognized = false, stopped = false;
    const header = Buffer.alloc(16);
    let evidence = null;
    function observe(start, bytes) {
        if (stopped || evidence || !Buffer.isBuffer(bytes) || !Number.isSafeInteger(start)
            || start < 0 || start + bytes.length > total) return evidence;
        while (boxes < 4096) {
            const cursor = next + used;
            if (cursor < start || cursor >= start + bytes.length) break;
            const needed = used < 8 ? 8 : header.readUInt32BE(0) === 1 ? 16 : 8;
            const length = Math.min(needed - used, start + bytes.length - cursor);
            bytes.copy(header, used, cursor - start, cursor - start + length);
            used += length;
            if (used < needed || (used === 8 && header.readUInt32BE(0) === 1)) continue;
            const type = header.toString('ascii', 4, 8);
            const raw = header.readUInt32BE(0);
            const size = raw === 1 ? header.readBigUInt64BE(8) : BigInt(raw);
            if (!recognized) {
                // Deliberately inconclusive for unusual layouts and other formats.
                if (next !== 0 || type !== 'ftyp' || size < 16n || size > BigInt(total)) {
                    stopped = true; break;
                }
                recognized = true;
            }
            if (size === 0n) { stopped = true; break; } // extends to physical EOF
            if (size < BigInt(used)) { stopped = true; break; }
            if (type === 'mdat' && BigInt(next) + size > BigInt(total)) {
                evidence = Object.freeze({ code: 'MP4_DECLARED_MEDIA_EXCEEDS_FILE',
                    fileSizeBytes: total, boxOffsetBytes: next,
                    declaredEndBytes: (BigInt(next) + size).toString() });
                break;
            }
            if (BigInt(next) + size > BigInt(total)) { stopped = true; break; }
            next += Number(size); used = 0; boxes++;
            if (next >= total) { stopped = true; break; }
        }
        if (boxes >= 4096) stopped = true;
        return evidence;
    }
    return Object.freeze({ observe });
}

module.exports = { createMp4SizeEvidence };
