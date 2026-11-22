import * as E from './engine.js';
import {createAtlas,exportTemplate,readArtworkFile,validateArtworkImage,buildTemplatePrompt} from './design-atlas.js';
import {panelBounds,FIT_VERSION} from './face-fit.js';
import {identityAdjustment} from './artwork-transform.js';
const $=id=>document.getElementById(id),s=E.state;
let hooks,initialized=false,uploadToken=0;
function fitAll(atlas=s.designAtlas){
 if(!atlas)return false;
 atlas.crops=Object.fromEntries(Object.keys(atlas.manifest.faces).filter(id=>!id.endsWith('Tab')).map(id=>[id,{...panelBounds(atlas.manifest,id),mode:'fit'}]));
 atlas.adjustments={global:identityAdjustment(),faces:{}};
 atlas.fitVersion=FIT_VERSION;atlas.fitSignature=atlas.signature??atlas.manifest?.signature??null;atlas.fitManifestSignature=atlas.manifest?.signature??null;
 return true;
}
export {fitAll};
export function mountLayoutTools(options){
 hooks=options;
 if(!initialized){initialized=true;const node=document.createElement('div');node.innerHTML=`<div id="netTools" class="net-tools" hidden><button id="downloadTemplate">Download template ↓</button><button id="openPrompt">Template & prompt ↗</button><button id="uploadLayout">Upload artwork ↗</button></div><input id="layoutFiles" type="file" accept="image/png,image/jpeg,image/webp" hidden><dialog id="templateDialog"><div class="dialog-head"><h2>Template & prompt</h2><button id="closeTemplate">Close ×</button></div><img id="templatePreview" class="template-preview" alt="Box template with panel directions"><button id="dialogDownload" class="primary">Download template PNG ↓</button><p>Attach this template, your logo and references in ChatGPT Images. Paste the prompt and add your wishes.</p><label class="field"><span>Your prompt · edit MY WISHES</span><textarea id="templatePrompt" rows="9" spellcheck="false"></textarea></label><details class="dimensions"><summary>Prompt options</summary><label class="check"><input id="promptCoordinates" type="checkbox"> Include exact panel coordinates</label></details><button id="copyTemplatePrompt">Copy prompt</button><p id="promptCopyStatus" role="status" class="microcopy"></p><button id="dialogUpload">Upload finished artwork ↗</button></dialog>`;while(node.firstChild)document.body.appendChild(node.firstChild);document.querySelector('.preview-card').insertBefore($('netTools'),document.querySelector('.stage-bottom'));
  const download=async()=>{try{await exportTemplate(hooks.persist);hooks.changed();hooks.toast('Template downloaded.');}catch(e){hooks.toast(e.message);}};
  $('downloadTemplate').onclick=$('dialogDownload').onclick=download;
  $('openPrompt').onclick=showTemplate;$('closeTemplate').onclick=()=>$('templateDialog').close();
  $('promptCoordinates').onchange=()=>{s.promptCoordinates=$('promptCoordinates').checked;$('templatePrompt').value=buildTemplatePrompt(createAtlas().manifest,$('templatePrompt').value,s.promptCoordinates);hooks.changed();};
  $('templatePrompt').onchange=()=>{s.templatePromptDraft=$('templatePrompt').value;hooks.changed();};
  $('copyTemplatePrompt').onclick=async()=>{const text=$('templatePrompt').value;s.templatePromptDraft=text;hooks.changed();try{await navigator.clipboard.writeText(text);$('promptCopyStatus').textContent='Prompt copied.';}catch{$('templatePrompt').focus();$('templatePrompt').select();$('promptCopyStatus').textContent='Press Ctrl+C to copy.';}};
  $('uploadLayout').onclick=pickArtwork;$('dialogUpload').onclick=()=>{$('templateDialog').close();pickArtwork();};
  $('layoutFiles').onchange=async e=>{const file=e.target.files[0];if(!file)return;const token=++uploadToken;try{hooks.toast('Loading artwork…');const artwork=await readArtworkFile(file);if(token!==uploadToken)return;const applied=await applyArtwork(artwork,()=>token===uploadToken);if(!applied||token!==uploadToken)return;hooks.setView('box');hooks.render();hooks.toast('Artwork ready to print.');}catch(error){if(token===uploadToken)hooks.toast(error.message);}finally{e.target.value='';}};
 }
 $('openTemplate')?.addEventListener('click',showTemplate);$('panelUpload')?.addEventListener('click',pickArtwork);
 $('fitArtworkAll')?.addEventListener('click',()=>{if(!fitAll())return;hooks.changed();hooks.render();hooks.toast('All faces fitted.');});
}
function pickArtwork(){$('layoutFiles').value='';$('layoutFiles').click();}
function showTemplate(){const a=createAtlas(),c=document.createElement('canvas');c.width=1000;c.height=Math.round(1000*a.template.height/a.template.width);c.getContext('2d').drawImage(a.template,0,0,c.width,c.height);$('templatePreview').src=c.toDataURL();$('templatePrompt').value=buildTemplatePrompt(a.manifest,s.templatePromptDraft,s.promptCoordinates);$('promptCoordinates').checked=!!s.promptCoordinates;$('promptCopyStatus').textContent='';$('templateDialog').showModal();}
export function syncNetTools(net){if($('netTools'))$('netTools').hidden=!net;}
// Every await below is bracketed by a fingerprint check. A box change during
// load (or a second upload racing this one) leaves the newer state untouched.
export async function applyArtwork(p,stillCurrent=()=>true){
 if(!p||p.manifest.signature!==E.designSignature())throw Error('Use artwork for the current box shape and size.');
 const started=E.designFingerprintNow();
 // readArtworkFile may already have decoded the image; reuse it rather than
 // decoding the same data URL twice.
 const image=p.image||await E.loadImage(p.src);
 validateArtworkImage(image,p.manifest);
 // No await remains below: the asset and atlas are committed atomically against
 // the generation captured before the first await, so a box change during load
 // cannot let this result overwrite the newer box. The token also rejects a
 // superseded upload that was replaced by a newer one mid-flight.
 if(E.designFingerprintIsStale(started)||p.manifest.signature!==E.designSignature()||!stillCurrent())throw Error('The box changed while loading. Upload artwork for the current box.');
 const a=hooks.addAssetFromImage(image,p.src,p.name,'layout',p.manifest.signature);
 const atlas={assetId:a.id,manifest:p.manifest,signature:p.manifest.signature,repairWhiteEdges:true,fitVersion:FIT_VERSION,fitSignature:p.manifest.signature,fitManifestSignature:p.manifest.signature};
 fitAll(atlas);
 s.designAtlas=atlas;s.lastDesignManifest=p.manifest;s.faces={};s.pattern='none';s.character='none';s.style='signature';s.advanced=false;s.simpleMode=true;s.step=2;s.undoDesign=null;hooks.changed();return true;
}
