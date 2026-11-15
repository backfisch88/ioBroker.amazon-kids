'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PATCHED = Symbol.for('iobroker.amazon-kids.cspPatch');

/**
 * Removes the directive that makes browsers switch to HTTPS from a CSP header value.
 *
 * @param {string | string[] | undefined} value header value
 * @returns {string | string[] | undefined} cleaned header value, undefined if nothing is left
 */
function stripUpgradeDirective(value) {
    if (Array.isArray(value)) {
        const list = value.map(stripUpgradeDirective).filter(Boolean);
        return list.length ? list : undefined;
    }
    if (typeof value !== 'string') {
        return value;
    }
    const cleaned = value
        .split(';')
        .map(part => part.trim())
        .filter(part => part && !/^(upgrade-insecure-requests|block-all-mixed-content)$/i.test(part))
        .join('; ');
    return cleaned || undefined;
}

/**
 * Amazon sends "Content-Security-Policy: upgrade-insecure-requests" with the
 * sign-in page. The login proxy of alexa-cookie2 only speaks HTTP and passes
 * that header on, so the browser submits the sign-in form to https://<proxy>
 * and fails. This wraps the response hook of the proxy middleware and removes
 * the directive. It has to run before alexa-cookie2 is loaded for the first time.
 *
 * @param {NodeJS.Require} [requireFn] require function (for tests)
 */
function patchLoginProxy(requireFn = require) {
    const cookieDir = path.dirname(requireFn.resolve('alexa-cookie2'));
    const middleware = requireFn(requireFn.resolve('http-proxy-middleware', { paths: [cookieDir] }));
    if (middleware[PATCHED]) {
        return;
    }
    const original = middleware.createProxyMiddleware;
    middleware.createProxyMiddleware = (context, options) => {
        const config = options && typeof options === 'object' ? options : context;
        if (config && typeof config === 'object') {
            const inner = config.onProxyRes;
            config.onProxyRes = (proxyRes, req, res) => {
                for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
                    const cleaned = stripUpgradeDirective(proxyRes.headers[name]);
                    if (cleaned === undefined) {
                        delete proxyRes.headers[name];
                    } else {
                        proxyRes.headers[name] = cleaned;
                    }
                }
                delete proxyRes.headers['strict-transport-security'];
                if (typeof inner === 'function') {
                    return inner(proxyRes, req, res);
                }
            };
        }
        return original(context, options);
    };
    middleware[PATCHED] = true;
}

/**
 * Finds the first IPv4 address of this host that other devices can reach.
 *
 * @returns {string} address or an empty string
 */
function detectOwnIp() {
    for (const list of Object.values(os.networkInterfaces())) {
        for (const entry of list || []) {
            if (entry.family === 'IPv4' && !entry.internal) {
                return entry.address;
            }
        }
    }
    return '';
}

/**
 * Derives the Amazon marketplace domain from the dashboard origin.
 *
 * @param {string} baseUrl dashboard origin, e.g. https://eltern.amazon.de
 * @returns {string} marketplace domain, e.g. amazon.de
 */
function getAmazonPage(baseUrl) {
    const host = new URL(baseUrl).hostname;
    return host.slice(host.indexOf('amazon.'));
}

/**
 * Checks whether a TCP port can be opened. The login proxy has no error
 * handling for an occupied port, so this has to be tested beforehand.
 *
 * @param {number} port TCP port
 * @returns {Promise<boolean>} true if the port is free
 */
function isPortFree(port) {
    return new Promise(resolve => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    });
}

/**
 * Wraps alexa-cookie2: browser login through a local proxy and renewal of
 * the session cookies with the refresh token of that login.
 */
class AmazonLogin {
    /**
     * @param {object} [library] alexa-cookie2 compatible implementation (for tests)
     */
    constructor(library) {
        if (!library) {
            patchLoginProxy();
        }
        this.library = library || require('alexa-cookie2');
        this.running = false;
    }

    /**
     * Starts the login proxy.
     *
     * @param {object} options alexa-cookie2 options
     * @param {object | null} former data of an earlier login, reuses the registered device
     * @param {{onUrl: (url: string) => void, onSuccess: (data: object) => void, onError: (error: Error) => void}} handlers callbacks
     */
    start(options, former, handlers) {
        this.running = true;
        const config = { ...options, setupProxy: true, proxyOnly: true };
        if (former) {
            config.formerRegistrationData = former;
        }
        this.library.generateAlexaCookie(config, (error, result) => {
            if (!this.running) {
                return;
            }
            if (result && result.localCookie) {
                handlers.onSuccess(result);
                return;
            }
            const message = error instanceof Error ? error.message : 'Unknown login error';
            const match = /Please open (http:\/\/[^\s/]+)/.exec(message);
            if (match) {
                handlers.onUrl(match[1]);
            } else {
                handlers.onError(new Error(message));
            }
        });
    }

    /**
     * Renews the session cookies without user interaction.
     *
     * @param {object} options alexa-cookie2 options
     * @param {object} former data of the last login or refresh
     * @returns {Promise<object>} updated login data
     */
    refresh(options, former) {
        return new Promise((resolve, reject) => {
            this.library.refreshAlexaCookie({ ...options, formerRegistrationData: former }, (error, result) => {
                if (error || !result || !result.localCookie) {
                    reject(error instanceof Error ? error : new Error('Session refresh returned no cookies'));
                } else {
                    resolve(result);
                }
            });
        });
    }

    stop() {
        if (this.running) {
            this.running = false;
            this.library.stopProxyServer();
        }
    }
}

module.exports = { AmazonLogin, detectOwnIp, getAmazonPage, isPortFree, patchLoginProxy, stripUpgradeDirective };
