'use strict';

const path = require('path');
const WrapperClass = require(path.join(__dirname, 'api-wrapper-mangadex.cjs'));
const SettingsClass = require(path.join(__dirname, 'api-settings-mangadex.cjs'));
const MapperClass = require(path.join(__dirname, 'mapper-mangadex.cjs'));
const { TRACKER_DTO_CONTRACT_VERSION } = require(path.join(__dirname, '..', 'trackerdtocontract.cjs'));

const serviceName = typeof WrapperClass.serviceName === 'string'
  ? WrapperClass.serviceName
  : 'mangadex';

module.exports = {
  serviceName,
  wrapperId: 'mangadex',
  dtoContractVersion: TRACKER_DTO_CONTRACT_VERSION,
  mapperEntry: 'apiwrappers/reg-mangadex/mapper-mangadex.cjs',
  supportsCoverSearch: true,
  supportsCoverDownload: true,
  supportsCoverUpload: false,
  maxUploadSize: null,
  acceptedMimeTypes: [],
  WrapperClass,
  MapperClass,
  SettingsClass,
};
