'use strict';
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

// Minimal stand-in for the adapter base class, so main.js can run against a mocked dashboard.
class FakeAdapter extends EventEmitter {
    constructor(options) {
        super();
        this.name = options.name;
        this.namespace = `${options.name}.0`;
        this.config = options.config || {};
        this.objects = new Map();
        this.states = new Map();
        this.logs = [];
        this.timers = new Set();
        this.log = {};
        for (const level of ['debug', 'info', 'warn', 'error']) {
            this.log[level] = message => this.logs.push(`${level}: ${message}`);
        }
    }
    async setState(id, val, ack) {
        this.states.set(id, { val, ack });
    }
    async setStateChangedAsync(id, val, ack) {
        this.states.set(id, { val, ack });
    }
    setInterval(fn, ms) {
        const timer = { fn, ms, interval: true };
        this.intervals = this.intervals || new Set();
        this.intervals.add(timer);
        return timer;
    }
    clearInterval(timer) {
        this.intervals.delete(timer);
    }
    async getStateAsync(id) {
        return this.states.get(id) || null;
    }
    async setObjectNotExistsAsync(id, obj) {
        if (!this.objects.has(id)) {
            this.objects.set(id, obj);
        }
    }
    async extendObject(id, obj) {
        const old = this.objects.get(id) || {};
        this.objects.set(id, { ...old, ...obj, common: { ...(old.common || {}), ...(obj.common || {}) } });
    }
    async subscribeStatesAsync(pattern) {
        this.subscribed = [...(this.subscribed || []), pattern];
    }
    encrypt(value) {
        return Buffer.from(value, 'utf8').toString('hex');
    }
    decrypt(value) {
        return Buffer.from(value, 'hex').toString('utf8');
    }
    setTimeout(fn, ms) {
        const timer = { fn, ms };
        this.timers.add(timer);
        return timer;
    }
    clearTimeout(timer) {
        this.timers.delete(timer);
    }
}

const mainPath = path.join(__dirname, '..', 'main.js');
const originalLoad = Module._load;
const originalFetch = globalThis.fetch;

function page(members) {
    const literal = JSON.stringify(JSON.stringify({ members })).slice(1, -1);
    return `<script>window.__PREFETCHED_HOUSEHOLD = JSON.parse('${literal}');</script>`;
}

function response(status, { text = '', json, location } = {}) {
    return {
        status,
        ok: status < 300,
        headers: { get: name => (name === 'location' ? location || null : null), getSetCookie: () => [] },
        text: async () => (json !== undefined && !text ? JSON.stringify(json) : text),
        json: async () => json,
    };
}

let dataDir;
let amazon;

// Stand-in for alexa-cookie2: records the calls and lets a test finish the login.
function createAmazon() {
    return {
        generate: [],
        refreshes: 0,
        stopped: 0,
        refreshResult: { localCookie: 'session-id=RENEWED', refreshToken: 'REFRESH', tokenDate: Date.now() },
        generateAlexaCookie(options, callback) {
            this.generate.push(options);
            this.finish = data => callback(null, data);
            callback(
                new Error(`Please open http://${options.proxyOwnIp}:${options.proxyPort}/ with your browser and login`),
                null,
            );
        },
        refreshAlexaCookie(options, callback) {
            this.refreshes++;
            if (this.refreshResult) {
                callback(null, this.refreshResult);
            } else {
                callback(new Error('invalid_grant'), null);
            }
        },
        stopProxyServer() {
            this.stopped++;
        },
    };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

async function start(config, handler) {
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
        return handler(String(url), init);
    };
    Module._load = function (request, ...rest) {
        if (request === '@iobroker/adapter-core') {
            return { Adapter: FakeAdapter, getAbsoluteInstanceDataDir: () => dataDir };
        }
        if (request === 'alexa-cookie2') {
            return amazon;
        }
        return originalLoad.call(this, request, ...rest);
    };
    delete require.cache[mainPath];
    const adapter = require(mainPath)({ config });
    await adapter.onReady();
    return { adapter, requests };
}

const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const limits = {
    periodConfigurations: days.map(name => ({
        type: 'DayOfWeek',
        name,
        enabled: true,
        timeLimits: { contentTimeLimitsEnabled: true, contentTimeLimits: { ALL: 75 } },
        goalsConfig: { learnFirstEnabled: true, contentGoals: { category_VIDEO: 0, category_APP: 30 } },
        curfewConfigList: [
            { start: '10:00', end: '17:00', type: null, enabled: true },
            { start: '06:00', end: '07:30', type: null, enabled: true },
            { start: '20:00', end: '21:00', type: null, enabled: false },
        ],
    })),
};
const dashboard = url => {
    if (url.includes('get-adjusted-time-limits') || url.includes('get-time-limit-v2')) {
        return response(200, { json: limits });
    }
    if (url.includes('get-bonus-time')) {
        return response(200, { text: '20' });
    }
    if (url.includes('get-weekly-activities-v2')) {
        const now = Math.floor(Date.now() / 1000);
        return response(200, {
            json: {
                activityV2Data: [
                    {
                        category: 'APP',
                        aggregatedDuration: 9999,
                        intervals: [
                            { startTime: now - 3 * 86400, endTime: now - 2 * 86400, aggregatedDuration: 6000 },
                            {
                                startTime: now - 60,
                                endTime: now + 600,
                                aggregatedDuration: 1800,
                                aggregatedActivityResults: [
                                    { key: 'a', activityDuration: 1500, attributes: { TITLE: 'Game' } },
                                    { key: 'b', activityDuration: 10, attributes: { TITLE: 'Launcher' } },
                                ],
                            },
                        ],
                    },
                    {
                        category: 'VIDEO',
                        intervals: [{ startTime: now - 60, endTime: now + 600, aggregatedDuration: 600 }],
                    },
                ],
            },
        });
    }
    if (url.includes('get-smart-home-access')) {
        return response(200, { json: { smartHomeEnabled: true } });
    }
    if (url.includes('get-restricted-websites')) {
        return response(200, { json: { websites: ['https://bad.example/'] } });
    }
    if (url.includes('get-allowlisted-websites')) {
        return response(200, { json: { websites: [] } });
    }
    if (url.includes('get-customer-devices-data')) {
        return response(200, {
            json: {
                customerDevices: [
                    { deviceName: 'iPhone', deviceSerialNumber: 'PHONE', deviceTypeId: 'T0', childProfiles: [] },
                    {
                        deviceName: "Ben's Fire",
                        deviceSerialNumber: 'SER1',
                        deviceTypeId: 'TYPE1',
                        kidsEditionDevice: true,
                        childProfiles: [],
                    },
                ],
            },
        });
    }
    if (url.includes('get-device-volume')) {
        return response(200, { json: { deviceVolume: 60 } });
    }
    if (url.includes('get-video-settings')) {
        return response(200, { json: 'ENABLED' });
    }
    if (url.includes('get-music-settings')) {
        return response(200, { json: { musicEnabled: false, elfEnabled: true } });
    }
    if (url.includes('/ajax/')) {
        return response(200, { json: {} });
    }
    return response(200, {
        text: page([
            { role: 'CHILD', firstName: 'Mia Sophie', directedId: 'amzn1.account.AAA' },
            { role: 'CHILD', firstName: 'Ben', directedId: 'amzn1.account.BBB' },
        ]),
    });
};
const config = {
    baseUrl: 'https://eltern.amazon.de',
    cookies: 'session-id=SECRET; ft-panda-csrf-token=TOK',
    pollInterval: 1,
};

const proxyConfig = { baseUrl: 'https://eltern.amazon.de', cookies: '', proxyOwnIp: '192.168.1.10', proxyPort: 38457 };

describe('adapter', () => {
    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amazon-kids-'));
        amazon = createAmazon();
    });
    afterEach(() => {
        fs.rmSync(dataDir, { recursive: true, force: true });
        Module._load = originalLoad;
        globalThis.fetch = originalFetch;
    });

    it('offers the login page when no session exists', async () => {
        const { adapter, requests } = await start(proxyConfig, dashboard);
        await tick();
        assert.strictEqual(requests.length, 0);
        assert.strictEqual(adapter.timers.size, 0);
        assert.deepStrictEqual(adapter.states.get('info.loginUrl'), { val: 'http://192.168.1.10:38457', ack: true });
        const options = amazon.generate[0];
        assert.strictEqual(options.amazonPage, 'amazon.de');
        assert.strictEqual(options.formerDataStorePath, path.join(dataDir, 'formerDataStore.json'));
        assert.strictEqual(options.logger, undefined);
    });

    it('stores the login encrypted and starts polling', async () => {
        const { adapter, requests } = await start(proxyConfig, dashboard);
        amazon.finish({ localCookie: 'session-id=LOGIN', refreshToken: 'REFRESH', tokenDate: Date.now() });
        await tick();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.strictEqual(amazon.stopped, 1);
        assert.deepStrictEqual(adapter.states.get('info.loginUrl'), { val: '', ack: true });
        assert.deepStrictEqual(adapter.states.get('info.connection'), { val: true, ack: true });
        assert.ok(requests.length > 0);
        const stored = fs.readFileSync(path.join(dataDir, 'session.json'), 'utf8');
        assert.ok(!stored.includes('REFRESH') && !stored.includes('LOGIN'));
        assert.ok(!adapter.logs.some(line => /REFRESH|LOGIN/.test(line)));

        const second = await start(proxyConfig, dashboard);
        assert.strictEqual(amazon.generate.length, 1);
        assert.deepStrictEqual(second.adapter.states.get('info.connection'), { val: true, ack: true });
    });

    it('renews rejected cookies with the refresh token', async () => {
        const first = await start(proxyConfig, dashboard);
        amazon.finish({ localCookie: 'session-id=OLD', refreshToken: 'REFRESH', tokenDate: Date.now() });
        await new Promise(resolve => setTimeout(resolve, 50));
        first.adapter.onUnload(() => {});

        const signin = response(302, { location: 'https://www.amazon.de/ap/signin' });
        const { adapter } = await start(proxyConfig, (url, init) =>
            init.headers.cookie.includes('RENEWED') ? dashboard(url) : signin,
        );
        assert.strictEqual(amazon.refreshes, 1);
        assert.deepStrictEqual(adapter.states.get('info.connection'), { val: true, ack: true });
        assert.strictEqual(amazon.generate.length, 1);
    });

    it('asks for a new login when the refresh fails', async () => {
        const first = await start(proxyConfig, dashboard);
        amazon.finish({ localCookie: 'session-id=OLD', refreshToken: 'REFRESH', tokenDate: Date.now() });
        await new Promise(resolve => setTimeout(resolve, 50));
        first.adapter.onUnload(() => {});

        amazon.refreshResult = null;
        const { adapter } = await start(proxyConfig, () =>
            response(302, { location: 'https://www.amazon.de/ap/signin' }),
        );
        await tick();
        assert.strictEqual(amazon.generate.length, 2);
        assert.strictEqual(amazon.generate[1].formerRegistrationData.refreshToken, 'REFRESH');
        assert.deepStrictEqual(adapter.states.get('info.connection'), { val: false, ack: true });
        assert.strictEqual(adapter.states.get('info.loginUrl').val, 'http://192.168.1.10:38457');
        assert.strictEqual(adapter.timers.size, 0);
    });

    it('refuses a non Amazon address', async () => {
        const { adapter, requests } = await start({ ...config, baseUrl: 'https://example.com' }, dashboard);
        assert.strictEqual(requests.length, 0);
        assert.ok(adapter.logs.some(line => line.startsWith('error:')));
    });

    it('creates the object tree and publishes the limits', async () => {
        const { adapter } = await start(config, dashboard);
        assert.strictEqual(adapter.objects.get('children').type, 'folder');
        assert.strictEqual(adapter.objects.get('children.Mia_Sophie').type, 'device');
        assert.strictEqual(adapter.objects.get('children.Mia_Sophie').common.name, 'Mia Sophie');
        assert.strictEqual(adapter.objects.get('children.Ben.control').type, 'channel');
        const button = adapter.objects.get('children.Ben.control.resume').common;
        assert.deepStrictEqual([button.role, button.read, button.write], ['button', false, true]);
        assert.deepStrictEqual(adapter.states.get('children.Ben.limits.minutesToday'), { val: 75, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.limits.enabledToday'), { val: true, ack: true });
        assert.deepStrictEqual(adapter.states.get('info.connection'), { val: true, ack: true });
        assert.deepStrictEqual(adapter.subscribed, [
            'children.*.control.*',
            'info.login',
            'info.discover',
            'children.*.schedule.*',
            'household.*',
            'children.*.access.*',
            'devices.*',
        ]);
    });

    it('publishes the rules of today', async () => {
        const { adapter } = await start(config, dashboard);
        const state = id => adapter.states.get(`children.Ben.today.${id}`);
        assert.deepStrictEqual(state('allowedWindows'), { val: '06:00-07:30, 10:00-17:00', ack: true });
        assert.deepStrictEqual(state('learnFirst'), { val: true, ack: true });
        assert.deepStrictEqual(state('goals.app'), { val: 30, ack: true });
        assert.deepStrictEqual(state('goals.video'), { val: 0, ack: true });
        assert.strictEqual(typeof state('allowedNow').val, 'boolean');
        assert.strictEqual(adapter.objects.get('children.Ben.today').type, 'channel');
        assert.strictEqual(adapter.objects.get('children.Ben.today.goals.app').common.unit, 'min');
        assert.strictEqual(adapter.intervals.size, 1);
        await [...adapter.intervals][0].fn();
        adapter.onUnload(() => {});
        assert.strictEqual(adapter.intervals.size, 0);
    });

    it('diagnoses the dashboard read-only and keeps cookies on the dashboard host', async () => {
        const seen = [];
        const { adapter } = await start(config, (url, init) => {
            seen.push({ url, method: init.method, cookie: init.headers && init.headers.cookie });
            if (url === 'https://m.media-amazon.com/app.js') {
                return response(200, {
                    text: 'e.updateDeviceVolume="ajax/update-device-volume",e.getHousehold="ajax/get-household";call({url:r.updateDeviceVolume,method:"POST",data:{childDirectedId:e}})',
                });
            }
            if (url.includes('get-bonus-time')) {
                return response(200, { text: '{"bonus":15}' });
            }
            if (url.includes('/ajax/')) {
                return dashboard(url);
            }
            return response(200, {
                text: `${page([{ role: 'CHILD', firstName: 'Ben', directedId: 'amzn1.account.BBB' }])}<script src="https://m.media-amazon.com/app.js"></script><script src="https://evil.example/x.js"></script>`,
            });
        });
        const before = seen.length;
        await adapter.onStateChange('amazon-kids.0.info.discover', { val: true, ack: false });
        const result = JSON.parse(adapter.states.get('info.endpoints').val);
        assert.deepStrictEqual(result.endpoints, ['/ajax/get-household', '/ajax/update-device-volume']);
        assert.match(result.usages['/ajax/update-device-volume'][0], /method:"POST",data:\{childDirectedId/);
        assert.strictEqual(result.usages['/ajax/get-household'], undefined);
        assert.deepStrictEqual(result.probes['get-bonus-time'], { status: 200, body: '{"bonus":15}' });
        assert.strictEqual(result.scripts, 1);
        const during = seen.slice(before);
        assert.ok(during.every(entry => entry.method === 'GET'));
        assert.strictEqual(during.find(entry => entry.url.startsWith('https://m.media-amazon.com')).cookie, undefined);
        assert.ok(!seen.some(entry => entry.url.includes('evil.example')));
    });

    it('publishes used and remaining time of today', async () => {
        const { adapter } = await start(config, dashboard);
        const state = id => adapter.states.get(`children.Ben.today.${id}`);
        // 1800 s apps + 600 s video = 40 min used; limit 75 + bonus 20
        assert.deepStrictEqual(state('usedMinutes'), { val: 40, ack: true });
        assert.deepStrictEqual(state('remainingMinutes'), { val: 55, ack: true });
        assert.deepStrictEqual(JSON.parse(state('usage').val), [{ title: 'Game', category: 'APP', minutes: 25 }]);
        await adapter.onStateChange('amazon-kids.0.children.Ben.control.pause', { val: 10, ack: false });
        assert.ok(adapter.logs.includes('info: Devices of Ben paused for 10 minutes'));
        assert.ok(adapter.logs.some(line => line.startsWith('debug: Amazon answered HTTP 200')));
    });

    it('changes the rules of the current weekday and keeps a backup', async () => {
        const { adapter, requests } = await start(config, dashboard);
        const id = 'amazon-kids.0.children.Ben.schedule';
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.windowsToday'), {
            val: '06:00-07:30, 10:00-17:00',
            ack: true,
        });
        assert.deepStrictEqual(adapter.states.get('children.Ben.limits.bonusMinutes'), { val: 20, ack: true });

        const before = requests.length;
        await adapter.onStateChange(`${id}.windowsToday`, { val: 'bis 18 Uhr', ack: false });
        await adapter.onStateChange(`${id}.limitToday`, { val: 0, ack: false });
        assert.strictEqual(requests.length, before);

        await adapter.onStateChange(`${id}.windowsToday`, { val: '6:00-07:30, 10:00-18:00', ack: false });
        const put = requests.find(entry => entry.method === 'PUT');
        assert.ok(put.url.endsWith('/ajax/set-time-limit-v2'));
        assert.strictEqual(put.body.childDirectedId, 'amzn1.account.BBB');
        assert.strictEqual(put.body.periodConfigurations.length, 7);
        const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
        const changed = put.body.periodConfigurations.filter(day =>
            JSON.stringify(day.curfewConfigList).includes('18:00'),
        );
        assert.deepStrictEqual(
            changed.map(day => day.name),
            [weekday],
        );
        assert.deepStrictEqual(changed[0].curfewConfigList, [
            { start: '06:00', end: '07:30', type: null, enabled: true },
            { start: '10:00', end: '18:00', type: null, enabled: true },
        ]);
        assert.strictEqual(changed[0].timeLimits.contentTimeLimits.ALL, 75);
        assert.strictEqual(
            JSON.parse(adapter.states.get('children.Ben.schedule.backup').val).periodConfigurations.length,
            7,
        );

        await adapter.onStateChange(`${id}.limitToday`, { val: 90, ack: false });
        const second = requests.filter(entry => entry.method === 'PUT')[1];
        assert.strictEqual(
            second.body.periodConfigurations.find(day => day.name === weekday).timeLimits.contentTimeLimits.ALL,
            90,
        );
    });

    it('switches learning goals first and repairs button definitions', async () => {
        const { adapter, requests } = await start(config, dashboard);
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.learnFirstToday'), { val: true, ack: true });
        await adapter.onStateChange('amazon-kids.0.children.Ben.schedule.learnFirstToday', { val: true, ack: false });
        assert.ok(!requests.some(entry => entry.method === 'PUT'));
        await adapter.onStateChange('amazon-kids.0.children.Ben.schedule.learnFirstToday', { val: false, ack: false });
        const put = requests.find(entry => entry.method === 'PUT');
        const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
        const off = put.body.periodConfigurations.filter(day => day.goalsConfig.learnFirstEnabled === false);
        assert.deepStrictEqual(
            off.map(day => day.name),
            [weekday],
        );
        assert.deepStrictEqual(off[0].goalsConfig.contentGoals, { category_VIDEO: 0, category_APP: 30 });

        // an object left over from an older version gets its button definition back
        const second = await start(config, dashboard);
        second.adapter.objects.set('children.Ben.control.resume', {
            type: 'state',
            common: { name: 'My name', type: 'boolean', role: 'switch', read: true, write: true },
        });
        second.adapter.checkedObjects.clear();
        await second.adapter.createChildObjects('Ben', 'Ben');
        const common = second.adapter.objects.get('children.Ben.control.resume').common;
        assert.deepStrictEqual([common.role, common.read, common.write], ['button', false, true]);
    });

    it('changes learning goals and switches the limit of the weekday', async () => {
        const { adapter, requests } = await start(config, dashboard);
        const id = 'amazon-kids.0.children.Ben.schedule';
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.goalAppToday'), { val: 30, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.goalAudibleToday'), { val: null, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.limitEnabledToday'), { val: true, ack: true });
        const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(new Date());
        const today = () =>
            requests
                .filter(entry => entry.method === 'PUT')
                .at(-1)
                .body.periodConfigurations.find(day => day.name === weekday);

        await adapter.onStateChange(`${id}.goalAppToday`, { val: 45, ack: false });
        assert.deepStrictEqual(today().goalsConfig.contentGoals, { category_VIDEO: 0, category_APP: 45 });
        await adapter.onStateChange(`${id}.limitEnabledToday`, { val: false, ack: false });
        assert.strictEqual(today().timeLimits.contentTimeLimitsEnabled, false);

        const count = requests.filter(entry => entry.method === 'PUT').length;
        await adapter.onStateChange(`${id}.goalAudibleToday`, { val: 10, ack: false });
        await adapter.onStateChange(`${id}.goalVideoToday`, { val: -5, ack: false });
        assert.strictEqual(requests.filter(entry => entry.method === 'PUT').length, count);
        assert.ok(adapter.logs.some(line => line.startsWith('warn:') && line.includes('category_AUDIBLE')));
    });

    it('saves a template and restores it only when the rules differ', async () => {
        let stored = JSON.parse(JSON.stringify(limits));
        const { adapter, requests } = await start(config, (url, init) => {
            if (url.includes('set-time-limit-v2')) {
                stored = { periodConfigurations: JSON.parse(init.body).periodConfigurations };
                return response(200, { json: {} });
            }
            if (url.includes('time-limit')) {
                return response(200, { json: stored });
            }
            return dashboard(url);
        });
        const id = 'amazon-kids.0.children.Ben.schedule';
        const puts = () => requests.filter(entry => entry.method === 'PUT').length;

        await adapter.onStateChange(`${id}.restoreTemplate`, { val: true, ack: false });
        assert.strictEqual(puts(), 0);
        await adapter.onStateChange(`${id}.template`, { val: '{"periodConfigurations":[]}', ack: false });
        assert.strictEqual(adapter.states.get('children.Ben.schedule.template'), undefined);

        await adapter.onStateChange(`${id}.saveTemplate`, { val: true, ack: false });
        assert.strictEqual(
            JSON.parse(adapter.states.get('children.Ben.schedule.template').val).periodConfigurations.length,
            7,
        );
        await adapter.onStateChange(`${id}.restoreTemplate`, { val: true, ack: false });
        assert.strictEqual(puts(), 0);

        await adapter.onStateChange(`${id}.windowsToday`, { val: '06:00-22:00', ack: false });
        assert.strictEqual(puts(), 1);
        assert.ok(JSON.stringify(stored).includes('22:00'));

        // nightly restore: only for children with the switch on, triggered by the date change
        adapter.lastDate = '2000-01-01';
        await adapter.updateClockStates();
        const timer = [...adapter.timers].find(entry => entry.ms < 5 * 60000);
        adapter.timers.delete(timer);
        await timer.fn();
        assert.strictEqual(puts(), 1);

        await adapter.onStateChange(`${id}.restoreDaily`, { val: true, ack: false });
        assert.deepStrictEqual(adapter.states.get('children.Ben.schedule.restoreDaily'), { val: true, ack: true });
        await adapter.restoreDaily();
        assert.strictEqual(puts(), 2);
        assert.ok(!JSON.stringify(stored).includes('22:00'));
        await adapter.restoreDaily();
        assert.strictEqual(puts(), 2);
    });

    it('pauses all children and removes bonus time', async () => {
        const { adapter, requests } = await start(config, dashboard);
        await adapter.onStateChange('amazon-kids.0.household.pause', { val: 30, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/set-household-offscreen-time'));
        assert.deepStrictEqual(requests.at(-1).body, { expirationTimeInSeconds: 1800 });
        assert.deepStrictEqual(adapter.states.get('household.pause'), { val: 0, ack: true });
        assert.strictEqual(adapter.states.get('children.Ben.control.paused').val, true);
        assert.strictEqual(adapter.states.get('children.Mia_Sophie.control.paused').val, true);
        await adapter.onStateChange('amazon-kids.0.household.resume', { val: true, ack: false });
        assert.deepStrictEqual(requests.at(-1).body, { expirationTimeInSeconds: -1 });
        await adapter.onStateChange('amazon-kids.0.children.Ben.control.clearBonus', { val: true, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/delete-bonus-time'));
        assert.strictEqual(requests.at(-1).method, 'PUT');
        assert.deepStrictEqual(requests.at(-1).body, { childDirectedId: 'amzn1.account.BBB' });
        assert.deepStrictEqual(adapter.states.get('children.Ben.limits.bonusMinutes'), { val: 0, ack: true });
    });

    it('enforces the minimum poll interval and stops on unload', async () => {
        const { adapter } = await start(config, dashboard);
        assert.strictEqual(adapter.timers.size, 1);
        assert.strictEqual([...adapter.timers][0].ms, 5 * 60000);
        let done = 0;
        adapter.onUnload(() => done++);
        assert.strictEqual(done, 1);
        assert.strictEqual(adapter.timers.size, 0);
    });

    it('handles commands only with ack=false and acknowledges them', async () => {
        const { adapter, requests } = await start(config, dashboard);
        const before = requests.length;
        const id = 'amazon-kids.0.children.Ben.control';
        await adapter.onStateChange(`${id}.pause`, { val: 30, ack: true });
        assert.strictEqual(requests.length, before);

        await adapter.onStateChange(`${id}.pause`, { val: 30, ack: false });
        assert.deepStrictEqual(requests.at(-1).body, {
            directedIds: ['amzn1.account.BBB'],
            expirationTimeInSeconds: 1800,
        });
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.pause'), { val: 0, ack: true });
        assert.strictEqual(adapter.states.get('children.Ben.control.paused').val, true);
        const until = adapter.states.get('children.Ben.control.pausedUntil').val;
        assert.ok(Math.abs(until - (Date.now() + 30 * 60000)) < 5000);

        // the same value can be sent again
        const again = requests.length;
        await adapter.onStateChange(`${id}.pause`, { val: 30, ack: false });
        assert.strictEqual(requests.length, again + 1);

        await adapter.onStateChange(`${id}.resume`, { val: true, ack: false });
        assert.strictEqual(requests.at(-1).body.expirationTimeInSeconds, -1);
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.pause'), { val: 0, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.paused'), { val: false, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.pausedUntil'), { val: 0, ack: true });

        // an expired pause is cleared by the clock
        adapter.pausedUntil.set('Ben', Date.now() - 1000);
        adapter.states.set('children.Ben.control.paused', { val: true, ack: true });
        await adapter.updateClockStates();
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.paused'), { val: false, ack: true });

        await adapter.onStateChange(`${id}.bonusTime`, { val: 15, ack: false });
        const bonus = requests.filter(entry => entry.method === 'PUT').at(-1);
        assert.strictEqual(bonus.body.bonusTimeDurationInMinutes, 15);
        assert.strictEqual(bonus.body.childDirectedId, 'amzn1.account.BBB');
        assert.deepStrictEqual(adapter.states.get('children.Ben.limits.bonusMinutes'), { val: 20, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.control.bonusTime'), { val: 0, ack: true });

        const count = requests.length;
        await adapter.onStateChange(`${id}.pause`, { val: 99999, ack: false });
        await adapter.onStateChange(`${id}.bonusTime`, { val: 'abc', ack: false });
        assert.strictEqual(requests.length, count);
    });

    it('reports an expired session once and never logs the cookies', async () => {
        const { adapter } = await start(config, () => response(302, { location: 'https://www.amazon.de/ap/signin' }));
        const timer = [...adapter.timers][0];
        adapter.timers.delete(timer);
        await timer.fn();
        assert.deepStrictEqual(adapter.states.get('info.connection'), { val: false, ack: true });
        assert.strictEqual(adapter.logs.filter(line => line.startsWith('error:')).length, 1);
        assert.ok(!adapter.logs.some(line => /SECRET|TOK/.test(line)));
        assert.strictEqual(adapter.timers.size, 1);
    });

    it('reads smart home, websites and Kids devices', async () => {
        const { adapter } = await start(config, dashboard);
        assert.deepStrictEqual(adapter.states.get('children.Ben.access.smartHome'), { val: true, ack: true });
        assert.deepStrictEqual(adapter.states.get('children.Ben.access.blockedWebsites'), {
            val: '["https://bad.example/"]',
            ack: true,
        });
        assert.deepStrictEqual(adapter.states.get('children.Ben.access.allowedWebsites'), { val: '[]', ack: true });
        assert.deepStrictEqual([...adapter.devices.keys()], ['Ben_s_Fire']);
        assert.deepStrictEqual(adapter.states.get('devices.Ben_s_Fire.volume'), { val: 60, ack: true });
        assert.deepStrictEqual(adapter.states.get('devices.Ben_s_Fire.videoEnabled'), { val: true, ack: true });
        assert.deepStrictEqual(adapter.states.get('devices.Ben_s_Fire.musicEnabled'), { val: false, ack: true });
        assert.deepStrictEqual(adapter.states.get('devices.Ben_s_Fire.musicFilter'), { val: true, ack: true });
    });

    it('creates no device states when the device does not support the settings', async () => {
        const unsupported = (url, options) => {
            if (url.includes('get-device-volume')) {
                return response(200, { json: { isSupported: false, deviceVolume: null } });
            }
            if (url.includes('get-video-settings') || url.includes('get-music-settings')) {
                return response(400, { text: '' });
            }
            return dashboard(url, options);
        };
        const { adapter } = await start(config, unsupported);
        assert.deepStrictEqual([...adapter.devices.keys()], ['Ben_s_Fire']);
        for (const id of ['volume', 'videoEnabled', 'musicEnabled', 'musicFilter']) {
            assert.strictEqual(adapter.states.has(`devices.Ben_s_Fire.${id}`), false);
        }
    });

    it('sends the documented bodies for smart home, websites and devices', async () => {
        const { adapter, requests } = await start(config, dashboard);
        const child = 'amazon-kids.0.children.Ben.access';
        await adapter.onStateChange(`${child}.smartHome`, { val: false, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/set-smart-home-access'));
        assert.deepStrictEqual(requests.at(-1).body, { childDirectedId: 'amzn1.account.BBB', enable: false });
        assert.deepStrictEqual(adapter.states.get('children.Ben.access.smartHome'), { val: false, ack: true });

        await adapter.onStateChange(`${child}.explicitFilter`, { val: true, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/set-elf-access'));
        assert.deepStrictEqual(requests.at(-1).body, { childDirectedId: 'amzn1.account.BBB', enable: true });

        await adapter.onStateChange(`${child}.blockWebsite`, { val: 'bad.example/x', ack: false });
        const change = requests.filter(entry => entry.url.endsWith('/ajax/add-or-remove-restricted-website')).at(-1);
        assert.deepStrictEqual(change.body, {
            childDirectedId: 'amzn1.account.BBB',
            isAdding: true,
            website: 'https://bad.example/x',
        });
        assert.deepStrictEqual(adapter.states.get('children.Ben.access.blockWebsite'), { val: '', ack: true });
        await adapter.onStateChange(`${child}.disallowWebsite`, { val: 'https://ok.example/', ack: false });
        const allow = requests.filter(entry => entry.url.endsWith('/ajax/add-or-remove-allowlisted-website')).at(-1);
        assert.strictEqual(allow.body.isAdding, false);

        const count = requests.length;
        await adapter.onStateChange(`${child}.blockWebsite`, { val: 'two words', ack: false });
        assert.strictEqual(requests.length, count);

        const device = 'amazon-kids.0.devices.Ben_s_Fire';
        await adapter.onStateChange(`${device}.volume`, { val: 40, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/update-device-volume'));
        assert.deepStrictEqual(requests.at(-1).body, { deviceId: 'SER1', deviceTypeId: 'TYPE1', deviceVolume: 40 });
        await adapter.onStateChange(`${device}.videoEnabled`, { val: false, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/toggle-video-on-device'));
        assert.deepStrictEqual(requests.at(-1).body, { deviceId: 'SER1', deviceTypeId: 'TYPE1', enable: false });
        await adapter.onStateChange(`${device}.musicFilter`, { val: true, ack: false });
        assert.ok(requests.at(-1).url.endsWith('/ajax/toggle-elf-on-device'));
        assert.deepStrictEqual(requests.at(-1).body, {
            deviceId: 'SER1',
            deviceTypeId: 'TYPE1',
            enableFiltering: true,
        });
        const after = requests.length;
        await adapter.onStateChange(`${device}.volume`, { val: 5, ack: false });
        assert.strictEqual(requests.length, after);
    });
});
