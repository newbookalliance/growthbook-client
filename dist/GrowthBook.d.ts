import {
  ApiHost,
  Attributes,
  ClientKey,
  Context,
  Experiment,
  FeatureDefinition,
  FeatureResult,
  JSONValue,
  LoadFeaturesOptions,
  RefreshFeaturesOptions,
  Result,
  SubscriptionFunction,
  WidenPrimitives
} from './types/growthbook';

export declare class GrowthBook {
  private context;
  debug: boolean;
  ready: boolean;
  private _ctx;
  private _renderer;
  private _trackedExperiments;
  private _trackedFeatures;
  private _subscriptions;
  private _rtQueue;
  private _rtTimer;
  private _assigned;
  private _forcedFeatureValues;
  private _attributeOverrides;

  constructor(context?: Context);

  loadFeatures(options?: LoadFeaturesOptions): Promise<void>;

  refreshFeatures(options?: RefreshFeaturesOptions): Promise<void>;

  getApiInfo(): [ApiHost, ClientKey];

  private _refresh;
  private _render;

  setFeatures(features: Record<string, FeatureDefinition>): void;

  setEncryptedFeatures(encryptedString: string, decryptionKey?: string, subtle?: SubtleCrypto): Promise<void>;

  setAttributes(attributes: Attributes): void;

  setAttributeOverrides(overrides: Attributes): void;

  setForcedVariations(vars: Record<string, number>): void;

  setForcedFeatures(map: Map<string, any>): void;

  getAttributes(): {
    [x: string]: any;
  };

  getFeatures(): Record<string, FeatureDefinition<any>>;

  subscribe(cb: SubscriptionFunction): () => void;

  getAllResults(): Map<string, {
    experiment: Experiment<any>;
    result: Result<any>;
  }>;

  destroy(): void;

  setRenderer(renderer: () => void): void;

  forceVariation(key: string, variation: number): void;

  run<T>(experiment: Experiment<T>): Result<T>;

  private _fireSubscriptions;
  private _trackFeatureUsage;
  private _getFeatureResult;

  isOn(key: string): boolean;

  isOff(key: string): boolean;

  getFeatureValue<T extends JSONValue>(key: string, defaultValue: T): WidenPrimitives<T>;

  feature<T extends JSONValue = any>(id: string): FeatureResult<T | null>;

  evalFeature<T extends JSONValue = any>(id: string): FeatureResult<T | null>;

  private _conditionPasses;
  private _run;

  log(msg: string, ctx: Record<string, unknown>): void;

  private _track;
  private _mergeOverrides;
  private _getHashAttribute;
  private _getResult;
  private _getContextUrl;
  private _urlIsValid;
  private _hasGroupOverlap;
}

//# sourceMappingURL=GrowthBook.d.ts.map
