// Minimal dependency-free static file server + Chrome DevTools Protocol
// client used by the verification scripts.  Node 24 ships a global fetch and
// WebSocket, so no packages are required.
//
// The server serves the repository root over http://127.0.0.1:<port>/ and
// supports a few test-only control endpoints (see startServer()).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webm': 'video/webm',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
};

// In-memory throttle table:  pathname -> { delayMs, gate }
//   delayMs: artificial latency applied before the body is sent
//   gate:    a promise that must resolve before the response is sent; lets a
//            test hold a response open and release it on demand.
function makeServerOptions() {
    return {
        routes: {},          // config.json overrides, pathname -> object
        throttle: {},        // pathname -> { delayMs, gate }
        requests: [],        // { path, method, at, released, aborted }
    };
}

export async function startServer(options = {}) {
    const state = makeServerOptions();
    Object.assign(state, options);
    state.requests = [];

    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);

        if (urlPath === '/__control/reset' && req.method === 'POST') {
            state.requests = [];
            res.writeHead(200).end('ok');
            return;
        }
        if (urlPath === '/__control/requests') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(state.requests));
            return;
        }
        if (urlPath === '/__control/request-count') {
            const name = new URL(req.url, 'http://x').searchParams.get('path');
            const count = state.requests.filter(r => r.path === name).length;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ count }));
            return;
        }
        if (urlPath === '/__control/release' && req.method === 'POST') {
            const q = new URL(req.url, 'http://x').searchParams.get('path');
            const info = state.throttle[q];
            if (info && info.release) {
                info.release();
                res.writeHead(200).end('ok');
            } else {
                res.writeHead(404).end('no gate');
            }
            return;
        }
        if (urlPath === '/__control/throttle' && req.method === 'POST') {
            // { path, delayMs?, gate? } -- gate:true installs a fresh hold
            let body = '';
            req.on('data', d => { body += d; });
            req.on('end', () => {
                let spec = {};
                try { spec = JSON.parse(body || '{}'); } catch { /* ignore */ }
                const target = spec.path;
                if (!target) { res.writeHead(400).end('path required'); return; }
                if (spec.delayMs !== undefined) {
                    state.throttle[target] = Object.assign({}, state.throttle[target], { delayMs: spec.delayMs });
                }
                if (spec.gate) {
                    let release;
                    const gate = new Promise(r => { release = r; });
                    state.throttle[target] = Object.assign({}, state.throttle[target], { gate, release, released: false });
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
            });
            return;
        }

        if (state.routes[urlPath] !== undefined) {
            const body = JSON.stringify(state.routes[urlPath]);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(body);
            return;
        }

        let filePath = urlPath === '/' ? '/index.html' : urlPath;
        if (!filePath.startsWith('/')) filePath = '/' + filePath;
        const abs = path.join(REPO_ROOT, path.normalize(filePath));
        let ok = false;
        let isDir = false;
        try {
            ok = abs.startsWith(REPO_ROOT) && fs.statSync(abs).isFile();
            isDir = ok === false && fs.existsSync(abs) && fs.statSync(abs).isDirectory();
        } catch { ok = false; }
        if (!ok || isDir) {
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found: ' + urlPath);
            return;
        }

        const record = { path: urlPath, method: req.method, at: Date.now(), released: false, closed: false };
        state.requests.push(record);
        req.on('close', () => { record.closed = true; });
        const info = state.throttle[urlPath];
        const sendFile = () => {
            if (record.closed) {
                //client aborted before the response body was written
                record.abortedByClient = true;
                return;
            }
            const data = fs.readFileSync(abs);
            const ext = path.extname(abs).toLowerCase();
            res.writeHead(200, {
                'content-type': MIME[ext] || 'application/octet-stream',
                'content-length': data.length,
                'cache-control': 'no-store',
                'accept-ranges': 'none',
            });
            res.end(data);
            record.released = true;
        };

        if (info && (info.gate || info.delayMs)) {
            const when = info.gate || Promise.resolve();
            when.then(() => setTimeout(sendFile, info.delayMs || 0));
        } else {
            sendFile();
        }
    });

    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    return {
        state,
        port,
        origin: `http://127.0.0.1:${port}`,
        url: `http://127.0.0.1:${port}/index.html`,
        close: () => new Promise(resolve => server.close(resolve)),
        setRoute: (p, value) => { state.routes[p] = value; },
        throttle: (p, opts) => { state.throttle[p] = opts || {}; },
        clearThrottle: () => { state.throttle = {}; },
        release: p => {
            const info = state.throttle[p];
            if (info && info.release) info.release();
        },
    };
}

export function findChrome() {
    const candidates = [
        process.env.CHROME_PATH,
        'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe',
        'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-win64/chrome-headless-shell.exe',
        'C:/Users/Administrator/AppData/Local/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-win64/chrome-headless-shell.exe',
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
    ].filter(Boolean);
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return c;
        } catch { /* ignore */ }
    }
    throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH to a Chrome build.');
}

export async function launchBrowser({ headless = true } = {}) {
    const exe = findChrome();
    const userDataDir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'scritch-cdp-'));
    const args = [
        headless ? '--headless=new' : '--new-window',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--remote-debugging-port=0',
        '--user-data-dir=' + userDataDir,
        'about:blank',
    ];
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error('Timed out waiting for Chrome DevTools endpoint.\n' + buf)), 20000);
        proc.stderr.on('data', d => {
            buf += d.toString();
            const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
            if (m) { clearTimeout(timer); resolve(m[1]); }
        });
        proc.on('exit', code => { clearTimeout(timer); reject(new Error('Chrome exited early (' + code + ')\n' + buf)); });
    });

    const browserPort = new URL(wsUrl).port;
    const browser = {
        async newPage() {
            const res = await fetch(`http://127.0.0.1:${browserPort}/json/new?about:blank`, { method: 'PUT' });
            const target = await res.json();
            const page = new CDPPage(target.webSocketDebuggerUrl);
            await page.connect();
            return page;
        },
        async close() {
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
        },
    };
    return browser;
}

class CDPPage {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.nextId = 0;
        this.pending = new Map();
        this.listeners = new Map();
        this.events = [];
    }

    async connect() {
        this.ws = new WebSocket(this.wsUrl);
        this.ws.addEventListener('message', ev => this._onMessage(ev));
        await new Promise((resolve, reject) => {
            this.ws.addEventListener('open', resolve, { once: true });
            this.ws.addEventListener('error', reject, { once: true });
        });
        await this.send('Page.enable');
        await this.send('Runtime.enable');
        await this.send('Network.enable');
        await this.send('Log.enable');
    }

    // Inject a script that runs before any page script on every navigation.
    async addInitScript(source) {
        const res = await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
        return res.identifier;
    }

    _onMessage(ev) {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message + ' ' + JSON.stringify(msg.error.data || '')));
            else resolve(msg.result);
            return;
        }
        if (msg.method) {
            this.events.push(msg);
            const subs = this.listeners.get(msg.method) || [];
            subs.forEach(fn => { try { fn(msg.params); } catch { /* ignore */ } });
        }
    }

    on(method, fn) {
        if (!this.listeners.has(method)) this.listeners.set(method, []);
        this.listeners.get(method).push(fn);
    }

    once(method, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for ' + method)), timeout);
            const fn = params => {
                clearTimeout(timer);
                const subs = this.listeners.get(method) || [];
                const i = subs.indexOf(fn);
                if (i >= 0) subs.splice(i, 1);
                resolve(params);
            };
            this.on(method, fn);
        });
    }

    send(method, params = {}) {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async navigate(url) {
        await this.send('Page.navigate', { url });
        await this.once('Page.loadEventFired', 20000);
    }

    async evaluate(fnOrString, ...args) {
        let expression;
        if (typeof fnOrString === 'function') {
            const argList = args.map(a => JSON.stringify(a)).join(',');
            expression = `(${fnOrString})(${argList})`;
        } else {
            expression = fnOrString;
        }
        const res = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
        });
        if (res.exceptionDetails) {
            throw new Error('evaluate failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
        }
        return res.result.value;
    }

    async waitFor(fnOrString, { timeout = 10000, interval = 50, label = 'condition' } = {}) {
        const start = Date.now();
        let lastErr;
        while (Date.now() - start < timeout) {
            try {
                if (await this.evaluate(fnOrString)) return true;
            } catch (e) { lastErr = e; }
            await sleep(interval);
        }
        throw new Error(`Timed out waiting for ${label}` + (lastErr ? ` (last error: ${lastErr.message})` : ''));
    }

    async close() {
        try { this.ws.close(); } catch { /* ignore */ }
        try {
            const port = new URL(this.wsUrl).port;
            const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
            const me = list.find(t => t.webSocketDebuggerUrl === this.wsUrl);
            if (me) await fetch(`http://127.0.0.1:${port}/json/close/${me.id}`);
        } catch { /* ignore */ }
    }
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
