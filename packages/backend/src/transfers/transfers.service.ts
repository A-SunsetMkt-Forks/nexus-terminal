import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid'; // 用于生成唯一ID
import { Client, ConnectConfig, SFTPWrapper } from 'ssh2';
import { InitiateTransferPayload, TransferTask, TransferSubTask } from './transfers.types';
import { getConnectionWithDecryptedCredentials } from '../services/connection.service';
import type { ConnectionWithTags, DecryptedConnectionCredentials } from '../types/connection.types';
// import { logger } from '../utils/logger'; // 假设的日志工具路径

export class TransfersService {
  private transferTasks: Map<string, TransferTask> = new Map();
  private taskAbortControllers: Map<string, AbortController> = new Map(); // +++ 用于存储任务的 AbortController +++
  private readonly TEMP_KEY_PREFIX = 'nexus_target_key_';
  private readonly MAX_CONCURRENT_SUB_TASKS = 5; // Maximum concurrent sub-tasks

  constructor() {
    console.info('[TransfersService] Initialized.');
  }

  public async initiateNewTransfer(payload: InitiateTransferPayload, userId: string | number): Promise<TransferTask> {
    const taskId = uuidv4();
    const now = new Date();
    const subTasks: TransferSubTask[] = [];
    const abortController = new AbortController(); // +++ 创建 AbortController +++
    this.taskAbortControllers.set(taskId, abortController); // +++ 存储 AbortController +++

    // 每个 (目标服务器, 源文件) 组合都是一个子任务
    for (const connectionId of payload.connectionIds) { // 目标服务器ID列表
      for (const item of payload.sourceItems) { // 源服务器上的文件/目录列表
        const subTaskId = uuidv4();
        subTasks.push({
          subTaskId,
          connectionId, // 这是目标服务器的ID
          sourceItemName: item.name, // 源文件的名称，用于标识
          status: 'queued',
          startTime: now,
        });
      }
    }

    const newTask: TransferTask = {
      taskId,
      status: 'queued',
      userId,
      createdAt: now,
      updatedAt: now,
      subTasks,
      payload, // payload 包含 sourceConnectionId
    };

    this.transferTasks.set(taskId, newTask);
    console.info(`[TransfersService] New transfer task created: ${taskId} for source ${payload.sourceConnectionId} with ${subTasks.length} sub-tasks.`);

    // 异步启动传输，不阻塞当前请求
    this.processTransferTask(taskId, abortController.signal).catch(error => { // +++ 传递 signal +++
        console.error(`[TransfersService] Error processing task ${taskId} in background:`, error);
        // 如果不是因为终止操作导致的错误，则更新状态
        if (error.name !== 'AbortError') {
          this.updateOverallTaskStatus(taskId, 'failed', `Background processing error: ${error.message}`);
        }
    });

    return { ...newTask }; // 返回任务的副本
  }

  public async cancelTransferTask(taskId: string, userId: string | number): Promise<boolean> {
    const task = this.transferTasks.get(taskId);
    if (!task || task.userId !== userId) {
      console.warn(`[TransfersService] Attempt to cancel non-existent task ${taskId} or task not owned by user ${userId}.`);
      return false;
    }

    const abortController = this.taskAbortControllers.get(taskId);
    if (abortController) {
      console.info(`[TransfersService] Cancelling task ${taskId}.`);
      abortController.abort(); // 触发终止信号

      // 更新主任务状态
      // 假设 'cancelling' 和 'cancelled' 是有效的状态
      if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') {
        this.updateOverallTaskStatus(taskId, 'cancelling', 'Task cancellation initiated by user.');
        // 可以在 processTransferTask 的 finally 中将状态设置为 'cancelled'
      }

      // 更新所有未完成的子任务状态
      task.subTasks.forEach(subTask => {
        if (subTask.status !== 'completed' && subTask.status !== 'failed' && subTask.status !== 'cancelled') {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', subTask.progress, 'Cancelled due to parent task cancellation.');
        }
      });
      
      // 确保在 AbortController Map 中移除，以防内存泄漏（如果任务不再处理）
      // 也可以在任务彻底结束后移除
      // this.taskAbortControllers.delete(taskId); // 暂时不在这里删除，可能在 processTransferTask 的 finally 中

      return true;
    }
    console.warn(`[TransfersService] No AbortController found for task ${taskId} to cancel.`);
    return false;
  }

  private buildSshConnectConfig(
    connectionInfo: ConnectionWithTags,
    credentials: DecryptedConnectionCredentials
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: connectionInfo.host,
      port: connectionInfo.port || 22,
      username: connectionInfo.username,
      readyTimeout: 20000, // 20 seconds
      keepaliveInterval: 10000, // 10 seconds
    };
    if (connectionInfo.auth_method === 'password' && credentials.decryptedPassword) {
      config.password = credentials.decryptedPassword;
    } else if (connectionInfo.auth_method === 'key' && credentials.decryptedPrivateKey) {
      config.privateKey = credentials.decryptedPrivateKey;
      if (credentials.decryptedPassphrase) {
        config.passphrase = credentials.decryptedPassphrase;
      }
    }
    return config;
  }

  private async processTransferTask(taskId: string, signal: AbortSignal): Promise<void> { // +++ 接收 AbortSignal +++
    const task = this.transferTasks.get(taskId);
    if (!task) {
      console.error(`[TransfersService] Task ${taskId} not found for processing.`);
      return;
    }

    if (signal.aborted) {
      console.info(`[TransfersService] Task ${taskId} was cancelled before processing started.`);
      this.updateOverallTaskStatus(taskId, 'cancelled', 'Cancelled before start.');
      this.taskAbortControllers.delete(taskId); // 清理
      return;
    }

    this.updateOverallTaskStatus(taskId, 'in-progress');
    let sourceSshClient: Client | undefined;

    try {
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      const sourceConnectionResult = await getConnectionWithDecryptedCredentials(task.payload.sourceConnectionId);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      if (!sourceConnectionResult || !sourceConnectionResult.connection) {
        throw new Error(`Source connection with ID ${task.payload.sourceConnectionId} not found or inaccessible.`);
      }
      const { connection: sourceConnection, ...sourceCredentials } = sourceConnectionResult;

      sourceSshClient = new Client();
      const sourceConnectConfig = this.buildSshConnectConfig(sourceConnection, sourceCredentials);

      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(new DOMException('Transfer cancelled by user.', 'AbortError'));

        const onAbort = () => {
          sourceSshClient?.end(); // 尝试关闭连接
          reject(new DOMException('Transfer cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });

        sourceSshClient!
          .on('ready', () => {
            signal.removeEventListener('abort', onAbort);
            console.info(`[TransfersService] SSH connection established to source server ${sourceConnection.host} for task ${taskId}.`);
            resolve();
          })
          .on('error', (err) => {
            signal.removeEventListener('abort', onAbort);
            console.error(`[TransfersService] SSH connection error to source server ${sourceConnection.host} for task ${taskId}:`, err);
            reject(err);
          })
          .on('close', () => {
             signal.removeEventListener('abort', onAbort);
             console.info(`[TransfersService] SSH connection closed to source server ${sourceConnection.host} for task ${taskId}.`);
          })
          .connect(sourceConnectConfig);
      });

      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      // New concurrent processing logic for sub-tasks
      const subTaskExecutionPromises: Promise<void>[] = []; // Stores promises for all initiated sub-tasks
      let currentlyActiveSubTasks = 0;
      const maxConcurrentSubTasks = this.MAX_CONCURRENT_SUB_TASKS;
      let currentSubTaskIndex = 0; // Points to the next sub-task in task.subTasks to be processed
      const totalSubTasks = task.subTasks.length;

      console.info(`[TransfersService] Task ${taskId}: Starting to process ${totalSubTasks} sub-tasks with max concurrency of ${maxConcurrentSubTasks}.`);

      // Wrapper function to process a single sub-task and manage active counts
      const processSingleSubTaskWrapper = async (subTask: TransferSubTask, subTaskIndexForLog: number): Promise<void> => {
        console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (index ${subTaskIndexForLog}) started. Active: ${currentlyActiveSubTasks}/${maxConcurrentSubTasks}`);
        
        if (signal.aborted) {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', undefined, 'Cancelled before start.');
          console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} cancelled before processing.`);
          return; // Do not process this sub-task
        }

        const currentSourceItem = task.payload.sourceItems.find(it => it.name === subTask.sourceItemName);
        if (!currentSourceItem) {
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, `Source item '${subTask.sourceItemName}' not found in payload.`);
          console.warn(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${subTask.sourceItemName}) - Source item not found.`);
          return;
        }

        try {
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
          this.updateSubTaskStatus(taskId, subTask.subTaskId, 'connecting', undefined, `Preparing transfer for ${currentSourceItem.name} to target ID ${subTask.connectionId}`);
          console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) - Connecting to target ID ${subTask.connectionId}.`);
          
          const targetConnectionResult = await getConnectionWithDecryptedCredentials(subTask.connectionId);
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

          if (!targetConnectionResult || !targetConnectionResult.connection) {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, `Target connection with ID ${subTask.connectionId} not found.`);
            return;
          }
          const { connection: targetConnection, ...targetCredentials } = targetConnectionResult;

          await this.executeRemoteTransferOnSource(
            taskId,
            subTask.subTaskId,
            sourceSshClient!,
            sourceConnection,
            currentSourceItem,
            targetConnection,
            targetCredentials,
            task.payload.remoteTargetPath,
            task.payload.transferMethod,
            signal // +++ Pass signal +++
          );
        } catch (subTaskError: any) {
          if (subTaskError.name === 'AbortError') {
            this.updateSubTaskStatus(taskId, subTask.subTaskId, 'cancelled', undefined, 'Sub-task cancelled by user.');
            console.info(`[TransfersService] Task ${taskId}: Sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) was cancelled.`);
          } else {
            console.error(`[TransfersService] Task ${taskId}: Error in sub-task ${subTask.subTaskId} (item: ${currentSourceItem.name}) wrapper:`, subTaskError.message, subTaskError.stack);
            const subTaskInstance = task.subTasks.find(st => st.subTaskId === subTask.subTaskId);
            if (subTaskInstance && subTaskInstance.status !== 'failed' && subTaskInstance.status !== 'completed' && subTaskInstance.status !== 'cancelled') {
               this.updateSubTaskStatus(taskId, subTask.subTaskId, 'failed', undefined, subTaskError.message || `Unknown error in sub-task ${subTask.subTaskId} wrapper.`);
            }
          }
        }
      };
      
      await new Promise<void>((resolveAllTasksCompleted, rejectAllTasksCompleted) => {
        const onAbortOverall = () => {
          console.info(`[TransfersService] Task ${taskId}: Overall cancellation signal received during sub-task processing phase.`);
          // Attempt to clean up / signal running sub-tasks is handled by individual sub-task signal checks
          rejectAllTasksCompleted(new DOMException('Transfer cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbortOverall, { once: true });

        const launchNextSubTaskIfPossible = () => {
          if (signal.aborted) { // Check before launching new sub-tasks
            console.info(`[TransfersService] Task ${taskId}: Abort signal detected, not launching more sub-tasks.`);
            if (currentlyActiveSubTasks === 0) resolveAllTasksCompleted(); // If no tasks are active, resolve.
            return;
          }

          while (currentlyActiveSubTasks < maxConcurrentSubTasks && currentSubTaskIndex < totalSubTasks) {
            const subTaskToProcess = task.subTasks[currentSubTaskIndex];
            // If sub-task is already marked (e.g. cancelled by overall cancel before it started), skip.
            if (subTaskToProcess.status === 'cancelled') {
                console.info(`[TransfersService] Task ${taskId}: Skipping already cancelled sub-task ${subTaskToProcess.subTaskId}`);
                currentSubTaskIndex++;
                if (currentSubTaskIndex === totalSubTasks && currentlyActiveSubTasks === 0) {
                     signal.removeEventListener('abort', onAbortOverall);
                     resolveAllTasksCompleted();
                }
                continue; // check next sub-task
            }

            const capturedIndexForLog = currentSubTaskIndex;
            currentlyActiveSubTasks++;
            currentSubTaskIndex++;

            const taskPromise = processSingleSubTaskWrapper(subTaskToProcess, capturedIndexForLog)
              .finally(() => {
                currentlyActiveSubTasks--;
                if (signal.aborted && currentlyActiveSubTasks === 0) {
                   console.info(`[TransfersService] Task ${taskId}: All active sub-tasks finished after main abort signal.`);
                   signal.removeEventListener('abort', onAbortOverall);
                   resolveAllTasksCompleted(); // All active tasks completed/aborted after main signal
                   return;
                }
                if (currentSubTaskIndex < totalSubTasks && !signal.aborted) {
                  launchNextSubTaskIfPossible();
                } else if (currentlyActiveSubTasks === 0) {
                  console.info(`[TransfersService] Task ${taskId}: All ${totalSubTasks} sub-tasks have completed or been skipped after processing.`);
                  signal.removeEventListener('abort', onAbortOverall);
                  resolveAllTasksCompleted();
                }
              });
            subTaskExecutionPromises.push(taskPromise);
          }
          // If all tasks were launched and some are still active, or if all tasks were skipped due to early cancellation
          if (currentSubTaskIndex === totalSubTasks && currentlyActiveSubTasks === 0 && !signal.aborted) {
             console.info(`[TransfersService] Task ${taskId}: All sub-tasks processed (no active, no more to launch).`);
             signal.removeEventListener('abort', onAbortOverall);
             resolveAllTasksCompleted();
          }
        };

        if (totalSubTasks === 0) {
            console.info(`[TransfersService] Task ${taskId}: No sub-tasks to process.`);
            signal.removeEventListener('abort', onAbortOverall);
            resolveAllTasksCompleted();
            return;
        }
        if (signal.aborted) { // Check if cancelled even before starting the loop
            console.info(`[TransfersService] Task ${taskId}: Cancelled before sub-task loop initiation.`);
            task.subTasks.forEach(st => { // Mark all sub-tasks as cancelled
                 if(st.status !== 'completed' && st.status !== 'failed') this.updateSubTaskStatus(taskId, st.subTaskId, 'cancelled', undefined, 'Task cancelled before sub-task execution.');
            });
            signal.removeEventListener('abort', onAbortOverall);
            rejectAllTasksCompleted(new DOMException('Transfer cancelled by user.', 'AbortError'));
            return;
        }
        launchNextSubTaskIfPossible();
      });
      
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.info(`[TransfersService] Task ${taskId} processing was aborted.`);
        this.updateOverallTaskStatus(taskId, 'cancelled', 'Transfer cancelled by user.');
      } else {
        console.error(`[TransfersService] Major error processing task ${taskId}:`, error);
        this.updateOverallTaskStatus(taskId, 'failed', error.message || 'Failed to process task due to a major error.');
      }
    } finally {
      if (sourceSshClient) { // 直接检查 sourceSshClient 是否存在
        try {
          sourceSshClient.end();
          console.info(`[TransfersService] SSH connection to source server explicitly closed for task ${taskId}.`);
        } catch (e) {
          console.warn(`[TransfersService] Error ending sourceSshClient for task ${taskId}:`, e)
        }
      }
      this.finalizeOverallTaskStatus(taskId); // Ensure final status is set
      this.taskAbortControllers.delete(taskId); // +++ Clean up AbortController +++
      if (task) { // task 可能未定义如果 taskId 错误
        console.info(`[TransfersService] Task ${taskId} processing finished. Final status: ${task.status}.`);
      } else {
        console.info(`[TransfersService] Task ${taskId} processing finished (task object was not found at the end).`);
      }
    }
  }

  private async checkCommandOnSource(client: Client, command: string): Promise<string | null> {
    return new Promise((resolve) => {
      const checkCmd = `command -v ${this.escapeShellArg(command)} 2>/dev/null`;
      console.error(`[Roo Debug][transfers.service.ts] checkCommandOnSource: Executing: ${checkCmd}`);
      client.exec(checkCmd, (err, stream) => {
        if (err) {
          console.warn(`[Roo Debug][transfers.service.ts] Error checking for command '${command}' on source:`, err);
          return resolve(null);
        }
        let stdout = '';
        stream
          .on('data', (data: Buffer) => stdout += data.toString())
          .on('close', (code: number) => {
            const foundPath = stdout.trim();
            if (code === 0 && foundPath) {
              console.error(`[Roo Debug][transfers.service.ts] checkCommandOnSource: Command '${command}' found at '${foundPath}'.`);
              resolve(foundPath);
            } else {
              console.warn(`[Roo Debug][transfers.service.ts] checkCommandOnSource: Command '${command}' not found (exit code: ${code}).`);
              resolve(null);
            }
          })
          .stderr.on('data', (data: Buffer) => { // Should be empty due to 2>/dev/null, but good to have
            console.warn(`[Roo Debug][transfers.service.ts] checkCommandOnSource: STDERR for '${command}': ${data.toString()}`);
          });
      });
    });
  }

  private async checkCommandOnTargetServer(targetConnection: ConnectionWithTags, targetCredentials: DecryptedConnectionCredentials, command: string): Promise<string | null> {
    const targetClient = new Client();
    const connectConfig = this.buildSshConnectConfig(targetConnection, targetCredentials);
    let foundCommandPath: string | null = null;

    console.error(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: Attempting to connect to target ${targetConnection.host} to check for command '${command}'.`);

    try {
      await new Promise<void>((resolve, reject) => {
        targetClient
          .on('ready', () => {
            console.info(`[TransfersService] SSH connection established to target server ${targetConnection.host} for command check.`);
            resolve();
          })
          .on('error', (err) => {
            console.error(`[TransfersService] SSH connection error to target server ${targetConnection.host} for command check:`, err);
            reject(err);
          })
          .on('close', () => {
             console.info(`[TransfersService] SSH connection closed to target server ${targetConnection.host} after command check.`);
          })
          .connect(connectConfig);
      });

      foundCommandPath = await new Promise((resolve) => {
        const checkCmd = `command -v ${this.escapeShellArg(command)} 2>/dev/null`;
        console.error(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: Executing on target: ${checkCmd}`);
        targetClient.exec(checkCmd, (err, stream) => {
          if (err) {
            console.warn(`[Roo Debug][transfers.service.ts] Error checking for command '${command}' on target ${targetConnection.host}:`, err);
            return resolve(null);
          }
          let stdout = '';
          stream
            .on('data', (data: Buffer) => stdout += data.toString())
            .on('close', (code: number) => {
              const pathOutput = stdout.trim();
              if (code === 0 && pathOutput) {
                console.error(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: Command '${command}' found at '${pathOutput}' on target ${targetConnection.host}.`);
                resolve(pathOutput);
              } else {
                console.warn(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: Command '${command}' not found on target ${targetConnection.host} (exit code: ${code}).`);
                resolve(null);
              }
            })
            .stderr.on('data', (data: Buffer) => {
              console.warn(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: STDERR for '${command}' on target ${targetConnection.host}: ${data.toString()}`);
            });
        });
      });
    } catch (error) {
      console.error(`[Roo Debug][transfers.service.ts] checkCommandOnTargetServer: Failed to check command '${command}' on target ${targetConnection.host}:`, error);
      foundCommandPath = null; // Ensure it's null on error
    } finally {
      targetClient.end();
    }
    return foundCommandPath;
  }
 
  private async uploadKeyToSourceViaSftp(client: Client, privateKeyContent: string, remotePath: string): Promise<void> {
    console.error(`[Roo Debug][transfers.service.ts] ENTERING uploadKeyToSourceViaSftp for remotePath: ${remotePath}`);
    const SFTP_UPLOAD_TIMEOUT_MS = 30000; // 30 seconds timeout for SFTP key upload

    return new Promise((resolve, reject) => {
      let timeoutHandle: NodeJS.Timeout | null = null;
      let sftpSession: SFTPWrapper | null = null; // To ensure sftp.end() can be called in timeout

      const cleanupAndReject = (errMsg: string, errObj?: any) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (errObj) console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp error: ${errMsg}`, errObj);
        else console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp error: ${errMsg}`);
        sftpSession?.end();
        reject(new Error(errMsg));
      };

      timeoutHandle = setTimeout(() => {
        cleanupAndReject(`SFTP upload to ${remotePath} timed out after ${SFTP_UPLOAD_TIMEOUT_MS / 1000}s.`);
      }, SFTP_UPLOAD_TIMEOUT_MS);

      console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: Calling client.sftp(). Timeout set for ${SFTP_UPLOAD_TIMEOUT_MS}ms.`);
      client.sftp((err, sftp) => {
        sftpSession = sftp; // Store session for potential cleanup
        if (err) {
          return cleanupAndReject(`SFTP session error for key upload: ${err.message}`, err);
        }
        if (!sftp) {
          return cleanupAndReject(`SFTP session error: SFTP object is null.`);
        }
        console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: client.sftp() CALLBACK success. SFTP session obtained. Creating write stream to ${remotePath}`);
        const stream = sftp.createWriteStream(remotePath, { mode: 0o600 });
        
        stream.on('error', (writeErr: Error) => {
          cleanupAndReject(`Failed to write key to ${remotePath} on source: ${writeErr.message}`, writeErr);
        });

        // Listen to 'close' instead of 'finish' for more reliability
        stream.on('close', () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: WriteStream ON CLOSE for ${remotePath}. Key upload likely successful.`);
          console.info(`[TransfersService] Private key for target successfully uploaded to source at ${remotePath}`);
          sftp.end();
          resolve();
        });
 
        console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: Previewing privateKeyContent before stream.end(). Length: ${privateKeyContent.length}`);
        console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: Key content START: <<<${privateKeyContent.substring(0, 70)}>>>`);
        console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: Key content END: <<<${privateKeyContent.substring(Math.max(0, privateKeyContent.length - 70))}>>>`);
        console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: Calling stream.end() to write key content.`);
        let keyContentToWrite = privateKeyContent;
        if (!keyContentToWrite.endsWith('\n')) {
          console.error(`[Roo Debug][transfers.service.ts] uploadKeyToSourceViaSftp: privateKeyContent does not end with a newline. Appending one.`);
          keyContentToWrite += '\n';
        }
        stream.end(keyContentToWrite);
      });
    });
  }
 
  private async deleteFileOnSourceViaSftp(client: Client, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(new Error(`SFTP session error for key deletion: ${err.message}`));
        sftp.unlink(remotePath, (unlinkErr) => {
          sftp.end(); // Ensure sftp session is closed
          if (unlinkErr) {
            // Log but don't necessarily reject if file just wasn't there (though it should be)
            console.warn(`[TransfersService] Failed to delete temporary key ${remotePath} from source:`, unlinkErr);
            return reject(new Error(`Failed to delete ${remotePath} from source: ${unlinkErr.message}`));
          }
          console.info(`[TransfersService] Temporary key ${remotePath} deleted from source.`);
          resolve();
        });
      });
    });
  }
  
  private escapeShellArg(arg: string): string {
    // Basic escaping for paths and arguments. More robust escaping might be needed.
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }

  private buildTransferCommandString(
    sourceItemPathOnA: string, // Absolute path on source A
    isDir: boolean,
    targetConnection: ConnectionWithTags, // Target B connection details
    targetPathOnB: string, // Base remote target path on B
    executableCommand: string, // Full path to rsync or scp
    commandType: 'rsync' | 'scp', // To distinguish logic
    options: { // Options derived from checking source A and target B auth
      sshPassCommand?: string; // e.g., "sshpass -p 'password'"
      sshIdentityFileOption?: string; // e.g., "-i /tmp/key_B_XYZ"
      targetUserAndHost: string; // e.g., "userB@hostB.com"
      sshPortOption?: string; // e.g., "-P 2222" for scp, or part of rsync's -e 'ssh -p 2222'
    }
  ): string {
    const remoteBase = targetPathOnB.endsWith('/') ? targetPathOnB : `${targetPathOnB}/`;
    const remoteFullDest = `${options.targetUserAndHost}:${this.escapeShellArg(remoteBase)}`;
 
    let commandParts: string[] = [];
    if (options.sshPassCommand) {
      commandParts.push(options.sshPassCommand);
    }
 
    // Use the full path here (should be safe, no special chars from command -v)
    // Arguments will still be quoted later.
    commandParts.push(executableCommand);
 
    if (commandType === 'rsync') {
      commandParts.push('-avz --progress'); // rsync specific options
      // For rsync, SSH options go into the -e argument
      let sshArgsForRsync = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
      if (options.sshPortOption && options.sshPortOption.startsWith('-p')) { // rsync uses -p for port in its -e "ssh -p XXX"
         sshArgsForRsync += ` ${options.sshPortOption}`;
      }
      if (options.sshIdentityFileOption) { // -i for identity file is an ssh option
        sshArgsForRsync += ` ${options.sshIdentityFileOption}`;
      }
      commandParts.push(`-e "${sshArgsForRsync.trim()}"`);
      
      let rsyncSourcePath = this.escapeShellArg(sourceItemPathOnA);
      if (isDir && !rsyncSourcePath.endsWith('/\'')) {
        rsyncSourcePath = rsyncSourcePath.slice(0, -1) + '/\'';
      }
      commandParts.push(rsyncSourcePath);
      commandParts.push(remoteFullDest);
 
    } else { // scp
      // For scp, SSH options are typically passed directly if scp is a wrapper around ssh, or via scp's own options that map to ssh options.
      // Common scp implementations accept -P for port and -i for identity file directly.
      // StrictHostKeyChecking and UserKnownHostsFile are ssh options.
      // We build the ssh part for scp separately if needed, or rely on scp passing -o options.
      // Let's assume scp will pass these -o options to its underlying ssh call.
      // If not, a more complex construction of scp's ssh command via -S might be needed.
      commandParts.push('-o StrictHostKeyChecking=no'); // For scp, pass as direct option
      commandParts.push('-o UserKnownHostsFile=/dev/null'); // For scp, pass as direct option
      if (isDir) commandParts.push('-r');
      if (options.sshPortOption && options.sshPortOption.startsWith('-P')) { // scp uses -P for port
         commandParts.push(options.sshPortOption);
      }
      if (options.sshIdentityFileOption) { // scp uses -i for identity file
        commandParts.push(options.sshIdentityFileOption);
      }
      commandParts.push(this.escapeShellArg(sourceItemPathOnA));
      commandParts.push(remoteFullDest);
    }
    return commandParts.join(' ');
  }
 
private async executeRemoteTransferOnSource(
  taskId: string,
  subTaskId: string,
  sourceSshClient: Client,
  sourceConnectionForInfo: ConnectionWithTags,
  sourceItem: { name: string; path: string; type: 'file' | 'directory' },
  targetConnection: ConnectionWithTags,
  targetCredentials: DecryptedConnectionCredentials,
  remoteTargetPathOnTarget: string,
  transferMethodPreference: 'auto' | 'rsync' | 'scp',
  signal: AbortSignal // +++ Add AbortSignal parameter +++
): Promise<void> {
  console.error(`[Roo Debug][transfers.service.ts] ENTERING executeRemoteTransferOnSource for sub-task ${subTaskId}, item: ${sourceItem.name}`);
  if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
  this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 0, `Initializing remote transfer for ${sourceItem.name}`);
  let tempTargetKeyPathOnSource: string | undefined;

    try {
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      console.error(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: Starting try block in executeRemoteTransferOnSource.`);
      // Pass signal to these check commands if they are made to support it. For now, they are quick.
      const sshpassPath = await this.checkCommandOnSource(sourceSshClient, 'sshpass' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      const rsyncPathOnSource = await this.checkCommandOnSource(sourceSshClient, 'rsync' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      const scpPathOnSource = await this.checkCommandOnSource(sourceSshClient, 'scp' /*, signal */);
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      console.error(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: Source checks -> sshpass: ${sshpassPath}, rsync: ${rsyncPathOnSource}, scp: ${scpPathOnSource}`);

      let executableCommandPath: string | null = null;
      let commandTypeForLogic: 'rsync' | 'scp' | undefined = undefined; // Initialize as undefined
      let rsyncPathOnTarget: string | null = null;

      if (transferMethodPreference === 'auto') {
        if (rsyncPathOnSource) {
          // Source has rsync, check target
          console.error(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: 'auto' mode, rsync found on source. Checking target...`);
          rsyncPathOnTarget = await this.checkCommandOnTargetServer(targetConnection, targetCredentials, 'rsync' /*, signal */);
          if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
          if (rsyncPathOnTarget) {
            executableCommandPath = rsyncPathOnSource;
            commandTypeForLogic = 'rsync';
          }
        }
        if (!commandTypeForLogic) { // If rsync not chosen, try SCP
          if (scpPathOnSource) {
            executableCommandPath = scpPathOnSource;
            commandTypeForLogic = 'scp';
          } else {
            throw new Error(`Neither Rsync nor SCP are available on source for ${sourceItem.name} (auto mode).`);
          }
        }
      } else if (transferMethodPreference === 'rsync') {
        if (!rsyncPathOnSource) throw new Error(`Rsync preferred but not available on source for ${sourceItem.name}.`);
        rsyncPathOnTarget = await this.checkCommandOnTargetServer(targetConnection, targetCredentials, 'rsync' /*, signal */);
        if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
        if (!rsyncPathOnTarget) throw new Error(`Rsync preferred, but not available on target for ${sourceItem.name}.`);
        executableCommandPath = rsyncPathOnSource;
        commandTypeForLogic = 'rsync';
      } else if (transferMethodPreference === 'scp') {
        if (!scpPathOnSource) throw new Error(`SCP preferred but not available on source for ${sourceItem.name}.`);
        executableCommandPath = scpPathOnSource;
        commandTypeForLogic = 'scp';
      }

      if (!executableCommandPath || !commandTypeForLogic) {
        throw new Error(`Could not determine a valid transfer command for ${sourceItem.name}.`);
      }
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');

      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 5, `Using ${commandTypeForLogic}.`);
      
      // +++ Declare and initialize cmdOptions here +++
      const cmdOptions: {
        targetUserAndHost: string;
        sshPortOption?: string;
        sshIdentityFileOption?: string;
        sshPassCommand?: string;
      } = {
        targetUserAndHost: `${targetConnection.username}@${targetConnection.host}`,
        sshPortOption: targetConnection.port ? (commandTypeForLogic === 'scp' ? `-P ${targetConnection.port}` : (commandTypeForLogic === 'rsync' ? `-p ${targetConnection.port}` : undefined)) : undefined,
      };
      const subTaskToUpdate = this.transferTasks.get(taskId)?.subTasks.find(st => st.subTaskId === subTaskId);
      if (subTaskToUpdate) subTaskToUpdate.transferMethodUsed = commandTypeForLogic;

      // +++ 自动创建目标目录 +++
      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 6, `Ensuring target directory ${this.escapeShellArg(remoteTargetPathOnTarget)} exists on ${targetConnection.host}.`);
      console.error(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: Ensuring target directory exists: ${remoteTargetPathOnTarget} on ${targetConnection.host}`);
      const targetClientForMkdir = new Client();
      const targetConnectConfigForMkdir = this.buildSshConnectConfig(targetConnection, targetCredentials);
      try {
        if (signal.aborted) throw new DOMException('Transfer cancelled by user (before mkdir).', 'AbortError');
        await new Promise<void>((resolveMkdir, rejectMkdir) => {
          let mkdirStreamClosed = false;
          const onAbortMkdir = () => {
            if (!mkdirStreamClosed) { // Only if stream/connection is still active
                targetClientForMkdir.end(); // Attempt to close the connection
            }
            rejectMkdir(new DOMException('Mkdir operation cancelled by user.', 'AbortError'));
          };
          signal.addEventListener('abort', onAbortMkdir, { once: true });

          targetClientForMkdir.on('ready', () => {
            if (signal.aborted) { // Check signal again after ready, before exec
              signal.removeEventListener('abort', onAbortMkdir);
              targetClientForMkdir.end();
              return rejectMkdir(new DOMException('Mkdir operation cancelled by user (on ready).', 'AbortError'));
            }
            const mkdirCommand = `mkdir -p ${this.escapeShellArg(remoteTargetPathOnTarget)}`;
            console.error(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: Executing on target for mkdir: ${mkdirCommand}`);
            targetClientForMkdir.exec(mkdirCommand, (err, stream) => {
              if (err) {
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                return rejectMkdir(err);
              }
              let mkdirStderr = '';
              stream.on('close', (code: number) => {
                mkdirStreamClosed = true;
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                if (code === 0) {
                  console.info(`[TransfersService] Sub-task ${subTaskId}: Target directory ${remoteTargetPathOnTarget} ensured on ${targetConnection.host}.`);
                  resolveMkdir();
                } else {
                  rejectMkdir(new Error(`Failed to create directory ${remoteTargetPathOnTarget} on ${targetConnection.host}. Exit code: ${code}. Stderr: ${mkdirStderr.trim()}`));
                }
              }).on('data', (data: Buffer) => {
                // stdout from mkdir -p is usually empty
              }).stderr.on('data', (data: Buffer) => {
                mkdirStderr += data.toString();
                console.warn(`[Roo Debug][transfers.service.ts] Sub-task ${subTaskId}: STDERR (mkdir on target): ${data.toString()}`);
              }).on('error', (streamErr: Error) => { // Handle stream errors specifically
                mkdirStreamClosed = true;
                signal.removeEventListener('abort', onAbortMkdir);
                targetClientForMkdir.end();
                rejectMkdir(streamErr);
              });
            });
          }).on('error', (connErr: Error) => {
            signal.removeEventListener('abort', onAbortMkdir);
            // targetClientForMkdir.end(); // .end() might not be needed if 'close' always follows 'error'
            rejectMkdir(connErr);
          }).on('close', () => { // This 'close' is for the client connection itself
            signal.removeEventListener('abort', onAbortMkdir); // Ensure cleanup if closed for other reasons
            // console.info(`[TransfersService] SSH connection for mkdir to target ${targetConnection.host} closed.`);
          }).connect(targetConnectConfigForMkdir);
        });

        if (signal.aborted) throw new DOMException('Transfer cancelled by user (after mkdir attempt).', 'AbortError');
        this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 8, `Target directory ensured. Preparing transfer command.`);

      } catch (mkdirError: any) {
        // Ensure client is closed on error if it's still somehow connected
        // (though on 'error' or exec stream 'close'/'error', it should be handled)
        if (targetClientForMkdir && (targetClientForMkdir as any)._sock && !(targetClientForMkdir as any)._sock.destroyed) {
             try { targetClientForMkdir.end(); } catch (e) { /* ignore */ }
        }
        console.error(`[TransfersService] Sub-task ${subTaskId}: Failed to ensure target directory ${remoteTargetPathOnTarget} on ${targetConnection.host}:`, mkdirError.message);
        if (mkdirError.name === 'AbortError') {
             this.updateSubTaskStatus(taskId, subTaskId, 'cancelled', undefined, `Directory creation cancelled: ${mkdirError.message}`);
             throw mkdirError; // Re-throw AbortError to be handled by the main try-catch
        }
        // For other errors, update status to failed and throw a new error to be caught by main try-catch
        this.updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, `Failed to create target directory: ${mkdirError.message}`);
        throw new Error(`Failed to create target directory ${remoteTargetPathOnTarget}: ${mkdirError.message}`); // This will be caught by the outer try-catch
      }
      // +++ 结束自动创建目标目录 +++

      if (targetConnection.auth_method === 'key' && targetCredentials.decryptedPrivateKey) {
        const randomSuffix = crypto.randomBytes(6).toString('hex');
        tempTargetKeyPathOnSource = path.posix.join('/tmp', `${this.TEMP_KEY_PREFIX}${randomSuffix}`);
        await this.uploadKeyToSourceViaSftp(sourceSshClient, targetCredentials.decryptedPrivateKey, tempTargetKeyPathOnSource);
        if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
        cmdOptions.sshIdentityFileOption = `-i ${this.escapeShellArg(tempTargetKeyPathOnSource)}`;
        if (targetCredentials.decryptedPassphrase && !sshpassPath) {
          throw new Error(`Target key has passphrase, but sshpass is not available on source for ${sourceItem.name}.`);
        }
        if (targetCredentials.decryptedPassphrase && sshpassPath) {
           cmdOptions.sshPassCommand = `${this.escapeShellArg(sshpassPath)} -p ${this.escapeShellArg(targetCredentials.decryptedPassphrase)}`;
        }
      } else if (targetConnection.auth_method === 'password' && targetCredentials.decryptedPassword) {
        if (!sshpassPath) {
          throw new Error(`Target uses password auth, but sshpass is not available on source for ${sourceItem.name}.`);
        }
        cmdOptions.sshPassCommand = `${this.escapeShellArg(sshpassPath)} -p ${this.escapeShellArg(targetCredentials.decryptedPassword)}`;
      } else if (targetConnection.auth_method === 'key' && !targetCredentials.decryptedPrivateKey) {
         throw new Error(`Target connection ${targetConnection.name} is key-based but no private key found.`);
      }
      if (signal.aborted) throw new DOMException('Transfer cancelled by user.', 'AbortError');
      
      const commandToExecute = this.buildTransferCommandString(
        sourceItem.path, sourceItem.type === 'directory', targetConnection, remoteTargetPathOnTarget,
        executableCommandPath, commandTypeForLogic, cmdOptions
      );
      this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 10, `Executing: ${commandTypeForLogic}`);
      
      await new Promise<void>((resolveCmd, rejectCmd) => {
        let streamClosed = false;
        const onAbortCmd = () => {
          if (!streamClosed) {
            console.warn(`[TransfersService] Abort signal received for command stream of sub-task ${subTaskId}. Attempting to close stream.`);
            // execStream?.close(); // 'execStream' is not defined here, should be 'stream' from exec callback
            // It's tricky to access the stream here to close it directly.
            // The main mechanism will be the timeout and the client connection eventually closing if task is aborted.
            // Or, if ssh2's stream object can be made available to this scope, call .close() or .destroy().
          }
          rejectCmd(new DOMException('Command cancelled by user.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbortCmd, { once: true });

        const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
        const timeoutHandle = setTimeout(() => {
          signal.removeEventListener('abort', onAbortCmd);
          if (!streamClosed) rejectCmd(new Error(`${commandTypeForLogic} command timed out for ${sourceItem.name}.`));
        }, COMMAND_TIMEOUT_MS);

        const execOptions: { pty?: boolean } = {};
        if (cmdOptions.sshPassCommand) execOptions.pty = true;

        sourceSshClient.exec(commandToExecute, execOptions, (err, stream) => {
          if (signal.aborted && !streamClosed) { // Check signal immediately after exec callback
             clearTimeout(timeoutHandle);
             signal.removeEventListener('abort', onAbortCmd);
             stream?.close(); // Attempt to close if stream exists
             return rejectCmd(new DOMException('Command cancelled by user (at exec).', 'AbortError'));
          }
          if (err) {
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
            return rejectCmd(new Error(`Failed to execute command: ${err.message}`));
          }

          stream.on('data', (data: Buffer) => {
            if (signal.aborted) return; // Stop processing data if aborted
            // ... (progress update logic)
            if (commandTypeForLogic === 'rsync') {
              const output = data.toString();
              const progressMatch = output.match(/(\d+)%/);
              if (progressMatch && progressMatch[1]) {
                this.updateSubTaskStatus(taskId, subTaskId, 'transferring', parseInt(progressMatch[1], 10));
              }
            } else {
                this.updateSubTaskStatus(taskId, subTaskId, 'transferring', 50, 'SCP in progress...');
            }
          });
          let stderrCombined = '';
          stream.stderr.on('data', (data: Buffer) => {
            if (signal.aborted) return;
            stderrCombined += data.toString();
            console.warn(`[Roo Debug][transfers.service.ts] STDERR Sub-task ${subTaskId}: ${data.toString()}`);
          });
          stream.on('close', (code: number | null) => {
            streamClosed = true;
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
            if (signal.aborted) { // Check if aborted during the command run
              return rejectCmd(new DOMException('Command cancelled by user (on close).', 'AbortError'));
            }
            if (code === 0) {
              this.updateSubTaskStatus(taskId, subTaskId, 'completed', 100, `${commandTypeForLogic} successful.`);
              resolveCmd();
            } else {
              rejectCmd(new Error(`${commandTypeForLogic} failed. Code: ${code}. Stderr: ${stderrCombined.trim()}`));
            }
          });
          stream.on('error', (streamErr: Error) => {
            streamClosed = true;
            clearTimeout(timeoutHandle);
            signal.removeEventListener('abort', onAbortCmd);
             if (signal.aborted && streamErr.message.includes('closed')) { // If aborted and stream closed, treat as AbortError
                return rejectCmd(new DOMException('Command stream error due to cancellation.', 'AbortError'));
             }
            rejectCmd(streamErr);
          });
        });
      });

    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.info(`[TransfersService] executeRemoteTransferOnSource for sub-task ${subTaskId} (item: ${sourceItem.name}) was aborted.`);
        // Status will be updated to 'cancelled' by the caller or here if not already
        const subTaskInstance = this.transferTasks.get(taskId)?.subTasks.find(st => st.subTaskId === subTaskId);
        if (subTaskInstance && subTaskInstance.status !== 'cancelled') {
            this.updateSubTaskStatus(taskId, subTaskId, 'cancelled', undefined, error.message);
        }
      } else {
        console.error(`[TransfersService] executeRemoteTransferOnSource error for sub-task ${subTaskId} (item: ${sourceItem.name}):`, error);
        this.updateSubTaskStatus(taskId, subTaskId, 'failed', undefined, error.message || `Remote transfer execution failed for ${sourceItem.name}.`);
      }
      throw error; // Re-throw to be caught by processSingleSubTaskWrapper
    } finally {
      console.info(`[Roo Debug][transfers.service.ts] executeRemoteTransferOnSource FINALLY for sub-task ${subTaskId}`);
      if (tempTargetKeyPathOnSource) {
        try {
          // TODO: Make deleteFileOnSourceViaSftp accept signal
          await this.deleteFileOnSourceViaSftp(sourceSshClient, tempTargetKeyPathOnSource);
        } catch (cleanupError) {
          console.warn(`[TransfersService] Failed to cleanup temp key ${tempTargetKeyPathOnSource} on source for sub-task ${subTaskId}:`, cleanupError);
        }
      }
    }
  }

  // --- Status Update and Retrieval Methods (largely unchanged) ---
  public async getTransferTaskDetails(taskId: string, userId: string | number): Promise<TransferTask | null> {
    const task = this.transferTasks.get(taskId);
    console.debug(`[TransfersService] Retrieving details for task: ${taskId} for user: ${userId}`);
    if (task && task.userId === userId) {
      // Spread the task, then explicitly add top-level fields from payload
      const taskToReturn = {
        ...task,
        subTasks: task.subTasks.map(st => ({ ...st })),
        sourceConnectionId: task.payload.sourceConnectionId,
        remoteTargetPath: task.payload.remoteTargetPath,
      };
      return taskToReturn;
    }
    if (task && task.userId !== userId) {
        console.warn(`[TransfersService] User ${userId} attempted to access task ${taskId} owned by ${task.userId}.`);
        return null;
    }
    return null;
  }

  public async getAllTransferTasks(userId: string | number): Promise<TransferTask[]> {
    console.debug(`[TransfersService] Retrieving all transfer tasks for user: ${userId}.`);
    return Array.from(this.transferTasks.values())
      .filter(task => task.userId === userId)
      .map(task => {
        // Spread the task, then explicitly add top-level fields from payload
        return {
          ...task,
          subTasks: task.subTasks.map(st => ({ ...st })),
          sourceConnectionId: task.payload.sourceConnectionId,
          remoteTargetPath: task.payload.remoteTargetPath,
        };
      });
  }

  public updateSubTaskStatus(
    taskId: string,
    subTaskId: string,
    newStatus: TransferSubTask['status'],
    progress?: number,
    message?: string
  ): void {
    const task = this.transferTasks.get(taskId);
    if (task) {
      const subTask = task.subTasks.find(st => st.subTaskId === subTaskId);
      if (subTask) {
        // Prevent overwriting a final state with a transient one unless it's a retry mechanism (not implemented here)
        if ((subTask.status === 'completed' || subTask.status === 'failed') && (newStatus !== 'completed' && newStatus !== 'failed')) {
            console.warn(`[TransfersService] Attempted to update final sub-task ${subTaskId} status '${subTask.status}' to '${newStatus}'. Ignoring.`);
            return;
        }

        subTask.status = newStatus;
        if (progress !== undefined) subTask.progress = Math.min(100, Math.max(0, progress)); // Clamp progress
        if (message !== undefined) subTask.message = message;
        if ((newStatus === 'completed' || newStatus === 'failed') && !subTask.endTime) {
            subTask.endTime = new Date();
        }
        task.updatedAt = new Date();
        this.updateOverallTaskStatusBasedOnSubTasks(taskId); // Important: update overall task
        console.info(`[TransfersService] Sub-task ${subTaskId} (task ${taskId}) updated: ${newStatus}, progress: ${subTask.progress}%, msg: "${subTask.message}"`);
      } else {
        console.warn(`[TransfersService] Sub-task ${subTaskId} not found for task ${taskId} during status update.`);
      }
    } else {
      console.warn(`[TransfersService] Task ${taskId} not found during sub-task status update.`);
    }
  }

  private updateOverallTaskStatus(taskId: string, newStatus: TransferTask['status'], message?: string): void {
    const task = this.transferTasks.get(taskId);
    if (task) {
        const isCurrentStatusFinal = task.status === 'completed' || task.status === 'failed' || task.status === 'partially-completed';
        // Check if newStatus is one of the transient states
        const isNewStatusTransient = newStatus === 'queued' || newStatus === 'in-progress';

        if (isCurrentStatusFinal && isNewStatusTransient) {
            // If current status is final and new status is transient, ignore the update.
            console.warn(`[TransfersService] Attempted to update final task ${taskId} status '${task.status}' to transient '${newStatus}'. Ignoring.`);
            return;
        }

        // Proceed with the update if:
        // 1. Current status is not final.
        // 2. Current status is final, and newStatus is also a final state (e.g., 'partially-completed' to 'failed').
        task.status = newStatus;
        task.updatedAt = new Date();
        // Overall task message could be an aggregation or just the first major error.
        // For simplicity, not adding detailed message aggregation here.
        console.info(`[TransfersService] Overall status for task ${taskId} directly updated to: ${newStatus}` + (message ? ` (Msg: ${message})` : ''));
    }
  }

  private updateOverallTaskStatusBasedOnSubTasks(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;

    let completedCount = 0;
    let failedCount = 0;
    let inProgressCount = 0;
    let queuedCount = 0;
    let totalProgress = 0;
    const numSubTasks = task.subTasks.length;

    if (numSubTasks === 0) {
      task.overallProgress = 0;
      // task.status remains as set by initiate or direct updateOverallTaskStatus if no subtasks.
      return;
    }

    task.subTasks.forEach(st => {
      switch (st.status) {
        case 'completed':
          completedCount++;
          totalProgress += 100;
          break;
        case 'failed':
          failedCount++;
          // Failed tasks are "done" but contribute 0 to success progress.
          // Depending on definition, they could count as 100 for task "completion" progress.
          // Here, only successful completion adds to progress towards 100%.
          break;
        case 'transferring':
        case 'connecting': // consider connecting as in-progress for overall status
          inProgressCount++;
          totalProgress += (st.progress !== undefined ? st.progress : (st.status === 'connecting' ? 5 : 0)); // Small progress for connecting
          break;
        case 'queued':
          queuedCount++;
          break;
      }
    });

    task.overallProgress = numSubTasks > 0 ? Math.round(totalProgress / numSubTasks) : 0;

    let newOverallStatus: TransferTask['status'];
    if (failedCount === numSubTasks) {
      newOverallStatus = 'failed';
    } else if (completedCount === numSubTasks) {
      newOverallStatus = 'completed';
    } else if (failedCount > 0 && (completedCount + failedCount === numSubTasks)) {
      newOverallStatus = 'partially-completed';
    } else if (inProgressCount > 0 || (queuedCount > 0 && (failedCount > 0 || completedCount > 0))) {
      // If anything is in progress, or if some are queued while others are done/failed, it's in-progress
      newOverallStatus = 'in-progress';
    } else if (queuedCount === numSubTasks) {
      newOverallStatus = 'queued'; // All subtasks are still queued
    } else {
      // Fallback or unexpected mixed state, treat as in-progress generally
      // This case implies some completed, some queued, no failed, no in-progress items.
      newOverallStatus = 'in-progress'; // Or 'partially-completed' if completedCount > 0
      if (completedCount > 0 && queuedCount > 0 && failedCount === 0 && inProgressCount === 0) {
        newOverallStatus = 'partially-completed'; // More accurate for this specific mix
      }
    }
    
    if (task.status !== newOverallStatus) {
        console.info(`[TransfersService] Task ${taskId} overall status changing from ${task.status} to ${newOverallStatus} (P: ${task.overallProgress}%)`);
        task.status = newOverallStatus;
    }
    task.updatedAt = new Date();
    // console.debug(`[TransfersService] Task ${taskId} overall progress: ${task.overallProgress}%, status: ${task.status}`);
  }

  private finalizeOverallTaskStatus(taskId: string): void {
    const task = this.transferTasks.get(taskId);
    if (!task) return;
    this.updateOverallTaskStatusBasedOnSubTasks(taskId); // Recalculate based on final sub-task states
    console.info(`[TransfersService] Finalized overall status for task ${taskId}: ${task.status}, progress: ${task.overallProgress}%`);
  }
}