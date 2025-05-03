import { Database } from 'sqlite3';
import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';


// Define Connection 类型 (可以从 controller 或 types 文件导入，暂时在此定义)
// 注意：这里不包含加密字段，因为 Repository 不应处理解密
interface ConnectionBase {
    id: number;
    name: string | null;
    type: 'SSH' | 'RDP'; // Add type field
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    proxy_id: number | null;
    created_at: number;
    updated_at: number;
    last_connected_at: number | null;
    ssh_key_id?: number | null; // +++ Add ssh_key_id here as well +++
notes?: string | null; // 新增备注字段
}

// ConnectionWithTagsRow implicitly includes 'type' and 'ssh_key_id' via ConnectionBase
interface ConnectionWithTagsRow extends ConnectionBase {
    tag_ids_str: string | null;
}

// ConnectionWithTags implicitly includes 'type' and 'ssh_key_id' via ConnectionBase
export interface ConnectionWithTags extends ConnectionBase {
    tag_ids: number[];
}

// 包含加密字段的完整类型，用于插入/更新
// FullConnectionData implicitly includes 'type' via ConnectionBase
export interface FullConnectionData extends ConnectionBase {
    encrypted_password?: string | null;
    encrypted_private_key?: string | null;
    encrypted_passphrase?: string | null;
notes?: string | null; // 新增备注字段
    tag_ids?: number[];
}


// FullConnectionDbRow implicitly includes 'type' via FullConnectionData
// Also add ssh_key_id here as it's part of the connection record itself
interface FullConnectionDbRow extends FullConnectionData {
    ssh_key_id?: number | null; // +++ Add ssh_key_id +++
    proxy_db_id: number | null;
    proxy_name: string | null;
    proxy_type: string | null;
    proxy_host: string | null;
    proxy_port: number | null;
    proxy_username: string | null;
    proxy_encrypted_password?: string | null;
    proxy_encrypted_private_key?: string | null;
    proxy_encrypted_passphrase?: string | null;
}


/**
 * 获取所有连接及其标签
 */
export const findAllConnectionsWithTags = async (): Promise<ConnectionWithTags[]> => {
    const sql = `
        SELECT
            c.id, c.name, c.type, c.host, c.port, c.username, c.auth_method, c.proxy_id, c.ssh_key_id, c.notes, -- +++ Select ssh_key_id and notes +++
            c.created_at, c.updated_at, c.last_connected_at,
            GROUP_CONCAT(ct.tag_id) as tag_ids_str
         FROM connections c
         LEFT JOIN connection_tags ct ON c.id = ct.connection_id
         GROUP BY c.id
         ORDER BY c.name ASC`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<ConnectionWithTagsRow>(db, sql);
        return rows.map(row => ({
            ...row,
            tag_ids: row.tag_ids_str ? row.tag_ids_str.split(',').map(Number).filter(id => !isNaN(id)) : []
        }));
    } catch (err: any) {
        console.error('Repository: 查询连接列表时出错:', err.message);
        throw new Error('获取连接列表失败');
    }
};

/**
 * 根据 ID 获取单个连接及其标签
 */
export const findConnectionByIdWithTags = async (id: number): Promise<ConnectionWithTags | null> => {
    const sql = `
        SELECT
            c.id, c.name, c.type, c.host, c.port, c.username, c.auth_method, c.proxy_id, c.ssh_key_id, c.notes, -- +++ Select ssh_key_id and notes +++
            c.created_at, c.updated_at, c.last_connected_at,
            GROUP_CONCAT(ct.tag_id) as tag_ids_str
         FROM connections c
         LEFT JOIN connection_tags ct ON c.id = ct.connection_id
         WHERE c.id = ?
         GROUP BY c.id`;
    try {
        const db = await getDbInstance();
        const row = await getDbRow<ConnectionWithTagsRow>(db, sql, [id]);
        if (row && typeof row.id !== 'undefined') {
            return {
                ...row,
                tag_ids: row.tag_ids_str ? row.tag_ids_str.split(',').map(Number).filter(id => !isNaN(id)) : []
            };
        } else {
            return null;
        }
    } catch (err: any) {
        console.error(`Repository: 查询连接 ${id} 时出错:`, err.message);
        throw new Error('获取连接信息失败');
    }
};

/**
 * 根据 ID 获取单个连接的完整信息 (包括加密字段和代理信息)
 */
export const findFullConnectionById = async (id: number): Promise<FullConnectionDbRow | null> => {
     const sql = `
         SELECT
             c.*, -- 选择 connections 表所有列
             p.id as proxy_db_id, p.name as proxy_name, p.type as proxy_type,
             p.host as proxy_host, p.port as proxy_port, p.username as proxy_username,
             p.encrypted_password as proxy_encrypted_password,
             p.encrypted_private_key as proxy_encrypted_private_key,
             p.encrypted_passphrase as proxy_encrypted_passphrase
          FROM connections c
          LEFT JOIN proxies p ON c.proxy_id = p.id
          WHERE c.id = ?`;
     try {
        const db = await getDbInstance();
        const row = await getDbRow<FullConnectionDbRow>(db, sql, [id]);
        return row || null;
     } catch (err: any) {
        console.error(`Repository: 查询连接 ${id} 详细信息时出错:`, err.message);
        throw new Error('获取连接详细信息失败');
     }
 };
 
 /**
  * 根据名称查找连接 (用于检查名称是否重复)
  */
 export const findConnectionByName = async (name: string): Promise<ConnectionBase | null> => {
     const sql = `SELECT id, name, type, host, port, username, auth_method, proxy_id, ssh_key_id, notes, created_at, updated_at, last_connected_at FROM connections WHERE name = ?`;
     try {
         const db = await getDbInstance();
         const row = await getDbRow<ConnectionBase>(db, sql, [name]);
         return row || null;
     } catch (err: any) {
         console.error(`Repository: 查询连接名称 "${name}" 时出错:`, err.message);
         throw new Error('查找连接名称失败');
     }
 };
 
 
 /**
  * 创建新连接 (不处理标签)
  */
// Update input type to reflect FullConnectionData now has 'type'
export const createConnection = async (data: Omit<FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at' | 'tag_ids'>): Promise<number> => {
    const now = Math.floor(Date.now() / 1000);
    const sql = `
        INSERT INTO connections (name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, proxy_id, ssh_key_id, notes, created_at, updated_at) -- +++ Add ssh_key_id and notes columns +++
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // +++ Add placeholders for ssh_key_id and notes +++
    const params = [
        data.name ?? null,
        data.type, // Add type parameter
        data.host, data.port, data.username, data.auth_method,
        data.encrypted_password ?? null, data.encrypted_private_key ?? null, data.encrypted_passphrase ?? null,
        data.proxy_id ?? null,
        data.ssh_key_id ?? null, // +++ Add ssh_key_id parameter +++
data.notes ?? null, // Add notes parameter
        now, now
    ];
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, params);
        if (typeof result.lastID !== 'number' || result.lastID <= 0) {
             throw new Error('创建连接后未能获取有效的 lastID');
        }
        return result.lastID;
    } catch (err: any) {
        console.error('Repository: 插入连接时出错:', err.message);
        throw new Error('创建连接记录失败');
    }
};

/**
 * 更新连接信息 (不处理标签)
 */
// Update input type to reflect FullConnectionData now has 'type'
export const updateConnection = async (id: number, data: Partial<Omit<FullConnectionData, 'id' | 'created_at' | 'last_connected_at' | 'tag_ids'>>): Promise<boolean> => {
    const fieldsToUpdate: { [key: string]: any } = { ...data };
    const params: any[] = [];

    delete fieldsToUpdate.id;
    delete fieldsToUpdate.created_at;
    delete fieldsToUpdate.last_connected_at;
    delete fieldsToUpdate.tag_ids;

    fieldsToUpdate.updated_at = Math.floor(Date.now() / 1000);

    const setClauses = Object.keys(fieldsToUpdate).map(key => `${key} = ?`).join(', ');
    Object.values(fieldsToUpdate).forEach(value => params.push(value ?? null));

    if (!setClauses) {
        console.warn(`[Repository] updateConnection called for ID ${id} with no fields to update.`);
        return false;
    }

    params.push(id);
    const sql = `UPDATE connections SET ${setClauses} WHERE id = ?`;

    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, params);
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${id} 时出错:`, err.message);
        throw new Error('更新连接记录失败');
    }
};


/**
 * 删除连接
 */
export const deleteConnection = async (id: number): Promise<boolean> => {
    const sql = `DELETE FROM connections WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [id]);
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 删除连接 ${id} 时出错:`, err.message);
        throw new Error('删除连接记录失败');
    }
};

/**
 * 更新指定连接的 last_connected_at 时间戳
 * @param id 连接 ID
 * @param timestamp Unix 时间戳 (秒)
 */
export const updateLastConnected = async (id: number, timestamp: number): Promise<boolean> => {
    const sql = `UPDATE connections SET last_connected_at = ? WHERE id = ?`;
    try {
        const db = await getDbInstance();
        const result = await runDb(db, sql, [timestamp, id]);
        if (result.changes === 0) {
            console.warn(`[Repository] updateLastConnected: No connection found with ID ${id} to update.`);
        }
        return result.changes > 0;
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${id} 的 last_connected_at 时出错:`, err.message);
        throw new Error('更新上次连接时间失败');
    }
};

/**
 * 更新连接的标签关联 (使用事务)
 * @param connectionId 连接 ID
 * @param tagIds 新的标签 ID 数组 (空数组表示清除所有标签)
 */
export const updateConnectionTags = async (connectionId: number, tagIds: number[]): Promise<boolean> => { // 修改返回类型为 boolean
    const db = await getDbInstance();

    // 1. 检查连接是否存在
    try {
        const connectionExists = await getDbRow<{ id: number }>(db, `SELECT id FROM connections WHERE id = ?`, [connectionId]);
        if (!connectionExists) {
            console.warn(`Repository: updateConnectionTags - Connection with ID ${connectionId} not found.`);
            return false; // 连接不存在，返回 false
        }
    } catch (checkErr: any) {
         console.error(`Repository: 检查连接 ${connectionId} 是否存在时出错:`, checkErr.message);
         throw new Error('检查连接是否存在时失败'); // 抛出检查错误
    }


    // 2. 执行标签更新事务
    try {
        await runDb(db, 'BEGIN TRANSACTION');

        // 删除旧关联
        await runDb(db, `DELETE FROM connection_tags WHERE connection_id = ?`, [connectionId]);

        // 插入新关联 (如果 tagIds 不为空)
        if (tagIds.length > 0) {
            const insertSql = `INSERT INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`;
            // 过滤无效 ID
            const validTagIds = tagIds.filter(tagId => typeof tagId === 'number' && tagId > 0);

            // 使用 Promise.all 确保所有插入完成或失败
            const insertPromises = validTagIds.map(tagId =>
                 runDb(db, insertSql, [connectionId, tagId])
            );
             // 如果任何插入失败，Promise.all 会 reject，错误会被下面的 catch 捕获
            await Promise.all(insertPromises);
        }

        await runDb(db, 'COMMIT');
        return true; // 事务成功提交，返回 true
    } catch (err: any) {
        console.error(`Repository: 更新连接 ${connectionId} 的标签关联事务出错:`, err.message);
        try {
            await runDb(db, 'ROLLBACK');
            console.log(`Repository: Transaction rolled back for connection ${connectionId} tag update.`);
        } catch (rollbackErr: any) {
            console.error(`Repository: 回滚连接 ${connectionId} 的标签更新事务失败:`, rollbackErr.message);
            // 即使回滚失败，原始错误也更重要
        }
        // 直接重新抛出原始事务错误，让上层处理
        // SQLite 在事务中遇到错误时通常会自动回滚
        throw err;
    }
};

/**
 * 查找指定连接的所有标签
 * @param connectionId 连接 ID
 * @returns 标签对象数组 { id: number, name: string }[]
 */
export const findConnectionTags = async (connectionId: number): Promise<{ id: number, name: string }[]> => {
    const sql = `
        SELECT t.id, t.name
        FROM tags t
        JOIN connection_tags ct ON t.id = ct.tag_id
        WHERE ct.connection_id = ?`;
    try {
        const db = await getDbInstance();
        const rows = await allDb<{ id: number, name: string }>(db, sql, [connectionId]);
        return rows;
    } catch (err: any) {
        console.error(`Repository: 查询连接 ${connectionId} 的标签时出错:`, err.message);
        throw new Error('获取连接标签失败');
    }
};

/**
 * 批量插入连接（用于导入）
 * 注意：此函数应在事务中调用 (由调用者负责事务)
 */
export const bulkInsertConnections = async (
    db: Database,
    // Update input type to reflect FullConnectionData now has 'type'
    connections: Array<Omit<FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at'> & { tag_ids?: number[] }>
): Promise<{ connectionId: number, originalData: any }[]> => {

    const insertConnSql = `INSERT INTO connections (name, type, host, port, username, auth_method, encrypted_password, encrypted_private_key, encrypted_passphrase, proxy_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`; // Add type and notes columns and placeholders
    const results: { connectionId: number, originalData: any }[] = [];
    const now = Math.floor(Date.now() / 1000);

    for (const connData of connections) {
        const params = [
            connData.name ?? null, connData.type, connData.host, connData.port, connData.username, connData.auth_method, // Add type parameter
            connData.encrypted_password || null,
            connData.encrypted_private_key || null,
            connData.encrypted_passphrase || null,
            connData.proxy_id || null,
connData.notes || null, // Add notes parameter
            now, now
        ];
        try {
            const connResult = await runDb(db, insertConnSql, params);
            if (typeof connResult.lastID !== 'number' || connResult.lastID <= 0) {
                 throw new Error(`插入连接 "${connData.name}" 后未能获取有效的 lastID`);
            }
            results.push({ connectionId: connResult.lastID, originalData: connData });
        } catch (err: any) {
             console.error(`Repository: 批量插入连接 "${connData.name}" 时出错: ${err.message}`);
             throw new Error(`批量插入连接 "${connData.name}" 失败`);
        }
    }
    return results;
};

/**
 * 为多个连接添加同一个标签 (使用事务)
 * @param connectionIds 连接 ID 数组
 * @param tagId 要添加的标签 ID
 */
export const addTagToMultipleConnections = async (connectionIds: number[], tagId: number): Promise<void> => {
    if (connectionIds.length === 0 || typeof tagId !== 'number' || tagId <= 0) {
        console.warn('[Repository] addTagToMultipleConnections called with empty connectionIds or invalid tagId.');
        return; // 无需操作
    }

    const db = await getDbInstance();
    try {
        await runDb(db, 'BEGIN TRANSACTION');

        const insertSql = `INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`;
        // 使用 Promise.all 确保所有插入完成或失败
        const insertPromises = connectionIds.map(connId =>
            runDb(db, insertSql, [connId, tagId])
        );
        await Promise.all(insertPromises);

        await runDb(db, 'COMMIT');
    } catch (err: any) {
        console.error(`Repository: 为多个连接添加标签 ${tagId} 时事务出错:`, err.message);
        try {
            await runDb(db, 'ROLLBACK');
        } catch (rollbackErr: any) {
            console.error(`Repository: 回滚为多个连接添加标签 ${tagId} 的事务失败:`, rollbackErr.message);
        }
        throw new Error(`为多个连接添加标签失败: ${err.message}`);
    }
};
