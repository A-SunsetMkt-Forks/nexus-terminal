import { Router } from 'express';
import { isAuthenticated } from '../auth/auth.middleware'; // 引入认证中间件
import {
    createTag,
    getTags,
    getTagById,
    updateTag,
    deleteTag
} from './tags.controller';

const router = Router();

// 应用认证中间件到所有标签路由
router.use(isAuthenticated);

// 定义标签相关的路由
router.post('/', createTag);       // POST /api/v1/tags - 创建新标签
router.get('/', getTags);         // GET /api/v1/tags - 获取标签列表
router.get('/:id', getTagById);   // GET /api/v1/tags/:id - 获取单个标签
router.put('/:id', updateTag);     // PUT /api/v1/tags/:id - 更新标签
router.delete('/:id', deleteTag); // DELETE /api/v1/tags/:id - 删除标签

export default router;
