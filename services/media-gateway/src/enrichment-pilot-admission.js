'use strict';

const invalid = () => Object.assign(new Error('ENRICHMENT_PILOT_CONFIG_INVALID'), {code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
// Operator-owned opaque exact-file keys, never provider URLs/credentials. A
// missing/expired pilot MUST NOT turn into a fleet-wide authorization.
function createEnrichmentPilotAdmission(raw, {mode='disabled',now=Date.now}={}) {
    if (!['disabled','pilot','fleet'].includes(mode)) throw invalid();
    let keys=new Set(),expiresAt=null;
    if (mode==='pilot') {
        let config;try {config=typeof raw==='string'?JSON.parse(raw):raw;} catch {throw invalid();}
        const created=Date.parse(config?.createdAt),expires=Date.parse(config?.expiresAt);
        if (config?.protocol!==1 || !Array.isArray(config.fileKeys) || config.fileKeys.length!==20
            || config.fileKeys.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))
            || new Set(config.fileKeys).size!==20 || !Number.isFinite(created) || !Number.isFinite(expires)
            || created>now()+5000 || expires<=created || expires-created>24*3600000) throw invalid();
        keys=new Set(config.fileKeys);expiresAt=expires;
    } else if (raw!==undefined && raw!==null && raw!=='') throw invalid();
    const allowsFile = key => mode==='fleet' || (mode==='pilot' && now()<expiresAt && keys.has(key));
    return Object.freeze({mode,
        allowsFile,
        assertFile(key) {
            if (!allowsFile(key)) throw Object.assign(new Error('Background enrichment is outside the active pilot'),
                {code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY',status:429,providerDrained:true,providerDrainProtocol:1});
        },
        snapshot:()=>({protocol:1,mode,files:keys.size,expiresAt,
            expired:mode==='pilot'&&now()>=expiresAt}),
    });
}
module.exports={createEnrichmentPilotAdmission};
