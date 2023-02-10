import { CacheSettings, Polyfills } from "./types/growthbook";
import { GrowthBook } from ".";
export declare function setPolyfills(overrides: Partial<Polyfills>): void;
export declare function configureCache(overrides: Partial<CacheSettings>): void;
export declare function clearCache(): Promise<void>;
export declare function refreshFeatures(instance: GrowthBook, timeout?: number, skipCache?: boolean, allowStale?: boolean, updateInstance?: boolean): Promise<void>;
export declare function subscribe(instance: GrowthBook): void;
export declare function unsubscribe(instance: GrowthBook): void;
//# sourceMappingURL=feature-repository.d.ts.map
