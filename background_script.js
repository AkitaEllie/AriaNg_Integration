"use strict";

const ICON_URL = browser.runtime.getURL("icons/icon.png");

const DEFAULT_SETTINGS = {
  initialize: false,
  contextMenu: true,
  aggressive: false,
  enabled: false,
  protocol: "ws",
  host: "127.0.0.1",
  port: "6800",
  path: "jsonrpc",
  token: "",
};

let currentSettings = { ...DEFAULT_SETTINGS };
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

/**
 * Triggers a native system alert notification banner.
 */
function notify(title, message) {
  return browser.notifications
    .create({
      type: "basic",
      iconUrl: ICON_URL,
      title: title,
      message: String(message),
    })
    .catch(() => {});
}

/**
 * Reads core extension preferences from storage.
 */
function readSettings() {
  return browser.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
    currentSettings = { ...DEFAULT_SETTINGS, ...stored };
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

function buildPayload(url, fileName, headers) {
  const options = { "parameterized-uri": "false" };
  if (fileName) options.out = fileName;
  if (headers.length > 0) options.header = headers;

  return {
    jsonrpc: "2.0",
    id: "aria-ng-integration",
    method: "aria2.addUri",
    params: [[url], options],
  };
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
  if (rpcReconnectTimer || !currentSettings.enabled || !currentRpcSettings)
    return;
  rpcReconnectTimer = setTimeout(() => {
    rpcReconnectTimer = null;
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

    // Instantly refresh the badge count state layout when a job wraps up
    updateDownloadBadge();

    if (message.method === "aria2.onDownloadComplete") {
      notify("Download complete", item.fileName);
    } else if (message.method === "aria2.onDownloadError") {
      notify(
        "Download failed",
        item.fileName + (data.errorCode ? " - " + data.errorCode : ""),
      );
    } else {
      notify("Download stopped", item.fileName);
    }
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
 */
async function updateDownloadBadge() {
  if (!currentSettings || !currentSettings.enabled) {
    browser.browserAction.setBadgeText({ text: "" });
    return;
  }
  try {
    // Optimization: request only 'gid' tokens to keep payload small
    const activeTasks = await rpcCall("aria2.tellActive", [["gid"]]);
    if (Array.isArray(activeTasks) && activeTasks.length > 0) {
      const count = activeTasks.length;
      browser.browserAction.setBadgeText({
        text: count > 99 ? "99+" : String(count),
      });
      browser.browserAction.setBadgeBackgroundColor({ color: "#E74C3C" });
    } else {
      browser.browserAction.setBadgeText({ text: "" });
    }
  } catch (error) {
    console.debug("Aria2c RPC unreachable during badge sync loop.");
    browser.browserAction.setBadgeText({ text: "" });
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
  }
}

function sendToAria2(details) {
  const requestHeaders = requestHeadersByRequestId.get(details.requestId) || [];
  requestHeadersByRequestId.delete(details.requestId);
  requestMetaByRequestId.delete(details.requestId);

  const fileName = fileNameFromResponse(details);
  const headers = requestHeadersForAria2(requestHeaders);
  const payload = buildPayload(details.url, fileName, headers);

  notify("Downloading " + fileName, "URL: " + details.url);

  return rpcCall("aria2.addUri", payload.params)
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

browser.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    browser.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
      if (!stored.initialize) {
        browser.storage.local.set({
          ...DEFAULT_SETTINGS,
          initialize: false,
          enabled: false,
        });
      }
    });
  }

  browser.storage.local
    .get({ enabled: false, contextMenu: false })
    .then((stored) => {
      updateMenuState(stored.enabled, stored.contextMenu);
    });
});

// Reactive Storage Change Interceptor Engine
browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  if (changes.enabled) {
    const isNowEnabled = changes.enabled.newValue;
    updateMenuState(isNowEnabled, currentSettings.contextMenu);
    toggleBadgePolling(isNowEnabled);
  }
  if (changes.contextMenu) {
    const isNowContextMenu = changes.contextMenu.newValue;
    updateMenuState(currentSettings.enabled, isNowContextMenu);
  }

  for (const [key, change] of Object.entries(changes)) {
    currentSettings[key] = change.newValue;
    if (key === "Options") {
      currentRpcSettings = null;
      closeRpcSocket();
    }
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
