import assert from 'node:assert/strict';
import {designSignatureOf,atlasFaceCacheKey,stableStringify,ensureAtlasBinding,atlasMatchesSignature,designFingerprint,fingerprintIsStale,ATLAS_CACHE_VERSION} from './design-binding.js';
import {createFaceArtworkCache} from './artwork-cache.js';
import {fitIsCurrent,invalidateFit,FIT_VERSION} from './face-fit.js';

const box=(overrides={})=>({shape:'classic',width:80,depth:60,height:45,thickness:.35,window:false,closure:'straight',...overrides});

// 1. Signature covers every geometry input that changes a face mapping.
const base=designSignatureOf(box());
assert.equal(base,designSignatureOf(box()),'identical boxes must share a signature');
for(const change of [{shape:'tuck'},{width:81},{depth:61},{height:46},{thickness:.6},{window:true},{closure:'tuck'}]){
 assert.notEqual(designSignatureOf(box(change)),base,`${Object.keys(change)[0]} must change the signature`);
}
// Non-geometric state is not part of the signature: repainting must reuse caches.
const artworkState={...box(),pattern:'dots',background:'#000000',accent:'#ffffff',step:2,activeFace:'left',paper:'a3'};
assert.equal(designSignatureOf(artworkState),base,'layer/UI state must not invalidate artwork caches');
// Non-finite input is normalised instead of producing a unique-per-call string.
assert.equal(designSignatureOf({...box(),width:undefined}),designSignatureOf({...box(),width:0}));

// 2. Cache key binds signature, manifest, face, size, map, crops and repair flag.
const req={signature:base,assetId:'a',manifestSignature:base,manifestWidth:4096,manifestHeight:2730,faceId:'front',width:640,height:480,widthMM:80,heightMM:45,map:[1,0,0,1,0,0],globalAdjustment:{x:0,y:0,scale:1,rotation:0},faceAdjustment:null,crop:{x:0,y:0,width:1,height:1},repairWhiteEdges:true};
const key=atlasFaceCacheKey(req);
assert.equal(key,atlasFaceCacheKey({...req}),'stable key for identical requests');
assert.equal(key,atlasFaceCacheKey({...req,map:[1,0,0,1,0,0],globalAdjustment:{rotation:0,scale:1,y:0,x:0}}),'key must not depend on object insertion order');
for(const change of [{signature:designSignatureOf(box({width:81}))},{manifestWidth:2048},{faceId:'back'},{width:641},{map:[1,0,0,1,0,1]},{crop:{x:.1,y:0,width:.9,height:1}},{repairWhiteEdges:false},{assetId:'b'}]){
 assert.notEqual(atlasFaceCacheKey({...req,...change}),key,`${Object.keys(change)[0]} must change the face cache key`);
}
assert(!key.includes('undefined'),'cache key must not embed undefined');
assert.equal(ATLAS_CACHE_VERSION,2);

// 3. The face cache only returns a canvas produced for the current signature.
const draws=[];
const cache=createFaceArtworkCache({createCanvas:()=>({width:1,height:1,getContext:()=>({clearRect(){}})}),repairEdgeArtwork:canvas=>({top:canvas.width})});
const entry={};
const first=cache.ensure(entry,req,ctx=>draws.push('A'));
assert.equal(first.hit,false);
const second=cache.ensure(entry,req,ctx=>draws.push('A2'));
assert.equal(second.hit,true,'same request must reuse the cached canvas');
assert.equal(draws.length,1,'identical signature must not recompute');
// A crop edit with the same box signature must recompute that face.
cache.ensure(entry,{...req,crop:{x:.2,y:0,width:.8,height:1}},ctx=>draws.push('crop'));
assert.equal(draws.length,2);
// Repainting with the same request again must hit without redrawing.
const repeat=cache.ensure(entry,{...req,crop:{x:.2,y:0,width:.8,height:1}},ctx=>draws.push('crop2'));
assert.equal(repeat.hit,true,'repeated draw under one signature must reuse the cache');
assert.equal(draws.length,2);
// Restoring the original crop is a different projection and recomputes.
cache.ensure(entry,req,()=>draws.push('A3'));
assert.equal(draws.length,3);
assert.equal(cache.ensure(entry,req,()=>draws.push('A4')).hit,true);
// Switching the box must drop the old canvas even though the face id repeats.
const boxB={...req,signature:designSignatureOf(box({shape:'tuck'}))};
const switched=cache.ensure(entry,boxB,ctx=>draws.push('B'));
assert.equal(switched.hit,false,'a new signature must invalidate the cached canvas');
assert.equal(draws.at(-1),'B');
assert.equal(entry.atlasSignature,boxB.signature);
assert.deepEqual(cache.inspect(entry,boxB),{hit:true,reason:'hit'});
assert.equal(cache.inspect(entry,req).hit,false,'old signature must not look current');
assert.ok(cache.stats.invalidations>=1);
assert.ok(cache.stats.hits>=2&&cache.stats.misses>=3);
// A forged entry whose signature disagrees with its canvas is treated as stale.
const forged={atlasCanvas:{width:req.width,height:req.height,getContext:()=>({clearRect(){}})},atlasKey:atlasFaceCacheKey(req),atlasSignature:boxB.signature};
assert.equal(cache.ensure(forged,req,()=>draws.push('C')).hit,false,'signature mismatch must never hit');

// 4. Async staleness: a result captured before a switch is rejected afterwards.
const before=designFingerprint(base,4);
assert(!fingerprintIsStale(before,designFingerprint(base,4)),'unchanged box keeps the result');
assert(fingerprintIsStale(before,designFingerprint(designSignatureOf(box({width:81})),4)),'signature change rejects');
assert(fingerprintIsStale(before,designFingerprint(base,5)),'A→B→A generation change rejects');

// 5. Atlas binding adopts a legacy manifest only when it describes this box.
const legacy={manifest:{signature:base}};
assert(ensureAtlasBinding(legacy,base));
assert.equal(legacy.signature,base);
assert(!ensureAtlasBinding({manifest:{signature:designSignatureOf(box({width:81}))}},base),'a foreign manifest must not be adopted');
// A torn atlas whose binding and manifest disagree is rejected even if one half
// matches the live box.
assert(!atlasMatchesSignature({signature:base,manifest:{signature:designSignatureOf(box({width:81}))}},base));
assert(!atlasMatchesSignature({signature:designSignatureOf(box({width:81})),manifest:{signature:base}},base));
assert(!ensureAtlasBinding({signature:base,manifest:{signature:designSignatureOf(box({width:81}))}},base),'a torn atlas is never adopted');
assert(!atlasMatchesSignature(null,base));

// 6. Fit state is bound to the atlas signature as well as the version.
const atlas={signature:base,manifest:{signature:base},fitVersion:FIT_VERSION,fitSignature:base,fitManifestSignature:base};
assert(fitIsCurrent(atlas),'a fit made for this signature is current');
atlas.fitSignature=undefined;atlas.fitManifestSignature=undefined;
assert(fitIsCurrent(atlas),'a legacy fit with no recorded signature stays valid for its manifest');
atlas.fitSignature=base;atlas.fitManifestSignature=base;
atlas.signature=designSignatureOf(box({width:81}));
assert(!fitIsCurrent(atlas),'a different signature invalidates the fit');
assert(invalidateFit(atlas)&&atlas.fitVersion===0);

// 7. stableStringify is order-independent and drops undefined payloads.
assert.equal(stableStringify({b:1,a:[2,3]}),stableStringify({a:[2,3],b:1}));
assert.equal(stableStringify(undefined),'null');

console.log('Design binding: signature scope, cache-key inputs, per-signature invalidation, async staleness, atlas and fit binding all pass.');
