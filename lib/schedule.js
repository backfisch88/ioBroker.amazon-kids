'use strict';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Returns the wall clock time (HH:MM) in the given time zone.
 *
 * @param {string} [timeZone] IANA time zone, system zone if empty
 * @param {Date} [date] reference date
 * @returns {string} time as HH:MM
 */
function getLocalTime(timeZone, date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: timeZone || undefined,
    }).formatToParts(date);
    const pick = type => parts.find(part => part.type === type)?.value || '00';
    return `${pick('hour')}:${pick('minute')}`;
}

function toMinutes(time) {
    const match = TIME_PATTERN.exec(String(time));
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Evaluates the configuration of one weekday from the time limit response.
 *
 * The dashboard calls the time windows "curfew". They are the periods in
 * which the devices may be used; outside of them the devices are locked.
 *
 * @param {object | null | undefined} day entry of periodConfigurations
 * @param {string} now current local time as HH:MM
 * @returns {{windows: {start: string, end: string}[], windowsText: string, allowedNow: boolean, nextChange: string, learnFirst: boolean, goals: Record<string, number>}} evaluated day
 */
function describeDay(day, now) {
    const list = Array.isArray(day?.curfewConfigList) ? day.curfewConfigList : [];
    const windows = list
        .filter(entry => entry && entry.enabled && toMinutes(entry.start) !== null && toMinutes(entry.end) !== null)
        .map(entry => ({ start: entry.start, end: entry.end }))
        .sort((a, b) => toMinutes(a.start) - toMinutes(b.start));

    const current = toMinutes(now) ?? 0;
    const inside = window => {
        const start = toMinutes(window.start);
        const end = toMinutes(window.end);
        return start <= end ? current >= start && current < end : current >= start || current < end;
    };
    // Without any window there is no time-of-day restriction.
    const allowedNow = day?.enabled === false || !windows.length ? true : windows.some(inside);

    const boundaries = windows
        .flatMap(window => [window.start, window.end])
        .filter(time => toMinutes(time) > current)
        .sort((a, b) => toMinutes(a) - toMinutes(b));

    const goals = {};
    const source = day?.goalsConfig?.contentGoals;
    if (source && typeof source === 'object') {
        for (const [key, value] of Object.entries(source)) {
            const name = key
                .replace(/^category_/i, '')
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
            if (name && Number.isFinite(Number(value))) {
                goals[name] = Number(value);
            }
        }
    }

    return {
        windows,
        windowsText: windows.map(window => `${window.start}-${window.end}`).join(', '),
        allowedNow,
        nextChange: boundaries[0] || '',
        learnFirst: Boolean(day?.goalsConfig?.learnFirstEnabled),
        goals,
    };
}

/**
 * @param {object | null | undefined} data response of get-adjusted-time-limits
 * @param {string} weekday English weekday name
 * @returns {object | null} entry of that weekday
 */
function findDay(data, weekday) {
    const periods = Array.isArray(data?.periodConfigurations) ? data.periodConfigurations : [];
    return periods.find(period => period && period.type === 'DayOfWeek' && period.name === weekday) || null;
}

/**
 * @param {string} [timeZone] IANA time zone, system zone if empty
 * @param {Date} [date] reference date
 * @returns {string} local date as YYYY-MM-DD
 */
function getLocalDate(timeZone, date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        timeZone: timeZone || undefined,
    }).format(date);
}

/**
 * Parses time windows written as "06:00-07:30, 10:00-17:00".
 *
 * @param {unknown} text user input
 * @returns {{start: string, end: string}[] | null} windows or null if the text is invalid
 */
function parseWindows(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return null;
    }
    const windows = [];
    for (const part of text.split(/[,;]/)) {
        const match = /^\s*(\d{1,2}):(\d{2})\s*[-\u2013]\s*(\d{1,2}):(\d{2})\s*$/.exec(part);
        if (!match) {
            return null;
        }
        const start = `${match[1].padStart(2, '0')}:${match[2]}`;
        const end = `${match[3].padStart(2, '0')}:${match[4]}`;
        if (toMinutes(start) === null || toMinutes(end) === null || start === end) {
            return null;
        }
        windows.push({ start, end });
    }
    return windows.sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
}

/**
 * Returns a copy of the weekly rules with changed values for one weekday.
 *
 * @param {{periodConfigurations: object[]}} config stored weekly rules
 * @param {string} weekday English weekday name
 * @param {{windows?: {start: string, end: string}[], minutes?: number, learnFirst?: boolean, limitEnabled?: boolean, goals?: Record<string, number>}} change new values
 * @returns {{periodConfigurations: object[]}} changed copy
 */
function changeDay(config, weekday, change) {
    const copy = JSON.parse(JSON.stringify(config));
    const day = findDay(copy, weekday);
    if (!day) {
        throw new Error(`No ${weekday} entry in the time limit configuration`);
    }
    if (change.windows) {
        day.curfewConfigList = change.windows.map(window => ({
            start: window.start,
            end: window.end,
            type: null,
            enabled: true,
        }));
    }
    if (change.learnFirst !== undefined) {
        day.goalsConfig = day.goalsConfig || {};
        day.goalsConfig.learnFirstEnabled = change.learnFirst;
    }
    if (change.limitEnabled !== undefined) {
        day.timeLimits = day.timeLimits || {};
        day.timeLimits.contentTimeLimitsEnabled = change.limitEnabled;
    }
    if (change.goals) {
        const goals = day.goalsConfig?.contentGoals;
        for (const [key, minutes] of Object.entries(change.goals)) {
            if (!goals || !(key in goals)) {
                throw new Error(`The dashboard has no learning goal ${key} for this child`);
            }
            goals[key] = minutes;
        }
    }
    if (change.minutes !== undefined) {
        day.timeLimits = day.timeLimits || {};
        day.timeLimits.contentTimeLimitsEnabled = true;
        day.timeLimits.contentTimeLimits = { ...(day.timeLimits.contentTimeLimits || {}), ALL: change.minutes };
    }
    return copy;
}

function comparable(config) {
    const periods = Array.isArray(config?.periodConfigurations) ? config.periodConfigurations : [];
    return JSON.stringify(
        periods
            .map(period => ({
                type: period.type,
                name: period.name,
                enabled: period.enabled,
                timeLimits: period.timeLimits,
                goalsConfig: period.goalsConfig,
                windows: (period.curfewConfigList || [])
                    .map(entry => `${entry.start}-${entry.end}-${entry.enabled}`)
                    .sort(),
            }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    );
}

/**
 * Compares two weekly rule sets, ignoring timestamps and ordering.
 *
 * @param {object} a weekly rules
 * @param {object} b weekly rules
 * @returns {boolean} true if both describe the same rules
 */
function sameSchedule(a, b) {
    return comparable(a) === comparable(b);
}

/**
 * Checks that a value looks like a complete set of weekly rules.
 *
 * @param {unknown} config parsed template
 * @returns {boolean} true if it can be sent to the dashboard
 */
function isSchedule(config) {
    const periods = config && typeof config === 'object' ? config.periodConfigurations : null;
    return (
        Array.isArray(periods) &&
        periods.length === 7 &&
        periods.every(period => period && period.type === 'DayOfWeek' && typeof period.name === 'string')
    );
}

module.exports = {
    getLocalTime,
    getLocalDate,
    describeDay,
    findDay,
    parseWindows,
    changeDay,
    sameSchedule,
    isSchedule,
};
