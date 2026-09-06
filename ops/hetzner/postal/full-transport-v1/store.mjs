import {DatabaseSync} from 'node:sqlite';
import {createCipheriv,createDecipheriv,createHmac,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync} from 'node:fs';
export class MailStore{
 constructor(path,key,{now=()=>Date.now()}={}){
  if(!/^[a-f0-9]{64}$/.test(key))throw Error('invalid_store_key');
  this.key=Buffer.from(hkdfSync('sha256',Buffer.from(key,'hex'),'norva-mail','payload',32));
  this.hmacKey=Buffer.from(hkdfSync('sha256',Buffer.from(key,'hex'),'norva-mail','indexes',32));
  this.now=now;this.db=new DatabaseSync(path);chmodSync(path,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1500;
   CREATE TABLE IF NOT EXISTS batches(key TEXT PRIMARY KEY,digest TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,batch_key TEXT NOT NULL REFERENCES batches(key),slot INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',cipher TEXT,content_hash TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,
    next_at INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,postal_id INTEGER,secure INTEGER NOT NULL DEFAULT 0,
    recipient_hash TEXT NOT NULL,auth INTEGER NOT NULL,flow TEXT NOT NULL,error TEXT,sent_at INTEGER,db_synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(batch_key,slot));
   CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,next_at,created);
   CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),kind TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS suppressions(recipient_hash TEXT PRIMARY KEY,reason TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS runtime(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);
 }
 hash(value){return createHmac('sha256',this.hmacKey).update(value).digest('hex');}
 seal(id,value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key,iv);c.setAAD(Buffer.from(id));
  const body=Buffer.concat([c.update(JSON.stringify(value)),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
 open(id,value){const b=Buffer.from(value,'base64'),c=createDecipheriv('aes-256-gcm',this.key,b.subarray(0,12));
  c.setAAD(Buffer.from(id));c.setAuthTag(b.subarray(12,28));return JSON.parse(Buffer.concat([c.update(b.subarray(28)),c.final()]).toString());}
 transaction(work){this.db.exec('BEGIN IMMEDIATE');try{const out=work();this.db.exec('COMMIT');return out;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 accept(request,{dailyLimit=1000,activeLimit=500}={}){
  return this.transaction(()=>{
   const k=this.hash(request.authority),old=this.db.prepare('SELECT * FROM batches WHERE key=?').get(k);
   if(old){if(old.digest!==request.digest||old.kind!==request.kind)throw Error('idempotency_conflict');return this.batch(k);}
   const now=this.now(),day=now-now%86400000;
   if(this.db.prepare('SELECT count(*) AS n FROM jobs WHERE created>=?').get(day).n+request.messages.length>dailyLimit||
      this.db.prepare("SELECT count(*) AS n FROM jobs WHERE state IN ('pending','api_started','held','sending')").get().n+request.messages.length>activeLimit)throw Error('queue_limit');
   if(request.messages.some(m=>this.suppressed(m.to)))throw Error('recipient_suppressed');
   this.db.prepare('INSERT INTO batches VALUES(?,?,?,?)').run(k,request.digest,request.kind,now);
   request.messages.forEach((m,slot)=>{
    // Stable across a local spool restore: the VM's independent permanent
    // journal must see the same message identity, never a fresh random send.
    const h=this.hash('job:'+request.authority+':'+slot);const id='postal_'+h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-8'+h.slice(17,20)+'-'+h.slice(20,32);
    this.db.prepare(`INSERT INTO jobs(id,batch_key,slot,cipher,content_hash,created,expires,recipient_hash,auth,flow)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id,k,slot,this.seal(id,{message:m,deliveryKey:request.key}),request.digest,now,
       now+(m.auth?15*60000:24*3600000),this.hash(m.to),m.auth?1:0,m.flow);});
   return this.batch(k);
  });
 }
 batch(key){return this.db.prepare('SELECT id,state,auth,postal_id,secure FROM jobs WHERE batch_key=? ORDER BY slot').all(key);}
 existing(request){const k=this.hash(request.authority),old=this.db.prepare('SELECT * FROM batches WHERE key=?').get(k);
  if(!old)return null;if(old.digest!==request.digest||old.kind!==request.kind)throw Error('idempotency_conflict');return this.batch(k);}
 next(){return this.db.prepare("SELECT * FROM jobs WHERE state IN ('pending','api_started','held','sending') AND next_at<=? ORDER BY auth DESC,created,slot LIMIT 1").get(this.now());}
 payload(job){if(!job.cipher)throw Error('payload_scrubbed');return this.open(job.id,job.cipher);}
 mark(id,state,fields={}){
  if(!['pending','api_started','held','sending','sent','failed','uncertain','canceled'].includes(state))throw Error('invalid_job_state');
  const names=Object.keys(fields);if(names.some(n=>!['next_at','attempts','postal_id','secure','error','sent_at'].includes(n)))throw Error('invalid_job_update');
  const terminal=['sent','failed','uncertain','canceled'].includes(state);
  const q=`UPDATE jobs SET state=?,db_synced=0${terminal?',cipher=NULL':''}${names.map(n=>','+n+'=?').join('')} WHERE id=? AND state NOT IN ('sent','failed','uncertain','canceled')`;
  return this.db.prepare(q).run(state,...names.map(n=>fields[n]),id).changes===1;
 }
 recover(){
  // Guest durable journals distinguish a saved receipt from an unknown DATA.
  // Recovery asks for those receipts; it never resets an attempt to pending.
  this.db.exec("UPDATE jobs SET next_at=0 WHERE state IN ('api_started','sending')");
 }
 suppressed(address){return !!this.db.prepare('SELECT 1 FROM suppressions WHERE recipient_hash=?').get(this.hash(address));}
 suppress(hash,reason){if(!/^[a-f0-9]{64}$/.test(hash)||!['bounce','complaint','permanent_recipient'].includes(reason))throw Error('suppression_invalid');
  this.db.prepare('INSERT INTO suppressions VALUES(?,?,?) ON CONFLICT(recipient_hash) DO UPDATE SET reason=excluded.reason').run(hash,reason,this.now());}
 feedback(key,id,kind){return this.transaction(()=>{
  if(!['MessageSent','MessageHeld','MessageDelayed','MessageDeliveryFailed','MessageBounced'].includes(kind))throw Error('invalid_event');
  const job=this.db.prepare('SELECT recipient_hash FROM jobs WHERE id=?').get(id);if(!job)throw Error('unbound_feedback');
  const added=this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(key,id,kind,this.now()).changes===1;
  if(['MessageBounced','complaint'].includes(kind))this.suppress(job.recipient_hash,kind==='complaint'?'complaint':'bounce');return added;
 });}
 unsynced(){return this.db.prepare("SELECT id,state,postal_id,secure,sent_at FROM jobs WHERE db_synced=0 AND state IN ('sent','failed','uncertain','canceled') LIMIT 32").all();}
 synced(id){this.db.prepare('UPDATE jobs SET db_synced=1 WHERE id=?').run(id);}
 status(){return {counts:this.db.prepare('SELECT state,count(*) AS count FROM jobs GROUP BY state').all(),
  events:this.db.prepare('SELECT count(*) AS n FROM events').get().n,suppressions:this.db.prepare('SELECT count(*) AS n FROM suppressions').get().n};}
 close(){this.db.close();}
}
