import { ref, readonly, type Ref, ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { sessions as globalSessionsRef } from '../stores/session/state'; // +++ 导入全局 sessions state +++
// import { useWebSocketConnection } from './useWebSocketConnection'; // 移除全局导入
import type { Terminal } from 'xterm';
import type { SearchAddon, ISearchOptions } from '@xterm/addon-search'; // *** 移除 ISearchResult 导入 ***
import type { WebSocketMessage, MessagePayload } from '../types/websocket.types';

// 定义与 WebSocket 相关的依赖接口
export interface SshTerminalDependencies {
    sendMessage: (message: WebSocketMessage) => void;
    onMessage: (type: string, handler: (payload: any, fullMessage?: WebSocketMessage) => void) => () => void;
    isConnected: ComputedRef<boolean>;
}

/**
 * 创建一个 SSH 终端管理器实例
 * @param sessionId 会话唯一标识符
 * @param wsDeps WebSocket 依赖对象
 * @param t i18n 翻译函数，从父组件传入
 * @returns SSH 终端管理器实例
 */
export function createSshTerminalManager(sessionId: string, wsDeps: SshTerminalDependencies, t: ReturnType<typeof useI18n>['t']) { // +++ Update type of t +++
    // 使用依赖注入的 WebSocket 函数
    const { sendMessage, onMessage, isConnected } = wsDeps;

    const terminalInstance = ref<Terminal | null>(null);
    const searchAddon = ref<SearchAddon | null>(null); // Keep searchAddon ref
    // Removed search result state refs
    // const searchResultCount = ref(0);
    // const currentSearchResultIndex = ref(-1);
    const terminalOutputBuffer = ref<string[]>([]); // 缓冲 WebSocket 消息直到终端准备好
    const isSshConnected = ref(false); // 新增：跟踪 SSH 连接状态

    // 辅助函数：获取终端消息文本
    const getTerminalText = (key: string, params?: Record<string, any>): string => {
        // 确保 i18n key 存在，否则返回原始 key
        const translationKey = `workspace.terminal.${key}`;
        const translated = t(translationKey, params || {});
        return translated === translationKey ? key : translated;
    };

    // --- 终端事件处理 ---

    // *** 更新 handleTerminalReady 签名以接收 searchAddon ***
    const handleTerminalReady = (payload: { terminal: Terminal; searchAddon: SearchAddon | null }) => {
        const { terminal: term, searchAddon: addon } = payload;
        console.log(`[会话 ${sessionId}][SSH终端模块] 终端实例已就绪。SearchAddon 实例:`, addon ? '存在' : '不存在');
        terminalInstance.value = term;
        searchAddon.value = addon; // *** 存储 searchAddon 实例 ***

        // *** 监听搜索结果变化 ***
        // if (searchAddon.value) {
        //     // *** 移除错误的类型注解，让 TS 推断 ***
        //     searchAddon.value.onDidChangeResults((results) => {
        //         // *** 添加更详细的日志 ***
        //         console.log(`[会话 ${sessionId}][SearchAddon] onDidChangeResults 事件触发! results:`, JSON.stringify(results)); // 使用 JSON.stringify 查看完整结构
        //         if (results && typeof results.resultIndex === 'number' && typeof results.resultCount === 'number') {
        //             // 确认 results 包含预期的数字属性
        //             searchResultCount.value = results.resultCount;
        //             currentSearchResultIndex.value = results.resultIndex; // xterm 的索引是从 0 开始的
        //             console.log(`[会话 ${sessionId}][SearchAddon] 状态已更新: index=${currentSearchResultIndex.value}, count=${searchResultCount.value}`);
        //         } else {
        //             // 没有结果、搜索被清除或 results 结构不符合预期
        //             console.log(`[会话 ${sessionId}][SearchAddon] 清除搜索状态或结果无效。 results:`, JSON.stringify(results)); // 使用 JSON.stringify 查看完整结构
        //             searchResultCount.value = 0;
        //             currentSearchResultIndex.value = -1;
        //              // console.log(`[会话 ${sessionId}][SearchAddon] 搜索结果清除或无匹配。`); // 这行日志有点重复，可以注释掉
        //         }
        //     });
        //     // *** 添加确认日志 ***
        //     console.log(`[会话 ${sessionId}][SearchAddon] onDidChangeResults 监听器已附加。`);
        // } else {
        //      console.warn(`[会话 ${sessionId}][SearchAddon] 无法附加 onDidChangeResults 监听器，searchAddon 实例为空。`);
        // }

        // --- 添加日志：检查缓冲区处理 ---
        // console.log(`[会话 ${sessionId}][SSH前端] handleTerminalReady: 准备处理缓冲区，缓冲区长度: ${terminalOutputBuffer.value.length}`);
        // if (terminalOutputBuffer.value.length > 0) {
        //     console.log(`[会话 ${sessionId}][SSH前端] handleTerminalReady: 内部缓冲区内容 (前100字符):`, terminalOutputBuffer.value.map(d => d.substring(0, 100)).join(' | '));
        // }
        // ---------------------------------
        
        // 1. 处理 SessionState.pendingOutput (来自 SSH_OUTPUT_CACHED_CHUNK 的早期数据)
        const currentSessionState = globalSessionsRef.value.get(sessionId);
        if (currentSessionState && currentSessionState.pendingOutput && currentSessionState.pendingOutput.length > 0) {
            // console.log(`[会话 ${sessionId}][SSH终端模块] 发现 SessionState.pendingOutput，长度: ${currentSessionState.pendingOutput.length}。正在写入...`);
            currentSessionState.pendingOutput.forEach(data => {
                term.write(data);
            });
            currentSessionState.pendingOutput = []; // 清空
            // console.log(`[会话 ${sessionId}][SSH终端模块] SessionState.pendingOutput 处理完毕。`);
            // 如果之前因为 pendingOutput 而将 isResuming 保持为 true，现在可以考虑更新
            if (currentSessionState.isResuming) {
                // 检查 isLastChunk 是否已收到 (这部分逻辑在 handleSshOutputCachedChunk 中，这里仅作标记清除)
                // 假设所有缓存块都已处理完毕
                // console.log(`[会话 ${sessionId}][SSH终端模块] 所有 pendingOutput 已写入，清除 isResuming 标记。`);
                currentSessionState.isResuming = false;
            }
        }

        // 2. 将此管理器内部缓冲的输出 (terminalOutputBuffer, 来自 ssh:output) 写入终端
        if (terminalOutputBuffer.value.length > 0) {
            terminalOutputBuffer.value.forEach(data => {
                 // console.log(`[会话 ${sessionId}][SSH前端] handleTerminalReady: 正在写入内部缓冲数据 (前100字符):`, data.substring(0, 100));
                 term.write(data);
            });
            // console.log(`[会话 ${sessionId}][SSH前端] handleTerminalReady: 内部缓冲区处理完成。`);
            terminalOutputBuffer.value = []; // 清空内部缓冲区
        }
        
        // 可以在这里自动聚焦或执行其他初始化操作
        // term.focus(); // 也许在 ssh:connected 时聚焦更好
    };

    const handleTerminalData = (data: string) => {
        // console.debug(`[会话 ${sessionId}][SSH终端模块] 接收到终端输入:`, data);
        sendMessage({ type: 'ssh:input', sessionId, payload: { data } });
    };

    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        // 添加日志，确认从 WorkspaceView 收到的尺寸
        console.log(`[SSH ${sessionId}] handleTerminalResize called with:`, dimensions);
        // 只有在连接状态下才发送 resize 命令给后端
        if (isConnected.value) {
            console.log(`[SSH ${sessionId}] Sending ssh:resize to backend:`, dimensions);
            sendMessage({ type: 'ssh:resize', sessionId, payload: dimensions });
        } else {
            console.log(`[SSH ${sessionId}] WebSocket not connected, skipping ssh:resize.`);
        }
    };

    // --- WebSocket 消息处理 ---

    const handleSshOutput = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        let outputData = payload;
        // 检查是否为 Base64 编码 (需要后端配合发送 encoding 字段)
        if (message?.encoding === 'base64' && typeof outputData === 'string') {
            try {
                // 使用更安全的Base64解码方式，保证中文字符正确解码
                const base64String = outputData;
                // 先用atob获取二进制字符串
                const binaryString = atob(base64String);
                // 创建Uint8Array存储二进制数据
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                }
                // 使用TextDecoder确保UTF-8正确解码
                outputData = new TextDecoder('utf-8').decode(bytes);
                
                // 如果输出仍然包含乱码字符，尝试其他编码
                if (outputData.includes('�')) {
                    console.warn(`[会话 ${sessionId}][SSH终端模块] UTF-8解码后仍有乱码，尝试其他编码...`);
                    // 尝试不同的编码
                    const encodings = ['gbk', 'gb18030', 'big5', 'iso-8859-1'];
                    for (const encoding of encodings) {
                        try {
                            const decoded = new TextDecoder(encoding).decode(bytes);
                            if (!decoded.includes('�')) {
                                outputData = decoded;
                                console.log(`[会话 ${sessionId}][SSH终端模块] 成功使用${encoding}解码`);
                                break;
                            }
                        } catch (encErr) {
                            // 忽略不支持的编码错误
                        }
                    }
                }
            } catch (e) {
                console.error(`[会话 ${sessionId}][SSH终端模块] Base64 解码失败:`, e, '原始数据:', message.payload);
                outputData = `\r\n[解码错误: ${e}]\r\n`; // 在终端显示解码错误
            }
        }
        // 如果不是 base64 或解码失败，确保它是字符串
        else if (typeof outputData !== 'string') {
             console.warn(`[会话 ${sessionId}][SSH终端模块] 收到非字符串 ssh:output payload:`, outputData);
             try {
                 outputData = JSON.stringify(outputData); // 尝试序列化
             } catch {
                 outputData = String(outputData); // 最后手段：强制转字符串
             }
        }

        // 尝试过滤掉非标准的 OSC 184 序列 (更强的过滤)
        if (typeof outputData === 'string' && outputData.includes('\x1b]184;')) {
            const originalLength = outputData.length;
            let cleanedData = '';
            let currentIndex = 0;
            let startIndex = outputData.indexOf('\x1b]184;');

            while (startIndex !== -1) {
                // 添加 OSC 序列之前的部分
                cleanedData += outputData.substring(currentIndex, startIndex);

                // 查找 OSC 序列的结束符 (BEL 或 ST)
                const belIndex = outputData.indexOf('\x07', startIndex);
                const stIndex = outputData.indexOf('\x1b\\', startIndex);

                let endIndex = -1;
                if (belIndex !== -1 && stIndex !== -1) {
                    endIndex = Math.min(belIndex, stIndex);
                } else if (belIndex !== -1) {
                    endIndex = belIndex;
                } else if (stIndex !== -1) {
                    endIndex = stIndex;
                }

                if (endIndex !== -1) {
                    // 找到结束符，跳过整个 OSC 序列
                    currentIndex = endIndex + (outputData[endIndex] === '\x07' ? 1 : 2); // 跳过 BEL(1) 或 ST(2)
                } else {
                    // 未找到结束符，可能序列不完整，保留 OSC 开始之后的部分
                    currentIndex = startIndex + 6; // 跳过 '\x1b]184;'
                    console.warn(`[会话 ${sessionId}][SSH终端模块] 未找到 OSC 184 的结束符，可能序列不完整。`);
                    break; // 停止处理，避免潜在问题
                }

                // 查找下一个 OSC 184 序列
                startIndex = outputData.indexOf('\x1b]184;', currentIndex);
            }

            // 添加剩余的部分
            cleanedData += outputData.substring(currentIndex);
            outputData = cleanedData;

            if (outputData.length < originalLength) {
                 console.warn(`[会话 ${sessionId}][SSH终端模块] 过滤掉 OSC 184 序列。`);
            }
        }

        // --- 添加前端日志 ---
        // console.log(`[会话 ${sessionId}][SSH前端] 收到 ssh:output 原始 payload (解码前):`, payload);
        // console.log(`[会话 ${sessionId}][SSH前端] 解码后的数据 (尝试写入):`, outputData);
        // --------------------

        if (terminalInstance.value) {
            // console.log(`[会话 ${sessionId}][SSH前端] 终端实例存在，尝试写入...`);
            terminalInstance.value.write(outputData);
            // console.log(`[会话 ${sessionId}][SSH前端] 写入完成。`);
        } else {
            // 如果终端还没准备好，先缓冲输出
            console.log(`[会话 ${sessionId}][SSH前端] 终端实例不存在，缓冲数据...`);
            terminalOutputBuffer.value.push(outputData);
        }
    };

    const handleSshConnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已连接。 Payload:`, payload, 'Full message:', message); // 更详细的日志
        isSshConnected.value = true; // 更新状态
        // 连接成功后聚焦终端
        terminalInstance.value?.focus();

        if (terminalInstance.value) {
            const currentDimensions = { cols: terminalInstance.value.cols, rows: terminalInstance.value.rows };
            // 检查尺寸是否有效
            if (currentDimensions.cols > 0 && currentDimensions.rows > 0) {
                console.log(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，主动发送初始尺寸:`, currentDimensions);
                sendMessage({ type: 'ssh:resize', sessionId, payload: currentDimensions });
            } else {
                console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但获取到的初始尺寸无效，跳过发送 resize:`, currentDimensions);
            }
        } else {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接成功，但 terminalInstance 不可用，无法发送初始 resize。`);
        }


        // 清空可能存在的旧缓冲（虽然理论上此时应该已经 ready 了）
        if (terminalOutputBuffer.value.length > 0) {
             console.warn(`[会话 ${sessionId}][SSH终端模块] SSH 连接时仍有缓冲数据，正在写入...`);
             terminalOutputBuffer.value.forEach(data => terminalInstance.value?.write(data));
             terminalOutputBuffer.value = [];
        }
    };

    const handleSshDisconnected = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const reason = payload || t('workspace.terminal.unknownReason'); // 使用 i18n 获取未知原因文本
        console.log(`[会话 ${sessionId}][SSH终端模块] SSH 会话已断开:`, reason);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('disconnectMsg', { reason })}\x1b[0m`);
        // 可以在这里添加其他清理逻辑，例如禁用输入
    };

    const handleSshError = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        const errorMsg = payload || t('workspace.terminal.unknownSshError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] SSH 错误:`, errorMsg);
        isSshConnected.value = false; // 更新状态
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('genericErrorMsg', { message: errorMsg })}\x1b[0m`);
    };

    const handleSshStatus = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 这个消息现在由 useWebSocketConnection 处理以更新全局状态栏消息
        // 这里可以保留日志或用于其他特定于终端的 UI 更新（如果需要）
        const statusKey = payload?.key || 'unknown';
        const statusParams = payload?.params || {};
        console.log(`[会话 ${sessionId}][SSH终端模块] 收到 SSH 状态更新:`, statusKey, statusParams);
        // 可以在终端打印一些状态信息吗？
        // terminalInstance.value?.writeln(`\r\n\x1b[34m[状态: ${statusKey}]\x1b[0m`);
    };

    const handleInfoMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        console.log(`[会话 ${sessionId}][SSH终端模块] 收到后端信息:`, payload);
        terminalInstance.value?.writeln(`\r\n\x1b[34m${getTerminalText('infoPrefix')} ${payload}\x1b[0m`);
    };

    const handleErrorMessage = (payload: MessagePayload, message?: WebSocketMessage) => {
        // 检查消息是否属于此会话
        if (message?.sessionId && message.sessionId !== sessionId) {
            return; // 忽略不属于此会话的消息
        }

        // 通用错误也可能需要显示在终端
        const errorMsg = payload || t('workspace.terminal.unknownGenericError'); // 使用 i18n
        console.error(`[会话 ${sessionId}][SSH终端模块] 收到后端通用错误:`, errorMsg);
        terminalInstance.value?.writeln(`\r\n\x1b[31m${getTerminalText('errorPrefix')} ${errorMsg}\x1b[0m`);
    };


    // --- 注册 WebSocket 消息处理器 ---
    const unregisterHandlers: (() => void)[] = [];

    const registerSshHandlers = () => {
        unregisterHandlers.push(onMessage('ssh:output', handleSshOutput));
        unregisterHandlers.push(onMessage('ssh:connected', handleSshConnected));
        unregisterHandlers.push(onMessage('ssh:disconnected', handleSshDisconnected));
        unregisterHandlers.push(onMessage('ssh:error', handleSshError));
        unregisterHandlers.push(onMessage('ssh:status', handleSshStatus));
        unregisterHandlers.push(onMessage('info', handleInfoMessage));
        unregisterHandlers.push(onMessage('error', handleErrorMessage)); // 也处理通用错误
        console.log(`[会话 ${sessionId}][SSH终端模块] 已注册 SSH 相关消息处理器。`);
    };

    const unregisterAllSshHandlers = () => {
        console.log(`[会话 ${sessionId}][SSH终端模块] 注销 SSH 相关消息处理器...`);
        unregisterHandlers.forEach(unregister => unregister?.());
        unregisterHandlers.length = 0; // 清空数组
    };

    // 初始化时自动注册处理程序
    registerSshHandlers();

    // --- 清理函数 ---
    const cleanup = () => {
        unregisterAllSshHandlers();
        // terminalInstance.value?.dispose(); // 终端实例的销毁由 TerminalComponent 负责
        terminalInstance.value = null;
        console.log(`[会话 ${sessionId}][SSH终端模块] 已清理。`);
    };

    /**
     * 直接发送数据到 SSH 会话 (例如，从命令输入栏)
     * @param data 要发送的字符串数据
     */
    const sendData = (data: string) => {
        // console.debug(`[会话 ${sessionId}][SSH终端模块] 直接发送数据:`, data);
        sendMessage({ type: 'ssh:input', sessionId, payload: { data } });
    };

    // --- 搜索相关方法 (移除计数逻辑) ---

    // Removed countOccurrences helper function

    const searchNext = (term: string, options?: ISearchOptions): boolean => {
        if (searchAddon.value) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchNext: "${term}"`);
            const found = searchAddon.value.findNext(term, options);
            // Removed manual count and state update
            return found;
        }
        console.warn(`[会话 ${sessionId}][SSH终端模块] searchNext 调用失败，searchAddon 不可用。`);
        // Removed state reset on failure
        return false;
    };

    const searchPrevious = (term: string, options?: ISearchOptions): boolean => {
        if (searchAddon.value) {
             console.log(`[会话 ${sessionId}][SSH终端模块] 执行 searchPrevious: "${term}"`);
            const found = searchAddon.value.findPrevious(term, options);
            // Removed manual count and state update
            return found;
        }
         console.warn(`[会话 ${sessionId}][SSH终端模块] searchPrevious 调用失败，searchAddon 不可用。`);
         // Removed state reset on failure
        return false;
    };

    const clearTerminalSearch = () => {
        if (searchAddon.value) {
            console.log(`[会话 ${sessionId}][SSH终端模块] 清除搜索高亮。`);
            searchAddon.value.clearDecorations();
        }
        // Removed state reset
        console.log(`[会话 ${sessionId}][SSH终端模块] 搜索高亮已清除 (状态不再管理)。`);
    };


    // 返回工厂实例
    return {
        // 公共接口
        handleTerminalReady,
        handleTerminalData, // 这个处理来自 xterm.js 的输入
        handleTerminalResize,
        sendData, // 新增：允许外部直接发送数据
        cleanup,
        // --- 搜索方法 ---
        searchNext,
        searchPrevious,
        clearTerminalSearch,
        // --- 暴露状态 ---
        isSshConnected: readonly(isSshConnected), // 暴露 SSH 连接状态 (只读)
        terminalInstance, // 暴露 terminal 实例，以便 WorkspaceView 可以写入提示信息
        // Removed search result state exposure
        // searchResultCount: readonly(searchResultCount),
        // currentSearchResultIndex: readonly(currentSearchResultIndex),
    };
}

// 保留兼容旧代码的函数（将在完全迁移后移除）
export function useSshTerminal(t: (key: string) => string) {
    console.warn('⚠️ 使用已弃用的 useSshTerminal() 全局单例。请迁移到 createSshTerminalManager() 工厂函数。');
    
    const terminalInstance = ref<Terminal | null>(null);
    
    const handleTerminalReady = (term: Terminal) => {
        console.log('[SSH终端模块][旧] 终端实例已就绪，但使用了已弃用的单例模式。');
        terminalInstance.value = term;
    };
    
    const handleTerminalData = (data: string) => {
        console.warn('[SSH终端模块][旧] 收到终端数据，但使用了已弃用的单例模式，无法发送。');
    };
    
    const handleTerminalResize = (dimensions: { cols: number; rows: number }) => {
        console.warn('[SSH终端模块][旧] 收到终端大小调整，但使用了已弃用的单例模式，无法发送。');
    };
    
    // 返回与旧接口兼容的空函数，以避免错误
    return {
        terminalInstance,
        handleTerminalReady,
        handleTerminalData,
        handleTerminalResize,
        registerSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 registerSshHandlers'),
        unregisterAllSshHandlers: () => console.warn('[SSH终端模块][旧] 调用了已弃用的 unregisterAllSshHandlers'),
    };
}
