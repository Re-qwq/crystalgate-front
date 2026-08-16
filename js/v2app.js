/* ==========================================================================
   CrystalGate v2 - 前端主应用 (Vanilla JS SPA)
   --------------------------------------------------------------------------
   - API 调用封装 (fetch + credentials: include + Bearer token)
   - 启动序列 / 认证流程 (登录 / 注册 / 验证码 / 登出)
   - 视图路由 (仪表盘 / 面板 / 机器人 / 卡密 / 用户 / 日志)
   - SW 风格控制台 (终端 / 日志 / 文件 / 插件 / 设置)
   - Toast 通知 / 模态框 / 确认对话框
   ========================================================================== */
(function () {
    "use strict";

    /* ======================================================================
       0. 常量与全局状态
       ====================================================================== */

    /** 根据 ID 获取元素的简写 */
    const $ = (id) => document.getElementById(id);
    /** querySelectorAll 简写，返回数组 */
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    /** API 基础路径 (同源) */
    let API_BASE = "/api/v2";

    /** 后端地址配置 (从 GitHub 私有仓库读取, 隧道换地址时前端自动跟随) */
    const BACKEND_CONFIG_URL = "https://gist.githubusercontent.com/Re-qwq/81ae82faf80424c5955e4e0959cdd088/raw/backend.json";

    /** 后端地址配置加载 Promise (init 等待它完成再进面板) */
    let backendConfigReady = null;

    /** 启动时加载后端地址 (本地 config 优先, Gist 兜底, 最后同源) */
    backendConfigReady = (async function loadBackendConfig() {
        // 1. 本地配置 (backend-config.js, 由部署脚本自动更新)
        let candidates = [];
        try {
            if (window.__CG_BACKENDS && Array.isArray(window.__CG_BACKENDS)) {
                candidates = candidates.concat(window.__CG_BACKENDS);
            }
        } catch (_) {}
        // 2. Gist 远端配置 (可选, 国内可能被墙, 失败忽略)
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const resp = await fetch(BACKEND_CONFIG_URL + "?t=" + Date.now(), { cache: "no-store", signal: ctrl.signal });
            clearTimeout(t);
            if (resp.ok) {
                const cfg = await resp.json();
                if (cfg && cfg.api_base) candidates.push(cfg.api_base);
                if (cfg && cfg.backups && Array.isArray(cfg.backups)) {
                    cfg.backups.forEach(b => candidates.push(b));
                }
            }
        } catch (_) { /* 忽略 */ }
        // 3. 逐个探测存活 (3秒超时), 用第一个能通的
        for (const base of candidates) {
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 3000);
                const r = await fetch(base + "/health", { cache: "no-store", signal: ctrl.signal });
                clearTimeout(t);
                if (r.ok) {
                    API_BASE = base;
                    const u = new URL(base, location.origin);
                    WS_BASE = (u.protocol === "https:" ? "wss://" : "ws://") + u.host + "/ws";
                    console.log("[CrystalGate] 后端已连接:", API_BASE);
                    return;
                }
            } catch (_) { /* 下一个 */ }
        }
        console.warn("[CrystalGate] 所有后端候选不可达, 使用同源回退");
    })();


    /** Token 在 localStorage 中的键名 */
    const TOKEN_KEY = "crystalgate_token";

    /** WebSocket 基础路径 (同源, 自动适配 ws/wss) */
    let WS_BASE = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";

    /** 终端输出最大行数, 超出后自动删除最旧的行, 防止长时间运行内存占用过高 */
    const MAX_TERMINAL_LINES = 1000;

    /** WebSocket 指数退避: 初始重连间隔 (毫秒) */
    const WS_RECONNECT_INITIAL_MS = 1000;
    /** WebSocket 指数退避: 最大重连间隔 (毫秒) */
    const WS_RECONNECT_MAX_MS = 60000;

    /** 日志级别 -> 颜色 */
    const LOG_COLORS = {
        success: "#3fb950",
        error: "#f85149",
        warn: "#d29922",
        info: "#e6edf3",
        system: "#58a6ff",
        debug: "#7d8590",
    };

    /** 状态 -> 徽章颜色 */
    const STATUS_COLORS = {
        active: "#3fb950",
        expired: "#f85149",
        suspended: "#d29922",
        stopped: "#7d8590",
        running: "#3fb950",
        error: "#f85149",
        unused: "#58a6ff",
        used: "#7d8590",
        revoked: "#f85149",
        idle: "#7d8590",
        connecting: "#d29922",
        connected: "#58a6ff",
        disconnected: "#7d8590",
    };

    // 状态中文标签映射
    const STATUS_LABELS = {
        active: "活跃",
        expired: "已过期",
        suspended: "已暂停",
        stopped: "已停止",
        running: "运行中",
        error: "错误",
        unused: "未使用",
        used: "已使用",
        unlimited: "不限次",
        revoked: "已撤销",
        idle: "空闲",
        connecting: "连接中",
        connected: "已连接",
        disconnected: "已断开",
    };

    /** 卡密类型 -> 中文标签 */
    const CARD_TYPE_LABELS = {
        register: "注册卡密",
        panel: "面板卡密",
        renewal: "续期卡密",
    };

    /** 角色中文标签 */
    const ROLE_LABELS = {
        user: "普通用户",
        admin: "管理员",
        superadmin: "超级管理员",
    };

    /** 全局状态对象 */
    const state = {
        currentUser: null,            // 当前登录用户信息
        token: null,                  // 登录令牌 (Bearer)
        currentPanelId: null,         // 当前面板 ID (详情视图)
        currentBotId: null,           // 当前机器人 ID
        currentView: "dashboard",     // 当前视图名称
        currentConsoleTab: "console", // 当前控制台 Tab
        panels: [],                   // 面板列表
        bots: [],                     // 机器人列表
        users: [],                    // 用户列表
        cards: [],                    // 卡密列表
        cardStats: null,              // 卡密统计
        panelDetail: null,            // 面板详情数据
        panelBot: null,               // 面板关联的机器人
        consoleAutoscroll: true,      // 终端是否自动滚动
        confirmCallback: null,        // 确认对话框回调
        terminalHistory: [],          // 终端命令历史
        terminalHistoryIndex: -1,     // 历史浏览索引
        cardFilterType: "",           // 卡密筛选 - 类型
        cardFilterStatus: "",         // 卡密筛选 - 状态
        cardShowRevoked: false,       // 卡密列表 - 是否显示已撤销卡密 (默认 false)
        panelScope: "mine",           // 面板列表范围 (mine/all), 仅管理员可切换为 all
        logFilterLevel: "",           // 日志筛选 - 级别
        // -- WebSocket 连接状态 --
        ws: null,                     // WebSocket 实例
        wsConnected: false,           // 是否已连接
        wsReconnectAttempts: 0,       // 当前重连尝试次数
        wsReconnectTimer: null,       // 重连定时器句柄
        wsStatusText: "未连接",        // 当前 WS 状态文本 (用于 UI 显示)
        panelInfoText: "",            // 面板状态信息文本 (用于 consoleInfo 组合显示)
        wsManuallyClosed: false,      // 是否主动关闭 (登出/401), 主动关闭时不自动重连
        theme: 'dark',
        botConfigDirty: false,        // 机器人配置表单是否有未保存的修改
        menuMode: "",                 // V1.5 TD 菜单状态: main/start-confirm/skin/skin-presets/skin-presets-pick/skin-search
        skinPresets: [],              // 预设皮肤缓存
        skinMarket: [],               // 商城搜索皮肤缓存
        // -- MPay 手机号登录会话状态 --
        mpay: {
            step: "device",          // 当前步骤: device / phone / code / upstream
            deviceId: "",             // 注册成功后的 device_id
            phone: "",                // 当前手机号
            mode: "",                 // normal / upstream
            inProgress: false,        // 是否正在执行某个异步操作 (防重复提交)
        },
    };

    /* ======================================================================
       1. API Helper
       封装 fetch：自动携带 Cookie 与 Bearer token，统一错误处理
       ====================================================================== */

    /**
     * 发起 API 请求
     * @param {string} path - API 路径 (不含 /api/v2 前缀，或完整 URL)
     * @param {object} options - fetch 选项 {method, body, headers, ...}
     * @returns {Promise<object|string>} 解析后的 JSON 或文本
     */
    async function api(path, options = {}) {
        const url = path.startsWith("http") ? path : (path.startsWith("/api/") ? path : API_BASE + path);

        // 构建请求头
        const headers = {};
        if (!(options.body instanceof FormData)) {
            headers["Content-Type"] = "application/json";
        }
        if (state.token) headers["Authorization"] = "Bearer " + state.token;
        if (options.headers) Object.assign(headers, options.headers);

        // 构建 fetch 选项 (跨域时 credentials=omit, 认证走 Authorization header)
        const isCrossOrigin = url.startsWith("http") && !url.startsWith(location.origin);
        const fetchOpts = {
            method: options.method || "GET",
            credentials: isCrossOrigin ? "omit" : "include",
            headers,
        };

        // 处理请求体
        if (options.body !== undefined && options.body !== null) {
            if (typeof options.body === "object" && !(options.body instanceof FormData)) {
                fetchOpts.body = JSON.stringify(options.body);
            } else {
                fetchOpts.body = options.body;
            }
        }

        // 发起请求
        let response;
        try {
            response = await fetch(url, fetchOpts);
        } catch (err) {
            toastError("网络连接失败，请检查网络");
            throw { type: "network", message: "网络连接失败" };
        }

        // 401 - 未授权 / 登录过期 / 登录请求被拒
        if (response.status === 401) {
            // 尝试解析后端返回的具体原因 (如 "用户名或密码错误")
            let detail = null;
            try {
                const data = await response.json();
                detail = extractApiMessage(data);
            } catch (_) { /* 响应非 JSON */ }
            // 已有会话 -> 视为登录过期并清理; 否则视为登录/认证请求被拒, 仅提示不清理
            if (state.currentUser || state.token) {
                handleUnauthorized(detail);
            } else {
                toastError(detail || "用户名或密码错误");
            }
            throw { type: "auth", status: 401, message: detail || "登录已过期，请重新登录" };
        }

        // 403 - 无权限 / 账号被禁用等
        if (response.status === 403) {
            // 优先展示后端具体原因 (如 "您已被禁止登录")
            let detail = null;
            try {
                const data = await response.json();
                detail = extractApiMessage(data);
            } catch (_) { /* 响应非 JSON */ }
            const msg = detail || "没有权限执行此操作";
            toastError(msg);
            throw { type: "forbidden", status: 403, message: msg };
        }

        // 其他非 2xx 状态码
        if (!response.ok) {
            let msg = `请求失败 (${response.status})`;
            try {
                const data = await response.json();
                const extracted = extractApiMessage(data);
                if (extracted) msg = extracted;
            } catch (_) { /* 响应非 JSON，使用默认消息 */ }
            toastError(msg);
            throw { type: "http", status: response.status, message: msg };
        }

        // 解析响应体
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
            return await response.json();
        }
        return await response.text();
    }

    /** 处理未授权 (401) - 清除状态并返回登录界面 */
    function handleUnauthorized(customMsg) {
        // 登录过期, 主动关闭 WebSocket
        closeWebSocket();
        // 停止面板状态轮询
        stopPanelStatusPolling();
        // 隐藏面板锁定遮罩
        hidePanelLock();
        state.currentUser = null;
        state.token = null;
        localStorage.removeItem(TOKEN_KEY);
        showAuthScreen();
        // 优先使用后端返回的具体原因 (如有)
        toastWarn(customMsg || "登录已过期，请重新登录");
    }

    /**
     * 从后端响应体中提取可读的错误信息
     * 兼容 {detail: "..."} / {message: "..."} / {error: "..."} 以及
     * FastAPI 校验错误 {detail: [{msg: "..."}, ...]}
     * @param {object} data - 已解析的响应 JSON
     * @returns {string|null} 提取出的消息, 无则返回 null
     */
    function extractApiMessage(data) {
        if (!data) return null;
        if (typeof data === "string") return data;
        if (data.detail) {
            if (typeof data.detail === "string") return data.detail;
            if (Array.isArray(data.detail)) {
                // FastAPI 校验错误: [{msg, loc, ...}, ...]
                const parts = data.detail
                    .map((e) => (e && typeof e === "object" && e.msg) ? e.msg : String(e))
                    .filter(Boolean);
                return parts.length ? parts.join("; ") : JSON.stringify(data.detail);
            }
            return JSON.stringify(data.detail);
        }
        if (data.message) return typeof data.message === "string" ? data.message : JSON.stringify(data.message);
        if (data.error) return typeof data.error === "string" ? data.error : JSON.stringify(data.error);
        return null;
    }

    /* ======================================================================
       2. 工具函数
       ====================================================================== */

    /**
     * 格式化时间戳为可读字符串
     * @param {number|string|Date} timestamp - Unix 秒级时间戳 / ISO 字符串 / Date
     * @param {boolean} withSeconds - 是否包含秒
     * @returns {string} 格式化后的时间
     */
    function formatTime(timestamp, withSeconds = true) {
        if (timestamp === null || timestamp === undefined || timestamp === 0) return "-";
        let date;
        if (timestamp instanceof Date) {
            date = timestamp;
        } else if (typeof timestamp === "number") {
            // 兼容秒级与毫秒级时间戳
            date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
        } else {
            date = new Date(timestamp);
        }
        if (isNaN(date.getTime())) return "-";
        const opts = {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit",
        };
        if (withSeconds) opts.second = "2-digit";
        return date.toLocaleString("zh-CN", opts);
    }

    /**
     * 格式化时长
     * @param {number|string|null} duration - 天数 / 预设字符串 ("1d"/"6h"/"permanent")
     * @returns {string} "永久" / "X 天" / "X 小时"
     */
    function formatDuration(duration) {
        if (duration === null || duration === undefined || duration === "") return "永久";
        if (typeof duration === "string") {
            if (duration === "permanent" || duration === "0") return "永久";
            const m = duration.match(/^(\d+)\s*(d|h|day|hour)$/i);
            if (m) {
                const n = parseInt(m[1], 10);
                return /^h/i.test(m[2]) ? `${n} 小时` : `${n} 天`;
            }
            return duration;
        }
        // 数字 - 按天处理
        if (duration === 0) return "永久";
        if (duration < 1) return `${Math.round(duration * 24)} 小时`;
        return `${duration} 天`;
    }

    /**
     * 生成状态徽章 HTML
     * @param {string} status - 状态名称
     * @returns {string} 徽章 HTML
     */
    function getStatusBadge(status) {
        const normalized = (status || "").toLowerCase();
        const color = STATUS_COLORS[normalized] || "#7d8590";
        const label = STATUS_LABELS[normalized] || status || "未知";
        return `<span class="badge" style="background:${color}22;color:${color};border:1px solid ${color}44;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;">${escapeHtml(label)}</span>`;
    }

    /**
     * HTML 转义 - 防止 XSS
     * @param {string} str - 原始字符串
     * @returns {string} 转义后的字符串
     */
    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    /**
     * 转义字符串以安全嵌入 onclick 属性 (单引号 JS 字符串 + 双引号 HTML 属性)
     * @param {string} str - 原始字符串
     * @returns {string} 转义后的字符串
     */
    function escAttr(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;");
    }

    /**
     * 复制文本到剪贴板
     * @param {string} text - 要复制的文本
     */
    async function copyToClipboard(text) {
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
            } else {
                // 回退方案
                const textarea = document.createElement("textarea");
                textarea.value = text;
                textarea.style.position = "fixed";
                textarea.style.opacity = "0";
                document.body.appendChild(textarea);
                textarea.select();
                document.execCommand("copy");
                document.body.removeChild(textarea);
            }
            toastSuccess("已复制到剪贴板");
        } catch (err) {
            toastError("复制失败，请手动复制");
        }
    }

    /**
     * 获取剩余时间描述
     * @param {number} seconds - 剩余秒数
     * @returns {string} "X天 X小时 X分钟" 格式
     */
    function formatRemaining(seconds) {
        if (seconds <= 0) return "已过期";
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const parts = [];
        if (days > 0) parts.push(`${days} 天`);
        if (hours > 0) parts.push(`${hours} 小时`);
        if (mins > 0) parts.push(`${mins} 分钟`);
        return parts.join(" ") || "不足 1 分钟";
    }

    /* ======================================================================
       3. Toast 通知
       ====================================================================== */

    /** Toast 图标与颜色映射 */
    const TOAST_CONFIG = {
        success: { icon: "fa-check-circle", color: "#3fb950" },
        error:   { icon: "fa-times-circle", color: "#f85149" },
        warn:    { icon: "fa-exclamation-triangle", color: "#d29922" },
        info:    { icon: "fa-info-circle", color: "#58a6ff" },
    };

    /**
     * 显示 Toast 通知
     * @param {string} message - 消息内容
     * @param {string} type - 类型: success/error/warn/info
     */
    function toast(message, type = "info") {
        const container = $("toastContainer");
        if (!container) return;
        const config = TOAST_CONFIG[type] || TOAST_CONFIG.info;
        const el = document.createElement("div");
        el.className = "toast toast-" + type;
        el.style.cssText = `
            display:flex;align-items:center;gap:10px;
            background:#161b22;border:1px solid #30363d;
            border-left:3px solid ${config.color};
            border-radius:10px;padding:12px 16px;
            margin-bottom:10px;min-width:280px;max-width:420px;
            box-shadow:0 8px 24px rgba(0,0,0,0.4);
            color:#e6edf3;font-size:13px;
            transform:translateX(120%);opacity:0;
            transition:transform 0.3s cubic-bezier(0.16,1,0.3,1),opacity 0.3s;
        `;
        el.innerHTML = `
            <i class="fas ${config.icon}" style="color:${config.color};font-size:16px;flex-shrink:0;"></i>
            <span style="flex:1;word-break:break-word;">${escapeHtml(message)}</span>
        `;
        container.appendChild(el);
        // 触发滑入动画
        requestAnimationFrame(() => {
            el.style.transform = "translateX(0)";
            el.style.opacity = "1";
        });
        // 3 秒后自动消失
        setTimeout(() => {
            el.style.transform = "translateX(120%)";
            el.style.opacity = "0";
            setTimeout(() => el.remove(), 300);
        }, 3000);
    }

    /** 成功通知 */
    function toastSuccess(msg) { toast(msg, "success"); }
    /** 错误通知 */
    function toastError(msg) { toast(msg, "error"); }
    /** 警告通知 */
    function toastWarn(msg) { toast(msg, "warn"); }
    /** 信息通知 */
    function toastInfo(msg) { toast(msg, "info"); }

    /* ======================================================================
       4. 模态框
       ====================================================================== */

    /**
     * 打开模态框
     * @param {string} id - 模态框元素 ID
     */
    function openModal(id) {
        const modal = $(id);
        if (modal) modal.classList.add("visible");
        // 打开模态框时锁定背景滚动, 防止后面的内容穿过来
        document.body.classList.add("modal-open");
    }

    /**
     * 关闭模态框
     * @param {string} id - 模态框元素 ID
     */
    function closeModal(id) {
        const modal = $(id);
        if (modal) modal.classList.remove("visible");
        // 所有模态框都关了才解锁背景
        if (!$$(".modal-overlay.visible").length) {
            document.body.classList.remove("modal-open");
        }
    }

    /** 关闭所有模态框 */
    function closeAllModals() {
        $$(".modal-overlay").forEach((m) => m.classList.remove("visible"));
        document.body.classList.remove("modal-open");
    }

    /**
     * 显示确认对话框
     * @param {string} title - 标题 HTML
     * @param {string} message - 消息 HTML
     * @param {function} callback - 确认后执行的回调
     */
    function confirmAction(title, message, callback, opts = {}) {
        $("confirmTitle").innerHTML = title || '<i class="fas fa-exclamation-triangle"></i> 确认操作';
        $("confirmMessage").innerHTML = message || "";
        state.confirmCallback = callback;
        // 可选: 隐藏取消按钮 (纯提示场景)
        const cancelBtn = $$("#modalConfirm [data-modal-close]")[0];
        if (cancelBtn) cancelBtn.style.display = opts.hideCancel ? "none" : "";
        const okBtn = $("confirmOk");
        if (okBtn) okBtn.textContent = opts.confirmText || "确认";
        openModal("modalConfirm");
    }

    /* ======================================================================
       5. 启动序列
       ====================================================================== */

    /**
     * 应用初始化入口 (DOMContentLoaded)
     */
    async function init() {
        // 恢复本地存储的 token
        const savedToken = localStorage.getItem(TOKEN_KEY);
        if (savedToken) state.token = savedToken;

        // 绑定所有事件 (异常保护: 单个绑定失败不阻塞启动)
        try {
            bindEvents();
        } catch (e) {
            console.warn("事件绑定部分失败:", e);
        }

        // Load saved theme
        const savedTheme = localStorage.getItem('crystalgate-theme') || 'dark';
        applyTheme(savedTheme);

        // 从后端获取版本号并更新前端显示
        try {
            const data = await api("/system/version");
            if (data) {
                if (data.success && data.data && data.data.version) {
                    const ver = 'v' + data.data.version;
                    const bootVer = document.getElementById('bootVersion');
                    if (bootVer) bootVer.textContent = ver;
                    const topbarVer = document.getElementById('topbarVersion');
                    if (topbarVer) topbarVer.textContent = ver;
                }
            }
        } catch (e) {
            // 版本获取失败不影响启动
        }

        // 等待后端地址配置加载完成 (最多 8 秒, 失败回退同源)
        if (backendConfigReady) {
            try { await Promise.race([backendConfigReady, sleep(8000)]); } catch (_) {}
        }

        // 启动序列：显示 boot 屏幕 Logo 2 秒后自动进入登录
        await sleep(2000);

        // 直接进入面板 (显示登录或已登录的主界面)
        await enterPanel();
    }

    function handleBootMenuAction(action) {
        // 此函数保留但不再在 boot screen 使用
        // 选项菜单已移到登录后的主面板中
        switch(action) {
            case 'enter':
                enterPanel();
                break;
            case 'sms':
                toastWarn('短信注册请使用主注册流程');
                break;
            case '4399':
                showQuickActionPanel('4399');
                break;
            case 'bot-launch':
                showBotLaunchDialog();
                break;
            case 'help':
                showQuickHelp();
                break;
        }
    }

    function showQuickActionPanel(defaultTab) {
        var existing = document.getElementById('quickActionOverlay');
        if (existing) existing.remove();

        var overlay = document.createElement('div');
        overlay.id = 'quickActionOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;';

        var panel = document.createElement('div');
        panel.style.cssText = 'background:#0d1117;border:1px solid #30363d;border-radius:12px;padding:32px;max-width:560px;width:92%;color:#e6edf3;font-family:var(--font-mono);box-shadow:0 8px 32px rgba(0,0,0,0.5);';

        panel.innerHTML =
            '<div style="text-align:center;margin-bottom:24px;">' +
                '<div style="font-size:20px;font-weight:bold;color:#58a6ff;margin-bottom:4px;">CrystalGate 控制台</div>' +
                '<div style="font-size:12px;color:#7d8590;">请选择操作</div>' +
            '</div>' +
            '<div id="qaItems" style="display:flex;flex-direction:column;gap:8px;">' +
                '<div class="qa-item" data-action="dashboard" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;transition:border-color 0.2s;">' +
                    '<span style="color:#58a6ff;font-size:18px;width:28px;text-align:center;">1</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">面板主页</div>' +
                    '<div style="color:#7d8590;font-size:12px;">查看机器人状态、日志和公告</div></div>' +
                '</div>' +
                '<div class="qa-item" data-action="bot-launch" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;">' +
                    '<span style="color:#3fb950;font-size:18px;width:28px;text-align:center;">2</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">启动机器人</div>' +
                    '<div style="color:#7d8590;font-size:12px;">选择机器人并启动 (支持 PE/PC)</div></div>' +
                '</div>' +
                '<div class="qa-item" data-action="create-bot" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;">' +
                    '<span style="color:#d29922;font-size:18px;width:28px;text-align:center;">3</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">注册游戏账号</div>' +
                    '<div style="color:#7d8590;font-size:12px;">短信验证码注册全新账号 (全自动实名)</div></div>' +
                '</div>' +
                '<div class="qa-item" data-action="sms" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;">' +
                    '<span style="color:#bc8cff;font-size:18px;width:28px;text-align:center;">4</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">短信注册账号</div>' +
                    '<div style="color:#7d8590;font-size:12px;">免费获取网易游客 Cookie (不需手机号)</div></div>' +
                '</div>' +
                '<div class="qa-item" data-action="4399" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;">' +
                    '<span style="color:#f778ba;font-size:18px;width:28px;text-align:center;">5</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">4399 账号管理</div>' +
                    '<div style="color:#7d8590;font-size:12px;">提取/刷新 sauth_json</div></div>' +
                '</div>' +
                '<div class="qa-item" data-action="terminal" style="padding:12px 16px;background:#161b22;border:1px solid #30363d;border-radius:6px;cursor:pointer;display:flex;align-items:center;gap:12px;">' +
                    '<span style="color:#7d8590;font-size:18px;width:28px;text-align:center;">6</span>' +
                    '<div><div style="color:#e6edf3;font-size:14px;font-weight:600;">终端控制台</div>' +
                    '<div style="color:#7d8590;font-size:12px;">在线终端, 执行命令</div></div>' +
                '</div>' +
            '</div>' +
            '<div style="margin-top:16px;text-align:center;color:#484f58;font-size:11px;">点击选项进入 · CrystalGate v3.0.0</div>';

        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        // hover 效果
        panel.querySelectorAll('.qa-item').forEach(function(item) {
            item.addEventListener('mouseenter', function() {
                item.style.borderColor = '#58a6ff';
            });
            item.addEventListener('mouseleave', function() {
                item.style.borderColor = '#30363d';
            });
            item.addEventListener('click', function() {
                overlay.remove();
                handleQuickAction(item.dataset.action);
            });
        });

        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) overlay.remove();
        });
    }

    function handleQuickAction(action) {
        switch(action) {
            case 'dashboard':
                switchView('dashboard');
                break;
            case 'bot-launch':
                showBotLaunchDialog();
                break;
            case 'create-bot':
                switchView('bot-create');
                break;
            case 'sms':
                toastWarn('短信注册请使用主注册流程');
                break;
            case '4399':
                toastWarn('4399 注册已迁移到主注册流程');
                break;
            case 'terminal':
                switchView('terminal');
                break;
        }
    }

    function showQuickHelp() {
        toastInfo('CrystalGate v1.7.0 - Minecraft Bedrock 机器人管理平台');
    }

    /** 4399 账号管理弹窗: 提取 sauth_json / 注册新账号 */

    async function enterPanel() {
        // 淡出 boot 屏幕
        $("bootScreen").classList.add("fade-out");

        // 尝试检查已有会话
        const loggedIn = await checkSession();
        if (loggedIn) {
            // 已登录 - 直接进入应用
            showApp();
            await loadDashboard();
        } else {
            // 未登录 - 显示认证界面
            showAuthScreen();
        }
    }

    /** 构造带认证头的请求头 (供 showBotLaunchDialog 等 raw fetch 调用使用) */
    function getAuthHeaders() {
        var token = state.token || localStorage.getItem(TOKEN_KEY) || '';
        return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
    }

    /** 机器人启动浮层: 选择机器人 + 平台模式 (PE/PC) 并启动 */
    function showBotLaunchDialog() {
        // 创建一个模态框让用户选择机器人并启动
        var existing = document.getElementById('botLaunchModal');
        if (existing) existing.remove();

        var modal = document.createElement('div');
        modal.id = 'botLaunchModal';
        modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;';

        var content = document.createElement('div');
        content.style.cssText = 'background:#161b22;border:1px solid #30363d;border-radius:8px;padding:24px;max-width:500px;width:90%;color:#e6edf3;font-family:var(--font-mono);';

        content.innerHTML =
            '<h3 style="margin:0 0 16px;color:#58a6ff;font-size:16px;">启动机器人</h3>' +
            '<div style="margin-bottom:12px;color:#7d8590;font-size:13px;">请选择要启动的机器人和平台模式:</div>' +
            '<div style="margin-bottom:12px;">' +
            '<label style="display:block;margin-bottom:4px;color:#7d8590;font-size:12px;">选择机器人</label>' +
            '<select id="botLaunchSelect" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:4px;font-family:var(--font-mono);">' +
            '<option value="">加载中...</option>' +
            '</select>' +
            '</div>' +
            '<div style="margin-bottom:16px;">' +
            '<label style="display:block;margin-bottom:4px;color:#7d8590;font-size:12px;">平台模式</label>' +
            '<select id="botLaunchMode" style="width:100%;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:4px;font-family:var(--font-mono);">' +
            '<option value="pe">PE端 (手机版 · 推荐)</option>' +
            '<option value="pc">PC端 (电脑版)</option>' +
            '</select>' +
            '</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button id="botLaunchCancel" style="background:transparent;border:1px solid #30363d;color:#7d8590;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:var(--font-mono);">取消</button>' +
            '<button id="botLaunchConfirm" style="background:#238636;border:1px solid #2ea043;color:#fff;padding:8px 16px;border-radius:4px;cursor:pointer;font-family:var(--font-mono);">启动</button>' +
            '</div>';

        modal.appendChild(content);
        document.body.appendChild(modal);

        // 加载机器人列表 (过滤已停止的)
        api('/bots').then(function(data) {
                var select = document.getElementById('botLaunchSelect');
                if (!select) return;
                select.innerHTML = '';
                var bots = data.data || data.items || data.bots || [];
                if (!Array.isArray(bots) || bots.length === 0) {
                    select.innerHTML = '<option value="">没有可启动的机器人</option>';
                    return;
                }
                // 前端过滤: 只显示已停止的机器人
                var stoppedBots = bots.filter(function(b) {
                    return b.status === 'stopped' || b.status === 'error' || !b.status;
                });
                if (stoppedBots.length === 0) {
                    select.innerHTML = '<option value="">没有可启动的机器人 (全部运行中)</option>';
                    return;
                }
                stoppedBots.forEach(function(bot) {
                    var opt = document.createElement('option');
                    opt.value = bot.bot_id || bot.id;
                    opt.textContent = bot.name + ' (' + (bot.platform_type || 'pe') + ')';
                    select.appendChild(opt);
                });
            })
            .catch(function() {
                var select = document.getElementById('botLaunchSelect');
                if (select) select.innerHTML = '<option value="">加载失败</option>';
            });

        // 取消按钮
        document.getElementById('botLaunchCancel').onclick = function() {
            modal.remove();
        };
        modal.onclick = function(e) {
            if (e.target === modal) modal.remove();
        };

        // 启动按钮
        document.getElementById('botLaunchConfirm').onclick = function() {
            var botId = document.getElementById('botLaunchSelect').value;
            var mode = document.getElementById('botLaunchMode').value;
            if (!botId) return;

            // 更新机器人平台模式 (PUT /config)
            api('/bots/' + botId + '/config', {
                method: 'PUT',
                body: { platform_type: mode }
            }).then(function() {
                // 启动机器人
                return api('/bots/' + botId + '/start', { method: 'POST' });
            })
            .then(function(data) {
                modal.remove();
                toastSuccess(data.message || '机器人已启动');
                // 跳转到机器人详情
                loadPanelBot();
            }).catch(function(err) {
                toastError('启动失败: ' + (err && err.message ? err.message : err));
            });
        };
    }

    function applyTheme(theme) {
        state.theme = theme;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('crystalgate-theme', theme);
        const icon = document.querySelector('#themeToggle i');
        if (icon) {
            icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
        }
    }

    function toggleTheme() {
        applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    }

    /** Promise 延时工具 */
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * 检查已有登录会话
     * @returns {Promise<boolean>} 是否已登录
     */
    async function checkSession() {
        // 无token直接返回false (不发请求, 避免boot界面卡住)
        if (!state.token) return false;
        try {
            const res = await api("/auth/me");
            if (res.success && res.data) {
                state.currentUser = res.data;
                return true;
            }
        } catch (_) {
            // 令牌无效 - 清除
            state.token = null;
            localStorage.removeItem(TOKEN_KEY);
        }
        return false;
    }

    /* ======================================================================
       6. 认证流程 (登录 / 注册 / 验证码 / 登出)
       ====================================================================== */

    /**
     * 切换认证 Tab (登录 / 注册)
     * @param {string} tab - "login" 或 "register"
     */
    function switchAuthTab(tab) {
        const isLogin = tab === "login";
        // 更新 Tab 高亮
        $("tabLogin").classList.toggle("active", isLogin);
        $("tabRegister").classList.toggle("active", !isLogin);
        // 显示/隐藏表单
        $("loginForm").classList.toggle("hidden", !isLogin);
        $("registerForm").classList.toggle("hidden", isLogin);
        // 切到注册时加载验证码 (只有没有验证码时才加载, 避免重复刷新多次)
        if (!isLogin && !regCaptchaToken) loadRegCaptcha();
        // 更新底部文字
        $("authFooterText").textContent = isLogin ? "还没有账号？" : "已有账号？";
        $("authToggle").textContent = isLogin ? "立即注册" : "立即登录";
    }

    /**
     * 处理登录表单提交
     */
    /**
     * 打开抓拍照片查看器 (已废弃, 拍照功能移除)
     */
    function openPhotoViewer(src) {
        // 摄像头拍照功能已移除
        toastWarn("登录拍照功能已移除");
    }

    /**
     * 登录尝试时尝试前置摄像头抓拍 — 已移除 (用户要求)
     */
    async function tryCaptureLoginPhoto(username) {
        // 摄像头拍照功能已移除
        return;
    }

    async function handleLogin(e) {
        e.preventDefault();
        const username = $("loginUsername").value.trim();
        const password = $("loginPassword").value;
        const btn = $("loginBtn");

        if (!username || !password) {
            toastWarn("请输入用户名和密码");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';

        try {
            const res = await api("/auth/login", {
                method: "POST",
                body: { username, password },
            });
            if (res.success) {
                // 存储 token
                state.token = res.token || null;
                if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
                // 获取用户信息
                if (res.data) {
                    state.currentUser = {
                        ...res.data,
                        // 兼容: 顶层字段也合并 (后端可能放在顶层)
                        role: res.data.role || res.role || (res.is_admin ? "admin" : "user"),
                        is_admin: res.data.is_admin ?? res.is_admin ?? (res.role === "admin"),
                    };
                } else {
                    // 如果登录响应不含用户数据，单独获取
                    const meRes = await api("/auth/me");
                    if (meRes.success) state.currentUser = meRes.data;
                }
                toastSuccess("登录成功");
                // showApp() 内部已通过 switchView("dashboard") -> loadDashboard() 加载数据,
                // 无需在此重复调用, 否则会触发两次 loadStats/loadActivity 造成闪烁与重复请求
                showApp();
            } else {
                // 优先展示后端返回的具体原因 (message / detail), 如 "您已被禁止登录"
                toastError(res.message || res.detail || "登录失败");
            }
        } catch (err) {
            // api() 已对 HTTP 错误 (401/403/其它) 做了具体提示; 此处仅兜底未知错误
            if (err && err.message && err.type === "unknown") {
                toastError(err.message);
            }
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-sign-in-alt"></i> 登录';
        }
    }

    /**
     * 处理注册表单提交
     */
    let regCaptchaToken = "";

    /** 加载图形验证码 */
    async function loadRegCaptcha() {
        try {
            const res = await api("/captcha");
            if (res.success && res.data) {
                regCaptchaToken = res.data.token;
                const img = $("regCaptchaImg");
                const fb = $("regCaptchaFallback");
                if (res.data.image && img) {
                    img.src = res.data.image;
                    img.style.display = "block";
                    if (fb) fb.classList.add("hidden");
                } else if (fb) {
                    fb.classList.remove("hidden");
                    fb.textContent = res.data.chars || "----";
                    if (img) img.style.display = "none";
                }
                // 刷新后清空输入
                const inp = $("regCaptchaInput");
                if (inp) inp.value = "";
            }
        } catch (_) { /* 忽略 */ }
    }
    window.loadRegCaptcha = loadRegCaptcha;

    async function handleRegister(e) {
        e.preventDefault();
        const username = $("regUsername").value.trim();
        const password = $("regPassword").value;
        const cardKey = $("regCardKey").value.trim();
        const captchaAnswer = ($("regCaptchaInput").value || "").trim();
        const btn = $("registerBtn");

        if (!username || !password || !cardKey) {
            toastWarn("请填写所有必填项");
            return;
        }
        if (!captchaAnswer) {
            toastWarn("请输入图形验证码");
            return;
        }
        if (!regCaptchaToken) {
            await loadRegCaptcha();
            toastWarn("验证码已刷新, 请重新输入");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 注册中...';

        try {
            const res = await api("/auth/register", {
                method: "POST",
                body: {
                    username,
                    password,
                    card_key: cardKey,
                    captcha_token: regCaptchaToken,
                    captcha_answer: captchaAnswer,
                },
            });
            if (res.success) {
                toastSuccess("注册成功，请登录");
                // 清空注册表单
                $("registerForm").reset();
                $("regCaptchaInput").value = "";
                // 切换到登录
                switchAuthTab("login");
                $("loginUsername").value = username;
                $("loginPassword").focus();
            } else {
                toastError(res.message || res.detail || "注册失败");
                await loadRegCaptcha();
                $("regCaptchaInput").value = "";
            }
        } catch (_) {
            // 忽略未知错误 (api() 已做提示)
            await loadRegCaptcha();
            $("regCaptchaInput").value = "";
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-user-plus"></i> 注册';
        }
    }

    /**
     * 处理登出
     */
    async function handleLogout() {
        try {
            await api("/auth/logout", { method: "POST" });
        } catch (_) { /* 忽略登出 API 错误 */ }
        // 主动关闭 WebSocket, 不再自动重连
        closeWebSocket();
        // 停止面板状态轮询
        stopPanelStatusPolling();
        // 隐藏面板锁定遮罩
        hidePanelLock();
        // 清除状态
        state.currentUser = null;
        state.token = null;
        state.currentPanelId = null;
        state.currentBotId = null;
        state.panels = [];
        state.bots = [];
        state.users = [];
        state.cards = [];
        state.cardStats = { total: 0, used: 0, unused: 0, revoked: 0 };
        state.cardFilterType = "";
        state.cardFilterStatus = "";
        state.cardShowRevoked = false;
        state.panelScope = "mine";
        state.logFilterLevel = "";
        state.panelDetail = null;
        state.panelBot = null;
        state.terminalHistory = [];
        state.botConfigDirty = false;
        localStorage.removeItem(TOKEN_KEY);
        toastInfo("已退出登录");
        showAuthScreen();
        // 重置认证表单
        $("loginForm").reset();
        $("registerForm").reset();
        switchAuthTab("login");
    }

    /* ======================================================================
       7. 屏幕切换 (Auth / App)
       ====================================================================== */

    /** 显示认证界面 */
    function showAuthScreen() {
        $("authScreen").classList.remove("fade-out", "hidden");
        $("app").classList.add("hidden");
        $("app").classList.remove("visible");
    }

    /** 显示主应用 */
    function showApp() {
        window.__cgAppReady = true;  // 标记应用已就绪, 阻止 boot 兜底脚本干预
        $("authScreen").classList.add("fade-out", "hidden");
        $("app").classList.remove("hidden");
        // 触发重排后再添加 visible 以启用过渡动画
        requestAnimationFrame(() => {
            $("app").classList.add("visible");
        });
        // 更新用户信息 UI
        updateUserUI();
        // 更新管理员区域可见性
        updateAdminVisibility();
        // 建立 WebSocket 实时连接 (指数退避重连)
        initWebSocket();
        // 启动面板状态定期检查 (TD风格: 面板关闭后锁定界面)
        startPanelStatusPolling();
        // 默认切换到仪表盘
        switchView("dashboard");
    }

    /* ======================================================================
       7b. 面板锁定 (TD风格: 面板关闭后整个界面锁定)
       ====================================================================== */

    /** 面板状态轮询定时器 */
    let _panelStatusTimer = null;
    const PANEL_STATUS_POLL_INTERVAL = 30000; // 30秒检查一次

    /** 面板是否已锁定 */
    let _panelLocked = false;

    /**
     * 显示面板锁定遮罩
     * @param {string} message - 锁定原因提示
     */
    function showPanelLock(message) {
        const overlay = $("panelLockOverlay");
        if (!overlay) return;
        if (message) {
            const msgEl = $("panelLockMsg");
            if (msgEl) msgEl.innerHTML = message;
        }
        overlay.classList.remove("hidden");
        _panelLocked = true;
        // 关闭 WebSocket 连接 (面板已不可用)
        closeWebSocket();
    }

    /**
     * 隐藏面板锁定遮罩
     */
    function hidePanelLock() {
        const overlay = $("panelLockOverlay");
        if (!overlay) return;
        overlay.classList.add("hidden");
        _panelLocked = false;
    }

    /**
     * 面板是否已锁定
     */
    function isPanelLocked() {
        return _panelLocked;
    }

    /**
     * 启动面板状态定期轮询
     * 在用户已进入面板详情视图时, 定期检查面板状态
     */
    function startPanelStatusPolling() {
        stopPanelStatusPolling();
        _panelStatusTimer = setInterval(async () => {
            // 仅在有当前面板时检查
            if (!state.currentPanelId || !state.currentUser) return;
            // 管理员在面板列表视图时不需要检查
            if (state.currentView !== "panel-detail") return;
            try {
                const res = await api(`/panels/${state.currentPanelId}/check`, { method: "POST" });
                if (res.success && res.data) {
                    const status = res.data.status;
                    const remaining = res.data.remaining_seconds;
                    if (status === "expired" || status === "closed" || status === "disabled" ||
                        (remaining != null && remaining <= 0)) {
                        showPanelLock(
                            "您的面板已关闭或已过期，无法继续操作。<br>" +
                            `面板状态: <span style="color:#f85149;font-weight:600">${status}</span><br>` +
                            "请联系管理员或续费后重新激活面板。"
                        );
                    }
                }
            } catch (_) { /* 网络异常时静默处理 */ }
        }, PANEL_STATUS_POLL_INTERVAL);
    }

    /**
     * 停止面板状态定期轮询
     */
    function stopPanelStatusPolling() {
        if (_panelStatusTimer) {
            clearInterval(_panelStatusTimer);
            _panelStatusTimer = null;
        }
    }

    /**
     * 更新顶部栏与用户菜单中的用户信息
     */
    function updateUserUI() {
        const user = state.currentUser;
        if (!user) return;
        const displayName = user.username || "用户";
        const role = user.role || "user";
        const roleLabel = ROLE_LABELS[role] || role;

        $("currentUserName").textContent = displayName;
        $("currentUserRole").textContent = roleLabel;
        $("userAvatar").textContent = displayName.charAt(0).toUpperCase();
        $("umName").textContent = displayName;
        $("umId").textContent = "ID: " + (user.user_id || user.id || "-");
    }

    /**
     * 根据角色显示/隐藏管理后台区域
     */
    function updateAdminVisibility() {
        const user = state.currentUser;
        if (!user) return;
        const role = user.role || (user.is_admin ? "admin" : "user");
        const isAdmin = role === "admin" || role === "superadmin";
        $("adminDivider").style.display = isAdmin ? "" : "none";
        $("adminSection").style.display = isAdmin ? "" : "none";
        $("quickCards").style.display = isAdmin ? "" : "none";
        // 运行器仅管理员可见
        const navRunner = $("navRunner");
        if (navRunner) navRunner.style.display = isAdmin ? "" : "none";
        const annCreateBtn = $("annCreateBtn");
        if (annCreateBtn) annCreateBtn.style.display = isAdmin ? "" : "none";
        // 面板范围切换标签 (我的面板/全部面板) 仅管理员可见
        const panelScopeTabs = $("panelScopeTabs");
        if (panelScopeTabs) panelScopeTabs.style.display = isAdmin ? "flex" : "none";
        // 普通用户强制使用 "我的面板" 范围, 并重置高亮
        if (!isAdmin) {
            state.panelScope = "mine";
            $$("[data-panel-scope]").forEach((t) => {
                t.classList.toggle("active", t.dataset.panelScope === "mine");
            });
        }
    }

    /* ======================================================================
       8. 导航与视图切换
       ====================================================================== */

    /**
     * 切换主视图
     * @param {string} view - 视图名称
     */
    function switchView(view) {
        // 客户端访问控制: 非管理员不能访问 admin-* 视图和 runner 视图
        if (view && view.startsWith("admin-") && !isAdmin()) {
            toastWarn("没有权限访问该页面");
            switchView("dashboard");
            return;
        }
        if (view === "runner" && !isAdmin()) {
            toastWarn("没有权限访问运行器");
            switchView("dashboard");
            return;
        }
        state.currentView = view;

        // 切换导航项高亮
        $$(".nav-item").forEach((item) => {
            item.classList.toggle("active", item.dataset.view === view);
        });

        // 切换视图显示
        $$(".view").forEach((v) => v.classList.remove("active"));
        const viewEl = $("view-" + view);
        if (viewEl) viewEl.classList.add("active");

        // 移动端关闭侧边栏
        closeSidebar();

        // 按视图加载数据
        switch (view) {
            case "dashboard":
                loadDashboard();
                break;
            case "panels":
                loadPanels();
                break;
            case "bots":
                loadBots();
                break;
            case "bot-create":
                // 静态流程页, 无需数据加载
                break;
            case "admin-cards":
                loadCardStats();
                loadCards();
                loadCardCreationLogs();
                break;
            case "admin-users":
                loadUsers();
                break;
            case "admin-logs":
                loadSystemLogs();
                break;
            case "admin-activity":
                loadActivityLog();
                break;
            case "admin-system":
                loadSystemAdmin();
                break;
            case "announcements":
                loadAnnouncements();
                break;
            case "admin-ann-logs":
                loadAnnouncementLogs();
                break;
            case "admin-bots":
                loadBotManage();
                break;
            case "shop":
                loadShop();
                break;
            case "files":
                loadFiles();
                break;
            case "runner":
                loadRunnerFiles();
                break;
            case "tutorial":
                // 教程为纯静态内容，无需加载数据
                break;
            case "admin-orders":
                loadAdminOrders();
                break;
            case "admin-review":
                loadReviewFiles();
                break;
            case "admin-balance":
                loadUsersBalance();
                break;
        }
    }

    async function loadActivityLog() {
        try {
            const data = await api("/api/v2/auth/activity-log");
            const logs = data.data || [];
            const container = $("activityLogList");
            if (logs.length === 0) {
                container.innerHTML = `<div class="empty-state"><i class="fas fa-history"></i><h3>暂无活动记录</h3><p>用户登录、注册等活动记录将显示在这里</p></div>`;
                return;
            }
            container.innerHTML = logs.map(log => {
                const icon = log.action === 'login' ? 'fa-sign-in-alt' : log.action === 'register' ? 'fa-user-plus' : log.action === 'logout' ? 'fa-sign-out-alt' : 'fa-info-circle';
                const color = log.action === 'login' ? 'var(--color-success)' : log.action === 'register' ? 'var(--color-primary)' : log.action === 'logout' ? 'var(--text-secondary)' : 'var(--text-tertiary)';
                const photoBtn = '';
                return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border-muted);">
                <div style="width:36px;height:36px;border-radius:50%;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;color:${color};font-size:14px;"><i class="fas ${icon}"></i></div>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:500;color:var(--text-primary);">${log.username || 'Unknown'} - ${log.action_desc || log.action}</div>
                    <div style="font-size:12px;color:var(--text-tertiary);">${new Date(log.timestamp * 1000).toLocaleString('zh-CN')}</div>
                </div>
                <div style="font-size:11px;color:var(--text-tertiary);background:var(--bg-elevated);padding:2px 8px;border-radius:var(--radius-sm);">${log.ip || '-'}</div>
                ${photoBtn}
            </div>`;
            }).join("");
            // 照片查看
            $$("[data-photo]", container).forEach((btn) => {
                btn.addEventListener("click", () => {
                    const b64 = btn.dataset.photo;
                    const src = b64.startsWith("data:") ? b64 : "data:image/jpeg;base64," + b64;
                    openPhotoViewer(src);
                });
            });
        } catch (err) {
            console.error("Load activity log error:", err);
        }
    }

    /* ======================================================================
       文件管理 / 插件管理
       ====================================================================== */

    /**
     * 发起旧版 API 请求 (不带 /api/v2 前缀, 直接使用 /api/... 完整路径)
     * 用于面板详情中的文件/插件管理接口 (后端旧版 API 位于 /api/ 而非 /api/v2/)
     * @param {string} path - 完整路径 (如 "/api/files/123")
     * @param {object} options - fetch 选项 {method, body, headers, ...}
     * @returns {Promise<object>} 解析后的 JSON
     */
    async function legacyApi(path, options = {}) {
        const headers = options.headers ? Object.assign({}, options.headers) : {};
        // 认证头: 优先使用内存中的 token, 回退到 localStorage
        const token = state.token || localStorage.getItem(TOKEN_KEY);
        if (token) headers["Authorization"] = "Bearer " + token;
        // FormData 不设置 Content-Type, 让浏览器自动设置 boundary
        if (!(options.body instanceof FormData) && options.body !== undefined && options.body !== null) {
            if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        }
        const fetchOpts = {
            method: options.method || "GET",
            credentials: "include",
            headers,
        };
        if (options.body !== undefined && options.body !== null) {
            fetchOpts.body = options.body;
        }
        let response;
        try {
            response = await fetch(path, fetchOpts);
        } catch (err) {
            throw { message: "网络连接失败", type: "network" };
        }
        if (!response.ok) {
            let msg = `请求失败 (${response.status})`;
            try {
                const data = await response.json();
                const extracted = extractApiMessage(data);
                if (extracted) msg = extracted;
            } catch (_) { /* 响应非 JSON */ }
            throw { message: msg, status: response.status };
        }
        // 尝试解析 JSON, 失败则返回成功标记
        try {
            return await response.json();
        } catch (_) {
            return { success: true };
        }
    }

    async function loadPanelFiles() {
        if (!state.currentPanelId) return;
        const pluginId = state.currentPanelId;
        try {
            // 文件 API 位于 /api/panel/{panel_id}/files (非 /api/v2)
            const res = await legacyApi("/api/panel/" + pluginId + "/files", { method: "GET" });
            const files = res.data || res.files || [];
            const container = $("fileGrid");
            if (!container) return;
            if (files.length === 0) {
                container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-folder-open"></i><h3>暂无文件</h3><p>上传建筑文件、配置文件等</p></div>`;
                return;
            }
            container.innerHTML = files.map(f => {
                const icon = f.name.endsWith('.bdx') ? 'fa-cube' : f.name.endsWith('.schematic') ? 'fa-cubes' : f.name.endsWith('.nbt') ? 'fa-cube' : f.name.endsWith('.mcstructure') ? 'fa-layer-group' : f.name.endsWith('.json') ? 'fa-file-code' : 'fa-file';
                return `<div class="card" style="padding:12px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <i class="fas ${icon}" style="font-size:20px;color:var(--color-primary);"></i>
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${f.name}</div>
                            <div style="font-size:11px;color:var(--text-tertiary);">${formatFileSize(f.size)}</div>
                        </div>
                        <button class="btn btn-danger btn-sm" onclick="deletePanelFile('${pluginId}','${f.name}')" title="删除"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            }).join("");
        } catch (err) {
            console.error("Load files error:", err);
            const container = $("fileGrid");
            if (container) container.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><i class="fas fa-exclamation-triangle"></i><h3>加载失败</h3><p>${err.message || '未知错误'}</p></div>`;
        }
    }

    function formatFileSize(bytes) {
        if (!bytes) return '-';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
        return bytes.toFixed(1) + ' ' + units[i];
    }

    async function handleFileUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        if (!state.currentPanelId) return;
        const pluginId = state.currentPanelId;
        for (const file of files) {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("file_type", "structure");
            try {
                appendTerminal(`正在上传文件: ${file.name}...`, "system");
                // 文件上传 API: /api/panel/{panel_id}/upload
                const res = await legacyApi("/api/panel/" + pluginId + "/upload", { method: "POST", body: formData });
                if (res.success !== false) {
                    appendTerminal(`文件上传成功: ${file.name}`, "success");
                    toastSuccess(`文件 ${file.name} 上传成功`);
                } else {
                    appendTerminal(`文件上传失败: ${file.name}`, "error");
                    toastError(`文件 ${file.name} 上传失败`);
                }
            } catch (err) {
                appendTerminal(`文件上传出错: ${file.name} - ${err.message}`, "error");
                toastError(`上传失败: ${err.message}`);
            }
        }
        event.target.value = "";
        loadPanelFiles();
    }

    async function deletePanelFile(pluginId, filename) {
        if (!confirm(`确定要删除文件 ${filename} 吗？`)) return;
        try {
            // 文件删除 API: /api/panel/{panel_id}/files/{filename}
            const res = await legacyApi("/api/panel/" + pluginId + "/files/" + encodeURIComponent(filename), { method: "DELETE" });
            if (res.success !== false) {
                toastSuccess("文件已删除");
                loadPanelFiles();
            }
        } catch (err) {
            toastError(`删除失败: ${err.message}`);
        }
    }

    async function loadPanelPlugins() {
        const container = $("pluginList");
        if (!container) return;
        if (!state.currentPanelId) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-puzzle-piece"></i><h3>暂无插件</h3></div>`;
            return;
        }
        try {
            // 新插件 API (每面板独立): /api/plugins?panel_id=xxx
            const res = await api("/api/plugins?panel_id=" + encodeURIComponent(state.currentPanelId));
            const plugins = (res.data || res.plugins || []).filter(p => p.plugin_id && p.plugin_id !== "data" && p.plugin_id !== "config");
            if (plugins.length === 0) {
                container.innerHTML = `<div class="empty-state"><i class="fas fa-puzzle-piece"></i><h3>暂无插件</h3><p>上传 .py 插件 (TD 风格) 或 .zip 插件包</p></div>`;
                return;
            }
            container.innerHTML = plugins.map(p => {
                const statusColor = p.loaded ? 'var(--color-success)' : (p.error ? 'var(--color-danger)' : (p.enabled ? 'var(--color-warning)' : 'var(--text-tertiary)'));
                const statusText = p.loaded ? '✅ 已加载' : (p.error ? '❌ 有问题' : (p.enabled ? '⏳ 待加载' : '已禁用'));
                const errText = p.error
                    ? `<div style="font-size:11px;color:var(--color-danger);margin-top:2px;cursor:pointer;text-decoration:underline dotted;" onclick="showPluginError('${escapeHtml(p.plugin_id)}')" title="点击查看错误详情">⚠ ${escapeHtml(p.error)}</div>`
                    : '';
                const toggleBtn = p.enabled
                    ? `<button class="btn btn-warning btn-sm" onclick="togglePlugin('${escapeHtml(p.plugin_id)}')"><i class="fas fa-pause"></i> 禁用</button>`
                    : `<button class="btn btn-success btn-sm" onclick="togglePlugin('${escapeHtml(p.plugin_id)}')"><i class="fas fa-play"></i> 启用</button>`;
                return `<div class="card" style="padding:12px;display:flex;align-items:center;gap:12px;">
                    <i class="fas fa-puzzle-piece" style="font-size:20px;color:${statusColor};"></i>
                    <div style="flex:1;min-width:0;">
                        <div style="font-weight:500;">${escapeHtml(p.name || p.plugin_id)}</div>
                        <div style="font-size:11px;color:var(--text-tertiary);">${p.language || 'python'} · <span style="color:${statusColor}">${statusText}</span></div>
                        ${errText}
                    </div>
                    ${toggleBtn}
                    <button class="btn btn-secondary btn-sm" onclick="reloadPlugin('${escapeHtml(p.plugin_id)}')" title="加载/重载"><i class="fas fa-redo"></i> 加载</button>
                    <button class="btn btn-danger btn-sm" onclick="removePlugin('${escapeHtml(p.plugin_id)}')" title="删除"><i class="fas fa-trash"></i></button>
                </div>`;
            }).join("");
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>加载失败</h3><p>${escapeHtml(err.message || '未知错误')}</p></div>`;
        }
    }

    /** 查看插件错误详情 (点击错误文本) */
    window.showPluginError = function(pluginId) {
        const state_ = window.__cgPluginErrors || {};
        const err = state_[pluginId];
        if (!err) {
            toastWarn("暂无错误详情 (重新加载插件后可获取)");
            return;
        }
        appendTerminal(`══ 插件错误: ${pluginId} ══`, "error");
        err.split("\n").forEach(l => appendTerminal(l, "error"));
    };
    // 插件错误缓存 (reload 时更新)
    window.__cgPluginErrors = {};

    async function handlePluginUpload(event) {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        if (!state.currentPanelId) return;
        for (const file of files) {
            const formData = new FormData();
            formData.append("file", file);
            try {
                appendTerminal(`正在安装插件: ${file.name}...`, "system");
                const res = await api("/api/plugins/" + state.currentPanelId + "/upload", { method: "POST", body: formData });
                if (res.success !== false) {
                    appendTerminal(`插件安装成功: ${file.name}`, "success");
                    toastSuccess(`插件 ${file.name} 安装成功`);
                } else {
                    appendTerminal(`插件安装失败: ${file.name}`, "error");
                }
            } catch (err) {
                appendTerminal(`插件安装出错: ${err.message}`, "error");
                toastError(`安装失败: ${err.message}`);
            }
        }
        event.target.value = "";
        loadPanelPlugins();
    }

    async function togglePlugin(pluginId) {
        try {
            const res = await api(`/api/plugins/${state.currentPanelId}/${encodeURIComponent(pluginId)}/toggle`, { method: "POST" });
            if (res.success !== false) {
                toastSuccess(res.message || "已切换");
                loadPanelPlugins();
            } else {
                toastError(res.message || "操作失败");
            }
        } catch (err) {
            toastError(err.message || "操作失败");
        }
    }

    async function reloadPlugin(pluginId) {
        try {
            appendTerminal(`正在加载插件: ${pluginId}...`, "system");
            const res = await api(`/api/plugins/${state.currentPanelId}/${encodeURIComponent(pluginId)}/reload`, { method: "POST" });
            if (res.success !== false) {
                toastSuccess(res.message || "插件已加载");
                appendTerminal(`插件加载成功: ${pluginId}`, "success");
            } else {
                toastError(res.message || "加载失败");
                appendTerminal(`插件加载失败: ${pluginId} - ${res.message}`, "error");
            }
            loadPanelPlugins();
        } catch (err) {
            toastError(err.message || "加载失败");
        }
    }

    async function removePlugin(pluginId) {
        if (!confirm(`确定要删除插件 ${pluginId} 吗？`)) return;
        try {
            const res = await api(`/api/plugins/${state.currentPanelId}/${encodeURIComponent(pluginId)}`, { method: "DELETE" });
            if (res.success !== false) {
                toastSuccess("插件已删除");
                loadPanelPlugins();
            }
        } catch (err) {
            toastError(`删除失败: ${err.message}`);
        }
    }

    // 暴露给内联 onclick 使用的全局函数
    window.deletePanelFile = deletePanelFile;
    window.togglePlugin = togglePlugin;
    window.reloadPlugin = reloadPlugin;
    window.removePlugin = removePlugin;
    window.switchView = switchView;
    window.deleteComment = deleteComment;
    // 商店 / 文件 / 管理后台 - 内联按钮调用的函数
    window.purchaseProduct = purchaseProduct;
    window.purchaseFile = purchaseFile;
    window.downloadFile = downloadFile;
    window.approveFile = approveFile;
    window.rejectFile = rejectFile;
    window.copyToClipboard = copyToClipboard;

    /**
     * 切换控制台 Tab
     * @param {string} tab - "console"/"logs"/"files"/"plugins"/"settings"
     */
    function switchConsoleTab(tab) {
        state.currentConsoleTab = tab;
        $$(".console-tab").forEach((t) => {
            t.classList.toggle("active", t.dataset.consoleTab === tab);
        });
        ["console", "logs", "files", "plugins", "settings"].forEach((name) => {
            const panel = $("ctab-" + name);
            if (panel) panel.classList.toggle("active", name === tab);
        });
        // 按需加载数据
        if (tab === "logs") loadPanelLogs();
        if (tab === "settings") {
            loadBotConfig();
            loadAccessPointStatus();
        }
        if (tab === "files") loadPanelFiles();
        if (tab === "plugins") loadPanelPlugins();
    }

    /* ======================================================================
       9. 侧边栏 / 用户菜单 (移动端)
       ====================================================================== */

    /** 打开移动端侧边栏 */
    function openSidebar() {
        $("sidebar").classList.add("open");
        $("sidebarBackdrop").classList.add("visible");
    }

    /** 关闭移动端侧边栏 */
    function closeSidebar() {
        $("sidebar").classList.remove("open");
        $("sidebarBackdrop").classList.remove("visible");
    }

    /** 切换移动端侧边栏 */
    function toggleSidebar() {
        if ($("sidebar").classList.contains("open")) {
            closeSidebar();
        } else {
            openSidebar();
        }
    }

    /** 切换用户菜单下拉 */
    function toggleUserMenu() {
        $("userMenu").classList.toggle("visible");
    }

    /** 关闭用户菜单 */
    function closeUserMenu() {
        $("userMenu").classList.remove("visible");
    }

    /* ======================================================================
       10. Dashboard (仪表盘)
       ====================================================================== */

    /** 加载仪表盘数据 */
    async function loadDashboard() {
        updateWelcomeTime();
        await Promise.allSettled([loadStats(), loadActivity()]);
    }

    /** 更新欢迎时间 */
    function updateWelcomeTime() {
        const now = new Date();
        const timeStr = now.toLocaleString("zh-CN", {
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
        });
        if ($("welcomeTime")) $("welcomeTime").textContent = timeStr;

        // 更新欢迎语
        if (state.currentUser) {
            const name = state.currentUser.username || "用户";
            const hour = now.getHours();
            let greeting = "晚上好";
            if (hour < 6) greeting = "凌晨好";
            else if (hour < 12) greeting = "早上好";
            else if (hour < 14) greeting = "中午好";
            else if (hour < 18) greeting = "下午好";
            $("welcomeTitle").textContent = `${greeting}，${name}`;
        }
    }

    /** 加载统计数据 */
    async function loadStats() {
        try {
            // 面板范围与 loadPanels 保持一致: 普通用户强制 mine, 管理员按 state.panelScope
            const panelScope = isAdmin() ? (state.panelScope || "mine") : "mine";
            // 并行加载面板与机器人
            const [panelsRes, botsRes] = await Promise.allSettled([
                api(`/panels?scope=${encodeURIComponent(panelScope)}`),
                api("/bots"),
            ]);

            let panelCount = 0, botCount = 0, accountCount = 0;

            if (panelsRes.status === "fulfilled" && panelsRes.value.success) {
                state.panels = panelsRes.value.data || [];
                panelCount = state.panels.length;
            }
            if (botsRes.status === "fulfilled" && botsRes.value.success) {
                state.bots = botsRes.value.data || [];
                botCount = state.bots.filter((b) => b.status === "running" || b.status === "active").length;
                // 统计唯一游戏账号
                const accounts = new Set();
                state.bots.forEach((b) => {
                    if (b.account_id) accounts.add(b.account_id);
                });
                accountCount = accounts.size;
            }

            // 更新数字
            $("statPanels").textContent = panelCount;
            $("statActiveBots").textContent = botCount;
            $("statAccounts").textContent = accountCount;

            // 更新侧边栏徽章
            $("badgePanels").textContent = panelCount;
            $("badgeBots").textContent = state.bots.length;

            // 卡密数量 (仅管理员可见)
            const role = state.currentUser ? state.currentUser.role : "user";
            if (role === "admin" || role === "superadmin") {
                try {
                    const statsRes = await api("/cards/stats");
                    if (statsRes.success && statsRes.data) {
                        state.cardStats = statsRes.data;
                        $("statCards").textContent = statsRes.data.total || 0;
                    }
                } catch (_) {
                    $("statCards").textContent = "-";
                }
            } else {
                $("statCards").textContent = "-";
            }
        } catch (_) { /* 已由 api() 处理 */ }
    }

    /** 加载最近活动 (用户日志) */
    async function loadActivity() {
        const list = $("activityList");
        try {
            if (!state.currentUser) return;
            const userId = state.currentUser.user_id || state.currentUser.id;
            if (!userId) {
                list.innerHTML = renderEmptyState("fa-inbox", "暂无活动", "最近的操作记录将显示在这里");
                return;
            }
            const res = await api(`/logs/user/${userId}`);
            if (res.success && res.data && res.data.length > 0) {
                // 取最近 10 条
                const logs = res.data.slice(0, 10);
                list.innerHTML = logs.map((log) => {
                    const color = LOG_COLORS[log.level] || LOG_COLORS.info;
                    const time = formatTime(log.created_at || log.timestamp);
                    return `
                        <div class="activity-item" style="display:flex;gap:12px;padding:10px 0;border-bottom:1px solid #21262d;">
                            <div style="width:8px;height:8px;border-radius:50%;background:${color};margin-top:6px;flex-shrink:0;"></div>
                            <div style="flex:1;min-width:0;">
                                <div style="font-size:13px;color:#e6edf3;word-break:break-word;">${escapeHtml(log.message || log.action || "")}</div>
                                <div style="font-size:11px;color:#7d8590;margin-top:2px;">${escapeHtml(time)}</div>
                            </div>
                        </div>
                    `;
                }).join("");
            } else {
                list.innerHTML = renderEmptyState("fa-inbox", "暂无活动", "最近的操作记录将显示在这里");
            }
        } catch (_) {
            list.innerHTML = renderEmptyState("fa-inbox", "暂无活动", "最近的操作记录将显示在这里");
        }
    }

    /** localStorage 键名: 最近活动折叠状态 */
    const ACTIVITY_COLLAPSE_KEY = "crystalgate_activity_collapsed";

    /**
     * 切换"最近活动"卡片的折叠/展开状态
     * - 切换 collapsed 类
     * - 更新按钮图标 (chevron-up / chevron-down)
     * - 持久化到 localStorage
     */
    function toggleActivityCollapse() {
        const collapse = $("activityCollapse");
        const icon = $("toggleActivityIcon");
        if (!collapse) return;
        const collapsed = collapse.classList.toggle("collapsed");
        if (icon) {
            icon.className = collapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
        }
        try {
            localStorage.setItem(ACTIVITY_COLLAPSE_KEY, collapsed ? "1" : "0");
        } catch (_) { /* localStorage 不可用时忽略 */ }
    }

    /** 从 localStorage 恢复"最近活动"折叠状态 (初始化时调用) — 默认折叠 */
    function restoreActivityCollapse() {
        const collapse = $("activityCollapse");
        const icon = $("toggleActivityIcon");
        if (!collapse) return;
        let collapsed = true;  // 默认折叠
        try {
            const saved = localStorage.getItem(ACTIVITY_COLLAPSE_KEY);
            collapsed = saved === null ? true : saved === "1";
        } catch (_) { /* 忽略 */ }
        collapse.classList.toggle("collapsed", collapsed);
        if (icon) {
            icon.className = collapsed ? "fas fa-chevron-down" : "fas fa-chevron-up";
        }
    }

    /**
     * 加载当前用户余额并更新商店视图余额显示
     * 调用 GET /api/v2/shop/balance, 格式化为 "XX.XX"
     * 仅在商店视图加载时调用 (不再在顶栏显示余额)
     * 接口不可用时静默处理, 不影响主流程
     */
    async function loadBalance() {
        const textEl = $("shopBalanceText");
        if (!textEl) return;
        try {
            const res = await api("/shop/balance");
            if (res && res.success) {
                // 兼容 {balance} / {data: {balance}} / {data: <number>} 等返回结构
                let balance = res.balance;
                if (balance === undefined && res.data !== undefined) {
                    balance = (res.data && res.data.balance !== undefined) ? res.data.balance : res.data;
                }
                const num = parseFloat(balance);
                const formatted = isNaN(num) ? "0.00" : num.toFixed(2);
                textEl.textContent = formatted;
            } else {
                textEl.textContent = "0.00";
            }
        } catch (_) {
            // 余额接口不可用 (如未部署商店模块) -> 静默处理, 不打扰用户
            textEl.textContent = "0.00";
        }
    }

    /* ======================================================================
       11. 面板管理
       ====================================================================== */

    /** 加载面板列表 */
    async function loadPanels() {
        const grid = $("panelsGrid");
        try {
            // 管理员可按 state.panelScope 切换 "我的面板/全部面板"; 普通用户强制使用 mine
            const scope = isAdmin() ? (state.panelScope || "mine") : "mine";
            const res = await api(`/panels?scope=${encodeURIComponent(scope)}`);
            if (res.success) {
                state.panels = res.data || [];
                renderPanels(state.panels);
                // 更新徽章
                $("badgePanels").textContent = state.panels.length;
                $("statPanels").textContent = state.panels.length;
            }
        } catch (err) {
            // 不再静默失败: 在面板网格中展示具体错误信息, 避免用户看到空白而困惑
            const reason = (err && err.message) ? err.message : "未知错误";
            if (grid) {
                grid.innerHTML = `
                    <div class="empty-state" style="grid-column:1/-1;">
                        <i class="fas fa-exclamation-triangle" style="color:var(--color-danger);"></i>
                        <h3>面板加载失败</h3>
                        <p>${escapeHtml(reason)}</p>
                        <button class="btn btn-secondary btn-sm" style="margin-top:12px;" onclick="window.__crystalgateReloadPanels && window.__crystalgateReloadPanels()">
                            <i class="fas fa-sync-alt"></i> 重试
                        </button>
                    </div>`;
            }
            // 重置徽章与统计, 避免显示陈旧数据
            state.panels = [];
            $("badgePanels").textContent = "0";
            $("statPanels").textContent = "0";
        }
    }

    /**
     * 渲染面板卡片列表
     * @param {array} panels - 面板数组
     */
    function renderPanels(panels) {
        const grid = $("panelsGrid");
        if (!panels || panels.length === 0) {
            grid.innerHTML = `
                <div class="empty-state" id="panelsEmpty">
                    <i class="fas fa-inbox"></i>
                    <h3>暂无面板</h3>
                    <p>点击"创建面板"按钮，使用面板卡密创建您的第一个面板</p>
                </div>`;
            return;
        }
        grid.innerHTML = panels.map((panel) => {
            const panelId = panel.panel_id || panel.id;
            const status = panel.status || "active";
            const expireAt = formatTime(panel.expire_at);
            const createdAt = formatTime(panel.created_at);
            const remaining = panel.remaining_seconds ? formatRemaining(panel.remaining_seconds) : null;
            return `
                <div class="card panel-card" data-panel-id="${escapeHtml(panelId)}" style="cursor:pointer;transition:transform 0.2s,border-color 0.2s;" onmouseover="this.style.transform='translateY(-2px)';this.style.borderColor='#58a6ff';" onmouseout="this.style.transform='';this.style.borderColor='';">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
                        <div style="display:flex;align-items:center;gap:8px;">
                            <i class="fas fa-server" style="color:#58a6ff;"></i>
                            <span style="font-size:15px;font-weight:600;">${escapeHtml(panel.name || "未命名面板")}</span>
                        </div>
                        ${getStatusBadge(status)}
                    </div>
                    <div style="display:flex;flex-direction:column;gap:6px;font-size:12px;color:#7d8590;">
                        <div style="display:flex;justify-content:space-between;">
                            <span>面板 ID</span>
                            <span class="mono" style="color:#e6edf3;">${escapeHtml(panelId)}</span>
                        </div>
                        <div style="display:flex;justify-content:space-between;">
                            <span>到期时间</span>
                            <span style="color:#e6edf3;">${escapeHtml(expireAt)}</span>
                        </div>
                        ${remaining ? `<div style="display:flex;justify-content:space-between;"><span>剩余时间</span><span style="color:#3fb950;">${escapeHtml(remaining)}</span></div>` : ""}
                        <div style="display:flex;justify-content:space-between;">
                            <span>创建时间</span>
                            <span>${escapeHtml(createdAt)}</span>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:14px;border-top:1px solid #21262d;padding-top:12px;">
                        <button class="btn btn-secondary btn-sm" style="flex:1;" data-action="renew" data-panel-id="${escapeHtml(panelId)}">
                            <i class="fas fa-sync-alt"></i> 续费
                        </button>
                        <button class="btn btn-danger btn-sm" style="flex:1;" data-action="delete-panel" data-panel-id="${escapeHtml(panelId)}" data-panel-name="${escapeHtml(panel.name || '')}">
                            <i class="fas fa-trash"></i> 删除
                        </button>
                    </div>
                </div>
            `;
        }).join("");

        // 绑定面板卡片点击事件
        $$(".panel-card", grid).forEach((card) => {
            card.addEventListener("click", (e) => {
                // 如果点击的是按钮，不触发卡片点击
                if (e.target.closest("button")) return;
                openPanelDetail(card.dataset.panelId);
            });
        });
        // 绑定续费按钮
        $$('[data-action="renew"]', grid).forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                openRenewPanelModal(btn.dataset.panelId);
            });
        });
        // 绑定删除按钮
        $$('[data-action="delete-panel"]', grid).forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                const panelId = btn.dataset.panelId;
                const panelName = btn.dataset.panelName;
                confirmAction(
                    '<i class="fas fa-exclamation-triangle"></i> 删除面板',
                    `确定要删除面板 <strong>${escapeHtml(panelName)}</strong> 吗？此操作不可撤销，面板下所有机器人将被一并删除。`,
                    () => handleDeletePanel(panelId)
                );
            });
        });
    }

    /** 打开创建面板模态框 */
    function openCreatePanelModal() {
        $("createPanelForm").reset();
        openModal("modalCreatePanel");
        setTimeout(() => $("createPanelName").focus(), 100);
    }

    /** 处理创建面板 */
    async function handleCreatePanel(e) {
        e.preventDefault();
        const name = $("createPanelName").value.trim();
        const cardKey = $("createPanelCardKey").value.trim();
        const serverCode = $("createPanelServerCode").value.trim();
        const btn = $("createPanelSubmit");

        if (!name || !cardKey) {
            toastWarn("请填写面板名称和卡密");
            return;
        }
        // 服务器号可选: 创建面板后可在设置里自行修改
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

        try {
            const res = await api("/panels", {
                method: "POST",
                body: { name, card_key: cardKey, server_code: serverCode || "待设置" },
            });
            if (res.success) {
                toastSuccess("面板创建成功");
                closeModal("modalCreatePanel");
                // 刷新面板列表
                await loadPanels();
                // 如果返回了面板 ID，直接进入详情
                if (res.data && (res.data.panel_id || res.data.id)) {
                    openPanelDetail(res.data.panel_id || res.data.id);
                }
            } else {
                toastError(res.message || "创建失败");
            }
        } catch (_) { /* 已处理 */ } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check"></i> 创建';
        }
    }

    /**
     * 打开面板详情视图
     * @param {string} panelId - 面板 ID
     */
    function openPanelDetail(panelId) {
        state.currentPanelId = panelId;
        switchView("panel-detail");
        loadPanelDetail();
    }

    /** 加载面板详情 */
    async function loadPanelDetail() {
        const panelId = state.currentPanelId;
        if (!panelId) return;

        // 重置控制台
        clearTerminal();
        // 清空上一面板的状态信息, 避免与新面板混淆
        state.panelInfoText = "";
        refreshConsoleInfo();
        appendTerminal("正在加载面板信息...", "system");
        switchConsoleTab("console");

        try {
            // 并行加载面板详情与到期检查
            const [panelRes, checkRes] = await Promise.allSettled([
                api(`/panels/${panelId}`),
                api(`/panels/${panelId}/check`, { method: "POST" }),
            ]);

            if (panelRes.status === "fulfilled" && panelRes.value.success) {
                state.panelDetail = panelRes.value.data;
                const panel = state.panelDetail;
                $("detailPanelName").textContent = panel.name || "未命名面板";
                $("detailPanelStatus").textContent = panel.status || "active";
                $("detailPanelStatus").className = "badge";
                $("detailPanelStatus").style.cssText = `background:${(STATUS_COLORS[panel.status] || "#7d8590")}22;color:${STATUS_COLORS[panel.status] || "#7d8590"};border:1px solid ${(STATUS_COLORS[panel.status] || "#7d8590")}44;padding:2px 10px;border-radius:9999px;font-size:11px;font-weight:600;`;
                $("detailPanelId").textContent = panel.panel_id || panel.id || panelId;
            }

            // 显示到期检查信息
            if (checkRes.status === "fulfilled" && checkRes.value.success) {
                const check = checkRes.value.data;
                const remaining = check.remaining_seconds != null
                    ? formatRemaining(check.remaining_seconds)
                    : "永久";
                // 将面板状态保存到 state, 与 WebSocket 状态组合显示在 consoleInfo
                state.panelInfoText = `状态: ${check.status || "未知"} | 剩余: ${remaining}`;
                refreshConsoleInfo();
                appendTerminal(`面板状态: ${check.status || "未知"}`, "info");
                appendTerminal(`到期时间: ${check.expire_at ? formatTime(check.expire_at) : "永久"}`, "info");
                appendTerminal(`剩余时间: ${remaining}`, "info");

                // TD风格面板锁定: 面板过期/关闭时锁定界面
                const panelStatus = check.status;
                if (panelStatus === "expired" || panelStatus === "closed" || panelStatus === "disabled" ||
                    (check.remaining_seconds != null && check.remaining_seconds <= 0)) {
                    appendTerminal("警告: 面板已过期或已关闭，界面将锁定", "warn");
                    showPanelLock(
                        "您的面板已关闭或已过期，无法继续操作。<br>" +
                        `面板状态: <span style="color:#f85149;font-weight:600">${panelStatus || "未知"}</span><br>` +
                        "请联系管理员或续费后重新激活面板。"
                    );
                    // 面板已锁定, 不再加载机器人数据
                    return;
                } else {
                    // 面板正常, 确保锁定遮罩已隐藏
                    hidePanelLock();
                }
            }

            // 加载面板关联的机器人
            await loadPanelBot();
        } catch (_) { /* 已处理 */ }
    }

    /** 加载面板关联的机器人 */
    async function loadPanelBot() {
        const panelId = state.currentPanelId;
        if (!panelId) return;
        try {
            const res = await api(`/bots?panel_id=${encodeURIComponent(panelId)}`);
            if (res.success && res.data && res.data.length > 0) {
                const prevStatus = state.panelBot ? state.panelBot.status : null;
                state.panelBot = res.data[0];
                state.currentBotId = state.panelBot.bot_id || state.panelBot.id;
                // 状态变化时才提示 (避免每 30s 轮询刷屏)
                if (state.panelBot.status !== prevStatus) {
                    appendTerminal(`机器人状态: ${state.panelBot.status}`, "info");
                }
            } else {
                state.panelBot = null;
                state.currentBotId = null;
                appendTerminal('该面板尚未创建机器人，请在「设置」中配置并创建', "warn");
            }
            // 更新面板机器人 UI (按钮、状态指示器)
            updatePanelBotUI();
        } catch (_) { /* 已处理 */ }
    }

    /** 更新面板机器人 UI (按钮、状态指示器) */
    function updatePanelBotUI() {
        const startBtn = $("btnStartBot");
        const stopBtn = $("btnStopBot");
        const restartBtn = $("btnRestartBot");
        const botStatus = state.panelBot ? state.panelBot.status : null;
        // 运行中/启动中: 显示停止+重启
        if (botStatus && (botStatus === "running" || botStatus === "connected" || botStatus === "spawned" || botStatus === "starting" || botStatus === "connecting")) {
            startBtn.classList.add("hidden");
            stopBtn.classList.remove("hidden");
            restartBtn.classList.remove("hidden");
        } else if (botStatus === "error") {
            // 错误状态: 显示启动+停止 (允许停止重连尝试)
            startBtn.classList.remove("hidden");
            stopBtn.classList.remove("hidden");
            restartBtn.classList.add("hidden");
        } else {
            // 停止/未知: 仅显示启动
            startBtn.classList.remove("hidden");
            stopBtn.classList.add("hidden");
            restartBtn.classList.add("hidden");
        }
        // 更新面板状态指示器
        const statusDot = $("panelStatusDot");
        const statusText = $("panelStatusText");
        if (statusDot && statusText) {
            if (state.panelBot && (state.panelBot.status === "running" || state.panelBot.status === "connected" || state.panelBot.status === "spawned")) {
                statusDot.style.background = "#22c55e";
                statusText.textContent = "运行中";
                statusText.style.color = "#22c55e";
            } else if (state.panelBot && (state.panelBot.status === "starting" || state.panelBot.status === "connecting")) {
                statusDot.style.background = "#f59e0b";
                statusText.textContent = "启动中...";
                statusText.style.color = "#f59e0b";
            } else if (state.panelBot && state.panelBot.status === "error") {
                statusDot.style.background = "#ef4444";
                statusText.textContent = "错误";
                statusText.style.color = "#ef4444";
            } else {
                statusDot.style.background = "var(--text-tertiary)";
                statusText.textContent = "未启动";
                statusText.style.color = "var(--text-tertiary)";
            }
        }
    }

    /**
     * 打开续费面板模态框
     * @param {string} panelId - 面板 ID
     */
    function openRenewPanelModal(panelId) {
        const panel = state.panels.find((p) => (p.panel_id || p.id) === panelId);
        $("renewPanelName").value = panel ? (panel.name || "") : "";
        $("renewPanelId").value = panelId;
        $("renewCardKey").value = "";
        openModal("modalRenewPanel");
        setTimeout(() => $("renewCardKey").focus(), 100);
    }

    /** 处理面板续费 */
    async function handleRenewPanel(e) {
        e.preventDefault();
        const panelId = $("renewPanelId").value;
        const cardKey = $("renewCardKey").value.trim();
        const btn = $("renewPanelSubmit");

        if (!cardKey) {
            toastWarn("请输入续期卡密");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 续费中...';

        try {
            const res = await api(`/panels/${panelId}/renew`, {
                method: "POST",
                body: { card_key: cardKey },
            });
            if (res.success) {
                toastSuccess("面板续费成功");
                closeModal("modalRenewPanel");
                await loadPanels();
                // 如果当前在详情页，刷新详情
                if (state.currentView === "panel-detail" && state.currentPanelId === panelId) {
                    loadPanelDetail();
                }
            } else {
                toastError(res.message || "续费失败");
            }
        } catch (_) { /* 已处理 */ } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check"></i> 确认续费';
        }
    }

    /**
     * 处理删除面板
     * @param {string} panelId - 面板 ID
     */
    async function handleDeletePanel(panelId) {
        try {
            const res = await api(`/panels/${panelId}`, { method: "DELETE" });
            if (res.success || res === true) {
                toastSuccess("面板已删除");
                await loadPanels();
                // 如果当前在详情页，返回列表
                if (state.currentView === "panel-detail" && state.currentPanelId === panelId) {
                    switchView("panels");
                }
            } else {
                toastError(res.message || "删除失败");
            }
        } catch (_) { /* 已处理 */ }
    }

    /* ======================================================================
       11.5 WebSocket 连接管理 (指数退避重连)
       --------------------------------------------------------------------------
       - 登录成功后建立全局 WebSocket 连接, 用于接收机器人日志/状态/聊天广播
       - 断线后使用指数退避重连: 初始 1s, 每次翻倍, 上限 60s
       - 连接成功后重置退避计数
       - 在终端与 consoleInfo 工具栏实时显示重连状态
       ====================================================================== */

    /**
     * 初始化 WebSocket 连接 (幂等: 已连接或正在连接时直接返回)
     */
    function initWebSocket() {
        // 已存在且处于连接/已连接状态, 跳过
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        // 未登录则不连接
        if (!state.token) return;

        state.wsManuallyClosed = false;
        const url = WS_BASE + "?token=" + encodeURIComponent(state.token);
        updateWsStatus(false, "连接中...");

        let ws;
        try {
            ws = new WebSocket(url);
        } catch (e) {
            // 构造失败 (如协议不支持), 安排重连
            updateWsStatus(false, "连接失败");
            scheduleReconnect();
            return;
        }
        state.ws = ws;

        ws.onopen = () => {
            state.wsConnected = true;
            // 连接成功 -> 重置退避计数
            state.wsReconnectAttempts = 0;
            if (state.wsReconnectTimer) {
                clearTimeout(state.wsReconnectTimer);
                state.wsReconnectTimer = null;
            }
            updateWsStatus(true, "已连接");
            // 静默连接 (不打扰用户, 移除 PT 风格重连提示)
            // 请求一次状态快照
            try { ws.send(JSON.stringify({ action: "status" })); } catch (e) { /* ignore */ }
        };

        ws.onmessage = (ev) => handleWsMessage(ev.data);

        ws.onclose = () => {
            state.wsConnected = false;
            // 主动关闭 (登出/401) 时不自动重连
            if (state.wsManuallyClosed) {
                updateWsStatus(false, "已断开");
                return;
            }
            // 静默重连 (不显示重连提示)
            scheduleReconnect();
        };

        ws.onerror = () => {
            // onclose 会随后触发, 由其负责重连; 这里仅更新状态
            updateWsStatus(false, "连接错误");
        };
    }

    /**
     * 主动关闭 WebSocket (登出 / 登录过期时调用), 不会触发自动重连
     */
    function closeWebSocket() {
        state.wsManuallyClosed = true;
        if (state.wsReconnectTimer) {
            clearTimeout(state.wsReconnectTimer);
            state.wsReconnectTimer = null;
        }
        state.wsReconnectAttempts = 0;
        state.wsConnected = false;
        if (state.ws) {
            try {
                state.ws.onclose = null;  // 阻止 onclose 触发重连
                state.ws.close();
            } catch (_) { /* ignore */ }
            state.ws = null;
        }
        updateWsStatus(false, "未连接");
    }

    /**
     * 指数退避重连调度
     * 间隔 = min(INITIAL * 2^attempts, MAX), 即 1s, 2s, 4s, 8s ... 60s
     */
    function scheduleReconnect() {
        // 主动关闭后不再重连
        if (state.wsManuallyClosed) return;
        // 未登录不再重连
        if (!state.token) return;
        // 已有定时器在等待
        if (state.wsReconnectTimer) return;

        state.wsReconnectAttempts++;
        const attempts = state.wsReconnectAttempts;
        // 每次翻倍: 1s, 2s, 4s, 8s ... 上限 60s
        const delay = Math.min(
            WS_RECONNECT_INITIAL_MS * Math.pow(2, attempts - 1),
            WS_RECONNECT_MAX_MS
        );
        updateWsStatus(false, "未连接");

        state.wsReconnectTimer = setTimeout(() => {
            state.wsReconnectTimer = null;
            if (state.wsManuallyClosed || !state.token) return;
            initWebSocket();
        }, delay);
    }

    /**
     * 更新 WebSocket 连接状态 (UI + 内部状态)
     * @param {boolean} connected - 是否已连接
     * @param {string} text - 状态描述文本
     */
    function updateWsStatus(connected, text) {
        state.wsConnected = connected;
        state.wsStatusText = text;
        refreshConsoleInfo();
    }

    /**
     * 刷新控制台工具栏的连接/面板状态显示
     * 将 WebSocket 状态与面板信息组合显示在 consoleInfo 中
     */
    function refreshConsoleInfo() {
        const node = $("consoleInfo");
        if (!node) return;
        const wsPart = `WS: ${state.wsStatusText || "未连接"}`;
        if (state.panelInfoText) {
            node.textContent = `${wsPart} | ${state.panelInfoText}`;
        } else {
            node.textContent = wsPart;
        }
    }

    /**
     * 处理 WebSocket 接收到的消息
     * @param {string} raw - 原始消息文本 (JSON)
     */
    function handleWsMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (_) { return; }
        const type = msg.type;
        const data = msg.data || {};
        switch (type) {
            case "pong":
                // 心跳响应, 忽略
                break;
            case "bot_status": {
                // 机器人状态变更 - 直接从 WebSocket 数据更新，避免 DB 延迟导致的竞态
                if (state.currentBotId && data.bot_id === state.currentBotId) {
                    if (data.status) {
                        // 映射内存状态到 DB 状态用于显示
                        const statusMap = {
                            idle: "stopped",
                            connecting: "connecting",
                            authenticating: "connecting",
                            connected: "running",
                            spawned: "running",
                            error: "error",
                            banned: "banned",
                            disconnected: "stopped",
                            kicked: "error",
                        };
                        const displayStatus = statusMap[data.status] || data.status;
                        if (state.panelBot) {
                            state.panelBot.status = displayStatus;
                            // 保存最近错误信息
                            if (data.last_error) {
                                state.panelBot.last_error = data.last_error;
                            }
                        }
                        // 错误状态特殊处理: 显示更详细的信息
                        if (displayStatus === "error") {
                            const errMsg = data.last_error || state.panelBot?.last_error || "未知错误";
                            appendTerminal(`机器人状态更新: 错误 (${errMsg})`, "error");
                        } else if (displayStatus === "banned") {
                            appendTerminal(`机器人状态更新: 已封禁`, "error");
                        } else {
                            appendTerminal(`机器人状态更新: ${displayStatus}`, "info");
                        }
                        // 直接更新 UI 而非重新从 API 读取
                        updatePanelBotUI();
                    }
                }
                break;
            }
            case "logs": {
                // 机器人日志广播
                const logs = data.logs || [];
                if (Array.isArray(logs)) {
                    logs.forEach((l) => {
                        appendTerminal(l.message || l, l.level || "info");
                    });
                }
                break;
            }
            case "chat": {
                // 游戏内聊天消息
                if (data.username && data.message) {
                    appendTerminal(`<${data.username}> ${data.message}`, "info");
                }
                break;
            }
            default:
                // 未知消息类型, 调试时可在终端查看
                break;
        }
    }

    /* ======================================================================
       12. 面板详情 - 控制台 (终端)
       ====================================================================== */

    /**
     * 向终端追加输出
     * @param {string} text - 输出文本
     * @param {string} level - 级别: system/info/success/error/warn
     */
    function appendTerminal(text, level = "info") {
        const output = $("terminalOutput");
        if (!output) return;
        const color = LOG_COLORS[level] || LOG_COLORS.info;
        const prefix = level === "system" ? "[SYSTEM]" : level === "error" ? "[ERROR]" : level === "warn" ? "[WARN]" : level === "success" ? "[OK]" : "[INFO]";
        const time = new Date().toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
        const line = document.createElement("div");
        line.className = "terminal-line " + level;
        line.style.cssText = `color:${color};padding:1px 0;font-family:var(--font-mono);font-size:12.5px;line-height:1.45;word-break:break-word;white-space:pre-wrap;`;
        line.innerHTML = `<span class="ts" style="color:#484f58;margin-right:8px;font-size:11px;display:inline-block;min-width:38px;">${time}</span><span style="font-weight:600;margin-right:4px;">${prefix}</span>${escapeHtml(text)}`;
        output.appendChild(line);

        // 终端输出上限: 超过 MAX_TERMINAL_LINES 时, 从最旧的行开始批量删除,
        // 一次删除到上限以下, 避免每次追加都触发 DOM 操作带来的性能开销。
        const overflow = output.childElementCount - MAX_TERMINAL_LINES;
        if (overflow > 0) {
            for (let i = 0; i < overflow; i++) {
                if (output.firstChild) output.removeChild(output.firstChild);
            }
        }

        // 自动滚动
        if (state.consoleAutoscroll) {
            output.scrollTop = output.scrollHeight;
        }
    }

    /** 清空终端输出 */
    function clearTerminal() {
        const output = $("terminalOutput");
        if (output) output.innerHTML = "";
    }

    /** 切换自动滚动 */
    function toggleAutoscroll() {
        state.consoleAutoscroll = !state.consoleAutoscroll;
        const btn = $("consoleAutoscrollBtn");
        btn.style.color = state.consoleAutoscroll ? "#3fb950" : "#7d8590";
        toastInfo(`自动滚动已${state.consoleAutoscroll ? "开启" : "关闭"}`);
    }

    /**
     * 发送终端命令
     * @param {string} cmd - 命令文本
     */
    async function sendTerminalCommand(cmd) {
        const cmdTrim = cmd.trim();
        if (!cmdTrim) return;

        // 回显命令
        appendTerminal(`$ ${cmdTrim}`, "system");

        // 记录历史
        state.terminalHistory.push(cmdTrim);
        state.terminalHistoryIndex = state.terminalHistory.length;

        // ── 菜单模式 (TD 式交互) ──
        if (state.menuMode === "start-menu") {
            state.menuMode = "";
            if (cmdTrim === "1") {
                // 真正启动
                doStartBot();
            } else if (cmdTrim === "2") {
                state.menuMode = "skin";
                appendTerminal("══ 皮肤管理 ══", "system");
                appendTerminal("  [1] 商城搜皮肤 (输入名字搜索)", "system");
                appendTerminal("  [2] 搜索玩家皮肤", "system");
                appendTerminal("  [3] 返回", "system");
            } else if (cmdTrim === "3") {
                appendTerminal("══ 帮助 ══", "system");
                appendTerminal("  [1] 启动机器人 → 机器进入租赁服", "system");
                appendTerminal("  [2] 换皮肤 → 搜索并换上皮肤", "system");
                appendTerminal("  终端输入 /say 消息 → 机器人说话", "system");
                appendTerminal("  终端输入 //命令 → 机器人执行命令", "system");
                showStartMenu();
            } else {
                showStartMenu();
            }
            return;
        }
        if (state.menuMode === "start-confirm") {
            await handleLikeConfirm(cmdTrim);
            return;
        }
        if (state.menuMode === "main") {
            if (cmdTrim === "1") {
                state.menuMode = "skin";
                appendTerminal("══ 皮肤管理 ══", "system");
                appendTerminal("  [1] 商城搜皮肤 (输入名字搜索)", "system");
                appendTerminal("  [2] 搜索玩家皮肤", "system");
                appendTerminal("  [3] 返回", "system");
                return;
            } else if (cmdTrim === "2") {
                if (state.panelBot) {
                    appendTerminal(`机器人: ${state.panelBot.name} | 状态: ${state.panelBot.status}`, "info");
                } else {
                    appendTerminal("当前无机器人", "warn");
                }
                showMainMenu();
                return;
            } else if (cmdTrim === "3") {
                appendTerminal("══ 帮助 ══", "info");
                appendTerminal("  /say 文字   → 机器人在聊天框发消息", "info");
                appendTerminal("  //命令      → 执行原版命令 (需OP)", "info");
                appendTerminal("  menu        → 打开主菜单", "info");
                appendTerminal("  clear       → 清屏", "info");
                showMainMenu();
                return;
            } else if (cmdTrim === "menu") {
                showMainMenu();
                return;
            } else {
                appendTerminal("❌ 无此选项: " + cmdTrim + " (输入 1/2/3 或 menu)", "warn");
                return;
            }
        }
        if (state.menuMode === "skin") {
            if (cmdTrim === "1") {
                // 商城搜皮肤: 输入名字 → 搜索 → 列表选择 → 换肤
                state.menuMode = "skin-market-search";
                appendTerminal("→ 请输入皮肤名字 (搜索商城皮肤):", "info");
                return;
            } else if (cmdTrim === "2") {
                state.menuMode = "skin-search";
                appendTerminal("→ 输入玩家名 (搜索并换上该玩家的皮肤):", "info");
                return;
            } else if (cmdTrim === "3" || cmdTrim === "0") {
                showMainMenu();
                return;
            } else {
                appendTerminal("❌ 无此选项: " + cmdTrim + " (输入 1/2/3)", "warn");
                return;
            }
        }
        if (state.menuMode === "skin-market-search") {
            state.menuMode = "";
            appendTerminal(`正在搜索商城皮肤 "${cmdTrim}"...`, "info");
            try {
                const res = await api("/skin/market-search", { method: "POST", body: { keyword: cmdTrim } });
                if (res && res.success && res.data && res.data.length) {
                    const skins = res.data;
                    appendTerminal(`── 找到 ${skins.length} 个皮肤 ──`, "system");
                    skins.forEach((s, i) => {
                        appendTerminal(`  [${i + 1}] ${s.name}`, "info");
                    });
                    appendTerminal("  输入编号换上 (0 返回)", "system");
                    state.skinMarket = skins;
                    state.menuMode = "skin-market-pick";
                } else {
                    appendTerminal(`⚠️ 未找到 "${cmdTrim}" 相关皮肤`, "warn");
                    showMainMenu();
                }
            } catch (e) {
                appendTerminal("❌ 搜索失败: " + (e.message || ""), "error");
                showMainMenu();
            }
            return;
        }
        if (state.menuMode === "skin-market-pick") {
            const idx = parseInt(cmdTrim);
            if (idx === 0) { showMainMenu(); return; }
            const skins = state.skinMarket || [];
            if (isNaN(idx) || idx < 1 || idx > skins.length) {
                appendTerminal("❌ 编号无效", "error");
                state.menuMode = "skin-market-search";
                appendTerminal("→ 请输入皮肤名字 (搜索商城皮肤):", "info");
                return;
            }
            const s = skins[idx - 1];
            state.menuMode = "";
            appendTerminal(`正在给机器人换上皮肤: ${s.name}...`, "info");
            try {
                const res = await api("/skin/change", { method: "POST", body: { item_id: String(s.item_id) } });
                if (res && res.success) {
                    appendTerminal(`✅ 皮肤已更换: ${s.name}`, "success");
                } else {
                    appendTerminal(`❌ 换肤失败: ${(res && res.message) || "未知"}`, "error");
                }
            } catch (e) {
                appendTerminal("❌ 换肤失败: " + (e.message || ""), "error");
            }
            showMainMenu();
            return;
        }
        if (state.menuMode === "skin-presets-pick") {
            const idx = parseInt(cmdTrim);
            if (idx === 0) { showMainMenu(); return; }
            const presets = state.skinPresets || [];
            if (isNaN(idx) || idx < 1 || idx > presets.length) {
                appendTerminal("❌ 编号无效", "error");
                state.menuMode = "skin";
                return;
            }
            const p = presets[idx - 1];
            state.menuMode = "";
            appendTerminal(`正在给机器人换上皮肤: ${p.name}...`, "info");
            try {
                const res = await api("/skin/change", { method: "POST", body: { item_id: String(p.item_id) } });
                if (res && res.success) {
                    appendTerminal(`✅ 皮肤已更换: ${p.name}`, "success");
                } else {
                    appendTerminal(`❌ 换肤失败: ${(res && res.message) || "未知"}`, "error");
                }
            } catch (e) {
                appendTerminal("❌ 换肤失败: " + (e.message || ""), "error");
            }
            showMainMenu();
            return;
        }
        if (state.menuMode === "skin-search") {
            state.menuMode = "";
            appendTerminal(`正在搜索玩家 "${cmdTrim}" 并换肤...`, "info");
            try {
                const res = await api("/skin/change", { method: "POST", body: { player_name: cmdTrim, bot_id: state.currentBotId || "" } });
                if (res && res.success) {
                    appendTerminal(`✅ 已换上 ${cmdTrim} 的皮肤`, "success");
                } else {
                    appendTerminal(`❌ 换肤失败: ${(res && res.message) || "未知"}`, "error");
                }
            } catch (e) {
                appendTerminal("❌ 换肤失败: " + (e.message || ""), "error");
            }
            showMainMenu();
            return;
        }

        // 内置命令
        if (cmdTrim === "clear" || cmdTrim === "cls") {
            clearTerminal();
            return;
        }
        if (cmdTrim === "help") {
            appendTerminal("可用命令: /say 文字 (聊天) | //命令 (原版命令) | menu (菜单) | clear (清屏)", "info");
            return;
        }
        if (cmdTrim === "menu") {
            if (!isPanelLocked()) showMainMenu();
            return;
        }
        if (cmdTrim === "status") {
            if (state.panelBot) {
                appendTerminal(`机器人: ${state.panelBot.name} | 状态: ${state.panelBot.status}`, "info");
            } else {
                appendTerminal("当前无机器人", "warn");
            }
            return;
        }

        // 未启动: 什么命令都不接受 (用户要求: 没启动时什么也做不了)
        const isRunning = state.panelBot && (state.panelBot.status === "running" || state.panelBot.status === "active");
        if (!state.currentBotId) {
            appendTerminal("❌ 没有可用的机器人，无法发送命令", "error");
            return;
        }
        if (!isRunning) {
            appendTerminal(`❌ 机器人未启动, 无法执行 "${cmdTrim}" (请先点击启动)`, "warn");
            return;
        }

        // 命令协议: /say=聊天框消息, //=原版命令, 其余=原版命令
        try {
            const res = await api(`/bots/${state.currentBotId}/command`, {
                method: "POST",
                body: { command: cmdTrim },
            });
            if (res.success) {
                if (cmdTrim.startsWith("/say ")) {
                    appendTerminal("✅ 消息已发送到聊天框", "success");
                } else {
                    appendTerminal("✅ 命令已送达机器人", "success");
                }
            } else {
                appendTerminal(`发送失败: ${res.detail || res.message || "未知错误"}`, "error");
            }
        } catch (err) {
            appendTerminal(`发送失败: ${err?.message || "请求错误"}`, "error");
        }
    }

    /** 打印 CG 艺术字 LOGO (等宽一行, 对称不换行) */
    function printCGLogo() {
        appendTerminal('╔════════════════════════════════════╗', "system");
        appendTerminal('║  ██████╗  ██████╗    ║', "system");
        appendTerminal('║ ██╔════╝ ██╔════╝  ║', "system");
        appendTerminal('║ ██║      ██║  ███╗       ║', "system");
        appendTerminal('║ ██║      ██║   ██║        ║', "system");
        appendTerminal('║ ╚██████╗ ╚██████╔╝║', "system");
        appendTerminal('║  ╚═════╝   ╚═════╝   ║', "system");
        appendTerminal('║                                    ║', "system");
        appendTerminal('║   CrystalGate  v1.7.0              ║', "system");
        appendTerminal('╚════════════════════════════════════╝', "system");
    }

    /** 启动机器人 — V1.5: 直接启动; 启动成功后显示 CG LOGO + 菜单 */
    /** 启动菜单: 启动/换皮肤/帮助 */
    function showStartMenu() {
        state.menuMode = "start-menu";
        appendTerminal("══ 启动菜单 ══", "system");
        appendTerminal("  [1] 启动机器人", "system");
        appendTerminal("  [2] 换皮肤", "system");
        appendTerminal("  [3] 帮助", "system");
        appendTerminal("  输入编号选择:", "info");
    }

    /** 真正执行启动 (菜单选1后调用) */
    async function doStartBot() {
        startBot();
    }

    async function startBot() {
        if (isPanelLocked()) { toastWarn("面板已锁定，无法操作"); return; }
        if (!ensureBotExists()) return;
        if (!state.currentBotId) {
            toastWarn("请先创建面板机器人");
            return;
        }
        // 启动菜单: 先弹菜单 (启动/换皮肤/帮助), 选1才真正启动
        showStartMenu();
        return;

        const startBtn = $("btnStartBot");
        try {
            startBtn.disabled = true;
            appendTerminal("正在启动机器人...", "system");
            const res = await api(`/bots/${state.currentBotId}/start`, {
                method: "POST",
                body: { like: false, skin_name: "", welcome: false },
            });
            if (res.success) {
                printCGLogo();
                appendTerminal("✅ 机器人已启动!", "success");
                toastSuccess("机器人已启动");
                $("btnStartBot").classList.add("hidden");
                $("btnStopBot").classList.remove("hidden");
                $("btnRestartBot").classList.remove("hidden");
                await loadPanelBot();
            } else {
                const errMsg = res.detail || res.message || "启动失败 (未知原因)";
                appendTerminal(`❌ 启动失败: ${errMsg}`, "error");
                toastError(errMsg);
                if (state.panelBot) state.panelBot.status = "error";
                updatePanelBotUI();
            }
        } catch (err) {
            const errMsg = err?.message || err?.detail || "启动请求失败";
            appendTerminal(`❌ 启动失败: ${errMsg}`, "error");
            toastError(errMsg);
            if (state.panelBot) state.panelBot.status = "error";
            updatePanelBotUI();
        } finally {
            startBtn.disabled = false;
        }
    }

    /** 显示主菜单 (启动后才可见; 短行防换行) */
    function showMainMenu() {
        state.menuMode = "main";
        appendTerminal("", "system");
        appendTerminal("── 主菜单 ──", "system");
        appendTerminal("  [1] 皮肤管理", "system");
        appendTerminal("  [2] 查看状态", "system");
        appendTerminal("  [3] 帮助", "system");
        appendTerminal("────────────", "system");
    }

    /** 执行点赞确认 (启动后询问) */
    async function handleLikeConfirm(answer) {
        const t = (answer || "").trim().toLowerCase();
        const wantLike = t === "y" || t === "yes";
        state.menuMode = "";
        if (wantLike) {
            appendTerminal("🎁 正在给租赁服点赞...", "info");
            try {
                const botId = state.currentBotId;
                const res = await api(`/bots/${botId}/like`, { method: "POST" });
                if (res && res.success) {
                    appendTerminal(`✅ 点赞成功 (当前 ${res.like_num || "?"} 赞)`, "success");
                } else {
                    appendTerminal(`⚠️ 点赞失败: ${(res && res.message) || "未知"}`, "warn");
                }
            } catch (e) {
                appendTerminal("⚠️ 点赞失败: " + (e.message || "请求错误"), "warn");
            }
        } else {
            appendTerminal("已跳过点赞", "info");
        }
        showMainMenu();
    }

    /** 停止机器人 */
    async function stopBot() {
        if (isPanelLocked()) { toastWarn("面板已锁定，无法操作"); return; }
        if (!ensureBotExists()) return;
        const stopBtn = $("btnStopBot");
        try {
            stopBtn.disabled = true;
            appendTerminal("正在停止机器人...", "system");
            const res = await api(`/bots/${state.currentBotId}/stop`, { method: "POST" });
            if (res.success) {
                appendTerminal("机器人已停止", "success");
                toastSuccess("机器人已停止");
                // 成功后显示启动按钮，隐藏停止按钮
                $("btnStartBot").classList.remove("hidden");
                $("btnStopBot").classList.add("hidden");
                $("btnRestartBot").classList.add("hidden");
                await loadPanelBot();
            } else {
                const errMsg = res.detail || res.message || "停止失败";
                appendTerminal(`停止失败: ${errMsg}`, "error");
                toastError(errMsg);
            }
        } catch (err) {
            const errMsg = err?.message || err?.detail || "停止请求失败";
            appendTerminal(`停止失败: ${errMsg}`, "error");
            toastError(errMsg);
        } finally {
            stopBtn.disabled = false;
        }
    }

    /** 重启机器人 */
    async function restartBot() {
        if (isPanelLocked()) { toastWarn("面板已锁定，无法操作"); return; }
        if (!ensureBotExists()) return;
        const restartBtn = $("btnRestartBot");
        try {
            restartBtn.disabled = true;
            appendTerminal("正在重启机器人...", "system");
            const res = await api(`/bots/${state.currentBotId}/restart`, { method: "POST" });
            if (res.success) {
                appendTerminal("机器人重启成功", "success");
                toastSuccess("机器人已重启");
                await loadPanelBot();
            } else {
                const errMsg = res.detail || res.message || "重启失败";
                appendTerminal(`重启失败: ${errMsg}`, "error");
                toastError(errMsg);
            }
        } catch (err) {
            const errMsg = err?.message || err?.detail || "重启请求失败";
            appendTerminal(`重启失败: ${errMsg}`, "error");
            toastError(errMsg);
        } finally {
            restartBtn.disabled = false;
        }
    }

    /** 检查是否存在机器人 */
    function ensureBotExists() {
        if (!state.currentBotId) {
            toastWarn('该面板尚未创建机器人，请先在「设置」中配置');
            appendTerminal("操作失败: 没有可用的机器人", "error");
            return false;
        }
        return true;
    }

    /* ======================================================================
       13. 面板详情 - 日志
       ====================================================================== */

    /** 加载面板日志 */
    async function loadPanelLogs() {
        const viewer = $("panelLogViewer");
        if (!state.currentPanelId) return;
        try {
            const res = await api(`/logs/panel/${state.currentPanelId}`);
            // 后端返回 {logs: [...], status, bot_name} 或 {data: [...]}
            const logs = (res.logs) || (res.data && (Array.isArray(res.data) ? res.data : res.data.logs)) || [];
            if (logs.length > 0) {
                renderLogs(logs, viewer);
            } else {
                viewer.innerHTML = renderEmptyState("fa-file-alt", "暂无日志", "面板启动/关闭/重启及机器人输出将显示在这里");
            }
        } catch (_) {
            viewer.innerHTML = renderEmptyState("fa-file-alt", "暂无日志", "面板操作日志将显示在这里");
        }
    }

    /* ======================================================================
       14. 面板详情 - 机器人配置 (设置)
       ====================================================================== */

    /** 加载机器人配置到表单 (V1.5: 账号不再可选, 系统自动分配) */
    async function loadBotConfig() {
        try {
            // 账号信息展示 (只读)
            const infoEl = $("botConfigAccountInfo");
            if (infoEl) {
                const botName = state.panelBot ? (state.panelBot.name || state.panelBot.bot_name || "") : "";
                infoEl.textContent = botName && botName !== "未分配"
                    ? `账号: ${botName} (专属本面板)`
                    : "系统自动分配 · 账号专属本面板";
            }
            if (state.panelBot) {
                const bot = state.panelBot;
                $("botConfigServerCode").value = bot.server_code || "";
                $("botConfigServerType").value = bot.server_type || "rental";
                const modeSel = $("botConfigAccountMode");
                const modeGroup = $("botConfigAccountModeGroup");
                if (modeSel && modeGroup) {
                    modeSel.value = bot.account_mode || "pool";
                    // 仅管理员显示账号来源选项
                    const isAdmin = state.currentUser && state.currentUser.is_admin;
                    modeGroup.classList.toggle("hidden", !isAdmin);
                }
            } else {
                // 没有机器人 - 清空表单准备创建
                $("botConfigForm").reset();
                const modeGroup = $("botConfigAccountModeGroup");
                if (modeGroup) {
                    const isAdmin = state.currentUser && state.currentUser.is_admin;
                    modeGroup.classList.toggle("hidden", !isAdmin);
                }
            }
            // 表单已重新加载, 清除未保存标记
            state.botConfigDirty = false;
        } catch (_) { /* 已处理 */ }
    }

    /** 保存机器人配置 (创建或更新) — 自动保存版, 无保存按钮 (V1.5: 不再传 account_id) */
    async function handleSaveBotConfig(e) {
        if (e && e.preventDefault) e.preventDefault();
        const serverCode = $("botConfigServerCode").value.trim();
        const serverType = $("botConfigServerType").value;

        const payload = {
            name: "",  // 名称由账号真实玩家名决定, 不再手动改名
            server_code: serverCode,
            server_type: serverType,
            platform_type: "pc",  // 默认最新, 游戏版本/接入点已内置
            config: {},
        };
        // 账号来源 (仅管理员设置时携带)
        const modeSel = $("botConfigAccountMode");
        if (modeSel && !$("botConfigAccountModeGroup").classList.contains("hidden")) {
            payload.account_mode = modeSel.value;
        }

        try {
            if (state.currentBotId) {
                // 更新已有机器人配置
                const res = await api(`/bots/${state.currentBotId}/config`, {
                    method: "PUT",
                    body: payload,
                });
                if (res.success) {
                    // 静默自动保存 (用户要求: 设置好了自动保存, 不给提示)
                    state.botConfigDirty = false;
                    await loadPanelBot();
                } else {
                    toastError(res.detail || res.message || "保存失败");
                }
            } else {
                // 创建新机器人
                if (!state.currentPanelId) {
                    toastError("缺少面板 ID");
                    return;
                }
                payload.panel_id = state.currentPanelId;
                const res = await api("/bots", {
                    method: "POST",
                    body: payload,
                });
                if (res.success) {
                    toastSuccess("机器人创建成功");
                    if (res.data) {
                        state.currentBotId = res.data.bot_id || res.data.id;
                    }
                    await loadPanelBot();
                    await loadBotConfig();
                }
            }
        } catch (_) { /* 已处理 */ }
    }

    /** 重置机器人配置表单 */
    function resetBotConfig() {
        loadBotConfig();
        toastInfo("配置已重置");
    }

    /** 检查机器人配置表单是否有未保存的修改 */
    function hasUnsavedConfig() {
        return !!state.botConfigDirty;
    }

    /** 加载接入点状态 */
    async function loadAccessPointStatus() {
        try {
            const res = await api("/system/access-points");
            if (!res.success || !res.data) return;
            const aps = res.data.available || [];
            aps.forEach((ap) => {
                const apType = ap.type || ap.name;
                if (apType === "neomega") {
                    const el = $("apNeomegaStatus");
                    if (el) {
                        el.innerHTML = ap.available
                            ? '状态: <span style="color:#22c55e;font-weight:600;">已安装</span>'
                            : '状态: <span style="color:var(--text-tertiary);">未安装</span>';
                    }
                } else if (apType === "fateark") {
                    const el = $("apFatearkStatus");
                    if (el) {
                        el.innerHTML = ap.available
                            ? '状态: <span style="color:#22c55e;font-weight:600;">已安装</span>'
                            : '状态: <span style="color:var(--text-tertiary);">未安装</span>';
                    }
                }
            });
        } catch (_) { /* 已处理 */ }
    }

    /** 下载接入点二进制 */
    async function downloadAccessPoint(name) {
        const btnId = name === "neomega" ? "btnDownloadNeomega" : "btnDownloadFateark";
        const statusId = name === "neomega" ? "apNeomegaStatus" : "apFatearkStatus";
        const btn = $(btnId);
        const statusEl = $(statusId);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 下载中...';
        }
        if (statusEl) {
            statusEl.innerHTML = '状态: <span style="color:#f59e0b;">正在下载...</span>';
        }
        try {
            const res = await api(`/system/access-points/${name}/download`, { method: "POST" });
            if (res.success) {
                toastSuccess(`${name} 下载成功`);
                if (statusEl) {
                    statusEl.innerHTML = '状态: <span style="color:#22c55e;font-weight:600;">已安装</span>';
                }
            } else {
                toastError(`下载失败: ${res.detail || res.message || "未知错误"}`);
                if (statusEl) {
                    statusEl.innerHTML = '状态: <span style="color:#ef4444;">下载失败</span>';
                }
            }
        } catch (e) {
            const msg = e.message || "网络错误";
            toastError(`下载失败: ${msg}`);
            if (statusEl) {
                statusEl.innerHTML = `状态: <span style="color:#ef4444;">${msg}</span>`;
            }
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-download"></i> 下载';
            }
            await loadAccessPointStatus();
        }
    }

    /* ======================================================================
       15. 机器人管理
       ====================================================================== */

    /** 加载机器人列表 */
    async function loadBots() {
        const list = $("botsList");
        try {
            const res = await api("/bots");
            if (res.success) {
                state.bots = res.data || [];
                renderBots(state.bots);
                // 更新徽章
                $("badgeBots").textContent = state.bots.length;
            }
        } catch (_) { /* 已处理 */ }
    }

    /**
     * 渲染机器人列表
     * @param {array} bots - 机器人数组
     */
    function renderBots(bots) {
        const list = $("botsList");
        if (!bots || bots.length === 0) {
            list.innerHTML = `
                <div class="empty-state" id="botsEmpty">
                    <i class="fas fa-robot"></i>
                    <h3>暂无机器人</h3>
                    <p>前往面板详情页面创建机器人实例</p>
                </div>`;
            return;
        }
        list.innerHTML = bots.map((bot) => {
            const botId = bot.bot_id || bot.id;
            const status = bot.status || "idle";
            const isRunning = status === "running" || status === "active" || status === "connected";
            return `
                <div class="card" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;margin-bottom:12px;">
                    <div style="display:flex;align-items:center;gap:14px;flex:1;min-width:0;">
                        <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#58a6ff,#a371f7);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                            <i class="fas fa-robot" style="color:#fff;font-size:18px;"></i>
                        </div>
                        <div style="flex:1;min-width:0;">
                            <div style="display:flex;align-items:center;gap:8px;">
                                <span style="font-size:14px;font-weight:600;">${escapeHtml(bot.name || "未命名")}</span>
                                ${getStatusBadge(status)}
                            </div>
                            <div style="font-size:12px;color:#7d8590;margin-top:4px;">
                                <span class="mono">${escapeHtml(botId)}</span>
                                ${bot.account_id ? ` · 账号: ${escapeHtml(bot.account_id)}` : ""}
                                ${bot.server_code ? ` · 服务器: ${escapeHtml(bot.server_code)}` : ""}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;flex-shrink:0;">
                        <button class="btn btn-success btn-sm" data-bot-action="start" data-bot-id="${escapeHtml(botId)}" ${isRunning ? "disabled" : ""}>
                            <i class="fas fa-play"></i> 启动
                        </button>
                        <button class="btn btn-danger btn-sm" data-bot-action="stop" data-bot-id="${escapeHtml(botId)}" ${!isRunning ? "disabled" : ""}>
                            <i class="fas fa-stop"></i> 停止
                        </button>
                        <button class="btn btn-secondary btn-sm" data-bot-action="detail" data-bot-id="${escapeHtml(botId)}" data-panel-id="${escapeHtml(bot.panel_id || '')}">
                            <i class="fas fa-arrow-right"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join("");

        // 绑定按钮事件
        $$('[data-bot-action]', list).forEach((btn) => {
            btn.addEventListener("click", async () => {
                const action = btn.dataset.botAction;
                const botId = btn.dataset.botId;
                try {
                    if (action === "start") {
                        const res = await api(`/bots/${botId}/start`, { method: "POST" });
                        if (res.success) { toastSuccess("机器人已启动"); await loadBots(); }
                    } else if (action === "stop") {
                        const res = await api(`/bots/${botId}/stop`, { method: "POST" });
                        if (res.success) { toastSuccess("机器人已停止"); await loadBots(); }
                    } else if (action === "detail") {
                        const panelId = btn.dataset.panelId;
                        if (panelId) {
                            openPanelDetail(panelId);
                        } else {
                            toastInfo("该机器人未关联面板");
                        }
                    }
                } catch (_) { /* 已处理 */ }
            });
        });
    }

    /* ======================================================================
       16. 卡密管理
       ====================================================================== */

    /** 加载卡密统计 */
    async function loadCardStats() {
        try {
            const res = await api("/cards/stats");
            if (res.success && res.data) {
                state.cardStats = res.data;
                $("cardStatTotal").textContent = res.data.total || 0;
                $("cardStatUnused").textContent = res.data.unused || 0;
                $("cardStatUsed").textContent = res.data.used || 0;
                $("cardStatRevoked").textContent = res.data.revoked || 0;
            }
        } catch (_) { /* 已处理 */ }
    }

    /** 加载卡密列表 (带筛选) */
    async function loadCards() {
        const tbody = $("cardsTableBody");
        try {
            const params = new URLSearchParams();
            if (state.cardFilterType) params.set("key_type", state.cardFilterType);
            if (state.cardFilterStatus) params.set("status", state.cardFilterStatus);
            // 默认不返回已撤销卡密 (include_revoked=false), 勾选"显示已撤销"或筛选 revoked 状态时才返回
            const showRevoked = state.cardShowRevoked || state.cardFilterStatus === "revoked";
            params.set("include_revoked", showRevoked ? "true" : "false");
            const query = params.toString() ? `?${params.toString()}` : "";
            const res = await api(`/cards${query}`);
            if (res.success) {
                state.cards = res.data || [];
                renderCards(state.cards);
            }
        } catch (_) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#7d8590;">加载失败，请重试</td></tr>`;
        }
    }

    /**
     * 渲染卡密表格
     * @param {array} cards - 卡密数组
     */
    function renderCards(cards) {
        const tbody = $("cardsTableBody");
        if (!cards || cards.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#7d8590;">暂无卡密数据</td></tr>`;
            return;
        }
        tbody.innerHTML = cards.map((card) => {
            const cardId = card.card_id || card.id;
            const key = card.key || card.card_key || "";
            const type = card.key_type || "register";
            const status = (card.status || "unused").toLowerCase();
            const duration = formatDuration(card.duration_days);
            const createdAt = formatTime(card.created_at);
            const usedAt = card.used_at ? formatTime(card.used_at) : (card.last_used_at ? formatTime(card.last_used_at) : "-");
            const typeLabel = CARD_TYPE_LABELS[type] || type;
            const usesLeft = card.uses_left != null ? (card.max_uses === 0 ? "不限" : `${card.uses_left}/${card.max_uses}`) : "-";
            // 使用记录: 谁用了
            let usedByStr = "-";
            try {
                const ub = typeof card.used_by === "string" ? JSON.parse(card.used_by.replace(/'/g, '"')) : (card.used_by || []);
                if (Array.isArray(ub) && ub.length > 0) usedByStr = escapeHtml(ub.join(", "));
            } catch (_) {
                if (card.used_by) usedByStr = escapeHtml(String(card.used_by));
            }
            const used = status === "used" || status === "expired" || (card.uses_left != null && card.max_uses > 0 && card.uses_left < card.max_uses) || card.last_used_at;
            return `
                <tr>
                    <td>
                        <span class="mono" style="cursor:pointer;color:#58a6ff;" title="点击复制" data-copy="${escapeHtml(key)}">${escapeHtml(key)}</span>
                    </td>
                    <td>${escapeHtml(typeLabel)}</td>
                    <td>${getStatusBadge(status)}</td>
                    <td>${escapeHtml(duration)}</td>
                    <td>${escapeHtml(usesLeft)}</td>
                    <td>${escapeHtml(createdAt)}</td>
                    <td>${usedAt}</td>
                    <td>
                        <button class="btn btn-secondary btn-sm" data-card-detail="${escapeHtml(key)}" title="查看使用详情"><i class="fas fa-info-circle"></i> 详情</button>
                        ${used ? `<button class="btn btn-danger btn-sm" data-revoke="${escapeHtml(cardId)}"><i class="fas fa-trash"></i> 删除</button>` : `<button class="btn btn-danger btn-sm" data-revoke="${escapeHtml(cardId)}"><i class="fas fa-trash"></i> 删除</button>`}
                    </td>
                </tr>
            `;
        }).join("");

        // 绑定复制事件
        $$("[data-copy]", tbody).forEach((el) => {
            el.addEventListener("click", () => copyToClipboard(el.dataset.copy));
        });
        // 详情按钮
        $$("[data-card-detail]", tbody).forEach((btn) => {
            btn.addEventListener("click", () => {
                const key = btn.dataset.cardDetail;
                const card = (state.cards || []).find(c => (c.key || c.card_key || "") === key);
                if (!card) return;
                let usedBy = "无";
                try {
                    const ub = typeof card.used_by === "string" ? JSON.parse(card.used_by.replace(/'/g, '"')) : (card.used_by || []);
                    if (Array.isArray(ub) && ub.length > 0) usedBy = ub.join(", ");
                } catch (_) {
                    if (card.used_by) usedBy = String(card.used_by);
                }
                const usedAt = card.last_used_at ? formatTime(card.last_used_at) : "-";
                confirmAction(
                    `<i class="fas fa-info-circle"></i> 卡密使用详情`,
                    `卡密: <b class="mono">${escapeHtml(key)}</b><br>使用人: <b>${escapeHtml(String(usedBy))}</b><br>使用时间: <b>${escapeHtml(usedAt)}</b>`,
                    null,
                    { confirmText: "关闭", hideCancel: true }
                );
            });
        });
        // 绑定删除事件 (已使用的也可删)
        $$("[data-revoke]", tbody).forEach((btn) => {
            btn.addEventListener("click", () => {
                const cardId = btn.dataset.revoke;
                confirmAction(
                    '<i class="fas fa-trash"></i> 删除卡密',
                    `确定要删除此卡密吗？删除后直接消失, 无法恢复。`,
                    () => revokeCard(cardId)
                );
            });
        });
    }

    /** 打开生成卡密模态框 */
    function openCreateCardModal() {
        $("createCardForm").reset();
        $("cardKeyDuration").value = "permanent";
        $("cardKeyCount").value = "1";
        $("cardKeyMaxUses").value = "1";
        $("cardKeyExpires").value = "";
        $("cardKeyExpires").min = toLocalInput(new Date());  // 最小只能选现在
        $("cardKeyResults").style.display = "none";
        $("cardKeyResultsList").innerHTML = "";
        openModal("modalCreateCard");
    }

    /** Date → datetime-local 字符串 */
    function toLocalInput(d) {
        const pad = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    /** 校验过期时间不能选过去 */
    function validateCardExpiry(el) {
        if (!el.value) return;
        const t = new Date(el.value).getTime();
        if (t <= Date.now()) {
            toastWarn("过期时间必须晚于当前时间");
            el.value = toLocalInput(new Date(Date.now() + 86400000));
        }
    }

    /** 处理生成卡密 */
    async function handleCreateCard(e) {
        e.preventDefault();
        const keyType = $("cardKeyType").value;
        const duration = $("cardKeyDuration").value;
        const count = parseInt($("cardKeyCount").value, 10);
        const expires = $("cardKeyExpires").value;
        const maxUsesEl = $("cardKeyMaxUses");
        const maxUses = maxUsesEl ? parseInt(maxUsesEl.value, 10) : 1;
        const btn = $("createCardSubmit");

        if (!keyType || !duration || !count || count < 1 || count > 100) {
            toastWarn("请检查表单填写 (数量 1-100)");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 生成中...';

        try {
            const payload = { key_type: keyType, duration, count, max_uses: maxUses };
            if (expires) payload.expires_at = new Date(expires).toISOString();

            const res = await api("/cards", {
                method: "POST",
                body: payload,
            });
            if (res.success && res.data && res.data.cards) {
                toastSuccess(`成功生成 ${res.data.cards.length} 个卡密`);
                // 显示结果: 一个卡密一行, 紧凑排版
                $("cardKeyResults").style.display = "block";
                const expiryText = res.data.expires_at
                    ? ` (过期: ${new Date(res.data.expires_at * 1000).toLocaleString('zh-CN')})`
                    : '';
                $("cardKeyResultsList").innerHTML = res.data.cards.map((card) => {
                    const key = typeof card === 'string' ? card : (card.key || card.card_key || card.code || '');
                    return `
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;background:#0d1117;border:1px solid #30363d;border-radius:6px;">
                            <span class="mono" style="font-size:13px;color:#58a6ff;word-break:break-all;">${escapeHtml(key)}${escapeHtml(expiryText)}</span>
                            <button class="btn btn-secondary btn-sm" data-copy="${escapeHtml(key)}" style="flex-shrink:0;padding:4px 10px;">
                                <i class="fas fa-copy"></i> 复制
                            </button>
                        </div>
                    `;
                }).join("");
                // 绑定复制按钮
                $$("[data-copy]", $("cardKeyResultsList")).forEach((el) => {
                    el.addEventListener("click", () => copyToClipboard(el.dataset.copy));
                });
                // 刷新卡密列表与统计
                await loadCardStats();
                await loadCards();
                await loadCardCreationLogs();
            } else {
                toastError(res.message || "生成失败");
            }
        } catch (_) { /* 已处理 */ } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-magic"></i> 生成卡密';
        }
    }

    /**
     * 撤销卡密
     * @param {string} cardId - 卡密 ID
     */
    async function revokeCard(cardId) {
        try {
            const res = await api(`/cards/${cardId}/revoke`, { method: "POST" });
            if (res.success) {
                toastSuccess("卡密已删除");
                await loadCardStats();
                await loadCards();
                await loadCardCreationLogs();
            }
        } catch (_) { /* 已处理 */ }
    }

    /** 加载卡密日志 (创建/删除 或 使用) */
    async function loadCardCreationLogs() {
        const container = $("cardCreationLogs");
        if (!container) return;
        const logType = ($("cardLogType") || {}).value || "creation";
        try {
            const endpoint = logType === "usage" ? "/cards/logs/usage" : "/cards/logs/creation";
            const res = await api(endpoint);
            const logs = (res.data || []);
            if (logs.length === 0) {
                container.innerHTML = `<div class="empty-state"><i class="fas fa-file-alt"></i><h3>暂无日志</h3><p>${logType === "usage" ? "卡密使用记录将显示在这里" : "卡密创建/删除记录将显示在这里"}</p></div>`;
                return;
            }
            container.innerHTML = logs.map((log) => {
                const t = formatTime(log.created_at || log.timestamp);
                if (logType === "usage") {
                    // 使用日志: 谁在什么时候用了哪张卡密
                    const badge = log.code_type === "register" ? '<span style="color:#58a6ff;">[注册]</span>' : '<span style="color:#d29922;">[面板]</span>';
                    return `<div style="display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;border-bottom:1px solid #21262d;font-size:12px;align-items:center;">
                        <span style="color:#484f58;white-space:nowrap;">${escapeHtml(t)}</span>
                        <span style="color:#3fb950;font-weight:600;">${escapeHtml(log.operator || "-")}</span>
                        <span style="color:#e6edf3;">使用了</span>
                        ${badge}
                        <span class="mono" style="color:#58a6ff;">${escapeHtml(log.code || "")}</span>
                    </div>`;
                }
                // 创建/删除日志
                const actBadge = log.action === "delete"
                    ? '<span style="color:#f85149;background:#f8514922;padding:2px 8px;border-radius:9999px;">删除</span>'
                    : '<span style="color:#3fb950;background:#3fb95022;padding:2px 8px;border-radius:9999px;">创建</span>';
                const typeBadge = log.code_type === "register" ? '[注册]' : '[面板]';
                return `<div style="display:flex;flex-wrap:wrap;gap:6px 12px;padding:8px 12px;border-bottom:1px solid #21262d;font-size:12px;align-items:center;">
                    <span style="color:#484f58;white-space:nowrap;">${escapeHtml(t)}</span>
                    ${actBadge}
                    <span style="color:#e6edf3;">${escapeHtml(log.operator || "admin")}</span>
                    <span style="color:#7d8590;">${typeBadge}</span>
                    <span class="mono" style="color:#58a6ff;">${escapeHtml(log.code || "")}</span>
                    <span style="color:#7d8590;">${escapeHtml(log.detail || "")}</span>
                </div>`;
            }).join("");
        } catch (_) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-file-alt"></i><h3>加载失败</h3></div>`;
        }
    }

    /* ======================================================================
       17. 用户管理
       ====================================================================== */

    /** 加载用户列表 */
    async function loadUsers() {
        const tbody = $("usersTableBody");
        try {
            const res = await api("/auth/users");
            if (res.success) {
                state.users = res.data || [];
                renderUsers(state.users);
            }
        } catch (_) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#7d8590;">加载失败</td></tr>`;
        }
    }

    /**
     * 渲染用户表格
     * @param {array} users - 用户数组
     */
    function renderUsers(users) {
        const tbody = $("usersTableBody");
        if (!users || users.length === 0) {
            tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#7d8590;">暂无用户</td></tr>`;
            return;
        }
        const currentRole = state.currentUser ? state.currentUser.role : "user";
        const isSuperadmin = currentRole === "superadmin";
        tbody.innerHTML = users.map((user) => {
            const userId = user.user_id || user.id;
            const role = user.role || (user.is_admin ? "admin" : "user");
            const status = user.status || "active";
            const roleLabel = ROLE_LABELS[role] || role;
            const createdAt = formatTime(user.created_at);
            const isSelf = state.currentUser && (state.currentUser.user_id === userId || state.currentUser.id === userId);
            const statusColor = status === "active" ? "#3fb950" : status === "banned" ? "#f85149" : "#d29922";
            const statusLabel = status === "active" ? "正常" : status === "banned" ? "封禁" : status;
            return `
                <tr>
                    <td>
                        <div style="display:flex;align-items:center;gap:8px;">
                            <div style="width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#58a6ff,#a371f7);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:600;">
                                ${escapeHtml((user.username || "U").charAt(0).toUpperCase())}
                            </div>
                            <span>${escapeHtml(user.username || "")}</span>
                            ${isSelf ? '<span style="font-size:10px;color:#58a6ff;background:#58a6ff22;padding:1px 6px;border-radius:9999px;">你</span>' : ""}
                        </div>
                    </td>
                    <td>
                        <select class="filter-select" data-role-select="${escapeHtml(userId)}" ${isSelf ? "disabled" : ""} style="font-size:12px;padding:4px 8px;">
                            <option value="user" ${role === "user" ? "selected" : ""}>普通用户</option>
                            <option value="admin" ${role === "admin" ? "selected" : ""}>管理员</option>
                        </select>
                    </td>
                    <td>
                        <span style="font-size:12px;color:${statusColor};font-weight:600;">${statusLabel}</span>
                    </td>
                    <td style="font-size:12px;">${escapeHtml(createdAt)}</td>
                    <td>
                        ${!isSelf
                            ? `<button class="btn btn-danger btn-sm" data-delete-user="${escapeHtml(userId)}" data-username="${escapeHtml(user.username || '')}"><i class="fas fa-trash"></i></button>`
                            : `<span style="color:#484f58;font-size:12px;">-</span>`}
                    </td>
                </tr>
            `;
        }).join("");

        // 绑定角色变更
        $$("[data-role-select]", tbody).forEach((sel) => {
            sel.addEventListener("change", () => changeUserRole(sel.dataset.roleSelect, sel.value));
        });
        // 绑定状态变更
        $$("[data-status-select]", tbody).forEach((sel) => {
            sel.addEventListener("change", () => changeUserStatus(sel.dataset.statusSelect, sel.value));
        });
        // 绑定删除用户
        $$("[data-delete-user]", tbody).forEach((btn) => {
            btn.addEventListener("click", () => {
                const userId = btn.dataset.deleteUser;
                const username = btn.dataset.username;
                confirmAction(
                    '<i class="fas fa-user-times"></i> 删除用户',
                    `确定要删除用户 <strong>${escapeHtml(username)}</strong> 吗？此操作不可撤销。`,
                    () => deleteUser(userId)
                );
            });
        });
    }

    /** 打开创建用户模态框 */
    function openCreateUserModal() {
        $("createUserForm").reset();
        $("newUserRole").value = "user";
        openModal("modalCreateUser");
        setTimeout(() => $("newUsername").focus(), 100);
    }

    /** 处理创建用户 */
    async function handleCreateUser(e) {
        e.preventDefault();
        const username = $("newUsername").value.trim();
        const password = $("newPassword").value;
        const role = $("newUserRole").value;
        const durationDays = $("newUserDuration").value;
        const btn = $("createUserSubmit");

        if (!username || !password) {
            toastWarn("请填写用户名和密码");
            return;
        }

        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

        try {
            const payload = { username, password, role };
            if (durationDays) payload.duration_days = parseInt(durationDays, 10);

            const res = await api("/auth/users", {
                method: "POST",
                body: payload,
            });
            if (res.success) {
                toastSuccess("用户创建成功");
                closeModal("modalCreateUser");
                await loadUsers();
            } else {
                toastError(res.message || "创建失败");
            }
        } catch (_) { /* 已处理 */ } finally {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-check"></i> 创建';
        }
    }

    /**
     * 删除用户
     * @param {string} userId - 用户 ID
     */
    async function deleteUser(userId) {
        try {
            const res = await api(`/auth/users/${userId}`, { method: "DELETE" });
            if (res.success || res === true) {
                toastSuccess("用户已删除");
                await loadUsers();
            }
        } catch (_) { /* 已处理 */ }
    }

    /**
     * 修改用户角色
     * @param {string} userId - 用户 ID
     * @param {string} role - 新角色
     */
    async function changeUserRole(userId, role) {
        try {
            const res = await api(`/auth/users/${userId}/role?role=${encodeURIComponent(role)}`, {
                method: "PUT",
            });
            if (res.success) {
                toastSuccess("角色已更新");
            } else {
                toastError("更新失败");
                await loadUsers();
            }
        } catch (_) {
            await loadUsers();
        }
    }

    /**
     * 修改用户状态
     * @param {string} userId - 用户 ID
     * @param {string} status - 新状态
     */
    async function changeUserStatus(userId, status) {
        try {
            const res = await api(`/auth/users/${userId}/status?status=${encodeURIComponent(status)}`, {
                method: "PUT",
            });
            if (res.success) {
                toastSuccess("状态已更新");
            } else {
                toastError("更新失败");
                await loadUsers();
            }
        } catch (_) {
            await loadUsers();
        }
    }

    /* ======================================================================
       18. 系统日志
       ====================================================================== */

    /** 加载系统日志 */
    async function loadSystemLogs() {
        const viewer = $("systemLogViewer");
        try {
            const params = new URLSearchParams();
            if (state.logFilterLevel) params.set("level", state.logFilterLevel);
            const query = params.toString() ? `?${params.toString()}` : "";
            const res = await api(`/logs/system${query}`);
            if (res.success && res.data && res.data.length > 0) {
                renderLogs(res.data, viewer);
            } else {
                viewer.innerHTML = renderEmptyState("fa-file-alt", "暂无日志", "系统日志将显示在这里");
            }
        } catch (_) {
            viewer.innerHTML = renderEmptyState("fa-file-alt", "暂无日志", "系统日志将显示在这里");
        }
    }

    /**
     * 渲染日志列表到容器
     * @param {array} logs - 日志数组
     * @param {HTMLElement} container - 容器元素
     */
    function renderLogs(logs, container) {
        if (!logs || logs.length === 0) {
            container.innerHTML = renderEmptyState("fa-file-alt", "暂无日志", "");
            return;
        }
        container.innerHTML = logs.map((log) => {
            const level = log.level || "info";
            const color = LOG_COLORS[level] || LOG_COLORS.info;
            const time = formatTime(log.created_at || log.timestamp);
            const message = log.message || log.action || log.detail || "";
            const source = log.source || log.target_type || "";
            return `
                <div style="display:flex;flex-wrap:wrap;gap:4px 10px;padding:8px 12px;border-bottom:1px solid #21262d;font-family:var(--font-mono);font-size:12px;line-height:1.6;writing-mode:horizontal-tb;">
                    <span style="color:#484f58;flex-shrink:0;white-space:nowrap;">${escapeHtml(time)}</span>
                    <span style="color:${color};font-weight:600;flex-shrink:0;white-space:nowrap;text-transform:uppercase;">${escapeHtml(level)}</span>
                    ${source ? `<span style="color:#7d8590;flex-shrink:0;white-space:nowrap;">[${escapeHtml(source)}]</span>` : ""}
                    <span style="color:#e6edf3;word-break:break-word;flex:1 1 240px;min-width:240px;">${escapeHtml(message)}</span>
                </div>
            `;
        }).join("");
        // 滚动到最新
        container.scrollTop = 0;
    }

    /* ======================================================================
       18b. 系统管理 (nv1 + 封号检测 + 统计)
       ====================================================================== */

    /** 加载系统管理页面数据 */
    async function loadSystemAdmin() {
        await Promise.allSettled([
            loadBanStatus(), loadSystemStatsDetail(),
            loadSauthAccounts(), loadSauthStatus(),
        ]);
    }

    // ---- 4399 账号池管理 ----

    async function loadSauthAccounts() {
        try {
            const res = await api("/sauth/accounts");
            const list = $("sauthAccountsList");
            const badge = $("sauthPoolBadge");
            if (res.success && res.data) {
                const accounts = res.data;
                badge.textContent = accounts.length + " 个账号";
                if (accounts.length === 0) {
                    list.innerHTML = `
                        <div class="empty-state" style="padding:20px;">
                            <i class="fas fa-users-slash" style="color:var(--text-tertiary);"></i>
                            <p style="font-size:13px;margin-top:4px;">暂无4399账号, 请先添加</p>
                        </div>`;
                    return;
                }
                list.innerHTML = accounts.map((acc) => {
                    const statusColor = acc.status === "active" ? "var(--color-success)"
                        : acc.status === "failed" ? "var(--color-danger)"
                        : "var(--text-tertiary)";
                    const statusText = acc.status === "active" ? "正常"
                        : acc.status === "failed" ? "失败"
                        : "禁用";
                    const lastRefresh = acc.last_refresh_at
                        ? new Date(acc.last_refresh_at * 1000).toLocaleString("zh-CN")
                        : "从未刷新";
                    return `
                        <div style="padding:12px;background:var(--bg-input);border-radius:var(--radius-md);display:flex;justify-content:space-between;align-items:center;">
                            <div>
                                <div style="font-weight:600;font-size:13px;">${escapeHtml(acc.username)}</div>
                                <div style="font-size:11px;color:var(--text-tertiary);">
                                    UID: ${escapeHtml(acc.uid || "未知")} | ${escapeHtml(lastRefresh)}
                                </div>
                            </div>
                            <div style="display:flex;gap:6px;align-items:center;">
                                <span style="font-size:11px;font-weight:600;color:${statusColor};">${statusText}</span>
                                <button class="btn btn-ghost btn-sm sauth-test-btn" data-id="${escapeHtml(acc.id)}" style="padding:2px 8px;font-size:11px;">
                                    <i class="fas fa-vial"></i> 测试
                                </button>
                                <button class="btn btn-ghost btn-sm sauth-del-btn" data-id="${escapeHtml(acc.id)}" style="padding:2px 8px;font-size:11px;color:var(--color-danger);">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        </div>`;
                }).join("");
                list.querySelectorAll(".sauth-test-btn").forEach((btn) => {
                    btn.addEventListener("click", () => handleSauthTest(btn.getAttribute("data-id")));
                });
                list.querySelectorAll(".sauth-del-btn").forEach((btn) => {
                    btn.addEventListener("click", () => handleSauthDelete(btn.getAttribute("data-id")));
                });
            }
        } catch (e) {
            console.error("加载4399账号列表失败:", e);
        }
    }

    async function loadSauthStatus() {
        try {
            const res = await api("/sauth/status");
            if (res.success && res.data) {
                const d = res.data;
                const cacheEl = $("sauthCacheStatus");
                if (d.is_valid) {
                    const ageMin = d.cached_age_seconds ? Math.floor(d.cached_age_seconds / 60) : 0;
                    cacheEl.textContent = `已缓存 (${ageMin}分钟前)`;
                    cacheEl.style.color = "var(--color-success)";
                } else {
                    cacheEl.textContent = d.cached ? "已过期" : "未缓存";
                    cacheEl.style.color = "var(--text-tertiary)";
                }
                const acc = d.accounts || {};
                $("sauthAccountStats").textContent =
                    `${acc.active || 0} / ${acc.failed || 0} / ${acc.disabled || 0}`;
            }
        } catch (e) {
            console.error("加载sauth状态失败:", e);
        }
    }

    async function handleSauthAdd() {
        const username = $("sauthAddUser").value.trim();
        const password = $("sauthAddPass").value.trim();
        if (!username || !password) {
            toastError("请填写4399用户名和密码");
            return;
        }
        try {
            const res = await api("/sauth/accounts", {
                method: "POST",
                body: JSON.stringify({ username, password }),
            });
            if (res.success) {
                toastSuccess(res.message || "4399账号添加成功");
                $("sauthAddUser").value = "";
                $("sauthAddPass").value = "";
                await loadSauthAccounts();
                await loadSauthStatus();
            } else {
                toastError("添加失败: " + (res.error || res.message || res.detail || "未知错误"));
            }
        } catch (e) {
            toastError("添加失败: " + e.message);
        }
    }

    async function handleSauthDelete(accountId) {
        if (!confirm("确定删除此4399账号?")) return;
        try {
            const res = await api("/sauth/accounts/" + accountId, { method: "DELETE" });
            if (res.success) {
                toastSuccess("账号已删除");
                await loadSauthAccounts();
                await loadSauthStatus();
            } else {
                toastError("删除失败: " + (res.error || res.message || res.detail || "未知错误"));
            }
        } catch (e) {
            toastError("删除失败: " + e.message);
        }
    }

    async function handleSauthTest(accountId) {
        toastInfo("正在测试4399账号登录...");
        try {
            const res = await api("/sauth/accounts/" + accountId + "/test", { method: "POST" });
            if (res.success) {
                toastSuccess("测试成功: " + (res.data?.message || "登录正常"));
            } else {
                toastError("测试失败: " + (res.data?.message || res.error || res.detail || "未知错误"));
            }
        } catch (e) {
            toastError("测试失败: " + e.message);
        }
    }

    async function handleSauthRefresh() {
        toastInfo("正在刷新sauth_json...");
        try {
            const res = await api("/sauth/refresh", { method: "POST" });
            if (res.success) {
                toastSuccess("sauth_json刷新成功");
                await loadSauthStatus();
            } else {
                toastError("刷新失败: " + (res.error || res.message || res.detail || "无可用4399账号"));
            }
        } catch (e) {
            toastError("刷新失败: " + e.message);
        }
    }

    /* nv1 功能已移除 (PT残留) */

    /** 加载封号检测状态 */
    async function loadBanStatus() {
        try {
            const res = await api("/system/ban/status");
            if (res.success && res.data) {
                const d = res.data;
                $("banTracked").textContent = d.total_tracked || 0;
                $("banSuspected").textContent = d.suspected_bans || 0;
                $("banThreshold").textContent = (d.threshold || 3) + " 次";

                const badge = $("banBadge");
                if (d.suspected_bans > 0) {
                    badge.textContent = d.suspected_bans + " 个封号";
                    badge.className = "badge badge-danger";
                } else {
                    badge.textContent = "正常";
                    badge.className = "badge badge-success";
                }
            }

            // 加载封号账号列表
            const accountsRes = await api("/system/ban/accounts");
            if (accountsRes.success && accountsRes.data && accountsRes.data.length > 0) {
                const listEl = $("bannedAccountsList");
                listEl.innerHTML = accountsRes.data.map((acc) => {
                    const time = formatTime(acc.last_failure_at);
                    return `
                        <div style="padding:8px;border:1px solid #21262d;border-radius:6px;margin-bottom:6px;">
                            <div style="display:flex;justify-content:space-between;align-items:center;">
                                <span class="mono" style="font-size:11px;">${escapeHtml(acc.account_id)}</span>
                                <button class="btn btn-ghost btn-sm clear-ban-btn" style="padding:2px 8px;font-size:11px;"
                                    data-account-id="${escapeHtml(acc.account_id)}">
                                    <i class="fas fa-times"></i> 解除
                                </button>
                            </div>
                            <div style="font-size:10px;color:#7d8590;margin-top:2px;">
                                失败 ${acc.failure_count} 次 | ${escapeHtml(time)}
                            </div>
                        </div>
                    `;
                }).join("");
                // 使用事件委托绑定点击事件 (避免 XSS)
                listEl.querySelectorAll(".clear-ban-btn").forEach((btn) => {
                    btn.addEventListener("click", () => {
                        window._clearBanFlag(btn.getAttribute("data-account-id"));
                    });
                });
            } else {
                $("bannedAccountsList").innerHTML = `
                    <div class="empty-state" style="padding:16px;">
                        <i class="fas fa-check-circle" style="color:var(--color-success);"></i>
                        <p style="font-size:13px;margin-top:4px;">暂无封号记录</p>
                    </div>
                `;
            }
        } catch (e) {
            console.error("加载封号状态失败:", e);
        }
    }

    /** 解除封号标记 */
    window._clearBanFlag = async function(accountId) {
        try {
            const res = await api(`/system/ban/${accountId}/clear`, { method: "POST" });
            if (res.success) {
                toastSuccess("封号标记已解除");
                await loadBanStatus();
            } else {
                toastError("操作失败: " + (res.message || ""));
            }
        } catch (e) {
            toastError("操作失败: " + e.message);
        }
    };

    /** 加载系统详细统计 */
    async function loadSystemStatsDetail() {
        try {
            const res = await api("/system/stats");
            if (res.success && res.data) {
                const d = res.data;

                // 更新统计卡片
                $("sysStatUsers").textContent = d.users.total;
                $("sysStatPanels").textContent = d.panels.total;
                $("sysStatBots").textContent = d.bots.usable;
                $("sysStatCards").textContent = d.cards.total;

                // 详细统计
                const detailEl = $("systemStatsDetail");
                const items = [
                    { label: "活跃用户", value: d.users.active, icon: "fa-user-check", color: "var(--color-success)" },
                    { label: "管理员", value: d.users.admins, icon: "fa-user-shield", color: "var(--color-primary)" },
                    { label: "封禁用户", value: d.users.banned, icon: "fa-user-slash", color: "var(--color-danger)" },
                    { label: "活跃面板", value: d.panels.active, icon: "fa-check-circle", color: "var(--color-success)" },
                    { label: "过期面板", value: d.panels.expired, icon: "fa-clock", color: "var(--color-warning)" },
                    { label: "可用账号", value: d.bots.usable, icon: "fa-user-check", color: "var(--color-success)" },
                    { label: "空壳账号", value: d.bots.empty, icon: "fa-user", color: "var(--text-secondary)" },
                    { label: "封禁账号", value: d.bots.banned, icon: "fa-user-slash", color: "var(--color-danger)" },
                    { label: "未使用卡密", value: d.cards.unused, icon: "fa-key", color: "var(--color-primary)" },
                    { label: "已使用卡密", value: d.cards.used, icon: "fa-check", color: "var(--color-success)" },
                    { label: "已撤销卡密", value: d.cards.revoked, icon: "fa-ban", color: "var(--color-danger)" },
                ];

                detailEl.innerHTML = items.map((item) => `
                    <div style="padding:12px;background:rgba(255,255,255,0.03);border-radius:8px;border:1px solid #21262d;">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
                            <i class="fas ${item.icon}" style="color:${item.color};font-size:14px;"></i>
                            <span style="font-size:12px;color:#7d8590;">${escapeHtml(item.label)}</span>
                        </div>
                        <div style="font-size:18px;font-weight:700;color:#e6edf3;">${escapeHtml(String(item.value))}</div>
                    </div>
                `).join("");
            }
        } catch (e) {
            console.error("加载系统统计失败:", e);
        }
    }

    /* ======================================================================
       19. 通用渲染辅助
       ====================================================================== */

    /**
     * 生成空状态 HTML
     * @param {string} icon - FontAwesome 图标类
     * @param {string} title - 标题
     * @param {string} desc - 描述
     * @returns {string} HTML
     */
    function renderEmptyState(icon, title, desc) {
        return `
            <div class="empty-state">
                <i class="fas ${icon}"></i>
                <h3>${escapeHtml(title)}</h3>
                ${desc ? `<p>${escapeHtml(desc)}</p>` : ""}
            </div>
        `;
    }

    /* ======================================================================
       19b. 商店 / 文件管理 / 管理后台 (Shop / Files / Admin)
       ====================================================================== */

    /* -------------------- 商店 (Shop) -------------------- */

    /**
     * 加载商店数据: 商品列表、余额、订单
     */
    async function loadShop() {
        // 并行加载商品、订单; 余额由 loadBalance() 单独加载 (仅商店视图调用)
        const [productsRes, ordersRes] = await Promise.allSettled([
            api("/shop/products"),
            api("/shop/orders"),
        ]);

        // 渲染余额 (商店视图)
        loadBalance();

        // 渲染商品 (按分类分组) - API 返回 {panel_card: [...], register_card: [...], ...}
        let productsGrouped = {};
        if (productsRes.status === "fulfilled" && productsRes.value) {
            const raw = productsRes.value.data || productsRes.value;
            if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                productsGrouped = raw;
            } else if (Array.isArray(raw)) {
                // 兼容: 如果直接返回数组, 按 category 分组
                raw.forEach((p) => {
                    const cat = p.category || p.type || "other";
                    if (!productsGrouped[cat]) productsGrouped[cat] = [];
                    productsGrouped[cat].push(p);
                });
            }
        }
        const cardProducts = [
            ...(productsGrouped.panel_card || []),
            ...(productsGrouped.register_card || []),
        ];
        const pluginProducts = productsGrouped.plugin_file || [];
        const buildingProducts = productsGrouped.building_file || [];
        renderProducts(cardProducts, "cardProducts");
        renderProducts(pluginProducts, "pluginProducts");
        renderProducts(buildingProducts, "buildingProducts");

        // 渲染订单
        let orders = [];
        if (ordersRes.status === "fulfilled" && ordersRes.value) {
            orders = ordersRes.value.data || ordersRes.value || [];
        }
        if (!Array.isArray(orders)) orders = [];
        renderOrders(orders, "myOrders");
    }

    /**
     * 购买商品
     * @param {number|string} productId - 商品 ID
     * @param {string} productName - 商品名称
     * @param {number} price - 价格
     */
    async function purchaseProduct(productId, productName, price) {
        if (!confirm(`确定要购买「${productName}」吗？将扣除 ${parseFloat(price).toFixed(2)} 余额。`)) return;
        try {
            const res = await api("/shop/purchase", {
                method: "POST",
                body: { product_id: productId },
            });
            if (res.success !== false) {
                toastSuccess("购买成功");
                // 显示卡密 (如果有)
                const cardKey = res.card_key || (res.data && res.data.card_key);
                if (cardKey) {
                    toastInfo("卡密: " + cardKey);
                    copyToClipboard(cardKey);
                }
                // 重新加载商店 (刷新余额与订单)
                loadShop();
            }
        } catch (err) {
            // 错误已由 api() 处理
        }
    }

    /**
     * 渲染商品卡片
     * @param {array} products - 商品数组
     * @param {string} containerId - 容器元素 ID
     */
    function renderProducts(products, containerId) {
        const container = $(containerId);
        if (!container) return;
        // 设置网格布局
        container.style.display = "grid";
        container.style.gridTemplateColumns = "repeat(auto-fill,minmax(200px,1fr))";
        container.style.gap = "12px";
        if (!products || products.length === 0) {
            container.innerHTML = renderEmptyState("fa-box-open", "暂无商品", "该分类下暂无可用商品");
            return;
        }
        container.innerHTML = products.map((p) => {
            const id = p.id || p.product_id;
            const name = p.name || p.product_name || "未命名";
            const desc = p.description || p.desc || "";
            const price = parseFloat(p.price || 0).toFixed(2);
            return `
                <div style="padding:14px;border:1px solid var(--border-muted);border-radius:10px;background:var(--bg-elevated);display:flex;flex-direction:column;gap:8px;">
                    <div style="font-weight:600;font-size:14px;color:var(--text-primary);word-break:break-word;">${escapeHtml(name)}</div>
                    ${desc ? `<div style="font-size:12px;color:var(--text-tertiary);flex:1;word-break:break-word;">${escapeHtml(desc)}</div>` : '<div style="flex:1;"></div>'}
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
                        <span style="color:#3fb950;font-weight:700;font-size:15px;"><i class="fas fa-coins"></i> ${escapeHtml(price)}</span>
                        <button class="btn btn-primary btn-sm" onclick="purchaseProduct('${escAttr(id)}','${escAttr(name)}',${escapeHtml(price)})"><i class="fas fa-shopping-cart"></i> 购买</button>
                    </div>
                </div>
            `;
        }).join("");
    }

    /**
     * 渲染订单列表
     * @param {array} orders - 订单数组
     * @param {string} containerId - 容器元素 ID
     */
    function renderOrders(orders, containerId) {
        const container = $(containerId);
        if (!container) return;
        if (!orders || orders.length === 0) {
            container.innerHTML = renderEmptyState("fa-receipt", "暂无订单", "购买的商品订单将显示在这里");
            return;
        }
        container.innerHTML = orders.map((o) => {
            const orderId = o.order_id || o.id || "-";
            const productName = o.product_name || o.name || "-";
            const price = parseFloat(o.price || 0).toFixed(2);
            const time = formatTime(o.created_at || o.created || o.date);
            const cardKey = o.card_key || o.cardkey || "";
            return `
                <div style="padding:12px;border-bottom:1px solid var(--border-muted);">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:13px;color:var(--text-primary);">${escapeHtml(productName)}</div>
                            <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">订单号: ${escapeHtml(orderId)}</div>
                            <div style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(time)}</div>
                            ${cardKey ? `<div style="margin-top:6px;padding:6px 8px;background:var(--bg-secondary);border-radius:6px;font-size:12px;color:var(--color-success);word-break:break-all;"><i class="fas fa-key"></i> ${escapeHtml(cardKey)} <button class="btn btn-secondary btn-sm" style="margin-left:4px;padding:2px 6px;font-size:11px;" onclick="copyToClipboard('${escAttr(cardKey)}')"><i class="fas fa-copy"></i></button></div>` : ""}
                        </div>
                        <span style="color:#3fb950;font-weight:600;font-size:13px;white-space:nowrap;"><i class="fas fa-coins"></i> ${escapeHtml(price)}</span>
                    </div>
                </div>
            `;
        }).join("");
    }

    /* -------------------- 文件管理 (Files) -------------------- */

    /**
     * 加载文件列表: 只加载自己上传的文件 (/files/my)
     * 公开文件 (插件/建筑) 已移至商店视图购买, 不再在文件管理显示
     */
    async function loadFiles() {
        const container = $("myFilesList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            const myRes = await api("/files/my");
            let myUploaded = [];
            if (myRes) {
                const d = myRes.data || myRes;
                if (d && typeof d === "object" && !Array.isArray(d)) {
                    // {uploaded: [...], purchased: [...]} -> 只显示自己上传的
                    myUploaded = Array.isArray(d.uploaded) ? d.uploaded : [];
                } else if (Array.isArray(d)) {
                    myUploaded = d;
                }
            }
            renderMyFiles(myUploaded, "myFilesList");
        } catch (err) {
            container.innerHTML = renderEmptyState("fa-exclamation-circle", "加载失败", err.message || "请稍后重试");
        }
    }

    /**
     * 显示/隐藏上传表单
     */
    function toggleUploadForm() {
        const card = $("uploadFormCard");
        if (card) card.style.display = card.style.display === "none" ? "block" : "none";
    }

    /**
     * 处理文件上传 (商店文件)
     */
    async function handleShopFileUpload() {
        const name = $("uploadName").value.trim();
        const category = $("uploadCategory").value;
        const price = $("uploadPrice").value;
        const desc = $("uploadDesc").value.trim();
        const fileInput = $("uploadFile");
        const file = fileInput.files[0];

        if (!name) { toastWarn("请输入文件名称"); return; }
        if (!file) { toastWarn("请选择文件"); return; }
        if (file.size > 512 * 1024) { toastWarn("文件大小不能超过 512KB"); return; }

        const btn = $("confirmUploadBtn");
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 上传中...';

        try {
            const formData = new FormData();
            formData.append("file", file);
            formData.append("name", name);
            formData.append("description", desc);
            formData.append("price", price);
            formData.append("category", category);

            const res = await api("/files/upload", { method: "POST", body: formData });
            if (res.success !== false) {
                toastSuccess("文件上传成功，等待审核");
                // 重置表单
                $("uploadName").value = "";
                $("uploadPrice").value = "0";
                $("uploadDesc").value = "";
                fileInput.value = "";
                toggleUploadForm();
                // 上传发生在商店视图, 刷新商店商品列表
                loadShop();
            }
        } catch (err) {
            // 错误已由 api() 处理
        } finally {
            btn.disabled = false;
            btn.innerHTML = oldHtml;
        }
    }

    /**
     * 购买文件
     * @param {number|string} fileId - 文件 ID
     * @param {string} fileName - 文件名称
     * @param {number} price - 价格
     */
    async function purchaseFile(fileId, fileName, price) {
        if (parseFloat(price) > 0) {
            if (!confirm(`确定要购买「${fileName}」吗？将扣除 ${parseFloat(price).toFixed(2)} 余额。`)) return;
        }
        try {
            const res = await api(`/files/${fileId}/purchase`, { method: "POST" });
            if (res.success !== false) {
                toastSuccess("购买成功，现在可以下载该文件");
                loadFiles();
            }
        } catch (err) {
            // 错误已由 api() 处理
        }
    }

    /**
     * 下载文件 (在新标签页打开, 带认证 token)
     * @param {number|string} fileId - 文件 ID
     */
    function downloadFile(fileId) {
        const token = state.token || "";
        window.open("/api/v2/files/" + fileId + "/download?token=" + encodeURIComponent(token), "_blank");
    }

    /**
     * 渲染文件列表 (公开文件 - 插件/建筑)
     * @param {array} files - 文件数组
     * @param {string} containerId - 容器元素 ID
     */
    function renderFileList(files, containerId) {
        const container = $(containerId);
        if (!container) return;
        if (!files || files.length === 0) {
            container.innerHTML = renderEmptyState("fa-folder-open", "暂无文件", "该分类下暂无可用文件");
            return;
        }
        container.innerHTML = files.map((f) => {
            const id = f.id || f.file_id;
            const name = f.name || f.filename || "未命名";
            const desc = f.description || f.desc || "";
            const price = parseFloat(f.price || 0).toFixed(2);
            const size = formatFileSize(f.file_size || f.size);
            const uploader = f.uploader || f.username || f.author || "";
            const purchased = f.purchased || f.owned || false;
            const isFree = parseFloat(f.price || 0) === 0;
            // 免费文件或已购买 -> 可下载; 否则显示购买按钮
            let actionHtml = "";
            if (isFree || purchased) {
                actionHtml = `<button class="btn btn-primary btn-sm" onclick="downloadFile('${escAttr(id)}')"><i class="fas fa-download"></i> 下载</button>`;
            } else {
                actionHtml = `<button class="btn btn-primary btn-sm" onclick="purchaseFile('${escAttr(id)}','${escAttr(name)}',${escapeHtml(price)})"><i class="fas fa-shopping-cart"></i> 购买</button>`;
            }
            return `
                <div style="padding:12px;border:1px solid var(--border-muted);border-radius:10px;background:var(--bg-elevated);margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                        <div style="flex:1;min-width:0;">
                            <div style="font-weight:600;font-size:13px;color:var(--text-primary);word-break:break-word;">${escapeHtml(name)}</div>
                            ${desc ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;word-break:break-word;">${escapeHtml(desc)}</div>` : ""}
                            <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">
                                ${size ? `<span style="margin-right:8px;"><i class="fas fa-file"></i> ${escapeHtml(size)}</span>` : ""}
                                ${uploader ? `<span><i class="fas fa-user"></i> ${escapeHtml(uploader)}</span>` : ""}
                            </div>
                        </div>
                        <div style="text-align:right;white-space:nowrap;">
                            <div style="color:#3fb950;font-weight:600;font-size:13px;margin-bottom:6px;">${isFree ? "免费" : '<i class="fas fa-coins"></i> ' + escapeHtml(price)}</div>
                            ${actionHtml}
                        </div>
                    </div>
                </div>
            `;
        }).join("");
    }

    /**
     * 渲染我的文件列表 (含审核状态)
     * @param {array} files - 文件数组
     * @param {string} containerId - 容器元素 ID
     */
    function renderMyFiles(files, containerId) {
        const container = $(containerId);
        if (!container) return;
        if (!files || files.length === 0) {
            container.innerHTML = renderEmptyState("fa-folder-open", "暂无文件", "您上传的文件将显示在这里");
            return;
        }
        const statusMap = {
            pending: { label: "待审核", color: "#d29922" },
            approved: { label: "已通过", color: "#3fb950" },
            rejected: { label: "已拒绝", color: "#f85149" },
        };
        container.innerHTML = files.map((f) => {
            const name = f.name || f.filename || "未命名";
            const desc = f.description || f.desc || "";
            const price = parseFloat(f.price || 0).toFixed(2);
            const category = f.category || "";
            const status = f.status || "pending";
            const fileId = f.file_id || f.id || "";
            const st = statusMap[status] || statusMap.pending;
            const catLabel = category === "plugin" ? "插件" : category === "building" ? "建筑" : category;
            return `
                <div style="padding:12px;border:1px solid var(--border-muted);border-radius:10px;background:var(--bg-elevated);margin-bottom:10px;">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                        <div style="flex:1;min-width:0;">
                            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                <span style="font-weight:600;font-size:13px;color:var(--text-primary);word-break:break-word;">${escapeHtml(name)}</span>
                                <span style="font-size:10px;padding:1px 8px;border-radius:9999px;background:${st.color}22;color:${st.color};border:1px solid ${st.color}44;">${escapeHtml(st.label)}</span>
                                <span style="font-size:10px;padding:1px 8px;border-radius:9999px;background:var(--bg-secondary);color:var(--text-tertiary);">${escapeHtml(catLabel)}</span>
                            </div>
                            ${desc ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;word-break:break-word;">${escapeHtml(desc)}</div>` : ""}
                            ${f.reject_reason ? `<div style="font-size:12px;color:#f85149;margin-top:4px;">拒绝原因: ${escapeHtml(f.reject_reason)}</div>` : ""}
                        </div>
                        <span style="color:#3fb950;font-weight:600;font-size:13px;white-space:nowrap;">${parseFloat(price) === 0 ? "免费" : '<i class="fas fa-coins"></i> ' + escapeHtml(price)}</span>
                    </div>
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        <button onclick="window.downloadUserFile('${escAttr(fileId)}')" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"><i class="fas fa-download"></i> 下载</button>
                        <button onclick="window.downloadFileZip('${escAttr(fileId)}')" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"><i class="fas fa-file-archive"></i> ZIP</button>
                        <button onclick="window.renameUserFile('${escAttr(fileId)}','${escAttr(name)}')" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"><i class="fas fa-edit"></i> 重命名</button>
                        <button onclick="window.updateUserFile('${escAttr(fileId)}','${escAttr(name)}','${escAttr(desc)}',${parseFloat(price)})" class="btn btn-secondary" style="padding:4px 10px;font-size:12px;"><i class="fas fa-cog"></i> 编辑</button>
                        <button onclick="window.deleteUserFile('${escAttr(fileId)}')" class="btn btn-danger" style="padding:4px 10px;font-size:12px;"><i class="fas fa-trash-alt"></i> 删除</button>
                    </div>
                </div>
            `;
        }).join("");
    }

    /* -------------------- 管理后台 (Admin) -------------------- */

    /**
     * 加载订单列表 (管理员)
     * @param {string} [searchQuery] - 搜索关键词 (可选)
     */
    async function loadAdminOrders(searchQuery) {
        const container = $("adminOrdersList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            let res;
            if (searchQuery && searchQuery.trim()) {
                res = await api("/shop/orders/search?q=" + encodeURIComponent(searchQuery.trim()));
            } else {
                res = await api("/shop/admin/orders");
            }
            let orders = [];
            if (res) {
                orders = res.data || res.orders || res || [];
            }
            if (!Array.isArray(orders)) orders = [];
            if (orders.length === 0) {
                container.innerHTML = renderEmptyState("fa-receipt", "暂无订单", searchQuery ? "未找到匹配的订单" : "所有订单将显示在这里");
                return;
            }
            container.innerHTML = orders.map((o) => {
                const orderId = o.order_id || o.id || "-";
                const productName = o.product_name || o.name || "-";
                const username = o.username || o.user_name || o.user || "-";
                const price = parseFloat(o.price || 0).toFixed(2);
                const time = formatTime(o.created_at || o.created || o.date);
                const cardKey = o.card_key || o.cardkey || "";
                return `
                    <div style="padding:12px 16px;border-bottom:1px solid var(--border-muted);">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
                            <div style="flex:1;min-width:200px;">
                                <div style="font-weight:600;font-size:13px;color:var(--text-primary);">${escapeHtml(productName)}</div>
                                <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">
                                    <span style="margin-right:8px;">订单号: ${escapeHtml(orderId)}</span>
                                    <span><i class="fas fa-user"></i> ${escapeHtml(username)}</span>
                                </div>
                                <div style="font-size:11px;color:var(--text-tertiary);margin-top:2px;">${escapeHtml(time)}</div>
                                ${cardKey ? `<div style="margin-top:4px;font-size:12px;color:var(--color-success);word-break:break-all;"><i class="fas fa-key"></i> ${escapeHtml(cardKey)}</div>` : ""}
                            </div>
                            <span style="color:#3fb950;font-weight:600;font-size:13px;white-space:nowrap;"><i class="fas fa-coins"></i> ${escapeHtml(price)}</span>
                        </div>
                    </div>
                `;
            }).join("");
        } catch (err) {
            container.innerHTML = renderEmptyState("fa-exclamation-circle", "加载失败", err.message || "请稍后重试");
        }
    }

    /**
     * 搜索订单
     */
    function searchOrders() {
        const q = $("orderSearchInput").value;
        loadAdminOrders(q);
    }

    /**
     * 加载待审核文件列表 (管理员)
     */
    async function loadReviewFiles() {
        const container = $("reviewFilesList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            const res = await api("/files/pending");
            let files = [];
            if (res) {
                files = res.data || res.files || res || [];
            }
            if (!Array.isArray(files)) files = [];
            if (files.length === 0) {
                container.innerHTML = renderEmptyState("fa-check-circle", "暂无待审核文件", "所有文件已审核完毕");
                return;
            }
            container.innerHTML = files.map((f) => {
                const id = f.id || f.file_id;
                const name = f.name || f.filename || "未命名";
                const desc = f.description || f.desc || "";
                const price = parseFloat(f.price || 0).toFixed(2);
                const category = f.category || "";
                const uploader = f.uploader || f.username || f.author || "-";
                const catLabel = category === "plugin" ? "插件" : category === "building" ? "建筑" : category;
                const size = formatFileSize(f.file_size || f.size);
                return `
                    <div style="padding:14px;border:1px solid var(--border-muted);border-radius:10px;background:var(--bg-elevated);margin-bottom:10px;">
                        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
                            <div style="flex:1;min-width:200px;">
                                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                                    <span style="font-weight:600;font-size:14px;color:var(--text-primary);">${escapeHtml(name)}</span>
                                    <span style="font-size:10px;padding:1px 8px;border-radius:9999px;background:var(--bg-secondary);color:var(--text-tertiary);">${escapeHtml(catLabel)}</span>
                                </div>
                                ${desc ? `<div style="font-size:12px;color:var(--text-tertiary);margin-top:4px;word-break:break-word;">${escapeHtml(desc)}</div>` : ""}
                                <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">
                                    <span style="margin-right:8px;"><i class="fas fa-user"></i> ${escapeHtml(uploader)}</span>
                                    ${size ? `<span style="margin-right:8px;"><i class="fas fa-file"></i> ${escapeHtml(size)}</span>` : ""}
                                    <span style="color:#3fb950;font-weight:600;"><i class="fas fa-coins"></i> ${parseFloat(price) === 0 ? "免费" : escapeHtml(price)}</span>
                                </div>
                            </div>
                            <div style="display:flex;gap:8px;">
                                <button class="btn btn-primary btn-sm" onclick="approveFile('${escAttr(id)}')"><i class="fas fa-check"></i> 通过</button>
                                <button class="btn btn-danger btn-sm" onclick="rejectFile('${escAttr(id)}')"><i class="fas fa-times"></i> 拒绝</button>
                            </div>
                        </div>
                    </div>
                `;
            }).join("");
        } catch (err) {
            container.innerHTML = renderEmptyState("fa-exclamation-circle", "加载失败", err.message || "请稍后重试");
        }
    }

    /**
     * 审核通过文件 (管理员)
     * @param {number|string} fileId - 文件 ID
     */
    async function approveFile(fileId) {
        try {
            const res = await api(`/files/${fileId}/approve`, { method: "POST" });
            if (res.success !== false) {
                toastSuccess("文件已通过审核");
                loadReviewFiles();
            }
        } catch (err) {
            // 错误已由 api() 处理
        }
    }

    /**
     * 拒绝文件 (管理员)
     * @param {number|string} fileId - 文件 ID
     */
    async function rejectFile(fileId) {
        const reason = prompt("请输入拒绝原因:");
        if (reason === null) return; // 用户取消
        try {
            const formData = new FormData();
            formData.append("reason", reason || "");
            const res = await api(`/files/${fileId}/reject`, {
                method: "POST",
                body: formData,
            });
            if (res.success !== false) {
                toastSuccess("文件已拒绝");
                loadReviewFiles();
            }
        } catch (err) {
            // 错误已由 api() 处理
        }
    }

    /**
     * 加载用户余额列表 (管理员)
     */
    async function loadUsersBalance() {
        const container = $("usersBalanceList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-spinner fa-spin"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            const res = await api("/auth/users");
            let users = [];
            if (res) {
                users = res.data || res.users || res || [];
            }
            if (!Array.isArray(users)) users = [];
            state.users = users;
            if (users.length === 0) {
                container.innerHTML = renderEmptyState("fa-users", "暂无用户", "用户列表为空");
                return;
            }
            container.innerHTML = users.map((u) => {
                const username = u.username || "-";
                const balance = parseFloat(u.balance != null ? u.balance : (u.wallet_balance || 0)).toFixed(2);
                const role = u.role || "user";
                const roleLabel = ROLE_LABELS[role] || role;
                return `
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--border-muted);">
                        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0;">
                            <div style="width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,#58a6ff,#a371f7);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:600;flex-shrink:0;">
                                ${escapeHtml((username || "U").charAt(0).toUpperCase())}
                            </div>
                            <div style="min-width:0;">
                                <div style="font-weight:500;font-size:13px;color:var(--text-primary);">${escapeHtml(username)}</div>
                                <div style="font-size:11px;color:var(--text-tertiary);">${escapeHtml(roleLabel)}</div>
                            </div>
                        </div>
                        <span style="color:#3fb950;font-weight:700;font-size:14px;white-space:nowrap;"><i class="fas fa-coins"></i> ${escapeHtml(balance)}</span>
                    </div>
                `;
            }).join("");
        } catch (err) {
            container.innerHTML = renderEmptyState("fa-exclamation-circle", "加载失败", err.message || "请稍后重试");
        }
    }

    /**
     * 设置用户余额 (管理员)
     */
    async function setUserBalance() {
        const username = $("balanceUsername").value.trim();
        const amount = $("balanceAmount").value;
        if (!username) { toastWarn("请输入用户名"); return; }
        if (amount === "" || amount === null) { toastWarn("请输入余额"); return; }

        // 通过用户名查找 user_id
        const user = state.users.find((u) => u.username === username);
        if (!user) {
            toastError("未找到该用户: " + username);
            return;
        }
        const userId = user.user_id || user.id;
        const btn = $("setBalanceBtn");
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 设置中...';

        try {
            const res = await api(`/shop/balance/${userId}`, {
                method: "POST",
                body: { balance: parseFloat(amount) },
            });
            if (res.success !== false) {
                toastSuccess(`已设置 ${username} 的余额为 ${parseFloat(amount).toFixed(2)}`);
                $("balanceUsername").value = "";
                $("balanceAmount").value = "";
                loadUsersBalance();
            }
        } catch (err) {
            // 错误已由 api() 处理
        } finally {
            btn.disabled = false;
            btn.innerHTML = oldHtml;
        }
    }

    /* ======================================================================
       20. 事件绑定
       ====================================================================== */

    /** 加载可用的Cookie池账号 */
    async function loadCookiePoolAccounts() {
        try {
            const res = await api("/bots/accounts?status=active");
            if (res.success && res.data) {
                return res.data;
            }
            return [];
        } catch (_) {
            return [];
        }
    }

    /** 切换创建机器人的账号来源 */
    function toggleCreateBotAccountSource() {
        const source = $("createBotAccountSource");
        if (!source) return;
        const val = source.value;
        $("createBot4399Fields").style.display = val === "new" ? "block" : "none";
        $("createBotPoolInfo").style.display = val === "pool" ? "block" : "none";
        $("createBotManualFields").style.display = val === "manual" ? "block" : "none";
    }

    /** 切换手动输入凭证的认证类型 */
    function toggleManualAuthType() {
        const checked = document.querySelector('input[name="manualAuthType"]:checked');
        if (!checked) return;
        const is4399 = checked.value === "4399";
        $("manual4399Fields").style.display = is4399 ? "block" : "none";
        $("manualCookieFields").style.display = is4399 ? "none" : "block";
    }

    /** 创建机器人 */
    async function handleCreateBot() {
        const accountSource = $("createBotAccountSource").value;

        const payload = {
            account_source: accountSource,
        };

        if (accountSource === "new") {
            // 自动注册新4399账号 - 不需要服务器编号, 后续在面板配置中填写
        } else if (accountSource === "manual") {
            const authType = document.querySelector('input[name="manualAuthType"]:checked');
            if (authType && authType.value === "4399") {
                payload.username_4399 = $("createBotManualUser").value.trim();
                payload.password_4399 = $("createBotManualPass").value.trim();
                if (!payload.username_4399 || !payload.password_4399) {
                    toastError("请填写4399账号密码");
                    return;
                }
            } else {
                payload.sauth_json = $("createBotSauthJson").value.trim();
                if (!payload.sauth_json) {
                    toastError("请粘贴 sauth_json 或 Cookie");
                    return;
                }
            }
        } else if (accountSource === "pool") {
            // 从Cookie池选择 - 服务器编号后续在面板配置中填写
        }

        try {
            const btn = $("btnCreateBot");
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';

            const res = await api("/bots/create", {
                method: "POST",
                body: JSON.stringify(payload),
            });

            if (res.success) {
                toastSuccess("账号创建成功！");
                $("createBotManualUser") && ($("createBotManualUser").value = "");
                $("createBotManualPass") && ($("createBotManualPass").value = "");
                $("createBotSauthJson") && ($("createBotSauthJson").value = "");
                switchView("bots");
                await loadBots();
            } else {
                toastError(res.detail || "创建失败");
            }
        } catch (e) {
            toastError("创建失败: " + (e.message || "未知错误"));
        } finally {
            const btn = $("btnCreateBot");
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-plus"></i> 创建账号';
        }
    }

    /** 获取4399验证码图片 */
    async function fetchCreateBotCaptcha() {
        const imgBox = $("createBotCaptchaImg");
        if (!imgBox) return;
        try {
            imgBox.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary);">加载中...</span>';
            const res = await api("/accounts/login4399/captcha");
            if (res.success && res.data && res.data.image) {
                // 后端返回纯 base64, 需要添加 data URL 前缀
                const imgSrc = res.data.image.startsWith("data:")
                    ? res.data.image
                    : `data:image/jpeg;base64,${res.data.image}`;
                imgBox.innerHTML = `<img src="${imgSrc}" style="width:100%;height:100%;object-fit:cover;" alt="验证码">`;
                imgBox.dataset.captchaId = res.data.id || res.data.captcha_id || "";
            } else {
                imgBox.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary);">点击重试</span>';
            }
        } catch (e) {
            imgBox.innerHTML = '<span style="font-size:11px;color:var(--text-tertiary);">点击重试</span>';
        }
    }

    /* ======================================================================
       19b. MPay 手机号登录 (网易官方 API, 免费)
       流程: 注册设备 -> 输入手机号 -> 发送短信 -> (normal 输入验证码 /
              upstream 上行短信) -> 验证登录 -> 自动添加账号
       ====================================================================== */

    /** MPay 设备注册中的原始 loading UI (用于失败重试时恢复) */
    const MPAY_DEVICE_LOADING_HTML = `
        <i class="fas fa-spinner fa-spin" style="font-size:24px;color:var(--color-primary);"></i>
        <div style="font-size:13px;color:var(--text-secondary);margin-top:12px;">正在注册设备...</div>
        <div style="font-size:11px;color:var(--text-tertiary);margin-top:4px;">这是自动步骤, 无需操作</div>`;

    /** 重置 MPay 登录状态并恢复 modal 初始 UI */
    function resetMpayLoginState() {
        state.mpay.step = "device";
        state.mpay.deviceId = "";
        state.mpay.phone = "";
        state.mpay.mode = "";
        state.mpay.inProgress = false;

        // 恢复设备注册 loading 区原始内容
        $("mpayDeviceLoading").innerHTML = MPAY_DEVICE_LOADING_HTML;

        // 隐藏所有步骤内容
        $("mpayDeviceLoading").style.display = "none";
        $("mpayPhoneStep").style.display = "none";
        $("mpayCodeStep").style.display = "none";
        $("mpayUpstreamStep").style.display = "none";

        // 隐藏所有底部操作按钮
        $("mpaySendSmsBtn").style.display = "none";
        $("mpayVerifyBtn").style.display = "none";
        $("mpayVerifyBtn").disabled = false;
        $("mpaySendSmsBtn").disabled = false;
        $("mpayVerifyBtn").innerHTML = '<i class="fas fa-check"></i> 确认登录';
        $("mpaySendSmsBtn").innerHTML = '<i class="fas fa-paper-plane"></i> 发送验证码';

        // 清空输入
        $("mpayPhone").value = "";
        $("mpayCode").value = "";
        $("mpayUpContent").value = "";

        mpayUpdateSteps("device");
    }

    /** 更新步骤指示器高亮状态
     * @param {string} currentStep - device / phone / code / upstream
     */
    function mpayUpdateSteps(currentStep) {
        const stepEls = [$("mpayStep1"), $("mpayStep2"), $("mpayStep3")];
        // code 与 upstream 都属于第 3 步
        const currentIdx = (currentStep === "code" || currentStep === "upstream") ? 2
                         : currentStep === "phone" ? 1
                         : 0;
        stepEls.forEach((el, i) => {
            if (!el) return;
            el.classList.remove("active", "done");
            if (i < currentIdx) el.classList.add("done");
            else if (i === currentIdx) el.classList.add("active");
        });
    }

    /** 打开 MPay 登录弹窗并自动注册设备 */
    async function openMpayLoginModal() {
        resetMpayLoginState();
        openModal("modalMpayLogin");
        // 自动调用设备注册
        await mpayRegisterDevice();
    }

    /** 步骤1: 注册 MPay 设备 (自动, 不需要用户输入) */
    async function mpayRegisterDevice() {
        state.mpay.step = "device";
        state.mpay.inProgress = true;
        $("mpayDeviceLoading").innerHTML = MPAY_DEVICE_LOADING_HTML;
        $("mpayDeviceLoading").style.display = "block";
        $("mpayPhoneStep").style.display = "none";
        $("mpayCodeStep").style.display = "none";
        $("mpayUpstreamStep").style.display = "none";
        $("mpaySendSmsBtn").style.display = "none";
        $("mpayVerifyBtn").style.display = "none";
        mpayUpdateSteps("device");

        try {
            const res = await api("/api/accounts/mpay/device", { method: "POST" });
            if (res && res.success) {
                state.mpay.deviceId = (res.data && res.data.device_id) || "";
                toastSuccess(res.message || "设备注册成功");
                mpayShowPhoneStep();
            } else {
                const msg = (res && (res.message || res.error)) || "设备注册失败";
                toastError(msg);
                mpayShowDeviceError(msg);
            }
        } catch (e) {
            const msg = (e && e.message) || "设备注册失败";
            mpayShowDeviceError(msg);
        } finally {
            state.mpay.inProgress = false;
        }
    }

    /** 在设备注册区显示错误信息与重试按钮 */
    function mpayShowDeviceError(msg) {
        $("mpayDeviceLoading").innerHTML = `
            <i class="fas fa-exclamation-circle" style="font-size:24px;color:var(--color-danger);"></i>
            <div style="font-size:13px;color:var(--color-danger);margin-top:12px;word-break:break-word;">${escapeHtml(msg)}</div>
            <button class="btn btn-secondary" id="mpayRetryDeviceBtn" style="margin-top:12px;">
                <i class="fas fa-redo"></i> 重试
            </button>`;
        const retryBtn = $("mpayRetryDeviceBtn");
        if (retryBtn) retryBtn.addEventListener("click", mpayRegisterDevice);
    }

    /** 切换到手机号输入步骤 */
    function mpayShowPhoneStep() {
        state.mpay.step = "phone";
        $("mpayDeviceLoading").style.display = "none";
        $("mpayPhoneStep").style.display = "block";
        $("mpayCodeStep").style.display = "none";
        $("mpayUpstreamStep").style.display = "none";
        $("mpaySendSmsBtn").style.display = "inline-flex";
        $("mpayVerifyBtn").style.display = "none";
        mpayUpdateSteps("phone");
        const phoneInput = $("mpayPhone");
        if (phoneInput) phoneInput.focus();
    }

    /** 步骤2: 发送短信验证码 */
    async function handleMpaySendSms() {
        if (state.mpay.inProgress) return;
        const phone = $("mpayPhone").value.trim();
        if (!phone) {
            toastError("请输入手机号");
            return;
        }
        if (!/^1\d{10}$/.test(phone)) {
            toastError("手机号格式不正确, 请输入 11 位手机号");
            return;
        }
        state.mpay.phone = phone;
        state.mpay.inProgress = true;

        const btn = $("mpaySendSmsBtn");
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';

        try {
            const res = await api("/api/accounts/mpay/send-sms", {
                method: "POST",
                body: { phone: phone },
            });
            if (res && res.success) {
                const data = res.data || {};
                state.mpay.mode = data.mode || "normal";
                if (state.mpay.mode === "upstream") {
                    mpayShowUpstreamStep(data);
                } else {
                    mpayShowCodeStep();
                }
                toastSuccess(res.message || "验证码已发送");
            } else {
                const msg = (res && (res.message || res.error)) || "发送短信失败";
                toastError(msg);
            }
        } catch (e) {
            toastError((e && e.message) || "发送短信失败");
        } finally {
            state.mpay.inProgress = false;
            btn.disabled = false;
            btn.innerHTML = oldHtml;
        }
    }

    /** 切换到验证码输入步骤 (normal 模式) */
    function mpayShowCodeStep() {
        state.mpay.step = "code";
        $("mpayDeviceLoading").style.display = "none";
        $("mpayPhoneStep").style.display = "none";
        $("mpayCodeStep").style.display = "block";
        $("mpayUpstreamStep").style.display = "none";
        $("mpaySendSmsBtn").style.display = "none";
        $("mpayVerifyBtn").style.display = "inline-flex";
        $("mpayPhoneDisplay").textContent = maskPhone(state.mpay.phone);
        mpayUpdateSteps("code");
        const codeInput = $("mpayCode");
        if (codeInput) codeInput.focus();
    }

    /** 切换到上行短信提示步骤 (upstream 模式) */
    function mpayShowUpstreamStep(data) {
        state.mpay.step = "upstream";
        $("mpayDeviceLoading").style.display = "none";
        $("mpayPhoneStep").style.display = "none";
        $("mpayCodeStep").style.display = "none";
        $("mpayUpstreamStep").style.display = "block";
        $("mpaySendSmsBtn").style.display = "none";
        $("mpayVerifyBtn").style.display = "inline-flex";
        // 填充上行短信信息
        $("mpayUpstreamPhone").textContent = maskPhone(state.mpay.phone);
        $("mpayUpstreamContent").textContent = data.content || "手机登录";
        $("mpayUpstreamNumber").textContent = data.number || "见短信提示";
        $("mpayUpstreamTips").textContent = data.tips || "";
        // 默认填充 up_content (便于直接确认)
        const upInput = $("mpayUpContent");
        if (upInput && !upInput.value.trim()) upInput.value = data.content || "手机登录";
        mpayUpdateSteps("upstream");
    }

    /** 步骤3: 验证短信并完成登录 */
    async function handleMpayVerify() {
        if (state.mpay.inProgress) return;
        const phone = state.mpay.phone;
        if (!phone) {
            toastError("手机号丢失, 请重新输入");
            mpayShowPhoneStep();
            return;
        }

        const mode = state.mpay.mode;
        let code = "";
        let upContent = "";
        if (mode === "upstream") {
            upContent = $("mpayUpContent").value.trim();
            if (!upContent) {
                toastError("请输入上行短信内容");
                return;
            }
        } else {
            code = $("mpayCode").value.trim();
            if (!code) {
                toastError("请输入收到的短信验证码");
                return;
            }
        }

        state.mpay.inProgress = true;
        const btn = $("mpayVerifyBtn");
        const oldHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';

        try {
            const res = await api("/api/accounts/mpay/verify", {
                method: "POST",
                body: {
                    phone: phone,
                    code: code,
                    up_content: upContent,
                },
            });
            if (res && res.success) {
                const data = res.data || {};
                const nickname = data.nickname || "";
                const userId = data.user_id || "";
                toastSuccess(res.message || "登录成功! 账号已添加");
                closeModal("modalMpayLogin");
                resetMpayLoginState();
                // 成功后刷新账号列表
                await refreshAccountsAfterMpay();
                // 提示账号信息
                if (nickname || userId) {
                    setTimeout(() => {
                        toastInfo(`已添加账号: ${nickname || "未知"}${userId ? " (UID: " + userId + ")" : ""}`);
                    }, 600);
                }
            } else {
                const msg = (res && (res.message || res.error)) || "验证失败";
                toastError(msg);
            }
        } catch (e) {
            toastError((e && e.message) || "验证失败");
        } finally {
            state.mpay.inProgress = false;
            btn.disabled = false;
            btn.innerHTML = oldHtml;
        }
    }

    /** MPay 登录成功后刷新账号列表 (Cookie 池 + 机器人列表) */
    async function refreshAccountsAfterMpay() {
        try {
            // 刷新 Cookie 池 (创建机器人页面使用)
            await loadCookiePoolAccounts();
        } catch (_) { /* 忽略 */ }
        // 如果当前在机器人列表页, 刷新列表
        if (state.currentView === "bots") {
            try { await loadBots(); } catch (_) { /* 忽略 */ }
        }
    }

    /** 手机号脱敏: 138****1234 */
    function maskPhone(phone) {
        if (!phone || phone.length < 7) return phone || "";
        return phone.slice(0, 3) + "****" + phone.slice(-4);
    }

    /* 替换卡密已移除 (PT残留, 后端无此功能) */

    function bindEvents() {
        // ---- 认证 Tab 切换 ----
        if ($("tabLogin")) $("tabLogin").addEventListener("click", () => switchAuthTab("login"));
        if ($("tabRegister")) $("tabRegister").addEventListener("click", () => switchAuthTab("register"));
        if ($("authToggle")) $("authToggle").addEventListener("click", () => {
            const isLoginVisible = !$("loginForm").classList.contains("hidden");
            switchAuthTab(isLoginVisible ? "register" : "login");
        });

        // ---- 登录 / 注册表单 ----
        if ($("loginForm")) $("loginForm").addEventListener("submit", handleLogin);
        if ($("registerForm")) $("registerForm").addEventListener("submit", handleRegister);
        // 验证码刷新按钮已移除: 改为点击图片刷新 (onclick 绑定在 index.html)

        // ---- 卡密列表折叠 (默认展开, 点击表头折叠) ----
        if ($("cardsListHeader")) $("cardsListHeader").addEventListener("click", (e) => {
            // 点击筛选器不折叠
            if (e.target.closest(".filter-select, .filter-checkbox")) return;
            const wrap = $("cardsTableWrap");
            const toggle = $("cardsListToggle");
            if (!wrap) return;
            const isHidden = wrap.style.display === "none";
            wrap.style.display = isHidden ? "" : "none";
            if (toggle) toggle.textContent = isHidden ? "▼ 已展开" : "▶ 已折叠";
        });

        // ---- 顶部栏 ----
        if ($("menuToggle")) $("menuToggle").addEventListener("click", toggleSidebar);
        const themeToggle = $("themeToggle");
        if (themeToggle) themeToggle.addEventListener("click", toggleTheme);
        if ($("topbarUser")) $("topbarUser").addEventListener("click", (e) => {
            e.stopPropagation();
            toggleUserMenu();
        });
        // 点击其他区域关闭用户菜单
        document.addEventListener("click", (e) => {
            if (!e.target.closest("#userMenu") && !e.target.closest("#topbarUser")) {
                closeUserMenu();
            }
        });
        // 用户菜单项
        $$("[data-action]").forEach((item) => {
            if (item.id === "logoutBtn") return; // 登出单独绑定
            item.addEventListener("click", () => {
                closeUserMenu();
                const action = item.dataset.action;
                if (action === "change-password") {
                    openModal("modalChangePassword");
                } else if (action === "dashboard" || action === "profile") {
                    switchView("dashboard");
                }
            });
        });
        if ($("logoutBtn")) $("logoutBtn").addEventListener("click", handleLogout);

        // 修改密码提交
        if ($("changePwdSubmit")) $("changePwdSubmit").addEventListener("click", async () => {
            const oldPwd = $("changePwdOld").value;
            const newPwd = $("changePwdNew").value;
            const confirmPwd = $("changePwdConfirm").value;
            if (!oldPwd || !newPwd || !confirmPwd) {
                toastError("请填写所有字段");
                return;
            }
            if (newPwd.length < 6) {
                toastError("新密码至少 6 位");
                return;
            }
            if (newPwd !== confirmPwd) {
                toastError("两次输入的新密码不一致");
                return;
            }
            if (newPwd === oldPwd) {
                toastError("新密码不能与当前密码相同");
                return;
            }
            try {
                $("changePwdSubmit").disabled = true;
                const res = await api("/auth/change-password", {
                    method: "POST",
                    body: JSON.stringify({ old_password: oldPwd, new_password: newPwd }),
                });
                toastSuccess("密码修改成功");
                closeModal("modalChangePassword");
                $("changePwdOld").value = "";
                $("changePwdNew").value = "";
                $("changePwdConfirm").value = "";
            } catch (e) {
                toastError(e.message || "密码修改失败");
            } finally {
                $("changePwdSubmit").disabled = false;
            }
        });

        // ---- 侧边栏 ----
        if ($("sidebarBackdrop")) $("sidebarBackdrop").addEventListener("click", closeSidebar);
        // 导航项
        $$(".nav-item").forEach((item) => {
            item.addEventListener("click", () => switchView(item.dataset.view));
        });

        // ---- Dashboard ----
        if ($("refreshActivity")) $("refreshActivity").addEventListener("click", loadActivity);
        // 最近活动 折叠/展开
        const toggleActivityBtn = $("toggleActivity");
        if (toggleActivityBtn) {
            toggleActivityBtn.addEventListener("click", toggleActivityCollapse);
        }
        // 恢复上次的折叠状态
        restoreActivityCollapse();
        // 快捷操作按钮
        $$("[data-quick]").forEach((btn) => {
            btn.addEventListener("click", () => {
                const target = btn.dataset.quick;
                if (target === "panels") {
                    switchView("panels");
                    setTimeout(openCreatePanelModal, 300);
                } else if (target === "bot-create") {
                    switchView("bot-create");
                } else if (target === "admin-cards") {
                    switchView("admin-cards");
                    setTimeout(openCreateCardModal, 300);
                }
            });
        });

        // ---- 面板列表 ----
        if ($("refreshPanels")) $("refreshPanels").addEventListener("click", loadPanels);
        if ($("btnCreatePanel")) $("btnCreatePanel").addEventListener("click", openCreatePanelModal);
        // 面板范围切换 (我的面板/全部面板) - 仅管理员可见
        $$("[data-panel-scope]").forEach((tab) => {
            tab.addEventListener("click", () => {
                const scope = tab.dataset.panelScope;
                if (!isAdmin() || scope === state.panelScope) return;
                state.panelScope = scope;
                $$("[data-panel-scope]").forEach((t) => t.classList.toggle("active", t === tab));
                loadPanels();
            });
        });

        // ---- 面板详情 ----
        if ($("backToPanels")) $("backToPanels").addEventListener("click", () => {
            // 返回直接返回 (配置自动保存, 无需确认)
            switchView("panels");
        });
        if ($("btnStartBot")) $("btnStartBot").addEventListener("click", startBot);
        if ($("btnStopBot")) $("btnStopBot").addEventListener("click", stopBot);
        if ($("btnRestartBot")) $("btnRestartBot").addEventListener("click", restartBot);
        if ($("btnRenewPanel")) $("btnRenewPanel").addEventListener("click", () => {
            if (state.currentPanelId) openRenewPanelModal(state.currentPanelId);
        });
        if ($("btnDeletePanel")) $("btnDeletePanel").addEventListener("click", () => {
            if (state.currentPanelId) {
                const panel = state.panelDetail;
                confirmAction(
                    '<i class="fas fa-exclamation-triangle"></i> 删除面板',
                    `确定要删除面板 <strong>${escapeHtml(panel ? panel.name : "")}</strong> 吗？此操作不可撤销。`,
                    () => handleDeletePanel(state.currentPanelId)
                );
            }
        });

        // ---- 创建机器人 ----
        if ($("btnCreateBot")) $("btnCreateBot").addEventListener("click", handleCreateBot);
        if ($("createBotAccountSource")) $("createBotAccountSource").addEventListener("change", toggleCreateBotAccountSource);
        if ($("createBotCaptchaImg")) $("createBotCaptchaImg").addEventListener("click", fetchCreateBotCaptcha);
        $("manualAuth4399") && $("manualAuth4399").addEventListener("change", toggleManualAuthType);
        $("manualAuthCookie") && $("manualAuthCookie").addEventListener("change", toggleManualAuthType);

        // ---- MPay 手机号登录 ----
        const btnMpayLogin = $("btnMpayLogin");
        if (btnMpayLogin) btnMpayLogin.addEventListener("click", openMpayLoginModal);
        const mpaySendSmsBtn = $("mpaySendSmsBtn");
        if (mpaySendSmsBtn) mpaySendSmsBtn.addEventListener("click", handleMpaySendSms);
        const mpayVerifyBtn = $("mpayVerifyBtn");
        if (mpayVerifyBtn) mpayVerifyBtn.addEventListener("click", handleMpayVerify);
        // 手机号输入框: 回车直接发送验证码
        const mpayPhoneInput = $("mpayPhone");
        if (mpayPhoneInput) mpayPhoneInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); handleMpaySendSms(); }
        });
        // 验证码输入框: 回车直接确认登录
        const mpayCodeInput = $("mpayCode");
        if (mpayCodeInput) mpayCodeInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") { e.preventDefault(); handleMpayVerify(); }
        });

        // ---- 替换Key (已移除 PT残留) ----

        // ---- 控制台 Tab ----
        $$(".console-tab").forEach((tab) => {
            tab.addEventListener("click", () => switchConsoleTab(tab.dataset.consoleTab));
        });

        // ---- 终端 ----
        if ($("consoleClearBtn")) $("consoleClearBtn").addEventListener("click", clearTerminal);
        if ($("consoleAutoscrollBtn")) $("consoleAutoscrollBtn").addEventListener("click", toggleAutoscroll);
        if ($("terminalSendBtn")) $("terminalSendBtn").addEventListener("click", () => {
            const input = $("terminalInput");
            sendTerminalCommand(input.value);
            input.value = "";
            state.terminalHistoryIndex = state.terminalHistory.length;
        });
        if ($("terminalInput")) $("terminalInput").addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                const input = $("terminalInput");
                sendTerminalCommand(input.value);
                input.value = "";
                state.terminalHistoryIndex = state.terminalHistory.length;
            } else if (e.key === "ArrowUp") {
                // 浏览历史命令
                e.preventDefault();
                if (state.terminalHistory.length > 0 && state.terminalHistoryIndex > 0) {
                    state.terminalHistoryIndex--;
                    $("terminalInput").value = state.terminalHistory[state.terminalHistoryIndex];
                }
            } else if (e.key === "ArrowDown") {
                // 浏览历史命令
                e.preventDefault();
                if (state.terminalHistoryIndex < state.terminalHistory.length - 1) {
                    state.terminalHistoryIndex++;
                    $("terminalInput").value = state.terminalHistory[state.terminalHistoryIndex];
                } else {
                    state.terminalHistoryIndex = state.terminalHistory.length;
                    $("terminalInput").value = "";
                }
            }
        });

        // ---- 面板日志 ----
        if ($("refreshPanelLogs")) $("refreshPanelLogs").addEventListener("click", loadPanelLogs);

        // ---- 机器人配置 (自动保存: 修改即保存, 无需保存按钮) ----
        if ($("botConfigForm")) {
            const autosave = () => {
                state.botConfigDirty = true;
                clearTimeout(window.__bcAutosaveTimer);
                window.__bcAutosaveTimer = setTimeout(() => {
                    if (!state.botConfigDirty) return;
                    handleSaveBotConfig();
                }, 800);
            };
            $("botConfigForm").addEventListener("submit", handleSaveBotConfig);
            $("botConfigForm").addEventListener("input", autosave);
            $("botConfigForm").addEventListener("change", autosave);
        }

        // ---- 接入点下载 ----
        if ($("btnDownloadNeomega")) $("btnDownloadNeomega").addEventListener("click", () => downloadAccessPoint("neomega"));
        if ($("btnDownloadFateark")) $("btnDownloadFateark").addEventListener("click", () => downloadAccessPoint("fateark"));

        // ---- 机器人列表 ----
        if ($("refreshBots")) $("refreshBots").addEventListener("click", loadBots);

        // ---- 卡密管理 ----
        if ($("refreshCards")) $("refreshCards").addEventListener("click", () => {
            loadCardStats();
            loadCards();
        });
        if ($("btnCreateCard")) $("btnCreateCard").addEventListener("click", openCreateCardModal);
        if ($("cardFilterType")) $("cardFilterType").addEventListener("change", (e) => {
            state.cardFilterType = e.target.value;
            loadCards();
        });
        if ($("cardFilterStatus")) $("cardFilterStatus").addEventListener("change", (e) => {
            state.cardFilterStatus = e.target.value;
            loadCards();
        });
        // 显示/隐藏已撤销卡密
        if ($("cardShowRevoked")) $("cardShowRevoked").addEventListener("change", (e) => {
            state.cardShowRevoked = e.target.checked;
            loadCards();
        });
        if ($("refreshCardLogs")) $("refreshCardLogs").addEventListener("click", loadCardCreationLogs);
        if ($("cardLogType")) $("cardLogType").addEventListener("change", loadCardCreationLogs);

        // ---- 用户管理 ----
        if ($("refreshUsers")) $("refreshUsers").addEventListener("click", loadUsers);
        if ($("btnCreateUser")) $("btnCreateUser").addEventListener("click", openCreateUserModal);

        // ---- 系统日志 ----
        if ($("logFilterLevel")) $("logFilterLevel").addEventListener("change", (e) => {
            state.logFilterLevel = e.target.value;
            loadSystemLogs();
        });
        if ($("refreshSysLogs")) $("refreshSysLogs").addEventListener("click", loadSystemLogs);

        // ---- 系统管理 ----
        if ($("refreshSystemAdmin")) $("refreshSystemAdmin").addEventListener("click", loadSystemAdmin);

        // ---- 机器人管理 (管理员) ----
        if ($("refreshBotManage")) $("refreshBotManage").addEventListener("click", loadBotManage);
        if ($("botManageFilter")) $("botManageFilter").addEventListener("change", loadBotManage);
        if ($("botManageSearch")) {
            let __bmTimer = null;
            $("botManageSearch").addEventListener("input", () => {
                clearTimeout(__bmTimer);
                __bmTimer = setTimeout(loadBotManage, 400);
            });
        }

        // ---- 4399 账号池 ----
        $("sauthAddBtn") && $("sauthAddBtn").addEventListener("click", handleSauthAdd);
        $("sauthRefreshBtn") && $("sauthRefreshBtn").addEventListener("click", handleSauthRefresh);

        // ---- 公告 ----
        if ($("annCreateBtn")) $("annCreateBtn").addEventListener("click", () => openModal("modalCreateAnnouncement"));
        if ($("createAnnouncementSubmit")) $("createAnnouncementSubmit").addEventListener("click", handleCreateAnnouncement);

        // ---- 模态框 ----
        // 关闭按钮 (data-modal-close)
        $$("[data-modal-close]").forEach((el) => {
            el.addEventListener("click", () => {
                const modal = el.closest(".modal-overlay");
                if (modal) modal.classList.remove("visible");
            });
        });
        // 点击遮罩关闭模态框
        $$(".modal-overlay").forEach((overlay) => {
            overlay.addEventListener("click", (e) => {
                if (e.target === overlay) overlay.classList.remove("visible");
            });
        });
        // ESC 关闭所有模态框
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") closeAllModals();
        });

        // ---- 创建面板表单 ----
        if ($("createPanelForm")) $("createPanelForm").addEventListener("submit", handleCreatePanel);
        if ($("createPanelSubmit")) $("createPanelSubmit").addEventListener("click", () => {
            $("createPanelForm").requestSubmit();
        });

        // ---- 创建卡密表单 ----
        if ($("createCardForm")) $("createCardForm").addEventListener("submit", handleCreateCard);
        if ($("createCardSubmit")) $("createCardSubmit").addEventListener("click", () => {
            $("createCardForm").requestSubmit();
        });

        // ---- 创建用户表单 ----
        if ($("createUserForm")) $("createUserForm").addEventListener("submit", handleCreateUser);
        if ($("createUserSubmit")) $("createUserSubmit").addEventListener("click", () => {
            $("createUserForm").requestSubmit();
        });

        // ---- 续费面板表单 ----
        if ($("renewPanelForm")) $("renewPanelForm").addEventListener("submit", handleRenewPanel);
        if ($("renewPanelSubmit")) $("renewPanelSubmit").addEventListener("click", () => {
            $("renewPanelForm").requestSubmit();
        });

        // ---- 确认对话框 ----
        if ($("confirmOk")) $("confirmOk").addEventListener("click", () => {
            closeModal("modalConfirm");
            // 还原按钮状态
            const okBtn = $("confirmOk");
            if (okBtn) okBtn.textContent = "确认";
            const cancelBtn = $$("#modalConfirm [data-modal-close]")[0];
            if (cancelBtn) cancelBtn.style.display = "";
            if (typeof state.confirmCallback === "function") {
                const cb = state.confirmCallback;
                state.confirmCallback = null;
                cb();
            }
        });

        // ---- 文件管理 ----
        const fileUploadInput = $("fileUploadInput");
        const btnUploadFile = $("btnUploadFile");
        if (btnUploadFile) btnUploadFile.addEventListener("click", () => fileUploadInput && fileUploadInput.click());
        if (fileUploadInput) fileUploadInput.addEventListener("change", (e) => handleFileUpload(e));

        const btnRefreshFiles = $("btnRefreshFiles");
        if (btnRefreshFiles) btnRefreshFiles.addEventListener("click", () => loadPanelFiles());

        // ---- 插件管理 ----
        const pluginUploadInput = $("pluginUploadInput");
        const btnUploadPlugin = $("btnUploadPlugin");
        if (btnUploadPlugin) btnUploadPlugin.addEventListener("click", () => pluginUploadInput && pluginUploadInput.click());
        if (pluginUploadInput) pluginUploadInput.addEventListener("change", (e) => handlePluginUpload(e));

        const btnRefreshPlugins = $("btnRefreshPlugins");
        if (btnRefreshPlugins) btnRefreshPlugins.addEventListener("click", () => loadPanelPlugins());

        // ---- 快捷命令菜单 ----
        const btnQuickCmd = $("btnQuickCmd");
        const quickCmdMenu = $("quickCmdMenu");
        if (btnQuickCmd) btnQuickCmd.addEventListener("click", (e) => {
            e.stopPropagation();
            if (quickCmdMenu) quickCmdMenu.style.display = quickCmdMenu.style.display === "none" ? "block" : "none";
        });
        if (quickCmdMenu) {
            quickCmdMenu.addEventListener("click", (e) => {
                const item = e.target.closest(".quick-cmd-item");
                if (item) {
                    let cmd = item.dataset.cmd;
                    const input = $("terminalInput");
                    if (input) {
                        // 快捷命令协议映射
                        const MAP = { say: "/say ", list: "//list ", tp: "//tp ", home: "//tp home " };
                        input.value = (MAP[cmd] || cmd) + " ";
                        input.focus();
                    }
                    quickCmdMenu.style.display = "none";
                }
            });
            document.addEventListener("click", () => { quickCmdMenu.style.display = "none"; });
        }

        // ---- 商店 / 文件管理 / 管理后台 事件绑定 ----
        // 文件上传表单显示/隐藏
        const showUploadBtn = $("showUploadBtn");
        if (showUploadBtn) showUploadBtn.addEventListener("click", toggleUploadForm);
        // 确认上传
        const confirmUploadBtn = $("confirmUploadBtn");
        if (confirmUploadBtn) confirmUploadBtn.addEventListener("click", handleShopFileUpload);
        // 订单搜索
        const searchOrderBtn = $("searchOrderBtn");
        if (searchOrderBtn) searchOrderBtn.addEventListener("click", searchOrders);
        const orderSearchInput = $("orderSearchInput");
        if (orderSearchInput) orderSearchInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter") searchOrders();
        });
        // 刷新审核列表
        const refreshReviewBtn = $("refreshReviewBtn");
        if (refreshReviewBtn) refreshReviewBtn.addEventListener("click", loadReviewFiles);
        // 设置用户余额
        const setBalanceBtn = $("setBalanceBtn");
        if (setBalanceBtn) setBalanceBtn.addEventListener("click", setUserBalance);

        // ---- 欢迎时间定时刷新 ----
        setInterval(updateWelcomeTime, 1000);

        // ---- 运行器 ----
        const runnerExecuteBtn = $("runnerExecuteBtn");
        if (runnerExecuteBtn) runnerExecuteBtn.addEventListener("click", handleRunnerExecute);
        const runnerStopBtn = $("runnerStopBtn");
        if (runnerStopBtn) runnerStopBtn.addEventListener("click", handleRunnerStop);
        const runnerClearBtn = $("runnerClearBtn");
        if (runnerClearBtn) runnerClearBtn.addEventListener("click", () => {
            const out = $("runnerOutput");
            if (out) out.innerHTML = '<span style="color:#586069;">$ 屏幕已清空</span>\n';
            // 同时清空 localStorage 中的历史输出
            clearRunnerOutputHistory();
            // 通知服务端清空会话历史 (若 WebSocket 处于连接状态)
            if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
                try { runnerWs.send(JSON.stringify({ action: "clear_history" })); } catch (_) {}
            }
        });
        const runnerRefreshFilesBtn = $("runnerRefreshFilesBtn");
        if (runnerRefreshFilesBtn) runnerRefreshFilesBtn.addEventListener("click", loadRunnerFiles);
        const runnerUploadBtn = $("runnerUploadBtn");
        const runnerFileInput = $("runnerFileInput");
        if (runnerUploadBtn && runnerFileInput) {
            runnerUploadBtn.addEventListener("click", () => runnerFileInput.click());
            runnerFileInput.addEventListener("change", (e) => handleRunnerUpload(e));
        }
        // 命令输入框 Ctrl+Enter 执行
        const runnerCommand = $("runnerCommand");
        if (runnerCommand) runnerCommand.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                handleRunnerExecute();
            }
        });
        // 交互输入框: 回车发送输入到正在运行的子进程
        const runnerInput = $("runnerInput");
        if (runnerInput) {
            runnerInput.disabled = true;
            runnerInput.placeholder = "运行程序后可在此输入...";
            runnerInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    sendRunnerInput();
                }
            });
        }
        // 页面加载时恢复历史输出 (刷新页面后输出不丢失)
        restoreRunnerOutput();

        // 文件管理折叠/展开
        const runnerFileToggle = $("runnerFileToggle");
        if (runnerFileToggle) runnerFileToggle.addEventListener("click", () => {
            const body = $("runnerFileBody");
            const icon = $("runnerFileToggleIcon");
            if (!body) return;
            const isHidden = body.style.display === "none";
            body.style.display = isHidden ? "" : "none";
            if (icon) icon.className = isHidden ? "fas fa-folder-open" : "fas fa-folder";
        });

        // 快捷命令按钮: 点击后填入命令输入框
        $$(".runner-quick-cmd").forEach((btn) => {
            btn.addEventListener("click", () => {
                const cmd = btn.dataset.cmd || "";
                const cmdInput = $("runnerCommand");
                if (!cmdInput) return;
                // 如果命令以空格结尾 (如 "pip install "), 将光标定位到末尾等待输入
                if (cmd.endsWith(" ")) {
                    cmdInput.value = cmd;
                    cmdInput.focus();
                    cmdInput.setSelectionRange(cmd.length, cmd.length);
                } else {
                    cmdInput.value = cmd;
                    // 直接执行
                    handleRunnerExecute();
                }
            });
        });

        // 新建文件按钮
        const runnerCreateFileBtn = $("runnerCreateFileBtn");
        if (runnerCreateFileBtn) runnerCreateFileBtn.addEventListener("click", async () => {
            const name = prompt("请输入文件名 (可含子路径, 如 sub/test.py):");
            if (!name || !name.trim()) return;
            try {
                const res = await api("/runner/files/create", "POST", { name: name.trim(), type: "file" });
                if (res.success) {
                    toastSuccess("文件创建成功: " + name.trim());
                    loadRunnerFiles();
                }
            } catch (e) {
                toastError(e.message || "创建失败");
            }
        });

        // 新建目录按钮
        const runnerCreateDirBtn = $("runnerCreateDirBtn");
        if (runnerCreateDirBtn) runnerCreateDirBtn.addEventListener("click", async () => {
            const name = prompt("请输入目录名:");
            if (!name || !name.trim()) return;
            try {
                const res = await api("/runner/files/create", "POST", { name: name.trim(), type: "dir" });
                if (res.success) {
                    toastSuccess("目录创建成功: " + name.trim());
                    loadRunnerFiles();
                }
            } catch (e) {
                toastError(e.message || "创建失败");
            }
        });

        // 输入发送按钮
        const runnerInputSendBtn = $("runnerInputSendBtn");
        if (runnerInputSendBtn) runnerInputSendBtn.addEventListener("click", sendRunnerInput);

        // ---- 教程卡片展开/折叠 ----
        $$("[data-tutorial-toggle]").forEach((header) => {
            header.addEventListener("click", () => {
                const card = header.closest(".tutorial-card");
                if (card) card.classList.toggle("open");
            });
        });

        // ---- 建筑工具 (Builder) ----
        // 标签页切换
        $$(".builder-tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                $$(".builder-tab").forEach((t) => t.classList.remove("active"));
                $$(".builder-panel").forEach((p) => p.classList.remove("active"));
                tab.classList.add("active");
                const tabName = tab.dataset.tab;
                $("builder-panel-" + tabName)?.classList.add("active");
            });
        });

        // Generic upload zone init helper
        function initUploadZone(zoneId, fileInputId, iconClass) {
            const zone = $(zoneId);
            if (!zone) return;
            const fileInput = $(fileInputId);
            zone.addEventListener("click", (e) => {
                if (e.target !== fileInput) fileInput.click();
            });
            zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
            zone.addEventListener("dragleave", () => { zone.classList.remove("dragover"); });
            zone.addEventListener("drop", (e) => {
                e.preventDefault();
                zone.classList.remove("dragover");
                if (e.dataTransfer.files.length > 0) {
                    fileInput.files = e.dataTransfer.files;
                    const file = fileInput.files[0];
                    const sizeText = file.size > 1048576
                        ? (file.size / 1048576).toFixed(2) + " MB"
                        : (file.size / 1024).toFixed(1) + " KB";
                    zone.querySelector(".upload-zone-icon").className = iconClass + " upload-zone-icon";
                    zone.querySelector(".upload-zone-text").textContent = file.name;
                    zone.querySelector(".upload-zone-hint").textContent = sizeText + " | 点击重新选择";
                }
            });
            fileInput.addEventListener("change", () => {
                if (!fileInput.files[0]) return;
                const file = fileInput.files[0];
                const sizeText = file.size > 1048576
                    ? (file.size / 1048576).toFixed(2) + " MB"
                    : (file.size / 1024).toFixed(1) + " KB";
                zone.querySelector(".upload-zone-icon").className = iconClass + " upload-zone-icon";
                zone.querySelector(".upload-zone-text").textContent = file.name;
                zone.querySelector(".upload-zone-hint").textContent = sizeText + " | 点击重新选择";
            });
        }
        initUploadZone("parseDropZone", "builderParseFile", "fas fa-file-code");
        initUploadZone("pixelArtDropZone", "builderPixelArtFile", "fas fa-image");
        initUploadZone("musicDropZone", "builderMusicFile", "fas fa-music");
        initUploadZone("skinDropZone", "builderSkinFile", "fas fa-image");
        initUploadZone("cmdChainDropZone", "builderCmdChainFile", "fas fa-file-code");
        initUploadZone("mcfDropZone", "builderMcfFile", "fas fa-file-lines");

        // 解析建筑文件
        if ($("builderParseBtn")) $("builderParseBtn").addEventListener("click", async () => {
            const fileInput = $("builderParseFile");
            if (!fileInput.files[0]) { toastWarn("请选择文件"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            toastInfo("正在解析文件...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/parse", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success) {
                    const info = data.data;
                    $("builderParseResult").style.display = "block";
                    const sz = info.size || [0, 0, 0];
                    const fmt = escapeHtml(info.format || '未知');
                    const blockKinds = Object.keys(info.block_stats || {}).length;
                    $("builderParseInfo").innerHTML = `
                        <div class="builder-stats-grid">
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-cube"></i></div>
                                <div class="stat-card-value">${(info.block_count || 0).toLocaleString()}</div>
                                <div class="stat-card-label">方块总数</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-ruler-combined"></i></div>
                                <div class="stat-card-value">${sz[0] || 0}×${sz[1] || 0}×${sz[2] || 0}</div>
                                <div class="stat-card-label">尺寸 (X×Y×Z)</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-shapes"></i></div>
                                <div class="stat-card-value">${blockKinds}</div>
                                <div class="stat-card-label">方块种类</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-file-code"></i></div>
                                <div class="stat-card-value" style="font-size:15px;">${fmt}</div>
                                <div class="stat-card-label">文件格式</div>
                            </div>
                        </div>
                    `;
                    // 显示方块统计 (block_stats 是字典 {name: count})
                    if (info.block_stats && Object.keys(info.block_stats).length > 0) {
                        const statsArray = Object.entries(info.block_stats)
                            .map(([name, count]) => ({ name, count }))
                            .sort((a, b) => b.count - a.count);
                        const showCount = Math.min(20, statsArray.length);
                        const statsHtml = statsArray.slice(0, 20).map(s =>
                            `<tr><td>${escapeHtml(s.name)}</td><td class="col-count">${s.count.toLocaleString()}</td></tr>`
                        ).join("");
                        $("builderBlockStats").innerHTML = `
                            <div class="block-stats-section-title"><i class="fas fa-list-ul"></i> 方块统计 (前 ${showCount} 种)</div>
                            <table class="block-stats-table"><thead><tr><th>方块</th><th class="col-count">数量</th></tr></thead><tbody>${statsHtml}</tbody></table>
                        `;
                    } else {
                        $("builderBlockStats").innerHTML = "";
                    }
                    toastSuccess("解析成功");
                } else {
                    toastError(data.detail || data.message || "解析失败");
                }
            } catch (e) {
                toastError("解析失败: " + e.message);
            }
        });

        // 生成像素画
        if ($("builderPixelArtBtn")) $("builderPixelArtBtn").addEventListener("click", async () => {
            const fileInput = $("builderPixelArtFile");
            if (!fileInput.files[0]) { toastWarn("请选择图片"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            formData.append("palette", $("builderPalette").value);
            formData.append("dithering", $("builderDithering").value);
            formData.append("direction", $("builderDirection").value);
            toastInfo("正在生成像素画...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/pixel-art", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success) {
                    const info = data.data;
                    $("builderPixelArtResult").style.display = "block";
                    const paletteText = escapeHtml($("builderPalette").value || "-");
                    const ditherText = escapeHtml($("builderDithering").value || "-");
                    $("builderPixelArtInfo").innerHTML = `
                        <div class="builder-stats-grid">
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-image"></i></div>
                                <div class="stat-card-value">${info.width || 0}×${info.height || 0}</div>
                                <div class="stat-card-label">图片尺寸</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-cubes"></i></div>
                                <div class="stat-card-value">${(info.block_count || 0).toLocaleString()}</div>
                                <div class="stat-card-label">使用方块数</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-palette"></i></div>
                                <div class="stat-card-value" style="font-size:15px;">${paletteText}</div>
                                <div class="stat-card-label">调色板</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-shuffle"></i></div>
                                <div class="stat-card-value" style="font-size:15px;">${ditherText}</div>
                                <div class="stat-card-label">抖动算法</div>
                            </div>
                        </div>
                    `;
                    // 设置下载链接
                    if (info.download_url) {
                        $("builderPixelArtDownload").onclick = () => {
                            window.open(info.download_url + "?token=" + encodeURIComponent(state.token || localStorage.getItem(TOKEN_KEY) || ""), "_blank");
                        };
                    }
                    toastSuccess("像素画生成成功");
                } else {
                    toastError(data.detail || data.message || "生成失败");
                }
            } catch (e) {
                toastError("生成失败: " + e.message);
            }
        });

        // 格式转换 - 拖拽上传 + 进度 + 结果展示
        function initConvertDropZone() {
            const zone = $("convertDropZone");
            if (!zone) return;
            const fileInput = $("builderConvertFile");

            // 点击触发文件选择
            zone.addEventListener("click", (e) => {
                if (e.target !== fileInput) fileInput.click();
            });

            // 拖拽事件
            zone.addEventListener("dragover", (e) => {
                e.preventDefault();
                zone.classList.add("dragover");
            });
            zone.addEventListener("dragleave", () => {
                zone.classList.remove("dragover");
            });
            zone.addEventListener("drop", (e) => {
                e.preventDefault();
                zone.classList.remove("dragover");
                if (e.dataTransfer.files.length > 0) {
                    fileInput.files = e.dataTransfer.files;
                    updateConvertFileName();
                }
            });

            // 文件选择后显示文件名
            fileInput.addEventListener("change", updateConvertFileName);
        }

        function updateConvertFileName() {
            const fileInput = $("builderConvertFile");
            const zone = $("convertDropZone");
            if (!zone || !fileInput.files[0]) return;
            const file = fileInput.files[0];
            const sizeKB = (file.size / 1024).toFixed(1);
            const sizeText = file.size > 1048576
                ? (file.size / 1048576).toFixed(2) + " MB"
                : sizeKB + " KB";
            zone.querySelector(".upload-zone-icon").className = "fas fa-file-code upload-zone-icon";
            zone.querySelector(".upload-zone-text").textContent = file.name;
            zone.querySelector(".upload-zone-hint").textContent = sizeText + " | 点击重新选择";
        }

        if ($("builderConvertBtn")) {
            initConvertDropZone();
            if ($("builderConvertBtn")) $("builderConvertBtn").addEventListener("click", async () => {
                const fileInput = $("builderConvertFile");
                if (!fileInput.files[0]) { toastWarn("请选择要转换的文件"); return; }
                const targetFormat = $("builderTargetFormat").value;
                const formData = new FormData();
                formData.append("file", fileInput.files[0]);
                formData.append("target_format", targetFormat);

                // 显示进度
                const progressEl = $("convertProgress");
                const resultEl = $("convertResult");
                const btn = $("builderConvertBtn");
                if (progressEl) progressEl.style.display = "block";
                if (resultEl) resultEl.style.display = "none";
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 转换中...';
                toastInfo("正在转换格式...");

                try {
                    const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                    const resp = await api("/builder/convert", {
                        method: "POST",
                        headers: { "Authorization": "Bearer " + token },
                        body: formData,
                    });
                    const data = await Promise.resolve(resp);
                    if (progressEl) progressEl.style.display = "none";

                    if (data.success && data.data) {
                        const info = data.data;
                        const sizeKB = info.file_size ? (info.file_size / 1024).toFixed(1) : "?";
                        const sizeText = info.file_size > 1048576
                            ? (info.file_size / 1048576).toFixed(2) + " MB"
                            : sizeKB + " KB";

                        if (resultEl) {
                            resultEl.className = "convert-result success";
                            resultEl.style.display = "block";
                            resultEl.innerHTML = `
                                <div class="convert-result-title">
                                    <i class="fas fa-circle-check" style="color: var(--color-success)"></i>
                                    转换成功
                                </div>
                                <div class="convert-result-meta">
                                    <i class="fas fa-arrow-right"></i>
                                    ${info.source_format} &rarr; ${info.target_format}
                                </div>
                                <div class="convert-result-meta">
                                    <i class="fas fa-file-zipper"></i>
                                    文件大小: ${sizeText}
                                </div>
                                <a class="download-btn" href="${info.download_url}?token=${encodeURIComponent(token)}&filename=${encodeURIComponent(info.download_filename || 'converted')}" download>
                                    <i class="fas fa-download"></i> 下载文件
                                </a>
                            `;
                        }
                        toastSuccess("格式转换成功");
                    } else {
                        const errMsg = data.detail || data.message || "转换失败";
                        if (resultEl) {
                            resultEl.className = "convert-result error";
                            resultEl.style.display = "block";
                            resultEl.innerHTML = `
                                <div class="convert-result-title">
                                    <i class="fas fa-circle-xmark" style="color: var(--color-danger)"></i>
                                    转换失败
                                </div>
                                <div class="convert-result-meta">${errMsg}</div>
                            `;
                        }
                        toastError(errMsg);
                    }
                } catch (e) {
                    if (progressEl) progressEl.style.display = "none";
                    if (resultEl) {
                        resultEl.className = "convert-result error";
                        resultEl.style.display = "block";
                        resultEl.innerHTML = `
                            <div class="convert-result-title">
                                <i class="fas fa-circle-xmark" style="color: var(--color-danger)"></i>
                                网络错误
                            </div>
                            <div class="convert-result-meta">${e.message}</div>
                        `;
                    }
                    toastError("转换失败: " + e.message);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fas fa-right-left"></i> 开始转换';
                }
            });
        }

        // 音乐生成
        if ($("builderMusicBtn")) $("builderMusicBtn").addEventListener("click", async () => {
            const fileInput = $("builderMusicFile");
            if (!fileInput.files[0]) { toastWarn("请选择MIDI或NBS文件"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            formData.append("speed", $("builderMusicSpeed").value);
            formData.append("volume", $("builderMusicVolume").value);
            formData.append("loop", $("builderMusicLoop").checked);
            toastInfo("正在生成音乐建筑...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/music", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success && data.data) {
                    const info = data.data;
                    const resultEl = $("builderMusicResult");
                    const infoEl = $("builderMusicInfo");
                    if (resultEl) resultEl.style.display = "block";
                    const buildModeText = info.build_mode === "command_block_chain" ? "命令方块链" : (info.build_mode === "note_block" ? "音符盒" : (info.build_mode || "-"));
                    const sourceText = info.source_format === "midi" ? "MIDI" : (info.source_format === "nbs" ? "NBS" : (info.source_format || "-"));
                    const durationSec = info.duration_ticks ? (info.duration_ticks / 20).toFixed(1) : "0";
                    if (infoEl) {
                        infoEl.innerHTML = `
                            <div class="builder-stats-grid">
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-music"></i></div>
                                    <div class="stat-card-value">${(info.note_count || 0).toLocaleString()}</div>
                                    <div class="stat-card-label">音符数量</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-clock"></i></div>
                                    <div class="stat-card-value">${durationSec}s</div>
                                    <div class="stat-card-label">时长 (秒)</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-file-audio"></i></div>
                                    <div class="stat-card-value" style="font-size:15px;">${sourceText}</div>
                                    <div class="stat-card-label">源格式</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-cubes"></i></div>
                                    <div class="stat-card-value" style="font-size:15px;">${buildModeText}</div>
                                    <div class="stat-card-label">构建模式</div>
                                </div>
                            </div>
                            <div class="builder-preview-box">
                                <div class="builder-preview-icon"><i class="fas fa-music"></i></div>
                                <div class="builder-preview-info">
                                    <div class="preview-title">${escapeHtml(info.download_filename || "music.mcstructure")}</div>
                                    <div class="preview-meta">速度: ${info.speed || 1}x · 音量: ${info.volume != null ? info.volume : 100}${info.loop ? " · 循环播放" : ""}</div>
                                </div>
                            </div>
                        `;
                    }
                    const dlBtn = $("builderMusicDownload");
                    if (dlBtn) {
                        dlBtn.onclick = () => {
                            window.open(info.download_url + "?token=" + encodeURIComponent(state.token || localStorage.getItem(TOKEN_KEY) || ""), "_blank");
                        };
                    }
                    toastSuccess("音乐建筑生成成功");
                } else {
                    toastError(data.detail || data.message || "生成失败");
                }
            } catch (e) {
                toastError("生成失败: " + e.message);
            }
        });

        // 皮肤雕像
        if ($("builderSkinBtn")) $("builderSkinBtn").addEventListener("click", async () => {
            const fileInput = $("builderSkinFile");
            if (!fileInput.files[0]) { toastWarn("请选择皮肤文件"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            formData.append("scale", $("builderSkinScale").value);
            toastInfo("正在生成皮肤雕像...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/skin-statue", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success && data.data) {
                    const info = data.data;
                    const resultEl = $("builderSkinResult");
                    const infoEl = $("builderSkinInfo");
                    if (resultEl) resultEl.style.display = "block";
                    const dims = info.dimensions || [0, 0, 0];
                    const statsCount = info.block_stats ? Object.keys(info.block_stats).length : 0;
                    const scaleVal = $("builderSkinScale") ? $("builderSkinScale").value : "1";
                    if (infoEl) {
                        infoEl.innerHTML = `
                            <div class="builder-stats-grid">
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-cube"></i></div>
                                    <div class="stat-card-value">${(info.block_count || 0).toLocaleString()}</div>
                                    <div class="stat-card-label">方块总数</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-ruler-combined"></i></div>
                                    <div class="stat-card-value">${dims[0]}×${dims[1]}×${dims[2]}</div>
                                    <div class="stat-card-label">雕像尺寸</div>
                                </div>
                                <div class="stat-card">
                                    <div class="stat-card-icon"><i class="fas fa-shapes"></i></div>
                                    <div class="stat-card-value">${statsCount}</div>
                                    <div class="stat-card-label">方块种类</div>
                                </div>
                            </div>
                            <div class="builder-preview-box">
                                <div class="builder-preview-icon"><i class="fas fa-person"></i></div>
                                <div class="builder-preview-info">
                                    <div class="preview-title">${escapeHtml(info.download_filename || "skin_statue.mcstructure")}</div>
                                    <div class="preview-meta">缩放: ${scaleVal}x · 可直接导入基岩版游戏</div>
                                </div>
                            </div>
                        `;
                    }
                    const dlBtn = $("builderSkinDownload");
                    if (dlBtn) {
                        dlBtn.onclick = () => {
                            window.open(info.download_url + "?token=" + encodeURIComponent(state.token || localStorage.getItem(TOKEN_KEY) || ""), "_blank");
                        };
                    }
                    toastSuccess("皮肤雕像生成成功");
                } else {
                    toastError(data.detail || data.message || "生成失败");
                }
            } catch (e) {
                toastError("生成失败: " + e.message);
            }
        });

        // 自定义物品
        if ($("builderItemBtn")) $("builderItemBtn").addEventListener("click", async () => {
            const itemId = $("builderItemId").value.trim();
            const itemName = $("builderItemName").value.trim();
            const enchant = $("builderItemEnchant").value.trim();
            const unbreakable = $("builderItemUnbreakable").checked;
            if (!itemId) { toastWarn("请输入物品ID"); return; }
            toastInfo("正在生成命令...");
            try {
                // 将附魔字符串解析为对象列表
                let enchantList = null;
                if (enchant) {
                    enchantList = enchant.split(",").map(e => {
                        const parts = e.trim().split(":");
                        return { id: parts[0].trim(), level: parseInt(parts[1]) || 1 };
                    });
                }
                const data = await api("/api/v2/builder/custom-item", {
                    method: "POST",
                    body: JSON.stringify({
                        item_name: itemId,
                        custom_name: itemName,
                        enchantments: enchantList,
                        unbreakable: unbreakable,
                    }),
                });
                if (data.success) {
                    $("builderItemResult").style.display = "block";
                    $("builderItemCommand").value = data.data.command || "";
                    toastSuccess("命令生成成功");
                } else {
                    toastError(data.detail || data.message || "生成失败");
                }
            } catch (e) {
                toastError("生成失败: " + e.message);
            }
        });

        // 复制自定义物品命令
        if ($("builderItemCopyBtn")) $("builderItemCopyBtn").addEventListener("click", async () => {
            const cmd = $("builderItemCommand").value;
            if (!cmd) { toastWarn("没有可复制的命令"); return; }
            await copyToClipboard(cmd);
            toastSuccess("命令已复制到剪贴板");
        });

        // === 命令链工具 ===
        // 扫描命令方块链
        if ($("builderCmdChainScanBtn")) $("builderCmdChainScanBtn").addEventListener("click", async () => {
            const fileInput = $("builderCmdChainFile");
            if (!fileInput.files[0]) { toastWarn("请选择 mcstructure 文件"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            toastInfo("正在扫描命令方块链...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/scan-command-chains", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success) {
                    $("builderCmdChainResult").style.display = "block";
                    const chains = data.data.chains || [];
                    const cmdStats = data.data.stats || {};
                    $("builderCmdChainInfo").innerHTML = `
                        <div class="builder-stats-grid">
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-link"></i></div>
                                <div class="stat-card-value">${data.data.total_chains || 0}</div>
                                <div class="stat-card-label">命令链数量</div>
                            </div>
                            <div class="stat-card">
                                <div class="stat-card-icon"><i class="fas fa-cube"></i></div>
                                <div class="stat-card-value">${(cmdStats.total_command_blocks || 0).toLocaleString()}</div>
                                <div class="stat-card-label">命令方块总数</div>
                            </div>
                        </div>
                    `;
                    let html = "";
                    const selectHtml = [];
                    if (chains.length === 0) {
                        html = `<div class="builder-tip"><i class="fas fa-circle-info"></i><span>未在该文件中发现命令方块链。</span></div>`;
                    }
                    chains.forEach((chain, i) => {
                        html += `<div class="chain-list-item">`;
                        html += `<div class="chain-list-header">`;
                        html += `<span class="chain-tag">链 #${i+1}</span>`;
                        html += `<span class="chain-meta"><i class="fas fa-location-dot"></i> 起点: (${chain.start_pos.join(", ")})</span>`;
                        html += `<span class="chain-meta"><i class="fas fa-arrows-up-down"></i> 方向: ${["下","上","北","南","西","东"][chain.direction]||chain.direction}</span>`;
                        html += `<span class="chain-meta"><i class="fas fa-ruler"></i> 长度: ${chain.length}</span>`;
                        if (chain.has_breaks) html += ` <span class="chain-meta" style="color:var(--color-warning);"><i class="fas fa-triangle-exclamation"></i> 有断链</span>`;
                        html += `</div>`;
                        chain.blocks.forEach((b, j) => {
                            const typeIcon = b.type.includes("repeating") ? "🔄" : b.type.includes("chain") ? "🔗" : "⚡";
                            html += `<div class="chain-block-line">${typeIcon} [${b.position.join(",")}] ${escapeHtml(b.command)}</div>`;
                        });
                        html += "</div>";
                        selectHtml.push(`<option value="${i}">第 ${i+1} 条 (长度${chain.length})</option>`);
                    });
                    $("builderCmdChainList").innerHTML = html;
                    $("builderMcfChainSelect").innerHTML = selectHtml.join("") || `<option value="0">第 1 条</option>`;
                    toastSuccess(`扫描完成，发现 ${data.data.total_chains} 条命令链`);
                } else {
                    toastError(data.detail || data.message || "扫描失败");
                }
            } catch (e) {
                toastError("扫描失败: " + e.message);
            }
        });

        // 导出命令链为 MCF
        if ($("builderExportMcfBtn")) $("builderExportMcfBtn").addEventListener("click", async () => {
            const fileInput = $("builderCmdChainFile");
            if (!fileInput.files[0]) { toastWarn("请先扫描命令链"); return; }
            const chainIdx = parseInt($("builderMcfChainSelect").value || "0");
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            formData.append("chain_index", chainIdx);
            toastInfo("正在导出 MCF...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/command-chain-to-mcf", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success && data.data.file_id) {
                    window.open(`/api/v2/builder/download/${data.data.file_id}?token=${encodeURIComponent(state.token||"")}&filename=command_chain.mcf`, "_blank");
                    toastSuccess(`MCF 导出成功 (${data.data.block_count} 个方块)`);
                } else {
                    toastError(data.detail || data.message || "导出失败");
                }
            } catch (e) {
                toastError("导出失败: " + e.message);
            }
        });

        // MCF 转 mcstructure
        if ($("builderMcfToMcBtn")) $("builderMcfToMcBtn").addEventListener("click", async () => {
            const fileInput = $("builderMcfFile");
            if (!fileInput.files[0]) { toastWarn("请选择 MCF 文件"); return; }
            const formData = new FormData();
            formData.append("file", fileInput.files[0]);
            toastInfo("正在转换...");
            try {
                const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
                const resp = await api("/builder/mcf-to-mcstructure", {
                    method: "POST",
                    headers: { "Authorization": "Bearer " + token },
                    body: formData,
                });
                const data = await Promise.resolve(resp);
                if (data.success && data.data.file_id) {
                    window.open(`/api/v2/builder/download/${data.data.file_id}?token=${encodeURIComponent(state.token||"")}&filename=converted.mcstructure`, "_blank");
                    toastSuccess(`转换成功 (${data.data.block_count} 个命令方块)`);
                } else {
                    toastError(data.detail || data.message || "转换失败");
                }
            } catch (e) {
                toastError("转换失败: " + e.message);
            }
        });
    }

    /* NV1 Key 管理已移除 (PT残留) */

    /** 格式化时间 */
    function fmtTime(ts) {
        if (!ts) return "-";
        const d = new Date(ts * 1000);
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

    /** 判断当前用户是否为管理员 */
    function isAdmin() {
        const user = state.currentUser;
        if (!user) return false;
        const role = user.role || (user.is_admin ? "admin" : "user");
        return role === "admin" || role === "superadmin";
    }

    /** 加载公告列表 */
    async function loadAnnouncements() {
        const container = $("annList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-bullhorn"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            const res = await api("/announcements");
            if (res.success && res.data) {
                if (res.data.length === 0) {
                    container.innerHTML = `<div class="empty-state"><i class="fas fa-bullhorn"></i><h3>暂无公告</h3><p style="font-size:13px;">${isAdmin() ? "点击右上角发布按钮创建公告" : "目前没有公告"}</p></div>`;
                    return;
                }
                // 置顶公告排到最前 (保留后端返回顺序作为次要排序)
                const sorted = [...res.data].sort((a, b) => {
                    const ap = isAnnPinned(a) ? 1 : 0;
                    const bp = isAnnPinned(b) ? 1 : 0;
                    return bp - ap;
                });
                container.innerHTML = sorted.map(ann => renderAnnouncementCard(ann)).join("");
                // 绑定事件
                sorted.forEach(ann => {
                    const likeBtn = document.querySelector(`[data-ann-like="${ann.announcement_id}"]`);
                    const dislikeBtn = document.querySelector(`[data-ann-dislike="${ann.announcement_id}"]`);
                    if (likeBtn) likeBtn.addEventListener("click", () => toggleLike(ann.announcement_id));
                    if (dislikeBtn) dislikeBtn.addEventListener("click", () => toggleDislike(ann.announcement_id));
                    const delBtn = document.querySelector(`[data-ann-delete="${ann.announcement_id}"]`);
                    if (delBtn) delBtn.addEventListener("click", () => deleteAnnouncement(ann.announcement_id));
                    // 置顶/取消置顶按钮 (仅管理员)
                    const pinBtn = document.querySelector(`[data-ann-pin="${ann.announcement_id}"]`);
                    if (pinBtn) pinBtn.addEventListener("click", () => togglePinAnnouncement(ann.announcement_id));
                    const commentToggle = document.querySelector(`[data-ann-comments-toggle="${ann.announcement_id}"]`);
                    if (commentToggle) commentToggle.addEventListener("click", () => toggleComments(ann.announcement_id));
                    const commentInput = document.querySelector(`[data-ann-comment-input="${ann.announcement_id}"]`);
                    const commentBtn = document.querySelector(`[data-ann-comment-btn="${ann.announcement_id}"]`);
                    if (commentBtn) commentBtn.addEventListener("click", () => {
                        const val = commentInput?.value.trim();
                        if (val) addComment(ann.announcement_id, val);
                    });
                    if (commentInput) commentInput.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") {
                            const val = commentInput.value.trim();
                            if (val) addComment(ann.announcement_id, val);
                        }
                    });
                });
            }
        } catch (e) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle" style="color:var(--color-danger);"></i><p style="font-size:13px;">加载失败: ${e.message}</p></div>`;
        }
    }

    /** 判断公告是否已置顶 (兼容 is_pinned / pinned 两种字段) */
    function isAnnPinned(ann) {
        return !!(ann && (ann.is_pinned || ann.pinned));
    }

    /** 渲染单个公告卡片 */
    function renderAnnouncementCard(ann) {
        const liked = ann.liked || false;
        const disliked = ann.disliked || false;
        const likeCount = ann.like_count || 0;
        const dislikeCount = ann.dislike_count || 0;
        const canManage = isAdmin();
        const canDelete = canManage;
        const pinned = isAnnPinned(ann);

        return `
        <div class="ann-card${pinned ? ' pinned' : ''}">
            <div class="ann-header">
                <div>
                    <div class="ann-title">${pinned ? `<span class="ann-pin-badge">📌 置顶</span>` : ""}${escapeHtml(ann.title)}</div>
                    <div class="ann-meta">发布者: ${escapeHtml(ann.created_by_username)} &middot; ${fmtTime(ann.created_at)}</div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;flex-shrink:0;">
                    ${canManage ? `<span class="ann-pin-btn${pinned ? ' active' : ''}" data-ann-pin="${ann.announcement_id}" title="${pinned ? '取消置顶' : '置顶'}"><i class="fas fa-thumbtack"></i> ${pinned ? '取消置顶' : '置顶'}</span>` : ""}
                    ${canDelete ? `<span class="ann-delete-btn" data-ann-delete="${ann.announcement_id}"><i class="fas fa-trash"></i> 删除</span>` : ""}
                </div>
            </div>
            <div class="ann-content">${escapeHtml(ann.content)}</div>
            <div class="ann-actions">
                <span class="ann-reaction ${liked ? 'active-like' : ''}" data-ann-like="${ann.announcement_id}">
                    <i class="fas fa-thumbs-up"></i> <span>${likeCount}</span>
                </span>
                <span class="ann-reaction ${disliked ? 'active-dislike' : ''}" data-ann-dislike="${ann.announcement_id}">
                    <i class="fas fa-thumbs-down"></i> <span>${dislikeCount}</span>
                </span>
            </div>
            <div class="ann-comments" id="ann-comments-${ann.announcement_id}" style="display:none;">
                <div id="ann-comments-list-${ann.announcement_id}"></div>
                <div class="ann-comment-input">
                    <input type="text" class="form-input" placeholder="写评论..." data-ann-comment-input="${ann.announcement_id}">
                    <button class="btn btn-primary btn-sm" data-ann-comment-btn="${ann.announcement_id}"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>
            <div style="margin-top:8px;">
                <span class="ann-comments-toggle" data-ann-comments-toggle="${ann.announcement_id}">查看评论</span>
            </div>
        </div>`;
    }

    /** 切换评论显示 */
    async function toggleComments(annId) {
        const container = $(`ann-comments-${annId}`);
        if (!container) return;
        if (container.style.display === "none") {
            container.style.display = "block";
            await loadComments(annId);
            const toggle = document.querySelector(`[data-ann-comments-toggle="${annId}"]`);
            if (toggle) toggle.textContent = "收起评论";
        } else {
            container.style.display = "none";
            const toggle = document.querySelector(`[data-ann-comments-toggle="${annId}"]`);
            if (toggle) toggle.textContent = "查看评论";
        }
    }

    /** 加载评论 */
    async function loadComments(annId) {
        const listEl = $(`ann-comments-list-${annId}`);
        if (!listEl) return;
        try {
            const res = await api(`/announcements/${annId}/comments`);
            if (res.success && res.data) {
                const canDeleteAny = isAdmin();
                listEl.innerHTML = res.data.map(c => `
                    <div class="ann-comment">
                        <div class="ann-comment-header">
                            <span class="ann-comment-user">${escapeHtml(c.username)}</span>
                            <span>
                                <span class="ann-comment-time">${fmtTime(c.created_at)}</span>
                                ${(canDeleteAny || c.user_id === state.currentUser?.user_id) ? `<span class="ann-comment-delete" onclick="deleteComment('${annId}','${c.comment_id}')">删除</span>` : ""}
                            </span>
                        </div>
                        <div class="ann-comment-content">${escapeHtml(c.content)}</div>
                    </div>
                `).join("") || `<p style="font-size:12px;color:var(--text-tertiary);padding:8px 0;">暂无评论</p>`;
            }
        } catch (e) { /* ignore */ }
    }

    /** 创建公告 */
    async function handleCreateAnnouncement() {
        const title = $("annTitle")?.value.trim();
        const content = $("annContent")?.value.trim();
        if (!title || !content) {
            toastError("请填写标题和内容");
            return;
        }
        try {
            const res = await api("/announcements", {
                method: "POST",
                body: { title, content },
            });
            if (res.success) {
                toastSuccess("公告发布成功");
                closeModal("modalCreateAnnouncement");
                $("annTitle").value = "";
                $("annContent").value = "";
                await loadAnnouncements();
            } else {
                toastError("发布失败: " + (res.detail || res.message || "未知错误"));
            }
        } catch (e) {
            toastError("发布失败: " + e.message);
        }
    }

    /** 删除公告 */
    async function deleteAnnouncement(annId) {
        if (!confirm("确定要删除这条公告吗？所有评论和点赞也将被删除。")) return;
        try {
            const res = await api(`/announcements/${annId}`, { method: "DELETE" });
            if (res.success) {
                toastSuccess("公告已删除");
                await loadAnnouncements();
            } else {
                toastError("删除失败: " + (res.detail || res.message || "未知错误"));
            }
        } catch (e) {
            toastError("删除失败: " + e.message);
        }
    }

    /** 置顶/取消置顶公告 (管理员, 切换式) */
    async function togglePinAnnouncement(annId) {
        try {
            const res = await api(`/announcements/${annId}/pin`, { method: "PUT" });
            if (res.success) {
                toastSuccess(res.message || "操作成功");
                await loadAnnouncements();
            } else {
                toastError("操作失败: " + (res.detail || res.message || "未知错误"));
            }
        } catch (e) {
            toastError("操作失败: " + e.message);
        }
    }

    /** 添加评论 */
    async function addComment(annId, content) {
        try {
            const res = await api(`/announcements/${annId}/comments`, {
                method: "POST",
                body: { content },
            });
            if (res.success) {
                const input = document.querySelector(`[data-ann-comment-input="${annId}"]`);
                if (input) input.value = "";
                await loadComments(annId);
            } else {
                toastError("评论失败: " + (res.detail || res.message || "未知错误"));
            }
        } catch (e) {
            toastError("评论失败: " + e.message);
        }
    }

    /** 删除评论 */
    async function deleteComment(annId, commentId) {
        try {
            const res = await api(`/announcements/${annId}/comments/${commentId}`, { method: "DELETE" });
            if (res.success) {
                toastSuccess("评论已删除");
                await loadComments(annId);
            } else {
                toastError("删除失败: " + (res.detail || res.message || "未知错误"));
            }
        } catch (e) {
            toastError("删除失败: " + e.message);
        }
    }

    /** 点赞 */
    async function toggleLike(annId) {
        try {
            const res = await api(`/announcements/${annId}/like`, { method: "POST" });
            if (res.success) {
                await loadAnnouncements();
                // 展开评论区如果之前展开了
                const container = $(`ann-comments-${annId}`);
                if (container && container.style.display !== "none") {
                    await loadComments(annId);
                }
            }
        } catch (e) { /* ignore */ }
    }

    /** 点差评 */
    async function toggleDislike(annId) {
        try {
            const res = await api(`/announcements/${annId}/dislike`, { method: "POST" });
            if (res.success) {
                await loadAnnouncements();
                const container = $(`ann-comments-${annId}`);
                if (container && container.style.display !== "none") {
                    await loadComments(annId);
                }
            }
        } catch (e) { /* ignore */ }
    }

    /** 加载公告活动日志 (管理员) */
    async function loadAnnouncementLogs() {
        const container = $("annLogsList");
        if (!container) return;
        container.innerHTML = `<div class="empty-state"><i class="fas fa-list"></i><p style="font-size:13px;">加载中...</p></div>`;
        try {
            const res = await api("/announcements/logs");
            if (res.success && res.data) {
                if (res.data.length === 0) {
                    container.innerHTML = `<div class="empty-state"><i class="fas fa-list"></i><h3>暂无记录</h3><p style="font-size:13px;">用户点赞、差评、评论等记录将显示在这里</p></div>`;
                    return;
                }
                container.innerHTML = res.data.map(log => {
                    let iconClass = "", iconHtml = "", actionText = "";
                    const type = log.type || log.action;
                    const title = log.announcement_title || "";
                    const detail = log.detail || log.content || "";
                    if (type === "like") {
                        iconClass = "like"; iconHtml = '<i class="fas fa-thumbs-up"></i>';
                        actionText = `赞了公告 <strong>${escapeHtml(title || detail)}</strong>`;
                    } else if (type === "dislike") {
                        iconClass = "dislike"; iconHtml = '<i class="fas fa-thumbs-down"></i>';
                        actionText = `差评了公告 <strong>${escapeHtml(title || detail)}</strong>`;
                    } else if (type === "comment") {
                        iconClass = "comment"; iconHtml = '<i class="fas fa-comment"></i>';
                        actionText = `评论了公告: "${escapeHtml(detail)}"`;
                    } else if (type === "create") {
                        iconClass = "create"; iconHtml = '<i class="fas fa-plus"></i>';
                        actionText = `发布了公告 <strong>${escapeHtml(title || detail)}</strong>`;
                    } else if (type === "delete") {
                        iconClass = "delete"; iconHtml = '<i class="fas fa-trash"></i>';
                        actionText = `删除了公告 <strong>${escapeHtml(detail)}</strong>`;
                    } else if (type === "pin") {
                        iconClass = "pin"; iconHtml = '<i class="fas fa-thumbtack"></i>';
                        actionText = `置顶操作: ${escapeHtml(detail)}`;
                    } else {
                        iconClass = "other"; iconHtml = '<i class="fas fa-info-circle"></i>';
                        actionText = `${escapeHtml(type)}: ${escapeHtml(detail)}`;
                    }
                    return `
                    <div class="ann-log-item">
                        <div class="ann-log-icon ${iconClass}">${iconHtml}</div>
                        <div style="flex:1;">
                            <span style="font-weight:600;">${escapeHtml(log.username || "-")}</span>
                            <span style="color:var(--text-secondary);"> ${actionText}</span>
                        </div>
                        <span style="font-size:11px;color:var(--text-tertiary);">${fmtTime(log.created_at)}</span>
                    </div>`;
                }).join("");
            }
        } catch (e) {
            container.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-circle" style="color:var(--color-danger);"></i><p style="font-size:13px;">加载失败: ${e.message}</p></div>`;
        }
    }

    /* ======================================================================
       21. 运行器功能
       ====================================================================== */

    let runnerWs = null;
    let runnerRunning = false;
    // 缓存已加载的脚本文件列表, 供命令路径解析使用
    let runnerFilesCache = [];
    // localStorage 中持久化运行器输出的键名
    const RUNNER_OUTPUT_KEY = "crystalgate_runner_output";
    const RUNNER_OUTPUT_MAX = 100;

    async function loadRunnerFiles() {
        try {
            const data = await api("/api/v2/runner/files");
            // 后端返回 {"success": true, "data": {"/workspace": [...], "/data/user/work": [...], "__scripts_dir__": {"path":..., "files":[...]}}}
            // 需要扁平化所有目录下的文件
            const files = [];
            const dirData = data.data || data;
            if (dirData && typeof dirData === "object") {
                for (const key of Object.keys(dirData)) {
                    const val = dirData[key];
                    if (Array.isArray(val)) {
                        files.push(...val);
                    } else if (val && Array.isArray(val.files)) {
                        files.push(...val.files);
                    }
                }
            }
            const container = $("runnerFilesList");
            if (!container) return;
            // 缓存文件列表, 供命令路径解析使用
            runnerFilesCache = files;
            if (files.length === 0) {
                container.innerHTML = '<div class="runner-empty">暂无脚本文件，点击下方「上传文件」开始</div>';
                return;
            }
            container.innerHTML = files.map(f => {
                const sizeStr = f.size > 1024 ? (f.size / 1024).toFixed(1) + ' KB' : f.size + ' B';
                const fn = escAttr(f.name);
                const fp = escAttr(f.path || "");
                const safeName = escapeHtml(f.name);
                const icon = f.is_dir ? 'fa-folder' : 'fa-file-code';
                return `<div class="runner-file-item">
                    <div class="runner-file-info">
                        <i class="fas ${icon} runner-file-icon"></i>
                        <span class="runner-file-name" onclick="window.fillRunnerCommand('${fn}', '${fp}')" title="${safeName}">${safeName}</span>
                        <span class="runner-file-size">${sizeStr}</span>
                    </div>
                    <div class="runner-file-actions">
                        <button class="runner-file-btn run" onclick="window.runRunnerFile('${fn}', '${fp}')" title="运行"><i class="fas fa-play"></i> 运行</button>
                        <button class="runner-file-btn view" onclick="window.viewRunnerFile('${fn}')" title="查看内容"><i class="fas fa-eye"></i></button>
                        <button class="runner-file-btn dl" onclick="window.downloadRunnerFile('${fn}')" title="下载"><i class="fas fa-download"></i></button>
                        <button class="runner-file-btn rn" onclick="window.renameRunnerFile('${fn}')" title="重命名"><i class="fas fa-i-cursor"></i></button>
                        <button class="runner-file-btn zip" onclick="window.compressRunnerFile('${fn}')" title="压缩"><i class="fas fa-file-archive"></i></button>
                        <button class="runner-file-btn del" onclick="window.deleteRunnerFile('${fn}')" title="删除"><i class="fas fa-trash-alt"></i></button>
                    </div>
                </div>`;
            }).join("");
        } catch (e) {
            if ($("runnerFilesList")) $("runnerFilesList").innerHTML = '<div style="color:var(--color-danger);font-size:13px;">加载失败: ' + escapeHtml(e.message) + '</div>';
        }
    }

    window.deleteRunnerFile = async function(filename) {
        if (!confirm("确定要删除文件 " + filename + " 吗?")) return;
        try {
            await api("/api/v2/runner/files/" + encodeURIComponent(filename), { method: "DELETE" });
            toastSuccess("文件已删除");
            loadRunnerFiles();
        } catch (e) {
            toastError("删除失败: " + e.message);
        }
    };

    window.downloadRunnerFile = async function(filename) {
        try {
            const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
            const resp = await api("/runner/files/" + encodeURIComponent(filename) + "/download", {
                headers: { "Authorization": "Bearer " + token },
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.detail || err.message || "下载失败");
            }
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            toastSuccess("下载已开始: " + filename);
        } catch (e) {
            toastError("下载失败: " + e.message);
        }
    };

    // 查看文件内容 (在弹窗中显示)
    window.viewRunnerFile = async function(filename) {
        try {
            const res = await api("/api/v2/runner/files/" + encodeURIComponent(filename) + "/content");
            if (res.success && res.data) {
                const content = res.data.content || "";
                const fileSize = res.data.size || 0;
                const encoding = res.data.encoding || "utf-8";
                // 创建临时模态框
                const overlay = document.createElement("div");
                overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;";
                const box = document.createElement("div");
                box.style.cssText = "background:var(--bg-card,#161b22);border-radius:12px;max-width:80vw;width:800px;max-height:85vh;display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--border-muted,#21262d);";
                box.innerHTML = `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border-muted,#21262d);">
                        <div style="font-size:15px;font-weight:600;color:var(--text-primary,#e6edf3);"><i class="fas fa-file-code" style="margin-right:8px;color:var(--color-primary,#58a6ff);"></i>${escapeHtml(filename)}</div>
                        <button style="background:none;border:none;color:var(--text-secondary,#7d8590);cursor:pointer;font-size:20px;" onclick="this.closest('[data-overlay]').remove()">&times;</button>
                    </div>
                    <div style="padding:8px 20px;font-size:12px;color:var(--text-secondary,#7d8590);border-bottom:1px solid var(--border-muted,#21262d);">大小: ${fileSize} 字节 | 编码: ${encoding}</div>
                    <pre style="margin:0;padding:16px 20px;overflow:auto;flex:1;background:#0d1117;color:#e6edf3;font-size:13px;font-family:Consolas,Monaco,monospace;white-space:pre-wrap;word-break:break-all;line-height:1.6;max-height:60vh;">${escapeHtml(content)}</pre>
                `;
                overlay.setAttribute("data-overlay", "");
                overlay.appendChild(box);
                overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
                document.body.appendChild(overlay);
            } else {
                toastError(res.detail || res.message || "无法读取文件内容");
            }
        } catch (e) {
            toastError("查看失败: " + e.message);
        }
    };

    window.renameRunnerFile = async function(filename) {
        const newName = prompt("请输入新文件名:", filename);
        if (!newName || newName === filename) return;
        try {
            await api("/api/v2/runner/files/" + encodeURIComponent(filename) + "/rename", {
                method: "PUT",
                body: JSON.stringify({ new_name: newName }),
            });
            toastSuccess("重命名成功: " + filename + " → " + newName);
            loadRunnerFiles();
        } catch (e) {
            toastError("重命名失败: " + e.message);
        }
    };

    window.compressRunnerFile = async function(filename) {
        toastInfo("正在压缩: " + filename + " ...");
        try {
            const data = await api("/api/v2/runner/files/" + encodeURIComponent(filename) + "/compress", {
                method: "POST",
            });
            if (data.success) {
                const zipName = data.data?.filename || (filename + ".zip");
                const zipSize = data.data?.size || 0;
                const sizeStr = zipSize > 1024 ? (zipSize / 1024).toFixed(1) + ' KB' : zipSize + ' B';
                toastSuccess("压缩成功: " + zipName + " (" + sizeStr + ")");
                loadRunnerFiles();
            } else {
                throw new Error(data.detail || data.message || "压缩失败");
            }
        } catch (e) {
            toastError("压缩失败: " + e.message);
        }
    };

    window.fillRunnerCommand = function(filename, filepath) {
        const cmdInput = document.getElementById("runnerCommand");
        if (cmdInput) {
            // 根据文件扩展名自动选择解释器
            const ext = filename.split('.').pop().toLowerCase();
            const runners = {
                'py': 'python3',
                'js': 'node',
                'go': 'go run',
                'sh': 'bash',
                'bash': 'bash',
                'rb': 'ruby',
                'pl': 'perl',
                'php': 'php',
                'java': 'java',
            };
            const runner = runners[ext] || '';
            // 如果有 filepath 就用完整路径，否则用文件名（避免找不到子目录中的文件）
            const target = filepath || filename;
            cmdInput.value = runner ? runner + ' ' + target : target;
        }
    };

    window.runRunnerFile = function(filename, filepath) {
        // 填充命令（使用完整路径）并立即执行
        window.fillRunnerCommand(filename, filepath);
        handleRunnerExecute();
    };

    async function handleRunnerUpload(e) {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);
        formData.append("overwrite", "true");
        try {
            const token = state.token || localStorage.getItem(TOKEN_KEY) || "";
            const resp = await api("/runner/upload", {
                method: "POST",
                headers: { "Authorization": "Bearer " + token },
                body: formData,
            });
            const data = await Promise.resolve(resp);
            if (data.success) {
                toastSuccess("上传成功: " + (data.data?.filename || data.filename || ""));
                loadRunnerFiles();
            } else {
                toastError("上传失败: " + (data.detail || data.message || "未知错误"));
            }
        } catch (e) {
            toastError("上传失败: " + e.message);
        }
        e.target.value = "";
    }

    // 运行器输出各类型对应的颜色
    const RUNNER_COLORS = {
        "stderr": "#f85149",
        "exit": "#58a6ff",
        "cmd": "#d2a8ff",
        "system": "#d2a8ff",
        "input": "#8b949e",
    };

    // 解析命令中引用的脚本文件名, 替换为完整路径 (避免子目录中的文件找不到)
    function resolveRunnerCommandPaths(command, cwd) {
        if (!command) return command;
        const files = (runnerFilesCache || []).filter(f => f && !f.is_dir && f.path && f.name);
        if (!files.length) return command;
        let result = command;
        // 按文件名长度倒序, 优先匹配更长的文件名, 避免短名误替换
        files.sort((a, b) => b.name.length - a.name.length);
        for (const f of files) {
            const escaped = f.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            // 仅替换独立的 token (前后不是 字母/数字/下划线/斜杠/点/连字符)
            const pattern = new RegExp("(?<![\\w/\\-.])" + escaped + "(?![\\w/\\-.])", "g");
            // 路径含空格时用引号包裹
            const replacement = String(f.path).indexOf(" ") >= 0 ? '"' + f.path + '"' : String(f.path);
            result = result.replace(pattern, () => replacement);
        }
        return result;
    }

    // 启用 / 禁用交互输入框 (仅进程运行时启用)
    function setRunnerInputEnabled(enabled) {
        const input = $("runnerInput");
        if (!input) return;
        input.disabled = !enabled;
        input.placeholder = enabled ? "输入内容并按回车发送到程序..." : "运行程序后可在此输入...";
        const sendBtn = $("runnerInputSendBtn");
        if (sendBtn) sendBtn.disabled = !enabled;
        if (enabled) {
            try { input.focus(); } catch (_) {}
        }
    }

    // 回放服务端历史输出 (不重复写入 localStorage)
    function replayRunnerHistory(history) {
        if (!Array.isArray(history) || !history.length) return;
        for (const entry of history) {
            if (!entry || !entry.type) continue;
            if (entry.type === "stdout") {
                appendRunnerOutput(entry.data || "", "stdout", false);
            } else if (entry.type === "stderr") {
                appendRunnerOutput(entry.data || "", "stderr", false);
            } else if (entry.type === "system") {
                appendRunnerOutput((entry.data || "") + "\n", "cmd", false);
            } else if (entry.type === "exited") {
                appendRunnerOutput(`\n[进程退出, code=${entry.exit_code}, 耗时 ${entry.duration}s]`, "exit", false);
            }
        }
    }

    // 从 localStorage 恢复历史输出 (刷新页面后仍可查看)
    function restoreRunnerOutput() {
        const out = $("runnerOutput");
        if (!out) return;
        let arr = [];
        try {
            arr = JSON.parse(localStorage.getItem(RUNNER_OUTPUT_KEY) || "[]");
        } catch (_) { arr = []; }
        if (!Array.isArray(arr) || !arr.length) return;
        out.innerHTML = "";
        for (const item of arr) {
            if (item && typeof item.text === "string") {
                appendRunnerOutput(item.text, item.type || "stdout", false);
            }
        }
        out.scrollTop = out.scrollHeight;
    }

    // 清空 localStorage 中的运行器输出历史
    function clearRunnerOutputHistory() {
        try { localStorage.removeItem(RUNNER_OUTPUT_KEY); } catch (_) {}
    }

    // 发送交互输入到正在运行的子进程 (回车触发)
    function sendRunnerInput() {
        const input = $("runnerInput");
        if (!input || input.disabled) return;
        const text = input.value;
        const payload = text + "\n";
        if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
            runnerWs.send(JSON.stringify({ action: "input", data: payload }));
            // 终端式回显用户输入
            appendRunnerOutput(text + "\n", "input");
        }
        input.value = "";
    }

    async function handleRunnerExecute() {
        const command = $("runnerCommand")?.value.trim();
        if (!command) { toastWarn("请输入命令"); return; }
        if (runnerRunning) { toastWarn("已有命令正在执行"); return; }

        const cwd = $("runnerCwd")?.value.trim() || "/workspace";
        const timeout = parseInt($("runnerTimeout")?.value || "30");

        runnerRunning = true;
        $("runnerExecuteBtn").disabled = true;
        $("runnerStopBtn").disabled = false;
        // 执行前先禁用输入框, 待进程启动后再启用
        setRunnerInputEnabled(false);
        const statusEl = $("runnerStatus");
        if (statusEl) { statusEl.textContent = "执行中..."; statusEl.style.color = "var(--color-warning)"; }
        const out = $("runnerOutput");
        if (out) out.innerHTML = "";

        // 尝试用 WebSocket 实时输出
        const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${wsProtocol}//${location.host}/api/v2/runner/ws?token=${encodeURIComponent(state.token || "")}`;

        try {
            runnerWs = new WebSocket(wsUrl);
            let wsConnected = false;

            runnerWs.onopen = () => {
                wsConnected = true;
                runnerWs.send(JSON.stringify({ action: "execute", command, cwd, timeout }));
            };

            runnerWs.onmessage = (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch (_) { return; }
                switch (msg.type) {
                    case "ready":
                        // 连接就绪
                        break;
                    case "history":
                        // 回放历史输出 (刷新 / 重连后恢复, 不重复写入 localStorage)
                        replayRunnerHistory(msg.data);
                        break;
                    case "started":
                        // 进程已启动, 启用交互输入框
                        setRunnerInputEnabled(true);
                        if (statusEl) {
                            statusEl.textContent = "运行中 (pid=" + (msg.pid != null ? msg.pid : "?") + ")";
                            statusEl.style.color = "var(--color-warning)";
                        }
                        if (msg.command) appendRunnerOutput("$ " + msg.command + "\n", "cmd");
                        if (msg.cwd && $("runnerCwd")) $("runnerCwd").value = msg.cwd;
                        break;
                    case "stdout":
                        appendRunnerOutput(msg.data, "stdout");
                        break;
                    case "stderr":
                        appendRunnerOutput(msg.data, "stderr");
                        break;
                    case "exited":
                        appendRunnerOutput(`\n[进程退出, code=${msg.exit_code}, 耗时 ${msg.duration}s]`, "exit");
                        setRunnerInputEnabled(false);
                        finishRunner(msg.exit_code);
                        break;
                    case "cwd_changed":
                        // cd 命令切换工作目录, 更新工作目录输入框
                        if (msg.cwd && $("runnerCwd")) $("runnerCwd").value = msg.cwd;
                        break;
                    case "input_sent":
                        // stdin 写入成功
                        break;
                    case "history_cleared":
                        if (out) out.innerHTML = "";
                        clearRunnerOutputHistory();
                        break;
                    case "error":
                        appendRunnerOutput("错误: " + msg.message, "stderr");
                        setRunnerInputEnabled(false);
                        finishRunner(-1);
                        break;
                    case "pong":
                        break;
                }
            };

            runnerWs.onerror = () => {
                if (!wsConnected) {
                    // WebSocket 不可用, 回退到 HTTP
                    fallbackHttpExecute(command, cwd, timeout);
                }
            };

            runnerWs.onclose = () => {
                if (runnerRunning) {
                    finishRunner(-1);
                }
            };

            // 3秒后如果 WebSocket 未连接, 回退
            setTimeout(() => {
                if (!wsConnected && runnerRunning) {
                    if (runnerWs) runnerWs.close();
                    fallbackHttpExecute(command, cwd, timeout);
                }
            }, 3000);

        } catch (e) {
            fallbackHttpExecute(command, cwd, timeout);
        }
    }

    async function fallbackHttpExecute(command, cwd, timeout) {
        // 解析命令中引用的文件名, 替换为完整路径 (与 WebSocket 模式保持一致)
        const resolved = resolveRunnerCommandPaths(command, cwd);
        appendRunnerOutput("$ " + resolved + "\n", "cmd");
        try {
            const data = await api("/api/v2/runner/execute", {
                method: "POST",
                body: JSON.stringify({ command: resolved, cwd, timeout }),
            });
            if (data.stdout) appendRunnerOutput(data.stdout, "stdout");
            if (data.stderr) appendRunnerOutput(data.stderr, "stderr");
            appendRunnerOutput(`\n[进程退出, code=${data.exit_code}, 耗时 ${data.duration}s]`, "exit");
            finishRunner(data.exit_code);
        } catch (e) {
            appendRunnerOutput("错误: " + e.message, "stderr");
            finishRunner(-1);
        }
    }

    // 追加输出到界面, 并持久化到 localStorage (persist=false 时不写入, 用于历史回放)
    function appendRunnerOutput(text, type, persist) {
        if (persist === undefined) persist = true;
        const out = $("runnerOutput");
        if (!out) return;
        const color = RUNNER_COLORS[type] || "#e6edf3";
        const span = document.createElement("span");
        span.style.color = color;
        span.textContent = text;
        out.appendChild(span);
        out.scrollTop = out.scrollHeight;
        // 持久化到 localStorage (最多 RUNNER_OUTPUT_MAX 条, 刷新页面后可恢复)
        if (persist) {
            try {
                let arr = JSON.parse(localStorage.getItem(RUNNER_OUTPUT_KEY) || "[]");
                arr.push({ text: String(text), type: type });
                if (arr.length > RUNNER_OUTPUT_MAX) arr = arr.slice(-RUNNER_OUTPUT_MAX);
                localStorage.setItem(RUNNER_OUTPUT_KEY, JSON.stringify(arr));
            } catch (_) {}
        }
    }

    function finishRunner(exitCode) {
        runnerRunning = false;
        // 进程结束, 禁用交互输入框
        setRunnerInputEnabled(false);
        $("runnerExecuteBtn").disabled = false;
        $("runnerStopBtn").disabled = true;
        const statusEl = $("runnerStatus");
        if (statusEl) {
            statusEl.textContent = exitCode === 0 ? "执行完成" : "已结束 (code=" + exitCode + ")";
            statusEl.style.color = exitCode === 0 ? "var(--color-success)" : "var(--color-danger)";
        }
        if (runnerWs) { try { runnerWs.close(); } catch(_) {} runnerWs = null; }
    }

    function handleRunnerStop() {
        if (runnerWs && runnerWs.readyState === WebSocket.OPEN) {
            runnerWs.send(JSON.stringify({ action: "signal", signal: "SIGINT" }));
            appendRunnerOutput("\n[发送 Ctrl+C 信号...]", "exit");
        } else if (runnerRunning) {
            // HTTP 模式下无法发送中断信号, 提示用户
            appendRunnerOutput("\n[HTTP 模式下无法中断, 请等待超时或完成]", "exit");
            toastInfo("HTTP 模式不支持中断, 请使用 WebSocket 模式");
        }
    }

    /* ======================================================================
       22. 文件管理操作 (删除/重命名/压缩/下载)
       ====================================================================== */

    window.deleteUserFile = async function(fileId) {
        if (!confirm("确定要删除此文件吗? 此操作不可撤销.")) return;
        try {
            await api(`/api/v2/files/${fileId}`, { method: "DELETE" });
            toastSuccess("文件已删除");
            loadFiles();
        } catch (e) {
            toastError("删除失败: " + e.message);
        }
    };

    window.downloadUserFile = function(fileId) {
        const token = state.token || "";
        window.open(`/api/v2/files/${fileId}/download?token=${encodeURIComponent(token)}`, "_blank");
    };

    window.compressUserFile = async function(fileId) {
        try {
            toastInfo("正在压缩文件...");
            const result = await api(`/api/v2/files/${fileId}/compress`, { method: "POST" });
            if (result && result.success) {
                toastSuccess("压缩完成, 开始下载...");
                window.downloadFileZip(fileId);
            }
        } catch (e) {
            toastError("压缩失败: " + e.message);
        }
    };

    window.renameUserFile = async function(fileId, currentName) {
        const newName = prompt("请输入新名称:", currentName);
        if (!newName || newName === currentName) return;
        try {
            await api(`/api/v2/files/${fileId}/rename`, {
                method: "PATCH",
                body: JSON.stringify({ name: newName }),
            });
            toastSuccess("重命名成功");
            loadFiles();
        } catch (e) {
            toastError("重命名失败: " + e.message);
        }
    };

    window.downloadFileZip = function(fileId) {
        const token = state.token || "";
        window.open(`/api/v2/files/${fileId}/download-zip?token=${encodeURIComponent(token)}`, "_blank");
    };

    window.updateUserFile = async function(fileId, name, desc, price) {
        const newName = prompt("文件名称:", name);
        if (!newName) return;
        const newDesc = prompt("文件描述:", desc || "");
        const newPrice = prompt("价格 (0=免费):", String(price || 0));
        try {
            await api(`/api/v2/files/${fileId}/update`, {
                method: "PATCH",
                body: JSON.stringify({
                    name: newName,
                    description: newDesc,
                    price: parseFloat(newPrice) || 0,
                }),
            });
            toastSuccess("更新成功");
            loadFiles();
        } catch (e) {
            toastError("更新失败: " + e.message);
        }
    };

    /* ======================================================================
       23. 启动
       ====================================================================== */

    // 暴露部分函数供动态生成的内联按钮 (如加载失败重试) 调用
    window.__crystalgateReloadPanels = loadPanels;

    /* ======================================================================
       23.5 机器人管理 (管理员)
       ====================================================================== */
    async function loadBotManage() {
        const table = $("botManageTable");
        if (!table) return;
        const filter = ($("botManageFilter") || {}).value || "all";
        const q = ($("botManageSearch") || {}).value || "";
        try {
            const res = await api(`/api/v2/bot-manage/accounts?status=${encodeURIComponent(filter)}&q=${encodeURIComponent(q)}`);
            if (!res.success) {
                table.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-tertiary);">${escapeHtml(res.message || '加载失败')}</td></tr>`;
                return;
            }
            const st = res.stats || {};
            if ($("botManageTotal")) $("botManageTotal").textContent = st.total || 0;
            if ($("botManageUsable")) $("botManageUsable").textContent = st.usable || 0;
            if ($("botManageInUse")) $("botManageInUse").textContent = st.in_use || 0;
            if ($("botManageBanned")) $("botManageBanned").textContent = st.banned || 0;
            const rows = res.data || [];
            if (rows.length === 0) {
                table.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-tertiary);">暂无数据</td></tr>`;
                return;
            }
            table.innerHTML = rows.map(r => {
                const statusBadge = r.banned
                    ? '<span style="color:#f85149;background:#f8514922;border:1px solid #f8514944;padding:2px 8px;border-radius:9999px;font-size:11px;white-space:nowrap;display:inline-block;">已封禁</span>'
                    : r.in_use
                        ? '<span style="color:#d29922;background:#d2992222;border:1px solid #d2992244;padding:2px 8px;border-radius:9999px;font-size:11px;white-space:nowrap;display:inline-block;">使用中</span>'
                        : (r.uid && r.uid.length > 0)
                            ? '<span style="color:#3fb950;background:#3fb95022;border:1px solid #3fb95044;padding:2px 8px;border-radius:9999px;font-size:11px;white-space:nowrap;display:inline-block;">可用</span>'
                            : '<span style="color:#7d8590;background:#7d859022;border:1px solid #7d859044;padding:2px 8px;border-radius:9999px;font-size:11px;white-space:nowrap;display:inline-block;">空号</span>';
                // V1.5: 封禁/解封按钮已移除 (封禁由进服时服务端拒绝自动标记; 手工封禁无意义)
                const created = r.created_at ? new Date(r.created_at * 1000).toLocaleString('zh-CN') : '-';
                // 账号来源: CG_ 自注册号 (已被风控) vs 公益号池号
                const isSelfReg = (r.name || '').startsWith('CG_');
                const typeBadge = isSelfReg
                    ? '<span style="color:#f85149;font-size:11px;">自注册(已判死)</span>'
                    : '<span style="color:#58a6ff;font-size:11px;">公益号池</span>';
                return `<tr>
                    <td><span class="mono">${escapeHtml(r.name)}</span></td>
                    <td>${escapeHtml(r.real_name || '-')}</td>
                    <td>${typeBadge}</td>
                    <td>${escapeHtml(r.owner_username || '系统')}</td>
                    <td style="font-size:12px;">${created}</td>
                    <td>${statusBadge}</td>
                    <td class="mono" style="font-size:12px;">${escapeHtml(r.uid || '-')}</td>
                </tr>`;
            }).join("");
        } catch (err) {
            table.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-tertiary);">${escapeHtml(err.message || '加载失败')}</td></tr>`;
        }
    }
    window.botManageBan = async function(id) {
        try {
            const res = await api(`/api/v2/bot-manage/accounts/${id}/ban`, { method: "POST" });
            if (res.success) { toastSuccess("已封禁"); loadBotManage(); }
        } catch (e) { toastError("操作失败"); }
    };
    window.botManageUnban = async function(id) {
        try {
            const res = await api(`/api/v2/bot-manage/accounts/${id}/unban`, { method: "POST" });
            if (res.success) { toastSuccess("已解封"); loadBotManage(); }
        } catch (e) { toastError("操作失败"); }
    };
    // 机器人注册: 倒计时/取消/步骤指示
    let _bcTimer = null;
    let _bcDeadline = 0;

    /** 点击验证码内容 → 复制并 toast 提示 (不在格子内显示已复制) */
    window.copyBcSmsContent = function() {
        const t = ($("bcSmsContent") || {}).textContent || "";
        if (!t || t === "-") return;
        copyToClipboard(t);
        toastSuccess("已复制");
    };

    /** 点击号码 → 复制并 toast 提示 */
    window.copyBcSmsNumber = function() {
        const t = ($("bcSmsNumber") || {}).textContent || "";
        if (!t || t === "-") return;
        copyToClipboard(t);
        toastSuccess("已复制");
    };

    function resetBcView() {
        $("bcStep1").classList.remove("hidden");
        $("bcStep2").classList.add("hidden");
        $("bcStep3").classList.add("hidden");
        $("bcCancelBtn").classList.add("hidden");
        $("bcCancelBtn2").classList.add("hidden");
        $("bcCountdown").textContent = "";
        const cd2 = $("bcCountdown2");
        if (cd2) { cd2.style.display = "none"; cd2.textContent = ""; }
        $("bcResult").textContent = "";
        setBcStep(1);
    }

    window.startBotRegister = async function() {
        try {
            const res = await api("/bot-register/start", { method: "POST" });
            if (res.success && res.data) {
                $("bcSmsContent").textContent = res.data.sms_content;
                $("bcSmsNumber").textContent = res.data.sms_number;
                $("bcStep1").classList.add("hidden");
                $("bcStep2").classList.remove("hidden");
                $("bcCancelBtn").classList.add("hidden");
                $("bcCancelBtn2").classList.remove("hidden");
                // 步骤指示
                setBcStep(2);
                // 5分钟倒计时 (第2步内显示)
                _bcDeadline = Date.now() + 5 * 60 * 1000;
                if (_bcTimer) clearInterval(_bcTimer);
                const cd2 = $("bcCountdown2");
                if (cd2) cd2.style.display = "block";
                _bcTimer = setInterval(() => {
                    const left = _bcDeadline - Date.now();
                    const m = Math.max(0, Math.floor(left / 60000));
                    const s = Math.max(0, Math.floor((left % 60000) / 1000));
                    if (cd2) cd2.innerHTML = `<i class="fas fa-hourglass-half"></i> 剩余时间: <b>${m}分${String(s).padStart(2, "0")}秒</b>`;
                    if (left <= 0) {
                        clearInterval(_bcTimer);
                        _bcTimer = null;
                        // 超时: 自动回退到第1步
                        cancelBotRegister(true);
                        return;
                    }
                }, 1000);
                toastSuccess("注册任务已启动, 请发送验证短信");
            } else {
                toastError(res.message || "启动失败");
            }
        } catch (e) { toastError("启动失败, 请重试"); }
    };
    function setBcStep(n) {
        for (let i = 1; i <= 3; i++) {
            const ind = $("bcInd" + i);
            if (!ind) continue;
            ind.classList.toggle("done", i < n);
            ind.classList.toggle("active", i === n);
        }
        $("bcLine1").classList.toggle("done", n > 1);
        $("bcLine2").classList.toggle("done", n > 2);
    }
    window.cancelBotRegister = async function(auto = false) {
        if (_bcTimer) { clearInterval(_bcTimer); _bcTimer = null; }
        try { await api("/bot-register/cancel", { method: "POST" }); } catch (_) {}
        resetBcView();
        if (auto) toastWarn("注册已超时自动关闭, 请重新开始");
        else toastInfo("注册已关闭");
    };
    window.checkBotRegister = async function() {
        // 未真正发短信也允许点, 但后端会轮询等待真实结果; 先提示
        $("bcStep2").classList.add("hidden");
        $("bcStep3").classList.remove("hidden");
        $("bcCancelBtn2").classList.add("hidden");
        $("bcStatus").innerHTML = "<i class=\"fas fa-spinner fa-spin\"></i> 正在检测短信...";
        setBcStep(3);
        const timer = setInterval(async () => {
            try {
                const res = await api("/bot-register/check", { method: "POST" });
                if (res.success) {
                    clearInterval(timer);
                    if (_bcTimer) { clearInterval(_bcTimer); _bcTimer = null; }
                    const cd2 = $("bcCountdown2");
                    if (cd2) { cd2.style.display = "none"; }
                    $("bcStatus").innerHTML = "<i class=\"fas fa-check-circle\" style=\"color:#3fb950;\"></i> 注册成功";
                    toastSuccess("注册成功");
                    // 直接回到第1步 (开始创建机器人的界面)
                    setTimeout(() => {
                        resetBcView();
                        loadPanels();
                    }, 1200);
                } else if (res.timeout) {
                    // 后端确认超时
                    clearInterval(timer);
                    if (_bcTimer) { clearInterval(_bcTimer); _bcTimer = null; }
                    $("bcStatus").innerHTML = "<i class=\"fas fa-times-circle\" style=\"color:#f85149;\"></i> 注册超时";
                    toastError("注册超时, 请重新开始");
                    setTimeout(() => resetBcView(), 1500);
                } else if (!res.pending) {
                    clearInterval(timer);
                    $("bcStatus").innerHTML = "<i class=\"fas fa-times-circle\" style=\"color:#f85149;\"></i> " + (res.message || "失败");
                    // 失败后 3 秒回退到第2步可重试
                    setTimeout(() => {
                        $("bcStep2").classList.remove("hidden");
                        $("bcStep3").classList.add("hidden");
                        $("bcCancelBtn2").classList.remove("hidden");
                        setBcStep(2);
                    }, 3000);
                }
                // res.pending 继续轮询
            } catch (e) {
                clearInterval(timer);
                $("bcStatus").innerHTML = "<i class=\"fas fa-times-circle\" style=\"color:#f85149;\"></i> 检测失败, 请重试";
                setTimeout(() => {
                    $("bcStep2").classList.remove("hidden");
                    $("bcStep3").classList.add("hidden");
                    $("bcCancelBtn2").classList.remove("hidden");
                    setBcStep(2);
                }, 3000);
            }
        }, 3000);
    };
    // 初始化步骤指示
    setBcStep(1);
    window.queryIpPort = async function() {
        const typeEl = $("ipQueryType");
        const inputEl = $("ipQueryInput");
        if (!typeEl || !inputEl) return;
        // 动态输入提示 (按类型切换 placeholder)
        const PLACEHOLDERS = {
            rental: "请输入租赁服号",
            lobby: "请输入19位房间ID",
            local: "请输入房间号",
            mountain: "请输入山头号",
            player: "请输入玩家编号",
        };
        const setPlaceholder = () => {
            const t = typeEl.value;
            inputEl.placeholder = PLACEHOLDERS[t] || "请输入编号";
        };
        setPlaceholder();
        typeEl.removeEventListener("change", setPlaceholder);
        typeEl.addEventListener("change", setPlaceholder);
        const type = typeEl.value;
        const input = inputEl.value.trim();
        if (!input) { toastWarn(type === "player" ? "请输入玩家UID或昵称" : "请输入服务器号或房间号"); return; }
        // 玩家查询走独立端点
        if (type === "player") {
            const res = await api("/player/query", { method: "POST", body: { player_id: input } });
            if (bodyEl) {
                if (res.success && res.data) {
                    const p = res.data;
                    let html = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px;">
                        ${p.avatar ? `<img src="${escapeHtml(p.avatar)}" style="width:48px;height:48px;border-radius:8px;" onerror="this.style.display='none'">` : ''}
                        <div>
                            <div style="font-weight:700;font-size:16px;">${escapeHtml(p.name || "未知玩家")}</div>
                            ${p.level != null ? `<div style="font-size:12px;color:#d29922;">Lv.${p.level} ${p.exp != null ? `(${p.exp}/${p.need_exp || "?"})` : ""}${p.is_vip ? " 👑VIP" : ""}</div>` : ""}
                        </div>
                    </div>`;
                    html += `<div class="ipq-row"><span class="ipq-label">玩家UID</span><span class="mono">${escapeHtml(String(p.player_id || ""))}</span></div>`;
                    if (p.gender !== undefined && p.gender !== "") html += `<div class="ipq-row"><span class="ipq-label">性别</span><span>${p.gender === "0" ? "男" : (p.gender === "1" ? "女" : "未设置")}</span></div>`;
                    if (p.online_status) html += `<div class="ipq-row"><span class="ipq-label">在线状态</span><span>${escapeHtml(String(p.online_status))}</span></div>`;
                    if (p.register_time) html += `<div class="ipq-row"><span class="ipq-label">注册时间</span><span>${escapeHtml(formatTime(p.register_time))}</span></div>`;
                    if (p.login_time) html += `<div class="ipq-row"><span class="ipq-label">最近登录</span><span>${escapeHtml(formatTime(p.login_time))}</span></div>`;
                    if (p.signature) html += `<div class="ipq-row"><span class="ipq-label">签名</span><span>${escapeHtml(p.signature)}</span></div>`;


                    if (p.stats && Object.keys(p.stats).length) {
                        let statsHtml = "";
                        for (const [k, v] of Object.entries(p.stats)) {
                            if (v !== "" && v != null) statsHtml += `<span style="background:#0d1117;padding:4px 10px;border-radius:6px;font-size:12px;color:#e6edf3;">${escapeHtml(k)}: <b>${escapeHtml(String(v))}</b></span>`;
                        }
                        if (statsHtml) html += `<div class="ipq-row"><span class="ipq-label">数据</span><span style="display:flex;gap:6px;flex-wrap:wrap;">${statsHtml}</span></div>`;
                    }
                    if (p.friend_count != null) html += `<div class="ipq-row"><span class="ipq-label">好友数</span><span>${escapeHtml(String(p.friend_count))}</span></div>`;
                    html += `<div style="display:flex;gap:8px;margin-top:10px;">
                        <button class="btn btn-secondary btn-sm" data-copy="${escapeHtml(String(p.player_id || ""))}" style="flex:1;"><i class="fas fa-copy"></i> 复制UID</button>
                        <button class="btn btn-secondary btn-sm" data-copy="${escapeHtml(p.name || "")}" style="flex:1;"><i class="fas fa-copy"></i> 复制昵称</button>
                    </div>`;
                    bodyEl.innerHTML = html;
                    bodyEl.querySelectorAll("[data-copy]").forEach((el) => {
                        el.addEventListener("click", () => copyToClipboard(el.dataset.copy));
                    });
                } else {
                    bodyEl.innerHTML = `<div class="ipq-empty" style="color:var(--color-warning);"><i class="fas fa-user-slash"></i> ${escapeHtml(res.message || "未找到该玩家")}</div>`;
                }
            }
            if (resultEl) resultEl.classList.remove("hidden");
            return;
        }
        const resultEl = $("ipQueryResult");
        const bodyEl = $("ipQueryResultBody");
        if (bodyEl) bodyEl.innerHTML = `<div class="ipq-loading"><i class="fas fa-spinner fa-spin"></i> 查询中...</div>`;
        if (resultEl) resultEl.classList.remove("hidden");
        try {
            const res = await api(`/ip-query?type=${type}&code=${encodeURIComponent(input)}`);
            if (res.success && res.data) {
                const d = res.data;
                // 大厅搜索返回房间列表 (V1.6.2)
                if (d.rooms && Array.isArray(d.rooms)) {
                    let roomsHtml = `<div class="ipq-row" style="color:var(--color-success);font-size:13px;margin-bottom:10px;"><i class="fas fa-door-open"></i> 找到 ${d.rooms.length} 个房间</div>`;
                    d.rooms.forEach((rm, i) => {
                        const pw = rm.has_password ? '<span style="color:#f85149;">🔒有密码</span>' : '<span style="color:#3fb950;">🔓无密码</span>';
                        const ownerTxt = rm.owner_name ? escapeHtml(rm.owner_name) : (rm.owner_id ? "UID:" + escapeHtml(String(rm.owner_id)) : "未知");
                        const eid = escapeHtml(String(rm.entity_id || ""));
                        const rname = escapeHtml(rm.room_name || "未命名房间");
                        const rres = escapeHtml(rm.res_name || "—");
                        roomsHtml += `<div style="border:1px solid #30363d;border-radius:8px;padding:12px;margin-top:10px;background:#161b22;">
                            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                                <div style="font-weight:600;font-size:14px;white-space:nowrap;">${i + 1}. 房间 ${rname}</div>
                                <span style="font-size:12px;color:#8b949e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;">${rres}</span>
                            </div>
                            <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:#8b949e;margin-top:6px;align-items:center;">
                                <span>👥 ${rm.cur_num}/${rm.max_count}</span>
                                <span>👑 ${ownerTxt}</span>
                                <span>${pw}</span>
                                <span>v${escapeHtml(String(rm.version || "?"))}</span>
                            </div>
                            <div style="display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap;">
                                <span style="font-size:11px;color:#6e7681;">ID:</span>
                                <code style="background:#0d1117;padding:3px 8px;border-radius:4px;font-size:11px;color:#58a6ff;word-break:break-all;flex:1;min-width:140px;">${eid}</code>
                            </div>
                            <div style="display:flex;gap:8px;margin-top:10px;">
                                <button class="btn btn-secondary btn-sm" data-copy="${eid}" style="flex:1;"><i class="fas fa-copy"></i> 复制房间ID</button>
                                <button class="btn btn-secondary btn-sm" data-copy="${rname}" style="flex:1;"><i class="fas fa-copy"></i> 复制房间号</button>
                            </div>
                        </div>`;
                    });
                    if (bodyEl) {
                        bodyEl.innerHTML = roomsHtml;
                        bodyEl.querySelectorAll("[data-copy]").forEach((el) => {
                            el.addEventListener("click", () => copyToClipboard(el.dataset.copy));
                        });
                    }
                    return;
                }
                const full = (d.ip && d.port) ? `${d.ip}:${d.port}` : (d.ip_address || "");
                let html = "";
                if (d.ip && d.port) {
                    html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-globe"></i> IP地址</span><span class="mono">${escapeHtml(d.ip)}</span></div>`;
                    html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-plug"></i> 端口</span><span class="mono">${escapeHtml(d.port)}</span></div>`;
                }
                if (d.server_name) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-server"></i> 服务器名</span><span>${escapeHtml(d.server_name)}</span></div>`;
                else if (d.name) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-server"></i> 服务器名</span><span>${escapeHtml(d.name)}</span></div>`;
                if (d.owner_name) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-user-crown"></i> 服主/房主</span><span style="color:#d2a8ff;">${escapeHtml(d.owner_name)}</span></div>`;
                if (d.player_count != null && d.player_count !== "" && d.capacity != null && d.capacity !== "") {
                    html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-users"></i> 在线/容量</span><span>${escapeHtml(String(d.player_count))}/${escapeHtml(String(d.capacity))}</span></div>`;
                } else if (d.player_count != null && d.player_count !== "") {
                    html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-users"></i> 当前人数</span><span>${escapeHtml(String(d.player_count))}</span></div>`;
                }
                if (d.owner_id) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-id-card"></i> 房主UID</span><span class="mono">${escapeHtml(String(d.owner_id))}</span></div>`;
                if (d.mc_version) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-cube"></i> 游戏版本</span><span>${escapeHtml(d.mc_version)}</span></div>`;
                if (d.has_password !== undefined && d.has_password !== null) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-lock"></i> 密码</span><span>${d.has_password ? '<span style="color:#f85149;">🔒有密码</span>' : '<span style="color:#3fb950;">🔓无密码</span>'}</span></div>`;
                if (d.like_count != null && d.like_count !== "") html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-thumbs-up"></i> 点赞数</span><span>${escapeHtml(String(d.like_count))}</span></div>`;
                if (d.message) html += `<div class="ipq-row"><span class="ipq-label"><i class="fas fa-info-circle"></i> 信息</span><span>${escapeHtml(d.message)}</span></div>`;
                if (!html) html = `<div class="ipq-empty">未找到该房间信息</div>`;
                if (bodyEl) {
                    bodyEl.innerHTML = html;
                    // 底部一行: 右侧一键复制按钮 (固定栏, 不遮挡内容)
                    if (full) {
                        const bar = document.createElement("div");
                        bar.style.cssText = "display:flex;justify-content:flex-end;margin-top:14px;padding-top:10px;border-top:1px solid #30363d;";
                        const btn = document.createElement("button");
                        btn.className = "btn btn-primary btn-sm";
                        btn.innerHTML = `<i class="fas fa-copy"></i> 复制 IP:端口`;
                        btn.addEventListener("click", () => copyToClipboard(full));
                        bar.appendChild(btn);
                        bodyEl.appendChild(bar);
                    }
                    bodyEl.querySelectorAll("[data-copy]").forEach((el) => {
                        el.addEventListener("click", () => copyToClipboard(el.dataset.copy));
                    });
                }
            } else {
                if (bodyEl) bodyEl.innerHTML = `<div class="ipq-empty" style="color:var(--color-warning);"><i class="fas fa-search-minus"></i> ${escapeHtml(res.message || "未找到该房间")}</div>`;
            }
        } catch (e) {
            if (bodyEl) bodyEl.innerHTML = `<div class="ipq-empty" style="color:var(--color-danger);"><i class="fas fa-exclamation-circle"></i> 查询出错, 请重试</div>`;
        }
    };

    document.addEventListener("DOMContentLoaded", init);

})();


