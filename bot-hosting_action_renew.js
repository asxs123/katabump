#!/usr/bin/env node
'use strict';
/**
 * bot_hosting_renew.js — bot-hosting.net 免费服务器自动续期（多账号版）
 *
 * 技术栈与 action_renew.js (katabump) 完全一致：
 *   - playwright-extra + puppeteer-extra-plugin-stealth (反检测)
 *   - 自行 spawn Chrome（--remote-debugging-port），再 chromium.connectOverCDP 接管
 *   - addInitScript 注入脚本 hook attachShadow，捕获 Turnstile 复选框位置
 *   - CDP Input.dispatchMouseEvent 原生鼠标事件点击 Turnstile（可 headless 工作）
 *
 * 登录方式（按优先级）：
 *   1. Email + 密码登录（BOT_USERS_JSON 多账号，同 katabump；走 bot-hosting /api/auth/email，
 *      页面表单 + CDP 点 Turnstile，等价于官方 UI 登录流程）
 *   2. 每个账号可选 session_token 字段：Cookie 注入快速通道（免验证码，失败自动回退密码登录）
 *   3. 旧版单账号模式（未配置 BOT_USERS_JSON 时）：SESSION_TOKEN 环境变量 → Discord Token OAuth 备用，
 *      并支持 gh secret set 写回 SESSION_TOKEN
 *
 * 代理（与 katabump 相同）：
 *   无认证: HTTP_PROXY=http://ip:port
 *   带认证: HTTP_PROXY=http://username:password@ip:port
 *
 * 通知：Telegram（+ 可选 SMTP），附截图；GitHub Actions ::add-mask:: 掩码
 *
 * 依赖: npm i playwright-extra puppeteer-extra-plugin-stealth axios
 * 可选: npm i nodemailer form-data
 * 运行: node bot_hosting_renew.js
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const http = require('http');

chromium.use(stealth);

/* ============================== 配置 ============================== */

// --- 通知 ---
const EMAIL = process.env.EMAIL || '';                              // 展示用；为空回退 SMTP_CONFIG.to
const TG_BOT_TOKEN = process.env['TG_BOT_TOKEN'] || process.env['TELEGRAM_BOT_TOKEN'] || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || process.env.TELEGRAM_CHAT_ID || '';

// --- 多账号（katabump 同款）: [{"username":"email","password":"xxx"}, ...] ---
// 也支持 {"users":[...]}，以及可选每账号 "session_token" 字段（Cookie 快速通道）

// --- 旧版单账号（未配置 BOT_USERS_JSON 时生效）---
const SESSION_TOKEN = (process.env['SESSION_TOKEN'] || '').trim();
const DISCORD_TOKEN = process.env['DISCORD_TOKEN'] || '';
const GH_TOKEN = process.env['GH_TOKEN'] || '';

// --- 代理（katabump 同款）: http://ip:port 或 http://user:pass@ip:port ---
const RAW_PROXY = (process.env.HTTP_PROXY || process.env.http_proxy || '').trim()
    || (((process.env.IS_PROXY || 'false').toLowerCase() === 'true')
        ? (process.env.PROXY_SERVER || '').trim() || 'http://127.0.0.1:1080'
        : '');

let PROXY_CONFIG = null;
if (RAW_PROXY) {
    try {
        const proxyUrl = new URL(RAW_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined,
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- 浏览器 ---
const HEADLESS = (process.env.HEADLESS || 'false').toLowerCase() === 'true';
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

process.env.NO_PROXY = 'localhost,127.0.0.1';

// 解析 DISCORD_TOKEN（兼容 "前缀,真实token" 写法）
let DC_TOKEN = '';
if (DISCORD_TOKEN) {
    const parts = DISCORD_TOKEN.split(',');
    DC_TOKEN = parts.at(-1).trim();
}

// 运行期状态（用于旧版单账号通知文案）
let _LOGIN_METHOD = 'SESSION_TOKEN';
let _SESSION_PERSIST_MSG = '尚未检查 SESSION_TOKEN 写回';
let _DISCORD_DETAIL = '';
let _LAST_FAIL_URL = '';
let _KNOWN_SESSION_TOKEN = (process.env['SESSION_TOKEN'] || '').trim();

function rememberVal(v) {
    _KNOWN_SESSION_TOKEN = v;
}
const NOTIFY_TITLE = 'Bot-hosting 续期通知';
const PHOTO_DIR = path.join(process.cwd(), 'screenshots');

/* ============================== 基础工具 ============================== */

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function maskSecret(v) {
    if (!v) return '***';
    return v.length > 8 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '***';
}

// GitHub Actions 原生日志掩码
function addMask(v) {
    if (v && v.length > 2 && process.env.GITHUB_ACTIONS) {
        console.log(`::add-mask::${v}`);
    }
}

function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function refreshBeforeHours() {
    const raw = parseInt(process.env.SESSION_REFRESH_BEFORE_HOURS || '48', 10);
    return Number.isFinite(raw) ? raw : 48;
}

function safeName(s) {
    return String(s || 'user').replace(/[^a-z0-9]/gi, '_');
}

/* ============================== 通知（TG + 可选 SMTP） ============================== */

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;

    // 1. 文字（HTML 模式，避免邮箱 _ * 等字符破坏 Markdown）
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        }, { timeout: 15000 });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
        return false;
    }

    // 2. 图片（如有）
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        try {
            const FormData = (() => { try { return require('form-data'); } catch (e) { return null; } })();
            const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`;
            if (FormData) {
                const form = new FormData();
                form.append('chat_id', TG_CHAT_ID);
                form.append('photo', fs.createReadStream(imagePath));
                await axios.post(url, form, { headers: form.getHeaders(), timeout: 60000 });
            } else {
                await new Promise(resolve => {
                    execFile('curl', ['-s', '-X', 'POST', url,
                        '-F', `chat_id=${TG_CHAT_ID}`, '-F', `photo=@${imagePath}`],
                        (err) => {
                            if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                            else console.log('[Telegram] Photo sent.');
                            resolve();
                        });
                });
            }
        } catch (e) {
            console.error('[Telegram] Failed to send photo:', e.message);
        }
    }
    return true;
}

async function sendEmailNotification(message) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch (e) { return false; }
    const raw = process.env.SMTP_CONFIG;
    if (!raw) return false;
    try {
        const cfg = JSON.parse(raw);
        if (!cfg || !cfg.host || !cfg.to) return false;
        const transporter = nodemailer.createTransport({
            host: cfg.host,
            port: Number(cfg.port || 465),
            secure: cfg.secure !== false,
            auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
        });
        await transporter.sendMail({ from: cfg.from || cfg.user, to: cfg.to, subject: NOTIFY_TITLE, text: message });
        console.log('[SMTP] Mail sent.');
        return true;
    } catch (e) {
        console.error('[SMTP] Failed:', e.message);
        return false;
    }
}

function accountLabel(account) {
    let raw = ((account && account.username) || EMAIL || '').trim();
    if (!raw.includes('@')) {
        try {
            const cfg = process.env.SMTP_CONFIG ? JSON.parse(process.env.SMTP_CONFIG) : null;
            if (cfg && cfg.to) raw = String(cfg.to).split(',')[0].trim();
        } catch (e) { /* ignore */ }
    }
    if (raw.includes('@')) {
        const [name, domain] = raw.split('@', 2);
        if (name.length > 4) return `${name.slice(0, 2)}****${name.slice(-2)}@${domain}`;
        return `${name}@${domain}`;
    }
    if (raw) return `${raw.slice(0, 2)}****`;
    return '（未配置账号）';
}

// 通知格式（业务文案，与推送通道无关）
function formatNotification(status, {
    account = null,
    loginMethod = null,
    persistMsg = null,
    extra = '',
    error = '',
    expiryDate = '',
} = {}) {
    const nowTs = new Date(Date.now() + 8 * 3600 * 1000);
    const now = nowTs.toISOString().replace('T', ' ').slice(0, 19);

    const lines = [
        '🇫🇮 Bot-hosting 续期通知',
        '',
        status,
        `👤 登录账户: ${accountLabel(account)}`,
    ];
    const method = loginMethod || (account && account.loginMethod) || _LOGIN_METHOD;
    if (method) lines.push(`🔐 登录方式: ${method}`);
    const persist = persistMsg !== null ? persistMsg : (account ? null : _SESSION_PERSIST_MSG);
    if (persist) lines.push(`🔑 ${persist}`);
    if (expiryDate) lines.push(`📅 到期时间: ${expiryDate}`);
    if (extra) lines.push(extra);
    if (error) lines.push(`⚠️ 错误信息: ${error}`);
    lines.push(`⏱️ 登录时间: ${now}`);
    return lines.join('\n');
}

async function notify(message) {
    const html = escapeHtml(message);
    let ok = false;
    try {
        ok = await sendTelegramMessage(html);
    } catch (e) {
        console.log(`通知调用异常: ${e.message}`);
    }
    try {
        await sendEmailNotification(message);
    } catch (e) {
        console.log(`邮件通知异常: ${e.message}`);
    }
    return ok;
}

function loginFailureMessage() {
    const detail = (_DISCORD_DETAIL || '').trim();
    const failUrl = _LAST_FAIL_URL || '';
    if (detail.includes('401') || detail.includes('Discord Token 已失效')) return detail;
    if (detail.toLowerCase().includes('disconnect') || failUrl.includes('error=disconnect')) {
        return 'SESSION_TOKEN 已失效；Discord 已拿到授权码，但 bot-hosting 返回 error=disconnect。不要急着换 Discord Token；请看 Actions 是否已清除旧 Cookie。';
    }
    if (detail.toLowerCase().includes('fraud')) return detail;
    if (!SESSION_TOKEN && DC_TOKEN) return detail || 'Discord OAuth 登录失败';
    if (SESSION_TOKEN && DC_TOKEN) return detail || 'SESSION_TOKEN 和 Discord OAuth 均失败';
    return detail || 'Cookie 已失效或页面异常';
}

/* ============================== Turnstile (CDP 绕过) ============================== */

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);

        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;

        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);

            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// CDP 原生鼠标事件点击 Turnstile 复选框
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', JSON.stringify(data));

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                const clickX = box.x + (box.width * data.xRatio);
                const clickY = box.y + (box.height * data.yRatio);
                console.log(`>> 计算点击坐标: (${clickX.toFixed(2)}, ${clickY.toFixed(2)})`);

                const client = await page.context().newCDPSession(page);

                await client.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1,
                });
                await sleep(50 + Math.random() * 100);
                await client.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: clickX,
                    y: clickY,
                    button: 'left',
                    clickCount: 1,
                });

                console.log('>> CDP 点击已发送。');
                await client.detach().catch(() => { });
                return true;
            }
        } catch (e) { /* ignore */ }
    }
    return false;
}

// 页面源码中不再出现 CF 指示文本即认为通过
async function waitForTurnstilePass(page, timeoutMs = 30000) {
    const start = Date.now();
    const cfIndicators = ['verify you are human', '确认您是真人', 'troubleshoot', 'just a moment'];
    while (Date.now() - start < timeoutMs) {
        let pageLower = '';
        try { pageLower = (await page.content()).toLowerCase(); } catch (e) { }
        if (!cfIndicators.some(x => pageLower.includes(x))) {
            console.log('✅ Turnstile 验证已通过');
            return true;
        }
        await sleep(1000);
    }
    console.log('❌ Turnstile 验证超时未通过');
    return false;
}

/* ============================== 代理 / Chrome ============================== */

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, () => resolve(true));
        req.on('error', () => resolve(false));
        req.setTimeout(3000, () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// 验证代理可用性（与 action_renew.js 的 checkProxy 相同）
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000,
        };
        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
        }
        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

function axiosProxyConfig() {
    if (!PROXY_CONFIG) return {};
    const cfg = {
        proxy: {
            protocol: 'http',
            host: new URL(PROXY_CONFIG.server).hostname,
            port: Number(new URL(PROXY_CONFIG.server).port || 80),
        },
    };
    if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
        cfg.proxy.auth = { username: PROXY_CONFIG.username, password: PROXY_CONFIG.password };
    }
    return cfg;
}

async function launchChrome() {
    console.log(`检查 Chrome 是否已在端口 ${DEBUG_PORT} 上运行...`);
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH}, headless=${HEADLESS})...`);
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--user-data-dir=/tmp/chrome_user_data',   // 必须指定，否则远程调试可能失败
    ];
    if (HEADLESS) args.push('--headless=new');

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    const chrome = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await sleep(1000);
    }
    if (!await checkPort(DEBUG_PORT)) {
        throw new Error(`Chrome 无法在端口 ${DEBUG_PORT} 上启动`);
    }
}

async function connectWithRetry() {
    console.log('正在连接 Chrome...');
    for (let k = 0; k < 5; k++) {
        try {
            const browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            return browser;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await sleep(2000);
        }
    }
    throw new Error('CDP 连接失败');
}

/* ============================== Cookie 操作 ============================== */

async function getCookieInfo(context, name) {
    try {
        const cookies = await context.cookies('https://bot-hosting.net');
        for (const c of cookies) {
            if (c.name === name) {
                const expiry = (c.expires && c.expires > 0) ? new Date(c.expires * 1000) : null;
                return { value: c.value, expiry };
            }
        }
    } catch (e) {
        console.log(`⚠️ 读取 Cookie(${name}) 失败: ${e.message}`);
    }
    return { value: null, expiry: null };
}

async function deleteCookieVariants(context, page, name) {
    const domains = ['bot-hosting.net', '.bot-hosting.net', 'www.bot-hosting.net'];
    try {
        const client = await context.newCDPSession(page);
        for (const domain of domains) {
            try { await client.send('Network.deleteCookies', { name, domain, path: '/' }); } catch (e) { }
            try { await client.send('Network.deleteCookies', { name, domain }); } catch (e) { }
        }
        await client.detach().catch(() => { });
        console.log(`✅ 已删除 Cookie: ${name}`);
        return true;
    } catch (e) {
        console.log(`⚠️ deleteCookie(${name}) 失败: ${e.message}`);
        return false;
    }
}

async function clearStaleSessionCookies(context, page, wipeAllIfStuck = false) {
    console.log('🧹 清除过期的 session_token / login Cookie...');
    let url = '';
    try { url = page.url() || ''; } catch (e) { }
    if (!url.includes('bot-hosting.net')) {
        try {
            await page.goto('https://bot-hosting.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
            await sleep(1000);
        } catch (e) {
            console.log(`⚠️ 无法打开 bot-hosting 以清 Cookie: ${e.message}`);
            return;
        }
    }

    for (const name of ['session_token', 'login']) {
        await deleteCookieVariants(context, page, name);
    }

    let leftover = [];
    try {
        const cookies = await context.cookies('https://bot-hosting.net');
        leftover = cookies.filter(c => c.name === 'session_token' || c.name === 'login').map(c => c.name);
    } catch (e) { }
    if (leftover.length) {
        console.log(`⚠️ 仍残留 Cookie: ${leftover.join(', ')}`);
        if (wipeAllIfStuck) {
            try {
                await context.clearCookies();
                console.log('✅ 已 clearCookies()');
            } catch (e) {
                console.log(`⚠️ clearCookies 失败: ${e.message}`);
            }
        }
    }
}

// 切换账号前清干净所有 Cookie
async function clearAllCookies(context) {
    try {
        await context.clearCookies();
        console.log('🧹 已清空全部 Cookie（切换账号）');
    } catch (e) {
        console.log(`⚠️ clearCookies 失败: ${e.message}`);
    }
}

async function injectSessionCookies(context, page, cookies) {
    let url = '';
    try { url = page.url() || ''; } catch (e) { }
    if (!url.includes('bot-hosting.net')) {
        console.log(`⚠️ 当前不在 bot-hosting 域，跳过 Cookie 注入。URL=${url}`);
        return false;
    }

    let okAny = false;
    for (const [name, rawValue] of Object.entries(cookies)) {
        if (!rawValue) continue;
        const value = String(rawValue).trim();
        if (!value) continue;

        const variants = [
            { name, value, url: 'https://bot-hosting.net/', path: '/', secure: true },
            { name, value, domain: '.bot-hosting.net', path: '/', secure: true },
            { name, value, domain: 'bot-hosting.net', path: '/', secure: true },
        ];
        let injected = false;
        let lastErr = null;
        for (const cookie of variants) {
            try {
                await context.addCookies([cookie]);
                injected = true;
                okAny = true;
                break;
            } catch (e) {
                lastErr = e;
            }
        }
        if (injected) console.log(`✅ Cookie 已注入: ${name}`);
        else console.log(`⚠️ Cookie 注入失败: ${name} → ${lastErr ? lastErr.message : 'unknown'}`);
    }
    return okAny;
}

/* ============================== SESSION_TOKEN 有效期 / 写回（旧版单账号） ============================== */

function tokenSecondsLeft(token) {
    try {
        const parts = (token || '').split('.');
        if (parts.length < 2) return null;
        const payload = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
        const data = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
        if (typeof data.exp !== 'number') return null;
        return Math.floor(data.exp - Date.now() / 1000);
    } catch (e) {
        return null;
    }
}

function sessionSecondsLeft(token, expiryDate) {
    const jwtLeft = tokenSecondsLeft(token);
    const cookieLeft = expiryDate ? Math.floor((expiryDate.getTime() - Date.now()) / 1000) : null;
    const candidates = [jwtLeft, cookieLeft].filter(x => x !== null && x !== undefined);
    if (!candidates.length) return null;
    return Math.min(...candidates);
}

function shouldWriteSessionToken(freshVal, oldVal, secondsLeft, force = false) {
    const hoursLimit = refreshBeforeHours();
    const changed = Boolean(freshVal) && freshVal !== (oldVal || '').trim();
    const changedNote = changed ? '；浏览器里的 token 值和 Secret 不同（已忽略）' : '';
    if (force) return { should: true, reason: 'Discord 登录换到新 session，强制写回' };
    if (!freshVal) return { should: false, reason: '浏览器中未读到 session_token，无法写回' };
    if (secondsLeft === null || secondsLeft === undefined) {
        return { should: false, reason: `未读到有效期，未写回${changedNote}` };
    }
    const hoursLeft = secondsLeft / 3600.0;
    if (secondsLeft < hoursLimit * 3600) {
        return {
            should: true,
            reason: `剩余约 ${hoursLeft.toFixed(1)} 小时 < ${hoursLimit}h，将写回 Secrets${changed ? '；token 值已变化' : ''}`,
        };
    }
    return { should: false, reason: `剩余约 ${hoursLeft.toFixed(1)} 小时 ≥ ${hoursLimit}h，未写回${changedNote}` };
}

function updateGithubSecret(secretName, newValue) {
    return new Promise((resolve) => {
        if (!newValue) {
            console.log(`⚠️ 跳过更新 ${secretName}：新值为空`);
            return resolve(false);
        }
        console.log(`🔄 更新 Secret: ${secretName} (新值: ${maskSecret(newValue)})`);
        const env = { ...process.env };
        execFile('gh', ['secret', 'set', secretName, '--body', newValue],
            { env, timeout: 30000 }, (err, stdout, stderr) => {
                if (!err) return resolve(true);
                console.log(`❌ 更新失败: ${stderr ? stderr.trim() : err.message}`);
                resolve(false);
            });
    });
}

async function persistSessionToken(context, page, force = false) {
    const hoursLimit = refreshBeforeHours();
    console.log('---------- SESSION_TOKEN 写回 ----------');
    const { value: freshVal, expiry: tokenExpiry } = await getCookieInfo(context, 'session_token');
    const secondsLeft = sessionSecondsLeft(freshVal || '', tokenExpiry);
    if (tokenExpiry) console.log(`Cookie 到期: ${tokenExpiry.toISOString()}`);
    const jwtLeft = tokenSecondsLeft(freshVal || '');
    if (jwtLeft !== null) console.log(`JWT exp 剩余: ${(jwtLeft / 3600.0).toFixed(1)} 小时`);
    console.log(`用于判定的剩余: ${secondsLeft !== null ? (secondsLeft / 3600.0).toFixed(1) + ' 小时' : '未知'}`);
    console.log(`写回阈值: ${hoursLimit} 小时`);

    const { should, reason } = shouldWriteSessionToken(freshVal, _KNOWN_SESSION_TOKEN, secondsLeft, force);
    if (!should || !freshVal) {
        _SESSION_PERSIST_MSG = `未写回（${reason}）`;
        console.log('结果: 未写回');
        console.log(`原因: ${reason}`);
        console.log('----------------------------------------');
        return false;
    }

    console.log(`当前 token: ${maskSecret(freshVal)}`);
    if (!GH_TOKEN) {
        _SESSION_PERSIST_MSG = '未写回（未设置 GH_TOKEN）';
        console.log('结果: 未写回\n原因: 未设置 GH_TOKEN');
        console.log('请手动设置 SESSION_TOKEN（新值请手动更新到 GitHub Secrets）');
        console.log('----------------------------------------');
        return false;
    }

    console.log(`原因: ${reason}`);
    if (await updateGithubSecret('SESSION_TOKEN', freshVal)) {
        rememberVal(freshVal);
        _SESSION_PERSIST_MSG = `已写回 Secrets（${reason}）`;
        console.log('结果: 已写回 Secrets');
        console.log('----------------------------------------');
        return true;
    }
    _SESSION_PERSIST_MSG = '未写回（gh secret set 失败，检查 GH_TOKEN 的 repo 权限）';
    console.log('结果: 未写回\n原因: gh secret set 失败');
    console.log('----------------------------------------');
    return false;
}

/* ============================== Discord OAuth 登录（旧版备用） ============================== */

const DISCORD_CLIENT_ID = '884382422530158623';
const OAUTH_REDIRECT_URI = 'https://bot-hosting.net/login';
const OAUTH_SCOPE = 'identify email guilds';
const DISCORD_API = 'https://discord.com/api/v9/oauth2/authorize';
const DISCORD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const STATE_RE = /[?&]state=([^&]+)/;

async function captureDiscordState(page) {
    console.log('🔎 获取 Discord OAuth state...');
    try {
        await page.goto('https://bot-hosting.net/login/discord', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log(`⚠️ 打开 /login/discord 出错: ${e.message}`);
    }
    await sleep(2000);

    let url = page.url();
    for (let i = 0; i < 15 && !url.includes('discord.com'); i++) {
        await sleep(1000);
        url = page.url();
    }
    if (!url.includes('discord.com')) {
        console.log(`⚠️ 未跳转到 Discord 相关页面，当前 URL：${url}`);
        return '';
    }

    const m = STATE_RE.exec(url);
    if (!m) {
        console.log(`❌ 未能从 URL 中解析出 state，当前 URL：${url}`);
        return '';
    }
    const state = decodeURIComponent(m[1]);
    console.log(`✅ 已捕获 state（当前落地页：${new URL(url).pathname}）`);
    return state;
}

async function discordAuthorize(state) {
    const query = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        response_type: 'code',
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: OAUTH_SCOPE,
        state,
    }).toString();
    const authorizeUrl = `${DISCORD_API}?${query}`;

    const referer = 'https://discord.com/oauth2/authorize?' + new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        response_type: 'code',
        scope: OAUTH_SCOPE,
        state,
    }).toString();

    const headers = {
        'accept': '*/*',
        'authorization': DC_TOKEN,
        'content-type': 'application/json',
        'origin': 'https://discord.com',
        'referer': referer,
        'user-agent': DISCORD_UA,
        'x-discord-locale': 'zh-CN',
    };

    const body = {
        permissions: '0',
        authorize: true,
        integration_type: 0,
        location_context: {
            guild_id: '10000',
            channel_id: '10000',
            channel_type: 10000,
        },
    };

    try {
        const resp = await axios.post(authorizeUrl, body, { headers, timeout: 20000, ...axiosProxyConfig() });
        const location = (resp.data && resp.data.location) || '';
        if (!location) {
            console.log(`❌ 授权响应中未找到 location 字段: ${JSON.stringify(resp.data).slice(0, 300)}`);
            _DISCORD_DETAIL = 'Discord 授权响应中没有 location（未拿到回调 code）';
            return '';
        }
        console.log(`✅ 拿到回调 URL: ${location.replace(/code=[^&]+/, 'code=***')}`);
        return location;
    } catch (e) {
        const status = e.response ? e.response.status : 0;
        const snippet = e.response ? JSON.stringify(e.response.data).slice(0, 300) : '';
        console.log(`❌ Discord OAuth2 授权失败: HTTP ${status} - ${snippet || e.message}`);
        if (status === 401) _DISCORD_DETAIL = 'Discord Token 已失效（HTTP 401），需要更新 DISCORD_TOKEN';
        else if (status) _DISCORD_DETAIL = `Discord OAuth2 授权失败: HTTP ${status}`;
        else _DISCORD_DETAIL = `Discord OAuth2 授权异常: ${e.message}`;
        return '';
    }
}

async function doDiscordLogin(context, page) {
    console.log('\n🔑 通过 Discord Token 登录...');

    const state = await captureDiscordState(page);
    if (!state) {
        _DISCORD_DETAIL = '未能从 Discord 落地页解析 OAuth state';
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_no_state.png'), fullPage: true }).catch(() => { });
        return false;
    }

    const location = await discordAuthorize(state);
    if (!location) return false;

    await clearStaleSessionCookies(context, page, false);

    console.log('↩️ 携带授权码打开回调链接...');
    try {
        await page.goto(location, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log(`⚠️ 打开回调链接出错: ${e.message}`);
    }
    await sleep(3000);

    let url = page.url();
    _LAST_FAIL_URL = url;

    if (url.includes('/error/banned')) {
        console.log('🚫 账号已被封禁');
        _DISCORD_DETAIL = '账号已被 bot-hosting 封禁';
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_banned.png'), fullPage: true }).catch(() => { });
        return false;
    }
    if (!url.includes('bot-hosting.net')) {
        console.log(`❌ 回调后未跳转至 bot-hosting.net，当前 URL：${url}`);
        _DISCORD_DETAIL = `回调后未回到 bot-hosting.net：${url}`;
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_no_redirect.png'), fullPage: true }).catch(() => { });
        return false;
    }

    let bodyText = '';
    try { bodyText = await page.locator('body').innerText(); } catch (e) { }
    if (bodyText.toLowerCase().includes('fraud')) {
        console.log('🚫 触发风控（fraud attempt），可能是 IP 被拦截');
        _DISCORD_DETAIL = '触发风控（fraud attempt），可能是代理 IP 被拦截';
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_fraud.png'), fullPage: true }).catch(() => { });
        return false;
    }

    for (let i = 0; i < 30; i++) {
        url = page.url();
        _LAST_FAIL_URL = url;
        const p = (() => { try { return new URL(url).pathname; } catch (e) { return ''; } })();
        if (url.includes('error=disconnect')) {
            await sleep(500);
            continue;
        }
        if (url.includes('bot-hosting.net') && p !== '/login' && !p.startsWith('/login/discord')) {
            console.log(`✅ Discord OAuth 登录成功！当前页面：${url}`);
            return true;
        }
        await sleep(500);
    }

    console.log(`❌ 登录超时或未跳转成功，最终停留在：${url}`);
    _DISCORD_DETAIL = url.includes('error=disconnect')
        ? 'Discord 已拿到授权码，但回调停留在 error=disconnect'
        : `Discord 回调超时，停留在：${url}`;
    try {
        bodyText = await page.locator('body').innerText();
        console.log(`📄 页面正文片段：${JSON.stringify(bodyText.slice(0, 200))}`);
    } catch (e) { }
    await page.screenshot({ path: path.join(PHOTO_DIR, 'login_timeout.png'), fullPage: true }).catch(() => { });
    return false;
}

/* ============================== 页面解析工具 ============================== */

function extractExpiryDate(pageSource) {
    const patterns = [
        /[Ee]xpires\s*[:\-]?\s*(\d{4}\/\d{2}\/\d{2})/,
        /[Ee]xpires\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})/,
        /(\d{4}\/\d{2}\/\d{2})\s*[\-–]\s*renew/,
        /(\d{2}\/\d{2}\/\d{4})\s*[\-–]\s*renew/,
        /(\d{4}\/\d{2}\/\d{2})\s*[\-–]\s*renew manually to extend for 4 days/,
    ];
    for (const pattern of patterns) {
        const match = pattern.exec(pageSource);
        if (match) {
            let dateStr = match[1];
            const parts = dateStr.split('/');
            if (parts[parts.length - 1].length === 4 && parts[0].length === 2) {
                dateStr = `${parts[2]}/${parts[0]}/${parts[1]}`;
            }
            return dateStr;
        }
    }
    return null;
}

function formatCountdown(countdownStr) {
    try {
        const [h, m] = countdownStr.split(':').map(x => parseInt(x, 10));
        if (h > 0) return `${h}h${m}min`;
        return `${m}min`;
    } catch (e) {
        return countdownStr;
    }
}

async function getExitIp() {
    const resp = await axios.get('https://api.ip.sb/ip', { timeout: 15000, ...axiosProxyConfig() });
    return String(resp.data).trim();
}

async function detectRenewControls(page) {
    let countdownText = null;
    let hasRenewButton = false;
    try {
        const handles = await page.locator('button, a').elementHandles();
        for (const handle of handles) {
            let text = '';
            try { text = (await handle.innerText()).trim(); } catch (e) { continue; }
            if (!text || text.length > 200 || !/renew/i.test(text)) continue;

            const m = text.match(/Renew in (\d{2}:\d{2}:\d{2})/i);
            if (m) {
                countdownText = m[1];
                continue;
            }
            if (/renew/i.test(text) && !/\bin\b/i.test(text)) {
                hasRenewButton = true;
            }
        }
    } catch (e) {
        console.log(`⚠️ 探测续期控件出错: ${e.message}`);
    }
    return { hasRenewButton, countdownText };
}

function outerRenewLocator(page) {
    return page.locator('button:has-text("Renew"), a:has-text("Renew")')
        .filter({ hasNotText: 'Renew in' }).first();
}

/* ============================== 登录：Email + 密码（多账号主通道） ============================== */

// bot-hosting 登录页表单：邮箱 → "Continue with email" → 密码 + Turnstile → Log in
// （站点为 SvelteKit，后端 /api/auth/email action:"login"）
async function loginWithEmailPassword(context, page, user) {
    const email = (user.username || '').trim();
    const password = user.password || '';
    if (!email || !password) {
        console.log('❌ 用户缺少 username(email) 或 password');
        return false;
    }
    addMask(email);
    addMask(password);

    console.log(`🌐 打开登录页 (用户: ${email})...`);
    await page.goto('https://bot-hosting.net/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2000);

    // 1. 输入邮箱
    const emailInput = page.locator('input[type="email"]').first();
    try {
        await emailInput.waitFor({ state: 'visible', timeout: 15000 });
    } catch (e) {
        console.log('❌ 未找到邮箱输入框');
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_no_email_field.png'), fullPage: true }).catch(() => { });
        return false;
    }
    await emailInput.fill(email);
    await sleep(500);

    // 2. 若密码框尚未出现，点 "Continue with email" 进入密码步骤
    const pwdInput = page.locator('input[type="password"]').first();
    if (!(await pwdInput.isVisible().catch(() => false))) {
        const continueBtn = page.getByRole('button', { name: /continue with email/i }).first();
        if (await continueBtn.isVisible().catch(() => false)) {
            console.log('   >> 点击 "Continue with email"...');
            await continueBtn.click();
            await sleep(1500);
        }
    }

    // 3. 输入密码
    try {
        await pwdInput.waitFor({ state: 'visible', timeout: 15000 });
    } catch (e) {
        console.log('❌ 未找到密码输入框（账号可能未注册或页面结构变化）');
        await page.screenshot({ path: path.join(PHOTO_DIR, 'login_no_password_field.png'), fullPage: true }).catch(() => { });
        return false;
    }
    await pwdInput.fill(password);
    await sleep(500);

    // 4. 登录页 Turnstile（CDP 点击；免打扰模式下无 checkbox 则自动跳过）
    console.log('   >> 处理登录页 Turnstile (CDP)...');
    for (let i = 0; i < 15; i++) {
        if (await attemptTurnstileCdp(page)) {
            console.log('   >> CDP 点击已发送，等待验证...');
            await sleep(3000);
            break;
        }
        await sleep(1000);
    }

    // 5. 提交登录（带验证码错误重试）
    for (let attempt = 1; attempt <= 3; attempt++) {
        const submitBtn = page.locator('form button[type="submit"]:not([disabled])').last();
        try {
            await submitBtn.click({ timeout: 8000 });
            console.log('   >> 已提交登录表单...');
        } catch (e) {
            console.log(`   >> 提交按钮点击失败: ${e.message}`);
        }

        // 等待跳转 / 出错
        for (let i = 0; i < 30; i++) {
            await sleep(500);
            const url = page.url();

            // 成功：离开登录路径，或拿到 session_token
            const p = (() => { try { return new URL(url).pathname; } catch (e) { return url; } })();
            if (url.includes('bot-hosting.net') && !p.startsWith('/login')) {
                console.log(`✅ Email+Password 登录成功！当前页面：${url}`);
                
                const { value } = await getCookieInfo(context, 'session_token');
                if (value) {
                    console.log('✅ 已获取 session_token！');
                }

                console.log('🌐 访问 https://bot-hosting.net/a/billings ...');
                await page.goto('https://bot-hosting.net/a/billings', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await sleep(3000);
                const currentUrl = page.url();
                console.log(`📝 当前URL: ${currentUrl}`);

                if (currentUrl.includes('/a/billings') && !currentUrl.includes('/login') && !currentUrl.includes('error=')) {
                    console.log('✅ 当前已到达账单页');
                    return true;
                }
                console.log('⚠️ 账单页访问失败');
                return false;
            }
            const { value } = await getCookieInfo(context, 'session_token');
            if (value) {
                console.log('✅ Email+Password 登录成功（已获取 session_token）！');
                
                console.log('🌐 访问 https://bot-hosting.net/a/billings ...');
                await page.goto('https://bot-hosting.net/a/billings', { waitUntil: 'domcontentloaded', timeout: 60000 });
                await sleep(3000);
                const currentUrl = page.url();
                console.log(`📝 当前URL: ${currentUrl}`);

                if (currentUrl.includes('/a/billings') && !currentUrl.includes('/login') && !currentUrl.includes('error=')) {
                    console.log('✅ 当前已到达账单页');
                    return true;
                }
                console.log('⚠️ 账单页访问失败');
                return false;
            }

            // 页面可见错误文本
            let bodyText = '';
            try { bodyText = await page.locator('body').innerText(); } catch (e) { }
            const lower = bodyText.toLowerCase();

            if (/complete the (captcha|verification)|verify you are human|please verify|确认您是真人/.test(lower)) {
                console.log('   >> ⚠️ 需要完成验证码，重试 Turnstile...');
                for (let j = 0; j < 10; j++) {
                    if (await attemptTurnstileCdp(page)) break;
                    await sleep(1000);
                }
                await sleep(3000);
                break;   // 重新提交
            }

            if (/incorrect|invalid|wrong|not found|does not exist|no account|rate limit|too many|failed|banned|suspended/.test(lower)) {
                // 提取错误行（取较短的、命中关键词的行）
                const errLine = bodyText.split('\n')
                    .map(s => s.trim())
                    .find(s => s.length > 3 && s.length < 160
                        && /incorrect|invalid|wrong|not found|does not exist|no account|rate limit|too many|failed|banned|suspended/i.test(s));
                const errText = errLine || '账号或密码错误';
                console.log(`   >> ❌ 登录失败: ${errText}`);
                await page.screenshot({ path: path.join(PHOTO_DIR, `login_fail_${safeName(email)}.png`), fullPage: true }).catch(() => { });
                user.loginError = errText;
                return false;
            }
        }
    }

    console.log('❌ 登录超时，未跳转到面板');
    await page.screenshot({ path: path.join(PHOTO_DIR, `login_timeout_${safeName(email)}.png`), fullPage: true }).catch(() => { });
    user.loginError = '登录超时，未跳转到面板';
    return false;
}

// 每账号可选的 session_token Cookie 快速通道
async function trySessionTokenLogin(context, page, token) {
    console.log('🚀 尝试 session_token Cookie 登录...');
    try {
        await page.goto('https://bot-hosting.net/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(2000);

        console.log('📝 注入 Cookie...');
        await injectSessionCookies(context, page, {
            session_token: token,
            login: 'true',
            theme: 'system',
        });

        console.log('🌐 访问 https://bot-hosting.net/a/billings ...');
        await page.goto('https://bot-hosting.net/a/billings', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(3000);
        const currentUrl = page.url();
        console.log(`📝 当前URL: ${currentUrl}`);

        if (currentUrl.includes('/a/billings') && !currentUrl.includes('/login') && !currentUrl.includes('error=')) {
            console.log('✅ session_token 登录成功, 当前已到达账单页');
            return true;
        }
        console.log(`❌ session_token 登录失败，当前URL: ${currentUrl}`);
    } catch (e) {
        console.log(`❌ session_token 登录流程异常: ${e.message}`);
    }
    return false;
}

/* ============================== 续期流程（单账号） ============================== */

async function renewForAccount(context, page, account) {
    const label = accountLabel(account);

    // 提取当前到期日期
    await sleep(2000);
    let pageSource = await page.content().catch(() => '');
    const currentExpiry = extractExpiryDate(pageSource);
    if (currentExpiry) console.log(`📅 当前到期日期: ${currentExpiry}`);
    else console.log('⚠️ 未能提取当前到期日期');

    // 寻找续期按钮 / 倒计时
    const { hasRenewButton, countdownText } = await detectRenewControls(page);

    if (!hasRenewButton) {
        if (countdownText) {
            const friendly = formatCountdown(countdownText);
            console.log(`⏳ 未到续期时间，倒计时: ${countdownText} (${friendly})`);
            await notify(formatNotification('⏳ 未到续期时间', {
                account,
                extra: `⏱️ 可续期时间: ${friendly}后`,
                expiryDate: currentExpiry || '（未获取到）',
            }));
        } else {
            console.log('ℹ️ 未找到续期按钮或倒计时，状态未知');
            await notify(formatNotification('ℹ️ 无需续期', {
                account,
                extra: '当前状态未知，请手动检查',
                expiryDate: currentExpiry || '（未获取到）',
            }));
        }
        return;
    }

    console.log('🔄 点击外部续期按钮，等待验证窗口...');
    try {
        await sleep(2000);
        await outerRenewLocator(page).click();
        await sleep(15000);   // 等待模态框加载（可能因网络因素加载慢）
    } catch (e) {
        console.log(`❌ 点击外部按钮失败: ${e.message}`);
        await notify(formatNotification('❌ 续期失败', {
            account,
            error: '点击外部续期按钮出错',
            expiryDate: currentExpiry || '',
        }));
        return;
    }

    // 处理弹窗中的 Turnstile（CDP 原生鼠标点击）
    console.log('🔒 检测弹窗中的 Turnstile 验证...');
    let turnstilePassed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let clicked = false;
        for (let findAttempt = 0; findAttempt < 10 && !clicked; findAttempt++) {
            clicked = await attemptTurnstileCdp(page);
            if (!clicked) await sleep(1000);
        }
        if (clicked) {
            console.log('   >> CDP 点击已发送，等待验证结果...');
            await sleep(3000);
        }

        if (await waitForTurnstilePass(page, 20000)) {
            turnstilePassed = true;
            break;
        }
        console.log(`⏳ 第 ${attempt} 次未通过，重试点击...`);
    }

    if (!turnstilePassed) {
        console.log('❌ Turnstile 验证最终未通过');
        await page.screenshot({ path: path.join(PHOTO_DIR, `turnstile_failed_${safeName(label)}.png`), fullPage: true }).catch(() => { });
        await notify(formatNotification('❌ 续期失败', {
            account,
            error: 'Turnstile 验证未通过',
            expiryDate: currentExpiry || '',
        }));
        return;
    }

    // 点击续期按钮
    console.log('⏳ 等待续期按钮可用并点击...');
    await sleep(5000);
    let clickedConfirm = false;
    for (let retry = 0; retry < 3; retry++) {
        try {
            await page.getByRole('button', { name: /Renew for 4 days/i }).click({ timeout: 8000 });
            console.log('✅ 已点击续期按钮');
            clickedConfirm = true;
        } catch (e) {
            console.log(`续期按钮点击失败: ${e.message}`);
        }

        await sleep(2000);
        const captchaErrVisible = await page.getByText('Please complete the captcha', { exact: false })
            .isVisible().catch(() => false);
        if (!captchaErrVisible) break;

        console.log('   >> ⚠️ 提示 "Please complete the captcha"，重试 Turnstile...');
        for (let findAttempt = 0; findAttempt < 10; findAttempt++) {
            if (await attemptTurnstileCdp(page)) break;
            await sleep(1000);
        }
        await sleep(3000);
    }
    if (!clickedConfirm) console.log('⚠️ 未能点击确认续期按钮，继续检查结果...');

    console.log('⏳ 等待新的过期时间...');
    await sleep(6000);

    // 提取新的到期日期和倒计时
    const newPageText = await page.content().catch(() => '');
    const newExpiry = extractExpiryDate(newPageText);
    const newMatch = /Renew in (\d{2}:\d{2}:\d{2})/i.exec(newPageText);
    if (newMatch) {
        const newCountdown = newMatch[1];
        console.log(`✅ 续期成功！新的倒计时: ${newCountdown}`);
        if (newExpiry) console.log(`📅 新的到期日期: ${newExpiry}`);
        await page.screenshot({ path: path.join(PHOTO_DIR, `renew_success_${safeName(label)}.png`), fullPage: true }).catch(() => { });
        await notify(formatNotification('✅ 续期成功', {
            account,
            extra: `⏱️ 可续期时间: ${formatCountdown(newCountdown)}后`,
            expiryDate: newExpiry || '（未获取到）',
        }));
    } else if (newExpiry && newExpiry !== currentExpiry) {
        console.log(`✅ 续期成功，到期日期已更新为: ${newExpiry}`);
        await notify(formatNotification('✅ 续期成功', {
            account,
            extra: '到期日期已更新',
            expiryDate: newExpiry,
        }));
    } else {
        console.log('⚠️ 续期结果未知，到期日期未变化，请手动检查');
        await page.screenshot({ path: path.join(PHOTO_DIR, `renew_unknown_${safeName(label)}.png`), fullPage: true }).catch(() => { });
        await notify(formatNotification('⚠️ 续期可能未成功', {
            account,
            extra: '请登录后台检查',
            expiryDate: currentExpiry || '（未获取到）',
        }));
    }
}

/* ============================== 账号列表 ============================== */

function getUsers() {
    // katabump 同款：BOT_USERS_JSON = [{"username":"email","password":"xxx"}, ...]
    // 每账号可选 "session_token"（Cookie 快速通道）
    try {
        if (process.env.BOT_USERS_JSON) {
            const parsed = JSON.parse(process.env.BOT_USERS_JSON);
            const users = Array.isArray(parsed) ? parsed : (parsed.users || []);
            return users
                .map(u => ({
                    username: String(u.username || u.email || '').trim(),
                    password: String(u.password || ''),
                    session_token: String(u.session_token || '').trim(),
                    loginMethod: 'Email+Password',
                    loginError: '',
                }))
                .filter(u => u.username && u.password);
        }
    } catch (e) {
        console.error('解析 BOT_USERS_JSON 环境变量错误:', e.message);
    }

    // 旧版单账号模式
    if (SESSION_TOKEN || DC_TOKEN) {
        return [{
            username: EMAIL,
            password: '',
            session_token: SESSION_TOKEN,
            legacy: true,
            loginMethod: 'SESSION_TOKEN',
            loginError: '',
        }];
    }
    return [];
}

/* ============================== 主流程 ============================== */

async function run() {
    console.log('#'.repeat(25));
    console.log('   Bot-hosting 自动续期 (多账号)');
    console.log('#'.repeat(25));

    if (!fs.existsSync(PHOTO_DIR)) fs.mkdirSync(PHOTO_DIR, { recursive: true });

    const users = getUsers();
    if (users.length === 0) {
        console.log('未找到账号。请配置 BOT_USERS_JSON=[{"username":"email","password":"xxx"},...]（或旧版 SESSION_TOKEN/DISCORD_TOKEN）');
        await notify(formatNotification('❌ 脚本异常', { error: '未配置任何账号（BOT_USERS_JSON / SESSION_TOKEN）' }));
        process.exit(1);
    }
    console.log(`📋 共 ${users.length} 个账号待处理`);
    users.forEach(u => { addMask(u.username); addMask(u.password); addMask(u.session_token); });

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            await notify(formatNotification('❌ 脚本异常', { error: '代理无效，无法访问外网' }));
            process.exit(1);
        }
    } else {
        console.log('🍭 未使用代理，直连访问');
    }
    try {
        const ip = await getExitIp();
        console.log(`📍 当前出口IP: ${ip}`);
    } catch (e) {
        console.log(`⚠️ 获取出口 IP 失败: ${e.message}`);
    }

    await launchChrome();
    const browser = await connectWithRetry();
    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    // 代理认证（与 action_renew.js 相同）
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password,
        });
    } else {
        await context.setHTTPCredentials(null).catch(() => { });
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            // 切换账号：先清空 Cookie，复用/新建页面
            await clearAllCookies(context);
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            let loginOk = false;

            if (user.legacy) {
                /* ---------- 旧版单账号登录链：SESSION_TOKEN → Discord OAuth ---------- */
                _LOGIN_METHOD = 'SESSION_TOKEN';
                if (user.session_token) {
                    loginOk = await trySessionTokenLogin(context, page, user.session_token);
                }

                if (!loginOk && DC_TOKEN) {
                    addMask(DC_TOKEN);
                    _LOGIN_METHOD = 'Discord Token';
                    console.log('\n🔄 SESSION_TOKEN 登录失败或未配置，尝试 Discord OAuth 登录...');
                    await clearStaleSessionCookies(context, page, true);

                    if (await doDiscordLogin(context, page)) {
                        console.log('🌐 访问 https://bot-hosting.net/a/billings ...');
                        try {
                            await page.goto('https://bot-hosting.net/a/billings', { waitUntil: 'domcontentloaded', timeout: 60000 });
                            await sleep(3000);
                        } catch (e) { }
                        const currentUrl = page.url();
                        if (currentUrl.includes('a/billings') && !currentUrl.includes('error=')) {
                            loginOk = true;
                            console.log('✅ Discord OAuth 登录成功,当前已到达账单页');
                        } else {
                            _LAST_FAIL_URL = currentUrl || '';
                            if (currentUrl.includes('error=disconnect')) {
                                _DISCORD_DETAIL = 'Discord 登录后仍停留在 error=disconnect';
                            }
                        }
                    } else {
                        console.log('❌ Discord OAuth 登录失败');
                    }
                }

                if (loginOk) {
                    if (_LOGIN_METHOD === 'Discord Token') {
                        console.log('ℹ️ 本次使用 Discord OAuth 登录，立即写回新的 SESSION_TOKEN');
                    }
                    await persistSessionToken(context, page, _LOGIN_METHOD === 'Discord Token');
                }
            } else {
                /* ---------- 多账号登录链：session_token（可选）→ Email+密码 ---------- */
                if (user.session_token) {
                    loginOk = await trySessionTokenLogin(context, page, user.session_token);
                    user.loginMethod = 'session_token';
                }
                if (!loginOk) {
                    loginOk = await loginWithEmailPassword(context, page, user);
                    user.loginMethod = 'Email+Password';
                }
            }

            if (!loginOk) {
                const errorMsg = user.legacy
                    ? loginFailureMessage()
                    : (user.loginError || '账号或密码错误 / 登录超时');
                console.log(`   >> ❌ 用户登录失败: ${errorMsg}`);
                await notify(formatNotification('❌ 登录失败', {
                    account: user,
                    loginMethod: user.loginMethod,
                    error: errorMsg,
                }));
                const failShot = path.join(PHOTO_DIR, `user_${i + 1}_login_fail.png`);
                try { await page.screenshot({ path: failShot, fullPage: true }); } catch (e) { }
                continue;   // 处理下一个账号
            }

            // 续期
            await renewForAccount(context, page, user);

            // 旧版单账号：续期结束再检查一次写回
            if (user.legacy) {
                await persistSessionToken(context, page);
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
            await notify(formatNotification('❌ 脚本异常', {
                account: user,
                error: String(err && err.message ? err.message : err).slice(0, 300),
            }));
        }

        // 每账号完成后截图留档（文件名不含账号信息）
        const screenshotPath = path.join(PHOTO_DIR, `user_${i + 1}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('🏁 全部账号处理完毕');
}

async function main() {
    try {
        addMask(SESSION_TOKEN);
        addMask(DC_TOKEN);
        await run();
    } catch (e) {
        const err = (e && e.message ? e.message : String(e)).trim() || (e && e.name) || 'Unknown error';
        console.log(`❌ 未捕获异常: ${err}`);
        console.log(`::error::Bot-hosting 续期脚本异常: ${err}`);
        try {
            await notify(formatNotification('❌ 脚本异常', {
                error: err.slice(0, 500),
                extra: 'Playwright/页面/网络等未预期错误，请查看 Actions 日志',
            }));
        } catch (ne) {
            console.log(`异常通知也失败: ${ne.message}`);
        }
        process.exit(1);
    }
    process.exit(0);
}

main();