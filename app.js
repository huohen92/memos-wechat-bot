/*
 * Memos 企业微信机器人
 * Copyright (C) 2026  huohen92
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */


const express = require('express');
const axios = require('axios');
const wecomCrypto = require('@wecom/crypto');
const xml2js = require('xml2js');
const crypto = require('crypto');
const fs = require('fs').promises;

const app = express();
app.use(express.json());

// ========== 日志级别控制 ==========
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const logLevels = { error: 0, warn: 1, info: 2, debug: 3 };
function log(level, ...args) {
    if (logLevels[level] <= logLevels[LOG_LEVEL]) {
        console.log(`[${level.toUpperCase()}]`, ...args);
    }
}
// =================================

// 持久化文件路径
const CONFIG_FILE = '/data/config.json';

// 企业微信配置
const CORP_ID = process.env.WECOM_CORP_ID;
const AGENT_ID = process.env.WECOM_AGENT_ID;
const SECRET = process.env.WECOM_SECRET;
const TOKEN = process.env.WECOM_TOKEN;
const ENCODING_AES_KEY = process.env.WECOM_ENCODING_AES_KEY;
const DEFAULT_TOUSER = process.env.WECOM_TOUSER || '@all';

// 代理配置
const PROXY_URL = process.env.PROXY_URL || 'https://qyapi.weixin.qq.com';

// Memos API 配置
const MEMOS_URL = process.env.MEMOS_URL;
const MEMOS_WEB_URL = process.env.MEMOS_WEB_URL || 'http://your-memos-ip:5230';
const DEFAULT_VISIBILITY = 'PRIVATE';
const DEFAULT_TAG = process.env.MEMOS_DEFAULT_TAG || '#企业微信机器人';

// 无菜单模式（环境变量控制，默认 false）
const NO_MENU = process.env.NO_MENU === 'true';

// 可见性映射（私有、工作区、公开）
const visibilityMap = {
    '私有': 'PRIVATE',
    '工作区': 'PROTECTED',
    '公开': 'PUBLIC'
};
const visibilityDisplay = {
    'PRIVATE': 'PRIVATE (私有)',
    'PROTECTED': 'PROTECTED (工作区)',
    'PUBLIC': 'PUBLIC (公开)'
};

// 存储用户数据：{ userId: { token: string, visibility: string, tag: string } }
let userData = new Map();
// 全局配置（从 config.json 的 meta 中读取）
let globalMeta = {
    menuEnabled: false  // 默认关闭
};

// 存储每个用户的最近查询结果列表 (用于 /view)
const userLastResults = new Map(); // key: userId, value: array of memo objects
const userCurrentIndex = new Map(); // key: userId, value: current index (0-based)
const userContext = new Map(); // key: userId, value: { mode: 'list'|'search'|'search-all'|'today'|'week'|'filter', page: number, totalPages: number, keyword: string, pageSize: number, hasMore: boolean }

// ---------- 辅助函数 ----------
function numToCircled(n) {
    if (n >= 1 && n <= 20) {
        return String.fromCodePoint(0x2460 + n - 1);
    }
    return `(${n})`;
}

function getModeDisplayName(userId) {
    const ctx = userContext.get(userId);
    if (!ctx) return '无模式';
    switch (ctx.mode) {
        case 'list': return '日常模式';
        case 'search': return '搜索模式';
        case 'search-all': return '全文模式';
        case 'today': return '今日模式';
        case 'week': return '本周模式';
        case 'filter': return '过滤模式';
        default: return '未知模式';
    }
}

// ---------- 用户数据持久化 ----------
async function loadUserData() {
    try {
        const data = await fs.readFile(CONFIG_FILE, 'utf8');
        const obj = JSON.parse(data);
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'meta') {
                globalMeta = value;
                if (typeof globalMeta.menuEnabled !== 'boolean') globalMeta.menuEnabled = false;
            } else if (value && typeof value === 'object' && value.token) {
                userData.set(key, {
                    token: value.token,
                    visibility: value.visibility || DEFAULT_VISIBILITY,
                    tag: value.tag || DEFAULT_TAG
                });
            }
        }
        log('info', `已加载 ${userData.size} 个用户数据`);
        log('info', `菜单状态: ${globalMeta.menuEnabled ? '开启' : '关闭'}`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            log('info', '配置文件不存在，将创建新文件');
            await saveUserData();
        } else {
            log('error', '加载配置失败:', err);
        }
    }
}

async function saveUserData() {
    try {
        const obj = {
            meta: globalMeta
        };
        for (const [key, value] of userData) {
            obj[key] = {
                token: value.token,
                visibility: value.visibility,
                tag: value.tag
            };
        }
        await fs.writeFile(CONFIG_FILE, JSON.stringify(obj, null, 2));
        log('info', '配置已保存到文件');
    } catch (err) {
        log('error', '保存配置失败:', err);
    }
}

function getUserToken(userId) {
    const user = userData.get(userId);
    return user ? user.token : null;
}

function getUserVisibility(userId) {
    const user = userData.get(userId);
    return user ? user.visibility : DEFAULT_VISIBILITY;
}

function getUserTag(userId) {
    const user = userData.get(userId);
    return user && user.tag ? user.tag : DEFAULT_TAG;
}

// ---------- 企业微信 API 工具 ----------
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
    const now = Date.now() / 1000;
    if (tokenCache.token && tokenCache.expiresAt > now + 60) return tokenCache.token;
    const url = `${PROXY_URL}/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`;
    try {
        const resp = await axios.get(url);
        if (resp.data.errcode !== 0) throw new Error(`获取 token 失败: ${JSON.stringify(resp.data)}`);
        tokenCache.token = resp.data.access_token;
        tokenCache.expiresAt = now + resp.data.expires_in;
        return tokenCache.token;
    } catch (err) {
        throw new Error(`获取 token 请求异常: ${err.message}`);
    }
}

async function sendMessage(touser, content) {
    const token = await getAccessToken();
    const url = `${PROXY_URL}/cgi-bin/message/send?access_token=${token}`;
    const payload = {
        touser: touser,
        msgtype: 'text',
        agentid: parseInt(AGENT_ID),
        text: { content }
    };
    log('debug', `准备发送消息给 ${touser}: ${content.substring(0, 50)}...`);
    const resp = await axios.post(url, payload);
    log('debug', `发送结果:`, resp.data);
    return resp.data;
}

// ---------- Memos API 工具 ----------
async function callMemosApi(method, path, token, data = null, params = {}) {
    const url = `${MEMOS_URL}${path}`;
    const headers = { 'Authorization': `Bearer ${token}` };
    if (data) headers['Content-Type'] = 'application/json';
    const resp = await axios({ method, url, data, params, headers });
    return resp.data;
}

async function handleMemosRequest(userId, apiCall) {
    const token = getUserToken(userId);
    if (!token) throw new Error('NO_TOKEN');
    try {
        return await apiCall(token);
    } catch (err) {
        if (err.response && err.response.status === 401) {
            userData.delete(userId);
            await saveUserData();
            throw new Error('TOKEN_EXPIRED');
        }
        throw err;
    }
}

async function saveTextToMemos(content, userId) {
    const token = getUserToken(userId);
    if (!token) throw new Error('NO_TOKEN');
    const visibility = getUserVisibility(userId);
    const userTag = getUserTag(userId);
    const taggedContent = `${userTag} ${content}`;
    const payload = { content: taggedContent, visibility };
    const resp = await axios.post(MEMOS_URL, payload, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    return resp.data;
}

// ---------- 动态菜单更新 ----------
async function updateWecomMenu() {
    if (NO_MENU) {
        log('info', '无菜单模式，跳过菜单更新');
        return;
    }
    const token = await getAccessToken();
    const url = `${PROXY_URL}/cgi-bin/menu/create?access_token=${token}&agentid=${AGENT_ID}`;

    let payload;
    if (globalMeta.menuEnabled) {
        payload = {
            "button": [
                {
                    "name": "时间笔记",
                    "sub_button": [
                        { "type": "click", "name": "今天笔记", "key": "today" },
                        { "type": "click", "name": "本周笔记", "key": "week" },
                        { "type": "click", "name": "随机一条", "key": "random" }
                    ]
                },
                {
                    "name": "状态信息",
                    "sub_button": [
                        { "type": "click", "name": "当前模式", "key": "mode" },
                        { "type": "click", "name": "bot信息", "key": "bot_version" },
                        { "type": "click", "name": "查看可见性", "key": "get_visibility" },
                        { "type": "click", "name": "切日常模式", "key": "exit" },
                        { "type": "click", "name": "关闭菜单", "key": "toggle_menu" }
                    ]
                },
                {
                    "name": "智能导航",
                    "sub_button": [
                        { "type": "click", "name": "上条/页", "key": "up" },
                        { "type": "click", "name": "下条/页", "key": "down" },
                        { "type": "click", "name": "纯文本", "key": "pure" },
                        { "type": "click", "name": "搜索模式", "key": "search_mode" }
                    ]
                }
            ]
        };
    } else {
        payload = {
            "button": [
                {
                    "type": "click",
                    "name": "开启菜单",
                    "key": "toggle_menu"
                }
            ]
        };
    }

    try {
        const resp = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' }
        });
        if (resp.data.errcode === 0) {
            log('info', `企业微信菜单更新成功，当前状态: ${globalMeta.menuEnabled ? '开启' : '关闭'}`);
        } else {
            log('error', '企业微信菜单更新失败:', resp.data);
        }
        return resp.data;
    } catch (err) {
        log('error', '调用企业微信API异常:', err);
        throw err;
    }
}

// ---------- 核心查询函数 ----------
async function _doList(userId, page) {
    const pageSize = 5;
    const maxFetch = 100;
    const fetchSize = Math.min(page * pageSize, maxFetch);
    const params = { pageSize: fetchSize };
    const data = await handleMemosRequest(userId, token => 
        callMemosApi('GET', '', token, null, params)
    );
    let memos = data.memos || [];
    if (memos.length === 0) return '📭 暂无备忘录。';
    const start = (page - 1) * pageSize;
    const pageMemos = memos.slice(start, start + pageSize);
    if (pageMemos.length === 0) return `📭 第 ${page} 页无内容。`;
    const totalPages = Math.ceil(memos.length / pageSize);
    const hasMore = (memos.length === maxFetch);
    userLastResults.set(userId, pageMemos);
    userCurrentIndex.delete(userId);
    userContext.set(userId, { mode: 'list', page, totalPages, pageSize, hasMore });
    
    let reply = `【日常模式】\n📋 **第 ${page} 页 / 共 ${totalPages} 页${hasMore ? '+' : ''}**\n`;
    pageMemos.forEach((m, idx) => {
        const date = new Date(m.createTime).toLocaleString('zh-CN', { hour12: false }).slice(5, 16);
        const circled = numToCircled(start + idx + 1);
        reply += `\n${circled} ${date}\n${m.content.substring(0, 30)}${m.content.length > 30 ? '…' : ''}`;
    });
    if (totalPages > 1 || hasMore) {
        reply += `\n\n使用 /up 和 /down 翻页，或 /list 页码 跳转。`;
    }
    return reply;
}

async function _doSearch(userId, keyword, page) {
    const pageSize = 10;
    const fetchSize = 100;
    const filter = `content.contains('${keyword}')`;
    const data = await handleMemosRequest(userId, token => 
        callMemosApi('GET', '', token, null, { filter, pageSize: fetchSize })
    );
    let memos = data.memos || [];
    if (memos.length === 0) return '🔍 未找到包含该关键词的备忘录。';
    const totalPages = Math.ceil(memos.length / pageSize);
    if (page > totalPages) return `❌ 页码超出范围（共 ${totalPages} 页）。`;
    const start = (page - 1) * pageSize;
    const pageMemos = memos.slice(start, start + pageSize);
    if (pageMemos.length === 0) return `📭 第 ${page} 页无内容。`;
    
    userLastResults.set(userId, pageMemos);
    userCurrentIndex.delete(userId);
    userContext.set(userId, { mode: 'search', page, totalPages, keyword, pageSize, hasMore: (memos.length === 100) });
    
    let reply = `【搜索模式】\n🔍 **“${keyword}” 搜索结果 第 ${page} 页 / 共 ${totalPages} 页**\n`;
    pageMemos.forEach((m, idx) => {
        const date = new Date(m.createTime).toLocaleString('zh-CN', { hour12: false }).slice(5, 16);
        const circled = numToCircled(start + idx + 1);
        reply += `\n${circled} ${date}\n${m.content.substring(0, 30)}${m.content.length > 30 ? '…' : ''}`;
    });
    if (totalPages > 1) {
        reply += `\n\n使用 /up 和 /down 翻页，或 /list 页码 跳转。`;
    }
    if (memos.length === 100 && page === totalPages) {
        reply += `\n\n⚠️ 可能还有更多结果，但当前仅显示前 100 条。`;
    }
    return reply;
}

async function _doSearchAll(userId, keyword, page) {
    const pageSize = 3;
    const filter = `content.contains('${keyword}')`;
    const data = await handleMemosRequest(userId, token => 
        callMemosApi('GET', '', token, null, { filter, pageSize: 100 })
    );
    const memos = data.memos || [];
    if (memos.length === 0) return '🔍 未找到包含该关键词的备忘录。';
    const totalPages = Math.ceil(memos.length / pageSize);
    if (page > totalPages) return `❌ 页码超出范围（共 ${totalPages} 页）。`;
    const start = (page - 1) * pageSize;
    const pageMemos = memos.slice(start, start + pageSize);
    
    userLastResults.set(userId, pageMemos);
    userCurrentIndex.delete(userId);
    userContext.set(userId, { mode: 'search-all', page, totalPages, keyword, pageSize, hasMore: false });
    
    let reply = `【全文模式】\n🔍 **“${keyword}” 搜索结果 第 ${page}/${totalPages} 页**\n\n`;
    pageMemos.forEach((m, idx) => {
        const date = new Date(m.createTime).toLocaleString('zh-CN', { hour12: false });
        const circled = numToCircled(start + idx + 1);
        reply += `**${circled} ${date}**\n${m.content}\n\n`;
    });
    if (totalPages > 1) {
        reply += `使用 /up 和 /down 翻页，或 /list 页码 跳转。`;
    }
    return reply;
}

// ---------- 命令处理函数 ----------
const BOT_VERSION = 'v0.8.0';

function getBotInfo() {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    return `🤖 **Memos 机器人信息**  
版本：${BOT_VERSION}  
运行时间：${hours}时${minutes}分${seconds}秒  
Node.js：${process.version}  
容器：memos-wechat-bot  
当前用户数：${userData.size}  
作者：huohen92  
GitHub：https://github.com/huohen92/memos-wechat-bot`;
}

function getBasicHelp() {
    const visibilityOptions = Object.values(visibilityDisplay).join('、');
    return `📋 **基础命令**  
/start <令牌> – 设置你的 Memos 令牌（首次使用必须执行）  
/set_visibility <${visibilityOptions}> – 修改默认可见性（支持中文，如“私有”）  
/get_visibility – 查询当前默认可见性  
/set_tag <新标签> – 设置你的默认标签（如 #我的笔记）  
/bot_version – 查看机器人版本  
/mode – 查询当前模式  
/exit – 切换到日常模式（清除状态并执行 /list）  
/bot_menu – 开启动态菜单栏（再次执行关闭），菜单2底部可切换  
/help 或 / – 显示本帮助  

**查询类**  
/list [页码] – 列出最近的备忘录  
/search <关键词> [页码] – 搜索包含关键词的备忘录  
/search_all <关键词> [页码] – 显示所有匹配备忘录的完整内容  
/today – 查看今日备忘录  
/week – 查看本周备忘录  
/filter <CEL表达式> – 高级过滤  

**智能导航**  
/view <序号> – 查看指定序号的完整内容，进入详细模式  
/up – 列表模式下翻上一页，详细模式下查看上一条  
/down – 列表模式下翻下一页，详细模式下查看下一条  
/id – 仅在详细模式下，返回当前笔记的 ID  
/pure – 仅在详细模式下，返回简洁的“创建时间+笔记原文”  

使用 /help_more 查看补充命令和模式说明。`;
}

function getMoreHelp() {
    return `📋 **补充命令**

**直接通过 ID 操作**  
/get <memoId> – 通过 ID 获取单条备忘录详情  
/update <memoId> <新内容> – 更新备忘录  
/delete <memoId> – 删除指定备忘录  
/pin <memoId> – 切换置顶状态  
/visibility <memoId> <PUBLIC/PRIVATE> – 修改可见性  

**其他**  
/stats – 统计备忘录总数（最多统计1000条）  
/tags – 列出最近50条笔记中出现的常用标签  
/random – 随机返回一条备忘录  

📌 **模式说明**  
本机器人支持以下 6 种**列表模式**（可显示多条并翻页）：  
• 日常模式：/list  
• 搜索模式：/search  
• 全文模式：/search_all  
• 今日模式：/today  
• 本周模式：/week  
• 过滤模式：/filter  

**详细模式**：使用 /view <序号> 进入，仅查看单条笔记的完整内容，此时可使用 /up、/down 浏览同列表中的上/下一条。  

📖 **列表模式 vs 详细模式**  
- 列表模式：显示多条摘要，可用 /up、/down 翻页，用 /view 进入详细模式。  
- 详细模式：显示单条完整内容，可用 /up、/down 在同列表中切换，用 /id 或 /pure 获取精简信息。`;
}

// ---------- 对外命令接口 ----------
async function cmdList(userId, args) {
    const page = args.length ? parseInt(args[0]) : 1;
    if (isNaN(page) || page < 1) return '❌ 页码必须是正整数。';
    const ctx = userContext.get(userId);
    if (ctx && (ctx.mode === 'search' || ctx.mode === 'search-all')) {
        if (ctx.mode === 'search') return await _doSearch(userId, ctx.keyword, page);
        else return await _doSearchAll(userId, ctx.keyword, page);
    }
    return await _doList(userId, page);
}

async function cmdSearch(userId, args) {
    if (!args.length) return '❌ 请指定搜索关键词。';
    const keyword = args[0];
    const page = args.length > 1 ? parseInt(args[1]) : 1;
    if (isNaN(page) || page < 1) return '❌ 页码必须是正整数。';
    return await _doSearch(userId, keyword, page);
}

async function cmdSearchAll(userId, args) {
    if (!args.length) return '❌ 请指定搜索关键词。';
    const keyword = args[0];
    const page = args.length > 1 ? parseInt(args[1]) : 1;
    if (isNaN(page) || page < 1) return '❌ 页码必须是正整数。';
    return await _doSearchAll(userId, keyword, page);
}

async function cmdToday(userId) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startTs = Math.floor(startOfDay.getTime() / 1000);
    const endTs = startTs + 86400;
    const filter = `created_ts >= ${startTs} && created_ts < ${endTs}`;
    log('debug', `/today filter: ${filter}`);
    try {
        const data = await handleMemosRequest(userId, token => 
            callMemosApi('GET', '', token, null, { filter, pageSize: 50 })
        );
        log('debug', `/today returned ${data.memos?.length || 0} memos`);
        const memos = data.memos || [];
        if (memos.length === 0) return '📭 今天还没有备忘录。';
        userLastResults.set(userId, memos);
        userCurrentIndex.delete(userId);
        userContext.set(userId, { mode: 'today', page: 1, totalPages: 1, pageSize: memos.length });
        let reply = `【今日模式】\n📋 **今日备忘录 (${memos.length}条)**\n`;
        memos.forEach((m, idx) => {
            const localDate = new Date(m.createTime);
            localDate.setHours(localDate.getHours() + 8);
            const date = localDate.toLocaleString('zh-CN', { hour12: false }).slice(5, 16);
            const circled = numToCircled(idx + 1);
            reply += `\n${circled} ${date}\n${m.content.substring(0, 50)}${m.content.length > 50 ? '…' : ''}`;
        });
        return reply;
    } catch (err) {
        log('error', '今日查询失败:', err.response?.data || err.message);
        return '❌ 查询今日备忘录失败，请稍后重试。';
    }
}

async function cmdWeek(userId) {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysToMonday);
    const startTs = Math.floor(monday.getTime() / 1000);
    const endTs = startTs + 7 * 86400;
    const filter = `created_ts >= ${startTs} && created_ts < ${endTs}`;
    log('debug', `/week filter: ${filter}`);
    try {
        const data = await handleMemosRequest(userId, token => 
            callMemosApi('GET', '', token, null, { filter, pageSize: 50 })
        );
        log('debug', `/week returned ${data.memos?.length || 0} memos`);
        const memos = data.memos || [];
        if (memos.length === 0) return '📭 本周没有备忘录。';
        userLastResults.set(userId, memos);
        userCurrentIndex.delete(userId);
        userContext.set(userId, { mode: 'week', page: 1, totalPages: 1, pageSize: memos.length });
        let reply = `【本周模式】\n📋 **本周备忘录 (${memos.length}条)**\n`;
        memos.forEach((m, idx) => {
            const localDate = new Date(m.createTime);
            localDate.setHours(localDate.getHours() + 8);
            const date = localDate.toLocaleDateString('zh-CN').slice(5);
            const circled = numToCircled(idx + 1);
            reply += `\n${circled} [${date}] ${m.content.substring(0, 50)}${m.content.length > 50 ? '…' : ''}`;
        });
        return reply;
    } catch (err) {
        log('error', '本周查询失败:', err.response?.data || err.message);
        return '❌ 查询本周备忘录失败，请稍后重试。';
    }
}

async function cmdFilter(userId, args) {
    if (!args.length) return '❌ 请提供 CEL 表达式（例如：visibility == \'PUBLIC\'）';
    const filter = args.join(' ');
    const data = await handleMemosRequest(userId, token => 
        callMemosApi('GET', '', token, null, { filter, pageSize: 50 })
    );
    const memos = data.memos || [];
    if (memos.length === 0) return '🔍 没有符合过滤条件的备忘录。';
    userLastResults.set(userId, memos);
    userCurrentIndex.delete(userId);
    userContext.set(userId, { mode: 'filter', page: 1, totalPages: 1, pageSize: memos.length });
    let reply = `【过滤模式】\n🔍 **过滤结果 (${memos.length}条)**\n`;
    memos.forEach((m, idx) => {
        const localDate = new Date(m.createTime);
        localDate.setHours(localDate.getHours() + 8);
        const date = localDate.toLocaleString('zh-CN', { hour12: false }).slice(5, 16);
        const circled = numToCircled(idx + 1);
        reply += `\n${circled} ${date}\n${m.content.substring(0, 50)}${m.content.length > 50 ? '…' : ''}`;
    });
    return reply;
}

async function cmdView(userId, args) {
    if (!args.length) return '❌ 请指定要查看的序号。';
    const idx = parseInt(args[0]) - 1;
    const memos = userLastResults.get(userId);
    if (!memos || memos.length === 0) return '❌ 没有可用的查询结果，请先执行查询命令（如 /list、/search）。';
    if (idx < 0 || idx >= memos.length) return `❌ 序号无效，有效范围 1-${memos.length}`;
    const memo = memos[idx];
    const memoId = memo.name.split('/')[1];
    const localDate = new Date(memo.createTime);
    localDate.setHours(localDate.getHours() + 8);
    const date = localDate.toLocaleString('zh-CN', { hour12: false });
    const webLink = `${MEMOS_WEB_URL}/m/${memoId}`;
    userCurrentIndex.set(userId, idx);
    let navHint = '';
    if (memos.length > 1) {
        const prevHint = idx > 0 ? ' /up 上一条' : '';
        const nextHint = idx < memos.length - 1 ? ' /down 下一条' : '';
        navHint = `\n第 ${idx+1} 条 / 共 ${memos.length} 条${prevHint}${nextHint}`;
    }
    return `🔗 网页链接：${webLink}\n\n📄 **${memoId}**  
创建时间：${date}  
可见性：${memo.visibility}  
置顶：${memo.pinned ? '是' : '否'}  
内容：\n${memo.content}${navHint}`;
}

async function cmdId(userId) {
    const currentIdx = userCurrentIndex.get(userId);
    if (currentIdx === undefined) return '❌ 当前不在详细模式，请先使用 /view <序号> 查看某条笔记。';
    const memos = userLastResults.get(userId);
    if (!memos || memos.length === 0 || currentIdx < 0 || currentIdx >= memos.length) return '❌ 无法获取当前笔记 ID，请重新执行 /view。';
    const memo = memos[currentIdx];
    const memoId = memo.name.split('/')[1];
    return memoId;
}

async function cmdPure(userId) {
    const currentIdx = userCurrentIndex.get(userId);
    if (currentIdx === undefined) return '❌ 当前不在详细模式，请先使用 /view <序号> 查看某条笔记。';
    const memos = userLastResults.get(userId);
    if (!memos || memos.length === 0 || currentIdx < 0 || currentIdx >= memos.length) return '❌ 无法获取当前笔记，请重新执行 /view。';
    const memo = memos[currentIdx];
    const localDate = new Date(memo.createTime);
    localDate.setHours(localDate.getHours() + 8);
    const date = localDate.toLocaleString('zh-CN', { hour12: false });
    return `${date}\n${memo.content}`;
}

async function cmdUp(userId) {
    const currentIdx = userCurrentIndex.get(userId);
    if (currentIdx !== undefined) {
        const memos = userLastResults.get(userId);
        if (!memos || memos.length === 0) return '❌ 没有可用的查询结果。';
        if (currentIdx <= 0) return '❌ 已经是第一条了。';
        return await cmdView(userId, [(currentIdx).toString()]);
    } else {
        const ctx = userContext.get(userId);
        if (!ctx) return '❌ 没有正在进行的查询，请先执行 /list、/search 或 /search-all。';
        const newPage = ctx.page - 1;
        if (newPage < 1) return '❌ 已经是第一页了。';
        if (ctx.mode === 'list') return await _doList(userId, newPage);
        else if (ctx.mode === 'search') return await _doSearch(userId, ctx.keyword, newPage);
        else if (ctx.mode === 'search-all') return await _doSearchAll(userId, ctx.keyword, newPage);
        else return '❌ 当前模式不支持翻页。';
    }
}

async function cmdDown(userId) {
    const currentIdx = userCurrentIndex.get(userId);
    if (currentIdx !== undefined) {
        const memos = userLastResults.get(userId);
        if (!memos || memos.length === 0) return '❌ 没有可用的查询结果。';
        if (currentIdx >= memos.length - 1) return '❌ 已经是最后一条了。';
        return await cmdView(userId, [(currentIdx + 2).toString()]);
    } else {
        const ctx = userContext.get(userId);
        if (!ctx) return '❌ 没有正在进行的查询，请先执行 /list、/search 或 /search-all。';
        const newPage = ctx.page + 1;
        if (ctx.mode === 'list') {
            const result = await _doList(userId, newPage);
            if (result.includes('📭 第 ') && result.includes('页无内容')) {
                return '❌ 已经是最后一页了。';
            }
            return result;
        } else if (ctx.mode === 'search') {
            const result = await _doSearch(userId, ctx.keyword, newPage);
            if (result.includes('📭 第 ') && result.includes('页无内容')) {
                return '❌ 已经是最后一页了。';
            }
            return result;
        } else if (ctx.mode === 'search-all') {
            const result = await _doSearchAll(userId, ctx.keyword, newPage);
            if (result.includes('📭 第 ') && result.includes('页无内容')) {
                return '❌ 已经是最后一页了。';
            }
            return result;
        } else {
            return '❌ 当前模式不支持翻页。';
        }
    }
}

async function cmdMode(userId) {
    const currentModeName = getModeDisplayName(userId);
    return `📋 当前模式：${currentModeName}\n\n可使用 /help_more 查看所有模式及说明。`;
}

async function cmdExit(userId) {
    userLastResults.delete(userId);
    userCurrentIndex.delete(userId);
    userContext.delete(userId);
    return await cmdList(userId, ['1']);
}

async function cmdSetTag(userId, args) {
    if (!args.length) return '❌ 请提供新的标签内容，例如 /set_tag #我的笔记';
    const newTag = args.join(' ').trim();
    if (!newTag) return '❌ 标签不能为空。';
    const user = userData.get(userId);
    if (!user) return '❌ 请先使用 /start 设置你的 Memos 令牌。';
    user.tag = newTag;
    userData.set(userId, user);
    await saveUserData();
    return `✅ 默认标签已设为：${newTag}`;
}

async function cmdGet(userId, args) {
    if (!args.length) return '❌ 请指定备忘录 ID（例如 /get abc123）';
    const memoId = args[0];
    const data = await handleMemosRequest(userId, token => callMemosApi('GET', `/${memoId}`, token));
    const date = new Date(data.createTime).toLocaleString('zh-CN');
    return `📄 **备忘录 ${memoId}**  
创建时间：${date}  
可见性：${data.visibility}  
置顶：${data.pinned ? '是' : '否'}  
内容：\n${data.content}`;
}

async function cmdUpdate(userId, args) {
    if (args.length < 2) return '❌ 格式：/update <memoId> <新内容>';
    const memoId = args[0];
    const newContent = args.slice(1).join(' ');
    await handleMemosRequest(userId, token => callMemosApi('PATCH', `/${memoId}`, token, { content: newContent }, { updateMask: 'content' }));
    return `✅ 备忘录 ${memoId} 已更新。`;
}

async function cmdDelete(userId, args) {
    if (!args.length) return '❌ 请指定要删除的备忘录 ID。';
    const memoId = args[0];
    await handleMemosRequest(userId, token => callMemosApi('DELETE', `/${memoId}`, token));
    return `🗑️ 备忘录 ${memoId} 已删除。`;
}

async function cmdTags(userId) {
    const data = await handleMemosRequest(userId, token => callMemosApi('GET', '', token, null, { pageSize: 50 }));
    const memos = data.memos || [];
    const tagCount = new Map();
    memos.forEach(m => {
        const tags = m.content.match(/#[a-zA-Z0-9_\u4e00-\u9fa5]+/g) || [];
        tags.forEach(t => tagCount.set(t, (tagCount.get(t) || 0) + 1));
    });
    const sorted = Array.from(tagCount.entries()).sort((a,b) => b[1] - a[1]).slice(0, 10);
    if (sorted.length === 0) return '🏷️ 最近备忘录中没有发现标签。';
    let reply = '🏷️ **常用标签**\n';
    sorted.forEach(([tag, count]) => reply += `\n${tag} (${count}次)`);
    return reply;
}

async function cmdRandom(userId) {
    const data = await handleMemosRequest(userId, token => callMemosApi('GET', '', token, null, { pageSize: 100 }));
    const memos = data.memos || [];
    if (memos.length === 0) return '📭 暂无备忘录。';
    const random = memos[Math.floor(Math.random() * memos.length)];
    return `🎲 **随机一条备忘录**\n${random.content}`;
}

async function cmdStats(userId) {
    const token = getUserToken(userId);
    if (!token) return '❌ 请先使用 /start 设置你的 Memos 令牌。';
    let count = 0;
    let pageToken = '';
    const pageSize = 100;
    let pageLimit = 10; // 最多取10页，即1000条
    try {
        while (pageLimit > 0) {
            const params = { pageSize };
            if (pageToken) params.pageToken = pageToken;
            const data = await callMemosApi('GET', '', token, null, params);
            count += (data.memos || []).length;
            if (!data.nextPageToken) break;
            pageToken = data.nextPageToken;
            pageLimit--;
        }
        if (pageLimit === 0 && count >= 1000) {
            return `📊 备忘录总数：${count}+（超过1000条，可能不完全准确）`;
        } else {
            return `📊 备忘录总数：${count}`;
        }
    } catch (err) {
        log('error', '统计失败:', err);
        return '❌ 统计失败，请稍后重试。';
    }
}

async function cmdPin(userId, args) {
    if (!args.length) return '❌ 请指定备忘录 ID。';
    const memoId = args[0];
    const memo = await handleMemosRequest(userId, token => callMemosApi('GET', `/${memoId}`, token));
    const newPinned = !memo.pinned;
    await handleMemosRequest(userId, token => callMemosApi('PATCH', `/${memoId}`, token, { pinned: newPinned }, { updateMask: 'pinned' }));
    return newPinned ? `📌 备忘录 ${memoId} 已置顶。` : `📍 备忘录 ${memoId} 已取消置顶。`;
}

async function cmdVisibility(userId, args) {
    if (args.length < 2) return '❌ 格式：/visibility <memoId> <PUBLIC|PRIVATE>';
    const memoId = args[0];
    const visibility = args[1].toUpperCase();
    if (!['PUBLIC', 'PRIVATE'].includes(visibility)) return '❌ 可见性只能是 PUBLIC 或 PRIVATE。';
    await handleMemosRequest(userId, token => callMemosApi('PATCH', `/${memoId}`, token, { visibility }, { updateMask: 'visibility' }));
    return `👁️ 备忘录 ${memoId} 可见性已设为 ${visibility}。`;
}

async function cmdSetVisibility(userId, args) {
    if (!args.length) return '❌ 请指定可见性：' + Object.values(visibilityDisplay).join('、');
    const input = args[0];
    let vis = input.toUpperCase();
    if (['PRIVATE', 'PROTECTED', 'PUBLIC'].includes(vis)) {
        // 有效英文
    } else if (visibilityMap[input]) {
        vis = visibilityMap[input];
    } else {
        return '❌ 无效的可见性，请选择：' + Object.values(visibilityDisplay).join('、');
    }
    const user = userData.get(userId);
    if (!user) return '❌ 请先使用 /start 设置你的 Memos 令牌。';
    user.visibility = vis;
    userData.set(userId, user);
    await saveUserData();
    return `✅ 默认可见性已设为 ${visibilityDisplay[vis]}`;
}

async function cmdGetVisibility(userId) {
    const user = userData.get(userId);
    if (!user) return '❌ 请先使用 /start 设置你的 Memos 令牌。';
    return `📋 你的默认可见性为：${visibilityDisplay[user.visibility]}`;
}

async function cmdBotMenu(userId) {
    if (NO_MENU) {
        return `❌ 当前为无菜单模式，动态菜单已禁用。\n如需启用，请修改环境变量 NO_MENU=false 并重新部署容器。`;
    }
    const oldState = globalMeta.menuEnabled;
    globalMeta.menuEnabled = !globalMeta.menuEnabled;
    await saveUserData();
    try {
        await updateWecomMenu();
        if (!globalMeta.menuEnabled) {
            return `✅ 动态菜单已关闭，并已同步更新。\n\n⚠️ 由于企业微信API限制，无法完全清空菜单。如需彻底关闭（不显示任何菜单），请登录企业微信管理后台 → 应用管理 → 你的自建应用 → 自定义菜单 → 手动删除所有菜单项后保存发布。`;
        } else {
            return `✅ 动态菜单已开启，并已同步更新。`;
        }
    } catch (err) {
        log('error', '更新菜单失败:', err);
        globalMeta.menuEnabled = oldState;
        await saveUserData();
        return `❌ 更新菜单失败，请查看日志。`;
    }
}

// ---------- 回调接口 ----------
app.get('/callback', (req, res) => {
    const { msg_signature, timestamp, nonce, echostr } = req.query;
    log('info', '收到 GET 验证请求');
    try {
        const decrypted = wecomCrypto.decrypt(ENCODING_AES_KEY, echostr);
        if (decrypted && decrypted.message) {
            log('info', '解密成功，返回明文');
            res.send(decrypted.message);
        } else {
            log('error', '解密失败：', decrypted);
            res.status(401).send('解密失败');
        }
    } catch (err) {
        log('error', '验证异常：', err);
        res.status(500).send('error');
    }
});

function parseXML(xml) {
    return new Promise((resolve, reject) => {
        xml2js.parseString(xml, { explicitArray: false, trim: true }, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

app.post('/callback', express.text({ type: 'text/xml' }), async (req, res) => {
    const { msg_signature, timestamp, nonce } = req.query;
    const encryptedXml = req.body;
    log('info', `收到 POST 请求，密文长度：`, encryptedXml.length);

    try {
        const parsed = await parseXML(encryptedXml);
        const encryptNode = parsed.xml?.Encrypt;
        if (!encryptNode) throw new Error('XML 中未找到 Encrypt 节点');
        const encryptedData = encryptNode;

        const decrypted = wecomCrypto.decrypt(ENCODING_AES_KEY, encryptedData);
        if (!decrypted || !decrypted.message) throw new Error('解密失败');
        log('debug', `解密后的消息：`, decrypted.message.substring(0, 200));

        const xmlData = await parseXML(decrypted.message);
        const xmlRoot = xmlData.xml;
        const fromUser = xmlRoot.FromUserName;
        const content = xmlRoot.Content;
        const msgType = xmlRoot.MsgType;

        // 处理事件消息（菜单点击）
        if (msgType === 'event') {
            const event = xmlRoot.Event;
            const eventKey = xmlRoot.EventKey;

            setImmediate(async () => {
                try {
                    let replyContent = '';
                    if (event === 'click') {
                        switch (eventKey) {
                            case 'today': replyContent = await cmdToday(fromUser); break;
                            case 'week': replyContent = await cmdWeek(fromUser); break;
                            case 'random': replyContent = await cmdRandom(fromUser); break;
                            case 'mode': replyContent = await cmdMode(fromUser); break;
                            case 'bot_version': replyContent = getBotInfo(); break;
                            case 'get_visibility': replyContent = await cmdGetVisibility(fromUser); break;
                            case 'exit': replyContent = await cmdExit(fromUser); break;
                            case 'up': replyContent = await cmdUp(fromUser); break;
                            case 'down': replyContent = await cmdDown(fromUser); break;
                            case 'pure': replyContent = await cmdPure(fromUser); break;
                            case 'toggle_menu': replyContent = await cmdBotMenu(fromUser); break;
                            case 'search_mode': replyContent = '/search <关键词> [页码]'; break;
                            default: replyContent = '未知菜单项';
                        }
                    } else {
                        log('info', `收到未处理的事件: ${event}`);
                    }
                    if (replyContent) await sendMessage(fromUser, replyContent);
                } catch (err) {
                    log('error', '处理事件消息失败:', err);
                }
            });

            res.send('success');
            return;
        }

        // 文本消息处理
        setImmediate(async () => {
            try {
                let replyContent = '';
                let extraSpaceMsg = '';

                if (content && content.startsWith('/')) {
                    const cmdMatch = content.match(/^\/([^\s]+)/);
                    if (!cmdMatch) {
                        return;
                    }
                    const cmd = cmdMatch[1].toLowerCase();
                    const rest = content.slice(cmdMatch[0].length);
                    const spaceMatch = rest.match(/^(\s+)/);
                    if (spaceMatch) {
                        const spaces = spaceMatch[1];
                        if (spaces.length > 1) {
                            extraSpaceMsg = `\n(提示：已忽略 /${cmd} 与参数之间的 ${spaces.length} 个空格)`;
                        }
                    }
                    const args = rest.trim() ? rest.trim().split(/\s+/) : [];

                    // 兼容旧版短横线命令
                    const cmdAlias = {
                        'set-tag': 'set_tag',
                        'search-all': 'search_all',
                        'help-more': 'help_more',
                        'bot-version': 'bot_version'
                    };
                    const effectiveCmd = cmdAlias[cmd] || cmd;

                    if (effectiveCmd === 'help' || effectiveCmd === '') {
                        replyContent = getBasicHelp();
                    } else if (effectiveCmd === 'help_more') {
                        replyContent = getMoreHelp();
                    } else if (effectiveCmd === 'bot_version') {
                        replyContent = getBotInfo();
                    } else if (effectiveCmd === 'mode') {
                        if (!userData.has(fromUser)) replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        else replyContent = await cmdMode(fromUser);
                    } else if (effectiveCmd === 'set_tag') {
                        if (!userData.has(fromUser)) replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        else replyContent = await cmdSetTag(fromUser, args);
                    } else if (effectiveCmd === 'set_visibility') {
                        if (!userData.has(fromUser)) replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        else replyContent = await cmdSetVisibility(fromUser, args);
                    } else if (effectiveCmd === 'get_visibility') {
                        if (!userData.has(fromUser)) replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        else replyContent = await cmdGetVisibility(fromUser);
                    } else if (effectiveCmd === 'start') {
                        if (args.length < 1) {
                            replyContent = '❌ 请提供你的 Memos 令牌。';
                        } else {
                            const token = args[0];
                            userData.set(fromUser, { token, visibility: DEFAULT_VISIBILITY, tag: DEFAULT_TAG });
                            await saveUserData();
                            replyContent = '✅ 令牌已保存，现在你可以直接发送任何文本，我会自动保存到 Memos。';
                        }
                    } else if (effectiveCmd === 'exit') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdExit(fromUser);
                        }
                    } else if (effectiveCmd === 'id') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdId(fromUser);
                        }
                    } else if (effectiveCmd === 'pure') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdPure(fromUser);
                        }
                    } else if (effectiveCmd === 'up') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdUp(fromUser);
                        }
                    } else if (effectiveCmd === 'down') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdDown(fromUser);
                        }
                    } else if (effectiveCmd === 'bot_menu') {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            replyContent = await cmdBotMenu(fromUser);
                        }
                    } else {
                        if (!userData.has(fromUser)) {
                            replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                        } else {
                            try {
                                switch (effectiveCmd) {
                                    case 'list': replyContent = await cmdList(fromUser, args); break;
                                    case 'search': replyContent = await cmdSearch(fromUser, args); break;
                                    case 'search_all': replyContent = await cmdSearchAll(fromUser, args); break;
                                    case 'today': replyContent = await cmdToday(fromUser); break;
                                    case 'week': replyContent = await cmdWeek(fromUser); break;
                                    case 'filter': replyContent = await cmdFilter(fromUser, args); break;
                                    case 'view': replyContent = await cmdView(fromUser, args); break;
                                    case 'get': replyContent = await cmdGet(fromUser, args); break;
                                    case 'update': replyContent = await cmdUpdate(fromUser, args); break;
                                    case 'delete': replyContent = await cmdDelete(fromUser, args); break;
                                    case 'stats': replyContent = await cmdStats(fromUser); break;
                                    case 'tags': replyContent = await cmdTags(fromUser); break;
                                    case 'random': replyContent = await cmdRandom(fromUser); break;
                                    case 'pin': replyContent = await cmdPin(fromUser, args); break;
                                    case 'visibility': replyContent = await cmdVisibility(fromUser, args); break;
                                    default: replyContent = '❌ 未知命令，请输入 /help 查看帮助。';
                                }
                            } catch (err) {
                                log('error', '命令执行异常:', err);
                                if (err.message === 'TOKEN_EXPIRED') {
                                    replyContent = '❌ 令牌已过期，请重新 /start 设置。';
                                } else if (err.message === 'NO_TOKEN') {
                                    replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                                } else {
                                    replyContent = `❌ 执行失败：${err.message}`;
                                }
                            }
                        }
                    }
                } else {
                    // 普通文本，保存到 Memos
                    if (!userData.has(fromUser)) {
                        replyContent = '❌ 请先使用 /start 设置你的 Memos 令牌。';
                    } else {
                        try {
                            await saveTextToMemos(content, fromUser);
                            replyContent = `✅ 已保存到 Memos：\n${content}`;
                        } catch (err) {
                            log('error', '保存失败:', err);
                            if (err.message === 'TOKEN_EXPIRED') {
                                replyContent = '❌ 令牌已过期，请重新 /start 设置。';
                            } else {
                                replyContent = '❌ 保存失败，请稍后重试。';
                            }
                        }
                    }
                }

                if (extraSpaceMsg && replyContent) {
                    replyContent += extraSpaceMsg;
                }

                if (replyContent) {
                    log('info', `准备回复给 ${fromUser}: ${replyContent.substring(0, 100)}`);
                    await sendMessage(fromUser, replyContent);
                }
            } catch (err) {
                log('error', '异步处理失败:', err);
            }
        });

        res.send('success');
    } catch (err) {
        log('error', '处理回调失败:', err);
        res.status(500).send('fail');
    }
});

// ---------- 主动发送接口 ----------
app.post('/post', async (req, res) => {
    const { touser, content } = req.body;
    if (!content) return res.status(400).json({ errcode: 400, errmsg: '缺少 content 字段' });
    const targetUser = touser || DEFAULT_TOUSER;
    try {
        const result = await sendMessage(targetUser, content);
        res.json(result);
    } catch (err) {
        log('error', '发送失败：', err.message);
        res.status(500).json({ errcode: 500, errmsg: err.message });
    }
});

app.get('/health', (req, res) => res.send('OK'));

const PORT = 3000;

// 启动前加载数据
loadUserData().catch(console.error);
if (!NO_MENU) {
    updateWecomMenu().catch(console.error);
}

app.listen(PORT, '0.0.0.0', () => {
    log('info', `Memos 企业微信机器人运行在端口 ${PORT}`);
    log('info', `主动发送接口: POST /post`);
    log('info', `回调接口:     GET/POST /callback`);
    if (NO_MENU) {
        log('info', '无菜单模式已启用，动态菜单功能已禁用');
    }
});