import express from 'express';
import * as appearanceController from './appearance.controller';
import { isAuthenticated } from '../auth/auth.middleware';

const router = express.Router();

// 应用认证中间件
router.use(isAuthenticated);

// GET /api/v1/appearance - 获取所有外观设置
router.get('/', appearanceController.getAppearanceSettingsController);

// PUT /api/v1/appearance - 更新外观设置 (文本类)
router.put('/', appearanceController.updateAppearanceSettingsController);

// POST /api/v1/appearance/background/page - 上传页面背景图片
router.post(
    '/background/page',
    appearanceController.uploadPageBackgroundMiddleware,
    appearanceController.uploadPageBackgroundController
);

// POST /api/v1/appearance/background/terminal - 上传终端背景图片
router.post(
    '/background/terminal',
    appearanceController.uploadTerminalBackgroundMiddleware,
    appearanceController.uploadTerminalBackgroundController
);

// TODO: 可能需要添加删除背景图片的路由

export default router;
