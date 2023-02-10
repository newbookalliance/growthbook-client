import { VariationRange } from "./types/growthbook";
export declare function hash(str: string): number;
export declare function getEqualWeights(n: number): number[];
export declare function inNamespace(hashValue: string, namespace: [string, number, number]): boolean;
export declare function chooseVariation(n: number, ranges: VariationRange[]): number;
export declare function getUrlRegExp(regexString: string): RegExp | undefined;
export declare function getBucketRanges(numVariations: number, coverage?: number, weights?: number[]): VariationRange[];
export declare function getQueryStringOverride(id: string, url: string, numVariations: number): number | null;
export declare function isIncluded(include: () => boolean): boolean;
//# sourceMappingURL=util.d.ts.map