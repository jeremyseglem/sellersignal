// Smoke test for new ATTOM-style features in pipeline.js
// Tests REO detection, quit claim handling, PO Box absentee fix

const { scoreParcel, parseParcel } = require('../batch/pipeline');

const baseStats = { p75Value: 1000000, ownerCounts: {} };
let pass = 0, fail = 0;

function check(label, condition, details) {
  if (condition) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${details ? ': ' + details : ''}`); }
}

// === TEST 1: REO bank-owned ===
console.log('\n--- REO bank-owned (BANK OF AMERICA NA, no trustee) ---');
const reoBank = {
  ownerName: 'BANK OF AMERICA NA',
  address: '123 MAIN ST', cityStateZip: 'PHOENIX, AZ 85003',
  totalValue: 500000, buildingValue: 350000, landValue: 150000,
  ownerAddress: '101 N TRYON ST CHARLOTTE NC', ownerState: 'NC',
  isAbsentee: true, isOutOfState: true,
  yearBuilt: 1990, sqft: 2000, propType: 'SFR'
};
const reoBankResult = scoreParcel(reoBank, baseStats, null);
check('cohort=reo', reoBankResult.cohort === 'reo', `got ${reoBankResult.cohort}`);
check('cohortLabel=Bank-Owned', reoBankResult.cohortLabel === 'Bank-Owned / REO');
check('seller likelihood high (>50)', reoBankResult.sellerLikelihood > 50, `got ${reoBankResult.sellerLikelihood}`);
check('signal includes REO', reoBankResult.signals.some(s => s.text.includes('Bank-owned')));
check('_isReo flag set', reoBankResult._isReo === true);

// === TEST 2: Bank in TRUSTEE capacity (NOT REO — it's an MBS holder) ===
console.log('\n--- Bank in TRUSTEE capacity (should NOT be REO) ---');
const bankTrustee = {
  ownerName: 'WELLS FARGO BANK NA AS TRUSTEE FOR HOLDERS OF SOMETHING',
  address: '456 OAK ST', cityStateZip: 'PHOENIX, AZ 85003',
  totalValue: 400000, buildingValue: 280000, landValue: 120000,
  ownerAddress: '101 N TRYON ST CHARLOTTE NC', ownerState: 'NC',
  isAbsentee: true, isOutOfState: true,
  yearBuilt: 1985, sqft: 1800, propType: 'SFR'
};
const trusteeResult = scoreParcel(bankTrustee, baseStats, null);
check('cohort != reo', trusteeResult.cohort !== 'reo', `got ${trusteeResult.cohort}`);
check('cohort=absentee (TRUSTEE not matched by isTrust regex)', trusteeResult.cohort === 'absentee');
check('_isReo flag false', trusteeResult._isReo === false);

// === TEST 3: Fannie Mae REO (unambiguous) ===
console.log('\n--- Fannie Mae REO ---');
const fannie = {
  ownerName: 'FEDERAL NATIONAL MORTGAGE ASSOC',
  address: '789 PINE ST', cityStateZip: 'PHOENIX, AZ 85003',
  totalValue: 350000, buildingValue: 250000, landValue: 100000,
  ownerAddress: '3900 WISCONSIN AVE NW WASHINGTON DC', ownerState: 'DC',
  isAbsentee: true, isOutOfState: true,
  yearBuilt: 1995, sqft: 1500, propType: 'SFR'
};
const fannieResult = scoreParcel(fannie, baseStats, null);
check('cohort=reo (Fannie unambiguous)', fannieResult.cohort === 'reo');
check('seller likelihood >50', fannieResult.sellerLikelihood > 50, `got ${fannieResult.sellerLikelihood}`);

// === TEST 4: Quit claim recent (with tenure) ===
console.log('\n--- Quit claim deed, 2yr tenure ---');
const qc = {
  ownerName: 'JANE DOE',
  address: '321 ELM ST', cityStateZip: 'BOZEMAN, MT 59715',
  totalValue: 800000, buildingValue: 600000, landValue: 200000,
  ownerAddress: '321 ELM ST BOZEMAN MT', ownerState: 'MT',
  isAbsentee: false, isOutOfState: false,
  yearBuilt: 2000, sqft: 2200, propType: 'SFR',
  quitClaimFlag: true, tenureYears: 2,
  lastTransferYear: 2024, lastTransferDate: '2024-03-15'
};
const qcResult = scoreParcel(qc, baseStats, null);
check('cohort=quitclaim', qcResult.cohort === 'quitclaim', `got ${qcResult.cohort}`);
check('cohortLabel=Recent Family Transfer', qcResult.cohortLabel === 'Recent Family Transfer');
check('signal includes quit claim', qcResult.signals.some(s => s.text.includes('quit claim') || s.text.includes('Quit')));
check('_quitClaimFlag set', qcResult._quitClaimFlag === true);

// === TEST 5: Old quit claim (>3yr tenure, weaker signal) ===
console.log('\n--- Old quit claim (10yr tenure, weak signal) ---');
const oldQc = { ...qc, tenureYears: 10 };
const oldQcResult = scoreParcel(oldQc, baseStats, null);
check('cohort != quitclaim (too old)', oldQcResult.cohort !== 'quitclaim', `got ${oldQcResult.cohort}`);
check('still has quit claim signal', oldQcResult.signals.some(s => s.text.includes('Quit claim')));

// === TEST 6: Regular individual owner (no flags) ===
console.log('\n--- Regular individual owner (baseline) ---');
const regular = {
  ownerName: 'JOHN SMITH', address: '555 OAK', cityStateZip: 'BOZEMAN, MT 59715',
  totalValue: 600000, buildingValue: 450000, landValue: 150000,
  ownerAddress: '555 OAK BOZEMAN MT', ownerState: 'MT',
  isAbsentee: false, isOutOfState: false,
  yearBuilt: 1995, sqft: 2000, propType: 'SFR'
};
const regResult = scoreParcel(regular, baseStats, null);
check('cohort=residential', regResult.cohort === 'residential');
check('_isReo false', regResult._isReo === false);
check('_quitClaimFlag false', regResult._quitClaimFlag === false);

// === TEST 7: PO Box absentee fix (parseParcel level) ===
console.log('\n--- PO Box in same ZIP region (parseParcel) ---');
const fakeFeature = {
  attributes: {
    OwnerName: 'JANE LOCAL', AddressLine1: '100 MAIN ST',
    CityStateZip: 'WHITEFISH, MT 59937',
    OwnerAddress1: 'PO BOX 1234', OwnerCity: 'WHITEFISH', OwnerState: 'MT', OwnerZipCode: '59937',
    PARCELID: 'TEST001', TotalValue: 500000
  }
};
const fakeMarket = {
  key: 'TEST', homeState: 'MT',
  fieldMap: { id:'PARCELID', ownerName:'OwnerName', address:'AddressLine1',
              cityStateZip:'CityStateZip', totalValue:'TotalValue',
              mailAddress:'OwnerAddress1', mailCity:'OwnerCity', mailState:'OwnerState',
              mailZip:'OwnerZipCode', situsZip:'CityStateZip' },
  propTypeRules: { style: 'none' }
};
// Note: situsZip uses CityStateZip which won't extract a ZIP cleanly, so this test
// validates the FALLBACK path. Need a better test market.
const fakeMarket2 = {
  key: 'TEST2', homeState: 'MT',
  fieldMap: { id:'PARCELID', ownerName:'OwnerName', address:'AddressLine1',
              cityStateZip:'CityStateZip', totalValue:'TotalValue',
              mailAddress:'OwnerAddress1', mailCity:'OwnerCity', mailState:'OwnerState',
              mailZip:'OwnerZipCode', situsZip:'SitusZip' },
  propTypeRules: { style: 'none' }
};
fakeFeature.attributes.SitusZip = '59937';
const parsed = parseParcel(fakeFeature, fakeMarket2);
check('PO Box same ZIP → not absentee', parsed.isAbsentee === false, `got isAbsentee=${parsed.isAbsentee}`);

// === TEST 8: PO Box different ZIP (still absentee) ===
console.log('\n--- PO Box in DIFFERENT ZIP region (still absentee) ---');
const fakeFeature2 = {
  attributes: {
    OwnerName: 'JANE REMOTE', AddressLine1: '100 MAIN ST', CityStateZip: 'WHITEFISH, MT 59937',
    OwnerAddress1: 'PO BOX 1234', OwnerCity: 'BOZEMAN', OwnerState: 'MT', OwnerZipCode: '59715',
    SitusZip: '59937', PARCELID: 'TEST002', TotalValue: 500000
  }
};
const parsed2 = parseParcel(fakeFeature2, fakeMarket2);
check('PO Box different ZIP → still absentee', parsed2.isAbsentee === true, `got isAbsentee=${parsed2.isAbsentee}`);

console.log(`\n${'='.repeat(50)}\n${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
process.exit(fail > 0 ? 1 : 0);
