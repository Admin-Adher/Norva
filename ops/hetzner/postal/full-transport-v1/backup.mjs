import fs from'node:fs';import path from'node:path';import{generateKeyPairSync,randomBytes,createCipheriv,createDecipheriv,publicEncrypt,privateDecrypt,createHash,constants}from'node:crypto';
import{gzipSync,gunzipSync}from'node:zlib';
const mode=process.argv[2],context=Buffer.from('norva-private-auth-backup-v1');
if(mode==='--init-key'){
 const directory=path.resolve(process.argv[3]);if(fs.existsSync(directory))throw Error('backup_directory_exists');fs.mkdirSync(directory,{recursive:true,mode:0o700});
 const keys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
 fs.writeFileSync(path.join(directory,'recovery-private.pem'),keys.privateKey,{mode:0o600,flag:'wx'});
 fs.writeFileSync(path.join(directory,'recovery-public.pem'),keys.publicKey,{mode:0o644,flag:'wx'});
 console.log(JSON.stringify({result:'OFFSERVER_RECOVERY_KEY_CREATED',privateKeyPrinted:false}));
}else if(mode==='--encrypt'){
 let size=0;const parts=[];for await(const chunk of process.stdin){size+=chunk.length;if(size>20000000)throw Error('backup_limit');parts.push(chunk);}
 const content=gzipSync(Buffer.concat(parts)),key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(context);
 const data=Buffer.concat([cipher.update(content),cipher.final()]);
 const wrapped=publicEncrypt({key:fs.readFileSync(process.argv[3]),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key);
 process.stdout.write(JSON.stringify({v:1,key:wrapped.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}));
}else if(mode==='--verify'){
 const e=JSON.parse(fs.readFileSync(process.argv[3]));if(e.v!==1)throw Error('backup_version');
 const key=privateDecrypt({key:fs.readFileSync(process.argv[4]),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(e.key,'base64'));
 const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));cipher.setAAD(context);cipher.setAuthTag(Buffer.from(e.tag,'base64'));
 const files=JSON.parse(gunzipSync(Buffer.concat([cipher.update(Buffer.from(e.data,'base64')),cipher.final()]),{maxOutputLength:20000000}));
 for(const [n,v]of Object.entries(files.files)){if(createHash('sha256').update(Buffer.from(v.data,'base64')).digest('hex')!==v.sha256)throw Error('backup_hash_mismatch');}
 console.log(JSON.stringify({result:'BACKUP_DECRYPT_AND_HASH_CHECK_OK',scope:files.scope,files:Object.keys(files.files).length,privateValuesPrinted:false}));
}else throw Error('explicit_mode_required');
