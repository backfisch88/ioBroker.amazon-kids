'use strict';

/**
 * Minimal client for the Amazon Kids Parent Dashboard web endpoints.
 *
 * The endpoints are not a public API. They were taken from the open source
 * Python client https://github.com/GrantGMiller/amazon_parent_dashboard
 * and can change at any time.
 */

const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CSRF_COOKIE = 'ft-panda-csrf-token';
const MAX_REDIRECTS = 5;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOST_PATTERN = /^[a-z0-9-]+\.amazon\.(com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;

class ParentDashboardError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ParentDashboardError';
    }
}

class AuthError extends ParentDashboardError {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
    }
}

/**
 * Validates the configured dashboard address. Only https hosts below an
 * Amazon domain are accepted, so the session cookies are never sent elsewhere.
 *
 * @param {unknown} input configured address
 * @returns {string | null} origin (e.g. https://eltern.amazon.de) or null if invalid
 */
function normalizeBaseUrl(input) {
    if (typeof input !== 'string' || !input.trim()) {
        return null;
    }
    let value = input.trim();
    if (!/^[a-z]+:\/\//i.test(value)) {
        value = `https://${value}`;
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.port || !HOST_PATTERN.test(url.hostname)) {
        return null;
    }
    return url.origin;
}

/**
 * Parses a cookie header string ("a=b; c=d") or a JSON object string.
 *
 * @param {unknown} raw cookie string
 * @returns {Map<string, string>} cookie jar
 */
function parseCookies(raw) {
    const jar = new Map();
    if (typeof raw !== 'string') {
        return jar;
    }
    let text = raw.trim();
    if (text.startsWith('{')) {
        try {
            const obj = JSON.parse(text);
            for (const [key, value] of Object.entries(obj)) {
                if (key && value !== null && value !== undefined) {
                    jar.set(key, String(value));
                }
            }
            return jar;
        } catch {
            return jar;
        }
    }
    text = text.replace(/^cookie:\s*/i, '');
    for (const part of text.split(';')) {
        const pos = part.indexOf('=');
        if (pos > 0) {
            const key = part.slice(0, pos).trim();
            if (key) {
                jar.set(key, part.slice(pos + 1).trim());
            }
        }
    }
    return jar;
}

/**
 * Extracts the children from the dashboard start page.
 *
 * @param {string} html page source
 * @returns {{name: string, directedId: string}[]} children of the household
 */
function parseHousehold(html) {
    const match = /window\.__PREFETCHED_HOUSEHOLD\s*=\s*JSON\.parse\('((?:\\.|[^'\\])*)'\)/s.exec(String(html));
    if (!match) {
        throw new ParentDashboardError('Could not find the household data in the dashboard page');
    }
    // The page embeds JSON inside a JavaScript string literal. Convert the
    // escapes that are valid in JavaScript but not in JSON before decoding.
    const literal = match[1].replace(/\\(x[0-9a-fA-F]{2}|.)/gs, (all, esc) => {
        if (esc === "'") {
            return "'";
        }
        if (esc.length === 3) {
            return `\\u00${esc.slice(1)}`;
        }
        return all;
    });
    let household;
    try {
        household = JSON.parse(JSON.parse(`"${literal}"`));
    } catch {
        throw new ParentDashboardError('Could not decode the household data of the dashboard page');
    }
    const members = Array.isArray(household?.members) ? household.members : [];
    return members
        .filter(m => m && m.role === 'CHILD' && m.firstName && m.directedId)
        .map(m => ({ name: String(m.firstName), directedId: String(m.directedId) }));
}

/**
 * Returns the weekday name in the given time zone.
 *
 * @param {string} [timeZone] IANA time zone, system zone if empty
 * @param {Date} [date] reference date
 * @returns {string} English weekday name
 */
function getWeekday(timeZone, date = new Date()) {
    try {
        return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: timeZone || undefined }).format(date);
    } catch {
        return WEEKDAYS[date.getDay()];
    }
}

/**
 * Reads the total screen time limit of one weekday from the time limit response.
 *
 * @param {object | null} data response of get-adjusted-time-limits
 * @param {string} weekday English weekday name
 * @returns {{enabled: boolean, minutes: number | null}} limit of that day
 */
function getDayLimit(data, weekday) {
    const periods = Array.isArray(data?.periodConfigurations) ? data.periodConfigurations : [];
    const day = periods.find(p => p && p.type === 'DayOfWeek' && p.name === weekday);
    if (!day) {
        throw new ParentDashboardError(`No ${weekday} entry in the time limit response`);
    }
    const limits = day.timeLimits || {};
    if (!day.enabled || !limits.contentTimeLimitsEnabled) {
        return { enabled: false, minutes: null };
    }
    const total = limits.contentTimeLimits?.ALL;
    return { enabled: true, minutes: Number.isInteger(total) ? total : null };
}

/**
 * Converts an external name into a valid object ID part.
 *
 * @param {unknown} value external name
 * @returns {string} sanitized ID part, may be empty
 */
function sanitizeId(value) {
    return String(value ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

class ParentDashboard {
    /**
     * @param {object} options client options
     * @param {string} options.baseUrl validated dashboard origin
     * @param {string} options.cookies cookie header of a logged-in browser session
     * @param {string} [options.timeZone] IANA time zone sent with bonus time requests
     * @param {number} [options.timeoutMs] request timeout
     * @param {typeof fetch} [options.fetchImpl] fetch implementation (for tests)
     */
    constructor(options) {
        this.baseUrl = options.baseUrl;
        this.cookies = parseCookies(options.cookies);
        this.timeZone = options.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        this.timeoutMs = options.timeoutMs || 20000;
        this.fetchImpl = options.fetchImpl || fetch;
    }

    get csrf() {
        return this.cookies.get(CSRF_COOKIE) || '';
    }

    /**
     * Replaces the session cookies and keeps cookies the dashboard has set itself.
     *
     * @param {string} raw cookie header of a renewed session
     */
    updateCookies(raw) {
        for (const [key, value] of parseCookies(raw)) {
            this.cookies.set(key, value);
        }
    }

    cookieHeader() {
        return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    }

    storeCookies(response) {
        const list = typeof response.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
        for (const line of list) {
            const first = String(line).split(';')[0];
            const pos = first.indexOf('=');
            if (pos <= 0) {
                continue;
            }
            const key = first.slice(0, pos).trim();
            const value = first.slice(pos + 1).trim();
            if (!value || value === 'deleted' || /;\s*max-age=0/i.test(line)) {
                this.cookies.delete(key);
            } else {
                this.cookies.set(key, value);
            }
        }
    }

    /**
     * @param {string} method HTTP method
     * @param {string} path path below the dashboard origin
     * @param {{query?: Record<string, string>, body?: object}} [options] request data
     * @param {boolean} [retry] retry once with a refreshed CSRF token
     * @returns {Promise<Response>} successful response
     */
    async request(method, path, options = {}, retry = true) {
        let url = new URL(path, this.baseUrl);
        for (const [key, value] of Object.entries(options.query || {})) {
            url.searchParams.set(key, value);
        }
        let response;
        for (let hop = 0; ; hop++) {
            const headers = {
                'user-agent': USER_AGENT,
                accept: 'application/json, text/plain, */*',
                origin: this.baseUrl,
                referer: `${this.baseUrl}/`,
                cookie: this.cookieHeader(),
            };
            if (this.csrf) {
                headers['x-amzn-csrf'] = this.csrf;
            }
            const init = { method, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) };
            if (options.body) {
                headers['content-type'] = 'application/json';
                init.body = JSON.stringify(options.body);
            }
            response = await this.fetchImpl(url, init);
            this.storeCookies(response);
            if (response.status < 300 || response.status >= 400) {
                break;
            }
            // Redirects are only followed inside the dashboard host. Everything
            // else is the Amazon sign-in, which means the session is gone.
            const location = response.headers.get('location') || '';
            let next;
            try {
                next = new URL(location, url);
            } catch {
                next = null;
            }
            if (!next || next.origin !== this.baseUrl || /signin|\/ap\//i.test(next.pathname)) {
                throw new AuthError('Session cookies are expired or invalid (redirected to sign-in)');
            }
            if (method !== 'GET' || hop >= MAX_REDIRECTS) {
                throw new ParentDashboardError(`${method} ${path} -> unexpected redirect`);
            }
            url = next;
        }

        if (response.status === 401 || response.status === 403) {
            if (retry) {
                const previous = this.csrf;
                await this.request('GET', '/', {}, false);
                if (this.csrf && this.csrf !== previous) {
                    return this.request(method, path, options, false);
                }
            }
            throw new AuthError(`${method} ${path} was rejected (HTTP ${response.status})`);
        }
        if (!response.ok) {
            throw new ParentDashboardError(`${method} ${path} -> HTTP ${response.status}`);
        }
        return response;
    }

    /**
     * Sends a command and returns how the dashboard answered.
     *
     * @param {string} method HTTP method
     * @param {string} path path below the dashboard origin
     * @param {object} body request body
     * @returns {Promise<{status: number, body: string}>} status and start of the answer
     */
    async command(method, path, body) {
        const response = await this.request(method, path, { body });
        let text = '';
        try {
            text = (await response.text()).slice(0, 300);
        } catch {
            // an unreadable body does not make the command fail
        }
        return { status: response.status, body: text };
    }

    /**
     * Reads the usage of a child. The dashboard reads this with POST; nothing is changed.
     *
     * @param {string} directedId child ID
     * @param {number} startTime start as unix time in seconds
     * @param {number} endTime end as unix time in seconds
     * @returns {Promise<object>} usage per category and local day
     */
    async getActivities(directedId, startTime, endTime) {
        const response = await this.request('POST', '/ajax/get-weekly-activities-v2', {
            body: {
                childDirectedId: directedId,
                startTime,
                endTime,
                aggregationInterval: 86400,
                timeZone: this.timeZone,
            },
        });
        try {
            return await response.json();
        } catch {
            throw new ParentDashboardError('Activity response is not valid JSON');
        }
    }

    /**
     * @returns {Promise<{name: string, directedId: string}[]>} children of the household
     */
    async getChildren() {
        const response = await this.request('GET', '/');
        return parseHousehold(await response.text());
    }

    /**
     * @param {string} directedId child ID
     * @returns {Promise<object>} raw time limit configuration
     */
    async getTimeLimits(directedId) {
        const response = await this.request('GET', '/ajax/get-adjusted-time-limits', {
            query: { childDirectedId: directedId },
        });
        try {
            return await response.json();
        } catch {
            throw new ParentDashboardError('Time limit response is not valid JSON');
        }
    }

    /**
     * Reads the weekly rules as they are stored, without temporary adjustments.
     *
     * @param {string} directedId child ID
     * @returns {Promise<{periodConfigurations: object[]}>} stored time limit configuration
     */
    async getBaseTimeLimits(directedId) {
        const response = await this.request('GET', '/ajax/get-time-limit-v2', {
            query: { childDirectedId: directedId },
        });
        let data;
        try {
            data = await response.json();
        } catch {
            throw new ParentDashboardError('Time limit response is not valid JSON');
        }
        if (!Array.isArray(data?.periodConfigurations) || !data.periodConfigurations.length) {
            throw new ParentDashboardError('Time limit response contains no weekdays');
        }
        return data;
    }

    /**
     * Replaces the weekly rules of a child.
     *
     * @param {string} directedId child ID
     * @param {object[]} periodConfigurations rules per weekday, as returned by getBaseTimeLimits
     */
    async setTimeLimits(directedId, periodConfigurations) {
        return this.command('PUT', '/ajax/set-time-limit-v2', { childDirectedId: directedId, periodConfigurations });
    }

    /**
     * @param {string} directedId child ID
     * @returns {Promise<number>} bonus time currently granted, in minutes
     */
    async getBonusTime(directedId) {
        const response = await this.request('GET', '/ajax/get-bonus-time', {
            query: { childDirectedId: directedId },
        });
        const minutes = Number((await response.text()).trim());
        if (!Number.isFinite(minutes)) {
            throw new ParentDashboardError('Bonus time response is not a number');
        }
        return minutes;
    }

    /**
     * @param {string} directedId child ID
     */
    async deleteBonusTime(directedId) {
        return this.command('PUT', '/ajax/delete-bonus-time', { childDirectedId: directedId });
    }

    /**
     * Pauses the devices of all children for some minutes, or resumes them (0).
     * Amazon expects the duration in seconds, -1 ends the pause.
     *
     * @param {number} minutes pause duration in minutes, 0 to resume
     */
    async setHouseholdOffscreenTime(minutes) {
        return this.command('POST', '/ajax/set-household-offscreen-time', {
            expirationTimeInSeconds: minutes > 0 ? minutes * 60 : -1,
        });
    }

    /**
     * @param {string} directedId child ID
     * @param {number} minutes bonus time to add
     */
    async setBonusTime(directedId, minutes) {
        return this.command('PUT', '/ajax/set-bonus-time', {
            childDirectedId: directedId,
            currentTime: new Date().toISOString(),
            currentTimeZone: this.timeZone,
            bonusTimeConfigurationType: 'Duration',
            bonusTimeDurationInMinutes: minutes,
        });
    }

    /**
     * @param {string} directedId child ID
     * @param {number} minutes pause duration
     */
    async pauseDevices(directedId, minutes) {
        return this.command('POST', '/ajax/set-offscreen-time', {
            directedIds: [directedId],
            expirationTimeInSeconds: minutes * 60,
        });
    }

    /**
     * @param {string} directedId child ID
     */
    async resumeDevices(directedId) {
        return this.command('POST', '/ajax/set-offscreen-time', {
            directedIds: [directedId],
            expirationTimeInSeconds: -1,
        });
    }
    /**
     * Reads JSON (or plain text) from a read-only endpoint.
     *
     * @param {string} path path below the dashboard origin
     * @param {Record<string, string>} query query parameters
     * @returns {Promise<unknown>} parsed answer
     */
    async getJson(path, query) {
        const response = await this.request('GET', path, { query });
        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch {
            return text.trim();
        }
    }

    /**
     * @param {string} directedId child ID
     * @returns {Promise<boolean | null>} whether the child may use Alexa smart home devices
     */
    async getSmartHomeAccess(directedId) {
        const data = await this.getJson('/ajax/get-smart-home-access', { childDirectedId: directedId });
        return typeof data?.smartHomeEnabled === 'boolean' ? data.smartHomeEnabled : null;
    }

    /**
     * @param {string} directedId child ID
     * @param {boolean} enable allow or forbid
     */
    async setSmartHomeAccess(directedId, enable) {
        return this.command('POST', '/ajax/set-smart-home-access', { childDirectedId: directedId, enable });
    }

    /**
     * Explicit language filter (ELF) of the child.
     *
     * @param {string} directedId child ID
     * @param {boolean} enable switch on or off
     */
    async setElfAccess(directedId, enable) {
        return this.command('POST', '/ajax/set-elf-access', { childDirectedId: directedId, enable });
    }

    /**
     * @param {string} directedId child ID
     * @param {'restricted' | 'allowlisted'} kind blocked or allowed websites
     * @returns {Promise<string[]>} websites
     */
    async getWebsites(directedId, kind) {
        const data = await this.getJson(`/ajax/get-${kind}-websites`, { childDirectedId: directedId });
        return Array.isArray(data?.websites) ? data.websites.map(String) : [];
    }

    /**
     * @param {string} directedId child ID
     * @param {'restricted' | 'allowlisted'} kind blocked or allowed websites
     * @param {string} website website address
     * @param {boolean} isAdding add or remove
     */
    async changeWebsite(directedId, kind, website, isAdding) {
        return this.command('POST', `/ajax/add-or-remove-${kind}-website`, {
            childDirectedId: directedId,
            isAdding,
            website,
        });
    }

    /**
     * @returns {Promise<{deviceId: string, deviceTypeId: string, name: string}[]>} kids devices of the household
     */
    async getKidsDevices() {
        const data = await this.getJson('/ajax/get-customer-devices-data', {});
        return parseKidsDevices(data);
    }

    /**
     * @param {'volume' | 'video' | 'music'} kind setting
     * @param {{deviceId: string, deviceTypeId: string}} device device
     * @returns {Promise<unknown>} answer of the dashboard
     */
    async getDeviceSetting(kind, device) {
        const path = { volume: 'get-device-volume', video: 'get-video-settings', music: 'get-music-settings' }[kind];
        return this.getJson(`/ajax/${path}`, { deviceId: device.deviceId, deviceTypeId: device.deviceTypeId });
    }

    /**
     * @param {{deviceId: string, deviceTypeId: string}} device device
     * @param {number} volume maximum volume
     */
    async setDeviceVolume(device, volume) {
        return this.command('POST', '/ajax/update-device-volume', {
            deviceId: device.deviceId,
            deviceTypeId: device.deviceTypeId,
            deviceVolume: volume,
        });
    }

    /**
     * @param {'video' | 'music' | 'filter'} kind what to switch
     * @param {{deviceId: string, deviceTypeId: string}} device device
     * @param {boolean} enable on or off
     */
    async toggleDevice(kind, device, enable) {
        const body = { deviceId: device.deviceId, deviceTypeId: device.deviceTypeId };
        if (kind === 'filter') {
            body.enableFiltering = enable;
        } else {
            body.enable = enable;
        }
        const path = {
            video: 'toggle-video-on-device',
            music: 'toggle-music-on-device',
            filter: 'toggle-elf-on-device',
        };
        return this.command('POST', `/ajax/${path[kind]}`, body);
    }
}

/**
 * Picks the Kids devices out of the household's device list.
 *
 * @param {unknown} data answer of get-customer-devices-data
 * @returns {{deviceId: string, deviceTypeId: string, name: string}[]} devices
 */
function parseKidsDevices(data) {
    const list = Array.isArray(data?.customerDevices) ? data.customerDevices : [];
    return list
        .filter(
            d =>
                d &&
                d.deviceSerialNumber &&
                d.deviceTypeId &&
                (d.kidsEditionDevice === true || d.childProfiles?.length),
        )
        .map(d => ({
            deviceId: String(d.deviceSerialNumber),
            deviceTypeId: String(d.deviceTypeId),
            name: String(d.deviceName || d.deviceSerialNumber).trim(),
        }));
}

module.exports = {
    ParentDashboard,
    parseKidsDevices,
    ParentDashboardError,
    AuthError,
    normalizeBaseUrl,
    parseCookies,
    parseHousehold,
    getWeekday,
    getDayLimit,
    sanitizeId,
};
