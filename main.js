'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const utils = require('@iobroker/adapter-core');
const {
    ParentDashboard,
    AuthError,
    normalizeBaseUrl,
    getWeekday,
    getDayLimit,
    sanitizeId,
} = require('./lib/parentDashboard');
const { AmazonLogin, detectOwnIp, getAmazonPage, isPortFree } = require('./lib/login');
const {
    getLocalTime,
    getLocalDate,
    describeDay,
    findDay,
    parseWindows,
    changeDay,
    sameSchedule,
    isSchedule,
} = require('./lib/schedule');
const { discoverEndpoints } = require('./lib/discover');
const { summarizeUsage } = require('./lib/usage');

const POLL_MIN = 5;
const POLL_MAX = 1440;
const POLL_DEFAULT = 15;
const MINUTES_MAX = 1440;
const PORT_DEFAULT = 3457;
const HOUSEHOLD_REFRESH_MS = 6 * 60 * 60 * 1000;
const SESSION_REFRESH_MS = 4 * 24 * 60 * 60 * 1000;
const SESSION_REFRESH_TIMEOUT_MS = 60000;
const CLOCK_INTERVAL_MS = 60000;
const RESTORE_JITTER_MS = 5 * 60000;
const GOAL_COMMANDS = { goalAppToday: 'APP', goalVideoToday: 'VIDEO', goalAudibleToday: 'AUDIBLE' };

const WEBSITE_COMMANDS = {
    blockWebsite: ['restricted', true],
    unblockWebsite: ['restricted', false],
    allowWebsite: ['allowlisted', true],
    disallowWebsite: ['allowlisted', false],
};
const VOLUME_MIN = 10;
const VOLUME_MAX = 100;

const DEVICE_STATES = [
    {
        id: 'volume',
        common: {
            name: 'Maximum volume',
            type: 'number',
            role: 'level.volume',
            unit: '%',
            min: VOLUME_MIN,
            max: VOLUME_MAX,
            read: true,
            write: true,
        },
    },
    {
        id: 'videoEnabled',
        common: { name: 'Prime Video allowed', type: 'boolean', role: 'switch', read: true, write: true },
    },
    {
        id: 'musicEnabled',
        common: { name: 'Music allowed', type: 'boolean', role: 'switch', read: true, write: true },
    },
    {
        id: 'musicFilter',
        common: { name: 'Explicit lyrics filter', type: 'boolean', role: 'switch', read: true, write: true },
    },
];

const CHILD_STATES = [
    {
        id: 'access.smartHome',
        common: { name: 'Allow smart home control', type: 'boolean', role: 'switch', read: true, write: true },
    },
    {
        id: 'access.explicitFilter',
        common: {
            name: 'Explicit language filter (last value sent)',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
        },
    },
    {
        id: 'access.blockedWebsites',
        common: { name: 'Blocked websites', type: 'string', role: 'json', read: true, write: false },
    },
    {
        id: 'access.allowedWebsites',
        common: { name: 'Allowed websites', type: 'string', role: 'json', read: true, write: false },
    },
    {
        id: 'access.blockWebsite',
        common: { name: 'Block a website (address)', type: 'string', role: 'text', read: true, write: true, def: '' },
    },
    {
        id: 'access.unblockWebsite',
        common: { name: 'Unblock a website (address)', type: 'string', role: 'text', read: true, write: true, def: '' },
    },
    {
        id: 'access.allowWebsite',
        common: { name: 'Allow a website (address)', type: 'string', role: 'text', read: true, write: true, def: '' },
    },
    {
        id: 'access.disallowWebsite',
        common: {
            name: 'Remove a website from the allowed list (address)',
            type: 'string',
            role: 'text',
            read: true,
            write: true,
            def: '',
        },
    },
    {
        id: 'limits.enabledToday',
        common: {
            name: 'Screen time limit active today',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        },
    },
    {
        id: 'limits.minutesToday',
        common: {
            name: 'Total screen time limit today',
            type: 'number',
            role: 'value',
            unit: 'min',
            read: true,
            write: false,
        },
    },
    {
        id: 'limits.raw',
        common: { name: 'Time limit configuration', type: 'string', role: 'json', read: true, write: false },
    },
    {
        id: 'today.allowedWindows',
        common: {
            name: 'Time windows in which use is allowed today',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.allowedNow',
        common: {
            name: 'Current time is inside an allowed time window',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.nextChange',
        common: {
            name: 'Next start or end of a time window today',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.learnFirst',
        common: {
            name: 'Learning goals must be reached before entertainment',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.usedMinutes',
        common: {
            name: 'Screen time used today',
            type: 'number',
            role: 'value',
            unit: 'min',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.remainingMinutes',
        common: {
            name: 'Screen time left today (limit plus bonus minus used time)',
            type: 'number',
            role: 'value',
            unit: 'min',
            read: true,
            write: false,
        },
    },
    {
        id: 'today.usage',
        common: { name: 'What was used today', type: 'string', role: 'json', read: true, write: false },
    },
    {
        id: 'limits.bonusMinutes',
        common: {
            name: 'Bonus time currently granted',
            type: 'number',
            role: 'value',
            unit: 'min',
            read: true,
            write: false,
        },
    },
    {
        id: 'control.clearBonus',
        common: { name: 'Remove the granted bonus time', type: 'boolean', role: 'button', read: false, write: true },
    },
    {
        id: 'schedule.windowsToday',
        common: {
            name: 'Change the allowed time windows of this weekday, e.g. 06:00-07:30, 10:00-18:00',
            type: 'string',
            role: 'text',
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.limitToday',
        common: {
            name: 'Change the total screen time limit of this weekday',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 1,
            max: MINUTES_MAX,
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.learnFirstToday',
        common: {
            name: 'Learning goals first on this weekday: entertainment only after the goals are reached',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.limitEnabledToday',
        common: {
            name: 'Total screen time limit active on this weekday',
            type: 'boolean',
            role: 'switch',
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.goalAppToday',
        common: {
            name: 'Change the daily learning goal for apps on this weekday',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 0,
            max: MINUTES_MAX,
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.goalVideoToday',
        common: {
            name: 'Change the daily learning goal for videos on this weekday',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 0,
            max: MINUTES_MAX,
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.goalAudibleToday',
        common: {
            name: 'Change the daily learning goal for audio books on this weekday',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 0,
            max: MINUTES_MAX,
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.template',
        common: { name: 'Saved weekly rules (template)', type: 'string', role: 'json', read: true, write: true },
    },
    {
        id: 'schedule.saveTemplate',
        common: {
            name: 'Save the current weekly rules as template',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        },
    },
    {
        id: 'schedule.restoreTemplate',
        common: {
            name: 'Restore the weekly rules from the template',
            type: 'boolean',
            role: 'button',
            read: false,
            write: true,
        },
    },
    {
        id: 'schedule.restoreDaily',
        common: {
            name: 'Restore the template every night shortly after midnight',
            type: 'boolean',
            role: 'switch',
            def: false,
            read: true,
            write: true,
        },
    },
    {
        id: 'schedule.backup',
        common: {
            name: 'Weekly rules before the last change by the adapter',
            type: 'string',
            role: 'json',
            read: true,
            write: false,
        },
    },
    {
        id: 'control.pause',
        common: {
            name: 'Pause devices for the given minutes (0 = resume), returns to 0 after sending',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 0,
            max: MINUTES_MAX,
            def: 0,
            read: true,
            write: true,
        },
    },
    {
        id: 'control.paused',
        common: {
            name: 'Devices are paused (only pauses set through ioBroker)',
            type: 'boolean',
            role: 'indicator',
            def: false,
            read: true,
            write: false,
        },
    },
    {
        id: 'control.pausedUntil',
        common: {
            name: 'End of the pause set through ioBroker (0 = not paused)',
            type: 'number',
            role: 'date',
            def: 0,
            read: true,
            write: false,
        },
    },
    {
        id: 'control.resume',
        common: { name: 'Resume devices', type: 'boolean', role: 'button', read: false, write: true },
    },
    {
        id: 'control.bonusTime',
        common: {
            name: 'Add bonus time in minutes, returns to 0 after sending',
            type: 'number',
            role: 'level',
            unit: 'min',
            min: 0,
            max: MINUTES_MAX,
            def: 0,
            read: true,
            write: true,
        },
    },
];

/**
 * The technical part of a state definition, used to update existing objects.
 * The name is left out, because users may rename objects.
 *
 * @param {Record<string, unknown>} common state definition
 * @returns {Record<string, unknown>} type, role, access, unit, range and default
 */
function technicalCommon(common) {
    const result = {};
    for (const key of ['type', 'role', 'read', 'write', 'unit', 'min', 'max', 'def']) {
        if (common[key] !== undefined) {
            result[key] = common[key];
        }
    }
    return result;
}

/**
 * @param {unknown} value text written by the user
 * @returns {string} website address with scheme, or an empty string
 */
function normalizeWebsite(value) {
    const text = String(value ?? '').trim();
    if (!text || text.length > 500 || /\s/.test(text)) {
        return '';
    }
    return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

class AmazonKids extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] adapter options
     */
    constructor(options = {}) {
        super({ ...options, name: 'amazon-kids' });
        this.client = null;
        this.login = null;
        this.loginActive = false;
        this.manualCookies = false;
        this.session = null;
        this.baseUrl = '';
        this.dataDir = '';
        this.pollTimer = null;
        this.pollIntervalMs = POLL_DEFAULT * 60000;
        this.children = new Map();
        this.limits = new Map();
        this.goalStates = new Set();
        this.clockTimer = null;
        this.restoreTimer = null;
        this.renewing = null;
        this.refreshWarned = false;
        this.pausedUntil = new Map();
        this.checkedObjects = new Set();
        this.devices = new Map();
        this.devicesLoadedAt = 0;
        this.lastDate = '';
        this.householdLoadedAt = 0;
        this.lastError = '';
        this.unloaded = false;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await this.setState('info.connection', false, true);
        await this.setState('info.loginUrl', '', true);

        const baseUrl = normalizeBaseUrl(this.config.baseUrl);
        if (!baseUrl) {
            this.log.error('The dashboard address is invalid. Use an address like https://eltern.amazon.de');
            return;
        }
        this.baseUrl = baseUrl;

        let minutes = Number(this.config.pollInterval);
        if (!Number.isFinite(minutes)) {
            minutes = POLL_DEFAULT;
        }
        minutes = Math.min(POLL_MAX, Math.max(POLL_MIN, Math.round(minutes)));
        this.pollIntervalMs = minutes * 60000;

        await this.subscribeStatesAsync('children.*.control.*');
        await this.subscribeStatesAsync('info.login');
        await this.subscribeStatesAsync('info.discover');
        await this.subscribeStatesAsync('children.*.schedule.*');
        await this.subscribeStatesAsync('household.*');
        await this.subscribeStatesAsync('children.*.access.*');
        await this.subscribeStatesAsync('devices.*');
        // The "allowed now" states depend on the clock, not on new data from Amazon.
        this.clockTimer = this.setInterval(() => {
            this.updateClockStates().catch(error => this.log.debug(`Clock update failed: ${error.message}`));
        }, CLOCK_INTERVAL_MS);

        const cookies = typeof this.config.cookies === 'string' ? this.config.cookies.trim() : '';
        if (cookies) {
            this.manualCookies = true;
            this.useCookies(cookies);
            await this.poll();
            return;
        }

        this.dataDir = utils.getAbsoluteInstanceDataDir(this);
        this.login = new AmazonLogin();
        this.session = await this.loadSession();
        if (this.session) {
            this.useCookies(this.session.localCookie);
            await this.poll();
        } else {
            await this.startLogin();
        }
    }

    getTimeZone() {
        const zone = typeof this.config.timeZone === 'string' ? this.config.timeZone.trim() : '';
        if (zone) {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: zone });
                return zone;
            } catch {
                this.log.warn(`Unknown time zone "${zone}", using the system time zone`);
            }
        }
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }

    useCookies(cookies) {
        if (this.client) {
            this.client.updateCookies(cookies);
        } else {
            this.client = new ParentDashboard({
                baseUrl: this.baseUrl,
                cookies,
                timeZone: this.getTimeZone(),
                renew: () => this.renewSession(),
            });
        }
    }

    // ---------------------------------------------------------------- login

    getLoginOptions() {
        const amazonPage = getAmazonPage(this.baseUrl);
        const german = amazonPage === 'amazon.de';
        let port = Math.round(Number(this.config.proxyPort));
        if (!Number.isFinite(port) || port < 1024 || port > 65535) {
            port = PORT_DEFAULT;
        }
        const ownIp = typeof this.config.proxyOwnIp === 'string' ? this.config.proxyOwnIp.trim() : '';
        return {
            proxyOwnIp: ownIp || detectOwnIp(),
            proxyPort: port,
            proxyListenBind: '0.0.0.0',
            amazonPage,
            baseAmazonPage: amazonPage === 'amazon.co.jp' ? 'amazon.co.jp' : 'amazon.com',
            acceptLanguage: german ? 'de-DE' : 'en-US',
            amazonPageProxyLanguage: german ? 'de_DE' : 'en_US',
            deviceAppName: 'ioBroker Amazon Kids',
            // The library would write this file into its own package directory otherwise.
            formerDataStorePath: path.join(this.dataDir, 'formerDataStore.json'),
            proxyCloseWindowHTML: '<b>Login successful. You can close this page.</b>',
        };
    }

    async startLogin() {
        if (this.loginActive || this.unloaded || !this.login) {
            return;
        }
        const options = this.getLoginOptions();
        if (!options.proxyOwnIp) {
            this.log.error('Cannot start the login page: enter the IP address of the ioBroker host in the settings');
            return;
        }
        if (!(await isPortFree(options.proxyPort))) {
            this.log.error(`Cannot start the login page: port ${options.proxyPort} is in use, choose another one`);
            return;
        }
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
        } catch (error) {
            this.log.error(`Cannot create the data directory: ${error.message}`);
            return;
        }
        this.loginActive = true;
        if (this.pollTimer) {
            this.clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.login.start(options, this.session, {
            onUrl: url => {
                this.log.warn(`Amazon login required: open ${url} in a browser in your home network and sign in`);
                void this.setState('info.loginUrl', url, true);
            },
            onSuccess: data => {
                this.onLoginSuccess(data).catch(error => this.handleError(error));
            },
            onError: error => this.log.warn(`Amazon login failed: ${error.message}`),
        });
    }

    async onLoginSuccess(data) {
        this.login.stop();
        this.loginActive = false;
        this.session = data;
        await this.saveSession();
        await this.setState('info.loginUrl', '', true);
        this.log.info('Amazon login successful');
        this.useCookies(data.localCookie);
        this.children = new Map();
        await this.poll();
    }

    /**
     * Called by the client when the dashboard rejects the session. All requests
     * that fail at the same time share one renewal.
     *
     * @returns {Promise<boolean>} false when the session cannot be renewed (manual cookies)
     */
    async renewSession() {
        if (this.manualCookies || !this.session) {
            return false;
        }
        if (!this.renewing) {
            this.renewing = this.refreshSession().finally(() => {
                this.renewing = null;
            });
        }
        try {
            await this.renewing;
        } catch (error) {
            throw new AuthError(`Session refresh failed: ${error.message}`);
        }
        return true;
    }

    async refreshSession() {
        let timer;
        const timeout = new Promise((resolve, reject) => {
            timer = this.setTimeout(() => reject(new Error('Session refresh timed out')), SESSION_REFRESH_TIMEOUT_MS);
        });
        try {
            this.session = await Promise.race([this.login.refresh(this.getLoginOptions(), this.session), timeout]);
        } finally {
            this.clearTimeout(timer);
        }
        this.session.tokenDate = this.session.tokenDate || Date.now();
        await this.saveSession();
        this.useCookies(this.session.localCookie);
        this.log.debug('Session cookies renewed');
    }

    async loadSession() {
        try {
            const content = await fs.readFile(path.join(this.dataDir, 'session.json'), 'utf8');
            const session = JSON.parse(this.decrypt(content));
            return session && session.localCookie && session.refreshToken ? session : null;
        } catch {
            return null;
        }
    }

    async saveSession() {
        try {
            await fs.mkdir(this.dataDir, { recursive: true });
            const content = this.encrypt(JSON.stringify(this.session));
            await fs.writeFile(path.join(this.dataDir, 'session.json'), content, { encoding: 'utf8', mode: 0o600 });
        } catch (error) {
            this.log.warn(`Cannot store the session, a new login is needed after a restart: ${error.message}`);
        }
    }

    // -------------------------------------------------------------- polling

    async poll() {
        this.pollTimer = null;
        try {
            const renewable = !this.manualCookies && this.session;
            if (renewable && Date.now() - (this.session.tokenDate || 0) > SESSION_REFRESH_MS) {
                try {
                    await this.refreshSession();
                    this.refreshWarned = false;
                } catch (error) {
                    // Requests renew the session again when the dashboard rejects it.
                    if (!this.refreshWarned) {
                        this.refreshWarned = true;
                        this.log.warn(`Scheduled session refresh failed: ${error.message}`);
                    }
                }
            }
            await this.pollOnce();
            if (this.lastError) {
                this.log.info('Connection to the Parent Dashboard restored');
                this.lastError = '';
            }
            await this.setState('info.connection', true, true);
        } catch (error) {
            await this.handleError(error);
            if (error instanceof AuthError && !this.manualCookies) {
                await this.startLogin();
            }
        }
        if (!this.unloaded && !this.loginActive) {
            this.pollTimer = this.setTimeout(() => this.poll(), this.pollIntervalMs);
        }
    }

    async pollOnce() {
        if (!this.children.size || Date.now() - this.householdLoadedAt > HOUSEHOLD_REFRESH_MS) {
            await this.loadChildren();
        }
        const weekday = getWeekday(this.getTimeZone());
        for (const [objectId, child] of this.children) {
            if (this.unloaded) {
                return;
            }
            await this.refreshChild(objectId, child, weekday);
        }
        await this.refreshDevices();
    }

    /**
     * @param {string} objectId child object ID
     * @param {{name: string, directedId: string}} child child profile
     * @param {string} weekday English weekday name
     */
    async refreshChild(objectId, child, weekday) {
        const data = await this.client.getTimeLimits(child.directedId);
        const today = getDayLimit(data, weekday);
        this.limits.set(objectId, data);
        const base = `children.${objectId}`;
        const windows = describeDay(findDay(data, weekday), '00:00').windowsText;
        await Promise.all([
            this.setState(`${base}.limits.enabledToday`, today.enabled, true),
            this.setState(`${base}.limits.minutesToday`, today.minutes, true),
            this.setState(`${base}.limits.raw`, JSON.stringify(data), true),
            this.setStateChangedAsync(`${base}.schedule.windowsToday`, windows, true),
            this.setStateChangedAsync(`${base}.schedule.limitToday`, today.minutes, true),
            this.setStateChangedAsync(
                `${base}.schedule.learnFirstToday`,
                describeDay(findDay(data, weekday), '00:00').learnFirst,
                true,
            ),
            this.setStateChangedAsync(`${base}.schedule.limitEnabledToday`, today.enabled, true),
            ...Object.entries(GOAL_COMMANDS).map(([command, category]) => {
                const minutes = describeDay(findDay(data, weekday), '00:00').goals[category.toLowerCase()];
                return this.setStateChangedAsync(`${base}.schedule.${command}`, minutes ?? null, true);
            }),
            this.updateToday(objectId, data, true),
        ]);
        await this.refreshAccess(objectId, child);
        let bonus = 0;
        try {
            bonus = await this.client.getBonusTime(child.directedId);
            await this.setStateChangedAsync(`${base}.limits.bonusMinutes`, bonus, true);
        } catch (error) {
            if (error instanceof AuthError) {
                throw error;
            }
            this.log.debug(`Cannot read the bonus time of ${child.name}: ${error.message}`);
        }
        try {
            const zone = this.getTimeZone();
            const now = Math.floor(Date.now() / 1000);
            const data = await this.client.getActivities(child.directedId, now - 86400, now);
            const usage = summarizeUsage(
                data,
                seconds => getLocalDate(zone, new Date(seconds * 1000)),
                getLocalDate(zone),
            );
            const used = Math.round(usage.usedSeconds / 60);
            const remaining =
                today.enabled && today.minutes !== null ? Math.max(0, today.minutes + bonus - used) : null;
            await Promise.all([
                this.setStateChangedAsync(`${base}.today.usedMinutes`, used, true),
                this.setStateChangedAsync(`${base}.today.remainingMinutes`, remaining, true),
                this.setStateChangedAsync(`${base}.today.usage`, JSON.stringify(usage.items), true),
            ]);
        } catch (error) {
            if (error instanceof AuthError) {
                throw error;
            }
            this.log.debug(`Cannot read the usage of ${child.name}: ${error.message}`);
        }
    }

    /**
     * Remembers a pause set through ioBroker. Amazon offers no way to read
     * the pause state back, so this is the adapter's own bookkeeping.
     *
     * @param {string} objectId child object ID
     * @param {number} until end of the pause as timestamp in ms, 0 if not paused
     */
    async setPaused(objectId, until) {
        this.pausedUntil.set(objectId, until);
        await Promise.all([
            this.setStateChangedAsync(`children.${objectId}.control.pausedUntil`, until, true),
            this.setStateChangedAsync(`children.${objectId}.control.paused`, until > Date.now(), true),
        ]);
    }

    /**
     * Logs how the dashboard answered a command, to tell an accepted command
     * from one that never reached Amazon.
     *
     * @param {string} text what was done
     * @param {{status: number, body: string} | undefined} answer answer of the dashboard
     */
    logCommand(text, answer) {
        this.log.info(text);
        if (answer) {
            this.log.debug(
                `Amazon answered HTTP ${answer.status}${answer.body ? `: ${String(answer.body).slice(0, 200)}` : ''}`,
            );
        }
    }

    // ------------------------------------------------------------- schedule

    /**
     * Writes new weekly rules and keeps the previous ones in schedule.backup.
     *
     * @param {string} objectId child object ID
     * @param {{name: string, directedId: string}} child child profile
     * @param {(current: {periodConfigurations: object[]}) => {periodConfigurations: object[]} | null} build returns the new rules, or null to leave them unchanged
     * @returns {Promise<boolean>} true if the rules were written
     */
    async writeSchedule(objectId, child, build) {
        const current = await this.client.getBaseTimeLimits(child.directedId);
        const next = build(current);
        if (!next || sameSchedule(current, next)) {
            return false;
        }
        await this.setState(`children.${objectId}.schedule.backup`, JSON.stringify(current), true);
        const answer = await this.client.setTimeLimits(child.directedId, next.periodConfigurations);
        this.log.debug(`Weekly rules of ${child.name} written, Amazon answered HTTP ${answer.status}`);
        await this.refreshChild(objectId, child, getWeekday(this.getTimeZone()));
        return true;
    }

    async readTemplate(objectId) {
        const state = await this.getStateAsync(`children.${objectId}.schedule.template`);
        if (!state || typeof state.val !== 'string' || !state.val) {
            return null;
        }
        try {
            const template = JSON.parse(state.val);
            return isSchedule(template) ? template : null;
        } catch {
            return null;
        }
    }

    async restoreTemplate(objectId, child) {
        const template = await this.readTemplate(objectId);
        if (!template) {
            this.log.warn(`No valid template stored for ${child.name}, press schedule.saveTemplate first`);
            return;
        }
        const written = await this.writeSchedule(objectId, child, () => template);
        if (written) {
            this.log.info(`Weekly rules of ${child.name} restored from the template`);
        } else {
            this.log.debug(`Weekly rules of ${child.name} already match the template`);
        }
    }

    async restoreDaily() {
        this.restoreTimer = null;
        if (this.unloaded || !this.client) {
            return;
        }
        for (const [objectId, child] of this.children) {
            try {
                const enabled = await this.getStateAsync(`children.${objectId}.schedule.restoreDaily`);
                if (enabled && enabled.val === true) {
                    await this.restoreTemplate(objectId, child);
                }
            } catch (error) {
                await this.handleError(error);
            }
        }
    }

    /**
     * @param {string} objectId child object ID
     * @param {{name: string, directedId: string}} child child profile
     * @param {string} command state name below schedule
     * @param {ioBroker.State} state written state
     */
    async onScheduleCommand(objectId, child, command, state) {
        const base = `children.${objectId}.schedule`;
        const weekday = getWeekday(this.getTimeZone());
        if (command === 'windowsToday') {
            const windows = parseWindows(state.val);
            if (!windows) {
                this.log.warn(`Ignoring ${base}.windowsToday: use a format like 06:00-07:30, 10:00-18:00`);
                return;
            }
            await this.writeSchedule(objectId, child, current => changeDay(current, weekday, { windows }));
            this.log.info(`Time windows of ${child.name} on ${weekday} changed`);
        } else if (command === 'learnFirstToday') {
            const learnFirst = Boolean(state.val);
            await this.writeSchedule(objectId, child, current => changeDay(current, weekday, { learnFirst }));
            this.log.info(`Learning goals first of ${child.name} on ${weekday} switched ${learnFirst ? 'on' : 'off'}`);
        } else if (command === 'limitEnabledToday') {
            const limitEnabled = Boolean(state.val);
            await this.writeSchedule(objectId, child, current => changeDay(current, weekday, { limitEnabled }));
            this.log.info(`Screen time limit of ${child.name} on ${weekday} switched ${limitEnabled ? 'on' : 'off'}`);
        } else if (command in GOAL_COMMANDS) {
            const minutes = Math.round(Number(state.val));
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_MAX) {
                this.log.warn(`Ignoring ${base}.${command}: value must be between 0 and ${MINUTES_MAX} minutes`);
                return;
            }
            const goals = { [`category_${GOAL_COMMANDS[command]}`]: minutes };
            await this.writeSchedule(objectId, child, current => changeDay(current, weekday, { goals }));
            this.log.info(
                `Learning goal ${GOAL_COMMANDS[command]} of ${child.name} on ${weekday} set to ${minutes} minutes`,
            );
        } else if (command === 'limitToday') {
            const minutes = Math.round(Number(state.val));
            if (!Number.isFinite(minutes) || minutes < 1 || minutes > MINUTES_MAX) {
                this.log.warn(`Ignoring ${base}.limitToday: value must be between 1 and ${MINUTES_MAX} minutes`);
                return;
            }
            await this.writeSchedule(objectId, child, current => changeDay(current, weekday, { minutes }));
            this.log.info(`Screen time limit of ${child.name} on ${weekday} set to ${minutes} minutes`);
        } else if (command === 'saveTemplate') {
            if (state.val) {
                const current = await this.client.getBaseTimeLimits(child.directedId);
                await this.setState(`${base}.template`, JSON.stringify(current), true);
                this.log.info(`Weekly rules of ${child.name} saved as template`);
            }
        } else if (command === 'restoreTemplate') {
            if (state.val) {
                await this.restoreTemplate(objectId, child);
            }
        } else if (command === 'restoreDaily') {
            await this.setState(`${base}.restoreDaily`, Boolean(state.val), true);
        } else if (command === 'template') {
            let valid = false;
            try {
                valid = isSchedule(JSON.parse(String(state.val)));
            } catch {
                valid = false;
            }
            if (valid) {
                await this.setState(`${base}.template`, String(state.val), true);
            } else {
                this.log.warn(`Ignoring ${base}.template: not a complete set of weekly rules`);
            }
        }
    }

    /**
     * @param {string} objectId child object ID
     * @param {object} data time limit configuration
     * @param {boolean} full also write the values that only change with new data
     */
    async updateToday(objectId, data, full) {
        const zone = this.getTimeZone();
        const day = describeDay(findDay(data, getWeekday(zone)), getLocalTime(zone));
        const base = `children.${objectId}.today`;
        const tasks = [
            this.setStateChangedAsync(`${base}.allowedNow`, day.allowedNow, true),
            this.setStateChangedAsync(`${base}.nextChange`, day.nextChange, true),
        ];
        if (full) {
            tasks.push(
                this.setStateChangedAsync(`${base}.allowedWindows`, day.windowsText, true),
                this.setStateChangedAsync(`${base}.learnFirst`, day.learnFirst, true),
            );
            for (const [name, minutes] of Object.entries(day.goals)) {
                tasks.push(this.setGoal(`${base}.goals.${name}`, name, minutes));
            }
        }
        await Promise.all(tasks);
    }

    async setGoal(id, name, minutes) {
        if (!this.goalStates.has(id)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: {
                    name: `Daily learning goal: ${name}`,
                    type: 'number',
                    role: 'value',
                    unit: 'min',
                    read: true,
                    write: false,
                },
                native: {},
            });
            this.goalStates.add(id);
        }
        await this.setStateChangedAsync(id, minutes, true);
    }

    async updateClockStates() {
        if (this.unloaded) {
            return;
        }
        // A new day: restore the templates after a random delay, so that not
        // every installation calls Amazon in the same second after midnight.
        const date = getLocalDate(this.getTimeZone());
        if (this.lastDate && date !== this.lastDate && !this.restoreTimer) {
            this.restoreTimer = this.setTimeout(
                () => {
                    this.restoreDaily().catch(error => this.log.debug(`Daily restore failed: ${error.message}`));
                },
                Math.floor(Math.random() * RESTORE_JITTER_MS),
            );
        }
        this.lastDate = date;
        for (const objectId of this.children.keys()) {
            const until = this.pausedUntil.get(objectId) || 0;
            if (until && until <= Date.now()) {
                await this.setPaused(objectId, 0);
            }
            const data = this.limits.get(objectId);
            if (data) {
                await this.updateToday(objectId, data, false);
            }
        }
    }

    async runDiscovery() {
        if (!this.client) {
            this.log.warn('Cannot list the dashboard endpoints: not logged in yet');
            return;
        }
        try {
            const child = [...this.children.values()][0];
            const result = await discoverEndpoints(this.client, child?.directedId);
            await this.setState('info.endpoints', JSON.stringify(result), true);
            const count = result.endpoints.length;
            this.log.debug(`Found ${count} dashboard endpoints in ${result.scripts} scripts, see info.endpoints`);
        } catch (error) {
            await this.handleError(error);
        }
    }

    async loadChildren() {
        const list = await this.client.getChildren();
        const children = new Map();
        // IDs must differ even when the case is ignored
        const usedIds = new Set();
        for (const child of list) {
            let objectId = sanitizeId(child.name) || sanitizeId(child.directedId.split('.').pop());
            if (!objectId) {
                continue;
            }
            if (usedIds.has(objectId.toLowerCase())) {
                objectId = `${objectId}_${sanitizeId(child.directedId.split('.').pop()).slice(-6)}`;
            }
            usedIds.add(objectId.toLowerCase());
            children.set(objectId, child);
        }
        if (!children.size) {
            this.log.warn('The Parent Dashboard returned no child profiles');
        }
        for (const [objectId, child] of children) {
            await this.createChildObjects(objectId, child.name);
            if (!this.pausedUntil.has(objectId)) {
                const stored = await this.getStateAsync(`children.${objectId}.control.pausedUntil`);
                const until = stored && Number(stored.val) > Date.now() ? Number(stored.val) : 0;
                await this.setPaused(objectId, until);
            }
        }
        this.children = children;
        this.householdLoadedAt = Date.now();
    }

    async createChildObjects(objectId, name) {
        const base = `children.${objectId}`;
        await this.setObjectNotExistsAsync('children', { type: 'folder', common: { name: 'Children' }, native: {} });
        await this.extendObject(base, { type: 'device', common: { name }, native: {} });
        await Promise.all([
            this.setObjectNotExistsAsync(`${base}.limits`, {
                type: 'channel',
                common: { name: 'Time limits' },
                native: {},
            }),
            this.setObjectNotExistsAsync(`${base}.today`, {
                type: 'channel',
                common: { name: 'Rules of today' },
                native: {},
            }),
            this.setObjectNotExistsAsync(`${base}.today.goals`, {
                type: 'folder',
                common: { name: 'Daily learning goals' },
                native: {},
            }),
            this.setObjectNotExistsAsync(`${base}.schedule`, {
                type: 'channel',
                common: { name: 'Change and restore the weekly rules' },
                native: {},
            }),
            this.setObjectNotExistsAsync(`${base}.access`, {
                type: 'channel',
                common: { name: 'Smart home, websites' },
                native: {},
            }),
            this.setObjectNotExistsAsync(`${base}.control`, {
                type: 'channel',
                common: { name: 'Control' },
                native: {},
            }),
        ]);
        await Promise.all(
            CHILD_STATES.map(async def => {
                const id = `${base}.${def.id}`;
                await this.setObjectNotExistsAsync(id, { type: 'state', common: def.common, native: {} });
                // Keep the technical definition of existing objects in line with this version
                // (e.g. buttons), without touching names a user may have changed.
                if (!this.checkedObjects.has(id)) {
                    this.checkedObjects.add(id);
                    await this.extendObject(id, { common: technicalCommon(def.common) });
                }
            }),
        );
    }

    async handleError(error) {
        if (this.unloaded) {
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await this.setState('info.connection', false, true);
        if (message === this.lastError) {
            this.log.debug(`Parent Dashboard request failed again: ${message}`);
            return;
        }
        this.lastError = message;
        if (!(error instanceof AuthError)) {
            this.log.warn(`Parent Dashboard request failed: ${message}`);
        } else if (this.manualCookies) {
            this.log.error(`${message}. Paste fresh session cookies into the instance settings.`);
        } else {
            this.log.error(`${message}. A new Amazon login is required.`);
        }
    }

    // ------------------------------------------------------------- commands

    /**
     * @param {string} id state ID
     * @param {ioBroker.State | null | undefined} state new state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        this.log.debug(`Command received: ${id} = ${JSON.stringify(state.val)}`);
        if (id === `${this.namespace}.info.login`) {
            if (!state.val) {
                return;
            }
            if (this.manualCookies) {
                this.log.warn('Remove the session cookies from the instance settings to use the login page');
            } else {
                await this.startLogin();
            }
            return;
        }
        if (id === `${this.namespace}.info.discover`) {
            if (state.val) {
                await this.runDiscovery();
            }
            return;
        }
        if (id.startsWith(`${this.namespace}.household.`)) {
            await this.onHouseholdCommand(id, state);
            return;
        }
        if (id.startsWith(`${this.namespace}.devices.`)) {
            await this.onDeviceCommand(id, state);
            return;
        }
        if (!id.startsWith(`${this.namespace}.children.`)) {
            return;
        }
        const [, objectId, channel, command] = id.slice(this.namespace.length + 1).split('.');
        const child = this.children.get(objectId);
        if ((channel !== 'control' && channel !== 'schedule' && channel !== 'access') || !child || !this.client) {
            this.log.warn(`Cannot handle ${id}: the child profile is not loaded yet`);
            return;
        }
        const base = `children.${objectId}.control`;
        try {
            if (channel === 'schedule') {
                await this.onScheduleCommand(objectId, child, command, state);
                return;
            }
            if (channel === 'access') {
                await this.onAccessCommand(objectId, child, command, state);
                return;
            }
            if (command === 'clearBonus') {
                if (state.val) {
                    const answer = await this.client.deleteBonusTime(child.directedId);
                    await this.setState(`children.${objectId}.limits.bonusMinutes`, 0, true);
                    this.logCommand(`Bonus time of ${child.name} removed`, answer);
                }
                return;
            }
            if (command === 'resume') {
                if (state.val) {
                    const answer = await this.client.resumeDevices(child.directedId);
                    await this.setState(`${base}.pause`, 0, true);
                    await this.setPaused(objectId, 0);
                    this.logCommand(`Devices of ${child.name} resumed`, answer);
                }
                return;
            }
            const minutes = Math.round(Number(state.val));
            if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_MAX) {
                this.log.warn(`Ignoring ${id}: value must be between 0 and ${MINUTES_MAX} minutes`);
                return;
            }
            if (command === 'pause') {
                if (minutes === 0) {
                    const answer = await this.client.resumeDevices(child.directedId);
                    await this.setPaused(objectId, 0);
                    this.logCommand(`Devices of ${child.name} resumed`, answer);
                } else {
                    const answer = await this.client.pauseDevices(child.directedId, minutes);
                    await this.setPaused(objectId, Date.now() + minutes * 60000);
                    this.logCommand(`Devices of ${child.name} paused for ${minutes} minutes`, answer);
                }
                // Command state: back to 0, so the same value can be sent again.
                await this.setState(`${base}.pause`, 0, true);
            } else if (command === 'bonusTime') {
                if (minutes > 0) {
                    const answer = await this.client.setBonusTime(child.directedId, minutes);
                    this.logCommand(`Bonus time of ${minutes} minutes added for ${child.name}`, answer);
                    const bonus = await this.client.getBonusTime(child.directedId);
                    await this.setState(`children.${objectId}.limits.bonusMinutes`, bonus, true);
                }
                await this.setState(`${base}.bonusTime`, 0, true);
            }
        } catch (error) {
            await this.handleError(error);
        }
    }

    // ------------------------------------------------- smart home, websites

    /**
     * Runs a read that may fail for one function without stopping the others.
     *
     * @param {string} what what is read, for the log
     * @param {() => Promise<void>} read the read
     */
    async tryRead(what, read) {
        try {
            await read();
        } catch (error) {
            if (error instanceof AuthError) {
                throw error;
            }
            this.log.debug(`Cannot read ${what}: ${error.message}`);
        }
    }

    /**
     * @param {string} objectId child object ID
     * @param {{name: string, directedId: string}} child child profile
     */
    async refreshAccess(objectId, child) {
        const base = `children.${objectId}.access`;
        await this.tryRead(`smart home access of ${child.name}`, async () => {
            const enabled = await this.client.getSmartHomeAccess(child.directedId);
            await this.setStateChangedAsync(`${base}.smartHome`, enabled, true);
        });
        for (const [kind, name] of [
            ['restricted', 'blockedWebsites'],
            ['allowlisted', 'allowedWebsites'],
        ]) {
            await this.tryRead(`${kind} websites of ${child.name}`, async () => {
                const websites = await this.client.getWebsites(child.directedId, kind);
                await this.setStateChangedAsync(`${base}.${name}`, JSON.stringify(websites), true);
            });
        }
    }

    /**
     * @param {string} objectId child object ID
     * @param {{name: string, directedId: string}} child child profile
     * @param {string} command state name below access
     * @param {ioBroker.State} state written state
     */
    async onAccessCommand(objectId, child, command, state) {
        const base = `children.${objectId}.access`;
        if (command === 'smartHome' || command === 'explicitFilter') {
            const enable = state.val === true || state.val === 1 || state.val === 'true';
            const answer =
                command === 'smartHome'
                    ? await this.client.setSmartHomeAccess(child.directedId, enable)
                    : await this.client.setElfAccess(child.directedId, enable);
            await this.setState(`${base}.${command}`, enable, true);
            this.logCommand(
                `${command === 'smartHome' ? 'Smart home control' : 'Explicit language filter'} of ${child.name} ${enable ? 'on' : 'off'}`,
                answer,
            );
            return;
        }
        const website = WEBSITE_COMMANDS[command];
        if (!website) {
            return;
        }
        const address = normalizeWebsite(state.val);
        // Command state: back to empty, so the same address can be sent again.
        await this.setState(`${base}.${command}`, '', true);
        if (!address) {
            if (String(state.val ?? '').trim()) {
                this.log.warn(`Ignoring ${command} of ${child.name}: not a website address`);
            }
            return;
        }
        const [kind, adding] = website;
        const answer = await this.client.changeWebsite(child.directedId, kind, address, adding);
        this.logCommand(
            `${kind === 'restricted' ? 'Blocked' : 'Allowed'} websites of ${child.name}: ${adding ? 'added' : 'removed'} ${address}`,
            answer,
        );
        await this.tryRead(`${kind} websites of ${child.name}`, async () => {
            const websites = await this.client.getWebsites(child.directedId, kind);
            await this.setStateChangedAsync(
                `${base}.${kind === 'restricted' ? 'blockedWebsites' : 'allowedWebsites'}`,
                JSON.stringify(websites),
                true,
            );
        });
    }

    // -------------------------------------------------------------- devices

    async loadDevices() {
        const list = await this.client.getKidsDevices();
        const devices = new Map();
        const usedIds = new Set();
        for (const device of list) {
            let objectId = sanitizeId(device.name) || sanitizeId(device.deviceId).slice(-8);
            if (usedIds.has(objectId.toLowerCase())) {
                objectId = `${objectId}_${sanitizeId(device.deviceId).slice(-6)}`;
            }
            usedIds.add(objectId.toLowerCase());
            devices.set(objectId, device);
        }
        await this.setObjectNotExistsAsync('devices', { type: 'folder', common: { name: 'Devices' }, native: {} });
        for (const [objectId, device] of devices) {
            await this.extendObject(`devices.${objectId}`, {
                type: 'device',
                common: { name: device.name },
                native: { deviceId: device.deviceId, deviceTypeId: device.deviceTypeId },
            });
        }
        this.devices = devices;
        this.devicesLoadedAt = Date.now();
        this.log.debug(`Found ${devices.size} Kids devices`);
    }

    /**
     * Creates a device state the first time Amazon answers for it, so that devices
     * which do not support a setting get no state for it.
     *
     * @param {string} objectId device object ID
     * @param {string} id state name, e.g. volume
     * @param {unknown} value value to set
     */
    async setDeviceState(objectId, id, value) {
        const full = `devices.${objectId}.${id}`;
        if (!this.checkedObjects.has(full)) {
            const def = DEVICE_STATES.find(item => item.id === id);
            if (!def) {
                return;
            }
            this.checkedObjects.add(full);
            await this.setObjectNotExistsAsync(full, { type: 'state', common: def.common, native: {} });
            await this.extendObject(full, { common: technicalCommon(def.common) });
        }
        await this.setStateChangedAsync(full, value, true);
    }

    async refreshDevices() {
        await this.tryRead('the devices', async () => {
            if (!this.devicesLoadedAt || Date.now() - this.devicesLoadedAt > HOUSEHOLD_REFRESH_MS) {
                await this.loadDevices();
            }
        });
        for (const [objectId, device] of this.devices) {
            // Amazon answers with an error or isSupported=false for devices without the setting
            await this.tryRead(`volume of ${device.name}`, async () => {
                const data = await this.client.getDeviceSetting('volume', device);
                const volume = Number(data?.deviceVolume);
                if (data?.isSupported !== false && data?.deviceVolume != null && Number.isFinite(volume)) {
                    await this.setDeviceState(objectId, 'volume', volume);
                }
            });
            await this.tryRead(`video settings of ${device.name}`, async () => {
                const data = await this.client.getDeviceSetting('video', device);
                const status = typeof data === 'string' ? data : data?.status;
                if (typeof status === 'string' && status) {
                    await this.setDeviceState(objectId, 'videoEnabled', /^enabled$/i.test(status));
                }
            });
            await this.tryRead(`music settings of ${device.name}`, async () => {
                const data = await this.client.getDeviceSetting('music', device);
                if (typeof data?.musicEnabled === 'boolean') {
                    await this.setDeviceState(objectId, 'musicEnabled', data.musicEnabled);
                }
                if (typeof data?.elfEnabled === 'boolean') {
                    await this.setDeviceState(objectId, 'musicFilter', data.elfEnabled);
                }
            });
        }
    }

    /**
     * @param {string} id state ID
     * @param {ioBroker.State} state written state
     */
    async onDeviceCommand(id, state) {
        const [, objectId, command] = id.slice(this.namespace.length + 1).split('.');
        const device = this.devices.get(objectId);
        if (!device || !this.client) {
            this.log.warn(`Cannot handle ${id}: the device is not loaded yet`);
            return;
        }
        const base = `devices.${objectId}`;
        try {
            if (command === 'volume') {
                const volume = Math.round(Number(state.val));
                if (!Number.isFinite(volume) || volume < VOLUME_MIN || volume > VOLUME_MAX) {
                    this.log.warn(`Ignoring ${id}: value must be between ${VOLUME_MIN} and ${VOLUME_MAX}`);
                    return;
                }
                const answer = await this.client.setDeviceVolume(device, volume);
                await this.setState(`${base}.volume`, volume, true);
                this.logCommand(`Maximum volume of ${device.name} set to ${volume}`, answer);
                return;
            }
            const kind = { videoEnabled: 'video', musicEnabled: 'music', musicFilter: 'filter' }[command];
            if (!kind) {
                return;
            }
            const enable = state.val === true || state.val === 1 || state.val === 'true';
            const answer = await this.client.toggleDevice(kind, device, enable);
            await this.setState(`${base}.${command}`, enable, true);
            this.logCommand(`${command} of ${device.name} ${enable ? 'on' : 'off'}`, answer);
        } catch (error) {
            await this.handleError(error);
        }
    }

    /**
     * @param {string} id state ID
     * @param {ioBroker.State} state written state
     */
    async onHouseholdCommand(id, state) {
        if (!this.client) {
            this.log.warn(`Cannot handle ${id}: not logged in yet`);
            return;
        }
        const command = id.split('.').pop();
        try {
            if (command === 'resume') {
                if (state.val) {
                    const answer = await this.client.setHouseholdOffscreenTime(0);
                    await this.setState('household.pause', 0, true);
                    await Promise.all([...this.children.keys()].map(objectId => this.setPaused(objectId, 0)));
                    this.logCommand('Devices of all children resumed', answer);
                }
            } else if (command === 'pause') {
                const minutes = Math.round(Number(state.val));
                if (!Number.isFinite(minutes) || minutes < 0 || minutes > MINUTES_MAX) {
                    this.log.warn(`Ignoring ${id}: value must be between 0 and ${MINUTES_MAX} minutes`);
                    return;
                }
                const answer = await this.client.setHouseholdOffscreenTime(minutes);
                const until = minutes === 0 ? 0 : Date.now() + minutes * 60000;
                await Promise.all([...this.children.keys()].map(objectId => this.setPaused(objectId, until)));
                await this.setState('household.pause', 0, true);
                this.logCommand(
                    minutes
                        ? `Devices of all children paused for ${minutes} minutes`
                        : 'Devices of all children resumed',
                    answer,
                );
            }
        } catch (error) {
            await this.handleError(error);
        }
    }

    /**
     * @param {() => void} callback unload callback
     */
    onUnload(callback) {
        this.unloaded = true;
        try {
            if (this.pollTimer) {
                this.clearTimeout(this.pollTimer);
                this.pollTimer = null;
            }
            if (this.clockTimer) {
                this.clearInterval(this.clockTimer);
                this.clockTimer = null;
            }
            if (this.restoreTimer) {
                this.clearTimeout(this.restoreTimer);
                this.restoreTimer = null;
            }
            if (this.login) {
                this.login.stop();
            }
        } finally {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new AmazonKids(options);
} else {
    new AmazonKids();
}
