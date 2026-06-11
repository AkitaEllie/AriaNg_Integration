"use strict";

function $(sel) {
  return document.querySelector(sel);
}

async function readSettings() {
  return await browser.storage.local.get({
    enabled: false,
  });
}

async function writeSettings(obj) {
  if (obj.enabled === true) obj.initialize = true;
  return browser.storage.local.set(obj);
}

document.addEventListener("DOMContentLoaded", () => {
  const enabledEl = $("#enabled");
  const openDetails = $("#openDetails");
  const openOptions = $("#openOptions");
  const status = $("#status");
  const soundEnabledEl = $("#soundEnabled");
  const customSoundBtn = $("#customSoundBtn");
  const soundFileEl = $("#soundFile");
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

  const contextMenuEl = $("#contextMenu");
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

  openOptions.addEventListener("click", () => {
    browser.tabs.create({ url: browser.runtime.getURL("options/index.html") });
  });
});
