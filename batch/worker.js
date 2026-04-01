#!/usr/bin/env node
// SellerSignal Batch Worker — standalone process
// Runs nightly via Railway cron or on-demand
// Usage: node batch/worker.js [--zip 33134] [--market FL_MD] [--all] [--noai]

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { MARKETS, getAllZips, getMarketForZip } = require('./markets');

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const args = process.argv.slice(2);
let targetZip = null, targetMarket = null, runAll = false, skipAI = false;
for (let i = 0; i < args.length; i++) {
  if (args[i]==='--zip'&&args[i+1]) targetZip=args[++i];
  if (args[i]==='--market'&&args[i+1]) targetMarket=args[++i];
  if (args[i]==='--all') runAll=true;
  if (args[i]==='--noai') skipAI=true;
}
if (!targetZip && !targetMarket && !runAll) runAll = true;

function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

function parseFeature(f, market) {
  const a = f.attributes || {};
  const fm = market.fieldMap;
  function getVal(fd) { if(!fd)return null; if(Array.isArray(fd)){for(const ff of fd){const v=a[ff];if(v)return v;}return null;} return a[fd]??null; }
  function getStr(fd) { const v=getVal(fd); return v?String(v).trim():''; }
  function getNum(fd) { const v=getVal(fd); return v?parseFloat(v)||0:0; }

  let ownerName = Array.isArray(fm.ownerName)?fm.ownerName.map(ff=>(a[ff]||'').toString().trim()).filter(Boolean).join(' '):getStr(fm.ownerName);
  if (!ownerName||ownerName.length<3) return null;
  const address = getStr(fm.address);
  if (!address||address.length<3) return null;
  const on = ownerName.toUpperCase();
  if (/\bCITY OF\b|\bCOUNTY OF\b|\bSTATE OF\b|\bUNITED STATES\b|\bFEDERAL\b|\bSCHOOL DIST|\bCHURCH\b|\bHOA\b|\bCONDO\s*ASSOC/i.test(on)) return null;

  let ownerType='individual';
  if(/\bTRUST\b|\bTRSTEE?\b/.test(on))ownerType='trust';
  else if(/\bESTATE\b|\bHEIRS?\b|\bDECEASED\b/.test(on))ownerType='estate';
  else if(/\bLLC\b|\bCORP\b|\bINC\b|\bLTD\b|\bLP\b|\bPARTNERSHIP\b|\bHOLDINGS?\b|\bGROUP\b|\bPROPERTIES\b|\bINVESTMENTS?\b|\bMANAGEMENT\b|\bREALTY\b/.test(on))ownerType='llc_corp';

  const totalValue=getNum(fm.totalValue)||(getNum(fm.landValue)+getNum(fm.buildingValue));
  let buildingValue=getNum(fm.buildingValue); const landValue=getNum(fm.landValue);
  const yearBuilt=parseInt(getVal(fm.yearBuilt))||0; const sqft=parseInt(getVal(fm.livingSpace))||0;
  if(!buildingValue&&totalValue>0&&(yearBuilt>1800||sqft>0)) buildingValue=Math.round(totalValue*0.7);
  const hasBuilding=buildingValue>0||yearBuilt>1800||sqft>0;
  const isVacantLand=!hasBuilding&&totalValue>0;

  const mailAddr=getStr(fm.mailAddress); const mailState=getStr(fm.mailState);
  const situsNorm=address.toLowerCase().replace(/\s+/g,'');
  const mailNorm=mailAddr.toLowerCase().replace(/\s+/g,'');
  const isAbsentee=!!(mailAddr&&address&&situsNorm.length>5&&!mailNorm.includes(situsNorm.substring(0,Math.min(10,situsNorm.length))));
  const isOutOfState=!!(mailState&&mailState.toUpperCase()!==market.homeState);

  let lastTransferYear=null,lastTransferDate=null,salePrice=0;
  const rawDate=getVal(fm.saleDate);
  if(rawDate){const sd=String(rawDate);
    if(/^\d{8}$/.test(sd)){lastTransferYear=parseInt(sd.substring(0,4));lastTransferDate=sd.substring(0,4)+'-'+sd.substring(4,6)+'-'+sd.substring(6,8);}
    else if(/^\d{10,13}$/.test(sd)){const d=new Date(parseInt(sd.length>10?sd:sd+'000'));if(d.getFullYear()>1900){lastTransferYear=d.getFullYear();lastTransferDate=d.toISOString().substring(0,10);}}
    else{const d=new Date(sd);if(!isNaN(d)&&d.getFullYear()>1900){lastTransferYear=d.getFullYear();lastTransferDate=d.toISOString().substring(0,10);}}
  }
  salePrice=getNum(fm.salePrice);
  const tenureYears=lastTransferYear?new Date().getFullYear()-lastTransferYear:null;

  let lat=0,lng=0;
  if(f.geometry){if(f.geometry.x){lng=f.geometry.x;lat=f.geometry.y;}
    else if(f.geometry.rings&&f.geometry.rings[0]){const ring=f.geometry.rings[0];lat=ring.reduce((s,p)=>s+p[1],0)/ring.length;lng=ring.reduce((s,p)=>s+p[0],0)/ring.length;}}

  return { id:`${market.key}-${getStr(fm.id)||address.replace(/\s/g,'')}`, zip_code:null, market_key:market.key,
    owner_name:ownerName, owner_type:ownerType, address, city:getStr(fm.situsCity), state:market.homeState,
    lat, lng, assessed_value:Math.round(totalValue), building_value:Math.round(buildingValue), land_value:Math.round(landValue),
    year_built:yearBuilt||null, sqft:sqft||null, bedrooms:null, acres:null, subdivision:getStr(fm.subdivision),
    prop_type:isVacantLand?'Vacant Land':'Residential', is_vacant_land:isVacantLand,
    is_absentee:isAbsentee, is_out_of_state:isOutOfState, owner_state:mailState||null,
    mailing_address:mailAddr||null, mailing_city:getStr(fm.mailCity), mailing_state:mailState||null, mailing_zip:getStr(fm.mailZip),
    multi_count:1, last_transfer_year:lastTransferYear, last_transfer_date:lastTransferDate,
    sale_price:salePrice||null, tenure_years:tenureYears };
}

function scoreParcel(p, cal) {
  function c(d,k){if(!cal?.lifts?.[k])return d;const l=cal.lifts[k];return l>=1?Math.round(d*Math.min(l,3)):Math.round(-d*(1-l));}
  let sl=20;
  if(p.owner_type==='estate')sl+=c(20,'Estates / Heirs');
  if(p.owner_type==='trust'&&p.is_absentee)sl+=c(16,'Trusts');else if(p.owner_type==='trust')sl+=c(8,'Trusts');
  if(p.is_absentee&&p.is_out_of_state)sl+=c(14,'Out-of-State');else if(p.is_out_of_state)sl+=c(8,'Out-of-State');else if(p.is_absentee)sl+=c(6,'Absentee Owners');
  if(p.is_vacant_land)sl+=c(6,'Vacant Land');
  if(p.owner_type==='individual'&&p.mailing_address)sl+=c(4,'Named Individuals');
  if(p.tenure_years!==null){if(p.tenure_years<=1)sl-=15;else if(p.tenure_years<=2)sl-=10;else if(p.tenure_years<=3)sl-=5;
    else if(p.tenure_years<=10)sl+=c(10,'Tenure 3-10yr');else if(p.tenure_years<=20)sl+=c(8,'Tenure 10-20yr');else sl+=c(6,'Tenure 20yr+');}
  if(p.owner_type==='llc_corp'&&!p.is_absentee)sl-=5;
  if(p.is_vacant_land&&!p.tenure_years)sl-=6;
  sl=Math.max(0,Math.min(100,sl));
  let act=25,omr=20,conf=30;
  const hasName=(p.owner_name||'').length>3,hasMail=(p.mailing_address||'').length>5;
  if(hasName&&hasMail)act+=15;else if(hasName)act+=8;
  if(p.owner_type==='individual'&&hasName)act+=12;
  if(p.owner_type==='trust'||p.owner_type==='estate')omr+=12;
  if(p.is_absentee)omr+=10;if(p.assessed_value>750000)omr+=10;
  if(hasName)conf+=10;if(hasMail)conf+=8;if(p.assessed_value>0)conf+=6;if(p.tenure_years!==null)conf+=10;
  act=Math.max(0,Math.min(100,act));omr=Math.max(0,Math.min(100,omr));conf=Math.max(0,Math.min(100,conf));
  const br=Math.round(sl*0.50+act*0.30+omr*0.15+conf*0.05);
  let cohort='residential';if(p.owner_type==='estate')cohort='estate';else if(p.owner_type==='trust')cohort='trust';
  else if(p.owner_type==='llc_corp')cohort='investor';else if(p.is_absentee)cohort='absentee';
  return{seller_likelihood:sl,off_market_receptivity:omr,actionability:act,confidence:conf,briefing_rank:br,score_class:br>=55?'high':br>=35?'medium':'low',cohort};
}

async function processZip(zip, market) {
  const t0=Date.now();
  let pendingDS = [];
  log(`=== ${zip} — ${market.name} ===`);
  if(!market.zipWhere){log('  SKIP: needs spatial query');return null;}

  // Paginated fetch
  let allF=[],offset=0,go=true;log('  Fetching...');
  while(go){
    const params=new URLSearchParams({where:market.zipWhere(zip),outFields:market.fields,returnGeometry:'true',outSR:'4326',f:'json',resultRecordCount:'2000',resultOffset:String(offset)});
    const resp=await fetch(`${market.url}?${params}`,{signal:AbortSignal.timeout(90000)});
    const data=await resp.json();const features=data.features||[];allF=allF.concat(features);
    const capped=data.exceededTransferLimit===true||(features.length>0&&features.length>=1000&&features.length%1000===0);
    if(features.length===0||(!capped&&features.length<2000))go=false;
    else{offset+=features.length;log(`  ... ${allF.length}`);await new Promise(r=>setTimeout(r,500));}
    if(allF.length>=20000)go=false;
  }
  log(`  ${allF.length} features`);
  if(!allF.length)return null;

  const parcels=allF.map(f=>parseFeature(f,market)).filter(Boolean);
  for(const p of parcels)p.zip_code=zip;
  log(`  ${parcels.length} parcels`);

  const oc={};for(const p of parcels){const k=p.owner_name.toUpperCase().trim();oc[k]=(oc[k]||0)+1;}
  for(const p of parcels)p.multi_count=oc[p.owner_name.toUpperCase().trim()]||1;

  let scores=parcels.map(p=>scoreParcel(p,null));

  // Calibration
  const cut=new Date();cut.setFullYear(cut.getFullYear()-2);
  const scored=parcels.map((p,i)=>({...p,...scores[i]}));
  const sold=scored.filter(p=>p.last_transfer_date&&new Date(p.last_transfer_date)>=cut&&(p.sale_price>10000||!p.sale_price));
  let calibration=null;
  if(sold.length>=10){
    const br=sold.length/scored.length;
    function fr(fn){const pool=scored.filter(fn),s=sold.filter(fn);return pool.length>0?s.length/pool.length:0;}
    const lifts={};const rates={'All Properties':br,'Trusts':fr(p=>p.owner_type==='trust'),'Estates / Heirs':fr(p=>p.owner_type==='estate'),
      'LLCs / Corps':fr(p=>p.owner_type==='llc_corp'),'Absentee Owners':fr(p=>p.is_absentee),'Out-of-State':fr(p=>p.is_out_of_state),
      'Vacant Land':fr(p=>p.is_vacant_land),'Named Individuals':fr(p=>p.owner_type==='individual')};
    for(const[k,r]of Object.entries(rates))if(k!=='All Properties'&&br>0)lifts[k]=r/br;
    calibration={baseRate:br,lifts,rates,sold24:sold.length,total:scored.length};
    log(`  Cal: base=${(br*100).toFixed(1)}%, ${sold.length} sold`);
    scores=parcels.map(p=>scoreParcel(p,calibration));
  } else log(`  No cal (${sold.length} sales)`);

  let ranked=parcels.map((p,i)=>({p,s:scores[i]})).sort((a,b)=>b.s.briefing_rank-a.s.briefing_rank);

  // AI Lite
  if(!skipAI&&anthropic){
    const top=ranked.slice(0,25);
    try{
      log(`  AI scoring ${top.length}...`);
      const d=top.map((r,i)=>`[${i+1}] ${r.p.owner_name} — ${r.p.address}\n  ${r.p.owner_type} | $${(r.p.assessed_value||0).toLocaleString()} | Abs:${r.p.is_absentee?'Y':'N'} OOS:${r.p.is_out_of_state?'Y':'N'} | Ten:${r.p.tenure_years!=null?r.p.tenure_years+'yr':'?'} | Multi:${r.p.multi_count}`).join('\n\n');
      const p=anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:2000,messages:[{role:'user',content:`Score seller likelihood 0-100. ONLY JSON: [{"idx":1,"score":72,"headline":"..."}]\n\n${d}`}]});
      const r=await Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),60000))]);
      const arr=JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      let u=0;if(Array.isArray(arr))for(const a of arr){const i=(a.idx||a.index)-1;if(i>=0&&i<top.length&&a.score){top[i].s.lite_score=a.score;top[i].s.lite_headline=a.headline||'';u++;}}
      log(`  AI: ${u}/${top.length}`);
    }catch(e){log(`  AI failed: ${e.message}`);}
    ranked.sort((a,b)=>(b.s.lite_score||b.s.briefing_rank)-(a.s.lite_score||a.s.briefing_rank));
  }

  // Deep Signal
  if(!skipAI&&anthropic){
    const top=ranked.slice(0,5);
    try{
      log(`  Deep Signal ${top.length}...`);
      const d=top.map((r,i)=>`[${i+1}] ${r.p.owner_name} — ${r.p.address}, ${r.p.city||''} ${r.p.state||''}\n  ${r.p.owner_type} | $${(r.p.assessed_value||0).toLocaleString()} | Mail: ${r.p.mailing_address||'?'} ${r.p.mailing_state||''}\n  Tenure: ${r.p.tenure_years!=null?r.p.tenure_years+'yr':'?'} | AI: ${r.s.lite_score||'?'} ${r.s.lite_headline||''}`).join('\n\n');
      const p=anthropic.messages.create({model:'claude-sonnet-4-20250514',max_tokens:8000,messages:[{role:'user',content:`You are SellerSignal's Deep Signal engine. For each prospect, produce a DETAILED intelligence report. Scripts should be FULL PARAGRAPHS (4-6 sentences) that an agent can use verbatim.

Respond with ONLY a JSON array. Each entry:
{"idx":1,"motivation":"3-4 sentence analysis referencing specific data: tenure, mailing state, trust structure, portfolio.","timeline":"3-6 months","best_channel":"call|mail|door","call_script":"Full 4-6 sentence phone script. Reference property, owner situation, position yourself as problem solver, soft close.","mail_script":"Full 4-6 sentence letter. Professional, specific to their property and situation.","door_script":"Full 4-6 sentence door knock. Warm, specific, leave-behind offer.","what_not_to_say":"2-3 specific things to avoid and WHY for this owner type."}

PROSPECTS:
${d}`}]});
      const r=await Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),120000))]);
      const arr=JSON.parse((r.content?.[0]?.text||'').replace(/```json|```/g,'').trim());
      if(Array.isArray(arr)){const rows=[];for(const ds of arr){const i=(ds.idx||ds.index)-1;if(i>=0&&i<top.length)rows.push({parcel_id:top[i].p.id,zip_code:zip,report:ds,motivation:ds.motivation||null,timeline:ds.timeline||null,best_channel:ds.best_channel||null,call_script:ds.call_script||null,mail_script:ds.mail_script||null,door_script:ds.door_script||null,what_not_to_say:ds.what_not_to_say||null,generated_at:new Date().toISOString()});}
        if(rows.length){pendingDS=rows;log(`  DS: ${rows.length} generated (storing after parcels)`);}}
    }catch(e){log(`  DS failed: ${e.message}`);}
  }

  // Dedup + store
  const seen=new Set();const uP=parcels.filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true;});
  const seen2=new Set();const uR=ranked.filter(r=>{if(seen2.has(r.p.id))return false;seen2.add(r.p.id);return true;});
  if(uP.length<parcels.length)log(`  Dedup: ${parcels.length} → ${uP.length}`);

  for(let i=0;i<uP.length;i+=500){const b=uP.slice(i,i+500).map(p=>({id:p.id,zip_code:p.zip_code,market_key:p.market_key,owner_name:p.owner_name,owner_type:p.owner_type,address:p.address,city:p.city,state:p.state,lat:p.lat||null,lng:p.lng||null,assessed_value:p.assessed_value||null,building_value:p.building_value||null,land_value:p.land_value||null,year_built:p.year_built||null,sqft:p.sqft||null,bedrooms:p.bedrooms||null,acres:p.acres||null,subdivision:p.subdivision||null,prop_type:p.prop_type||'Residential',is_vacant_land:!!p.is_vacant_land,is_absentee:!!p.is_absentee,is_out_of_state:!!p.is_out_of_state,owner_state:p.owner_state||null,mailing_address:p.mailing_address||null,mailing_city:p.mailing_city||null,mailing_state:p.mailing_state||null,mailing_zip:p.mailing_zip||null,multi_count:p.multi_count||1,last_transfer_year:p.last_transfer_year||null,last_transfer_date:p.last_transfer_date||null,sale_price:p.sale_price||null,tenure_years:p.tenure_years,fetched_at:new Date().toISOString(),updated_at:new Date().toISOString()}));const{error}=await supabase.from('parcels').upsert(b,{onConflict:'id'});if(error)log(`  Parcel err: ${error.message}`);}
  for(let i=0;i<uR.length;i+=500){const b=uR.slice(i,i+500).map(r=>({parcel_id:r.p.id,zip_code:zip,market_key:market.key,seller_likelihood:r.s.seller_likelihood,off_market_receptivity:r.s.off_market_receptivity,actionability:r.s.actionability,confidence:r.s.confidence,briefing_rank:r.s.briefing_rank,score_class:r.s.score_class,cohort:r.s.cohort,calibrated_rank:r.s.briefing_rank,...(r.s.lite_score?{lite_score:r.s.lite_score,lite_headline:r.s.lite_headline||''}:{}),scored_at:new Date().toISOString()}));const{error}=await supabase.from('parcel_scores').upsert(b,{onConflict:'parcel_id'});if(error)log(`  Score err: ${error.message}`);}

  // Store deep signals AFTER parcels exist (foreign key)
  if(pendingDS.length>0){const dsM=new Map();for(const r of pendingDS)dsM.set(r.parcel_id,r);const dd=[...dsM.values()];const{error}=await supabase.from('deep_signals').upsert(dd,{onConflict:'parcel_id'});if(error)log(`  DS store err: ${error.message}`);else log(`  DS stored: ${dd.length}`);}

  const ac=uR.filter(r=>(r.s.lite_score||r.s.briefing_rank)>=55).length;
  await supabase.from('zip_briefings').upsert({zip_code:zip,market_key:market.key,market_name:market.name,total_parcels:parcels.length,unique_owners:new Set(parcels.map(p=>p.owner_name.toUpperCase())).size,act_today_count:ac,outreach_queue_count:uR.filter(r=>(r.s.lite_score||r.s.briefing_rank)>=35).length,act_today_ids:uR.filter(r=>(r.s.lite_score||r.s.briefing_rank)>=55).slice(0,15).map(r=>r.p.id),outreach_queue_ids:uR.filter(r=>(r.s.lite_score||r.s.briefing_rank)>=35).slice(0,50).map(r=>r.p.id),calibration:calibration||null,computed_at:new Date().toISOString(),computation_time_ms:Date.now()-t0},{onConflict:'zip_code'});

  log(`  DONE: ${uP.length} parcels, ${ac} act today, ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
  return{zip,parcels:uP.length,actToday:ac};
}

async function main() {
  if(!supabase){console.error('SUPABASE_URL + SUPABASE_SERVICE_KEY required');process.exit(1);}
  let zips=[];
  if(targetZip){const m=getMarketForZip(targetZip);if(!m){console.error('Unknown ZIP');process.exit(1);}zips=[{zip:targetZip,market:m}];}
  else if(targetMarket){const m=MARKETS[targetMarket];if(!m){console.error('Unknown market. Available: '+Object.keys(MARKETS).join(', '));process.exit(1);}zips=m.zips.map(z=>({zip:z,market:m}));}
  else zips=getAllZips().map(z=>({zip:z.zip,market:MARKETS[z.marketKey]}));

  log(`SellerSignal Batch — ${zips.length} ZIPs${skipAI?' (no AI)':' (AI + Deep Signal)'}`);
  const{data:run}=await supabase.from('batch_runs').insert({started_at:new Date().toISOString(),status:'running'}).select('id').single();
  let tP=0,tA=0,errs=[];
  for(const{zip,market}of zips){try{const r=await processZip(zip,market);if(r){tP+=r.parcels;tA+=r.actToday;}await new Promise(r=>setTimeout(r,1500));}catch(e){log(`  FAILED: ${zip} — ${e.message}`);errs.push({zip,error:e.message});}}
  if(run?.id)await supabase.from('batch_runs').update({completed_at:new Date().toISOString(),status:errs.length?'completed_with_errors':'completed',zips_processed:zips.length-errs.length,parcels_processed:tP,errors:errs.length?errs:null}).eq('id',run.id);
  log(`\n=== DONE: ${zips.length-errs.length}/${zips.length} ZIPs | ${tP.toLocaleString()} parcels | ${tA} act today ===`);
}

main().catch(e=>{console.error('Fatal:',e);process.exit(1);});
