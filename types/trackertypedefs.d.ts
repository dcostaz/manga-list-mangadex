export type TrackerServiceSettings = Record<string, unknown>;
export type TrackerCredentials = Record<string, string>;

export type TrackerReadingStatus =
  | 'READING'
  | 'COMPLETED'
  | 'PLAN_TO_READ'
  | 'ON_HOLD'
  | 'DROPPED'
  | 'RE_READING';

export interface TrackerUserProgress {
  chapter?: number;
  volume?: number;
  rating?: number;
  lastUpdated?: string;
  status?: TrackerReadingStatus;
}

export type CredentialsRequiredCallback = (
  details?: Record<string, unknown>
) =>
  | TrackerCredentials
  | null
  | undefined
  | Promise<TrackerCredentials | null | undefined>;

export interface TrackerHttpResponseInterceptorLike {
  use(
    onFulfilled: (response: unknown) => unknown,
    onRejected: (error: unknown) => Promise<never>
  ): unknown;
}

export interface TrackerHttpClientLike {
  interceptors?: {
    response?: TrackerHttpResponseInterceptorLike;
  };
  put?: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown; status?: number }>;
  get?: (
    url: string,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown; status?: number }>;
  post?: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown; status?: number }>;
  patch?: (
    url: string,
    data?: unknown,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown; status?: number }>;
  delete?: (
    url: string,
    config?: Record<string, unknown>
  ) => Promise<{ data?: unknown; status?: number }>;
}

export interface TrackerCacheAdapterLike {
  getValue(key: string): Promise<string | null>;
  setValue(key: string, value: string, ttlSeconds?: number): Promise<void>;
  deleteValue?(key: string): Promise<void>;
}

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
  onCredentialsRequired?: CredentialsRequiredCallback;
  httpClient?: TrackerHttpClientLike | null;
  cacheAdapter?: TrackerCacheAdapterLike | null;
}

export interface MangaDexAPIWrapperInitOptions {
  apiSettings?: MangaDexAPISettingsLike | null;
  serviceSettings?: TrackerServiceSettings;
  settingsPath?: string;
  onCredentialsRequired?: CredentialsRequiredCallback;
  httpClient?: TrackerHttpClientLike | null;
  httpClientFactory?: () => TrackerHttpClientLike;
  cacheAdapter?: TrackerCacheAdapterLike | null;
  cacheAdapterFactory?: () => TrackerCacheAdapterLike;
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