// SellerSignal ZIP Pricing Tiers
// Blends median value (40%), transaction volume (35%), and property count (25%)
// to assign each ZIP a pricing tier.

const TIERS = {
  standard: { price: 997, label: 'Standard', minScore: 0 },
  premium:  { price: 1497, label: 'Premium', minScore: 40 },
  elite:    { price: 2497, label: 'Elite', minScore: 65 },
  ultra:    { price: 4997, label: 'Ultra', minScore: 85 },
};

// Manual overrides for ZIPs where GIS data understates actual market value
// These are well-known luxury/trophy markets
const VALUE_OVERRIDES = {
  // Ultra-luxury — trophy markets
  '10021': 3500000,  // Upper East Side, Manhattan
  '10013': 2800000,  // Tribeca
  '10014': 2200000,  // West Village
  '10024': 2000000,  // Upper West Side
  '10583': 1800000,  // Scarsdale
  '11201': 1500000,  // Brooklyn Heights
  '33131': 1200000,  // Brickell
  '33139': 1500000,  // Miami Beach
  '33149': 2000000,  // Key Biscayne
  '33480': 2500000,  // Palm Beach Island
  '33487': 1800000,  // Highland Beach / Boca
  '33496': 1200000,  // West Boca
  '98039': 4500000,  // Medina (Bezos, Gates)
  '98004': 2200000,  // Bellevue
  '98040': 2500000,  // Mercer Island
  '98112': 1800000,  // Capitol Hill / Madison Park
  '98033': 1600000,  // Kirkland
  '98074': 1600000,  // Sammamish / Woodinville
  '98105': 1500000,  // University District / Laurelhurst
  '98109': 1400000,  // Queen Anne / South Lake Union
  '98199': 1200000,  // Magnolia
  '98103': 850000,   // Fremont / Wallingford
  '59716': 1500000,  // Big Sky
  '59718': 900000,   // Bozeman
  '59730': 800000,   // Gallatin Gateway
  '85253': 2500000,  // Paradise Valley
  '85255': 1800000,  // North Scottsdale (DC Ranch, Silverleaf)
  '85262': 1200000,  // Scottsdale (Troon)
  '85258': 1000000,  // South Scottsdale luxury
  '85260': 900000,   // North Scottsdale
  // Miami-Dade — GIS sale prices are noisy (condos + single family mixed)
  '33133': 1200000,  // Coconut Grove
  '33134': 900000,   // Coral Gables
  '33140': 1500000,  // Mid-Beach / Indian Creek
  '33143': 600000,   // South Miami / Pinecrest adjacent
  '33156': 800000,   // Palmetto Bay / Pinecrest
  // Palm Beach — similar noise
  '33432': 1200000,  // Boca Raton east
  '33486': 900000,   // Boca west
  '33408': 600000,   // North Palm Beach
  // Bend — strong but not ultra
  '97702': 650000,
  '97703': 750000,
  '97707': 800000,   // Sunriver / Mt Bachelor
};

// Transaction volume benchmarks (sold in 24 months)
// NOTE: sold24=0 can mean "no data" (MT, NY, OR) not "no sales"
// Use -1 to signal "data unavailable" vs 0 for "confirmed zero"
function scoreVolume(sold24, hasSalesData) {
  if (!hasSalesData && sold24 === 0) return 30; // No data — assume moderate activity
  if (sold24 >= 2000) return 100;
  if (sold24 >= 1000) return 80;
  if (sold24 >= 500) return 60;
  if (sold24 >= 200) return 40;
  if (sold24 >= 50) return 20;
  if (sold24 >= 10) return 10;
  return 5;
}

// Median value benchmarks
function scoreValue(medianValue) {
  if (medianValue >= 3000000) return 100;
  if (medianValue >= 2000000) return 90;
  if (medianValue >= 1500000) return 80;
  if (medianValue >= 1000000) return 65;
  if (medianValue >= 750000) return 50;
  if (medianValue >= 500000) return 35;
  if (medianValue >= 300000) return 20;
  if (medianValue >= 150000) return 10;
  return 5;
}

// Property count benchmarks
function scoreParcels(count) {
  if (count >= 15000) return 100;
  if (count >= 10000) return 80;
  if (count >= 5000) return 60;
  if (count >= 2000) return 40;
  if (count >= 500) return 20;
  return 10;
}

function calculateTier(zipCode, medianValue, sold24, totalParcels, hasSalesData) {
  // Use manual override if available
  const value = VALUE_OVERRIDES[zipCode] || medianValue || 0;
  
  const vScore = scoreValue(value);
  const tScore = scoreVolume(sold24 || 0, hasSalesData !== false);
  const pScore = scoreParcels(totalParcels || 0);
  
  // Weighted blend: 40% value, 35% volume, 25% property count
  const composite = Math.round(vScore * 0.40 + tScore * 0.35 + pScore * 0.25);
  
  // Value floor — ultra-high-value markets get a minimum tier
  // regardless of volume or size, because one deal justifies the cost
  let minTier = 'standard';
  if (value >= 3000000) minTier = 'elite';
  else if (value >= 1500000) minTier = 'premium';
  
  // Map to tier (higher of composite-based or value-floor)
  let tier = 'standard';
  if (composite >= TIERS.ultra.minScore) tier = 'ultra';
  else if (composite >= TIERS.elite.minScore) tier = 'elite';
  else if (composite >= TIERS.premium.minScore) tier = 'premium';
  
  // Apply floor
  const tierOrder = ['standard', 'premium', 'elite', 'ultra'];
  if (tierOrder.indexOf(minTier) > tierOrder.indexOf(tier)) tier = minTier;
  
  return {
    tier,
    price: TIERS[tier].price,
    label: TIERS[tier].label,
    composite,
    breakdown: { value: vScore, volume: tScore, parcels: pScore, medianValue: value },
  };
}

module.exports = { calculateTier, TIERS, VALUE_OVERRIDES };
