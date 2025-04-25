import { defineStore } from 'pinia';
import apiClient from '../utils/apiClient'; // 使用统一的 apiClient
import router from '../router'; // 引入 router 用于重定向
import { setLocale } from '../i18n'; // 导入 setLocale

// 扩展的用户信息接口，包含 2FA 状态和语言偏好
interface UserInfo {
    id: number;
    username: string;
    isTwoFactorEnabled?: boolean; // 后端 /status 接口会返回这个
    language?: 'en' | 'zh'; // 新增：用户偏好语言
}

// 新增：登录请求的载荷接口
interface LoginPayload {
    username: string;
    password: string;
    rememberMe?: boolean; // 可选的“记住我”标志
}

// Public CAPTCHA Config Interface (mirrors backend public config)
interface PublicCaptchaConfig {
    enabled: boolean;
    provider: 'hcaptcha' | 'recaptcha' | 'none';
    hcaptchaSiteKey?: string;
    recaptchaSiteKey?: string;
}

// Auth Store State 接口
interface AuthState {
    isAuthenticated: boolean;
    user: UserInfo | null;
    isLoading: boolean;
    error: string | null;
    loginRequires2FA: boolean; // 新增状态：标记登录是否需要 2FA
    // 新增：存储 IP 黑名单数据 (虽然 actions 在这里，但 state 结构保持)
    ipBlacklist: {
        entries: any[]; // TODO: Define a proper type for blacklist entries
        total: number;
    };
    needsSetup: boolean; // 新增：是否需要初始设置
    publicCaptchaConfig: PublicCaptchaConfig | null; // NEW: Public CAPTCHA config
}

export const useAuthStore = defineStore('auth', {
    state: (): AuthState => ({
        isAuthenticated: false, // 初始为未登录
        user: null,
        isLoading: false,
        error: null,
        loginRequires2FA: false, // 初始为不需要
        ipBlacklist: { entries: [], total: 0 }, // 初始化黑名单状态
        needsSetup: false, // 初始假设不需要设置
        publicCaptchaConfig: null, // NEW: Initialize CAPTCHA config as null
    }),
    getters: {
        // 可以添加一些 getter，例如获取用户名
        loggedInUser: (state) => state.user?.username,
    },
    actions: {
        // 登录 Action - 更新为接受 LoginPayload + optional captchaToken
        async login(payload: LoginPayload & { captchaToken?: string }) { // Add captchaToken to payload
            this.isLoading = true;
            this.error = null;
            this.loginRequires2FA = false; // 重置 2FA 状态
            try {
                // 后端可能返回 user 或 requiresTwoFactor
                // 将完整的 payload (包含 rememberMe 和 captchaToken) 发送给后端
                const response = await apiClient.post<{ message: string; user?: UserInfo; requiresTwoFactor?: boolean }>('/auth/login', payload); // 使用 apiClient

                if (response.data.requiresTwoFactor) {
                    // 需要 2FA 验证
                    console.log('登录需要 2FA 验证');
                    this.loginRequires2FA = true;
                    // 不设置 isAuthenticated 和 user，等待 2FA 验证
                    return { requiresTwoFactor: true }; // 返回特殊状态给调用者
                } else if (response.data.user) {
                    // 登录成功 (无 2FA)
                    this.isAuthenticated = true;
                    this.user = response.data.user;
                    console.log('登录成功 (无 2FA):', this.user);
                    // 设置语言
                    if (this.user?.language) {
                        setLocale(this.user.language);
                    }
                    // await router.push({ name: 'Workspace' }); // 改为页面刷新
                    window.location.href = '/'; // 跳转到根路径并刷新
                    return { success: true };
                } else {
                    // 不应该发生，但作为防御性编程
                    throw new Error('登录响应无效');
                }
            } catch (err: any) {
                console.error('登录失败:', err);
                this.isAuthenticated = false;
                this.user = null;
                this.loginRequires2FA = false;
                this.error = err.response?.data?.message || err.message || '登录时发生未知错误。';
                return { success: false, error: this.error };
            } finally {
                this.isLoading = false;
            }
        },

        // 登录时的 2FA 验证 Action
        async verifyLogin2FA(token: string) {
            if (!this.loginRequires2FA) {
                throw new Error('当前登录流程不需要 2FA 验证。');
            }
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.post<{ message: string; user: UserInfo }>('/auth/login/2fa', { token }); // 使用 apiClient
                // 2FA 验证成功
                this.isAuthenticated = true;
                this.user = response.data.user;
                this.loginRequires2FA = false; // 重置状态
                console.log('2FA 验证成功，登录完成:', this.user);
                // 设置语言
                if (this.user?.language) {
                    setLocale(this.user.language);
                }
                // await router.push({ name: 'Workspace' }); // 改为页面刷新
                window.location.href = '/'; // 跳转到根路径并刷新
                return { success: true };
            } catch (err: any) {
                console.error('2FA 验证失败:', err);
                // 不清除 isAuthenticated 或 user，因为用户可能只是输错了验证码
                this.error = err.response?.data?.message || err.message || '2FA 验证时发生未知错误。';
                return { success: false, error: this.error };
            } finally {
                this.isLoading = false;
            }
        },


        // 登出 Action
        async logout() {
            this.isLoading = true;
            this.error = null;
            this.loginRequires2FA = false; // 重置 2FA 状态
            try {
                // 调用后端的登出 API
                await apiClient.post('/auth/logout'); // 使用 apiClient

                // 清除本地状态
                this.isAuthenticated = false;
                this.user = null;
                console.log('已登出');
                // 登出后重定向到登录页
                await router.push({ name: 'Login' });
            } catch (err: any) {
                console.error('登出失败:', err);
                this.error = err.response?.data?.message || err.message || '登出时发生未知错误。';
            } finally {
                this.isLoading = false;
            }
        },

        // 新增：检查并更新认证状态 Action
        async checkAuthStatus() {
            this.isLoading = true;
            try {
                const response = await apiClient.get<{ isAuthenticated: boolean; user: UserInfo }>('/auth/status'); // 使用 apiClient
                if (response.data.isAuthenticated && response.data.user) {
                    this.isAuthenticated = true;
                    this.user = response.data.user; // 更新用户信息，包含 isTwoFactorEnabled 和 language
                    this.loginRequires2FA = false; // 确保重置
                    console.log('认证状态已更新:', this.user);
                    // 设置语言
                    if (this.user?.language) {
                        setLocale(this.user.language);
                    }
                } else {
                    this.isAuthenticated = false;
                    this.user = null;
                    this.loginRequires2FA = false;
                }
            } catch (error: any) {
                // 如果获取状态失败 (例如 session 过期)，则认为未认证
                console.warn('检查认证状态失败:', error.response?.data?.message || error.message);
                this.isAuthenticated = false;
                this.user = null;
                this.loginRequires2FA = false;
                // 可选：如果不是 401 错误，可以记录更详细的日志
            } finally {
                this.isLoading = false;
            }
        },

        // 修改密码 Action
        async changePassword(currentPassword: string, newPassword: string) {
            if (!this.isAuthenticated) {
                throw new Error('用户未登录，无法修改密码。');
            }
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.put<{ message: string }>('/auth/password', { // 使用 apiClient
                    currentPassword,
                    newPassword,
                });
                console.log('密码修改成功:', response.data.message);
                // 密码修改成功后，通常不需要更新本地状态，但可以清除错误
                return true;
            } catch (err: any) {
                console.error('修改密码失败:', err);
                this.error = err.response?.data?.message || err.message || '修改密码时发生未知错误。';
                // 抛出错误，以便组件可以捕获并显示 (提供默认消息以防 this.error 为 null)
                throw new Error(this.error ?? '修改密码时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        // --- IP 黑名单管理 Actions ---
        /**
         * 获取 IP 黑名单列表
         * @param limit 每页数量
         * @param offset 偏移量
         */
        async fetchIpBlacklist(limit: number = 50, offset: number = 0) {
            this.isLoading = true;
            this.error = null;
            try {
                const response = await apiClient.get('/settings/ip-blacklist', { // 使用 apiClient
                    params: { limit, offset }
                });
                // 更新本地状态
                this.ipBlacklist.entries = response.data.entries;
                this.ipBlacklist.total = response.data.total;
                console.log('获取 IP 黑名单成功:', response.data);
                return response.data; // { entries: [], total: number }
            } catch (err: any) {
                console.error('获取 IP 黑名单失败:', err);
                this.error = err.response?.data?.message || err.message || '获取 IP 黑名单时发生未知错误。';
                // 确保抛出 Error 时提供字符串消息
                throw new Error(this.error ?? '获取 IP 黑名单时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        /**
         * 从 IP 黑名单中删除一个 IP
         * @param ip 要删除的 IP 地址
         */
        async deleteIpFromBlacklist(ip: string) {
            this.isLoading = true;
            this.error = null;
            try {
                await apiClient.delete(`/settings/ip-blacklist/${encodeURIComponent(ip)}`); // 使用 apiClient
                console.log(`IP ${ip} 已从黑名单删除`);
                // 从本地 state 中移除 (或者重新获取列表)
                this.ipBlacklist.entries = this.ipBlacklist.entries.filter(entry => entry.ip !== ip);
                this.ipBlacklist.total = Math.max(0, this.ipBlacklist.total - 1);
                return true;
            } catch (err: any) {
                console.error(`删除 IP ${ip} 失败:`, err);
                this.error = err.response?.data?.message || err.message || '删除 IP 时发生未知错误。';
                 // 确保抛出 Error 时提供字符串消息
                throw new Error(this.error ?? '删除 IP 时发生未知错误。');
            } finally {
                this.isLoading = false;
            }
        },

        // 新增：检查是否需要初始设置
        async checkSetupStatus() {
            // 不需要设置 isLoading，这个检查应该在后台快速完成
            try {
                const response = await apiClient.get<{ needsSetup: boolean }>('/auth/needs-setup'); // 使用 apiClient
                this.needsSetup = response.data.needsSetup;
                console.log(`[AuthStore] Needs setup status: ${this.needsSetup}`);
                return this.needsSetup; // 返回状态给调用者
            } catch (error: any) {
                console.error('检查设置状态失败:', error.response?.data?.message || error.message);
                // 如果检查失败，保守起见假设不需要设置，以避免卡在设置页面
                this.needsSetup = false;
                return false;
            }
        },

        // NEW: 获取公共 CAPTCHA 配置
        async fetchCaptchaConfig() {
            // Avoid refetching if already loaded
            if (this.publicCaptchaConfig !== null) return;

            // Don't set isLoading for this, it should be quick background fetch
            try {
                console.log('[AuthStore] Fetching public CAPTCHA config...');
                const response = await apiClient.get<PublicCaptchaConfig>('/auth/captcha/config');
                this.publicCaptchaConfig = response.data;
                console.log('[AuthStore] Public CAPTCHA config loaded:', this.publicCaptchaConfig);
            } catch (error: any) {
                console.error('获取公共 CAPTCHA 配置失败:', error.response?.data?.message || error.message);
                // Set a default disabled config on error to prevent blocking login UI
                this.publicCaptchaConfig = {
                    enabled: false,
                    provider: 'none',
                };
            }
        },
    },
    persist: true, // Revert to simple persistence to fix TS error for now
});
