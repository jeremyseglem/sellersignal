// SellerSignal — Market Source Configurations
// Extracted from sellersignal-briefing.html for use in batch pipeline
// Each source defines: GIS endpoint, field mapping, parsing, market profile

const MARKETS = {};

// =============================================
// HELPER: Standard ArcGIS query builder
// =============================================
function arcgisQuery(url, where, fields, max = 2000) {
  const params = new URLSearchParams({
    where, outFields: fields, returnGeometry: 'true', outSR: '4326',
    f: 'json', resultRecordCount: String(max),
  });
  return `${url}?${params}`;
}

// =============================================
// MONTANA
// =============================================
MARKETS.MT = {
  key: 'MT', name: 'Montana', homeState: 'MT',
  url: 'https://svc.mt.gov/msl/arcgis/rest/services/MSDI_Framework/MSDI_CadastralFramework/MapServer/9/query',
  fields: 'PropertyID,OwnerName,OwnerAddress,OwnerCityStateZip,FullAddress,CountyName,TotalMarketValue,TotalAcres,PropType,LegalDescFull',
  max: 4000,
  fieldMap: {
    id: 'PropertyID', ownerName: 'OwnerName', address: 'FullAddress',
    totalValue: 'TotalMarketValue', buildingValue: null, landValue: null,
    acres: 'TotalAcres',
    mailAddress: 'OwnerAddress', mailCityStateZip: 'OwnerCityStateZip',
  },
  propTypeField: 'PropType',
  zips: ['59718','59715','59716','59730','59714','59711'],
  marketProfile: 'Non-disclosure state — no sale prices or dates in public records. Ranch and recreational property dominant.',
};

// =============================================
// KING COUNTY, WA
// =============================================
MARKETS.WA_KING = {
  key: 'WA_KING', name: 'King County, WA', homeState: 'WA',
  url: 'https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_Parcels/MapServer/1/query',
  fields: 'PIN,TAXPAYER_NAME,ADDR_FULL,CTYNAME,ZIPCODE,APPRLNDVAL,APPR_IMPR,TAX_LNDVAL,TAX_IMPR,TAX_STAT,PROP_TYPE,LEVY_JURIS,KCTP_NAME,LOTSQFT',
  max: 5000,
  fieldMap: {
    id: 'PIN', ownerName: 'TAXPAYER_NAME', address: 'ADDR_FULL',
    situsCity: 'CTYNAME', situsZip: 'ZIPCODE',
    totalValue: null, buildingValue: ['APPR_IMPR','TAX_IMPR'], landValue: ['APPRLNDVAL','TAX_LNDVAL'],
  },
  zips: ['98112','98004','98033','98040','98039','98074','98103','98109','98105','98199'],
  marketProfile: 'Tech-driven market dominated by Amazon, Microsoft, Meta, Google employees.',
};

// =============================================
// BEND, OR (DESCHUTES COUNTY)
// =============================================
MARKETS.OR_DESCHUTES = {
  key: 'OR_DESCHUTES', name: 'Bend, OR', homeState: 'OR',
  url: 'https://services.arcgis.com/PmGCiVTaAMjab7mh/arcgis/rest/services/Deschutes_Parcels_Public/FeatureServer/0/query',
  fields: 'Account,Owner1,Owner2,MailAddr,MailCity,MailSt,MailZip,SitusAddress,SitusCity,SitusZip,TotVal,ImprVal,LandVal,StatClass,LegalAcres,BldgSqFt,YrBuilt,SaleDate,SalePrice,Subdivision',
  max: 5000,
  fieldMap: {
    id: 'Account', ownerName: ['Owner1','Owner2'], address: 'SitusAddress',
    situsCity: 'SitusCity', situsZip: 'SitusZip',
    totalValue: 'TotVal', buildingValue: 'ImprVal', landValue: 'LandVal',
    acres: 'LegalAcres', livingSpace: 'BldgSqFt', yearBuilt: 'YrBuilt',
    saleDate: 'SaleDate', salePrice: 'SalePrice', subdivision: 'Subdivision',
    mailAddress: 'MailAddr', mailCity: 'MailCity', mailState: 'MailSt', mailZip: 'MailZip',
  },
  zips: ['97701','97702','97703','97707','97756','97759'],
  marketProfile: 'Outdoor lifestyle market with heavy Californian in-migration.',
};

// =============================================
// MARICOPA COUNTY, AZ (Phoenix/Scottsdale)
// =============================================
MARKETS.AZ_MARICOPA = {
  key: 'AZ_MARICOPA', name: 'Phoenix / Scottsdale, AZ', homeState: 'AZ',
  url: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/ParcelWLayers/MapServer/0/query',
  fields: 'APN,OWNER_NAME,OWNER_NAME2,PROP_ADDR,CITY,ZIP_CODE,MAIL_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP,FCV_CUR,LAND_SIZE,LOT_SQ_FT,YEAR_BUILT,LIVING_AREA,BED_ROOMS,BATH_ROOMS,MCR_DESC,SALE_DATE,SALE_PRICE,SUBDIVISION',
  max: 5000,
  fieldMap: {
    id: 'APN', ownerName: ['OWNER_NAME','OWNER_NAME2'], address: 'PROP_ADDR',
    situsCity: 'CITY', situsZip: 'ZIP_CODE',
    totalValue: 'FCV_CUR', buildingValue: null, landValue: null,
    acres: 'LAND_SIZE', livingSpace: 'LIVING_AREA', yearBuilt: 'YEAR_BUILT',
    saleDate: 'SALE_DATE', salePrice: 'SALE_PRICE', subdivision: 'SUBDIVISION',
    mailAddress: 'MAIL_ADDR', mailCity: 'MAIL_CITY', mailState: 'MAIL_STATE', mailZip: 'MAIL_ZIP',
  },
  acresIsSqft: true,
  zips: ['85253','85254','85262','85255','85268','85331','85251','85258','85260','85281','85224','85295','85206'],
  marketProfile: 'Snowbird capital — massive seasonal ownership from Midwest and Canada.',
};

// =============================================
// SAN ANTONIO, TX (BEXAR COUNTY)
// =============================================
MARKETS.TX_SA = {
  key: 'TX_SA', name: 'San Antonio, TX', homeState: 'TX',
  url: 'https://bexar.trueautomation.com/arcgis/rest/services/Bexar/TAProperty/MapServer/0/query',
  fields: 'prop_id,owner_name,addr1,legal_desc,situs_addr,situs_city,situs_zip,market_value,impr_val,land_val,deed_date',
  max: 5000,
  fieldMap: {
    id: 'prop_id', ownerName: 'owner_name', address: 'situs_addr',
    situsCity: 'situs_city', situsZip: 'situs_zip',
    totalValue: 'market_value', buildingValue: 'impr_val', landValue: 'land_val',
    saleDate: 'deed_date',
    mailAddress: 'addr1',
  },
  zips: ['78209','78255','78258','78230'],
  marketProfile: 'Military-heavy market with strong appreciation in NW corridor.',
};

// =============================================
// NORTH CAROLINA (STATEWIDE)
// =============================================
MARKETS.NC = {
  key: 'NC', name: 'North Carolina', homeState: 'NC',
  url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/0/query',
  fields: 'ownname,ownfrst,ownlast,ownname2,siteadd,scity,sstate,szip,parval,improvval,landval,mailadd,mcity,mstate,mzip,gisacres,parusedesc,parusecode,saledate,parno,owntype,subdivisio,structyear,cntyname',
  max: 5000,
  fieldMap: {
    id: 'parno', ownerName: 'ownname', address: 'siteadd',
    situsCity: 'scity', situsZip: 'szip',
    totalValue: 'parval', buildingValue: 'improvval', landValue: 'landval',
    acres: 'gisacres', subdivision: 'subdivisio', yearBuilt: 'structyear',
    saleDate: 'saledate',
    mailAddress: 'mailadd', mailCity: 'mcity', mailState: 'mstate', mailZip: 'mzip',
  },
  zips: ['28202','28207','28209','28211','28226','28277','28270','28105','27609','27615','27613','27517','27707','28803','28804','28401'],
  marketProfile: 'Traditional Southern market with rapid growth in Charlotte banking corridor and Research Triangle.',
};

// =============================================
// NEW YORK (STATEWIDE)
// =============================================
MARKETS.NY = {
  key: 'NY', name: 'New York', homeState: 'NY',
  url: 'https://gis.ny.gov/arcgis/rest/services/CUGIR_parcels/MapServer/0/query',
  fields: 'SWIS_PRINT_KEY,NAME,ADDR1,ADDR2,CALC_ACRES,FULL_MARKET_VAL,TOTAL_AV,LAND_AV,FRONT,DEPTH,PROP_CLASS,SCHOOL_NAME,MUNI_NAME',
  max: 5000,
  fieldMap: {
    id: 'SWIS_PRINT_KEY', ownerName: 'NAME', address: 'ADDR1',
    totalValue: ['FULL_MARKET_VAL','TOTAL_AV'], buildingValue: null, landValue: 'LAND_AV',
    acres: 'CALC_ACRES',
    mailAddress: 'ADDR2',
  },
  zips: ['10021','10024','10014','10013','11201','10583','10504','11937','11976','12866'],
  marketProfile: 'Extreme value density. NYC co-ops and condos, Westchester estates, Hamptons seasonal.',
};

// =============================================
// PALM BEACH COUNTY, FL
// =============================================
MARKETS.FL_PB = {
  key: 'FL_PB', name: 'Palm Beach County, FL', homeState: 'FL',
  url: 'https://gis.pbcgov.org/arcgis/rest/services/Parcels/PARCEL_DETAILS_LABEL_PAPA/MapServer/13/query',
  fields: 'PARID,OWNER_NAME1,OWNER_NAME2,SITE_ADDR_STR,MUNICIPALITY,ZIP1,PADDR1,PADDR2,PADDR3,CITYNAME,STATE,TOTAL_VALUE,TOTAL_MARKET,LAND_MARKET,IMPRV_MRKT,ASSESSED_VAL,SALE_DATE,PRICE,ACRES,PROPERTY_USE,HMSTD_FLG,SUBDIV_NAME,YEAR_ADDED,MONTHS_SINCE_SALE',
  max: 2000,
  fieldMap: {
    id: 'PARID', ownerName: ['OWNER_NAME1','OWNER_NAME2'], address: 'SITE_ADDR_STR',
    situsCity: 'MUNICIPALITY', situsZip: 'ZIP1',
    totalValue: ['TOTAL_VALUE','TOTAL_MARKET','ASSESSED_VAL'], buildingValue: 'IMPRV_MRKT', landValue: 'LAND_MARKET',
    acres: 'ACRES', yearBuilt: 'YEAR_ADDED', subdivision: 'SUBDIV_NAME',
    saleDate: 'SALE_DATE', salePrice: 'PRICE',
    mailAddress: 'PADDR1', mailCity: 'CITYNAME', mailState: 'STATE',
  },
  zips: ['33480','33486','33496','33432','33433','33487','33458','33408','33462','33434'],
  marketProfile: 'Ultra-high-net-worth estate planning market. Trust ownership is baseline, not signal.',
};

// =============================================
// MIAMI-DADE COUNTY, FL
// =============================================
MARKETS.FL_MD = {
  key: 'FL_MD', name: 'Miami-Dade County, FL', homeState: 'FL',
  url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaParcelView_gdb/FeatureServer/0/query',
  fields: 'TRUE_OWNER1,TRUE_OWNER2,TRUE_OWNER3,TRUE_SITE_ADDR,TRUE_SITE_CITY,TRUE_SITE_ZIP_CODE,TRUE_MAILING_ADDR1,TRUE_MAILING_ADDR2,TRUE_MAILING_ADDR3,TRUE_MAILING_CITY,TRUE_MAILING_STATE,TRUE_MAILING_ZIP_CODE,TRUE_MAILING_COUNTRY,ASSESSED_VAL_CUR,YEAR_BUILT,BEDROOM_COUNT,BATHROOM_COUNT,BUILDING_HEATED_AREA,SUBDIVISION,DOS_1,PRICE_1,DOR_CODE_CUR,DOR_DESC,LOT_SIZE,CONDO_FLAG,FOLIO',
  max: 2000,
  fieldMap: {
    id: 'FOLIO', ownerName: ['TRUE_OWNER1','TRUE_OWNER2','TRUE_OWNER3'], address: 'TRUE_SITE_ADDR',
    situsCity: 'TRUE_SITE_CITY', situsZip: 'TRUE_SITE_ZIP_CODE',
    totalValue: 'ASSESSED_VAL_CUR', buildingValue: null, landValue: null,
    yearBuilt: 'YEAR_BUILT', subdivision: 'SUBDIVISION', livingSpace: 'BUILDING_HEATED_AREA',
    saleDate: 'DOS_1', salePrice: 'PRICE_1',
    mailAddress: 'TRUE_MAILING_ADDR1', mailCity: 'TRUE_MAILING_CITY', mailState: 'TRUE_MAILING_STATE', mailZip: 'TRUE_MAILING_ZIP_CODE',
  },
  zips: ['33139','33140','33131','33133','33134','33149','33156','33143'],
  marketProfile: 'International luxury market with massive foreign ownership.',
};

// =============================================
// AGGREGATE: all ZIP codes across all markets
// =============================================
function getAllZips() {
  const zips = [];
  for (const [marketKey, market] of Object.entries(MARKETS)) {
    for (const zip of market.zips) {
      zips.push({ zip, marketKey, marketName: market.name });
    }
  }
  return zips;
}

function getMarketForZip(zip) {
  for (const [key, market] of Object.entries(MARKETS)) {
    if (market.zips.includes(zip)) return { key, ...market };
  }
  return null;
}

module.exports = { MARKETS, getAllZips, getMarketForZip };
