"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.chooseVariation = chooseVariation;
exports.getBucketRanges = getBucketRanges;
exports.getEqualWeights = getEqualWeights;
exports.getQueryStringOverride = getQueryStringOverride;
exports.getUrlRegExp = getUrlRegExp;
exports.hash = hash;
exports.inNamespace = inNamespace;
exports.isIncluded = isIncluded;
function hashFnv32a(str) {
  let hval = 0x811c9dc5;
  const l = str.length;
  for (let i = 0; i < l; i++) {
    hval ^= str.charCodeAt(i);
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
  }
  return hval >>> 0;
}
function hash(str) {
  return hashFnv32a(str) % 1000 / 1000;
}
function getEqualWeights(n) {
  if (n <= 0) return [];
  return new Array(n).fill(1 / n);
}
function inNamespace(hashValue, namespace) {
  const n = hash(hashValue + "__" + namespace[0]);
  return n >= namespace[1] && n < namespace[2];
}
function chooseVariation(n, ranges) {
  for (let i = 0; i < ranges.length; i++) {
    if (n >= ranges[i][0] && n < ranges[i][1]) {
      return i;
    }
  }
  return -1;
}
function getUrlRegExp(regexString) {
  try {
    const escaped = regexString.replace(/([^\\])\//g, "$1\\/");
    return new RegExp(escaped);
  } catch (e) {
    console.error(e);
    return undefined;
  }
}
function getBucketRanges(numVariations) {
  let coverage = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
  let weights = arguments.length > 2 ? arguments[2] : undefined;
  // Make sure coverage is within bounds
  if (coverage < 0) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Experiment.coverage must be greater than or equal to 0");
    }
    coverage = 0;
  } else if (coverage > 1) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Experiment.coverage must be less than or equal to 1");
    }
    coverage = 1;
  }

  // Default to equal weights if missing or invalid
  const equal = getEqualWeights(numVariations);
  weights = weights || equal;
  if (weights.length !== numVariations) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Experiment.weights array must be the same length as Experiment.variations");
    }
    weights = equal;
  }

  // If weights don't add up to 1 (or close to it), default to equal weights
  const totalWeight = weights.reduce((w, sum) => sum + w, 0);
  if (totalWeight < 0.99 || totalWeight > 1.01) {
    if (process.env.NODE_ENV !== "production") {
      console.error("Experiment.weights must add up to 1");
    }
    weights = equal;
  }

  // Covert weights to ranges
  let cumulative = 0;
  return weights.map(w => {
    const start = cumulative;
    cumulative += w;
    return [start, start + coverage * w];
  });
}
function getQueryStringOverride(id, url, numVariations) {
  if (!url) {
    return null;
  }
  const search = url.split("?")[1];
  if (!search) {
    return null;
  }
  const match = search.replace(/#.*/, "") // Get rid of anchor
  .split("&") // Split into key/value pairs
  .map(kv => kv.split("=", 2)).filter(_ref => {
    let [k] = _ref;
    return k === id;
  }) // Look for key that matches the experiment id
  .map(_ref2 => {
    let [, v] = _ref2;
    return parseInt(v);
  }); // Parse the value into an integer

  if (match.length > 0 && match[0] >= 0 && match[0] < numVariations) return match[0];
  return null;
}
function isIncluded(include) {
  try {
    return include();
  } catch (e) {
    console.error(e);
    return false;
  }
}
//# sourceMappingURL=util.js.map