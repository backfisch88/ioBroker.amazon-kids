'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
    ParentDashboard,
    AuthError,
    normalizeBaseUrl,
    parseCookies,
    parseHousehold,
    getWeekday,
    getDayLimit,
    sanitizeId,
} = require('../lib/parentDashboard');

const BASE = 'https://eltern.amazon.de';

function householdPage(household) {
    const literal = JSON.stringify(JSON.stringify(household)).slice(1, -1).replace(/'/g, "\\'");
    return `<html><script>window.__PREFETCHED_HOUSEHOLD = JSON.parse('${literal}');</script></html>`;
}

function fakeResponse(status, { text = '', json, headers = {}, cookies = [] } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => headers[name.toLowerCase()] ?? null, getSetCookie: () => cookies },
        text: async () => text,
        json: async () => {
            if (json === undefined) {
                throw new Error('no json');
            }
            return json;
        },
    };
}

function createClient(handler) {
    const calls = [];
    const client = new ParentDashboard({
        baseUrl: BASE,
        cookies: 'session-id=1; ft-panda-csrf-token=TOK',
        timeZone: 'Europe/Berlin',
        fetchImpl: async (url, init) => {
            calls.push({ url: String(url), init });
            return handler(String(url), init, calls.length);
        },
    });
    return { client, calls };
}

describe('normalizeBaseUrl', () => {
    it('accepts Amazon dashboard hosts', () => {
        assert.strictEqual(normalizeBaseUrl('https://eltern.amazon.de/'), BASE);
        assert.strictEqual(normalizeBaseUrl('parents.amazon.co.uk'), 'https://parents.amazon.co.uk');
        assert.strictEqual(normalizeBaseUrl(' https://parents.amazon.com/settings '), 'https://parents.amazon.com');
    });
    it('rejects everything else', () => {
        for (const bad of ['', null, 'http://eltern.amazon.de', 'https://evil.example', 'https://amazon.de.evil.com']) {
            assert.strictEqual(normalizeBaseUrl(bad), null, String(bad));
        }
        assert.strictEqual(normalizeBaseUrl('https://eltern.amazon.de:8443'), null);
    });
});

describe('parsers', () => {
    it('parses cookie headers and JSON', () => {
        assert.strictEqual(parseCookies('Cookie: a=1; b=x=y').get('b'), 'x=y');
        assert.strictEqual(parseCookies('{"a":"1"}').get('a'), '1');
        assert.strictEqual(parseCookies(undefined).size, 0);
    });
    it('extracts children from the page', () => {
        const page = householdPage({
            members: [
                { role: 'CHILD', firstName: "Mia O'Neil", directedId: 'amzn1.account.AAA' },
                { role: 'ADULT', firstName: 'Parent', directedId: 'amzn1.account.PPP' },
            ],
        });
        assert.deepStrictEqual(parseHousehold(page), [{ name: "Mia O'Neil", directedId: 'amzn1.account.AAA' }]);
        assert.throws(() => parseHousehold('<html></html>'), /household/);
    });
    it('reads the limit of a weekday', () => {
        const data = {
            periodConfigurations: [
                {
                    type: 'DayOfWeek',
                    name: 'Monday',
                    enabled: true,
                    timeLimits: { contentTimeLimitsEnabled: true, contentTimeLimits: { ALL: 90 } },
                },
                { type: 'DayOfWeek', name: 'Tuesday', enabled: false, timeLimits: {} },
            ],
        };
        assert.deepStrictEqual(getDayLimit(data, 'Monday'), { enabled: true, minutes: 90 });
        assert.deepStrictEqual(getDayLimit(data, 'Tuesday'), { enabled: false, minutes: null });
        assert.throws(() => getDayLimit(data, 'Sunday'), /Sunday/);
        assert.throws(() => getDayLimit(null, 'Monday'));
    });
    it('resolves the weekday in a time zone', () => {
        const date = new Date('2026-11-15T23:30:00Z');
        assert.strictEqual(getWeekday('UTC', date), 'Sunday');
        assert.strictEqual(getWeekday('Europe/Berlin', date), 'Monday');
    });
    it('sanitizes object IDs', () => {
        assert.strictEqual(sanitizeId(' Mia-Sophie Müller. '), 'Mia-Sophie_M_ller');
        assert.strictEqual(sanitizeId('...'), '');
    });
});

describe('ParentDashboard', () => {
    it('sends cookies, CSRF header and the documented bodies', async () => {
        const { client, calls } = createClient(() => fakeResponse(200, { json: {} }));
        await client.pauseDevices('amzn1.account.AAA', 60);
        await client.resumeDevices('amzn1.account.AAA');
        await client.setBonusTime('amzn1.account.AAA', 15);
        assert.strictEqual(calls[0].url, `${BASE}/ajax/set-offscreen-time`);
        assert.strictEqual(calls[0].init.method, 'POST');
        assert.strictEqual(calls[0].init.headers['x-amzn-csrf'], 'TOK');
        assert.match(calls[0].init.headers.cookie, /session-id=1/);
        assert.strictEqual(calls[0].init.redirect, 'manual');
        assert.ok(calls[0].init.signal);
        assert.deepStrictEqual(JSON.parse(calls[0].init.body), {
            directedIds: ['amzn1.account.AAA'],
            expirationTimeInSeconds: 3600,
        });
        assert.strictEqual(JSON.parse(calls[1].init.body).expirationTimeInSeconds, -1);
        const bonus = JSON.parse(calls[2].init.body);
        assert.strictEqual(calls[2].init.method, 'PUT');
        assert.strictEqual(bonus.bonusTimeDurationInMinutes, 15);
        assert.strictEqual(bonus.currentTimeZone, 'Europe/Berlin');
        assert.strictEqual(bonus.bonusTimeConfigurationType, 'Duration');
    });
    it('reads time limits with the child ID as query', async () => {
        const { client, calls } = createClient(() => fakeResponse(200, { json: { periodConfigurations: [] } }));
        assert.deepStrictEqual(await client.getTimeLimits('amzn1.account.AAA'), { periodConfigurations: [] });
        assert.strictEqual(calls[0].url, `${BASE}/ajax/get-adjusted-time-limits?childDirectedId=amzn1.account.AAA`);
    });
    it('treats a redirect to the sign-in as expired session', async () => {
        const { client } = createClient(() =>
            fakeResponse(302, { headers: { location: 'https://www.amazon.de/ap/signin?x=1' } }),
        );
        await assert.rejects(client.getChildren(), AuthError);
    });
    it('follows redirects inside the dashboard host only', async () => {
        const page = householdPage({ members: [{ role: 'CHILD', firstName: 'Mia', directedId: 'id1' }] });
        const { client, calls } = createClient((url, init, n) =>
            n === 1 ? fakeResponse(302, { headers: { location: '/dashboard' } }) : fakeResponse(200, { text: page }),
        );
        assert.deepStrictEqual(await client.getChildren(), [{ name: 'Mia', directedId: 'id1' }]);
        assert.strictEqual(calls[1].url, `${BASE}/dashboard`);
    });
    it('refreshes the CSRF token once after HTTP 403', async () => {
        const { client, calls } = createClient((url, init, n) => {
            if (n === 1) {
                return fakeResponse(403);
            }
            if (n === 2) {
                return fakeResponse(200, { cookies: ['ft-panda-csrf-token=NEW; Path=/; Secure'] });
            }
            return fakeResponse(200, { json: {} });
        });
        await client.pauseDevices('id1', 5);
        assert.strictEqual(calls.length, 3);
        assert.strictEqual(calls[2].init.headers['x-amzn-csrf'], 'NEW');
    });
    it('reports a rejected session without endless retries', async () => {
        const { client, calls } = createClient(() => fakeResponse(403));
        await assert.rejects(client.pauseDevices('id1', 5), AuthError);
        assert.strictEqual(calls.length, 2);
    });
    it('renews the session once when the dashboard keeps rejecting a command', async () => {
        let renewals = 0;
        let renewed = false;
        const { client, calls } = createClient(() => (renewed ? fakeResponse(200, { json: {} }) : fakeResponse(403)));
        client.renew = async () => {
            renewals++;
            renewed = true;
            return true;
        };
        await client.pauseDevices('id1', 5);
        assert.strictEqual(renewals, 1);
        assert.strictEqual(calls.length, 3);
    });
    it('reports a rejection when the renewed session is rejected as well', async () => {
        let renewals = 0;
        const { client } = createClient(() => fakeResponse(403));
        client.renew = async () => {
            renewals++;
            return true;
        };
        await assert.rejects(client.pauseDevices('id1', 5), AuthError);
        assert.strictEqual(renewals, 1);
    });
    it('never puts cookies into error messages', async () => {
        const { client } = createClient(() => fakeResponse(500));
        await assert.rejects(client.getTimeLimits('id1'), error => !/TOK|session-id/.test(error.message));
    });
});

describe('repository consistency', () => {
    const root = path.join(__dirname, '..');
    const io = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));
    it('keeps native config and admin fields aligned', () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'admin', 'jsonConfig.json'), 'utf8'));
        const fields = Object.keys(config.items).filter(key => !key.startsWith('_'));
        assert.deepStrictEqual(fields.sort(), Object.keys(io.native).sort());
        assert.deepStrictEqual(io.encryptedNative, ['cookies']);
        assert.deepStrictEqual(io.protectedNative, ['cookies']);
    });
    it('has identical translation keys in all languages', () => {
        const dir = path.join(root, 'admin', 'i18n');
        const languages = fs
            .readdirSync(dir)
            .map(file => file.replace(/\.json$/, ''))
            .sort();
        assert.deepStrictEqual(languages, ['de', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn']);
        const keys = lang => Object.keys(JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'))).sort();
        for (const lang of languages) {
            assert.deepStrictEqual(keys(lang), keys('en'), lang);
        }
    });
});

describe('login helpers', () => {
    const { getAmazonPage, isPortFree } = require('../lib/login');
    it('derives the marketplace from the dashboard address', () => {
        assert.strictEqual(getAmazonPage('https://eltern.amazon.de'), 'amazon.de');
        assert.strictEqual(getAmazonPage('https://parents.amazon.co.uk'), 'amazon.co.uk');
    });
    it('detects an occupied port', async () => {
        const server = require('node:net').createServer();
        await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
        assert.strictEqual(await isPortFree(server.address().port), false);
        await new Promise(resolve => server.close(resolve));
    });
});

describe('login proxy patch', () => {
    const http = require('node:http');
    const { patchLoginProxy, stripUpgradeDirective } = require('../lib/login');

    it('removes only the HTTPS upgrade from a policy', () => {
        assert.strictEqual(stripUpgradeDirective('upgrade-insecure-requests'), undefined);
        assert.strictEqual(
            stripUpgradeDirective("default-src 'self'; Upgrade-Insecure-Requests; img-src *"),
            "default-src 'self'; img-src *",
        );
        assert.deepStrictEqual(stripUpgradeDirective(['upgrade-insecure-requests', 'frame-ancestors none']), [
            'frame-ancestors none',
        ]);
    });

    it('cleans the headers of responses passing the real proxy middleware', async () => {
        patchLoginProxy();
        patchLoginProxy();
        const cookieDir = path.dirname(require.resolve('alexa-cookie2'));
        const middleware = require(require.resolve('http-proxy-middleware', { paths: [cookieDir] }));
        const upstream = http.createServer((req, res) => {
            res.setHeader('Content-Security-Policy', "upgrade-insecure-requests; frame-ancestors 'self'");
            res.setHeader('Strict-Transport-Security', 'max-age=1000');
            res.end('ok');
        });
        await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
        let innerCalled = 0;
        const proxy = middleware.createProxyMiddleware('/', {
            target: `http://127.0.0.1:${upstream.address().port}`,
            logLevel: 'silent',
            onProxyRes: () => innerCalled++,
        });
        const server = http.createServer((req, res) => proxy(req, res, () => res.end()));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
        await response.text();
        assert.strictEqual(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
        assert.strictEqual(response.headers.get('strict-transport-security'), null);
        assert.strictEqual(innerCalled, 1);
        server.closeAllConnections();
        upstream.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await new Promise(resolve => upstream.close(resolve));
    });
});

describe('schedule', () => {
    const { getLocalTime, describeDay, findDay } = require('../lib/schedule');
    const day = {
        enabled: true,
        goalsConfig: {
            learnFirstEnabled: true,
            contentGoals: { category_VIDEO: 0, category_APP: 30, category_AUDIBLE: 0 },
        },
        curfewConfigList: [
            { start: '06:00', end: '07:30', type: null, enabled: true },
            { start: '10:00', end: '17:00', type: null, enabled: true },
        ],
    };
    it('formats the local time of a zone', () => {
        assert.strictEqual(getLocalTime('Europe/Berlin', new Date('2026-11-15T23:05:00Z')), '00:05');
        assert.strictEqual(getLocalTime('UTC', new Date('2026-11-15T09:07:00Z')), '09:07');
    });
    it('evaluates the time windows', () => {
        assert.strictEqual(describeDay(day, '05:59').allowedNow, false);
        assert.strictEqual(describeDay(day, '06:00').allowedNow, true);
        assert.strictEqual(describeDay(day, '07:30').allowedNow, false);
        assert.strictEqual(describeDay(day, '09:00').nextChange, '10:00');
        assert.strictEqual(describeDay(day, '12:00').nextChange, '17:00');
        assert.strictEqual(describeDay(day, '18:00').nextChange, '');
        assert.strictEqual(describeDay(day, '12:00').windowsText, '06:00-07:30, 10:00-17:00');
        assert.deepStrictEqual(describeDay(day, '12:00').goals, { video: 0, app: 30, audible: 0 });
    });
    it('handles days without windows and windows over midnight', () => {
        assert.strictEqual(describeDay({ enabled: true, curfewConfigList: [] }, '03:00').allowedNow, true);
        assert.strictEqual(describeDay(null, '03:00').allowedNow, true);
        const night = { enabled: true, curfewConfigList: [{ start: '22:00', end: '06:00', enabled: true }] };
        assert.strictEqual(describeDay(night, '23:00').allowedNow, true);
        assert.strictEqual(describeDay(night, '12:00').allowedNow, false);
        const broken = { enabled: true, curfewConfigList: [{ start: 'x', end: '25:00', enabled: true }] };
        assert.strictEqual(describeDay(broken, '12:00').windowsText, '');
    });
    it('finds a weekday', () => {
        const data = { periodConfigurations: [{ type: 'DayOfWeek', name: 'Sunday', enabled: true }] };
        assert.strictEqual(findDay(data, 'Sunday').name, 'Sunday');
        assert.strictEqual(findDay(data, 'Monday'), null);
        assert.strictEqual(findDay(null, 'Monday'), null);
    });
});

describe('schedule changes', () => {
    const { parseWindows, changeDay, sameSchedule, isSchedule, getLocalDate } = require('../lib/schedule');
    const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const config = () => ({
        periodConfigurations: names.map(name => ({
            type: 'DayOfWeek',
            name,
            enabled: true,
            timeLimits: { contentTimeLimitsEnabled: true, contentTimeLimits: { ALL: 120 } },
            curfewConfigList: [{ start: '06:00', end: '17:00', type: null, enabled: true }],
            time: 1,
            dreamSleepEnabledDevices: null,
        })),
    });
    it('parses time windows', () => {
        assert.deepStrictEqual(parseWindows('10:00-17:00, 6:00 - 07:30'), [
            { start: '06:00', end: '07:30' },
            { start: '10:00', end: '17:00' },
        ]);
        for (const bad of ['', '   ', '10-17', '25:00-26:00', '10:00-10:00', 'abc', null, 5, '10:00-17:00,']) {
            assert.strictEqual(parseWindows(bad), null, String(bad));
        }
    });
    it('changes one weekday and leaves the input untouched', () => {
        const original = config();
        const changed = changeDay(original, 'Sunday', { windows: [{ start: '08:00', end: '19:00' }], minutes: 60 });
        assert.strictEqual(original.periodConfigurations[6].timeLimits.contentTimeLimits.ALL, 120);
        assert.strictEqual(changed.periodConfigurations[6].timeLimits.contentTimeLimits.ALL, 60);
        assert.strictEqual(changed.periodConfigurations[6].curfewConfigList[0].end, '19:00');
        assert.strictEqual(changed.periodConfigurations[6].dreamSleepEnabledDevices, null);
        assert.deepStrictEqual(changed.periodConfigurations[0], original.periodConfigurations[0]);
        assert.throws(() => changeDay(original, 'Someday', { minutes: 5 }));
    });
    it('compares rules without timestamps and order', () => {
        const a = config();
        const b = config();
        b.periodConfigurations.reverse();
        b.periodConfigurations[0].time = 999;
        assert.strictEqual(sameSchedule(a, b), true);
        assert.strictEqual(sameSchedule(a, changeDay(a, 'Monday', { minutes: 30 })), false);
    });
    it('validates templates', () => {
        assert.strictEqual(isSchedule(config()), true);
        assert.strictEqual(isSchedule({ periodConfigurations: [] }), false);
        assert.strictEqual(isSchedule(null), false);
        assert.strictEqual(isSchedule('x'), false);
    });
    it('formats the local date', () => {
        assert.strictEqual(getLocalDate('Europe/Berlin', new Date('2026-11-15T23:30:00Z')), '2026-11-16');
    });
});
