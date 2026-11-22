// A design belongs to exactly one box signature. Every cached face artifact —
// the mapped artwork canvas, its white-edge repair and the fit crops — is
// keyed through these helpers so a geometry change can never reuse pixels that
// were laid out for another box. Keep this module free of DOM and Three.js so
// the binding rules can be audited without a browser.
//
// The signature string itself stays byte-identical to the historical format so
// saved template maps keep matching; only the cache-key version advances.
export const ATLAS_CACHE_VERSION=2;

const finite=(value,fallback)=>{const n=+value;return Number.isFinite(n)?n:fallback;};

// Geometry that changes a panel mapping. Layer colours, patterns or the camera
// are deliberately absent: repainting those must reuse the mapped artwork.
export function designSignatureOf(config={}){
 return JSON.stringify([
  String(config.shape??''),
  finite(config.width,0),
  finite(config.depth,0),
  finite(config.height,0),
  finite(config.thickness,0),
  !!config.window,
  String(config.closure??'straight')
 ]);
}

// Strict binding: an atlas is usable only when every recorded signature agrees
// with the live box. A torn atlas (binding says one box, manifest another) is
// rejected rather than projected through the wrong face maps.
export function atlasMatchesSignature(atlas,signature){
 if(!atlas||signature==null)return false;
 const bound=atlas.signature!=null?atlas.signature:null;
 const mapped=atlas.manifest?.signature!=null?atlas.manifest.signature:null;
 if(bound==null&&mapped==null)return false;
 if(bound!=null&&bound!==signature)return false;
 if(mapped!=null&&mapped!==signature)return false;
 return true;
}
export function bindAtlasSignature(atlas,signature=atlas?.manifest?.signature){
 if(!atlas)return null;
 atlas.signature=signature??null;return atlas.signature;
}
// Adopt a legacy atlas that predates explicit binding, but only when its
// manifest already describes this box. Returns whether the atlas is usable.
export function ensureAtlasBinding(atlas,signature){
 if(!atlas)return false;
 if(atlas.signature==null&&atlas.manifest?.signature===signature)bindAtlasSignature(atlas,signature);
 return atlasMatchesSignature(atlas,signature);
}

// A fingerprint captured before an await. Comparing it afterwards rejects a
// result produced for a box that is no longer current, including A→B→A churn.
export function designFingerprint(signature,generation){return{signature,generation};}
export function fingerprintIsStale(captured,current){
 return !captured||!current||captured.signature!==current.signature||captured.generation!==current.generation;
}

// Insertion order can differ between a live object and one restored from JSON;
// a cache key must not change because of that.
export function stableStringify(value){
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(stableStringify).join(',')+']';
 return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableStringify(value[key])).join(',')+'}';
}

// The signature is part of the key even though the cached entry also records
// it: a key is then self-describing and provably stale without rerunning the
// mapping. Every input that can change mapped pixels is included.
export function atlasFaceCacheKey(entry){
 return stableStringify([
  ATLAS_CACHE_VERSION,
  entry.signature??null,
  entry.assetId??null,
  entry.manifestSignature??null,
  entry.manifestWidth??null,
  entry.manifestHeight??null,
  entry.faceId??null,
  entry.width??null,
  entry.height??null,
  entry.map??null,
  entry.globalAdjustment??null,
  entry.faceAdjustment??null,
  entry.crop??null,
  !!entry.repairWhiteEdges
 ]);
}
