'use strict';

/**
 * Sums up what a child used on one local day.
 *
 * @param {object | null | undefined} data response of get-weekly-activities-v2 (times in seconds)
 * @param {(unixSeconds: number) => string} toLocalDate converts a timestamp to the local date (YYYY-MM-DD)
 * @param {string} date local date to evaluate
 * @returns {{usedSeconds: number, items: {title: string, category: string, minutes: number}[]}} usage of that day
 */
function summarizeUsage(data, toLocalDate, date) {
    const categories = Array.isArray(data?.activityV2Data) ? data.activityV2Data : [];
    let usedSeconds = 0;
    const items = [];
    for (const category of categories) {
        for (const interval of Array.isArray(category?.intervals) ? category.intervals : []) {
            const start = Number(interval?.startTime);
            if (!Number.isFinite(start) || toLocalDate(start + 1) !== date) {
                continue;
            }
            const duration = Number(interval.aggregatedDuration);
            usedSeconds += Number.isFinite(duration) && duration > 0 ? duration : 0;
            for (const entry of Array.isArray(interval.aggregatedActivityResults)
                ? interval.aggregatedActivityResults
                : []) {
                const seconds = Number(entry?.activityDuration);
                if (!Number.isFinite(seconds) || seconds < 30) {
                    continue;
                }
                items.push({
                    title: String(entry.attributes?.TITLE || entry.key || 'unknown').slice(0, 80),
                    category: String(category.category || entry.attributes?.CATEGORY || ''),
                    minutes: Math.round(seconds / 60),
                });
            }
        }
    }
    items.sort((a, b) => b.minutes - a.minutes);
    return { usedSeconds, items };
}

module.exports = { summarizeUsage };
