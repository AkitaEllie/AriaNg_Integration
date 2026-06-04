'use strict';

function $(sel){return document.querySelector(sel)}

async function readSettings(){
  const s = await browser.storage.local.get({enabled:false});
  return s;
}

async function writeSettings(obj){
  // ensure initialize is set so background attaches listeners when enabling
  if (obj.enabled === true) obj.initialize = true;
  return browser.storage.local.set(obj);
}

document.addEventListener('DOMContentLoaded', async () => {
  const enabledEl = $('#enabled');
  const openOptions = $('#openOptions');
  const openDetails = $('#openDetails');
  const status = $('#status');

  const s = await readSettings();
  enabledEl.checked = Boolean(s.enabled);

  enabledEl.addEventListener('change', async (e) => {
    const on = e.target.checked;
    try {
      await writeSettings({enabled: on});
      status.textContent = on ? 'Interception enabled' : 'Interception disabled';
    } catch (err) {
      status.textContent = 'Error saving setting';
    }
    setTimeout(()=> status.textContent='', 1600);
  });

  openOptions.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
    window.close();
  });

  openDetails.addEventListener('click', () => {
    // open stub details page in a new tab
    browser.tabs.create({url: browser.runtime.getURL('details.html')});
    window.close();
  });
});
