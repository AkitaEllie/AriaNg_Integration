"use strict";

const ICONS = {
  off: "icons/icon_off.svg",
  idle: "icons/icon_idle.svg",
  active: "icons/icon_active.svg",
  error: "icons/icon_err.svg",
};

let currentIcon = null;
let extensionError = false;

const DEFAULT_SETTINGS = {
  initialize: false,
  contextMenu: true,
  enabled: false,
};

let currentSettings = null;
let listenersAttached = false;
let badgeIntervalId = null;

const requestHeadersByRequestId = new Map();
const requestMetaByRequestId = new Map();
const trackedDownloads = new Map();
const rpcPendingById = new Map();

let rpcSocket = null;
let rpcSocketReady = null;
let rpcReconnectTimer = null;
let rpcRequestCounter = 0;
let currentRpcSettings = null;
let lastDownloadStats = null;
let lastCompletedDownload = null;

/**
 * Triggers a native system alert notification banner.
 */
function notify(title, message) {
  return browser.notifications
    .create({
      type: "basic",
      iconUrl: ICONS.idle,
      title: title,
      message: String(message),
    })
    .catch(() => {});
}

/**
 * Updates the toolbar icon based on the current extension state.
 * States: off (disabled), idle (enabled, no downloads), active (downloading), error (RPC/extension error).
 */
function updateIcon(state) {
  const icon = ICONS[state];
  if (!icon || icon === currentIcon) return;
  currentIcon = icon;
  browser.browserAction.setIcon({ path: icon }).catch(() => {});
}

/**
 * Reads extension preferences from storage into the local cache.
 * Returns the cached settings object.
 */
function readSettings() {
  return browser.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
    return currentSettings;
  });
}

/**
 * Persists settings to extension storage and updates the local cache.
 * Partial updates are merged with the current cached values.
 */
function saveSettings(partial) {
  const updated = { ...currentSettings, ...partial };
  return browser.storage.local.set(updated).then(() => {
    currentSettings = updated;
    return currentSettings;
  });
}

/**
 * Robustly decodes standard and URL-safe Base64 strings into UTF-8 text.
 */
function decodeBase64Text(value) {
  if (!value) return "";
  const normalized = String(value)
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/\s+/g, "");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binaryString = atob(padded);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    console.debug(
      "String is not valid base64 payload, returning raw input stream fallback.",
    );
    return String(value);
  }
}

function normalizeRpcProtocol(protocol) {
  const p = String(protocol || "")
    .toLowerCase()
    .trim();
  return p === "wss" || p === "https" ? "wss" : "ws";
}

/**
 * Extracts, normalizes, and caches the AriaNg configuration from web storage.
 */
function readAriaNgRpcSettings() {
  try {
    const rawOptions = localStorage.getItem("AriaNg.Options");
    if (!rawOptions) {
      currentRpcSettings = null;
      return null;
    }
    const options = JSON.parse(rawOptions);
    if (!options || typeof options !== "object" || !options.rpcHost) {
      currentRpcSettings = null;
      return null;
    }

    currentRpcSettings = {
      rpcHost: String(options.rpcHost).trim(),
      rpcPort: String(options.rpcPort || "6800").trim(),
      rpcInterface: String(options.rpcInterface || "jsonrpc")
        .trim()
        .replace(/^\/+/, ""),
      protocol: normalizeRpcProtocol(options.protocol),
      secret: decodeBase64Text(options.secret),
    };

    return currentRpcSettings;
  } catch (error) {
    console.error(
      "Failed to parse AriaNg options from localStorage context pool:",
      error,
    );
    currentRpcSettings = null;
    return null;
  }
}

function headerValue(headers, headerName) {
  if (!Array.isArray(headers)) return "";
  const lowerName = headerName.toLowerCase();
  const match = headers.find(
    (header) => header.name && header.name.toLowerCase() === lowerName,
  );
  return match ? match.value : "";
}

function cleanFileName(fileName) {
  return (
    String(fileName || "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim() || "download"
  );
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const lastSegment =
      parsed.pathname.split("/").filter(Boolean).pop() || "download";
    return cleanFileName(decodeURIComponent(lastSegment));
  } catch (error) {
    return "download";
  }
}

function fileNameFromResponse(details) {
  const disposition = headerValue(
    details.responseHeaders,
    "content-disposition",
  );
  if (!disposition) {
    return fileNameFromUrl(details.url);
  }

  const filenameStar = disposition.match(
    /filename\*=(?:UTF-8''|[^']*'[^']*')?([^;]+)/i,
  );
  if (filenameStar) {
    const rawValue = filenameStar[1].trim().replace(/^"|"$/g, "");
    try {
      return cleanFileName(decodeURIComponent(rawValue));
    } catch (error) {
      return cleanFileName(rawValue);
    }
  }

  const filename = disposition.match(/filename=(?:"([^"]+)"|([^;]+))/i);
  if (filename) {
    return cleanFileName(
      (filename[1] || filename[2] || "").trim().replace(/^"|"$/g, ""),
    );
  }

  return fileNameFromUrl(details.url);
}

function requestHeadersForAria2(requestHeaders) {
  const names = ["Referer", "Cookie", "Cookie2", "Authorization", "User-Agent"];
  const headers = [];
  for (const name of names) {
    const value = headerValue(requestHeaders, name);
    if (value) {
      headers.push(name + ": " + value);
    }
  }
  return headers;
}

const EXEMPT_CONTENT_TYPES_RE =
  /[:/+\-](pdf|xhtml|x-xpinstall|x-shockwave-flash|rss|json|javascript|xml|wasm|csp-report|graphql|hls|mpegurl)\b/i;

function shouldIntercept(details) {
  if (!currentSettings.enabled) return false;
  if (details.statusCode !== 200 && details.statusCode !== 206) return false;

  const rawDisposition = headerValue(
    details.responseHeaders,
    "content-disposition",
  );
  if (rawDisposition) {
    const disposition = rawDisposition.toLowerCase().trim();
    if (
      disposition.startsWith("attachment") ||
      /\battachment\b/.test(disposition)
    ) {
      return true;
    }
  }

  const rawContentType = headerValue(details.responseHeaders, "content-type");
  if (!rawContentType) return false;

  const contentType = rawContentType.toLowerCase().trim();
  if (contentType.startsWith("application/")) {
    if (EXEMPT_CONTENT_TYPES_RE.test(contentType)) return false;
    if (
      contentType.includes("charset=") &&
      (contentType.includes("json") || contentType.includes("xml"))
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function buildRpcUrl() {
  if (!currentRpcSettings) return "";
  return (
    currentRpcSettings.protocol +
    "://" +
    currentRpcSettings.rpcHost +
    ":" +
    currentRpcSettings.rpcPort +
    "/" +
    currentRpcSettings.rpcInterface
  );
}

function buildAria2Options(fileName, headers) {
  const options = { "parameterized-uri": "false" };
  if (fileName) options.out = fileName;
  if (headers.length > 0) options.header = headers;
  return options;
}

function closeRpcSocket() {
  if (rpcReconnectTimer) {
    clearTimeout(rpcReconnectTimer);
    rpcReconnectTimer = null;
  }
  if (rpcSocket) {
    try {
      rpcSocket.onopen = null;
      rpcSocket.onmessage = null;
      rpcSocket.onerror = null;
      rpcSocket.onclose = null;
      rpcSocket.close();
    } catch (error) {}
  }
  rpcSocket = null;
  rpcSocketReady = null;
}

function scheduleRpcReconnect() {
  if (rpcReconnectTimer || !currentSettings.enabled) return;
  rpcReconnectTimer = setTimeout(() => {
    rpcReconnectTimer = null;
    // Re-read AriaNg settings from localStorage in case the user
    // reconfigured RPC host/port/secret since the last connection
    currentRpcSettings = null;
    readAriaNgRpcSettings();
    if (!currentRpcSettings) return; // still no settings, will retry on next poll
    ensureRpcSocket().catch(() => {});
  }, 1000);
}

function handleRpcMessage(event) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch (error) {
    return;
  }

  if (message && message.id != null) {
    const pending = rpcPendingById.get(String(message.id));
    if (!pending) return;
    rpcPendingById.delete(String(message.id));
    if (message.error) {
      pending.reject(
        new Error(message.error.message || "aria2 rejected the request"),
      );
      return;
    }
    pending.resolve(message.result);
    return;
  }

  if (!message || !message.method) return;

  if (
    message.method === "aria2.onDownloadComplete" ||
    message.method === "aria2.onDownloadError" ||
    message.method === "aria2.onDownloadStop"
  ) {
    const params = Array.isArray(message.params) ? message.params : [];
    const data = params[0] && typeof params[0] === "object" ? params[0] : {};
    const gid = String(data.gid || params[0] || "");
    if (!gid || !trackedDownloads.has(gid)) return;

    const item = trackedDownloads.get(gid);
    trackedDownloads.delete(gid);

    if (message.method === "aria2.onDownloadComplete") {
      // Cache completed download stats so the popup can show the result
      lastCompletedDownload = {
        gid: gid,
        fileName: item.fileName,
        downloadSpeed: 0,
        completedLength: 0,
        totalLength: 0,
        activeCount: 0,
        status: "complete",
      };
      notify("Download complete", item.fileName);
    } else if (message.method === "aria2.onDownloadError") {
      lastCompletedDownload = {
        gid: gid,
        fileName: item.fileName,
        downloadSpeed: 0,
        completedLength: 0,
        totalLength: 0,
        activeCount: 0,
        status: "error",
      };
      notify(
        "Download failed",
        item.fileName + (data.errorCode ? " - " + data.errorCode : ""),
      );
    } else {
      lastCompletedDownload = null;
      notify("Download stopped", item.fileName);
    }

    // Refresh badge — updateDownloadBadge will pick up lastCompletedDownload
    // if no active tasks remain
    updateDownloadBadge();
  }
}

function ensureRpcSocket() {
  if (!currentSettings.enabled)
    return Promise.reject(new Error("Interception is disabled"));
  if (!currentRpcSettings)
    return readAriaNgRpcSettings().then(() => ensureRpcSocket());

  if (
    rpcSocket &&
    (rpcSocket.readyState === WebSocket.OPEN ||
      rpcSocket.readyState === WebSocket.CONNECTING)
  ) {
    return rpcSocketReady || Promise.resolve();
  }

  closeRpcSocket();
  const rpcUrl = buildRpcUrl();
  if (!rpcUrl) return Promise.reject(new Error("No AriaNg RPC settings found"));

  rpcSocketReady = new Promise((resolve, reject) => {
    const socket = new WebSocket(rpcUrl);
    rpcSocket = socket;
    socket.onopen = () => resolve();
    socket.onmessage = handleRpcMessage;
    socket.onerror = () =>
      reject(new Error("Unable to connect to aria2 WebSocket RPC"));
    socket.onclose = () => {
      if (rpcSocket === socket) {
        rpcSocket = null;
        rpcSocketReady = null;
        scheduleRpcReconnect();
      }
    };
  });

  return rpcSocketReady;
}

function rpcCall(method, params) {
  return ensureRpcSocket().then(() => {
    if (!rpcSocket || rpcSocket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    const requestId = String(++rpcRequestCounter);
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      method,
      params:
        currentRpcSettings && currentRpcSettings.secret
          ? ["token:" + currentRpcSettings.secret].concat(params)
          : params,
    };
    return new Promise((resolve, reject) => {
      rpcPendingById.set(requestId, { resolve, reject });
      try {
        rpcSocket.send(JSON.stringify(payload));
      } catch (error) {
        rpcPendingById.delete(requestId);
        reject(error);
      }
    });
  });
}

/**
 * Queries the active aria2c instance and updates the badge count overlay.
 * Also caches the latest download stats for the popup.
 */
async function updateDownloadBadge() {
  if (!currentSettings || !currentSettings.enabled) {
    browser.browserAction.setBadgeText({ text: "" });
    lastDownloadStats = null;
    updateIcon("off");
    return;
  }
  // If we don't have RPC settings yet, try reading them before attempting a call
  if (!currentRpcSettings) {
    readAriaNgRpcSettings();
    if (!currentRpcSettings) {
      // Still no settings — show error state but don't spam RPC attempts
      browser.browserAction.setBadgeText({ text: "" });
      lastDownloadStats = null;
      extensionError = true;
      updateIcon("error");
      return;
    }
  }
  try {
    const activeTasks = await rpcCall("aria2.tellActive", [
      ["gid", "downloadSpeed", "completedLength", "totalLength", "status"],
    ]);
    if (Array.isArray(activeTasks) && activeTasks.length > 0) {
      const count = activeTasks.length;
      browser.browserAction.setBadgeText({
        text: count > 99 ? "99+" : String(count),
      });
      browser.browserAction.setBadgeBackgroundColor({ color: "#E74C3C" });
      extensionError = false;

      // Cache stats for the popup — pick the first active (downloading) task
      const downloading =
        activeTasks.find((t) => t.status === "active") || activeTasks[0];
      const tracked = trackedDownloads.get(downloading.gid);
      lastDownloadStats = {
        gid: downloading.gid,
        fileName: tracked ? tracked.fileName : "",
        downloadSpeed: parseInt(downloading.downloadSpeed, 10) || 0,
        completedLength: parseInt(downloading.completedLength, 10) || 0,
        totalLength: parseInt(downloading.totalLength, 10) || 0,
        activeCount: count,
        status: "downloading",
      };
      updateIcon("active");
    } else {
      browser.browserAction.setBadgeText({ text: "" });
      extensionError = false;
      // Keep last completed download visible; clear active stats
      if (lastCompletedDownload) {
        lastDownloadStats = lastCompletedDownload;
      } else {
        lastDownloadStats = null;
      }
      updateIcon("idle");
    }
  } catch (error) {
    console.debug("Aria2c RPC unreachable during badge sync loop.");
    browser.browserAction.setBadgeText({ text: "" });
    lastDownloadStats = null;
    // Re-read AriaNg settings — the user may have just configured them
    readAriaNgRpcSettings();
    if (!currentRpcSettings) {
      // Still no valid settings; show error and wait for next poll
      extensionError = true;
      updateIcon("error");
    } else {
      // Settings exist now; close stale socket and reconnect
      extensionError = false;
      closeRpcSocket();
      scheduleRpcReconnect();
    }
  }
}

/**
 * Handles toggling the execution loop of the badge polling process tracker.
 */
function toggleBadgePolling(shouldPoll) {
  if (badgeIntervalId) {
    clearInterval(badgeIntervalId);
    badgeIntervalId = null;
  }
  if (shouldPoll) {
    updateDownloadBadge();
    badgeIntervalId = setInterval(updateDownloadBadge, 3000);
  } else {
    browser.browserAction.setBadgeText({ text: "" });
    updateIcon("off");
  }
}

function sendToAria2(details) {
  const requestHeaders = requestHeadersByRequestId.get(details.requestId) || [];
  requestHeadersByRequestId.delete(details.requestId);
  requestMetaByRequestId.delete(details.requestId);

  const fileName = fileNameFromResponse(details);
  const headers = requestHeadersForAria2(requestHeaders);
  const options = buildAria2Options(fileName, headers);

  notify("Downloading " + fileName, "URL: " + details.url);

  return rpcCall("aria2.addUri", [[details.url], options])
    .then((gid) => {
      const resultGid = String(gid || "");
      if (resultGid) {
        trackedDownloads.set(resultGid, {
          fileName: fileName,
          url: details.url,
        });
      }

      // Update badge counts immediately on handoff injection success
      updateDownloadBadge();
      maybeCloseBlankTab(details.tabId);

      return { gid: resultGid, fileName };
    })
    .catch((error) => {
      notify(
        "AriaNG Integration Minor Error",
        "aria2 handoff failed, keeping browser download: " +
          (error.message || error),
      );
      throw error;
    });
}

function maybeCloseBlankTab(tabId) {
  if (!tabId || tabId === browser.tabs.TAB_ID_NONE) return;
  browser.tabs
    .get(tabId)
    .then((tab) => {
      const isBlank =
        tab.url === "about:blank" ||
        tab.url === "" ||
        tab.url.startsWith("chrome://newtab");
      if (isBlank) {
        browser.tabs.remove(tabId).catch(() => {});
      }
    })
    .catch(() => {});
}

function handleSendHeaders(details) {
  requestHeadersByRequestId.set(
    details.requestId,
    details.requestHeaders || [],
  );
  requestMetaByRequestId.set(details.requestId, { tabId: details.tabId });
}

function handleHeadersReceived(details) {
  if (!shouldIntercept(details)) {
    requestHeadersByRequestId.delete(details.requestId);
    return Promise.resolve({ cancel: false });
  }
  return sendToAria2(details)
    .then(() => ({ cancel: true }))
    .catch(() => ({ cancel: false }));
}

function cleanupRequest(details) {
  requestHeadersByRequestId.delete(details.requestId);
  requestMetaByRequestId.delete(details.requestId);
}

function cleanupTab(tabId) {
  for (const [requestId, requestMeta] of requestMetaByRequestId.entries()) {
    if (requestMeta.tabId === tabId) {
      requestHeadersByRequestId.delete(requestId);
      requestMetaByRequestId.delete(requestId);
    }
  }
}

function createContextMenu() {
  browser.contextMenus.create(
    {
      id: "download-with-aria2c",
      title: "Download with aria2c",
      contexts: ["link", "image", "audio", "video"],
    },
    () => {
      if (browser.runtime.lastError) {
        console.debug("Context menu entry verified.");
      }
    },
  );
}

function removeContextMenu() {
  browser.contextMenus.remove("download-with-aria2c", () => {
    if (browser.runtime.lastError) {
      console.debug("Context menu already absent or cleared.");
    }
  });
}

function updateMenuState(isEnabled, contextMenuSetting) {
  if (isEnabled && contextMenuSetting) {
    createContextMenu();
  } else {
    removeContextMenu();
  }
}

function attachListeners() {
  if (listenersAttached || !currentSettings.enabled) return;

  const filter = {
    urls: ["<all_urls>"],
    types: ["main_frame", "sub_frame", "other", "object"],
  };

  browser.webRequest.onSendHeaders.addListener(handleSendHeaders, filter, [
    "requestHeaders",
  ]);
  browser.webRequest.onHeadersReceived.addListener(
    handleHeadersReceived,
    filter,
    ["blocking", "responseHeaders"],
  );
  browser.webRequest.onErrorOccurred.addListener(cleanupRequest, filter);
  browser.tabs.onRemoved.addListener(cleanupTab);

  listenersAttached = true;
}

function detachListeners() {
  if (!listenersAttached) return;
  browser.webRequest.onSendHeaders.removeListener(handleSendHeaders);
  browser.webRequest.onHeadersReceived.removeListener(handleHeadersReceived);
  browser.webRequest.onErrorOccurred.removeListener(cleanupRequest);
  browser.tabs.onRemoved.removeListener(cleanupTab);
  requestHeadersByRequestId.clear();
  requestMetaByRequestId.clear();
  listenersAttached = false;
}

function applyListeners() {
  if (currentSettings.initialize && currentSettings.enabled) {
    attachListeners();
  } else {
    detachListeners();
  }
}

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "download-with-aria2c") return;

  const downloadUrl = info.linkUrl || info.srcUrl;
  if (!downloadUrl) return;

  const mockDetails = {
    url: downloadUrl,
    requestId: `ctx_${Date.now()}`,
    responseHeaders: [],
    tabId: tab ? tab.id : null,
  };

  sendToAria2(mockDetails)
    .then(({ gid, fileName }) => {
      console.log(
        `Successfully handed off context asset. GID: ${gid}, Name: ${fileName}`,
      );
    })
    .catch((err) => {
      console.error("Context menu aria2c handoff failed:", err);
    });
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getDownloadStats") {
    sendResponse(lastDownloadStats);
    return true;
  }
  if (message.type === "clearCompletedDownload") {
    lastCompletedDownload = null;
    lastDownloadStats = null;
    sendResponse(true);
    return true;
  }
});

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.set(DEFAULT_SETTINGS);
  }
});

/**
 * Handles changes to the enabled setting.
 * Starts/stops badge polling and closes the socket when disabled.
 */
function handleEnabledChange(enabled) {
  if (enabled) {
    toggleBadgePolling(true);
  } else {
    toggleBadgePolling(false);
    closeRpcSocket();
  }
}

/**
 * Handles changes to AriaNg RPC options.
 * Resets the cached RPC settings and closes the stale socket.
 */
function handleOptionsChange() {
  currentRpcSettings = null;
  closeRpcSocket();
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Merge changes into the current settings cache for accurate state reflection Immediately.
  for (const [key, change] of Object.entries(changes)) {
    if (currentSettings && key in currentSettings) {
      currentSettings[key] = change.newValue;
    }
  }

  const needsOptionsReset = changes.hasOwnProperty("Options");
  const needsEnabledHandler = changes.hasOwnProperty("enabled");
  const needsMenuUpdate =
    changes.hasOwnProperty("enabled") || changes.hasOwnProperty("contextMenu");

  if (needsOptionsReset) {
    handleOptionsChange();
  }

  if (needsEnabledHandler) {
    handleEnabledChange(currentSettings.enabled);
  }

  if (needsMenuUpdate) {
    updateMenuState(currentSettings.enabled, currentSettings.contextMenu);
  }
  applyListeners();
});

// Primary Core Extension Synchronization Cold-Start Chain
Promise.all([readSettings(), readAriaNgRpcSettings()])
  .then(([settings, rpcSettings]) => {
    updateMenuState(settings.enabled, settings.contextMenu);
    toggleBadgePolling(settings.enabled);
    applyListeners();
  })
  .catch((error) => {
    if (typeof notify === "function") {
      notify("AriaNG Integration Critical Error", error.message || error);
    } else {
      console.error("Extension startup initialization failed:", error);
    }
  });
