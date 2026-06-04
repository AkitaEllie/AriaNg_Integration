'use strict';

const ICON_URL = browser.runtime.getURL('icons/icon.png');

const DEFAULT_SETTINGS = {
	initialize: false,
	enabled: false,
	protocol: 'ws',
	host: '127.0.0.1',
	port: '6800',
	path: 'jsonrpc',
	token: '',
	defaultDir: ''
};

let currentSettings = { ...DEFAULT_SETTINGS };
let listenersAttached = false;
const requestHeadersByRequestId = new Map();
const requestMetaByRequestId = new Map();

function notify(message) {
	return browser.notifications.create({
		type: 'basic',
		iconUrl: ICON_URL,
		title: 'AriaNG Integration',
		message: String(message)
	}).catch(() => {});
}

function readSettings() {
	return browser.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
		currentSettings = { ...DEFAULT_SETTINGS, ...stored };
		return currentSettings;
	});
}

function headerValue(headers, headerName) {
	if (!Array.isArray(headers)) {
		return '';
	}
	const lowerName = headerName.toLowerCase();
	const match = headers.find((header) => header.name && header.name.toLowerCase() === lowerName);
	return match ? match.value : '';
}

function cleanFileName(fileName) {
	return String(fileName || '')
		.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
		.trim() || 'download';
}

function fileNameFromUrl(url) {
	try {
		const parsed = new URL(url);
		const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || 'download';
		return cleanFileName(decodeURIComponent(lastSegment));
	} catch (error) {
		return 'download';
	}
}

function fileNameFromResponse(details) {
	const disposition = headerValue(details.responseHeaders, 'content-disposition');
	if (!disposition) {
		return fileNameFromUrl(details.url);
	}

	const filenameStar = disposition.match(/filename\*=(?:UTF-8''|[^']*'[^']*')?([^;]+)/i);
	if (filenameStar) {
		const rawValue = filenameStar[1].trim().replace(/^"|"$/g, '');
		try {
			return cleanFileName(decodeURIComponent(rawValue));
		} catch (error) {
			return cleanFileName(rawValue);
		}
	}

	const filename = disposition.match(/filename=(?:"([^"]+)"|([^;]+))/i);
	if (filename) {
		return cleanFileName((filename[1] || filename[2] || '').trim().replace(/^"|"$/g, ''));
	}

	return fileNameFromUrl(details.url);
}

function requestHeadersForAria2(requestHeaders) {
	const names = currentSettings.useUserAgent
		? ['Referer', 'Cookie', 'Cookie2', 'Authorization', 'User-Agent']
		: ['Referer', 'Cookie', 'Cookie2', 'Authorization'];
	const headers = [];

	for (const name of names) {
		const value = headerValue(requestHeaders, name);
		if (value) {
			headers.push(name + ': ' + value);
		}
	}

	return headers;
}

function shouldIntercept(details) {
	if (!currentSettings.enabled) {
		return false;
	}
	if (details.statusCode !== 200) {
		return false;
	}

	const disposition = headerValue(details.responseHeaders, 'content-disposition').toLowerCase();
	if (disposition.startsWith('attachment')) {
		return true;
	}

	const contentType = headerValue(details.responseHeaders, 'content-type').toLowerCase();
	if (contentType.startsWith('application') &&
		!contentType.includes('pdf') &&
		!contentType.includes('xhtml') &&
		!contentType.includes('x-xpinstall') &&
		!contentType.includes('x-shockwave-flash') &&
		!contentType.includes('rss') &&
		!contentType.includes('json')) {
		return true;
	}

	return false;
}

function buildRpcUrl() {
	return currentSettings.protocol + '://' + currentSettings.host + ':' + currentSettings.port + '/' + currentSettings.path;
}

function buildPayload(url, fileName, headers) {
	const options = {
		'parameterized-uri': 'false'
	};

	if (fileName) {
		options.out = fileName;
	}
	if (currentSettings.defaultDir) {
		options.dir = currentSettings.defaultDir;
	}
	if (headers.length > 0) {
		options.header = headers;
	}

	const params = currentSettings.token
		? ['token:' + currentSettings.token, [url], options]
		: [[url], options];

	return {
		jsonrpc: '2.0',
		id: 'aria-ng-integration',
		method: 'aria2.addUri',
		params
	};
}

function sendToAria2(details) {
	const requestHeaders = requestHeadersByRequestId.get(details.requestId) || [];
	requestHeadersByRequestId.delete(details.requestId);
	requestMetaByRequestId.delete(details.requestId);

	const fileName = fileNameFromResponse(details);
	const headers = requestHeadersForAria2(requestHeaders);
	const payload = buildPayload(details.url, fileName, headers);
	const rpcUrl = buildRpcUrl();

	if (currentSettings.protocol === 'ws' || currentSettings.protocol === 'wss') {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(rpcUrl);
			socket.onopen = () => {
				socket.send(JSON.stringify(payload));
			};
			socket.onmessage = (event) => {
				try {
					const response = JSON.parse(event.data);
					if (response.error) {
						reject(new Error(response.error.message || 'aria2 rejected the request'));
						return;
					}
					resolve(response.result);
				} catch (error) {
					reject(error);
				} finally {
					socket.close();
				}
			};
			socket.onerror = () => {
				socket.close();
				reject(new Error('Unable to connect to aria2 RPC'));
			};
		});
	}

	return fetch(rpcUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json'
		},
		body: JSON.stringify(payload)
	}).then((response) => {
		if (!response.ok) {
			throw new Error('aria2 RPC request failed');
		}
		return response.json();
	}).then((result) => {
		if (result && result.error) {
			throw new Error(result.error.message || 'aria2 rejected the request');
		}
		return result;
	});
}

function maybeCloseBlankTab() {
	browser.tabs.query({
		active: true,
		lastFocusedWindow: true,
		windowType: 'normal'
	}).then((tabs) => {
		if (tabs[0] && tabs[0].url === 'about:blank') {
			browser.tabs.remove(tabs[0].id).catch(() => {});
		}
	}).catch(() => {});
}

function handleSendHeaders(details) {
	requestHeadersByRequestId.set(details.requestId, details.requestHeaders || []);
	requestMetaByRequestId.set(details.requestId, {
		tabId: details.tabId
	});
}

function handleHeadersReceived(details) {
	if (!shouldIntercept(details)) {
		requestHeadersByRequestId.delete(details.requestId);
		return { cancel: false };
	}

	sendToAria2(details).then(() => {
		notify('Downloading ' + fileNameFromResponse(details));
	}).catch((error) => {
		notify(error.message || error);
	});

	setTimeout(maybeCloseBlankTab, 0);
	return { cancel: true };
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

function attachListeners() {
	if (listenersAttached || !currentSettings.enabled) {
		return;
	}
	browser.webRequest.onSendHeaders.addListener(handleSendHeaders, {
		urls: ['<all_urls>'],
		types: ['main_frame', 'sub_frame']
	}, ['requestHeaders']);
	browser.webRequest.onHeadersReceived.addListener(handleHeadersReceived, {
		urls: ['<all_urls>'],
		types: ['main_frame', 'sub_frame']
	}, ['blocking', 'responseHeaders']);
	browser.webRequest.onErrorOccurred.addListener(cleanupRequest, {
		urls: ['<all_urls>'],
		types: ['main_frame', 'sub_frame']
	});
	browser.tabs.onRemoved.addListener(cleanupTab);
	listenersAttached = true;
}

function detachListeners() {
	if (!listenersAttached) {
		return;
	}
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
		return;
	}
	detachListeners();
}

browser.runtime.onInstalled.addListener((details) => {
	if (details.reason === 'install') {
		browser.storage.local.get(DEFAULT_SETTINGS).then((stored) => {
			if (!stored.initialize) {
				browser.storage.local.set({
					...DEFAULT_SETTINGS,
					initialize: false,
					enabled: false
				}).then(() => browser.runtime.openOptionsPage().catch(() => {}));
			}
		});
	}
});

browser.runtime.onStartup.addListener(() => {
	readSettings().then(applyListeners).catch((error) => notify(error.message || error));
});

browser.browserAction.onClicked.addListener(() => {
	browser.runtime.openOptionsPage().catch(() => {});
});

browser.storage.onChanged.addListener((changes, areaName) => {
	if (areaName !== 'local') {
		return;
	}
	for (const [key, change] of Object.entries(changes)) {
		currentSettings[key] = change.newValue;
	}
	applyListeners();
});

readSettings().then(applyListeners).catch((error) => notify(error.message || error));
