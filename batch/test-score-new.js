// Test harness for scoreParcelNew — validates JS implementation against
// the Python prototype output. Real parcel + signal data inline, so no
// network calls needed.

const { scoreParcelNew, precomputeStats } = require('./pipeline');

// Real parcels from Paradise Valley 85253 investigation_cache, captured
// from the session transcript and DB queries earlier today.
const TEST_PARCELS = [
    {
        id: '16913061E',
        ownerName: 'BEL SOGNO ESTATE LLC',
        address: '7317 N HIGHCLIFF DR',
        totalValue: 2129000,
        buildingValue: 1500000,
        landValue: 629000,
        ownerAddress: 'SCOTTSDALE AZ',
        ownerState: 'AZ',
        isAbsentee: true,
        isOutOfState: false,
        propType: 'Residential',
        tenureYears: 8,
        tenureLongTerm: true,
        tenureSource: 'deed',
        tenureConfidence: 'high',
        signals: [
            { type: 'previously_listed', category: 'listing', confidence: 0.85, detail: 'Property was listed but is now off market' },
            { type: 'listing_history_exists', category: 'listing', confidence: 0.4, detail: 'Has listing platform history' },
            { type: 'historical_price', category: 'listing', confidence: 0.5, detail: '$10,454' },
            { type: 'linkedin_found', category: 'identity', confidence: 0.7, detail: 'Jeremy Rowley - Chief Operating Officer' },
            { type: 'business_owner', category: 'identity', confidence: 0.6, detail: 'Business owner/executive' },
            { type: 'entity_info', category: 'identity', confidence: 0.6, detail: 'Entity info: AZ Corp. Commission...' },
        ],
        expectedCohort: 'previously_listed', // has listed, no life event
    },
    {
        id: '16403125',
        ownerName: 'KIRBY SUZETTE TR',
        address: '6750 N 39TH PL',
        totalValue: 2700000,
        buildingValue: 1900000,
        landValue: 800000,
        ownerAddress: 'LAS VEGAS NV',
        ownerState: 'NV',
        isAbsentee: true,
        isOutOfState: true,
        propType: 'Residential',
        tenureYears: 20,
        tenureLongTerm: true,
        tenureSource: 'deed',
        tenureConfidence: 'high',
        signals: [
            { type: 'previously_listed', category: 'listing', confidence: 0.85, detail: 'Property was listed but is now off market' },
            { type: 'listing_history_exists', category: 'listing', confidence: 0.4, detail: 'Has listing platform history' },
            { type: 'historical_price', category: 'listing', confidence: 0.5, detail: '$2980600' },
            { type: 'linkedin_found', category: 'identity', confidence: 0.7, detail: 'Roy Fernandez - Security National Mortgage' },
            { type: 'business_owner', category: 'identity', confidence: 0.6, detail: 'Business owner/executive' },
            { type: 'retirement', category: 'life_event', confidence: 0.65, detail: 'Retirement indicator' },
            { type: 'obituary', category: 'life_event', confidence: 0.75, detail: 'Possible death in household' },
            { type: 'entity_info', category: 'identity', confidence: 0.6, detail: 'Entity info: Case 2:24-cv-02377...' },
        ],
        expectedCohort: 'motivated_seller', // listed + retirement + obituary
    },
    {
        id: '16951003',
        ownerName: 'BANASH BEN',
        address: '7777 E CHALK LN',
        totalValue: 2100000,
        buildingValue: 1600000,
        landValue: 500000,
        ownerAddress: 'PARADISE VALLEY AZ',
        ownerState: 'AZ',
        isAbsentee: false,
        isOutOfState: false,
        propType: 'Residential',
        tenureYears: 5,
        tenureLongTerm: true,
        tenureSource: 'deed',
        tenureConfidence: 'high',
        signals: [
            { type: 'listing_history_exists', category: 'listing', confidence: 0.4, detail: 'Has listing platform history' },
            { type: 'historical_price', category: 'listing', confidence: 0.5, detail: '$34,995' },
            { type: 'linkedin_found', category: 'identity', confidence: 0.7, detail: 'Ben Banash - Expanding my sales team!' },
            { type: 'business_owner', category: 'identity', confidence: 0.6, detail: 'Business owner/executive' },
            { type: 'entity_info', category: 'identity', confidence: 0.6, detail: 'Entity info: 200+ Gionni profiles' },
        ],
        expectedCohort: 'residential', // no life event, no previously_listed; just identity
    },
    // Agent test — should be hard-capped at 15
    {
        id: 'TEST_AGENT',
        ownerName: 'SMITH JOHN',
        address: '123 MAIN ST',
        totalValue: 3500000,
        buildingValue: 2500000,
        landValue: 1000000,
        ownerAddress: 'SEATTLE WA',
        ownerState: 'WA',
        isAbsentee: true,
        isOutOfState: false,
        propType: 'Residential',
        tenureYears: 12,
        tenureLongTerm: true,
        signals: [
            { type: 'linkedin_found', category: 'identity', confidence: 0.85, detail: 'John Smith - Realtor at Windermere' },
            { type: 'is_agent', category: 'blocker', confidence: 0.9, detail: 'Owner is a real estate agent' },
        ],
        expectedCohort: 'agent',
    },
    // Recent buyer test — should return 0
    {
        id: 'TEST_RECENT',
        ownerName: 'NEWBUYER LLC',
        address: '456 OAK ST',
        totalValue: 4000000,
        buildingValue: 3000000,
        landValue: 1000000,
        ownerAddress: 'TEMPE AZ',
        ownerState: 'AZ',
        isAbsentee: true,
        isOutOfState: false,
        propType: 'Residential',
        tenureYears: 0.6,
        signals: [
            { type: 'previously_listed', category: 'listing', confidence: 0.85, detail: 'Property was listed but is now off market' },
        ],
        expectedCohort: 'recent_buyer',
    },
    // Commercial test — should return 0
    {
        id: 'TEST_COMMERCIAL',
        ownerName: 'DOWNTOWN TOWER LLC',
        address: '100 PIKE ST',
        totalValue: 50000000,
        buildingValue: 40000000,
        landValue: 10000000,
        ownerAddress: 'BELLEVUE WA',
        ownerState: 'WA',
        propType: 'Commercial',
        tenureYears: 10,
        signals: [],
        expectedCohort: 'commercial',
    },
    // No investigation — should score by property shape only, mid-range
    {
        id: 'TEST_NO_INV',
        ownerName: 'JONES FAMILY TRUST',
        address: '789 ELM ST',
        totalValue: 1500000,
        buildingValue: 1200000,
        landValue: 300000,
        ownerAddress: 'DENVER CO',
        ownerState: 'CO',
        isAbsentee: true,
        isOutOfState: true,
        propType: 'Residential',
        tenureYears: 18,
        tenureLongTerm: true,
        tenureSource: 'deed',
        tenureConfidence: 'high',
        signals: null, // no investigation
        expectedCohort: 'trust',
    },
    // Probate + heirs — should be top-tier
    {
        id: 'TEST_PROBATE',
        ownerName: 'SMITH HEIRS',
        address: '321 BIRCH ST',
        totalValue: 2200000,
        buildingValue: 1700000,
        landValue: 500000,
        ownerAddress: 'PORTLAND OR',
        ownerState: 'OR',
        isAbsentee: true,
        isOutOfState: true,
        propType: 'Residential',
        tenureYears: 25,
        tenureLongTerm: true,
        signals: [
            { type: 'probate', category: 'life_event', confidence: 0.85, detail: 'Probate/estate filing' },
        ],
        expectedCohort: 'estate',
    },
];

// Mock stats object (scoreParcelNew uses p75Value and ownerCounts)
const mockStats = {
    p75Value: 2000000,
    ownerCounts: {},
};

console.log('scoreParcelNew test harness — real Paradise Valley data + synthetic edge cases\n');
console.log('='.repeat(130));
console.log('id                 expected        cohort          sl   rank  invScore shapeScore  topSignal');
console.log('='.repeat(130));

let allPass = true;
for (const p of TEST_PARCELS) {
    const { signals: inv, expectedCohort, ...parcel } = p;
    const result = scoreParcelNew(parcel, mockStats, null, inv);
    const cohortMatch = result.cohort === expectedCohort;
    const topSig = (result.signals && result.signals[0]) ? result.signals[0].text.slice(0, 55) : '(none)';
    const status = cohortMatch ? '✓' : '✗';
    console.log(
        `${status} ${p.id.padEnd(18)} ${expectedCohort.padEnd(15)} ${result.cohort.padEnd(15)} ` +
        `${String(result.sellerLikelihood).padStart(3)}  ${String(result.briefingRank).padStart(4)}  ` +
        `${String(result._investigationScore || 0).padStart(8)} ${String(result._shapeScore || 0).padStart(10)}  ${topSig}`
    );
    if (!cohortMatch) allPass = false;
}

console.log();
console.log(allPass ? '✓ ALL COHORT ASSERTIONS PASS' : '✗ SOME COHORT ASSERTIONS FAILED');

// Detailed look at Bel Sogno and Suzette Kirby — the two demo parcels
console.log('\n' + '='.repeat(130));
console.log('DETAILED: Bel Sogno Estate LLC');
console.log('='.repeat(130));
const bs = TEST_PARCELS.find(p => p.id === '16913061E');
const { signals: bsInv, expectedCohort: _bs, ...bsParcel } = bs;
const bsResult = scoreParcelNew(bsParcel, mockStats, null, bsInv);
console.log(JSON.stringify({
    sellerLikelihood: bsResult.sellerLikelihood,
    offMarketReceptivity: bsResult.offMarketReceptivity,
    actionability: bsResult.actionability,
    confidence: bsResult.confidence,
    briefingRank: bsResult.briefingRank,
    cohort: bsResult.cohort,
    cohortLabel: bsResult.cohortLabel,
    _investigationScore: bsResult._investigationScore,
    _shapeScore: bsResult._shapeScore,
    signals: bsResult.signals.map(s => s.text),
}, null, 2));

console.log('\n' + '='.repeat(130));
console.log('DETAILED: Suzette Kirby Trust');
console.log('='.repeat(130));
const sk = TEST_PARCELS.find(p => p.id === '16403125');
const { signals: skInv, expectedCohort: _sk, ...skParcel } = sk;
const skResult = scoreParcelNew(skParcel, mockStats, null, skInv);
console.log(JSON.stringify({
    sellerLikelihood: skResult.sellerLikelihood,
    offMarketReceptivity: skResult.offMarketReceptivity,
    actionability: skResult.actionability,
    confidence: skResult.confidence,
    briefingRank: skResult.briefingRank,
    cohort: skResult.cohort,
    cohortLabel: skResult.cohortLabel,
    _investigationScore: skResult._investigationScore,
    _shapeScore: skResult._shapeScore,
    signals: skResult.signals.map(s => s.text),
}, null, 2));
