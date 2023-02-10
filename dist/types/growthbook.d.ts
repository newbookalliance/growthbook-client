import { GrowthBook } from "..";
import { ConditionInterface } from "./mongrule";
declare global {
    interface Window {
        _growthbook?: GrowthBook;
    }
}
export declare type FeatureRule<T = any> = {
    id?: string;
    condition?: ConditionInterface;
    force?: T;
    variations?: T[];
    weights?: number[];
    key?: string;
    hashAttribute?: string;
    coverage?: number;
    namespace?: [string, number, number];
};
export interface FeatureDefinition<T = any> {
    defaultValue?: T;
    rules?: FeatureRule<T>[];
}
export declare type FeatureResultSource = "unknownFeature" | "defaultValue" | "force" | "override" | "experiment";
export interface FeatureResult<T = any> {
    value: T | null;
    source: FeatureResultSource;
    on: boolean;
    off: boolean;
    ruleId: string;
    experiment?: Experiment<T>;
    experimentResult?: Result<T>;
}
export declare type ExperimentStatus = "draft" | "running" | "stopped";
export declare type Experiment<T> = {
    key: string;
    variations: T[];
    weights?: number[];
    condition?: ConditionInterface;
    coverage?: number;
    include?: () => boolean;
    namespace?: [string, number, number];
    force?: number;
    hashAttribute?: string;
    active?: boolean;
    status?: ExperimentStatus;
    url?: RegExp;
    groups?: string[];
};
export declare type ExperimentOverride = {
    condition?: ConditionInterface;
    weights?: number[];
    active?: boolean;
    status?: ExperimentStatus;
    force?: number;
    coverage?: number;
    groups?: string[];
    namespace?: [string, number, number];
    url?: RegExp | string;
};
export interface Result<T> {
    value: T;
    variationId: number;
    inExperiment: boolean;
    hashUsed?: boolean;
    hashAttribute: string;
    hashValue: string;
    featureId: string | null;
}
export declare type Attributes = Record<string, any>;
export declare type RealtimeUsageData = {
    key: string;
    on: boolean;
};
export interface Context {
    enabled?: boolean;
    attributes?: Attributes;
    url?: string;
    features?: Record<string, FeatureDefinition>;
    forcedVariations?: Record<string, number>;
    log?: (msg: string, ctx: any) => void;
    qaMode?: boolean;
    enableDevMode?: boolean;
    disableDevTools?: boolean;
    trackingCallback?: (experiment: Experiment<any>, result: Result<any>) => void;
    onFeatureUsage?: (key: string, result: FeatureResult<any>) => void;
    realtimeKey?: string;
    realtimeInterval?: number;
    user?: {
        id?: string;
        anonId?: string;
        [key: string]: string | undefined;
    };
    overrides?: Record<string, ExperimentOverride>;
    groups?: Record<string, boolean>;
    apiHost?: string;
    clientKey?: string;
    decryptionKey?: string;
}
export declare type SubscriptionFunction = (experiment: Experiment<any>, result: Result<any>) => void;
export declare type VariationRange = [number, number];
export declare type JSONValue = null | number | string | boolean | Array<JSONValue> | {
    [key: string]: JSONValue;
};
export declare type WidenPrimitives<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T;
export declare type FeatureDefinitions = Record<string, FeatureDefinition>;
export declare type FeatureApiResponse = {
    features?: FeatureDefinitions;
    dateUpdated?: string;
    encryptedFeatures?: string;
};
export declare type Polyfills = {
    fetch: any;
    SubtleCrypto: any;
    EventSource: any;
    localStorage?: LocalStorageCompat;
};
export interface LocalStorageCompat {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
}
export declare type CacheSettings = {
    backgroundSync: boolean;
    cacheKey: string;
    staleTTL: number;
};
export declare type ApiHost = string;
export declare type ClientKey = string;
export declare type RepositoryKey = string;
export declare type LoadFeaturesOptions = {
    autoRefresh?: boolean;
    timeout?: number;
    skipCache?: boolean;
};
export declare type RefreshFeaturesOptions = {
    timeout?: number;
    skipCache?: boolean;
};
//# sourceMappingURL=growthbook.d.ts.map
