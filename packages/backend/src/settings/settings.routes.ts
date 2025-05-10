import express from 'express';
import { settingsController } from './settings.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = express.Router();


// GET /api/v1/settings/captcha - 获取公共 CAPTCHA 配置 (不含密钥)
router.get('/captcha', settingsController.getCaptchaConfig);

// 应用认证中间件，确保只有登录用户才能访问【受保护的】设置相关 API
router.use(isAuthenticated);

// 定义【受保护的】路由
router.get('/', settingsController.getAllSettings); // GET /api/v1/settings
router.put('/', settingsController.updateSettings); // PUT /api/v1/settings

// +++ 新增：焦点切换顺序路由 +++
// GET /api/v1/settings/focus-switcher-sequence - 获取焦点切换顺序
router.get('/focus-switcher-sequence', settingsController.getFocusSwitcherSequence);
// PUT /api/v1/settings/focus-switcher-sequence - 更新焦点切换顺序
router.put('/focus-switcher-sequence', settingsController.setFocusSwitcherSequence);

// +++ 新增：导航栏可见性路由 +++
// GET /api/v1/settings/nav-bar-visibility - 获取导航栏可见性
router.get('/nav-bar-visibility', settingsController.getNavBarVisibility);
// PUT /api/v1/settings/nav-bar-visibility - 更新导航栏可见性
router.put('/nav-bar-visibility', settingsController.setNavBarVisibility);

// +++ 新增：布局树路由 +++
// GET /api/v1/settings/layout - 获取布局树
router.get('/layout', settingsController.getLayoutTree);
// PUT /api/v1/settings/layout - 更新布局树
router.put('/layout', settingsController.setLayoutTree);

// --- IP 黑名单管理路由 ---
// GET /api/v1/settings/ip-blacklist - 获取 IP 黑名单列表 (需要认证)
router.get('/ip-blacklist', settingsController.getIpBlacklist);

// DELETE /api/v1/settings/ip-blacklist/:ip - 从黑名单中删除指定 IP (需要认证)
router.delete('/ip-blacklist/:ip', settingsController.deleteIpFromBlacklist);


// +++ 新增：终端选中自动复制路由 +++
// GET /api/v1/settings/auto-copy-on-select - 获取设置
router.get('/auto-copy-on-select', settingsController.getAutoCopyOnSelect);
// PUT /api/v1/settings/auto-copy-on-select - 更新设置
router.put('/auto-copy-on-select', settingsController.setAutoCopyOnSelect);

// +++ 新增：侧栏配置路由 +++
// GET /api/v1/settings/sidebar - 获取侧栏配置
router.get('/sidebar', settingsController.getSidebarConfig);
// PUT /api/v1/settings/sidebar - 更新侧栏配置
router.put('/sidebar', settingsController.setSidebarConfig);

// +++ 新增：显示连接标签路由 +++
// GET /api/v1/settings/show-connection-tags - 获取设置
router.get('/show-connection-tags', settingsController.getShowConnectionTags);
// PUT /api/v1/settings/show-connection-tags - 更新设置
router.put('/show-connection-tags', settingsController.setShowConnectionTags);

// +++ 新增：显示快捷指令标签路由 +++
// GET /api/v1/settings/show-quick-command-tags - 获取设置
router.get('/show-quick-command-tags', settingsController.getShowQuickCommandTags);
// PUT /api/v1/settings/show-quick-command-tags - 更新设置
router.put('/show-quick-command-tags', settingsController.setShowQuickCommandTags);

// +++ 新增：导出所有连接路由 +++
// GET /api/v1/settings/export-connections - 导出所有连接为加密的 ZIP 文件
router.get('/export-connections', settingsController.exportAllConnections);


export default router;

// +++ 新增：CAPTCHA 配置路由 (需要认证更新) +++
// PUT /api/v1/settings/captcha - 更新 CAPTCHA 配置
// 注意：这个路由定义在 `export default router` 之后，这是不正确的。
// 我会将它移到 `export default router` 之前，并确保它也在 `isAuthenticated` 中间件的作用域内。
// 然而，既然它已经存在，并且在 `isAuthenticated` 之后（通过 router.use(isAuthenticated)），
// 我们只需要确保导出路由也在正确的位置。
router.put('/captcha', settingsController.setCaptchaConfig);
