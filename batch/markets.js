// SellerSignal — Market Source Configurations
// Extracted from sellersignal-briefing.html SOURCES configs
// Custom parse functions reference pipeline.parseParcel

const { parseParcel, parseNumericValue } = require('./pipeline');

const MARKETS = {};

MARKETS.MT = {
  key: 'MT', name: 'Montana', homeState: 'MT',
  url: 'https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0/query',
  fields: 'OwnerName,AddressLine1,CityStateZip,TotalValue,TotalBuildingValue,TotalLandValue,PropType,GISAcres,Subdivision,OwnerAddress1,OwnerCity,OwnerState,OwnerZipCode,PARCELID',
  max: 2000,
  zipWhere: (zip) => `CityStateZip LIKE '%${zip}%'`,
  fieldMap: { id:'PARCELID', ownerName:'OwnerName', address:'AddressLine1', cityStateZip:'CityStateZip', totalValue:'TotalValue', buildingValue:'TotalBuildingValue', landValue:'TotalLandValue', acres:'GISAcres', subdivision:'Subdivision', mailAddress:'OwnerAddress1', mailCity:'OwnerCity', mailState:'OwnerState', mailZip:'OwnerZipCode' },
  propTypeRules: { style: 'string', field: 'PropType', exempt: ['Exempt Property'], commercial: ['Commercial'], vacant: ['Vacant', 'Agricultural'] },
  parse(f) { return parseParcel(f, this); },
  zips: ['59718','59715','59716','59730','59714','59711'],
};

MARKETS.WA_KING = {
  key: 'WA_KING', name: 'King County, WA', homeState: 'WA',
  url: 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/PARCEL_ADDRESS_PUB_AREA_3069/FeatureServer/0/query',
  fields: 'PAAUNIQUENAME,KCTP_ATTN,ADDR_FULL,CTYNAME,KCTP_ADDR,KCTP_CTYST,KCTP_STATE,APPRLNDVAL,APPR_IMPR,TAX_LNDVAL,TAX_IMPR,PLAT_NAME,KCA_ACRES,PREUSE_DESC,PIN,LAT,LON,ZIP5',
  max: 1000,
  zipWhere: (zip) => `ZIP5='${zip}'`,
  latField: 'LAT', lngField: 'LON',
  fieldMap: { id:'PIN', ownerName:['PAAUNIQUENAME','KCTP_ATTN'], address:'ADDR_FULL', situsCity:'CTYNAME', situsZip:'ZIP5', totalValue:null, buildingValue:['APPR_IMPR','TAX_IMPR'], landValue:['APPRLNDVAL','TAX_LNDVAL'], acres:'KCA_ACRES', subdivision:'PLAT_NAME', mailAddress:'KCTP_ADDR', mailState:'KCTP_STATE' },
  propTypeRules: { style: 'regex', field: 'PREUSE_DESC', exemptRx: /exempt|government/i, vacantRx: /vacant/i, commercialRx: /commercial|industrial|apartment|multi.?family|multifamily|hotel|motel|\boffice\b|retail|warehouse|shopping|mobile home park/i },
  salesUrl: 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/PARCEL_SALES3YR_AREA_287/FeatureServer/0/query',
  salesFields: 'PIN,SaleDate,SalePrice,Sellername,buyername',
  parse(f) { return parseParcel(f, this); },
  // King County: keep parcels even without owner names — enrichTenure fills them from sales data
  keepBlankOwners: true,
  zips: ['98112','98004','98033','98040','98039','98074','98103','98109','98105','98199'],
};

MARKETS.NY = {
  key: 'NY', name: 'New York State', homeState: 'NY',
  url: 'https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query',
  fields: 'PRIMARY_OWNER,PARCEL_ADDR,LOC_STREET,LOC_ST_NBR,LOC_ZIP,MAIL_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP,TOTAL_AV,FULL_MARKET_VAL,LAND_AV,COUNTY_NAME,MUNI_NAME,CITYTOWN_NAME,PROP_CLASS,ACRES,CALC_ACRES,OWNER_TYPE,ROLL_YR,SQ_FT,YR_BLT',
  max: 1000,
  zipWhere: (zip) => `LOC_ZIP='${zip}'`,
  fieldMap: { id:null, ownerName:'PRIMARY_OWNER', address:['LOC_ST_NBR','LOC_STREET'], situsCity:'MUNI_NAME', situsZip:'LOC_ZIP', totalValue:['FULL_MARKET_VAL','TOTAL_AV'], buildingValue:null, landValue:'LAND_AV', acres:'CALC_ACRES', sqft:'SQ_FT', yearBuilt:'YR_BLT', mailAddress:'MAIL_ADDR', mailCity:'MAIL_CITY', mailState:'MAIL_STATE', mailZip:'MAIL_ZIP' },
  propTypeRules: { style: 'class', field: 'PROP_CLASS', exempt: ['8','9','6'], commercial: ['4','7'], vacant: ['3'], multiFamily: ['2'] },
  parse(f) {
    const p = parseParcel(f, this);
    const a = f.attributes || {};
    const city = (a.MUNI_NAME || a.CITYTOWN_NAME || a.COUNTY_NAME || 'New York').trim();
    p.cityStateZip = `${city}, NY ${a.LOC_ZIP || ''}`;
    if (!p.id) p.id = `NY-${(p.address||'').replace(/\s/g,'')}-${(p.ownerName||'').substring(0,10)}`;
    if (!p.buildingValue && p.totalValue > p.landValue) p.buildingValue = p.totalValue - p.landValue;
    p.county = (a.COUNTY_NAME || '').trim();
    return p;
  },
  zips: ['10021','10024','10014','10013','11201','10583'],
};

MARKETS.AZ_MARICOPA = {
  key: 'AZ_MARICOPA', name: 'Maricopa County, AZ', homeState: 'AZ',
  url: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/MaricopaDynamicQueryService/MapServer/3/query',
  fields: 'APN,OWNER_NAME,PHYSICAL_ADDRESS,PHYSICAL_CITY,PHYSICAL_ZIP,MAIL_ADDRESS,MAIL_CITY,MAIL_STATE,MAIL_ZIP,FCV_CUR,LPV_CUR,LAND_SIZE,CONST_YEAR,LIVING_SPACE,DEED_DATE,SALE_DATE,SALE_PRICE,PUC,LATITUDE,LONGITUDE,INCAREOF,CITY_ZONING,SUBNAME,JURISDICTION',
  max: 1000, noGeometry: true,
  zipWhere: (zip) => `PHYSICAL_ZIP='${zip}'`,
  latField: 'LATITUDE', lngField: 'LONGITUDE',
  acresIsSqft: true,
  fieldMap: { id:'APN', ownerName:'OWNER_NAME', address:'PHYSICAL_ADDRESS', situsCity:'PHYSICAL_CITY', situsZip:'PHYSICAL_ZIP', totalValue:'FCV_CUR', buildingValue:null, landValue:null, acres:'LAND_SIZE', subdivision:'SUBNAME', livingSpace:'LIVING_SPACE', yearBuilt:'CONST_YEAR', deedDate:'DEED_DATE', saleDate:'SALE_DATE', salePrice:'SALE_PRICE', mailAddress:'MAIL_ADDRESS', mailCity:'MAIL_CITY', mailState:'MAIL_STATE', mailZip:'MAIL_ZIP', inCareOf:'INCAREOF' },
  propTypeRules: { style: 'puc', field: 'PUC', exempt: ['8','9','0745','0770','0261','0262'], commercial: ['1','2'], vacant: ['00'] },
  parse(f) {
    const p = parseParcel(f, this);
    if (p.sqft > 0 && p.totalValue > 0 && !p.buildingValue) {
      p.buildingValue = Math.max(p.totalValue - Math.round(p.totalValue * 0.3), 0);
      p.landValue = p.totalValue - p.buildingValue;
    } else if (!p.sqft && p.totalValue > 0) {
      p.landValue = p.totalValue;
    }
    return p;
  },
  zips: ['85253','85254','85262','85255','85268','85331','85251','85258','85260','85281','85224','85295','85206'],
};

MARKETS.NC = {
  key: 'NC', name: 'North Carolina', homeState: 'NC',
  url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/0/query',
  fields: 'ownname,ownfrst,ownlast,ownname2,siteadd,scity,sstate,szip,parval,improvval,landval,mailadd,mcity,mstate,mzip,gisacres,parusedesc,parusecode,saledate,parno,owntype,subdivisio,structyear,cntyname',
  max: 5000,
  zipWhere: (zip) => `szip='${zip}'`,
  fieldMap: { id:'parno', ownerName:'ownname', address:'siteadd', situsCity:'scity', situsZip:'szip', totalValue:'parval', buildingValue:'improvval', landValue:'landval', acres:'gisacres', subdivision:'subdivisio', yearBuilt:'structyear', saleDate:'saledate', mailAddress:'mailadd', mailCity:'mcity', mailState:'mstate', mailZip:'mzip' },
  propTypeRules: { style:'regex', field:'parusedesc', exemptRx:/EXEMPT|GOVERNMENT|COUNTY|STATE|FEDERAL|CHURCH|RELIGIOUS|SCHOOL|HOSPITAL|CEMETERY|LIBRARY|MUNICIPAL|CITY|PUBLIC/i, commercialRx:/COMMERCIAL|OFFICE|WAREHOUSE|STORE|RESTAURANT|RETAIL|INDUSTRIAL|MANUFACTURING|HOTEL|MOTEL/i, vacantRx:/^VACANT|UNDEVELOPED/i },
  parse(f) {
    const p = parseParcel(f, this);
    if (p.address && p.address.includes(' NC')) {
      const parts = p.address.split(/\s+(NC|CHARLOTTE|RALEIGH|DURHAM|GREENSBORO|WINSTON|ASHEVILLE|FAYETTEVILLE|CARY|WILMINGTON|GASTONIA|CONCORD|HUNTERSVILLE|CORNELIUS|MOORESVILLE|MATTHEWS|MINT HILL|PINEVILLE|INDIAN TRAIL)/i);
      if (parts[0]) p.address = parts[0].trim();
    }
    if (!p.cityStateZip || p.cityStateZip === ', ') {
      const city = (f.attributes?.scity || f.attributes?.cntyname || '').trim();
      p.cityStateZip = `${city}, NC ${f.attributes?.szip || ''}`;
    }
    if (!p.id) p.id = `NC-${(p.address||'').replace(/\s/g,'')}-${(p.ownerName||'').substring(0,10)}`;
    if (!p.buildingValue && p.totalValue > p.landValue) p.buildingValue = p.totalValue - p.landValue;
    return p;
  },
  zips: ['28202','28207','28209','28211','28226','28277','28270','28105','27613','27517','27707'],
};

MARKETS.FL_PB = {
  key: 'FL_PB', name: 'Palm Beach County, FL', homeState: 'FL',
  url: 'https://gis.pbcgov.org/arcgis/rest/services/Parcels/PARCEL_DETAILS_LABEL_PAPA/MapServer/13/query',
  fields: 'PARID,OWNER_NAME1,OWNER_NAME2,SITE_ADDR_STR,MUNICIPALITY,ZIP1,PADDR1,PADDR2,PADDR3,CITYNAME,STATE,TOTAL_VALUE,TOTAL_MARKET,LAND_MARKET,IMPRV_MRKT,ASSESSED_VAL,SALE_DATE,PRICE,ACRES,PROPERTY_USE,HMSTD_FLG,SUBDIV_NAME,YEAR_ADDED,MONTHS_SINCE_SALE,INSTRUMENT',
  max: 2000,
  zipWhere: (zip) => `ZIP1='${zip}'`,
  fieldMap: { id:'PARID', ownerName:['OWNER_NAME1','OWNER_NAME2'], address:'SITE_ADDR_STR', situsCity:'MUNICIPALITY', situsZip:'ZIP1', totalValue:['TOTAL_VALUE','TOTAL_MARKET','ASSESSED_VAL'], buildingValue:'IMPRV_MRKT', landValue:'LAND_MARKET', acres:'ACRES', yearBuilt:'YEAR_ADDED', subdivision:'SUBDIV_NAME', saleDate:'SALE_DATE', salePrice:'PRICE', mailAddress:'PADDR1', mailCity:'CITYNAME', mailState:'STATE', deedType:'INSTRUMENT' },
  propTypeRules: { style:'regex', field:'PROPERTY_USE', exemptRx:/MUNICIPAL|GOVERNMENT|COUNTY|STATE|FEDERAL|SCHOOL|CHURCH|RELIGIOUS|CEMETERY|HOSPITAL|LIBRARY/i, commercialRx:/STORE|OFFICE|WAREHOUSE|WAREH|RESTAURANT|AUTO|SERVICE STATION|LIGHT MFG|OPEN STORAGE|CLB|HOTEL|MOTEL|SHOPPING|BANK|THEATER|BOWLING|GOLF|MARINA|CAMP/i, vacantRx:/^VACANT/i },
  parse(f) {
    const p = parseParcel(f, this);
    if (!p.id) p.id = `PB-${(p.address||'').replace(/\s/g,'')}-${(p.ownerName||'').substring(0,10)}`;
    return p;
  },
  zips: ['33480','33486','33496','33432','33433','33487','33458','33408','33462','33434'],
};

MARKETS.FL_MD = {
  key: 'FL_MD', name: 'Miami-Dade County, FL', homeState: 'FL',
  url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaParcelView_gdb/FeatureServer/0/query',
  fields: 'TRUE_OWNER1,TRUE_OWNER2,TRUE_OWNER3,TRUE_SITE_ADDR,TRUE_SITE_CITY,TRUE_SITE_ZIP_CODE,TRUE_MAILING_ADDR1,TRUE_MAILING_ADDR2,TRUE_MAILING_ADDR3,TRUE_MAILING_CITY,TRUE_MAILING_STATE,TRUE_MAILING_ZIP_CODE,TRUE_MAILING_COUNTRY,ASSESSED_VAL_CUR,YEAR_BUILT,BEDROOM_COUNT,BATHROOM_COUNT,BUILDING_HEATED_AREA,SUBDIVISION,DOS_1,PRICE_1,DOR_CODE_CUR,DOR_DESC,LOT_SIZE,CONDO_FLAG,FOLIO',
  max: 2000,
  zipWhere: (zip) => `TRUE_SITE_ZIP_CODE LIKE '${zip}%'`,
  fieldMap: { id:'FOLIO', ownerName:['TRUE_OWNER1','TRUE_OWNER2','TRUE_OWNER3'], address:'TRUE_SITE_ADDR', situsCity:'TRUE_SITE_CITY', situsZip:'TRUE_SITE_ZIP_CODE', totalValue:'ASSESSED_VAL_CUR', buildingValue:null, landValue:null, yearBuilt:'YEAR_BUILT', livingSpace:'BUILDING_HEATED_AREA', subdivision:'SUBDIVISION', saleDate:'DOS_1', salePrice:'PRICE_1', mailAddress:'TRUE_MAILING_ADDR1', mailCity:'TRUE_MAILING_CITY', mailState:'TRUE_MAILING_STATE', mailZip:'TRUE_MAILING_ZIP_CODE' },
  propTypeRules: { style:'regex', field:'DOR_DESC', exemptRx:/GOVERNMENT|COUNTY|STATE|FEDERAL|CHURCH|RELIGIOUS|SCHOOL|HOSPITAL|CEMETERY|MUNICIPAL|CITY|MILITARY|PARKS/i, commercialRx:/STORE|OFFICE|WAREHOUSE|RESTAURANT|AUTO|HOTEL|MOTEL|SHOPPING|BANK|THEATER|PROFESSIONAL|COMMERCIAL|INDUSTRIAL/i, vacantRx:/^VACANT/i, residentialRx:/SINGLE FAMILY|CONDOMINIUM|DUPLEX|TRIPLEX|APARTMENT|TOWNHOUSE|MULTI.?FAMILY|MOBILE HOME|COOPERATIVE|RESIDENTIAL/i },
  parse(f) {
    const p = parseParcel(f, this);
    const a = f.attributes || {};
    if (!p.id) p.id = `MD-${(p.address||'').replace(/\s/g,'')}-${(p.ownerName||'').substring(0,10)}`;
    if (a.DOS_1 && !p.lastTransferYear) {
      const dos = String(a.DOS_1);
      if (dos.length >= 4) { const yr=parseInt(dos.substring(0,4)); if(yr>1900&&yr<=new Date().getFullYear()){p.lastTransferYear=yr;p.lastTransferDate=dos.substring(0,4)+'-'+(dos.substring(4,6)||'01')+'-'+(dos.substring(6,8)||'01');} }
    }
    if (a.PRICE_1 && a.PRICE_1 > 0) p.salePrice = a.PRICE_1;
    if (a.TRUE_SITE_ZIP_CODE) { p.cityStateZip = (a.TRUE_SITE_CITY||'Miami')+', FL '+String(a.TRUE_SITE_ZIP_CODE).split('-')[0]; }
    const heatedArea=parseFloat(a.BUILDING_HEATED_AREA)||0, bedrooms=parseInt(a.BEDROOM_COUNT)||0, yearBuilt=parseInt(a.YEAR_BUILT)||0;
    if (!p.buildingValue && p.totalValue > 0 && (heatedArea>0||bedrooms>0||yearBuilt>1800)) { p.buildingValue=Math.round(p.totalValue*0.7); p.landValue=p.totalValue-p.buildingValue; }
    if (heatedArea > 0) p.sqft = heatedArea;
    if (bedrooms > 0) p.bedrooms = bedrooms;
    return p;
  },
  zips: ['33139','33140','33131','33133','33134','33149','33156','33143'],
};

MARKETS.OR_DESCHUTES = {
  key: 'OR_DESCHUTES', name: 'Deschutes County, OR', homeState: 'OR',
  url: 'https://maps.deschutes.org/arcgis/rest/services/Dial2_Taxlots/MapServer/0/query',
  fields: 'Taxlot_Assessor_Account.TAXLOT,Taxlot_Assessor_Account.Address,Taxlot_Assessor_Account.City,Taxlot_Assessor_Account.Zip,Taxlot_Assessor_Account.Subdivision,dbo_GIS_MAILING.OWNER,dbo_GIS_MAILING.AGENT,dbo_GIS_MAILING.IN_CARE_OF,dbo_GIS_MAILING.M_ADDRESS,dbo_GIS_MAILING.M_CITY,dbo_GIS_MAILING.M_STATE,dbo_GIS_MAILING.M_ZIP,dbo_GIS_MAILING.ACCOUNT_ID',
  max: 200, noGeometry: true,
  zipWhere: (zip) => `Zip='${zip}'`,
  fieldMap: { id:'Taxlot_Assessor_Account.TAXLOT', ownerName:'dbo_GIS_MAILING.OWNER', address:'Taxlot_Assessor_Account.Address', situsCity:'Taxlot_Assessor_Account.City', situsZip:'Taxlot_Assessor_Account.Zip', totalValue:null, buildingValue:null, landValue:null, acres:null, subdivision:'Taxlot_Assessor_Account.Subdivision', mailAddress:'dbo_GIS_MAILING.M_ADDRESS', mailCity:'dbo_GIS_MAILING.M_CITY', mailState:'dbo_GIS_MAILING.M_STATE', mailZip:'dbo_GIS_MAILING.M_ZIP', inCareOf:'dbo_GIS_MAILING.IN_CARE_OF' },
  propTypeRules: { style: 'none' },
  parse(f) {
    const a = f.attributes || {};
    const flat = {};
    for (const [k, v] of Object.entries(a)) { const sk = k.includes('.') ? k.split('.').pop() : k; flat[sk] = v; flat[k] = v; }
    f.attributes = flat;
    const p = parseParcel(f, this);
    if (!p.cityStateZip || p.cityStateZip === ', ') { p.cityStateZip = `${(flat.City||'Bend').trim()}, OR ${flat.Zip||''}`; }
    if (!p.id) p.id = flat.TAXLOT || flat.ACCOUNT_ID || `OR-${(p.address||'').replace(/\s/g,'')}-${(p.ownerName||'').substring(0,10)}`;
    p.totalValue = 0; p.buildingValue = 0; p.landValue = 0;
    return p;
  },
  zips: ['97701','97702','97703','97707','97756','97759'],
};

function getAllZips() {
  const zips = [];
  for (const [mk, m] of Object.entries(MARKETS)) {
    if (!m.zipWhere) continue;
    for (const zip of m.zips) zips.push({ zip, marketKey: mk, marketName: m.name });
  }
  return zips;
}

function getMarketForZip(zip) {
  for (const [k, m] of Object.entries(MARKETS)) {
    if (m.zips.includes(zip)) return { key: k, ...m };
  }
  return null;
}

module.exports = { MARKETS, getAllZips, getMarketForZip };
