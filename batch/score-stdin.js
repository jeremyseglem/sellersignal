// stdin → scoreParcelNew → stdout
// 
// Input:  JSON array of { parcel, signals } objects on stdin
// Output: JSON array of score results on stdout
//
// Used by the Python validation wrapper to test scoreParcelNew against
// real DB data without needing Node's fetch to work in the sandbox.

const { scoreParcelNew, precomputeStats } = require('./pipeline');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const batch = JSON.parse(input);
        const parcels = batch.parcels || [];
        const signalsByParcelId = batch.signalsByParcelId || {};
        
        // Compute stats from the batch
        const stats = precomputeStats(parcels);
        
        const results = [];
        for (const p of parcels) {
            const sigs = signalsByParcelId[p.id] || null;
            const r = scoreParcelNew(p, stats, null, sigs);
            results.push({
                parcel_id: p.id,
                seller_likelihood: r.sellerLikelihood,
                off_market_receptivity: r.offMarketReceptivity,
                actionability: r.actionability,
                confidence: r.confidence,
                briefing_rank: r.briefingRank,
                score_class: r.scoreClass,
                cohort: r.cohort,
                cohort_label: r.cohortLabel,
                signals: r.signals,
                has_investigation: r._hasInvestigation || false,
                investigation_score: r._investigationScore || 0,
                shape_score: r._shapeScore || 0,
            });
        }
        
        process.stdout.write(JSON.stringify(results));
    } catch (e) {
        console.error('Scorer error:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
});
