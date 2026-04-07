export type TrackerServiceSettings = Record<string, unknown>;

export interface MangaDexSettingsDocument {
  metadata: Record<string, unknown>;
  schema: Record<string, unknown>;
  settings: TrackerServiceSettings;
}

export interface MangaDexAPISettingsInitOptions {
  settingsPath?: string;
  defaultSettings?: TrackerServiceSettings;
}

export interface MangaDexAPISettingsConstructorParams {
  settings?: TrackerServiceSettings | MangaDexSettingsDocument;
  settingsPath?: string;
}

export interface MangaDexAPISettingsLike {
  componentName: string;
  toLegacyFormat(): TrackerServiceSettings;
}

export interface MangaDexAPIWrapperCtorParams {
  apiSettings?: MangaDexAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
}

export interface MangaDexAPIWrapperInitOptions {
  apiSettings?: MangaDexAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
}

export interface MangaDexRawSearchItem {
  id: string;
  title: string;
}

export interface MangaDexRawSearchResponse {
  trackerId: string;
  operation: string;
  payload: {
    data: MangaDexRawSearchItem[];
  };
}

export interface MangaDexRawEntityResponse {
  trackerId: string;
  operation: string;
  payload: Record<string, unknown>;
}

export interface MangaDexSeriesDetailDto {
  trackerId: string;
  source: string;
  title: string;
  alternativeTitles: string[];
  description: string | null;
  status: string | null;
  year: number | null;
  url: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MangaDexStatusDto {
  status?: string;
  chapter: number | null;
  volume: number | null;
  rating: number | null;
  lastUpdated: string | null;
}

export interface MangaDexTrackerModuleDescriptor {
  serviceName: string;
  wrapperId: string;
  dtoContractVersion: string;
  mapperEntry: string;
  supportsCoverSearch: boolean;
  supportsCoverDownload: boolean;
  supportsCoverUpload: boolean;
  maxUploadSize: number | null;
  acceptedMimeTypes: string[];
  WrapperClass: Function;
  MapperClass: Function;
  SettingsClass: Function;
}