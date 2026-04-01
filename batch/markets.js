// SellerSignal — Market Source Configurations
// Synced from sellersignal-briefing.html source configs

const MARKETS = {};

MARKETS.MT = {
  key: 'MT', name: 'Montana', homeState: 'MT',
  url: 'https://gisservicemt.gov/arcgis/rest/services/MSDI_Framework/Parcels/MapServer/0/query',
  fields: 'OwnerName,AddressLine1,CityStateZip,TotalValue,TotalBuildingValue,TotalLandValue,PropType,GISAcres,Subdivision,OwnerAddress1,OwnerCity,OwnerState,OwnerZipCode,PARCELID',
  max: 2000,
  zipWhere: (zip) => `CityStateZip LIKE '%${zip}%'`,
  fieldMap: { id:'PARCELID', ownerName:'OwnerName', address:'AddressLine1', cityStateZip:'CityStateZip', totalValue:'TotalValue', buildingValue:'TotalBuildingValue', landValue:'TotalLandValue', acres:'GISAcres', subdivision:'Subdivision', mailAddress:'OwnerAddress1', mailCity:'OwnerCity', mailState:'OwnerState', mailZip:'OwnerZipCode' },
  zips: ['59718','59715','59716','59730','59714','59711'],
};

MARKETS.WA_KING = {
  key: 'WA_KING', name: 'King County, WA', homeState: 'WA',
  url: 'https://services.arcgis.com/Ej0PsM5Aw677QF1W/arcgis/rest/services/PARCEL_ADDRESS_PUB_AREA_3069/FeatureServer/0/query',
  fields: 'PAAUNIQUENAME,KCTP_ATTN,ADDR_FULL,CTYNAME,KCTP_ADDR,KCTP_CTYST,KCTP_STATE,APPRLNDVAL,APPR_IMPR,TAX_LNDVAL,TAX_IMPR,PLAT_NAME,KCA_ACRES,PREUSE_DESC,PIN,LAT,LON,ZIP5',
  max: 1000,
  zipWhere: (zip) => `ZIP5='${zip}'`,
  fieldMap: { id:'PIN', ownerName:['PAAUNIQUENAME','KCTP_ATTN'], address:'ADDR_FULL', situsCity:'CTYNAME', situsZip:'ZIP5', totalValue:null, buildingValue:['APPR_IMPR','TAX_IMPR'], landValue:['APPRLNDVAL','TAX_LNDVAL'], acres:'KCA_ACRES', subdivision:'PLAT_NAME', mailAddress:'KCTP_ADDR', mailCityStateZip:'KCTP_CTYST', mailState:'KCTP_STATE' },
  zips: ['98112','98004','98033','98040','98039','98074','98103','98109','98105','98199'],
};

MARKETS.OR_DESCHUTES = {
  key: 'OR_DESCHUTES', name: 'Bend, OR', homeState: 'OR',
  url: 'https://maps.deschutes.org/arcgis/rest/services/Dial2_Taxlots/MapServer/0/query',
  fields: 'Taxlot_Assessor_Account.TAXLOT,Taxlot_Assessor_Account.Address,Taxlot_Assessor_Account.City,Taxlot_Assessor_Account.Zip,Taxlot_Assessor_Account.Subdivision,dbo_GIS_MAILING.OWNER,dbo_GIS_MAILING.AGENT,dbo_GIS_MAILING.IN_CARE_OF,dbo_GIS_MAILING.M_ADDRESS,dbo_GIS_MAILING.M_CITY,dbo_GIS_MAILING.M_STATE,dbo_GIS_MAILING.M_ZIP,dbo_GIS_MAILING.ACCOUNT_ID',
  max: 200,
  zipWhere: (zip) => `Zip='${zip}'`,
  fieldMap: { id:'dbo_GIS_MAILING.ACCOUNT_ID', ownerName:'dbo_GIS_MAILING.OWNER', address:'Taxlot_Assessor_Account.Address', situsCity:'Taxlot_Assessor_Account.City', situsZip:'Taxlot_Assessor_Account.Zip', subdivision:'Taxlot_Assessor_Account.Subdivision', mailAddress:'dbo_GIS_MAILING.M_ADDRESS', mailCity:'dbo_GIS_MAILING.M_CITY', mailState:'dbo_GIS_MAILING.M_STATE', mailZip:'dbo_GIS_MAILING.M_ZIP' },
  zips: ['97701','97702','97703','97707','97756','97759'],
};

MARKETS.AZ_MARICOPA = {
  key: 'AZ_MARICOPA', name: 'Phoenix / Scottsdale, AZ', homeState: 'AZ',
  url: 'https://gis.mcassessor.maricopa.gov/arcgis/rest/services/MaricopaDynamicQueryService/MapServer/3/query',
  fields: 'APN,OWNER_NAME,PHYSICAL_ADDRESS,PHYSICAL_CITY,PHYSICAL_ZIP,MAIL_ADDRESS,MAIL_CITY,MAIL_STATE,MAIL_ZIP,FCV_CUR,LPV_CUR,LAND_SIZE,CONST_YEAR,LIVING_SPACE,DEED_DATE,SALE_DATE,SALE_PRICE,PUC,LATITUDE,LONGITUDE,INCAREOF,CITY_ZONING,SUBNAME,JURISDICTION',
  max: 1000,
  zipWhere: (zip) => `PHYSICAL_ZIP='${zip}'`,
  fieldMap: { id:'APN', ownerName:'OWNER_NAME', address:'PHYSICAL_ADDRESS', situsCity:'PHYSICAL_CITY', situsZip:'PHYSICAL_ZIP', totalValue:'FCV_CUR', landValue:'LPV_CUR', livingSpace:'LIVING_SPACE', yearBuilt:'CONST_YEAR', saleDate:'SALE_DATE', salePrice:'SALE_PRICE', subdivision:'SUBNAME', mailAddress:'MAIL_ADDRESS', mailCity:'MAIL_CITY', mailState:'MAIL_STATE', mailZip:'MAIL_ZIP' },
  acresIsSqft: true,
  zips: ['85253','85254','85262','85255','85268','85331','85251','85258','85260','85281','85224','85295','85206'],
};

MARKETS.TX_SA = {
  key: 'TX_SA', name: 'San Antonio, TX', homeState: 'TX',
  url: 'https://maps.bexar.org/arcgis/rest/services/Parcels/MapServer/0/query',
  fields: 'Owner,Situs,AddrLn2,AddrSt,Zip,LandVal,ImprVal,TotVal,PropUse,Acres,LglAcres,AcctNumb,YrBlt,Nbhd,DBA',
  max: 1000,
  zipWhere: null, // Bexar ZIP is mailing ZIP — needs spatial query, skip for now
  fieldMap: { id:'AcctNumb', ownerName:'Owner', address:'Situs', totalValue:'TotVal', buildingValue:'ImprVal', landValue:'LandVal', acres:'Acres', yearBuilt:'YrBlt', mailAddress:'AddrLn2', mailState:'AddrSt', mailZip:'Zip' },
  zips: ['78209','78255','78258','78230'],
};

MARKETS.NC = {
  key: 'NC', name: 'North Carolina', homeState: 'NC',
  url: 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/0/query',
  fields: 'ownname,ownfrst,ownlast,ownname2,siteadd,scity,sstate,szip,parval,improvval,landval,mailadd,mcity,mstate,mzip,gisacres,parusedesc,parusecode,saledate,parno,owntype,subdivisio,structyear,cntyname',
  max: 5000,
  zipWhere: (zip) => `szip='${zip}'`,
  fieldMap: { id:'parno', ownerName:'ownname', address:'siteadd', situsCity:'scity', situsZip:'szip', totalValue:'parval', buildingValue:'improvval', landValue:'landval', acres:'gisacres', subdivision:'subdivisio', yearBuilt:'structyear', saleDate:'saledate', mailAddress:'mailadd', mailCity:'mcity', mailState:'mstate', mailZip:'mzip' },
  zips: ['28202','28207','28209','28211','28226','28277','28270','28105','27609','27615','27613','27517','27707','28803','28804','28401'],
};

MARKETS.NY = {
  key: 'NY', name: 'New York State', homeState: 'NY',
  url: 'https://services6.arcgis.com/EbVsqZ18sv1kVJ3k/ArcGIS/rest/services/NYS_Tax_Parcels_Public/FeatureServer/1/query',
  fields: 'PRIMARY_OWNER,PARCEL_ADDR,LOC_STREET,LOC_ST_NBR,LOC_ZIP,MAIL_ADDR,MAIL_CITY,MAIL_STATE,MAIL_ZIP,TOTAL_AV,FULL_MARKET_VAL,LAND_AV,COUNTY_NAME,MUNI_NAME,CITYTOWN_NAME,PROP_CLASS,ACRES,CALC_ACRES,OWNER_TYPE,ROLL_YR,SQ_FT,YR_BLT',
  max: 1000,
  zipWhere: (zip) => `LOC_ZIP='${zip}'`,
  fieldMap: { id:null, ownerName:'PRIMARY_OWNER', address:['LOC_ST_NBR','LOC_STREET'], situsZip:'LOC_ZIP', totalValue:['FULL_MARKET_VAL','TOTAL_AV'], landValue:'LAND_AV', acres:'CALC_ACRES', sqft:'SQ_FT', yearBuilt:'YR_BLT', mailAddress:'MAIL_ADDR', mailCity:'MAIL_CITY', mailState:'MAIL_STATE', mailZip:'MAIL_ZIP' },
  zips: ['10021','10024','10014','10013','11201','10583','10504','11937','11976','12866'],
};

MARKETS.FL_PB = {
  key: 'FL_PB', name: 'Palm Beach County, FL', homeState: 'FL',
  url: 'https://gis.pbcgov.org/arcgis/rest/services/Parcels/PARCEL_DETAILS_LABEL_PAPA/MapServer/13/query',
  fields: 'PARID,OWNER_NAME1,OWNER_NAME2,SITE_ADDR_STR,MUNICIPALITY,ZIP1,PADDR1,PADDR2,PADDR3,CITYNAME,STATE,TOTAL_VALUE,TOTAL_MARKET,LAND_MARKET,IMPRV_MRKT,ASSESSED_VAL,SALE_DATE,PRICE,ACRES,PROPERTY_USE,HMSTD_FLG,SUBDIV_NAME,YEAR_ADDED,MONTHS_SINCE_SALE',
  max: 2000,
  zipWhere: (zip) => `ZIP1='${zip}'`,
  fieldMap: { id:'PARID', ownerName:['OWNER_NAME1','OWNER_NAME2'], address:'SITE_ADDR_STR', situsCity:'MUNICIPALITY', situsZip:'ZIP1', totalValue:['TOTAL_VALUE','TOTAL_MARKET','ASSESSED_VAL'], buildingValue:'IMPRV_MRKT', landValue:'LAND_MARKET', acres:'ACRES', yearBuilt:'YEAR_ADDED', subdivision:'SUBDIV_NAME', saleDate:'SALE_DATE', salePrice:'PRICE', mailAddress:'PADDR1', mailCity:'CITYNAME', mailState:'STATE' },
  zips: ['33480','33486','33496','33432','33433','33487','33458','33408','33462','33434'],
};

MARKETS.FL_MD = {
  key: 'FL_MD', name: 'Miami-Dade County, FL', homeState: 'FL',
  url: 'https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/PaParcelView_gdb/FeatureServer/0/query',
  fields: 'TRUE_OWNER1,TRUE_OWNER2,TRUE_OWNER3,TRUE_SITE_ADDR,TRUE_SITE_CITY,TRUE_SITE_ZIP_CODE,TRUE_MAILING_ADDR1,TRUE_MAILING_ADDR2,TRUE_MAILING_ADDR3,TRUE_MAILING_CITY,TRUE_MAILING_STATE,TRUE_MAILING_ZIP_CODE,TRUE_MAILING_COUNTRY,ASSESSED_VAL_CUR,YEAR_BUILT,BEDROOM_COUNT,BATHROOM_COUNT,BUILDING_HEATED_AREA,SUBDIVISION,DOS_1,PRICE_1,DOR_CODE_CUR,DOR_DESC,LOT_SIZE,CONDO_FLAG,FOLIO',
  max: 2000,
  zipWhere: (zip) => `TRUE_SITE_ZIP_CODE LIKE '${zip}%'`,
  fieldMap: { id:'FOLIO', ownerName:['TRUE_OWNER1','TRUE_OWNER2','TRUE_OWNER3'], address:'TRUE_SITE_ADDR', situsCity:'TRUE_SITE_CITY', situsZip:'TRUE_SITE_ZIP_CODE', totalValue:'ASSESSED_VAL_CUR', yearBuilt:'YEAR_BUILT', livingSpace:'BUILDING_HEATED_AREA', subdivision:'SUBDIVISION', saleDate:'DOS_1', salePrice:'PRICE_1', mailAddress:'TRUE_MAILING_ADDR1', mailCity:'TRUE_MAILING_CITY', mailState:'TRUE_MAILING_STATE', mailZip:'TRUE_MAILING_ZIP_CODE' },
  zips: ['33139','33140','33131','33133','33134','33149','33156','33143'],
};

function getAllZips() {
  const zips = [];
  for (const [mk, m] of Object.entries(MARKETS)) {
    if (!m.zipWhere) continue; // skip markets that need spatial queries
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
