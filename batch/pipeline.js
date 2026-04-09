// SellerSignal Pipeline — extracted from sellersignal-briefing.html
// This is the EXACT same code that runs in the browser.
// The batch worker imports this to get identical parsing, scoring, and enrichment.

// ========================
// HELPERS
// ========================

function cleanOwnerName(raw) {
    if (!raw) return '';
    let o = raw.trim();
    o = o.replace(/\bC\/?O\b.*/i, '').trim();
    o = o.replace(/\bATTN\b.*/i, '').trim();
    o = o.replace(/\bCARE OF\b.*/i, '').trim();
    o = o.replace(/\bTAX\s*PROPERTY\b/i, '').trim();
    o = o.replace(/\bCURRENT\s*RESIDENT\b/i, '').trim();
    o = o.replace(/\bOCCUPANT\b/i, '').trim();
    o = o.replace(/\bPROPERTY\s*OWNER\b/i, '').trim();
    o = o.replace(/[,.\-;:'"!?]+$/, '').trim();
    if (o.length < 3 || /^[A-Z]{1,2}$|^\d+$|^UNKNOWN$/i.test(o)) o = '';
    return o;
}

function parseNumericValue(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return v;
    return parseInt(String(v).replace(/[^0-9.-]/g, '')) || 0;
}

function extractLatLng(feature, cfg) {
    const a = feature.attributes || {};
    if (cfg.latField && a[cfg.latField] && a[cfg.lngField]) {
        return { lat: parseFloat(a[cfg.latField]) || 0, lng: parseFloat(a[cfg.lngField]) || 0 };
    }
    if (feature.centroid) {
        return { lat: feature.centroid.y || 0, lng: feature.centroid.x || 0 };
    }
    if (feature.geometry && typeof feature.geometry.x === 'number' && typeof feature.geometry.y === 'number') {
        return { lat: feature.geometry.y, lng: feature.geometry.x };
    }
    if (feature.geometry?.rings?.[0]?.length) {
        const r = feature.geometry.rings[0];
        return {
            lng: r.reduce((s,p) => s + p[0], 0) / r.length,
            lat: r.reduce((s,p) => s + p[1], 0) / r.length
        };
    }
    return { lat: 0, lng: 0 };
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

function latlngToMerc(lat,lng){const x=lng*20037508.34/180;const y=Math.log(Math.tan((90+lat)*Math.PI/360))/(Math.PI/180)*20037508.34/180;return{x,y}}

// ========================
// PROPERTY TYPE CLASSIFIER
// ========================

function classifyPropType(a, cfg) {
    const rules = cfg.propTypeRules;
    if (!rules || rules.style === 'none') return { propType: 'Residential', isExempt: false, isVacant: false, isCommercial: false };
    
    let propType = 'Residential', isExempt = false, isVacant = false, isCommercial = false;
    
    if (rules.style === 'puc') {
        const code = String(a[rules.field] || '');
        isExempt = (rules.exempt || []).some(p => code.startsWith(p));
        isCommercial = (rules.commercial || []).some(p => code.startsWith(p));
        isVacant = (rules.vacant || []).some(p => code.startsWith(p));
        const isMulti = (rules.multiFamily || []).some(p => code.startsWith(p));
        propType = isExempt ? 'Exempt' : isCommercial ? 'Commercial' : isVacant ? 'Vacant Land' : isMulti ? 'Multi-Family' : 'Residential';
    } else if (rules.style === 'class') {
        const code = String(a[rules.field] || '');
        isExempt = (rules.exempt || []).some(p => code.startsWith(p));
        isCommercial = (rules.commercial || []).some(p => code.startsWith(p));
        isVacant = (rules.vacant || []).some(p => code.startsWith(p));
        const isMulti = (rules.multiFamily || []).some(p => code.startsWith(p));
        propType = isExempt ? 'Exempt' : isCommercial ? 'Commercial' : isVacant ? 'Vacant Land' : isMulti ? 'Multi-Family' : 'Residential';
    } else if (rules.style === 'string') {
        const val = (a[rules.field] || '').toLowerCase();
        isExempt = (rules.exempt || []).some(p => val.includes(p.toLowerCase()));
        isCommercial = (rules.commercial || []).some(p => val.includes(p.toLowerCase()));
        isVacant = (rules.vacant || []).some(p => val.includes(p.toLowerCase()));
        propType = isExempt ? 'Exempt' : isCommercial ? 'Commercial' : isVacant ? 'Vacant Land' : 'Residential';
    } else if (rules.style === 'regex') {
        const val = a[rules.field] || '';
        isExempt = rules.exemptRx ? rules.exemptRx.test(val) : false;
        isCommercial = rules.commercialRx ? rules.commercialRx.test(val) : false;
        isVacant = rules.vacantRx ? rules.vacantRx.test(val) : false;
        propType = isExempt ? 'Exempt' : isCommercial ? 'Commercial' : isVacant ? 'Vacant Land' : 'Residential';
    }
    
    // Normalize raw propType strings to standard categories
    const pt = propType.toLowerCase();
    if (/single.?family|sfr|1\s*unit|detached|improved|bungalow|ranch|colonial|cape\s*cod|split\s*level/i.test(pt)) propType = 'Residential';
    else if (/condo|condominium|cooperative|co-op/i.test(pt)) propType = 'Condo';
    else if (/town\s*h|row\s*h|attached/i.test(pt)) propType = 'Townhouse';
    else if (/multi|duplex|triplex|quad|apartment|2.?unit|3.?unit|4.?unit/i.test(pt)) propType = 'Multi-Family';
    else if (/mobile|manufactured/i.test(pt)) propType = 'Mobile Home';
    else if (/vacant|undeveloped|unimproved/i.test(pt)) propType = 'Vacant Land';
    else if (/commercial|office|retail|store|warehouse|industrial/i.test(pt)) propType = 'Commercial';
    else if (/exempt|government|municipal|school|church/i.test(pt)) propType = 'Exempt';
    else if (/agri|farm|ranch|timber/i.test(pt) && !isVacant) propType = 'Agricultural';
    // If still not matched but has building value, it's residential
    
    return { propType, isExempt, isVacant, isCommercial };
}

// ========================
// PARCEL PARSER — universal, handles all markets
// ========================

function parseParcel(feature, cfg) {
    const a = feature.attributes || {};
    const fm = cfg.fieldMap;
    
    let ownerName = '';
    if (fm.ownerName) {
        const fields = Array.isArray(fm.ownerName) ? fm.ownerName : [fm.ownerName];
        for (const f of fields) {
            const v = (a[f] || '').trim();
            if (v && v.length > 2) { ownerName = v; break; }
        }
    }
    ownerName = cleanOwnerName(ownerName);
    
    const id = a[fm.id] || null;
    
    let address = '';
    if (fm.address) {
        if (Array.isArray(fm.address)) {
            address = fm.address.map(f => (a[f] || '').trim()).filter(Boolean).join(' ');
        } else {
            address = (a[fm.address] || '').trim();
        }
    }
    
    let cityStateZip = '';
    if (fm.cityStateZip) {
        cityStateZip = (a[fm.cityStateZip] || '').trim();
    } else {
        const city = a[fm.situsCity] || cfg.defaultCity || '';
        const st = cfg.homeState || '';
        const zip = a[fm.situsZip] || '';
        cityStateZip = `${city}, ${st} ${zip}`.trim();
    }
    
    const getVal = (fieldSpec) => {
        if (!fieldSpec) return 0;
        const fields = Array.isArray(fieldSpec) ? fieldSpec : [fieldSpec];
        for (const f of fields) { const v = parseNumericValue(a[f]); if (v) return v; }
        return 0;
    };
    const totalValue = getVal(fm.totalValue) || (getVal(fm.landValue) + getVal(fm.buildingValue));
    const buildingValue = getVal(fm.buildingValue);
    const landValue = getVal(fm.landValue);
    
    let ownerAddress = '';
    if (fm.mailAddress) {
        ownerAddress = (a[fm.mailAddress] || '').trim();
        if (fm.mailCity && a[fm.mailCity]) ownerAddress += (ownerAddress ? ', ' : '') + (a[fm.mailCity] || '').trim();
        if (fm.mailState && a[fm.mailState]) ownerAddress += ' ' + (a[fm.mailState] || '').trim();
    }
    const ownerCity = fm.mailCity ? (a[fm.mailCity] || '').trim() : '';
    const ownerState = fm.mailState ? (a[fm.mailState] || '').trim() : '';
    const ownerZip = fm.mailZip ? (a[fm.mailZip] || '').trim() : '';
    
    const ptResult = classifyPropType(a, cfg);
    
    const hasBuilding = buildingValue > 0 || (fm.yearBuilt && a[fm.yearBuilt]) || (fm.livingSpace && parseNumericValue(a[fm.livingSpace]) > 0);
    const isVacant = ptResult.isVacant || (!hasBuilding && totalValue > 0 && !ptResult.isCommercial && !ptResult.isExempt && !ptResult.isResidential);
    
    const { lat, lng } = extractLatLng(feature, cfg);
    
    let acres = 0;
    if (fm.acres) {
        const rawAcres = parseNumericValue(a[fm.acres]);
        acres = cfg.acresIsSqft ? Math.round(rawAcres / 43560 * 100) / 100 : rawAcres;
    }
    
    let lastTransferYear = null, lastTransferDate = null, salePrice = 0;
    if (fm.deedDate && a[fm.deedDate]) {
        const raw = a[fm.deedDate];
        if (typeof raw === 'number' && raw > 0) {
            const d = new Date(raw);
            if (d.getFullYear() > 1900) { lastTransferYear = d.getFullYear(); lastTransferDate = d.toISOString().split('T')[0]; }
        } else if (typeof raw === 'string' && raw.includes('/')) {
            const parts = raw.split('/');
            if (parts.length === 3) { const yr = parseInt(parts[2]); if (yr > 1900) { lastTransferYear = yr; lastTransferDate = raw; } }
        }
    }
    if (!lastTransferYear && fm.saleDate && a[fm.saleDate]) {
        const raw = a[fm.saleDate];
        if (typeof raw === 'number' && raw > 0) {
            const d = new Date(raw);
            if (d.getFullYear() > 1900) { lastTransferYear = d.getFullYear(); lastTransferDate = d.toISOString().split('T')[0]; }
        } else if (typeof raw === 'string' && raw.includes('/')) {
            const parts = raw.split('/');
            if (parts.length === 3) { const yr = parseInt(parts[2]); if (yr > 1900) { lastTransferYear = yr; lastTransferDate = raw; } }
        }
    }
    if (fm.salePrice) salePrice = parseNumericValue(a[fm.salePrice]);
    
    const yearBuilt = fm.yearBuilt ? (parseInt(a[fm.yearBuilt]) || null) : null;
    const sqft = fm.livingSpace ? parseNumericValue(a[fm.livingSpace]) : (fm.sqft ? parseNumericValue(a[fm.sqft]) : 0);
    
    const situsNorm = (address || '').toUpperCase().replace(/\s+/g, '').substring(0, 20);
    const mailNorm = (ownerAddress || '').toUpperCase().replace(/\s+/g, '').substring(0, 20);
    let isAbsentee = ownerAddress.length > 5 && address.length > 5 && situsNorm !== mailNorm && !mailNorm.includes(situsNorm.substring(0, 10));
    const isOutOfState = ownerState && cfg.homeState && ownerState.toUpperCase() !== cfg.homeState.toUpperCase();

    // PO BOX OVERRIDE: an owner using a PO Box in the SAME 3-digit ZIP prefix as the
    // situs property is almost certainly a local resident using a PO Box for mail
    // privacy, not a true absentee. The 3-digit ZIP prefix is the postal sectional
    // center, which means same-region delivery — typically within 30-50 miles of
    // the property. Override the isAbsentee flag to false in this case so the
    // cohort classifier doesn't bucket them as absentee owners.
    const hasPoBox = /\bP\.?O\.?\s*BOX\b/i.test(ownerAddress);
    const situsZipRaw = (a[fm.situsZip] || '').toString().substring(0, 3);
    const ownerZipRaw = (ownerZip || '').toString().substring(0, 3);
    const samePoBoxRegion = hasPoBox && situsZipRaw && ownerZipRaw && situsZipRaw === ownerZipRaw;
    if (samePoBoxRegion && !isOutOfState) {
        isAbsentee = false;
    }

    const subdivision = fm.subdivision ? (a[fm.subdivision] || '').trim() : '';
    const inCareOf = fm.inCareOf ? (a[fm.inCareOf] || '').trim() : '';

    // QUIT CLAIM FLAG: extracted if the market field map declares a deedType source.
    // Detection looks for "QUIT" or "QC" anywhere in the deed/instrument type string.
    // Returns false if the field isn't mapped for this market — graceful degradation
    // until each market's parser audit adds the field.
    let quitClaimFlag = false;
    if (fm.deedType && a[fm.deedType]) {
        const dt = String(a[fm.deedType]).toUpperCase();
        quitClaimFlag = /\bQUIT\b|\bQUITCLAIM\b|\bQ\.?C\.?\b/.test(dt);
    }

    // SOURCE PUBLICATION DATE: when the underlying county feed was last refreshed
    // for this parcel. Some ArcGIS feeds expose this as EditDate, LAST_UPDATE,
    // ModDate, or similar. Extracted only if the market field map declares the
    // source field. Stored as ISO date string for display in the UI freshness badge.
    let sourceModifiedDate = null;
    if (fm.sourceModified && a[fm.sourceModified]) {
        const raw = a[fm.sourceModified];
        if (typeof raw === 'number' && raw > 0) {
            const d = new Date(raw);
            if (d.getFullYear() > 2000) sourceModifiedDate = d.toISOString().split('T')[0];
        } else if (typeof raw === 'string' && raw.length >= 8) {
            sourceModifiedDate = raw.substring(0, 10);
        }
    }
    
    return {
        id: id || `${cfg.key}-${address.replace(/\s/g, '')}-${ownerName.substring(0, 10)}`,
        ownerName, address, cityStateZip,
        totalValue, buildingValue, landValue,
        propType: ptResult.propType, acres, subdivision,
        ownerAddress, ownerCity, ownerState, ownerZip,
        exempt: ptResult.isExempt,
        lat, lng,
        isAbsentee, isOutOfState, isVacantLand: isVacant,
        hasBuildingValue: hasBuilding,
        lastTransferYear, lastTransferDate, salePrice,
        yearBuilt, sqft, inCareOf, multiCount: 1,
        // New ATTOM-style fields (graceful degradation when source field absent)
        quitClaimFlag, sourceModifiedDate
    };
}

// ========================
// CALIBRATION
// ========================

function calibrate(defaultBonus, featureKey, cal) {
    if (!cal || !cal.lifts || !(featureKey in cal.lifts)) return defaultBonus;
    const lift = cal.lifts[featureKey];
    // Below base rate — penalize
    if (lift <= 0) return -defaultBonus;
    if (lift < 1) return Math.round(-defaultBonus * (1 - lift));
    // Within noise of base rate — no predictive value, no bonus
    if (lift <= 1.15) return 0;
    // Above base rate — scale bonus by excess over 1.0
    // lift 1.3x = 0.3 * default (modest), 2.0x = 1.0 * default (full), 8.0x = 2.5 * default (capped)
    const excess = Math.min(lift - 1, 2.5);
    return Math.round(defaultBonus * excess);
}

function precomputeStats(parcels) {
    const valid = parcels.filter(x => x.totalValue > 0 && !x.exempt);
    const values = valid.map(x => x.totalValue).sort((a,b) => a-b);
    const p75Value = values[Math.floor(values.length * 0.75)] || 0;
    const ownerCounts = {};
    for (const p of valid) {
        if (p.ownerName && p.ownerName.length > 3) {
            const key = p.ownerName.toUpperCase().trim();
            ownerCounts[key] = (ownerCounts[key] || 0) + 1;
        }
    }
    return { p75Value, ownerCounts };
}

// ========================
// SCORER — the full model from the briefing HTML
// ========================

function scoreParcel(p, stats, cal) {
    const { p75Value, ownerCounts } = stats;
    const signals = [];
    
    if (p.exempt) return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[],cohort:'residential',cohortLabel:'Residential'};

    // OVERSIZED-VALUE GUARDRAIL: any property assessed above $25M is functionally
    // never a single-family residence. Bel Air mansions top out around $150M and
    // there are five of them in the entire country. A $25M+ "house" in any market
    // outside of Beverly Hills, Bel Air, Greenwich CT, or Aspen CO is overwhelmingly
    // likely to be a misclassified apartment building, hotel, office, or institutional
    // holding. The previous heuristic gave these maximum scores because the value-based
    // luxury bonus stacked on top of out-of-state-absentee bonuses, putting commercial
    // multi-family at the top of residential prospect lists. Catches AMLI Bellevue
    // Park, downtown Seattle apartment towers, hotel REITs, and similar.
    if (p.totalValue && p.totalValue > 25000000) {
        return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[{text:'Oversized value (>$25M) — likely commercial/institutional',type:'negative'}],cohort:'commercial',cohortLabel:'Commercial / Institutional'};
    }

    // COMMERCIAL PROPERTY TYPE GUARDRAIL: if the assessor's property type field
    // already classified this as commercial, exclude from residential scoring.
    // Previously the propType label was set but never used as a filter, so
    // commercial parcels still ran through the full scorer.
    if (p.propType === 'Commercial') {
        return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[{text:'Commercial property — not a residential lead',type:'negative'}],cohort:'commercial',cohortLabel:'Commercial'};
    }

    // PROPERTY TAX AGENT GUARDRAIL: certain firms appear as "owner" on assessor
    // records but are actually tax agents acting on behalf of institutional owners.
    // KE Andrews (Texas) handles AMLI Residential, Equity Residential, and many
    // others. Marvin F Poer, Ryan LLC, Altus Group, Duff & Phelps, True Partners,
    // Paradigm Tax, and Property Tax Advisors all do similar work. They have
    // person-like names (KE Andrews looks like "Ke Andrews", a name) so they slip
    // past the LLC/Corp/Inc entity detection. Excluding them by name is the only
    // reliable way to filter. List sourced from public commercial real estate
    // tax agent registries.
    const onAgent = (p.ownerName || '').toUpperCase();
    const taxAgentRx = /\b(K\.?E\.?\s*ANDREWS|MARVIN\s*F\s*POER|RYAN\s*LLC|RYAN\s*PROPERTY\s*TAX|ALTUS\s*GROUP|DUFF\s*&?\s*PHELPS|TRUE\s*PARTNERS|PARADIGM\s*TAX|PROPERTY\s*TAX\s*ADVISORS|PADDOCK\s*&?\s*PARSONS|MORRIS\s*MANNING|BRUSNIAK\s*BLACKWELL|POPP\s*HUTCHESON|GUNTER\s*BENNETT)\b/i;
    if (taxAgentRx.test(onAgent)) {
        return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[{text:'Property tax agent (not actual owner)',type:'negative'}],cohort:'commercial',cohortLabel:'Tax Agent / Institutional'};
    }

    // REO PRE-CHECK: Fannie Mae, Freddie Mac, HUD, etc. would otherwise be caught
    // by the FEDERAL keyword in govRx and early-exited as "institutional" with
    // score 0. We need to detect these as REO BEFORE the gov check fires so they
    // get the high seller_likelihood boost they deserve. Same regex used later
    // in the main entity classification block.
    const onPre = (p.ownerName || '').toUpperCase();
    const reoGovRxPre = /\b(FANNIE\s*MAE|FEDERAL\s*NATIONAL\s*MORTGAGE|FREDDIE\s*MAC|FEDERAL\s*HOME\s*LOAN\s*MORTGAGE|GINNIE\s*MAE|HUD\b|SECRETARY\s*OF\s*HOUSING|SECRETARY\s*OF\s*VETERANS|VETERANS\s*AFFAIRS|USDA\s*RURAL)\b/i;
    const isReoPreCheck = reoGovRxPre.test(onPre);

    const govRx = /\bUSA\b|\bCITY OF\b|\bTOWN OF\b|\bVILLAGE OF\b|\bBOROUGH OF\b|\bCOUNTY OF\b|\bSTATE OF\b|\bUNITED STATES\b|\bFEDERAL\b|\bMUNICIPAL\b|\bSCHOOL DIST|\bSCHOOL\b|\bACADEMY\b|\bSEMINARY\b|\bFIRE DIST|\bWATER DIST|\bSEWER\b|\bHOUSING AUTH|\bCHURCH\b|\bDIOCESE\b|\bMINISTR(Y|IES)\b|\bPARISH\b|\bMONASTER|\bCONVENT\b|\bARCHDIOCESE\b|\bCONGREGATION\b|\bSISTERS OF\b|\bBROTHERS OF\b|\bORDER OF\b|\bFRIARS\b|\bABBEY\b|\bPRIORY\b|\bSYNAGOGUE\b|\bTEMPLE\b|\bMOSQUE\b|\bHOA\b|\bHOMEOWNERS?\s*ASS|\bCOMMON\s*AREA|\bMUSEUM\b|\bCONDO\s*MASTER|\bCONDO\s*ASSOC|\bCONDOMINIUM\s*ASS|\bPARK\s*AREA|\bOWNERS?\s*ASSOC|\bPROPERTY\s*OWNERS|\bMASTER\s*ASSOC|\bCOMMUNITY\s*ASSOC|\bNEIGHBORHOOD\s*ASSOC|\bIRRIGATION|\bCEMETERY|\bLIBRARY|\bFOUNDATION\b|\bUNIVERSIT(Y|IES)\b|\bCOLLEGE\b|\bHOSPITAL\b|\bHEALTH(CARE)?\s*(SYSTEM|INC|CORP|GROUP|CENTER|CENTRE)\b|\bMEDICAL\s*CENTER\b|\bYMCA\b|\bYWCA\b|\bBOY\s*SCOUT|\bGIRL\s*SCOUT|\bROTARY\b|\bLIONS\s*CLUB|\bELKS\b|\bMOOSE\s*LODGE|\bVFW\b|\bAMERICAN\s*LEGION|\bSALVATION\s*ARMY|\bGOODWILL\b|\bHABITAT\b|\bRED\s*CROSS|\bBOYS\s*(AND|&)\s*GIRLS|\bDAV\b|\bKIWANIS\b|\bSHRINERS\b|\bODD\s*FELLOWS|\bKNIGHTS\s*OF|\bMONTANA STATE\b|\bSUB\s+[A-Z]/i;
    if (p.ownerName && govRx.test(p.ownerName) && !isReoPreCheck) return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[{text:'Government/institutional',type:'negative'}],cohort:'residential',cohortLabel:'Institutional'};
    
    const on = (p.ownerName || '').toUpperCase();
    if (!p.address && (!on || on.length < 4)) return {sellerLikelihood:0,offMarketReceptivity:0,actionability:0,confidence:0,briefingRank:0,scoreClass:'low',signals:[],cohort:'residential',cohortLabel:'Unknown'};

    const pa = (p.address||'').toLowerCase().replace(/\s+/g,'');
    const oa = (p.ownerAddress||'').toLowerCase().replace(/\s+/g,'');
    const isAbsentee = p.isAbsentee || p.mailDiffers || (oa && pa && pa.length > 5 && !oa.includes(pa.substring(0, Math.min(10, pa.length))));
    const isOutOfState = p.isOutOfState;
    const pt = (p.propType || '').toLowerCase();
    const isVacant = pt.includes('vacant') || pt.includes('land') || (p.totalValue > 0 && p.buildingValue === 0);
    const landHeavy = p.totalValue > 0 && p.landValue > 0 && p.buildingValue > 0 && (p.landValue / p.totalValue) > 0.6;
    const isHighValue = p.totalValue > 0 && p75Value > 0 && p.totalValue > p75Value;
    const isLuxury = !isVacant && p.totalValue > 750000 && p75Value > 0 && p.totalValue > p75Value * 1.5;
    const hasMailingAddr = p.ownerAddress && p.ownerAddress.length > 5;
    const hasOwnerName = on && on.length > 3;
    
    const isLLC = /\bLLC\b|\bCORP\b|\bINC\b|\bPARTNERSHIP\b|\bHOLDINGS\b|\bPROPERTIES\b|\bINVESTMENTS\b|\bGROUP\b|\bREALTY\b|\bMANAGEMENT\b/i.test(on);
    const isTrust = /\bTRUST\b/i.test(on);
    const isEstate = /\bESTATE\b/i.test(on);
    const isHeirs = /\bHEIRS\b|\bDECEASED\b|\bSURVIVOR\b/i.test(on);
    const isRanch = /\bRANCH\b|\bFARM\b/i.test(on);
    const isEntity = isLLC || isTrust || isEstate || isHeirs || isRanch;
    const isCorporateOpaque = isLLC && !isTrust && !isEstate && !isHeirs && !isRanch;

    // REO / BANK-OWNED DETECTION
    // Two-bucket approach to keep false positives low:
    //   1. Unambiguous government / GSE / federal mortgage agencies — always REO
    //   2. Major banks WITHOUT a "TRUSTEE" qualifier — REO only if not in
    //      mortgage-backed-security trustee capacity (those are securitization
    //      vehicles, not foreclosed inventory)
    // Plus a third bucket for known servicers that frequently hold REO during
    // disposition cycles.
    const reoGovRx = /\b(FANNIE\s*MAE|FEDERAL\s*NATIONAL\s*MORTGAGE|FREDDIE\s*MAC|FEDERAL\s*HOME\s*LOAN\s*MORTGAGE|GINNIE\s*MAE|HUD\b|SECRETARY\s*OF\s*HOUSING|SECRETARY\s*OF\s*VETERANS|VETERANS\s*AFFAIRS|USDA\s*RURAL)\b/i;
    const reoBankRx = /\b(BANK\s*OF\s*AMERICA|WELLS\s*FARGO|JPMORGAN|JP\s*MORGAN|CHASE\s*BANK|US\s*BANK\s*N|CITIBANK|HSBC\s*BANK|DEUTSCHE\s*BANK|WILMINGTON\s*(SAVINGS|TRUST)|BANK\s*OF\s*NEW\s*YORK)\b/i;
    const reoServicerRx = /\b(MTGLQ\s*INVESTORS|NATIONSTAR|MR\.?\s*COOPER|RUSHMORE\s*LOAN|SHELLPOINT|SPECIALIZED\s*LOAN\s*SERVICING|CARRINGTON\s*MORTGAGE|OCWEN|PHH\s*MORTGAGE|SELENE\s*FINANCE)\b/i;
    const isReoUnambiguous = reoGovRx.test(on) || reoServicerRx.test(on);
    const isReoBank = reoBankRx.test(on) && !/\bTRUSTEE\b/i.test(on);
    const isReo = isReoUnambiguous || isReoBank;
    
    const isJunkName = hasOwnerName && (
        /\bMANAGEMENT\b|\bPROPERTY\b|\bSERVICE|\bAGENCY\b|\bDEPARTMENT\b|\bOFFICE\b|\bCOMMITTEE\b|\bBOARD\b/i.test(on) && !isEntity ||
        on.split(/\s+/).length === 1 ||
        /^\d/.test(on)
    );
    const hasCleanOwnerName = hasOwnerName && !isJunkName;
    
    let multiCount = 1;
    if (hasOwnerName) {
        const ownerKey = on.trim();
        multiCount = ownerCounts[ownerKey] || 1;
    }
    const isSmallPortfolio = multiCount >= 2 && multiCount <= 5;
    const isLargePortfolio = multiCount > 5;
    const isOperational = isRanch && p.acres > 20;
    
    // 1. SELLER LIKELIHOOD
    let sellerLikelihood = 20;

    // REO and quit claim are the strongest signals — score them first so they
    // dominate the signal panel when present.
    if (isReo) {
        signals.push({text:'Bank-owned / REO — bank will dispose, regulatory pressure to sell',type:'positive'});
        sellerLikelihood += 35;
    }
    if (p.quitClaimFlag && p.tenureYears != null && p.tenureYears <= 3) {
        signals.push({text:'Recent quit claim deed — likely divorce, family transfer, or distressed sale',type:'positive'});
        sellerLikelihood += 15;
    } else if (p.quitClaimFlag) {
        signals.push({text:'Quit claim deed in chain — non-arms-length transfer history',type:'neutral'});
        sellerLikelihood += 5;
    }

    if (isHeirs) { signals.push({text:'Heir/deceased/survivor — likely transition',type:'positive'}); sellerLikelihood += calibrate(22, 'Estates / Heirs', cal); }
    if (isEstate && !isHeirs) { signals.push({text:'Estate ownership — may be in settlement',type:'positive'}); sellerLikelihood += calibrate(18, 'Estates / Heirs', cal); }
    if (isTrust && isAbsentee) { signals.push({text:'Trust + absentee — succession or remote management',type:'positive'}); sellerLikelihood += calibrate(16, 'Trusts', cal); }
    else if (isTrust && !isHeirs && !isEstate) { signals.push({text:'Trust ownership — possible succession planning',type:'neutral'}); sellerLikelihood += calibrate(8, 'Trusts', cal); }
    
    if (isAbsentee && isOutOfState) { signals.push({text:`Out-of-state absentee (${p.ownerState}) — distance creates friction`,type:'positive'}); sellerLikelihood += calibrate(14, 'Out-of-State', cal); }
    else if (isOutOfState) { signals.push({text:`Out-of-state owner (${p.ownerState})`,type:'positive'}); sellerLikelihood += calibrate(8, 'Out-of-State', cal); }
    else if (isAbsentee) { signals.push({text:'Absentee owner — not occupying property',type:'neutral'}); sellerLikelihood += calibrate(6, 'Absentee Owners', cal); }
    
    if (isVacant && isAbsentee) { signals.push({text:'Vacant land + absentee — carrying cost with no use',type:'positive'}); sellerLikelihood += calibrate(12, 'Vacant Land', cal); }
    else if (isVacant) { signals.push({text:'Vacant land — carrying costs with no income',type:'neutral'}); sellerLikelihood += calibrate(6, 'Vacant Land', cal); }
    if (landHeavy && !isVacant) { signals.push({text:'Land value exceeds building — possible teardown/redevelopment candidate',type:'neutral'}); sellerLikelihood += 4; }
    
    if (isSmallPortfolio) { signals.push({text:`Owner holds ${multiCount} properties locally — portfolio simplification possible`,type:'neutral'}); sellerLikelihood += 5; }
    if (isLargePortfolio) { signals.push({text:`Owner holds ${multiCount}+ properties — active investor`,type:'neutral'}); sellerLikelihood += 2; }
    
    if (p.tenureYears !== undefined && p.tenureYears !== null) {
        if (p.tenureYears <= 1) { signals.push({text:`Very recent transfer (${p.lastTransferDate || '<1yr'}) — unlikely to sell`,type:'negative'}); sellerLikelihood -= 15; }
        else if (p.tenureYears <= 2) { signals.push({text:`Recent buyer (~${Math.round(p.tenureYears)}yr ago) — low sell probability`,type:'negative'}); sellerLikelihood -= 10; }
        else if (p.tenureYears <= 3) { signals.push({text:`Purchased ~${Math.round(p.tenureYears)}yr ago — relatively recent`,type:'negative'}); sellerLikelihood -= 5; }
    } else if (p.tenureLongTerm) { signals.push({text:'No sale in past 3 years — ownership appears stable',type:'positive'}); sellerLikelihood += 3; }
    
    if (cal && p.tenureYears !== undefined && p.tenureYears !== null && p.tenureYears > 3) {
        let tenureBucket = null;
        if (p.tenureYears <= 10) tenureBucket = 'Tenure 3-10yr';
        else if (p.tenureYears <= 20) tenureBucket = 'Tenure 10-20yr';
        else tenureBucket = 'Tenure 20yr+';
        const bonus = calibrate(10, tenureBucket, cal);
        if (bonus !== 10) {
            sellerLikelihood += bonus;
            if (bonus > 5) signals.push({text:`${tenureBucket.replace('Tenure ','')} tenure — above-average seller rate in this market`,type:'positive'});
        }
    }
    
    if (isOperational) { signals.push({text:'Active agricultural operation — lower sell probability',type:'negative'}); sellerLikelihood -= 16; }
    if (isCorporateOpaque && !isAbsentee && !isOutOfState && multiCount <= 1) { signals.push({text:'Opaque entity with no transition signals',type:'negative'}); sellerLikelihood -= 10; }
    if (isLargePortfolio && !isAbsentee) { sellerLikelihood -= 6; }
    if (isLLC && !isTrust && !isEstate && !isHeirs && !isAbsentee && !isOutOfState && multiCount <= 1) {
        const llcLift = cal?.lifts?.['LLCs / Corps'] || 1;
        sellerLikelihood -= llcLift >= 1.2 ? 0 : llcLift >= 0.8 ? 3 : 5;
    }
    
    const isNamedIndividual = hasCleanOwnerName && !isLLC && !isTrust && !isEstate && !isHeirs && !isRanch;
    if (isNamedIndividual && hasMailingAddr) sellerLikelihood += calibrate(4, 'Named Individuals', cal);
    if (isCorporateOpaque && !hasMailingAddr) sellerLikelihood -= 4;
    if (isJunkName) sellerLikelihood -= 3;
    sellerLikelihood = clamp(sellerLikelihood, 0, 100);
    
    // 2. OFF-MARKET RECEPTIVITY
    let offMarketReceptivity = 20;
    if (isTrust || isEstate || isHeirs) offMarketReceptivity += 12;
    if (isLLC) offMarketReceptivity += 10;
    if (isAbsentee) offMarketReceptivity += 10;
    if (isOutOfState) offMarketReceptivity += 8;
    if (isLuxury) offMarketReceptivity += 12;
    if (isVacant) offMarketReceptivity += 6;
    if (p.acres && p.acres > 10) offMarketReceptivity += 10;
    if (isRanch) offMarketReceptivity += 8;
    if (isHighValue) offMarketReceptivity += 4;
    if (landHeavy) offMarketReceptivity += 4;
    if (isSmallPortfolio || isLargePortfolio) offMarketReceptivity += 6;
    offMarketReceptivity = clamp(offMarketReceptivity, 0, 100);
    
    // 3. ACTIONABILITY
    let actionability = 25;
    if (hasCleanOwnerName && hasMailingAddr) actionability += 15;
    else if (hasCleanOwnerName) actionability += 8;
    else if (hasOwnerName && hasMailingAddr) actionability += 5;
    if (hasCleanOwnerName && !isLLC) actionability += 12;
    if (isTrust && hasMailingAddr) actionability += 8;
    if (isHeirs || isEstate) actionability += 6;
    if (isAbsentee && hasMailingAddr) actionability += 6;
    if (isCorporateOpaque) actionability -= 15;
    if (isOperational) actionability -= 10;
    if (isLargePortfolio && isCorporateOpaque) actionability -= 8;
    if (!hasOwnerName) actionability -= 10;
    if (!hasMailingAddr && isCorporateOpaque) actionability -= 8;
    if (isJunkName) actionability -= 8;
    if (isNamedIndividual && hasMailingAddr) actionability += 5;
    if (isCorporateOpaque && !hasMailingAddr) actionability -= 5;
    actionability = clamp(actionability, 0, 100);
    
    // 4. CONFIDENCE
    let confidence = 30;
    if (hasCleanOwnerName) confidence += 10;
    else if (hasOwnerName) confidence += 4;
    if (hasMailingAddr) confidence += 8;
    if (p.totalValue > 0) confidence += 6;
    if (p.propType) confidence += 4;
    if (p.acres > 0) confidence += 3;
    if (isJunkName) confidence -= 6;
    const posSignals = signals.filter(s => s.type === 'positive').length;
    const negSignals = signals.filter(s => s.type === 'negative').length;
    if (posSignals >= 3 && negSignals === 0) confidence += 10;
    else if (posSignals >= 2) confidence += 5;
    if (posSignals > 0 && negSignals > 0) confidence -= 5;
    if (!hasOwnerName && !hasMailingAddr) confidence -= 10;
    if (isVacant || isLuxury || isRanch) confidence -= 5;
    if (p.tenureConfidence === 'high') confidence += 6;
    else if (p.tenureLongTerm) confidence += 1;
    else if (!p.tenureSource) confidence -= 3;
    
    // DATA-QUALITY PENALTY — model confidence scales with available evidence
    // No values AND no tenure (Deschutes): heavy penalty, model is blind
    // No tenure only (Montana non-disclosure): moderate penalty, missing key predictor
    const noValues = !p.totalValue || p.totalValue === 0;
    const noTenure = !p.tenureSource && !p.salePrice;
    if (noValues && noTenure) {
        sellerLikelihood -= 5;
        actionability -= 8;
        confidence -= 8;
    } else if (noTenure && !isEntity) {
        // Named individuals without tenure: reduce scores — can't estimate sell timing
        // Entities (trusts, LLCs, estates) keep their scores because entity type IS the signal
        sellerLikelihood -= 3;
        actionability -= 4;
        confidence -= 4;
    }
    
    confidence = clamp(confidence, 0, 100);
    
    const briefingRank = Math.round(
        (sellerLikelihood * 0.50) + (actionability * 0.30) +
        (offMarketReceptivity * 0.15) + (confidence * 0.05)
    );
    const scoreClass = briefingRank >= 55 ? 'high' : briefingRank >= 35 ? 'medium' : 'low';
    
    let cohort = 'residential', cohortLabel = 'Residential';
    if (isReo) { cohort='reo'; cohortLabel='Bank-Owned / REO'; }
    else if (isHeirs || isEstate) { cohort='estate'; cohortLabel='Estate / Heir'; }
    else if (p.quitClaimFlag && p.tenureYears != null && p.tenureYears <= 3) { cohort='quitclaim'; cohortLabel='Recent Family Transfer'; }
    else if (isTrust) { cohort='trust'; cohortLabel='Trust'; }
    else if (isRanch) { cohort='ranch'; cohortLabel='Ranch / Farm'; }
    else if (isLLC && !isTrust && !isEstate) { cohort='investor'; cohortLabel='Investor / Entity'; }
    else if (isAbsentee || isOutOfState) { cohort='absentee'; cohortLabel='Absentee Owner'; }
    else if (isVacant) { cohort='vacant'; cohortLabel='Vacant / Land'; }
    else if (isLuxury) { cohort='luxury'; cohortLabel='Luxury / High-End'; }

    return {
        sellerLikelihood, offMarketReceptivity, actionability, confidence, briefingRank,
        scoreClass, signals, cohort, cohortLabel,
        _multiCount: multiCount, _isSmallPortfolio: isSmallPortfolio, _isLargePortfolio: isLargePortfolio,
        _isAbsentee: isAbsentee, _isOutOfState: isOutOfState, _isVacant: isVacant, _isOperational: isOperational,
        _isReo: isReo, _quitClaimFlag: !!p.quitClaimFlag
    };
}

// ========================
// TENURE ENRICHMENT — King County sales endpoint
// ========================

async function enrichTenure(source, parcels) {
    if (!source.salesUrl || parcels.length === 0) return;
    
    let bSouth=90, bNorth=-90, bWest=180, bEast=-180;
    for (const p of parcels) {
        if (p.lat && p.lat !== 0) {
            if (p.lat < bSouth) bSouth = p.lat;
            if (p.lat > bNorth) bNorth = p.lat;
            if (p.lng < bWest) bWest = p.lng;
            if (p.lng > bEast) bEast = p.lng;
        }
    }
    if (bSouth >= bNorth) return; // no valid coords
    bSouth -= 0.001; bNorth += 0.001; bWest -= 0.001; bEast += 0.001;
    
    const sw = latlngToMerc(bSouth, bWest);
    const ne = latlngToMerc(bNorth, bEast);
    
    let allSalesFeatures = [];
    let offset = 0, hasMore = true, page = 0;
    while (hasMore && page < 10) {
        const params = new URLSearchParams({
            geometry: `${sw.x},${sw.y},${ne.x},${ne.y}`,
            geometryType: 'esriGeometryEnvelope', inSR: '3857', spatialRel: 'esriSpatialRelIntersects',
            outFields: source.salesFields, returnGeometry: 'false', f: 'json',
            resultRecordCount: '2000', resultOffset: String(offset)
        });
        const resp = await fetch(`${source.salesUrl}?${params}`, { signal: AbortSignal.timeout(30000) });
        const data = await resp.json();
        const features = data.features || [];
        allSalesFeatures.push(...features);
        hasMore = data.exceededTransferLimit === true && features.length > 0;
        offset += 2000;
        page++;
    }
    
    if (allSalesFeatures.length === 0) return;
    
    const salesByPin = {};
    for (const sf of allSalesFeatures) {
        const sa = sf.attributes;
        const pin = sa.PIN;
        const saleDate = sa.SaleDate;
        if (!pin || !saleDate) continue;
        if (!salesByPin[pin] || saleDate > salesByPin[pin].saleDate) {
            salesByPin[pin] = { saleDate, salePrice: sa.SalePrice||0, seller: (sa.Sellername||'').trim(), buyer: (sa.buyername||'').trim() };
        }
    }
    
    const now = Date.now();
    let enrichedCount = 0;
    for (const p of parcels) {
        const sale = salesByPin[p.id];
        if (sale) {
            const yearsAgo = (now - sale.saleDate) / (365.25*24*60*60*1000);
            p.lastTransferDate = new Date(sale.saleDate).toISOString().split('T')[0];
            p.lastTransferYear = new Date(sale.saleDate).getFullYear();
            p.tenureYears = Math.round(yearsAgo*10)/10;
            p.tenureSource = 'king_sales3yr';
            p.tenureConfidence = 'high';
            p.recentTransfer = yearsAgo <= 3;
            p.salePrice = sale.salePrice;
            // Fill in owner name from buyer if parcel has no owner name
            if (!p.ownerName && sale.buyer) {
                p.ownerName = sale.buyer.replace(/\+/g,' ').replace(/\s+/g,' ').trim();
                p.ownerName = cleanOwnerName(p.ownerName);
            }
            enrichedCount++;
        } else {
            // No sale in 3yr window — mark as long-term
            p.tenureLongTerm = true;
            p.tenureSource = 'king_sales3yr_absent';
        }
    }
    
    return enrichedCount;
}

module.exports = {
    cleanOwnerName, parseNumericValue, extractLatLng, classifyPropType,
    parseParcel, clamp, calibrate, precomputeStats, scoreParcel,
    latlngToMerc, enrichTenure
};
