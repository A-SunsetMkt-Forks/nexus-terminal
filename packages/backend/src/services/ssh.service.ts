import { Client, ClientChannel, ConnectConfig } from 'ssh2';
import { SocksClient, SocksClientOptions } from 'socks';
import http from 'http';
import net from 'net';
import * as ConnectionRepository from '../repositories/connection.repository';
import * as ProxyRepository from '../repositories/proxy.repository';
import { decrypt } from '../utils/crypto';

const CONNECT_TIMEOUT = 20000; // 连接超时时间 (毫秒)
const TEST_TIMEOUT = 15000; // 测试连接超时时间 (毫秒)

// 辅助接口：定义解密后的凭证和代理信息结构 (导出以便 websocket.ts 使用)
export interface DecryptedConnectionDetails {
    id: number;
    name: string;
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string; // Decrypted
    privateKey?: string; // Decrypted
    passphrase?: string; // Decrypted
    proxy?: {
        id: number;
        name: string;
        type: 'SOCKS5' | 'HTTP';
        host: string;
        port: number;
        username?: string;
        password?: string; // Decrypted
        // auth_method?: string; // Proxy auth method (如果需要可以保留)
        // privateKey?: string; // Decrypted proxy key (如果需要可以保留)
        // passphrase?: string; // Decrypted proxy passphrase (如果需要可以保留)
    } | null;
}

/**
 * 获取并解密指定 ID 的完整连接信息（包括代理）
 * @param connectionId 连接 ID
 * @returns Promise<DecryptedConnectionDetails> 解密后的连接详情
 * @throws Error 如果连接配置未找到或解密失败
 */
export const getConnectionDetails = async (connectionId: number): Promise<DecryptedConnectionDetails> => {
    console.log(`SshService: 获取连接 ${connectionId} 的详细信息...`);
    const rawConnInfo = await ConnectionRepository.findFullConnectionById(connectionId);
    if (!rawConnInfo) {
        throw new Error(`连接配置 ID ${connectionId} 未找到。`);
    }

    try {
        const fullConnInfo: DecryptedConnectionDetails = {
            id: rawConnInfo.id,
            // Add null check for required fields from rawConnInfo
            name: rawConnInfo.name ?? (() => { throw new Error(`Connection ID ${connectionId} has null name.`); })(),
            host: rawConnInfo.host ?? (() => { throw new Error(`Connection ID ${connectionId} has null host.`); })(),
            port: rawConnInfo.port ?? (() => { throw new Error(`Connection ID ${connectionId} has null port.`); })(),
            username: rawConnInfo.username ?? (() => { throw new Error(`Connection ID ${connectionId} has null username.`); })(),
            auth_method: rawConnInfo.auth_method ?? (() => { throw new Error(`Connection ID ${connectionId} has null auth_method.`); })(),
            password: (rawConnInfo.auth_method === 'password' && rawConnInfo.encrypted_password) ? decrypt(rawConnInfo.encrypted_password) : undefined,
            privateKey: (rawConnInfo.auth_method === 'key' && rawConnInfo.encrypted_private_key) ? decrypt(rawConnInfo.encrypted_private_key) : undefined,
            passphrase: (rawConnInfo.auth_method === 'key' && rawConnInfo.encrypted_passphrase) ? decrypt(rawConnInfo.encrypted_passphrase) : undefined,
            proxy: null,
        };

        if (rawConnInfo.proxy_db_id) {
             // Add null checks for required proxy fields inside the if block
             const proxyName = rawConnInfo.proxy_name ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null name.`); })();
             const proxyType = rawConnInfo.proxy_type ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null type.`); })();
             const proxyHost = rawConnInfo.proxy_host ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null host.`); })();
             const proxyPort = rawConnInfo.proxy_port ?? (() => { throw new Error(`Proxy for Connection ID ${connectionId} has null port.`); })();

             // Ensure proxyType is one of the allowed values
             if (proxyType !== 'SOCKS5' && proxyType !== 'HTTP') {
                throw new Error(`Proxy for Connection ID ${connectionId} has invalid type: ${proxyType}`);
             }

            fullConnInfo.proxy = {
                id: rawConnInfo.proxy_db_id, // Already checked by the if condition
                name: proxyName,
                type: proxyType, // Already validated
                host: proxyHost,
                port: proxyPort,
                username: rawConnInfo.proxy_username || undefined, // Optional, defaults to undefined
                password: rawConnInfo.proxy_encrypted_password ? decrypt(rawConnInfo.proxy_encrypted_password) : undefined, // Optional, handled by decrypt logic
                // 可以根据需要解密代理的其他凭证
            };
        }
        console.log(`SshService: 连接 ${connectionId} 的详细信息获取并解密成功。`);
        return fullConnInfo;
    } catch (decryptError: any) {
        console.error(`SshService: 处理连接 ${connectionId} 凭证或代理凭证失败:`, decryptError);
        throw new Error(`处理凭证失败: ${decryptError.message}`);
    }
};

/**
 * 根据解密后的连接详情建立 SSH 连接（处理代理）
 * @param connDetails - 解密后的连接详情
 * @param timeout - 连接超时时间 (毫秒)，可选
 * @returns Promise<Client> 连接成功的 SSH Client 实例
 * @throws Error 如果连接失败
 */
export const establishSshConnection = (
    connDetails: DecryptedConnectionDetails,
    timeout: number = CONNECT_TIMEOUT
): Promise<Client> => {
    return new Promise((resolve, reject) => {
        const sshClient = new Client();

        const connectConfig: ConnectConfig = {
            host: connDetails.host,
            port: connDetails.port,
            username: connDetails.username,
            password: connDetails.password,
            privateKey: connDetails.privateKey,
            passphrase: connDetails.passphrase,
            readyTimeout: timeout,
            keepaliveInterval: 10000, // 保持连接
            keepaliveCountMax: 10,
        };

        const readyHandler = async () => { // 改为 async 函数
            console.log(`SshService: SSH 连接到 ${connDetails.host}:${connDetails.port} (ID: ${connDetails.id}) 成功。`);
            sshClient.removeListener('error', errorHandler); // 成功后移除错误监听器

            try {
                const currentTimeSeconds = Math.floor(Date.now() / 1000);
                await ConnectionRepository.updateLastConnected(connDetails.id, currentTimeSeconds);
                console.log(`SshService: 已更新连接 ${connDetails.id} 的 last_connected_at 为 ${currentTimeSeconds}`);
            } catch (updateError) {
                // 更新失败不应阻止连接成功，但需要记录错误
                console.error(`SshService: 更新连接 ${connDetails.id} 的 last_connected_at 失败:`, updateError);
            }

            resolve(sshClient); // 返回 Client 实例
        };

        const errorHandler = (err: Error) => {
            console.error(`SshService: SSH 连接到 ${connDetails.host}:${connDetails.port} (ID: ${connDetails.id}) 失败:`, err);
            sshClient.removeListener('ready', readyHandler); // 失败后移除成功监听器
            sshClient.end(); // 确保关闭客户端
            reject(err);
        };

        sshClient.once('ready', readyHandler);
        sshClient.once('error', errorHandler);

        // --- 处理代理 ---
        if (connDetails.proxy) {
            const proxy = connDetails.proxy;
            console.log(`SshService: 应用代理 ${proxy.name} (${proxy.type}) 连接到 ${connDetails.host}:${connDetails.port}`);
            if (proxy.type === 'SOCKS5') {
                const socksOptions: SocksClientOptions = {
                    proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username, password: proxy.password },
                    command: 'connect',
                    destination: { host: connectConfig.host!, port: connectConfig.port! },
                    timeout: connectConfig.readyTimeout,
                };
                SocksClient.createConnection(socksOptions)
                    .then(({ socket }) => {
                        console.log(`SshService: SOCKS5 代理连接成功 (目标: ${connDetails.host}:${connDetails.port})。`);
                        connectConfig.sock = socket;
                        sshClient.connect(connectConfig);
                    })
                    .catch(socksError => {
                        errorHandler(new Error(`SOCKS5 代理 ${proxy.host}:${proxy.port} 连接失败: ${socksError.message}`));
                    });

            } else if (proxy.type === 'HTTP') {
                console.log(`SshService: 尝试通过 HTTP 代理 ${proxy.host}:${proxy.port} 建立隧道到 ${connDetails.host}:${connDetails.port}...`);
                const reqOptions: http.RequestOptions = {
                    method: 'CONNECT',
                    host: proxy.host,
                    port: proxy.port,
                    path: `${connectConfig.host}:${connectConfig.port}`,
                    timeout: connectConfig.readyTimeout,
                    agent: false
                };
                if (proxy.username) {
                    const auth = 'Basic ' + Buffer.from(proxy.username + ':' + (proxy.password || '')).toString('base64');
                    reqOptions.headers = { ...reqOptions.headers, 'Proxy-Authorization': auth, 'Proxy-Connection': 'Keep-Alive', 'Host': `${connectConfig.host}:${connectConfig.port}` };
                }
                const req = http.request(reqOptions);
                req.on('connect', (res, socket, head) => {
                    if (res.statusCode === 200) {
                        console.log(`SshService: HTTP 代理隧道建立成功 (目标: ${connDetails.host}:${connDetails.port})。`);
                        connectConfig.sock = socket;
                        sshClient.connect(connectConfig);
                    } else {
                        socket.destroy();
                        errorHandler(new Error(`HTTP 代理 ${proxy.host}:${proxy.port} 连接失败 (状态码: ${res.statusCode})`));
                    }
                });
                req.on('error', (err) => {
                    errorHandler(new Error(`HTTP 代理 ${proxy.host}:${proxy.port} 请求错误: ${err.message}`));
                });
                req.on('timeout', () => {
                    req.destroy();
                    errorHandler(new Error(`HTTP 代理 ${proxy.host}:${proxy.port} 连接超时`));
                });
                req.end();
            } else {
                errorHandler(new Error(`不支持的代理类型: ${proxy.type}`));
            }
        } else {
            // 无代理，直接连接
            console.log(`SshService: 无代理，直接连接到 ${connDetails.host}:${connDetails.port}`);
            sshClient.connect(connectConfig);
        }
    });
};

/**
 * 在已连接的 SSH Client 上打开 Shell 通道
 * @param sshClient - 已连接的 SSH Client 实例
 * @returns Promise<ClientChannel> Shell 通道实例
 * @throws Error 如果打开 Shell 失败
 */
export const openShell = (sshClient: Client): Promise<ClientChannel> => {
    return new Promise((resolve, reject) => {
        sshClient.shell((err, stream) => {
            if (err) {
                console.error(`SshService: 打开 Shell 失败:`, err);
                return reject(new Error(`打开 Shell 失败: ${err.message}`));
            }
            console.log(`SshService: Shell 通道已打开。`);
            resolve(stream);
        });
    });
};

/**
 * 测试给定 ID 的 SSH 连接（包括代理）
 * @param connectionId 连接 ID
 * @returns Promise<{ latency: number }> - 如果连接成功则 resolve 包含延迟的对象，否则 reject
 * @throws Error 如果连接失败或配置错误
 */
export const testConnection = async (connectionId: number): Promise<{ latency: number }> => {
    console.log(`SshService: 测试连接 ${connectionId}...`);
    let sshClient: Client | null = null;
    const startTime = Date.now(); // 开始计时
    try {
        // 1. 获取并解密连接信息
        const connDetails = await getConnectionDetails(connectionId);

        // 2. 尝试建立连接 (使用较短的测试超时时间)
        sshClient = await establishSshConnection(connDetails, TEST_TIMEOUT);

        const endTime = Date.now(); // 结束计时
        const latency = endTime - startTime;
        console.log(`SshService: 测试连接 ${connectionId} 成功，延迟: ${latency}ms。`);
        return { latency }; // 返回延迟
    } catch (error) {
        console.error(`SshService: 测试连接 ${connectionId} 失败:`, error);
        throw error; // 将错误向上抛出
    } finally {
        // 无论成功失败，都关闭 SSH 客户端
        if (sshClient) {
            sshClient.end();
            console.log(`SshService: 测试连接 ${connectionId} 的客户端已关闭。`);
        }
    }
};


/**
 * 测试未保存的 SSH 连接信息（包括代理）
 * @param connectionConfig - 包含连接参数的对象 (host, port, username, auth_method, password?, private_key?, passphrase?, proxy_id?)
 * @returns Promise<{ latency: number }> - 如果连接成功则 resolve 包含延迟的对象，否则 reject
 * @throws Error 如果连接失败或配置错误
 */
export const testUnsavedConnection = async (connectionConfig: {
    host: string;
    port: number;
    username: string;
    auth_method: 'password' | 'key';
    password?: string;
    private_key?: string; // 注意这里是 private_key
    passphrase?: string;
    proxy_id?: number | null;
}): Promise<{ latency: number }> => {
    console.log(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port}...`);
    let sshClient: Client | null = null;
    const startTime = Date.now(); // 开始计时
    try {
        // 1. 构建临时的 DecryptedConnectionDetails 结构
        const tempConnDetails: DecryptedConnectionDetails = {
            id: -1, // 临时 ID，不实际使用
            name: `Test-${connectionConfig.host}`, // 临时名称
            host: connectionConfig.host,
            port: connectionConfig.port,
            username: connectionConfig.username,
            auth_method: connectionConfig.auth_method,
            // 直接使用传入的凭证，因为它们是未加密的
            password: connectionConfig.password,
            privateKey: connectionConfig.private_key, // 映射 private_key
            passphrase: connectionConfig.passphrase,
            proxy: null, // 稍后填充
        };

        // 2. 如果提供了 proxy_id，获取并解密代理信息
        if (connectionConfig.proxy_id) {
            console.log(`SshService: 测试连接需要获取代理 ${connectionConfig.proxy_id} 的信息...`);
            const rawProxyInfo = await ProxyRepository.findProxyById(connectionConfig.proxy_id);
            if (!rawProxyInfo) {
                throw new Error(`代理 ID ${connectionConfig.proxy_id} 未找到。`);
            }
            try {
                 // Add null checks for required proxy fields
                 const proxyName = rawProxyInfo.name ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null name.`); })();
                 const proxyType = rawProxyInfo.type ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null type.`); })();
                 const proxyHost = rawProxyInfo.host ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null host.`); })();
                 const proxyPort = rawProxyInfo.port ?? (() => { throw new Error(`Proxy ID ${connectionConfig.proxy_id} has null port.`); })();

                 // Ensure proxyType is one of the allowed values
                 if (proxyType !== 'SOCKS5' && proxyType !== 'HTTP') {
                    throw new Error(`Proxy ID ${connectionConfig.proxy_id} has invalid type: ${proxyType}`);
                 }

                tempConnDetails.proxy = {
                    id: rawProxyInfo.id,
                    name: proxyName,
                    type: proxyType,
                    host: proxyHost,
                    port: proxyPort,
                    username: rawProxyInfo.username || undefined,
                    password: rawProxyInfo.encrypted_password ? decrypt(rawProxyInfo.encrypted_password) : undefined,
                };
                console.log(`SshService: 代理 ${connectionConfig.proxy_id} 信息获取并解密成功。`);
            } catch (decryptError: any) {
                console.error(`SshService: 处理代理 ${connectionConfig.proxy_id} 凭证失败:`, decryptError);
                throw new Error(`处理代理凭证失败: ${decryptError.message}`);
            }
        }

        // 3. 尝试建立连接 (使用较短的测试超时时间)
        sshClient = await establishSshConnection(tempConnDetails, TEST_TIMEOUT);

        const endTime = Date.now(); // 结束计时
        const latency = endTime - startTime;
        console.log(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port} 成功，延迟: ${latency}ms。`);
        return { latency }; // 返回延迟
    } catch (error) {
        console.error(`SshService: 测试未保存的连接到 ${connectionConfig.host}:${connectionConfig.port} 失败:`, error);
        throw error; // 将错误向上抛出
    } finally {
        // 无论成功失败，都关闭 SSH 客户端
        if (sshClient) {
            sshClient.end();
            console.log(`SshService: 测试未保存连接的客户端已关闭。`);
        }
    }
};

