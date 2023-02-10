"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.clearCache = clearCache;
exports.configureCache = configureCache;
exports.refreshFeatures = refreshFeatures;
exports.setPolyfills = setPolyfills;
exports.subscribe = subscribe;
exports.unsubscribe = unsubscribe;
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
      process.env.NODE_ENV !== "production" && instance.log("Error fetching features", {
        apiHost,
        clientKey,
        error: e ? e.message : null
      });
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
          process.env.NODE_ENV !== "production" && instance.log("SSE Error", {
            apiHost,
            clientKey,
            error: e ? e.message : null
          });
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
//# sourceMappingURL=feature-repository.js.map