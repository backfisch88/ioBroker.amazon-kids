'use strict';

const MAX_SCRIPTS = 40;
const MAX_SCRIPT_BYTES = 8 * 1024 * 1024;
const USAGE_CONTEXT = 450;
const MAX_USAGES = 2;
const MAX_PROBE_BODY = 900;
const SCRIPT_HOST = /(^|\.)(media-amazon\.com|ssl-images-amazon\.com|amazon\.[a-z]{2,3}(\.[a-z]{2})?|cloudfront\.net)$/;
const ENDPOINT = /["'`]\/?(ajax\/[A-Za-z0-9_/-]+)/g;
const ENUM_MEMBER = /\.([A-Za-z_$][\w$]*)\s*=\s*["'](ajax\/[A-Za-z0-9_/-]+)["']/g;
const RELEVANT =
    /ajax\/(set-|toggle-|update-|add-or-remove-|assign-|share-|change-|opt-out-|get-child-devices|get-customer-devices|get-device-|get-video-settings|get-music-settings|get-comms-settings|get-smart-home|get-restricted|get-allowlisted)/;

function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the places where the dashboard code calls the endpoints that matter
 * for time limits, usage and bonus time, to learn the expected parameters.
 *
 * @param {string[]} texts page and script sources
 * @returns {Record<string, string[]>} code snippets per endpoint
 */
function findUsages(texts) {
    const members = new Map();
    for (const text of texts) {
        for (const match of text.matchAll(ENUM_MEMBER)) {
            if (RELEVANT.test(match[2])) {
                members.set(match[1], `/${match[2]}`);
            }
        }
    }
    const usages = {};
    for (const [member, endpoint] of members) {
        const pattern = new RegExp(`\\.${escapeRegex(member)}\\b(?!\\s*=)`, 'g');
        const snippets = [];
        for (const text of texts) {
            for (const match of text.matchAll(pattern)) {
                if (snippets.length >= MAX_USAGES) {
                    break;
                }
                const from = Math.max(0, match.index - USAGE_CONTEXT);
                snippets.push(text.slice(from, match.index + USAGE_CONTEXT).replace(/\s+/g, ' '));
            }
        }
        if (snippets.length) {
            usages[endpoint] = snippets;
        }
    }
    return usages;
}

/**
 * Calls read-only endpoints with GET to learn what they return.
 *
 * @param {import('./parentDashboard').ParentDashboard} client logged-in client
 * @param {string} directedId child ID
 * @returns {Promise<Record<string, {status: number | string, body: string}>>} status and start of the response
 */
async function probe(client, directedId) {
    const child = { childDirectedId: directedId };
    const requests = {
        'get-bonus-time': child,
        'get-time-limit-v2': child,
        'get-child-devices': {},
        'get-customer-devices-data': {},
        'get-video-settings': child,
        'get-music-settings': child,
        'get-comms-settings': child,
        'get-smart-home-access': child,
        'get-restricted-websites': child,
        'get-allowlisted-websites': child,
    };
    const results = {};
    for (const [name, query] of Object.entries(requests)) {
        const path = `/ajax/${name.split(' ')[0]}`;
        try {
            const url = new URL(path, client.baseUrl);
            for (const [key, value] of Object.entries(query)) {
                url.searchParams.set(key, value);
            }
            // Plain request without the retry logic: an error status is a valid answer here.
            const response = await client.fetchImpl(url, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(client.timeoutMs),
                headers: {
                    accept: 'application/json, text/plain, */*',
                    referer: `${client.baseUrl}/`,
                    cookie: client.cookieHeader(),
                    ...(client.csrf ? { 'x-amzn-csrf': client.csrf } : {}),
                },
            });
            results[name] = { status: response.status, body: (await response.text()).slice(0, MAX_PROBE_BODY) };
        } catch (error) {
            results[name] = { status: 'error', body: error instanceof Error ? error.message : String(error) };
        }
    }
    try {
        const data = await client.getJson('/ajax/get-customer-devices-data', {});
        const list = Array.isArray(data?.customerDevices) ? data.customerDevices : [];
        results['device summary'] = {
            status: 200,
            body: JSON.stringify(
                list.map(d => ({
                    name: d.deviceName,
                    family: d.deviceFamily,
                    kidsEditionDevice: d.kidsEditionDevice,
                    amazonKidsCompatible: d.amazonKidsCompatible,
                    childProfiles: Array.isArray(d.childProfiles) ? d.childProfiles.length : d.childProfiles,
                })),
            ),
        };
    } catch (error) {
        results['device summary'] = { status: 'error', body: error instanceof Error ? error.message : String(error) };
    }
    return results;
}

/**
 * Diagnostic helper: lists the web endpoints the Parent Dashboard page knows,
 * shows how the page calls the time related ones and reads a few of them.
 * Nothing is changed in the account. Session cookies are only sent to the
 * dashboard host itself.
 *
 * @param {import('./parentDashboard').ParentDashboard} client logged-in client
 * @param {string} [directedId] child ID for the read-only probes
 * @returns {Promise<{scripts: number, failed: number, endpoints: string[], usages: Record<string, string[]>, probes: object}>} result
 */
async function discoverEndpoints(client, directedId) {
    const page = await (await client.request('GET', '/')).text();
    const texts = [page];

    const urls = new Set();
    for (const match of page.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
        try {
            const url = new URL(match[1], client.baseUrl);
            if (url.protocol === 'https:' && (url.origin === client.baseUrl || SCRIPT_HOST.test(url.hostname))) {
                urls.add(url.href);
            }
        } catch {
            // ignore malformed addresses
        }
    }

    let failed = 0;
    for (const href of [...urls].slice(0, MAX_SCRIPTS)) {
        try {
            const url = new URL(href);
            let response;
            if (url.origin === client.baseUrl) {
                response = await client.request('GET', `${url.pathname}${url.search}`);
            } else {
                response = await client.fetchImpl(url, {
                    method: 'GET',
                    redirect: 'error',
                    signal: AbortSignal.timeout(client.timeoutMs),
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
            }
            const text = await response.text();
            if (text.length <= MAX_SCRIPT_BYTES) {
                texts.push(text);
            }
        } catch {
            failed++;
        }
    }

    const endpoints = new Set();
    for (const text of texts) {
        for (const match of text.matchAll(ENDPOINT)) {
            endpoints.add(`/${match[1]}`);
        }
    }
    return {
        scripts: texts.length - 1,
        failed,
        endpoints: [...endpoints].sort(),
        usages: findUsages(texts),
        probes: directedId ? await probe(client, directedId) : {},
    };
}

module.exports = { discoverEndpoints, findUsages };
