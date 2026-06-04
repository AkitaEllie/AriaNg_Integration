'use strict';

const DEFAULT_SETTINGS = {
	initialize: false,
	enabled: false,
	protocol: 'ws',
	host: '127.0.0.1',
	port: '6800',
	path: 'jsonrpc',
	token: '',
	defaultDir: '',
	useUserAgent: false
};

function setValue(id, value) {
	const element = document.getElementById(id);
	if (!element) {
		return;
	}
	if (element.type === 'checkbox') {
		element.checked = Boolean(value);
		return;
	}
	element.value = value == null ? '' : String(value);
}

function getValue(id) {
	const element = document.getElementById(id);
	if (!element) {
		return undefined;
	}
	if (element.type === 'checkbox') {
		return element.checked;
	}
	if (element.type === 'number') {
		return Number(element.value || 0);
	}
	return element.value.trim();
}

function fillForm(settings) {
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		setValue(key, settings[key]);
	}
}

function loadSettings() {
	return browser.storage.local.get(DEFAULT_SETTINGS).then((settings) => {
		fillForm({ ...DEFAULT_SETTINGS, ...settings });
	});
}

function showStatus(message, isError) {
	const status = document.getElementById('status');
	status.textContent = message;
	status.dataset.state = isError ? 'error' : 'ok';
	if (!isError) {
		window.setTimeout(() => {
			status.textContent = '';
			status.dataset.state = '';
		}, 1400);
	}
}

function collectSettings() {
	const settings = {};
	for (const key of Object.keys(DEFAULT_SETTINGS)) {
		settings[key] = getValue(key);
	}
	settings.initialize = true;
	return settings;
}

document.addEventListener('DOMContentLoaded', () => {
	loadSettings();
	document.getElementById('settingsForm').addEventListener('submit', (event) => {
		event.preventDefault();
		browser.storage.local.set(collectSettings()).then(() => {
			showStatus('Saved', false);
		}, (error) => {
			showStatus(error.message || String(error), true);
		});
	});

	const checkBtn = document.getElementById('checkRpc');
	if (checkBtn) {
		checkBtn.addEventListener('click', async (e) => {
			e.preventDefault();
			const status = document.getElementById('status');
			status.textContent = 'Checking...';
			try {
				const settings = collectSettings();
				const ok = await testRpc(settings);
				status.textContent = ok ? 'RPC OK' : 'RPC failed';
				status.dataset.state = ok ? 'ok' : 'error';
			} catch (err) {
				status.textContent = err && err.message ? err.message : String(err);
				status.dataset.state = 'error';
			}
			setTimeout(() => { status.textContent = ''; status.dataset.state = ''; }, 1800);
		});
	}
});

async function testRpc(settings) {
	const protocol = (settings.protocol || 'ws').toLowerCase();
	const host = settings.host || '127.0.0.1';
	const port = settings.port || '6800';
	const path = (settings.path || 'jsonrpc').replace(/^\/+/, '');
	const token = settings.token || '';
	const rpcUrl = `${protocol}://${host}:${port}/${path}`;

	const payload = token ? { jsonrpc: '2.0', id: 'test', method: 'aria2.getVersion', params: ['token:' + token] } : { jsonrpc: '2.0', id: 'test', method: 'aria2.getVersion', params: [] };

	if (protocol === 'ws' || protocol === 'wss') {
		return new Promise((resolve, reject) => {
			let socket;
			try {
				socket = new WebSocket(rpcUrl);
			} catch (err) {
				reject(err);
				return;
			}
			const timer = setTimeout(() => {
				try { socket.close(); } catch(e){}
				reject(new Error('Timeout'));
			}, 5000);
			socket.onopen = () => {
				socket.send(JSON.stringify(payload));
			};
			socket.onmessage = (evt) => {
				clearTimeout(timer);
				try {
					const json = JSON.parse(evt.data);
					socket.close();
					if (json && (json.result || json.error === undefined)) {
						resolve(Boolean(json.result));
					} else {
						resolve(false);
					}
				} catch (err) {
					reject(err);
				}
			};
			socket.onerror = (e) => {
				clearTimeout(timer);
				try { socket.close(); } catch(e){}
				reject(new Error('WebSocket error'));
			};
		});
	}

	// HTTP(s)
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 5000);
	try {
		const resp = await fetch(rpcUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
			signal: controller.signal
		});
		clearTimeout(timeoutId);
		if (!resp.ok) return false;
		const json = await resp.json();
		return !!json.result;
	} catch (err) {
		clearTimeout(timeoutId);
		throw err;
	}
}
