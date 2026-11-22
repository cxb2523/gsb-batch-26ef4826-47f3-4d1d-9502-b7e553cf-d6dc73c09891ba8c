// Per-face artwork cache.
//
// The canvas that is handed to both the 3D material and the print renderer is
// built here. Every cached artifact is bound to a box signature, the manifest
// it was mapped from, and the exact crop/adjustment inputs. A cache lookup can
// therefore only succeed when the pixels were produced for the current box.
import {atlasFaceCacheKey} from './design-binding.js';

export const defaultCreateCanvas=()=>document.createElement('canvas');

export function createFaceArtworkCache({createCanvas=defaultCreateCanvas,repairEdgeArtwork=()=>null}={}){
 const stats={hits:0,misses:0,repairs:0,invalidations:0,rebuilds:0};
 function invalidate(entry){
  if(!entry)return false;
  const had=!!(entry.atlasCanvas||entry.atlasKey||entry.edgeRepair);
  entry.atlasCanvas=null;entry.atlasKey=null;entry.atlasSignature=null;entry.edgeRepair=null;entry.importCanvas=null;
  if(had)stats.invalidations++;
  return had;
 }
 // request fields:
 //   signature, assetId, manifestSignature, manifestWidth, manifestHeight,
 //   faceId, width, height, widthMM, heightMM, map, globalAdjustment,
 //   faceAdjustment, crop, repairWhiteEdges
 // draw(ctx, canvas) paints the mapped artwork into the fresh canvas.
 function ensure(entry,request,draw){
  if(!entry||typeof draw!=='function')throw Error('A face cache entry and a draw callback are required.');
  const key=atlasFaceCacheKey(request);
  // An entry carrying a different signature is provably stale even if the
  // key happens to collide; never let the old canvas survive a box change.
  if(entry.atlasSignature&&entry.atlasSignature!==request.signature)invalidate(entry);
  const canvas=entry.atlasCanvas;
  if(canvas&&entry.atlasKey===key&&entry.atlasSignature===request.signature&&canvas.width===request.width&&canvas.height===request.height){
   stats.hits++;return{canvas,key,hit:true,edgeRepair:entry.edgeRepair??null};
  }
  stats.misses++;stats.rebuilds++;
  const target=entry.atlasCanvas||(entry.atlasCanvas=createCanvas());
  if(target.width!==request.width||target.height!==request.height){target.width=request.width;target.height=request.height;}
  const ctx=target.getContext('2d',{willReadFrequently:true});
  ctx.clearRect(0,0,target.width,target.height);
  draw(ctx,target);
  entry.edgeRepair=request.repairWhiteEdges?repairEdgeArtwork(target,request.widthMM,request.heightMM):null;
  if(entry.edgeRepair)stats.repairs++;
  entry.atlasKey=key;entry.atlasSignature=request.signature;
  return{canvas:target,key,hit:false,edgeRepair:entry.edgeRepair};
 }
 function inspect(entry,request){
  if(!entry?.atlasCanvas)return{hit:false,reason:'empty'};
  if(entry.atlasSignature!==request.signature)return{hit:false,reason:'signature'};
  if(entry.atlasKey!==atlasFaceCacheKey(request))return{hit:false,reason:'key'};
  return{hit:true,reason:'hit'};
 }
 return{ensure,invalidate,inspect,stats};
}
