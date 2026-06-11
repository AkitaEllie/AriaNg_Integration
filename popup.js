"use strict";

function $(sel) {
  return document.querySelector(sel);
}

async function readSettings() {
  return browser.storage.local.get({
    enabled: false,
    contextMenu: true,
  });
}

async function writeSettings(obj) {
  if (obj.enabled === true) obj.initialize = true;
  return browser.storage.local.set(obj);
}

document.addEventListener("DOMContentLoaded", () => {
  const enabledEl = $("#enabled");
  const contextMenuEl = $("#contextMenu");
  const openDetails = $("#openDetails");
  const status = $("#status");

  readSettings()
    .then((s) => {
      enabledEl.checked = Boolean(s.enabled);
      contextMenuEl.checked = Boolean(s.contextMenu);
    })
    .catch((err) => {
      console.error("Failed to read settings on popup launch:", err);
    });

  let statusTimer = null;

  async function saveSetting(partial, message) {
    try {
      await writeSettings(partial);
      status.textContent = message;
      if (statusTimer) {
        clearTimeout(statusTimer);
      }
      statusTimer = setTimeout(() => {
        status.textContent = "";
        statusTimer = null;
      }, 1600);
    } catch (err) {
      status.textContent = "Error saving setting";
    }
  }

  enabledEl.addEventListener("change", (e) => {
    const on = e.target.checked;
    saveSetting(
      { enabled: on },
      on ? "Interception enabled" : "Interception disabled",
    );
  });

  contextMenuEl.addEventListener("change", (e) => {
    const on = e.target.checked;
    saveSetting(
      { contextMenu: on },
      on ? "Context menu enabled" : "Context menu disabled",
    );
  });

  openDetails.addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("ariang/index.html") });
  });

  // --- Download stats display ---
  const downloadStatsEl = $("#downloadStats");
  const statFileNameEl = $("#statFileName");
  const statSpeedEl = $("#statSpeed");
  const statProgressEl = $("#statProgress");
  const statBarFillEl = $("#statBarFill");
  const dismissBtn = $("#dismissStats");

  let statsDismissed = false;

  function formatBytes(bytes) {
    if (bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = bytes / Math.pow(1024, i);
    return value.toFixed(i === 0 ? 0 : 1) + " " + units[i];
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec <= 0) return "—";
    return formatBytes(bytesPerSec) + "/s";
  }

  function resetStats() {
    statFileNameEl.textContent = "—";
    statSpeedEl.textContent = "—";
    statProgressEl.textContent = "—";
    statBarFillEl.style.width = "0%";
  }

  dismissBtn.addEventListener("click", () => {
    statsDismissed = true;
    downloadStatsEl.hidden = true;
    resetStats();
    // Also clear the background's completed cache so it doesn't reappear
    browser.runtime
      .sendMessage({ type: "clearCompletedDownload" })
      .catch(() => {});
  });

  async function refreshStats() {
    if (statsDismissed) return;
    try {
      const stats = await browser.runtime.sendMessage({
        type: "getDownloadStats",
      });
      if (!stats) {
        downloadStatsEl.hidden = true;
        return;
      }

      // Show filename
      statFileNameEl.textContent = stats.fileName || "—";

      if (stats.status === "complete") {
        statSpeedEl.textContent = "✓ Complete";
        statProgressEl.textContent = "100%";
        statBarFillEl.style.width = "100%";
        downloadStatsEl.hidden = false;
      } else if (stats.status === "error") {
        statSpeedEl.textContent = "✗ Failed";
        statProgressEl.textContent = "—";
        statBarFillEl.style.width = "0%";
        downloadStatsEl.hidden = false;
      } else if (stats.totalLength > 0) {
        const pct = Math.min(
          100,
          (stats.completedLength / stats.totalLength) * 100,
        );
        statSpeedEl.textContent = formatSpeed(stats.downloadSpeed);
        statProgressEl.textContent = pct.toFixed(1) + "%";
        statBarFillEl.style.width = pct.toFixed(1) + "%";
        downloadStatsEl.hidden = false;
      } else if (stats.activeCount > 0) {
        // Active but no total length yet (e.g. chunked streaming)
        statSpeedEl.textContent = formatSpeed(stats.downloadSpeed);
        statProgressEl.textContent = formatBytes(stats.completedLength);
        statBarFillEl.style.width = "0%";
        downloadStatsEl.hidden = false;
      } else {
        downloadStatsEl.hidden = true;
      }
    } catch {
      downloadStatsEl.hidden = true;
    }
  }

  refreshStats();
  setInterval(refreshStats, 500);
});
