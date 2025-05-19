
import * as ConnectionRepository from '../repositories/connection.repository';
import * as ProxyRepository from '../repositories/proxy.repository';
import * as TagService from '../services/tag.service'; 
import { getDbInstance, runDb, getDb as getDbRow, allDb } from '../database/connection';
import { decrypt, getEncryptionKeyBuffer as getCryptoKeyBuffer } from '../utils/crypto'; 
import { getAllDecryptedSshKeys, DecryptedSshKeyDetails } from '../services/ssh_key.service'; 
import archiver from 'archiver';
archiver.registerFormat('zip-encrypted', require("archiver-zip-encrypted"));




interface ImportedConnectionData {
    name: string;
    type: 'SSH' | 'RDP' | 'VNC'; 
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key'; // For SSH
    // Plaintext fields for export
    password?: string | null;
    private_key?: string | null;
    passphrase?: string | null;
    // Encrypted fields might still be part of the base ImportedConnectionData if it's used elsewhere
    encrypted_password?: string | null;
    encrypted_private_key?: string | null;
    encrypted_passphrase?: string | null;
    tag_ids?: number[];
    proxy?: {
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string | null;
        auth_method?: 'none' | 'password' | 'key'; // For proxy
        // Plaintext fields for proxy export
        password?: string | null;
        private_key?: string | null; // If proxy uses key auth
        passphrase?: string | null; // If proxy key has passphrase
        // Encrypted fields for proxy
        encrypted_password?: string | null;
        encrypted_private_key?: string | null;
        encrypted_passphrase?: string | null;
    } | null;
}

// This will represent the structure of the data *before* it's put into the JSON for export,
// containing plaintext sensitive info.
interface PlaintextExportConnectionData {
    name: string;
    type: 'SSH' | 'RDP' | 'VNC';
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key'; // SSH auth method
    password?: string | null; // Plaintext password
    private_key?: string | null; // Plaintext private key
    passphrase?: string | null; // Plaintext passphrase for key
    ssh_key_id?: number | null; // +++ Add SSH Key ID +++
    tag_ids?: number[];
    proxy?: {
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string | null;
        auth_method?: 'none' | 'password' | 'key'; // Proxy auth method
        password?: string | null; // Plaintext proxy password
        private_key?: string | null; // Plaintext proxy private key
        passphrase?: string | null; // Plaintext proxy key passphrase
    } | null;
}

export interface ImportResult {
    successCount: number;
    failureCount: number;
    errors: { connectionName?: string; message: string }[];
}


/**
 * 获取所有连接的明文数据以供导出。
 * 敏感信息将被解密。
 */
const getPlaintextConnectionsData = async (): Promise<PlaintextExportConnectionData[]> => {
    try {
        const db = await getDbInstance();

        // Ensure ExportRow reflects the updated FullConnectionData (which now includes 'type')
        type ExportRow = ConnectionRepository.FullConnectionData & { // FullConnectionData 包含 ssh_key_id
             proxy_db_id: number | null;
             proxy_name: string | null;
             proxy_type: 'SOCKS5' | 'HTTP' | null; // Proxy type remains the same
             proxy_host: string | null;
             proxy_port: number | null;
             proxy_username: string | null;
             proxy_auth_method: 'none' | 'password' | 'key' | null;
             proxy_encrypted_password?: string | null;
             proxy_encrypted_private_key?: string | null;
             proxy_encrypted_passphrase?: string | null;
        };


        const connectionsWithProxies = await allDb<ExportRow>(db,
            `SELECT
                c.*,
                p.id as proxy_db_id, p.name as proxy_name, p.type as proxy_type,
                p.host as proxy_host, p.port as proxy_port, p.username as proxy_username,
                p.auth_method as proxy_auth_method,
                p.encrypted_password as proxy_encrypted_password,
                p.encrypted_private_key as proxy_encrypted_private_key,
                p.encrypted_passphrase as proxy_encrypted_passphrase
             FROM connections c
             LEFT JOIN proxies p ON c.proxy_id = p.id
             ORDER BY c.name ASC`
        );


        const tagRows = await allDb<{ connection_id: number, tag_id: number }>(db,
            'SELECT connection_id, tag_id FROM connection_tags'
        );


        const tagsMap: { [connId: number]: number[] } = {};
        tagRows.forEach(row => {
            if (!tagsMap[row.connection_id]) tagsMap[row.connection_id] = [];
            tagsMap[row.connection_id].push(row.tag_id);
        });


        const formattedData: PlaintextExportConnectionData[] = connectionsWithProxies.map(row => {
            // Decrypt main connection sensitive data
            let plainPassword = null;
            if (row.encrypted_password) {
                try { plainPassword = decrypt(row.encrypted_password); }
                catch (e) { console.warn(`解密连接 [${row.name}] 密码失败: ${(e as Error).message}`); }
            }
            let plainPrivateKey = null;
            if (row.encrypted_private_key) {
                try { plainPrivateKey = decrypt(row.encrypted_private_key); }
                catch (e) { console.warn(`解密连接 [${row.name}] 私钥失败: ${(e as Error).message}`); }
            }
            let plainPassphrase = null;
            if (row.encrypted_passphrase) {
                try { plainPassphrase = decrypt(row.encrypted_passphrase); }
                catch (e) { console.warn(`解密连接 [${row.name}] 私钥密码失败: ${(e as Error).message}`); }
            }

            const connection: PlaintextExportConnectionData = {
                name: row.name ?? 'Unnamed',
                type: row.type,
                host: row.host,
                port: row.port,
                username: row.username,
                auth_method: row.auth_method, // Keep auth_method as is
                password: plainPassword,
                private_key: plainPrivateKey,
                passphrase: plainPassphrase,
                ssh_key_id: (row.type === 'SSH' && row.auth_method === 'key') ? row.ssh_key_id : null, // +++ Populate SSH Key ID +++
                tag_ids: tagsMap[row.id] || [],
                proxy: null
            };

            if (row.proxy_db_id && row.proxy_name && row.proxy_type && row.proxy_host && row.proxy_port !== null) {
                // Decrypt proxy sensitive data
                let proxyPlainPassword = null;
                if (row.proxy_encrypted_password) {
                    try { proxyPlainPassword = decrypt(row.proxy_encrypted_password); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 密码失败: ${(e as Error).message}`); }
                }
                let proxyPlainPrivateKey = null;
                if (row.proxy_encrypted_private_key) {
                    try { proxyPlainPrivateKey = decrypt(row.proxy_encrypted_private_key); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 私钥失败: ${(e as Error).message}`); }
                }
                let proxyPlainPassphrase = null;
                if (row.proxy_encrypted_passphrase) {
                    try { proxyPlainPassphrase = decrypt(row.proxy_encrypted_passphrase); }
                    catch (e) { console.warn(`解密代理 [${row.proxy_name}] 私钥密码失败: ${(e as Error).message}`); }
                }

                connection.proxy = {
                    name: row.proxy_name,
                    type: row.proxy_type,
                    host: row.proxy_host,
                    port: row.proxy_port,
                    username: row.proxy_username,
                    auth_method: row.proxy_auth_method ?? 'none',
                    password: proxyPlainPassword,
                    private_key: proxyPlainPrivateKey,
                    passphrase: proxyPlainPassphrase,
                };
            }
            return connection;
        });

        return formattedData;

    } catch (err: any) {
        console.error('Service: 获取明文连接数据时出错:', err.message);
        throw new Error(`获取明文连接数据失败: ${err.message}`);
    }
};

/**
 * 导出所有连接配置为一个加密的 ZIP 文件。
 * @param includeSshKeys 是否包含 SSH 密钥
 * @returns Buffer 包含加密的 ZIP 文件内容 (IV + Ciphertext + AuthTag)。
 */

// 辅助函数：安全地转义 CLI 参数，如果参数包含空格或引号，则用双引号括起来
function escapeCliArgument(value: string | number | null | undefined): string {
    if (value === null || value === undefined || String(value).trim() === '') {
        return '""'; // 返回空引号对，而不是空字符串，以保持参数位置
    }
    const strValue = String(value);
    // 如果字符串包含空格，或者已经是引号括起来的，或者包含特殊字符，则需要处理
    // 这里简化处理：如果包含空格或双引号，就用双引号包裹并转义内部双引号
    if (strValue.includes(' ') || strValue.includes('"')) {
        return `"${strValue.replace(/"/g, '\\"')}"`;
    }
    return strValue;
}


export const exportConnectionsAsEncryptedZip = async (includeSshKeys: boolean = false): Promise<Buffer> => {
    try {
        const connectionsData = await getPlaintextConnectionsData(); // This now returns PlaintextExportConnectionData[]
        const allTags = await TagService.getAllTags();
        const allSshKeys = includeSshKeys ? await getAllDecryptedSshKeys() : [];

        const tagsMap = new Map(allTags.map(tag => [tag.id, tag.name]));
        const sshKeysMap = new Map(allSshKeys.map(key => [key.id, key.name]));

        const scriptLines: string[] = [];

        for (const conn of connectionsData) {
            let line = `${conn.username}@${conn.host}:${conn.port}`;

            line += ` -type ${conn.type.toUpperCase()}`;
            if (conn.name && conn.name !== `${conn.username}@${conn.host}`) {
                 line += ` -name ${escapeCliArgument(conn.name)}`;
            }

            if (conn.type === 'SSH') {
                if (conn.auth_method === 'password' && conn.password) {
                    line += ` -p ${escapeCliArgument(conn.password)}`;
                } else if (conn.auth_method === 'key') {
                    // PlaintextExportConnectionData now includes ssh_key_id
                    if (conn.ssh_key_id && sshKeysMap.has(conn.ssh_key_id)) {
                        line += ` -k ${escapeCliArgument(sshKeysMap.get(conn.ssh_key_id)!)}`;
                        // Passphrase for named key is not directly supported in simple script line.
                        // It's assumed the key is usable or passphrase handled by agent.
                    } else if (conn.private_key) {
                        // This case (direct private key without a named ref) is not cleanly exportable to the simple script.
                        console.warn(`Connection ${conn.name} uses an SSH key by content, which cannot be directly represented by '-k <keyname>' in script export.`);
                    }
                }
            } else if ((conn.type === 'RDP' || conn.type === 'VNC') && conn.password) {
                line += ` -p ${escapeCliArgument(conn.password)}`;
            }

            if (conn.proxy) {
                line += ` -proxy-name ${escapeCliArgument(conn.proxy.name)}`;
                line += ` -proxy-type ${conn.proxy.type}`;
                line += ` -proxy-host ${escapeCliArgument(conn.proxy.host)}`;
                line += ` -proxy-port ${conn.proxy.port}`;
                if (conn.proxy.username) {
                    line += ` -proxy-username ${escapeCliArgument(conn.proxy.username)}`;
                }
                if (conn.proxy.auth_method && conn.proxy.auth_method !== 'none') {
                    line += ` -proxy-auth-method ${conn.proxy.auth_method}`;
                    if (conn.proxy.auth_method === 'password' && conn.proxy.password) {
                        line += ` -proxy-password ${escapeCliArgument(conn.proxy.password)}`;
                    } else if (conn.proxy.auth_method === 'key' && conn.proxy.private_key) {
                        line += ` -proxy-key ${escapeCliArgument('key-content-not-exported-for-security')}`;
                        if (conn.proxy.passphrase) {
                            line += ` -proxy-passphrase ${escapeCliArgument(conn.proxy.passphrase)}`;
                        }
                    }
                }
            }

            if (conn.tag_ids && conn.tag_ids.length > 0) {
                const tagNames = conn.tag_ids.map(id => tagsMap.get(id)).filter(name => !!name) as string[];
                if (tagNames.length > 0) {
                    line += ` -tags ${tagNames.map(escapeCliArgument).join(' ')}`;
                }
            }
            
            const connWithNotes = conn as PlaintextExportConnectionData & { notes?: string };
            if (connWithNotes.notes) { // notes is already part of PlaintextExportConnectionData
                 line += ` -note ${escapeCliArgument(connWithNotes.notes)}`;
            }
            
            scriptLines.push(line);
        }

        const connectionsScriptContent = scriptLines.join('\n');

        return new Promise<Buffer>((resolve, reject) => {
            const archive = archiver.create('zip', {
                zlib: { level: 9 }
            });

            const buffers: Buffer[] = [];

            archive.on('data', (chunk: Buffer) => {
                buffers.push(chunk);
            });

            archive.on('warning', (err: Error) => {
                console.warn('Archiver warning during export:', err);
            });

            // 'error' event should still be listened to for stream errors
            archive.on('error', (err: Error) => {
                console.error('Archiver stream error during export:', err);
                reject(new Error(`Archiver stream failed during export: ${err.message}`));
            });

            // archive.finalize() returns a promise that resolves when the archive is fully written.
            // No need to listen for 'finish' event separately if we await finalize().

            archive.append(connectionsScriptContent, { name: 'connections.txt' });

            if (includeSshKeys && allSshKeys.length > 0) {
                const sshKeysJsonContent = JSON.stringify(allSshKeys, null, 2);
                archive.append(sshKeysJsonContent, { name: 'ssh_keys.json' });
            }

            archive.finalize()
                .then(() => {
                    console.log('Archiver finalized successfully.');
                    resolve(Buffer.concat(buffers));
                })
                .catch(err => {
                    console.error('Error during archive.finalize():', err);
                    reject(new Error(`Failed to finalize archive: ${err.message}`));
                });
        });

    } catch (error: any) {
        console.error('Service: 导出连接 ZIP (outer try-catch) 时发生意外错误:', error);
        throw new Error(`导出连接 ZIP (archiver) 失败: ${error.message}`);
    }
};


/**
 * 导入连接配置
 * @param fileBuffer Buffer containing the JSON file content
 */
export const importConnections = async (fileBuffer: Buffer): Promise<ImportResult> => {
    let importedData: ImportedConnectionData[];
    try {
        const fileContent = fileBuffer.toString('utf8');
        importedData = JSON.parse(fileContent);
        if (!Array.isArray(importedData)) {
            throw new Error('JSON 文件内容必须是一个数组。');
        }
    } catch (error: any) {
        console.error('Service: 解析导入文件失败:', error);
        throw new Error(`解析 JSON 文件失败: ${error.message}`);
    }

    let successCount = 0;
    let failureCount = 0;
    const errors: { connectionName?: string; message: string }[] = [];
    const db = await getDbInstance();

    try {
        await runDb(db, 'BEGIN TRANSACTION');

        const connectionsToInsert: Array<Omit<ConnectionRepository.FullConnectionData, 'id' | 'created_at' | 'updated_at' | 'last_connected_at'> & { tag_ids?: number[] }> = [];
        const proxyCache: { [key: string]: number } = {}; 


        for (const connData of importedData) {
             try {

                // Validate imported data, including type
                if (!connData.type || !['SSH', 'RDP', 'VNC'].includes(connData.type)) {
                    throw new Error('缺少或无效的连接类型 (type)。');
                }
                if (!connData.name || !connData.host || !connData.port || !connData.username) {
                    throw new Error('缺少必要的连接字段 (name, host, port, username)。');
                }
                // Validate SSH specific fields only if type is SSH
                if (connData.type === 'SSH' && (!connData.auth_method || !['password', 'key'].includes(connData.auth_method))) {
                     throw new Error('SSH 连接缺少有效的认证方式 (auth_method)。');
                }
                // RDP specific validation (e.g., password required) could be added here if needed


                let proxyIdToUse: number | null = null;

                if (connData.proxy) {
                    const proxyData = connData.proxy;
                    if (!proxyData.name || !proxyData.type || !proxyData.host || !proxyData.port) {
                        throw new Error('代理信息不完整 (缺少 name, type, host, port)。');
                    }
                    const cacheKey = `${proxyData.name}-${proxyData.type}-${proxyData.host}-${proxyData.port}`;
                    if (proxyCache[cacheKey]) {
                        proxyIdToUse = proxyCache[cacheKey];
                    } else {
                        const existingProxy = await ProxyRepository.findProxyByNameTypeHostPort(proxyData.name, proxyData.type, proxyData.host, proxyData.port);
                        if (existingProxy) {
                            proxyIdToUse = existingProxy.id;
                        } else {
                            const newProxyData: Omit<ProxyRepository.ProxyData, 'id' | 'created_at' | 'updated_at'> = {
                                name: proxyData.name,
                                type: proxyData.type,
                                host: proxyData.host,
                                port: proxyData.port,
                                username: proxyData.username || null,
                                auth_method: proxyData.auth_method || 'none',
                                encrypted_password: proxyData.encrypted_password || null,
                                encrypted_private_key: proxyData.encrypted_private_key || null,
                                encrypted_passphrase: proxyData.encrypted_passphrase || null,
                            };
                            proxyIdToUse = await ProxyRepository.createProxy(newProxyData);
                            console.log(`Service: 导入连接 ${connData.name}: 新代理 ${proxyData.name} 创建成功 (ID: ${proxyIdToUse})`);
                        }
                        if (proxyIdToUse) proxyCache[cacheKey] = proxyIdToUse; 
                    }
                }

                // Prepare data for repository, ensuring correct auth_method for RDP
                const authMethodForDb = (connData.type === 'RDP' || connData.type === 'VNC') ? 'password' : connData.auth_method!;
                connectionsToInsert.push({
                    name: connData.name,
                    type: connData.type, // Add type
                    host: connData.host,
                    port: connData.port,
                    username: connData.username,
                    auth_method: authMethodForDb, // Use determined auth method
                    encrypted_password: connData.encrypted_password || null,
                    encrypted_private_key: connData.encrypted_private_key || null,
                    encrypted_passphrase: connData.encrypted_passphrase || null,
                    proxy_id: proxyIdToUse,
                    tag_ids: connData.tag_ids || []
                });

            } catch (connError: any) {
                failureCount++;
                errors.push({ connectionName: connData.name || '未知连接', message: connError.message });
                console.warn(`Service: 处理导入连接 "${connData.name || '未知'}" 时出错: ${connError.message}`);
            }
        } 
        let insertedResults: { connectionId: number, originalData: any }[] = [];
        if (connectionsToInsert.length > 0) {

             insertedResults = await ConnectionRepository.bulkInsertConnections(db, connectionsToInsert);
             successCount = insertedResults.length;
        }

        const insertTagSql = `INSERT OR IGNORE INTO connection_tags (connection_id, tag_id) VALUES (?, ?)`; 
        for (const result of insertedResults) {
            const originalTagIds = result.originalData?.tag_ids;
            if (Array.isArray(originalTagIds) && originalTagIds.length > 0) {
                const validTagIds = originalTagIds.filter((id: any) => typeof id === 'number' && id > 0);
                if (validTagIds.length > 0) {
                    const tagPromises = validTagIds.map(tagId =>
                        runDb(db, insertTagSql, [result.connectionId, tagId]).catch(tagError => {
                             console.warn(`Service: 导入连接 ${result.originalData.name}: 关联标签 ID ${tagId} 失败: ${tagError.message}`);
                        })
                    );
                    await Promise.all(tagPromises);
                }
            }
        }



        await runDb(db, 'COMMIT');
        console.log(`Service: 导入事务提交。成功: ${successCount}, 失败: ${failureCount}`);
        return { successCount, failureCount, errors };

    } catch (error: any) {

        console.error('Service: 导入事务处理出错，正在回滚:', error);
        try {
            await runDb(db, 'ROLLBACK');
        } catch (rollbackErr: any) {
            console.error("Service: 回滚事务失败:", rollbackErr);
        }
        failureCount = importedData.length;
        successCount = 0;
        errors.push({ message: `事务处理失败: ${error.message}` });
        return { successCount, failureCount, errors };
    }
};
