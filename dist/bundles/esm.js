// Config settings
const cacheSettings = {
  // Consider a fetch stale after 1 minute
  staleTTL: 1000 * 60,
  cacheKey: "gbFeaturesCache",
  backgroundSync: true
};
const polyfills = {
  fetch: globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined,
  SubtleCrypto: globalThis.crypto ? globalThis.crypto.subtle : undefined,
  EventSource: globalThis.EventSource
};
try {
  if (globalThis.localStorage) {
    polyfills.localStorage = globalThis.localStorage;
  }
} catch (e) {
  // Ignore localStorage errors
}

// Global state
const subscribedInstances = new Map();
let cacheInitialized = false;
const cache = new Map();
const activeFetches = new Map();
const streams = new Map();
const supportsSSE = new Set();

// Public functions
function setPolyfills(overrides) {
  Object.assign(polyfills, overrides);
}
function configureCache(overrides) {
  Object.assign(cacheSettings, overrides);
  if (!cacheSettings.backgroundSync) {
    clearAutoRefresh();
  }
}
async function clearCache() {
  cache.clear();
  activeFetches.clear();
  clearAutoRefresh();
  cacheInitialized = false;
  await updatePersistentCache();
}
async function refreshFeatures(instance, timeout, skipCache, allowStale, updateInstance) {
  const data = await fetchFeaturesWithCache(instance, allowStale, timeout, skipCache);
  updateInstance && data && (await setFeaturesOnInstance(instance, data));
}

// Subscribe a GrowthBook instance to feature changes
function subscribe(instance) {
  const [key] = getKey(instance);
  const subs = subscribedInstances.get(key) || new Set();
  subs.add(instance);
  subscribedInstances.set(key, subs);
}
function unsubscribe(instance) {
  subscribedInstances.forEach(s => s.delete(instance));
}

// Private functions
async function updatePersistentCache() {
  try {
    if (!polyfills.localStorage) return;
    await polyfills.localStorage.setItem(cacheSettings.cacheKey, JSON.stringify(Array.from(cache.entries())));
  } catch (e) {
    // Ignore localStorage errors
  }
}
async function fetchFeaturesWithCache(instance, allowStale, timeout, skipCache) {
  const [key] = getKey(instance);
  const now = new Date();
  await initializeCache();
  const existing = cache.get(key);
  if (existing && !skipCache && (allowStale || existing.staleAt > now)) {
    // Reload features in the backgroud if stale
    if (existing.staleAt < now) {
      fetchFeatures(instance);
    }
    // Otherwise, if we don't need to refresh now, start a background sync
    else {
      startAutoRefresh(instance);
    }
    return existing.data;
  } else {
    const data = await promiseTimeout(fetchFeatures(instance), timeout);
    return data;
  }
}
function getKey(instance) {
  const [apiHost, clientKey] = instance.getApiInfo();
  return ["".concat(apiHost, "||").concat(clientKey), apiHost, clientKey];
}

// Guarantee the promise always resolves within {timeout} ms
// Resolved value will be `null` when there's an error or it takes too long
// Note: The promise will continue running in the background, even if the timeout is hit
function promiseTimeout(promise, timeout) {
  return new Promise(resolve => {
    let resolved = false;
    let timer;
    const finish = data => {
      if (resolved) return;
      resolved = true;
      timer && clearTimeout(timer);
      resolve(data || null);
    };
    if (timeout) {
      timer = setTimeout(() => finish(), timeout);
    }
    promise.then(data => finish(data)).catch(() => finish());
  });
}

// Populate cache from localStorage (if available)
async function initializeCache() {
  if (cacheInitialized) return;
  cacheInitialized = true;
  try {
    if (polyfills.localStorage) {
      const value = await polyfills.localStorage.getItem(cacheSettings.cacheKey);
      if (value) {
        const parsed = JSON.parse(value);
        if (parsed && Array.isArray(parsed)) {
          parsed.forEach(_ref => {
            let [key, data] = _ref;
            cache.set(key, {
              ...data,
              staleAt: new Date(data.staleAt)
            });
          });
        }
      }
    }
  } catch (e) {
    // Ignore localStorage errors
  }
}

// Called whenever new features are fetched from the API
function onNewFeatureData(key, data) {
  // If contents haven't changed, ignore the update, extend the stale TTL
  const version = data.dateUpdated || "";
  const staleAt = new Date(Date.now() + cacheSettings.staleTTL);
  const existing = cache.get(key);
  if (existing && version && existing.version === version) {
    existing.staleAt = staleAt;
    return;
  }

  // Update in-memory cache
  cache.set(key, {
    data,
    version,
    staleAt
  });
  // Update local storage (don't await this, just update asynchronously)
  updatePersistentCache();

  // Update features for all subscribed GrowthBook instances
  const instances = subscribedInstances.get(key);
  instances && instances.forEach(instance => setFeaturesOnInstance(instance, data));
}
async function setFeaturesOnInstance(instance, data) {
  await (data.encryptedFeatures ? instance.setEncryptedFeatures(data.encryptedFeatures, undefined, polyfills.SubtleCrypto) : instance.setFeatures(data.features || instance.getFeatures()));
}
async function fetchFeatures(instance) {
  const [key, apiHost, clientKey] = getKey(instance);
  const endpoint = apiHost + "/api/features/" + clientKey;
  let promise = activeFetches.get(key);
  if (!promise) {
    promise = polyfills.fetch(endpoint)
    // TODO: auto-retry if status code indicates a temporary error
    .then(res => {
      if (res.headers.get("x-sse-support") === "enabled") {
        supportsSSE.add(key);
      }
      return res.json();
    }).then(data => {
      onNewFeatureData(key, data);
      startAutoRefresh(instance);
      activeFetches.delete(key);
      return data;
    }).catch(e => {
      activeFetches.delete(key);
      return Promise.resolve({});
    });
    activeFetches.set(key, promise);
  }
  return await promise;
}

// Watch a feature endpoint for changes
// Will prefer SSE if enabled, otherwise fall back to cron
function startAutoRefresh(instance) {
  const [key, apiHost, clientKey] = getKey(instance);
  if (cacheSettings.backgroundSync && supportsSSE.has(key) && polyfills.EventSource) {
    if (streams.has(key)) return;
    const channel = {
      src: new polyfills.EventSource("".concat(apiHost, "/sub/").concat(clientKey)),
      cb: event => {
        try {
          const json = JSON.parse(event.data);
          onNewFeatureData(key, json);
          // Reset error count on success
          channel.errors = 0;
        } catch (e) {
          onSSEError(channel, key);
        }
      },
      errors: 0
    };
    streams.set(key, channel);
    channel.src.addEventListener("features", channel.cb);
    channel.src.onerror = () => {
      onSSEError(channel, key);
    };
  }
}
function onSSEError(channel, key) {
  channel.errors++;
  if (channel.errors > 3 || channel.src.readyState === 2) {
    destroyChannel(channel, key);
  }
}
function destroyChannel(channel, key) {
  channel.src.onerror = null;
  channel.src.close();
  streams.delete(key);
}
function clearAutoRefresh() {
  // Clear list of which keys are auto-updated
  supportsSSE.clear();

  // Stop listening for any SSE events
  streams.forEach(destroyChannel);

  // Remove all references to GrowthBook instances
  subscribedInstances.clear();
}

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
    coverage = 0;
  } else if (coverage > 1) {
    coverage = 1;
  }

  // Default to equal weights if missing or invalid
  const equal = getEqualWeights(numVariations);
  weights = weights || equal;
  if (weights.length !== numVariations) {
    weights = equal;
  }

  // If weights don't add up to 1 (or close to it), default to equal weights
  const totalWeight = weights.reduce((w, sum) => sum + w, 0);
  if (totalWeight < 0.99 || totalWeight > 1.01) {
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

/* eslint-disable @typescript-eslint/no-explicit-any */

const _regexCache = {};

// The top-level condition evaluation function
function evalCondition(obj, condition) {
  // Recursive condition
  if ("$or" in condition) {
    return evalOr(obj, condition["$or"]);
  }
  if ("$nor" in condition) {
    return !evalOr(obj, condition["$nor"]);
  }
  if ("$and" in condition) {
    return evalAnd(obj, condition["$and"]);
  }
  if ("$not" in condition) {
    return !evalCondition(obj, condition["$not"]);
  }

  // Condition is an object, keys are object paths, values are the condition for that path
  for (const [k, v] of Object.entries(condition)) {
    if (!evalConditionValue(v, getPath(obj, k))) return false;
  }
  return true;
}

// Return value at dot-separated path of an object
function getPath(obj, path) {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length; i++) {
    if (current && typeof current === "object" && parts[i] in current) {
      current = current[parts[i]];
    } else {
      return null;
    }
  }
  return current;
}

// Transform a regex string into a real RegExp object
function getRegex(regex) {
  if (!_regexCache[regex]) {
    _regexCache[regex] = new RegExp(regex.replace(/([^\\])\//g, "$1\\/"));
  }
  return _regexCache[regex];
}

// Evaluate a single value against a condition
function evalConditionValue(condition, value) {
  // Simple equality comparisons
  if (typeof condition === "string") {
    return value + "" === condition;
  }
  if (typeof condition === "number") {
    return value * 1 === condition;
  }
  if (typeof condition === "boolean") {
    return !!value === condition;
  }
  if (Array.isArray(condition) || !isOperatorObject(condition)) {
    return JSON.stringify(value) === JSON.stringify(condition);
  }

  // This is a special operator condition and we should evaluate each one separately
  for (const op in condition) {
    if (!evalOperatorCondition(op, value, condition[op])) {
      return false;
    }
  }
  return true;
}

// If the object has only keys that start with '$'
function isOperatorObject(obj) {
  const keys = Object.keys(obj);
  return keys.length > 0 && keys.filter(k => k[0] === "$").length === keys.length;
}

// Return the data type of a value
function getType(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (["string", "number", "boolean", "object", "undefined"].includes(t)) {
    return t;
  }
  return "unknown";
}

// At least one element of actual must match the expected condition/value
function elemMatch(actual, expected) {
  if (!Array.isArray(actual)) return false;
  const check = isOperatorObject(expected) ? v => evalConditionValue(expected, v) : v => evalCondition(v, expected);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] && check(actual[i])) {
      return true;
    }
  }
  return false;
}

// Evaluate a single operator condition
function evalOperatorCondition(operator, actual, expected) {
  switch (operator) {
    case "$eq":
      return actual === expected;
    case "$ne":
      return actual !== expected;
    case "$lt":
      return actual < expected;
    case "$lte":
      return actual <= expected;
    case "$gt":
      return actual > expected;
    case "$gte":
      return actual >= expected;
    case "$exists":
      return expected ? actual !== null : actual === null;
    case "$in":
      return expected.includes(actual);
    case "$nin":
      return !expected.includes(actual);
    case "$not":
      return !evalConditionValue(expected, actual);
    case "$size":
      if (!Array.isArray(actual)) return false;
      return evalConditionValue(expected, actual.length);
    case "$elemMatch":
      return elemMatch(actual, expected);
    case "$all":
      if (!Array.isArray(actual)) return false;
      for (let i = 0; i < expected.length; i++) {
        let passed = false;
        for (let j = 0; j < actual.length; j++) {
          if (evalConditionValue(expected[i], actual[j])) {
            passed = true;
            break;
          }
        }
        if (!passed) return false;
      }
      return true;
    case "$regex":
      try {
        return getRegex(expected).test(actual);
      } catch (e) {
        return false;
      }
    case "$type":
      return getType(actual) === expected;
    default:
      console.error("Unknown operator: " + operator);
      return false;
  }
}

// Recursive $or rule
function evalOr(obj, conditions) {
  if (!conditions.length) return true;
  for (let i = 0; i < conditions.length; i++) {
    if (evalCondition(obj, conditions[i])) {
      return true;
    }
  }
  return false;
}

// Recursive $and rule
function evalAnd(obj, conditions) {
  for (let i = 0; i < conditions.length; i++) {
    if (!evalCondition(obj, conditions[i])) {
      return false;
    }
  }
  return true;
}

const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
const base64ToBuf = b => Uint8Array.from(atob(b), c => c.charCodeAt(0));
class GrowthBook {
  // context is technically private, but some tools depend on it so we can't mangle the name
  // _ctx below is a clone of this property that we use internally

  // Properties and methods that start with "_" are mangled by Terser (saves ~150 bytes)

  // eslint-disable-next-line

  constructor(context) {
    context = context || {};
    // These properties are all initialized in the constructor instead of above
    // This saves ~80 bytes in the final output
    this._ctx = this.context = context;
    this._renderer = null;
    this._trackedExperiments = new Set();
    this._trackedFeatures = {};
    this.debug = false;
    this._subscriptions = new Set();
    this._rtQueue = [];
    this._rtTimer = 0;
    this.ready = false;
    this._assigned = new Map();
    this._forcedFeatureValues = new Map();
    this._attributeOverrides = {};
    if (context.features) {
      this.ready = true;
    }
    if (isBrowser && context.enableDevMode) {
      window._growthbook = this;
      document.dispatchEvent(new Event("gbloaded"));
    }
    if (context.clientKey) {
      this._refresh({}, true, false);
    }
  }
  async loadFeatures(options) {
    await this._refresh(options, true, true);
    if (options && options.autoRefresh) {
      subscribe(this);
    }
  }
  async refreshFeatures(options) {
    await this._refresh(options, false, true);
  }
  getApiInfo() {
    return [(this._ctx.apiHost || "https://cdn.growthbook.io").replace(/\/*$/, ""), this._ctx.clientKey || ""];
  }
  async _refresh(options, allowStale, updateInstance) {
    options = options || {};
    if (!this._ctx.clientKey) {
      throw new Error("Missing clientKey");
    }
    await refreshFeatures(this, options.timeout, options.skipCache || this._ctx.enableDevMode, allowStale, updateInstance);
  }
  _render() {
    if (this._renderer) {
      this._renderer();
    }
  }
  setFeatures(features) {
    this._ctx.features = features;
    this.ready = true;
    this._render();
  }
  async setEncryptedFeatures(encryptedString, decryptionKey, subtle) {
    decryptionKey = decryptionKey || this._ctx.decryptionKey || "";
    subtle = subtle || globalThis.crypto && globalThis.crypto.subtle;
    if (!subtle) {
      throw new Error("No SubtleCrypto implementation found");
    }
    try {
      const key = await subtle.importKey("raw", base64ToBuf(decryptionKey), {
        name: "AES-CBC",
        length: 128
      }, true, ["encrypt", "decrypt"]);
      const [iv, cipherText] = encryptedString.split(".");
      const plainTextBuffer = await subtle.decrypt({
        name: "AES-CBC",
        iv: base64ToBuf(iv)
      }, key, base64ToBuf(cipherText));
      this.setFeatures(JSON.parse(new TextDecoder().decode(plainTextBuffer)));
    } catch (e) {
      throw new Error("Failed to decrypt features");
    }
  }
  setAttributes(attributes) {
    this._ctx.attributes = attributes;
    this._render();
  }
  setAttributeOverrides(overrides) {
    this._attributeOverrides = overrides;
    this._render();
  }
  setForcedVariations(vars) {
    this._ctx.forcedVariations = vars || {};
    this._render();
  }
  // eslint-disable-next-line
  setForcedFeatures(map) {
    this._forcedFeatureValues = map;
    this._render();
  }
  getAttributes() {
    return {
      ...this._ctx.attributes,
      ...this._attributeOverrides
    };
  }
  getFeatures() {
    return this._ctx.features || {};
  }
  subscribe(cb) {
    this._subscriptions.add(cb);
    return () => {
      this._subscriptions.delete(cb);
    };
  }
  getAllResults() {
    return new Map(this._assigned);
  }
  destroy() {
    // Release references to save memory
    this._subscriptions.clear();
    this._assigned.clear();
    this._trackedExperiments.clear();
    this._trackedFeatures = {};
    this._rtQueue = [];
    if (this._rtTimer) {
      clearTimeout(this._rtTimer);
    }
    unsubscribe(this);
    if (isBrowser && window._growthbook === this) {
      delete window._growthbook;
    }
  }
  setRenderer(renderer) {
    this._renderer = renderer;
  }
  forceVariation(key, variation) {
    this._ctx.forcedVariations = this._ctx.forcedVariations || {};
    this._ctx.forcedVariations[key] = variation;
    this._render();
  }
  run(experiment) {
    const result = this._run(experiment, null);
    this._fireSubscriptions(experiment, result);
    return result;
  }
  _fireSubscriptions(experiment, result) {
    const key = experiment.key;

    // If assigned variation has changed, fire subscriptions
    const prev = this._assigned.get(key);
    // TODO: what if the experiment definition has changed?
    if (!prev || prev.result.inExperiment !== result.inExperiment || prev.result.variationId !== result.variationId) {
      this._assigned.set(key, {
        experiment,
        result
      });
      this._subscriptions.forEach(cb => {
        try {
          cb(experiment, result);
        } catch (e) {
          console.error(e);
        }
      });
    }
  }
  _trackFeatureUsage(key, res) {
    // Don't track feature usage that was forced via an override
    if (res.source === "override") return;

    // Only track a feature once, unless the assigned value changed
    const stringifiedValue = JSON.stringify(res.value);
    if (this._trackedFeatures[key] === stringifiedValue) return;
    this._trackedFeatures[key] = stringifiedValue;

    // Fire user-supplied callback
    if (this._ctx.onFeatureUsage) {
      try {
        this._ctx.onFeatureUsage(key, res);
      } catch (e) {
        // Ignore feature usage callback errors
      }
    }

    // In browser environments, queue up feature usage to be tracked in batches
    if (!isBrowser || !window.fetch) return;
    this._rtQueue.push({
      key,
      on: res.on
    });
    if (!this._rtTimer) {
      this._rtTimer = window.setTimeout(() => {
        // Reset the queue
        this._rtTimer = 0;
        const q = [...this._rtQueue];
        this._rtQueue = [];

        // Skip logging if a real-time usage key is not configured
        if (!this._ctx.realtimeKey) return;
        window.fetch("https://rt.growthbook.io/?key=".concat(this._ctx.realtimeKey, "&events=").concat(encodeURIComponent(JSON.stringify(q))), {
          cache: "no-cache",
          mode: "no-cors"
        }).catch(() => {
          // TODO: retry in case of network errors?
        });
      }, this._ctx.realtimeInterval || 2000);
    }
  }
  _getFeatureResult(key, value, source, ruleId, experiment, result) {
    const ret = {
      value,
      on: !!value,
      off: !value,
      source,
      ruleId: ruleId || ""
    };
    if (experiment) ret.experiment = experiment;
    if (result) ret.experimentResult = result;

    // Track the usage of this feature in real-time
    this._trackFeatureUsage(key, ret);
    return ret;
  }
  isOn(key) {
    return this.evalFeature(key).on;
  }
  isOff(key) {
    return this.evalFeature(key).off;
  }
  getFeatureValue(key, defaultValue) {
    var _this$evalFeature$val;
    return (_this$evalFeature$val = this.evalFeature(key).value) !== null && _this$evalFeature$val !== void 0 ? _this$evalFeature$val : defaultValue;
  }

  // eslint-disable-next-line
  feature(id) {
    return this.evalFeature(id);
  }

  // eslint-disable-next-line
  evalFeature(id) {
    var _feature$defaultValue2;
    // Global override
    if (this._forcedFeatureValues.has(id)) {
      return this._getFeatureResult(id, this._forcedFeatureValues.get(id), "override");
    }

    // Unknown feature id
    if (!this._ctx.features || !this._ctx.features[id]) {
      return this._getFeatureResult(id, null, "unknownFeature");
    }

    // Get the feature
    const feature = this._ctx.features[id];

    // Loop through the rules
    if (feature.rules) {
      for (const rule of feature.rules) {
        // If it's a conditional rule, skip if the condition doesn't pass
        if (rule.condition && !this._conditionPasses(rule.condition)) {
          continue;
        }
        // Feature value is being forced
        if ("force" in rule) {
          // Skip if coverage is reduced and user not included
          if ("coverage" in rule) {
            const {
              hashValue
            } = this._getHashAttribute(rule.hashAttribute);
            if (!hashValue) {
              continue;
            }
            const n = hash(hashValue + id);
            if (n > rule.coverage) {
              continue;
            }
          }
          return this._getFeatureResult(id, rule.force, "force", rule.id);
        }
        if (!rule.variations) {
          continue;
        }
        // For experiment rules, run an experiment
        const exp = {
          variations: rule.variations,
          key: rule.key || id
        };
        if ("coverage" in rule) exp.coverage = rule.coverage;
        if (rule.weights) exp.weights = rule.weights;
        if (rule.hashAttribute) exp.hashAttribute = rule.hashAttribute;
        if (rule.namespace) exp.namespace = rule.namespace;

        // Only return a value if the user is part of the experiment
        const res = this._run(exp, id);
        this._fireSubscriptions(exp, res);
        if (res.inExperiment) {
          return this._getFeatureResult(id, res.value, "experiment", rule.id, exp, res);
        }
      }
    }

    // Fall back to using the default value
    return this._getFeatureResult(id, (_feature$defaultValue2 = feature.defaultValue) !== null && _feature$defaultValue2 !== void 0 ? _feature$defaultValue2 : null, "defaultValue");
  }
  _conditionPasses(condition) {
    return evalCondition(this.getAttributes(), condition);
  }
  _run(experiment, featureId) {
    var _experiment$coverage;
    const key = experiment.key;
    const numVariations = experiment.variations.length;

    // 1. If experiment has less than 2 variations, return immediately
    if (numVariations < 2) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 2. If the context is disabled, return immediately
    if (this._ctx.enabled === false) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 2.5. Merge in experiment overrides from the context
    experiment = this._mergeOverrides(experiment);

    // 3. If a variation is forced from a querystring, return the forced variation
    const qsOverride = getQueryStringOverride(key, this._getContextUrl(), numVariations);
    if (qsOverride !== null) {
      return this._getResult(experiment, qsOverride, false, featureId);
    }

    // 4. If a variation is forced in the context, return the forced variation
    if (this._ctx.forcedVariations && key in this._ctx.forcedVariations) {
      const variation = this._ctx.forcedVariations[key];
      return this._getResult(experiment, variation, false, featureId);
    }

    // 5. Exclude if a draft experiment or not active
    if (experiment.status === "draft" || experiment.active === false) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 6. Get the hash attribute and return if empty
    const {
      hashValue
    } = this._getHashAttribute(experiment.hashAttribute);
    if (!hashValue) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 7. Exclude if user not in experiment.namespace
    if (experiment.namespace && !inNamespace(hashValue, experiment.namespace)) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 7.5. Exclude if experiment.include returns false or throws
    if (experiment.include && !isIncluded(experiment.include)) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 8. Exclude if condition is false
    if (experiment.condition && !this._conditionPasses(experiment.condition)) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 8.1. Exclude if user is not in a required group
    if (experiment.groups && !this._hasGroupOverlap(experiment.groups)) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 8.2. Exclude if not on a targeted url
    if (experiment.url && !this._urlIsValid(experiment.url)) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 9. Get bucket ranges and choose variation
    const ranges = getBucketRanges(numVariations, (_experiment$coverage = experiment.coverage) !== null && _experiment$coverage !== void 0 ? _experiment$coverage : 1, experiment.weights);
    const n = hash(hashValue + key);
    const assigned = chooseVariation(n, ranges);

    // 10. Return if not in experiment
    if (assigned < 0) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 11. Experiment has a forced variation
    if ("force" in experiment) {
      var _experiment$force;
      return this._getResult(experiment, (_experiment$force = experiment.force) !== null && _experiment$force !== void 0 ? _experiment$force : -1, false, featureId);
    }

    // 12. Exclude if in QA mode
    if (this._ctx.qaMode) {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 12.5. Exclude if experiment is stopped
    if (experiment.status === "stopped") {
      return this._getResult(experiment, -1, false, featureId);
    }

    // 13. Build the result object
    const result = this._getResult(experiment, assigned, true, featureId);

    // 14. Fire the tracking callback
    this._track(experiment, result);
    return result;
  }
  log(msg, ctx) {
    if (!this.debug) return;
    if (this._ctx.log) this._ctx.log(msg, ctx);else console.log(msg, ctx);
  }
  _track(experiment, result) {
    if (!this._ctx.trackingCallback) return;
    const key = experiment.key;

    // Make sure a tracking callback is only fired once per unique experiment
    const k = result.hashAttribute + result.hashValue + key + result.variationId;
    if (this._trackedExperiments.has(k)) return;
    this._trackedExperiments.add(k);
    try {
      this._ctx.trackingCallback(experiment, result);
    } catch (e) {
      console.error(e);
    }
  }
  _mergeOverrides(experiment) {
    const key = experiment.key;
    const o = this._ctx.overrides;
    if (o && o[key]) {
      experiment = Object.assign({}, experiment, o[key]);
      if (typeof experiment.url === "string") {
        experiment.url = getUrlRegExp(
        // eslint-disable-next-line
        experiment.url);
      }
    }
    return experiment;
  }
  _getHashAttribute(attr) {
    const hashAttribute = attr || "id";
    let hashValue = "";
    if (this._attributeOverrides[hashAttribute]) {
      hashValue = this._attributeOverrides[hashAttribute];
    } else if (this._ctx.attributes) {
      hashValue = this._ctx.attributes[hashAttribute] || "";
    } else if (this._ctx.user) {
      hashValue = this._ctx.user[hashAttribute] || "";
    }
    return {
      hashAttribute,
      hashValue
    };
  }
  _getResult(experiment, variationIndex, hashUsed, featureId) {
    let inExperiment = true;
    // If assigned variation is not valid, use the baseline and mark the user as not in the experiment
    if (variationIndex < 0 || variationIndex >= experiment.variations.length) {
      variationIndex = 0;
      inExperiment = false;
    }
    const {
      hashAttribute,
      hashValue
    } = this._getHashAttribute(experiment.hashAttribute);
    return {
      featureId,
      inExperiment,
      hashUsed,
      variationId: variationIndex,
      value: experiment.variations[variationIndex],
      hashAttribute,
      hashValue
    };
  }
  _getContextUrl() {
    return this._ctx.url || (isBrowser ? window.location.href : "");
  }
  _urlIsValid(urlRegex) {
    const url = this._getContextUrl();
    if (!url) return false;
    const pathOnly = url.replace(/^https?:\/\//, "").replace(/^[^/]*\//, "/");
    if (urlRegex.test(url)) return true;
    if (urlRegex.test(pathOnly)) return true;
    return false;
  }
  _hasGroupOverlap(expGroups) {
    const groups = this._ctx.groups || {};
    for (let i = 0; i < expGroups.length; i++) {
      if (groups[expGroups[i]]) return true;
    }
    return false;
  }
}

export { GrowthBook, clearCache, configureCache, setPolyfills };
//# sourceMappingURL=esm.js.map
