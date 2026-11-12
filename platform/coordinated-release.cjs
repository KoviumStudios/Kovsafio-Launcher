'use strict';
const assert=require('node:assert/strict');
const TARGETS=['win32-x64','linux-x64','darwin-x64','darwin-arm64'];
function coordinatedRelease(metadata,proofs){
 assert(/^\d+\.\d+\.\d+$/.test(metadata?.version)&&/^[a-f0-9]{64}$/.test(metadata.sha256),'Metadatos de versión no válidos.');
 assert(Array.isArray(proofs)&&proofs.length===4,'La publicación requiere Windows, Linux, Mac Intel y Mac Apple Silicon.');
 const seen=new Set();for(const proof of proofs){assert(TARGETS.includes(proof.target)&&!seen.has(proof.target),'Destino repetido o desconocido.');seen.add(proof.target);assert(proof.version===metadata.version&&proof.appSha256===metadata.sha256,'Una plataforma contiene otra versión o archivo.');assert(proof.nativeVerified===true&&proof.updateVerified===true,'Falta comprobar el arranque y la actualización de una plataforma.');if(proof.target==='win32-x64')assert(proof.installedVersion===metadata.version&&proof.healthy===true&&proof.previousVersion&&proof.signatureVerified===true,'Falta la actualización real de Windows.');}
 return{ok:true,version:metadata.version,sha256:metadata.sha256,targets:TARGETS,allPlatformsReady:true};
}
module.exports={coordinatedRelease,TARGETS};

if(require.main===module){try{const fs=require('node:fs');const metadata=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),proofs=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));console.log(JSON.stringify(coordinatedRelease(metadata,proofs),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
