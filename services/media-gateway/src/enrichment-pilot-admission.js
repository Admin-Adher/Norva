'use strict';

const invalid = () => Object.assign(new Error('ENRICHMENT_PILOT_CONFIG_INVALID'), {code:'ENRICHMENT_PILOT_CONFIG_INVALID'});
// Operator-owned opaque exact-file keys, never provider URLs/credentials. A
// missing/expired pilot MUST NOT turn into a fleet-wide authorization.
function createEnrichmentPilotAdmission(raw, {mode='disabled',now=Date.now}={}) {
    if (!['disabled','pilot','fleet'].includes(mode)) throw invalid();
    let keys=new Set(),expiresAt=null;const passiveSources=new Map(),passiveTargets=new Map();
    const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const passiveKey=(owner,url,profile)=>`${owner}:${url}:${profile}`;
    const targetKey=(owner,url)=>`${owner}:${url}`;
    if (mode==='pilot') {
        let config;try {config=typeof raw==='string'?JSON.parse(raw):raw;} catch {throw invalid();}
        const created=Date.parse(config?.createdAt),expires=Date.parse(config?.expiresAt);
        if (config?.protocol!==1 || !Array.isArray(config.fileKeys) || config.fileKeys.length<1 || config.fileKeys.length>20
            || config.fileKeys.some(key=>typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))
            || new Set(config.fileKeys).size!==config.fileKeys.length || !Number.isFinite(created) || !Number.isFinite(expires)
            || created>now()+5000 || expires<=created || expires-created>24*3600000) throw invalid();
        keys=new Set(config.fileKeys);expiresAt=expires;
        // Optional operator-owned playback canary. A ready viewer session must
        // match the exact account, source URL and observed file profile; neither
        // a source label nor client-provided metadata can widen the pilot.
        const sources=config.passiveSources??[];
        if(!Array.isArray(sources)||sources.length>20)throw invalid();
        for(const source of sources) {
            if(!source||Array.isArray(source)||Object.keys(source).length!==4
                ||!['ownerHash','sourceUrlHash','profileFingerprint','fileKey'].every(k=>hex(source[k]))
                ||!keys.has(source.fileKey))throw invalid();
            const key=passiveKey(source.ownerHash,source.sourceUrlHash,source.profileFingerprint);
            if(passiveSources.has(key))throw invalid();
            passiveSources.set(key,source.fileKey);
        }
        // An immutable exact-file/account/URL target is not evidence and does
        // not yet authorize collection. A service-only live-session check may
        // later bind its newly observed full protocol-2 profile. Never ignore
        // probedAt or turn this into an owner/provider-wide wildcard.
        const targets=config.passiveTargets??[];
        if(!Array.isArray(targets)||targets.length>20)throw invalid();
        for(const target of targets) {
            if(!target||Array.isArray(target)||Object.keys(target).length!==3
                ||!['ownerHash','sourceUrlHash','fileKey'].every(k=>hex(target[k]))
                ||!keys.has(target.fileKey))throw invalid();
            const key=targetKey(target.ownerHash,target.sourceUrlHash);
            if(passiveTargets.has(key))throw invalid();
            passiveTargets.set(key,target.fileKey);
        }
    } else if (raw!==undefined && raw!==null && raw!=='') throw invalid();
    const allowsFile = key => mode==='fleet' || (mode==='pilot' && now()<expiresAt && keys.has(key));
    const allowsPassive=()=>mode==='fleet'||(mode==='pilot'&&now()<expiresAt&&passiveSources.size>0);
    return Object.freeze({mode,
        allowsFile,
        allowsPassive,
        allowsPassiveSource(owner,url,profile) {
            if(![owner,url,profile].every(hex)||!allowsPassive())return false;
            return mode==='fleet'||allowsFile(passiveSources.get(passiveKey(owner,url,profile)));
        },
        authorizeObservedPassiveSource(source) {
            if(mode!=='pilot'||now()>=expiresAt||!source||Array.isArray(source)||Object.keys(source).length!==4
                ||!['ownerHash','sourceUrlHash','profileFingerprint','fileKey'].every(k=>hex(source[k]))
                ||!allowsFile(source.fileKey)
                ||passiveTargets.get(targetKey(source.ownerHash,source.sourceUrlHash))!==source.fileKey)throw invalid();
            const key=passiveKey(source.ownerHash,source.sourceUrlHash,source.profileFingerprint);
            if(passiveSources.has(key)) {
                if(passiveSources.get(key)!==source.fileKey)throw invalid();
                return {protocol:1,authorized:true,alreadyGranted:true,expiresAt};
            }
            if(passiveSources.size>=20)throw invalid();
            passiveSources.set(key,source.fileKey);
            return {protocol:1,authorized:true,alreadyGranted:false,expiresAt};
        },
        assertFile(key) {
            if (!allowsFile(key)) throw Object.assign(new Error('Background enrichment is outside the active pilot'),
                {code:'LANGUAGE_ENRICHMENT_CAPACITY_BUSY',status:429,providerDrained:true,providerDrainProtocol:1});
        },
        snapshot:()=>({protocol:1,mode,files:keys.size,passiveSources:passiveSources.size,expiresAt,
            expired:mode==='pilot'&&now()>=expiresAt}),
    });
}
module.exports={createEnrichmentPilotAdmission};
