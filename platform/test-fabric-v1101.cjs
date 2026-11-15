'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const source=process.env.KOVIUM_TEST_SOURCE||path.join(__dirname,'player-v170');
const {prepareFabricMetadata,fetchFabricProfile,listFabricVersions}=require(path.join(source,'fabric-runtime'));
const {validateCatalog,catalogRevision}=require(path.join(source,'catalog-service'));
const base={id:'1.21.1',mainClass:'net.minecraft.client.main.Main',arguments:{jvm:['-cp','${classpath}'],game:['--version','${version_name}']},libraries:[{name:'org.ow2.asm:asm:9.1'},{name:'org.lwjgl:lwjgl:3.3.3'}]};
const profile={id:'fabric-loader-0.20.1-1.21.1',inheritsFrom:'1.21.1',mainClass:'net.fabricmc.loader.impl.launch.knot.KnotClient',libraries:[{name:'net.fabricmc:fabric-loader:0.20.1',url:'https://maven.fabricmc.net/'},{name:'org.ow2.asm:asm:9.10.1',url:'https://maven.fabricmc.net/',sha1:'b'.repeat(40),size:100}],arguments:{jvm:['-Dfabric.fixture=1'],game:[]}};
test('Fabric survives catalog validation, revision and round trip; Forge is mutually exclusive',()=>{
 const catalog={schemaVersion:2,projects:{permadeath:{name:'Permadeath',minecraft:'1.21.1',fabric:'0.20.1',loader:'fabric',forge:''}}};
 const clean=validateCatalog(catalog);assert.equal(clean.projects.permadeath.fabric,'0.20.1');assert.equal(catalogRevision(clean),catalogRevision(catalog));
 assert.throws(()=>validateCatalog({projects:{p:{fabric:'0.20.1',forge:'47.4.28'}}}));assert.throws(()=>validateCatalog({projects:{p:{fabric:'../bad'}}}));
});
test('Fabric metadata merges official libraries, retains native libraries and reuses cache',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-metadata-'));let requests=0;
 const fetchImpl=async(url,options)=>{requests++;return options.method==='HEAD'?new Response(null,{headers:{'content-length':'123'}}):new Response(url.endsWith('.sha1')?'a'.repeat(40):JSON.stringify(profile));};
 try{const merged=await prepareFabricMetadata(base,'0.20.1',dir,{fetchImpl});assert.equal(merged.id,'1.21.1');assert.equal(merged.mainClass,profile.mainClass);assert.deepEqual(merged.arguments.jvm,['-cp','${classpath}','-Dfabric.fixture=1']);assert(!merged.libraries.some(lib=>lib.name==='org.ow2.asm:asm:9.1'));assert(merged.libraries.some(lib=>lib.name==='org.lwjgl:lwjgl:3.3.3'));assert.equal(merged.libraries.find(lib=>lib.name.startsWith('net.fabricmc:')).downloads.artifact.sha1,'a'.repeat(40));assert.deepEqual(await prepareFabricMetadata(base,'0.20.1',dir,{fetchImpl:()=>assert.fail('cached profile must be reused')}),merged);assert.equal(requests,3);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Fabric rejects wrong game versions, foreign Maven sources and invalid integrity',async()=>{
 for(const bad of [{...profile,inheritsFrom:'1.20.1'},{...profile,mainClass:'evil.Entry'},{...profile,libraries:[{name:'net.fabricmc:fabric-loader:0.20.1',url:'https://evil.invalid/'},profile.libraries[1]]}])await assert.rejects(fetchFabricProfile('1.21.1','0.20.1',{fetchImpl:async()=>new Response(JSON.stringify(bad))}));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fabric-invalid-'));try{await assert.rejects(prepareFabricMetadata(base,'0.20.1',dir,{fetchImpl:async(url,options)=>options.method==='HEAD'?new Response(null,{headers:{'content-length':'123'}}):new Response(url.endsWith('.sha1')?'bad':JSON.stringify(profile))}));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Fabric version selector uses the official game-specific results',async()=>{
 const rows=await listFabricVersions('1.21.1',{fetchImpl:async url=>{assert(url.endsWith('/1.21.1'));return new Response(JSON.stringify([{loader:{version:'0.20.1',stable:true}},{loader:{version:'../../bad'}}]));}});assert.deepEqual(rows,[{version:'0.20.1',stable:true}]);
});
