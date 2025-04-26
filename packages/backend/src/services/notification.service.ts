import axios, { AxiosRequestConfig } from 'axios';
import { NotificationSettingsRepository } from '../repositories/notification.repository';
import {
    NotificationSetting,
    NotificationEvent,
    NotificationPayload,
    WebhookConfig,
    EmailConfig,
    TelegramConfig,
    NotificationChannelConfig,
    NotificationChannelType
} from '../types/notification.types';
import * as nodemailer from 'nodemailer';
import Mail from 'nodemailer/lib/mailer';
import i18next, { defaultLng, supportedLngs } from '../i18n';
import { settingsService } from './settings.service';


const testSubjectKey = 'testNotification.subject';
const testEmailBodyKey = 'testNotification.email.body';
const testEmailBodyHtmlKey = 'testNotification.email.bodyHtml';
const testWebhookDetailsKey = 'testNotification.webhook.detailsMessage';
const testTelegramDetailsKey = 'testNotification.telegram.detailsMessage';
const testTelegramBodyTemplateKey = 'testNotification.telegram.bodyTemplate';

export class NotificationService {
    private repository: NotificationSettingsRepository;

    constructor() {
        this.repository = new NotificationSettingsRepository();
    }

    async getAllSettings(): Promise<NotificationSetting[]> {
        return this.repository.getAll();
    }

    async getSettingById(id: number): Promise<NotificationSetting | null> {
        return this.repository.getById(id);
    }

     async createSetting(settingData: Omit<NotificationSetting, 'id' | 'created_at' | 'updated_at'>): Promise<number> {
        return this.repository.create(settingData);
    }

    async updateSetting(id: number, settingData: Partial<Omit<NotificationSetting, 'id' | 'created_at' | 'updated_at'>>): Promise<boolean> {
        return this.repository.update(id, settingData);
    }

    async deleteSetting(id: number): Promise<boolean> {
        return this.repository.delete(id);
    }


    async testSetting(channelType: NotificationChannelType, config: NotificationChannelConfig): Promise<{ success: boolean; message: string }> {
        switch (channelType) {
            case 'email':
                return this._testEmailSetting(config as EmailConfig);
            case 'webhook':
                return this._testWebhookSetting(config as WebhookConfig);
            case 'telegram':
                return this._testTelegramSetting(config as TelegramConfig);
            default:
                console.warn(`[通知测试] 不支持的测试渠道类型: ${channelType}`);
                return { success: false, message: `不支持测试此渠道类型 (${channelType})` };
        }
    }

    private async _testEmailSetting(config: EmailConfig): Promise<{ success: boolean; message: string }> {
        console.log('[通知测试 - 邮件] 开始测试...');
        if (!config.to || !config.smtpHost || !config.smtpPort || !config.from) {
             console.error('[通知测试 - 邮件] 缺少必要的配置。');
            return { success: false, message: '测试邮件失败：缺少必要的 SMTP 配置信息 (收件人, 主机, 端口, 发件人)。' };
        }

        let userLang = defaultLng;
        try {
            const langSetting = await settingsService.getSetting('language');
            if (langSetting && supportedLngs.includes(langSetting)) {
                userLang = langSetting;
            }
             console.log(`[通知测试 - 邮件] 使用语言: ${userLang}`);
        } catch (error) {
            console.error(`[通知测试 - 邮件] 获取语言设置时出错，使用默认 (${defaultLng}):`, error);
        }

        const transporterOptions = {
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpSecure ?? true,
            auth: (config.smtpUser || config.smtpPass) ? {
                user: config.smtpUser,
                pass: config.smtpPass,
            } : undefined,
        };

        const transporter = nodemailer.createTransport(transporterOptions);

        const eventDisplayName = i18next.t(`event.SETTINGS_UPDATED`, { lng: userLang, defaultValue: 'SETTINGS_UPDATED' });

        const mailOptions: Mail.Options = {
            from: config.from,
            to: config.to,
            subject: i18next.t(testSubjectKey, { lng: userLang, defaultValue: 'Nexus Terminal Test Notification ({event})', eventDisplay: eventDisplayName }),
            text: i18next.t(testEmailBodyKey, { lng: userLang, timestamp: new Date().toISOString(), defaultValue: `This is a test email from Nexus Terminal for event '{{event}}'.\n\nIf you received this, your SMTP configuration is working.\n\nTimestamp: {{timestamp}}`, eventDisplay: eventDisplayName }),
            html: i18next.t(testEmailBodyHtmlKey, { lng: userLang, timestamp: new Date().toISOString(), defaultValue: `<p>This is a test email from <b>Nexus Terminal</b> for event '{{event}}'.</p><p>If you received this, your SMTP configuration is working.</p><p>Timestamp: {{timestamp}}</p>`, eventDisplay: eventDisplayName }),
        };

        try {
            console.log(`[通知测试 - 邮件] 尝试通过 ${config.smtpHost}:${config.smtpPort} 发送测试邮件至 ${config.to}`);
            const info = await transporter.sendMail(mailOptions);
            console.log(`[通知测试 - 邮件] 测试邮件发送成功: ${info.messageId}`);
            return { success: true, message: '测试邮件发送成功！请检查收件箱。' };
        } catch (error: any) {
            console.error(`[通知测试 - 邮件] 发送测试邮件时出错:`, error);
            return { success: false, message: `测试邮件发送失败: ${error.message || '未知错误'}` };
        }
    }

    private async _testWebhookSetting(config: WebhookConfig): Promise<{ success: boolean; message: string }> {
        console.log('[通知测试 - Webhook] 开始测试...');
        if (!config.url) {
             console.error('[通知测试 - Webhook] 缺少 URL。');
            return { success: false, message: '测试 Webhook 失败：缺少 URL。' };
        }

        let userLang = defaultLng;
        try {
            const langSetting = await settingsService.getSetting('language');
            if (langSetting && supportedLngs.includes(langSetting)) {
                userLang = langSetting;
            }
             console.log(`[通知测试 - Webhook] 使用语言: ${userLang}`);
        } catch (error) {
            console.error(`[通知测试 - Webhook] 获取语言设置时出错，使用默认 (${defaultLng}):`, error);
        }

        const testPayload: NotificationPayload = {
            event: 'SETTINGS_UPDATED',
            timestamp: Date.now(),
            details: { message: i18next.t(testWebhookDetailsKey, { lng: userLang, defaultValue: 'This is a test notification from Nexus Terminal (Webhook).' }) }
        };
        const translatedWebhookMessage = (typeof testPayload.details === 'object' && testPayload.details?.message) ? testPayload.details.message : 'Details 不是带有 message 属性的对象';
        console.log(`[通知测试 - Webhook] 测试负载已创建。翻译后的 details.message:`, translatedWebhookMessage);

        const eventDisplayName = i18next.t(`event.${testPayload.event}`, { lng: userLang, defaultValue: testPayload.event });
        const defaultBody = JSON.stringify(testPayload, null, 2);
        const defaultBodyTemplate = `Default: JSON payload. Use {event}, {timestamp}, {details}.`;
        // Prepare data object for _renderTemplate
        const templateDataWebhookTest: Record<string, string> = {
            event: testPayload.event,
            eventDisplay: eventDisplayName, // Assuming no markdown needed for webhook test
            timestamp: new Date(testPayload.timestamp).toISOString(),
            // Use the message from details if available
            details: (typeof testPayload.details === 'object' && testPayload.details?.message)
                     ? testPayload.details.message
                     : (typeof testPayload.details === 'string'
                        ? testPayload.details
                        : JSON.stringify(testPayload.details || {}, null, 2))
        };
        const requestBody = this._renderTemplate(config.bodyTemplate || defaultBodyTemplate, templateDataWebhookTest, defaultBody); // Use new signature (3 args)

        const requestConfig: AxiosRequestConfig = {
            method: config.method || 'POST',
            url: config.url,
            headers: {
                'Content-Type': 'application/json',
                ...(config.headers || {}),
            },
            data: requestBody,
            timeout: 15000,
        };

        try {
            console.log(`[通知测试 - Webhook] 发送测试 Webhook 到 ${config.url}`);
            const response = await axios(requestConfig);
            console.log(`[通知测试 - Webhook] 测试 Webhook 成功发送到 ${config.url}。状态: ${response.status}`);
            return { success: true, message: `测试 Webhook 发送成功 (状态码: ${response.status})。` };
        } catch (error: any) {
            const errorMessage = error.response?.data?.message || error.response?.data || error.message || '未知错误';
            console.error(`[通知测试 - Webhook] 发送测试 Webhook 到 ${config.url} 时出错:`, errorMessage);
            return { success: false, message: `测试 Webhook 发送失败: ${errorMessage}` };
        }
    }

    private async _testTelegramSetting(config: TelegramConfig): Promise<{ success: boolean; message: string }> {
        console.log('[通知测试 - Telegram] 开始测试...');
        if (!config.botToken || !config.chatId) {
            console.error('[通知测试 - Telegram] 缺少 botToken 或 chatId。');
            return { success: false, message: '测试 Telegram 失败：缺少机器人 Token 或聊天 ID。' };
        }

        let userLang = defaultLng;
        try {
            const langSetting = await settingsService.getSetting('language');
            if (langSetting && supportedLngs.includes(langSetting)) {
                userLang = langSetting;
            }
             console.log(`[通知测试 - Telegram] 使用语言: ${userLang}`);
        } catch (error) {
            console.error(`[通知测试 - Telegram] 获取语言设置时出错，使用默认 (${defaultLng}):`, error);
        }

        const testPayload: NotificationPayload = {
            event: 'SETTINGS_UPDATED',
            timestamp: Date.now(),
            details: undefined
        };

        const detailsOptions = { lng: userLang, defaultValue: 'Fallback: This is a test notification from Nexus Terminal (Telegram).' };
        const keyWithNamespace = `notifications:${testTelegramDetailsKey}`;
        const translatedDetailsMessage = i18next.t(keyWithNamespace, detailsOptions);

        testPayload.details = { message: translatedDetailsMessage };


        const messageFromPayload = (typeof testPayload.details === 'object' && testPayload.details?.message) ? testPayload.details.message : 'Details is not an object with message property';
        console.log(`[Notification Test - Telegram] Test payload created. Final details.message in payload:`, messageFromPayload);

        const templateKeyWithNamespace = `notifications:${testTelegramBodyTemplateKey}`;
        const defaultMessageTemplateFromI18n = i18next.t(templateKeyWithNamespace, {
            lng: userLang,
            defaultValue: `Fallback Template: *Nexus Terminal Test Notification*\nEvent: \`{event}\`\nTimestamp: {timestamp}\nDetails:\n\`\`\`\n{details}\n\`\`\``
        });
        console.log(`[通知测试 - Telegram] 来自 i18n 的默认模板 (使用语言 '${userLang}', 键 '${templateKeyWithNamespace}'):`, defaultMessageTemplateFromI18n);

        const templateToUse = config.messageTemplate || defaultMessageTemplateFromI18n;
        console.log(`[通知测试 - Telegram] 要渲染的模板:`, templateToUse);

        const eventDisplayName = i18next.t(`event.${testPayload.event}`, { lng: userLang, defaultValue: testPayload.event });
        // Prepare data object for _renderTemplate
        const templateDataTelegramTest: Record<string, string> = {
            // Use 'event' key with escaped raw event name
            event: this._escapeBasicMarkdown(testPayload.event),
            eventDisplay: this._escapeBasicMarkdown(eventDisplayName), // Keep escaped display name too
            timestamp: new Date(testPayload.timestamp).toISOString(),
            // Use 'details' key with escaped formatted details message
            details: this._escapeBasicMarkdown(messageFromPayload)
        };
        // Render using the chosen template and prepared data
        const messageText = this._renderTemplate(templateToUse, templateDataTelegramTest, defaultMessageTemplateFromI18n); // Use new signature (3 args)
        console.log(`[通知测试 - Telegram] 渲染的消息文本:`, messageText); // Keep original log message

        const telegramApiUrl = `https://api.telegram.org/bot${config.botToken}/sendMessage`;

        try {
             console.log(`[通知测试 - Telegram] 发送测试 Telegram 消息到聊天 ID ${config.chatId}`);
            const response = await axios.post(telegramApiUrl, {
                chat_id: config.chatId,
                text: messageText,
                parse_mode: 'Markdown'
            }, { timeout: 15000 });

            if (response.data?.ok) {
                 console.log(`[通知测试 - Telegram] 测试 Telegram 消息发送成功。`);
                     return { success: true, message: '测试 Telegram 消息发送成功！' };
                } else {
                     console.error(`[通知测试 - Telegram] Telegram API 返回错误:`, response.data?.description);
                     return { success: false, message: `测试 Telegram 发送失败: ${response.data?.description || 'API 返回失败'}` };
                }
            } catch (error: any) {
                 const errorMessage = error.response?.data?.description || error.response?.data || error.message || '未知错误';
                console.error(`[通知测试 - Telegram] 发送测试 Telegram 消息时出错:`, errorMessage);
            return { success: false, message: `测试 Telegram 发送失败: ${errorMessage}` };
        }
    }


    async sendNotification(event: NotificationEvent, details?: Record<string, any> | string): Promise<void> {
        console.log(`[通知] 事件触发: ${event}`, details || '');

        let userLang = defaultLng;
        try {
            const langSetting = await settingsService.getSetting('language');
            if (langSetting && supportedLngs.includes(langSetting)) {
                userLang = langSetting;
            }
        } catch (error) {
            console.error(`[通知] 获取事件 ${event} 的语言设置时出错:`, error);
        }
        console.log(`[通知] 事件 ${event} 使用语言 '${userLang}'`);

        const payload: NotificationPayload = {
            event,
            timestamp: Date.now(),
            details: details || undefined,
        };

        try {
            const applicableSettings = await this.repository.getEnabledByEvent(event);
            console.log(`[通知] 找到 ${applicableSettings.length} 个适用于事件 ${event} 的设置`);

            if (applicableSettings.length === 0) {
                return; // 此事件没有启用的设置
            }

            const sendPromises = applicableSettings.map(setting => {
                switch (setting.channel_type) {
                    case 'webhook':
                        return this._sendWebhook(setting, payload, userLang);
                    case 'email':
                        return this._sendEmail(setting, payload, userLang);
                    case 'telegram':
                        return this._sendTelegram(setting, payload, userLang);
                    default:
                        console.warn(`[通知] 未知渠道类型: ${setting.channel_type} (设置 ID: ${setting.id})`);
                        return Promise.resolve(); // 如果有一个未知，不要让所有都失败
                }
            });

            await Promise.allSettled(sendPromises);
            console.log(`[通知] 完成尝试发送事件 ${event} 的通知`);

        } catch (error) {
            console.error(`[通知] 获取或处理事件 ${event} 的设置时出错:`, error);
        }
    }


    // Helper function to escape basic Markdown characters (`*`, `_`, `` ` ``, `[`)
    private _escapeBasicMarkdown(text: string): string {
        if (typeof text !== 'string') return '';
        // Escape *, _, `, [
        // Note: Telegram's Markdown parser might have quirks.
        // If issues persist, consider escaping more characters or using MarkdownV2 with its stricter rules.
        return text.replace(/([*_`\[])/g, '\\$1');
    }

    private _renderTemplate(template: string | undefined, data: Record<string, string>, defaultText: string): string {
        if (!template) return defaultText;
        let rendered = template;
        for (const key in data) {
            // Replace placeholders like {key} with data[key]
            // Assumes data values are already properly escaped if needed
            rendered = rendered.replace(new RegExp(`\\{${key}\\}`, 'g'), data[key]);
        }
        return rendered;
    }

    private async _sendWebhook(setting: NotificationSetting, payload: NotificationPayload, userLang: string): Promise<void> {
        const config = setting.config as WebhookConfig;
        if (!config.url) {
            console.error(`[通知] Webhook 设置 ID ${setting.id} 缺少 URL。`);
            return;
        }

        const eventDisplayName = i18next.t(`event.${payload.event}`, { lng: userLang, defaultValue: payload.event });

        const translatedDetails = this._translatePayloadDetails(payload.details, userLang);
        const translatedPayload = { ...payload, details: translatedDetails };

        const defaultBody = JSON.stringify(translatedPayload, null, 2);
        const defaultBodyTemplate = `Default: JSON payload. Use {event}, {timestamp}, {details}.`;
        // Prepare data object for _renderTemplate
        const templateDataWebhook: Record<string, string> = {
            event: translatedPayload.event,
            eventDisplay: eventDisplayName, // Assuming no markdown needed for webhook
            timestamp: new Date(translatedPayload.timestamp).toISOString(),
            // Use the translated message if available, otherwise stringify
            details: (typeof translatedPayload.details === 'object' && translatedPayload.details?.message)
                     ? translatedPayload.details.message
                     : (typeof translatedPayload.details === 'string'
                        ? translatedPayload.details
                        : JSON.stringify(translatedPayload.details || {}, null, 2))
        };
        const requestBody = this._renderTemplate(config.bodyTemplate || defaultBodyTemplate, templateDataWebhook, defaultBody); // Use new signature (3 args)

        const requestConfig: AxiosRequestConfig = {
            method: config.method || 'POST',
            url: config.url,
            headers: {
                'Content-Type': 'application/json',
                ...(config.headers || {}),
            },
            data: requestBody,
            timeout: 10000,
        };

        try {
            console.log(`[通知] 发送 Webhook 到 ${config.url} (事件: ${payload.event})`);
            const response = await axios(requestConfig);
            console.log(`[通知] Webhook 成功发送到 ${config.url}。状态: ${response.status}`);
        } catch (error: any) {
            const errorMessage = error.response?.data?.message || error.response?.data || error.message;
            console.error(`[通知] 发送 Webhook 到 ${config.url} (设置 ID: ${setting.id}) 时出错:`, errorMessage);
        }
    }

    private async _sendEmail(setting: NotificationSetting, payload: NotificationPayload, userLang: string): Promise<void> {
        const config = setting.config as EmailConfig;
        if (!config.to || !config.smtpHost || !config.smtpPort || !config.from) {
             console.error(`[通知] 邮件设置 ID ${setting.id} 缺少必要的 SMTP 配置 (to, smtpHost, smtpPort, from)。`);
            return;
        }

        const transporterOptions = {
            host: config.smtpHost,
            port: config.smtpPort,
            secure: config.smtpSecure ?? true,
            auth: (config.smtpUser || config.smtpPass) ? {
                user: config.smtpUser,
                pass: config.smtpPass,
            } : undefined,
        };

        const transporter = nodemailer.createTransport(transporterOptions);

        const i18nOptions: Record<string, any> = { lng: userLang };
        if (payload.details && typeof payload.details === 'object') {
          Object.assign(i18nOptions, payload.details);
        } else if (payload.details !== undefined) {
          i18nOptions.details = payload.details;
        }

        const eventDisplayName = i18next.t(`event.${payload.event}`, { lng: userLang, defaultValue: payload.event });

        const defaultSubjectKey = `event.${payload.event}`;
        const defaultSubjectFallback = `Nexus Terminal Notification: {event}`;
        const subjectText = i18next.t(defaultSubjectKey, { ...i18nOptions, defaultValue: defaultSubjectFallback, eventDisplay: eventDisplayName });

        const defaultSubjectTemplateKey = 'testNotification.subject';
        const defaultSubjectTemplate = i18next.t(defaultSubjectTemplateKey, { lng: userLang, defaultValue: defaultSubjectFallback, eventDisplay: eventDisplayName });
        // Prepare data object for _renderTemplate (for subject)
        const templateDataEmailSubject: Record<string, string> = {
             event: payload.event,
             eventDisplay: eventDisplayName, // Assuming subject doesn't need markdown
             timestamp: new Date(payload.timestamp).toISOString(),
             details: typeof payload.details === 'string' ? payload.details : JSON.stringify(payload.details || {}, null, 2),
             // Add other relevant fields from i18nOptions if needed by subject template
             ...Object.entries(i18nOptions).reduce((acc, [key, value]) => {
                 if (key !== 'lng') { // Exclude 'lng' itself
                     acc[key] = String(value);
                 }
                 return acc;
             }, {} as Record<string, string>)
        };
        const subject = this._renderTemplate(config.subjectTemplate || defaultSubjectTemplate, templateDataEmailSubject, subjectText); // Use new signature (3 args)


        const bodyKey = `eventBody.${payload.event}`;
        const detailsString = typeof payload.details === 'string' ? payload.details : JSON.stringify(payload.details || {}, null, 2);
        const defaultBodyText = `Event: ${eventDisplayName}\nTimestamp: ${new Date(payload.timestamp).toISOString()}\nDetails:\n${detailsString}`;
        const body = i18next.t(bodyKey, { ...i18nOptions, defaultValue: defaultBodyText, eventDisplay: eventDisplayName });

        const mailOptions: Mail.Options = {
            from: config.from,
            to: config.to,
            subject: subject,
            text: body,
        };

        try {
            console.log(`[通知] 通过 ${config.smtpHost}:${config.smtpPort} 发送邮件至 ${config.to} (事件: ${payload.event})`);
            const info = await transporter.sendMail(mailOptions);
            console.log(`[通知] 邮件成功发送至 ${config.to} (设置 ID: ${setting.id})。消息 ID: ${info.messageId}`);
        } catch (error: any) {
            console.error(`[通知] 通过 ${config.smtpHost} 发送邮件 (设置 ID: ${setting.id}) 时出错:`, error);
        }
    }

    private async _sendTelegram(setting: NotificationSetting, payload: NotificationPayload, userLang: string): Promise<void> {
        console.log(`[_sendTelegram] Initiating for event: ${payload.event}, Setting ID: ${setting.id}, Lang: ${userLang}`);
        console.log(`[_sendTelegram] Received payload:`, JSON.stringify(payload, null, 2));
        const config = setting.config as TelegramConfig;
        if (!config.botToken || !config.chatId) {
            console.error(`[通知] Telegram 设置 ID ${setting.id} 缺少 botToken 或 chatId。`);
            return;
        }

        let detailsText = '';
        if (payload.details) {
            if (payload.event === 'SETTINGS_UPDATED' && typeof payload.details === 'object' && Array.isArray(payload.details.updatedKeys)) {
                detailsText = payload.details.updatedKeys.join(', ');

            } else if (typeof payload.details === 'string') {
                detailsText = payload.details;
            } else {
                // Generic fallback for unhandled object details
                detailsText = JSON.stringify(payload.details);
            }
        }
        console.log(`[_sendTelegram] Formatted detailsText:`, detailsText);

        // 3. Prepare data for template placeholders AND i18n interpolation (NO escaping here)
        // Get the translated event name using the correct key 'event.<EVENT_NAME>'
        const translatedEventName = i18next.t(`event.${payload.event}`, { lng: userLang, defaultValue: payload.event });

        const templateData: Record<string, string> = {
            // Assign the *translated* event name to the 'event' key (NO escaping)
            event: translatedEventName,
            // ISO timestamp (usually safe)
            timestamp: new Date(payload.timestamp).toISOString(),
            // Formatted details string (NO escaping)
            details: detailsText
            // Note: We no longer create eventDisplay key
        };
        console.log(`[_sendTelegram] Prepared templateData (NO escaping):`, JSON.stringify(templateData, null, 2));

        // 4. Handle template
        let messageText = '';
        if (config.messageTemplate) {
            // User has a custom template, render it using prepared data
            console.log(`[_sendTelegram] Using custom template:`, config.messageTemplate);
            // Provide a fallback text in case rendering fails
            const fallbackForCustom = `Event: ${templateData.event}, Details: ${templateData.details}`; // Use 'event' key now
            messageText = this._renderTemplate(config.messageTemplate, templateData, fallbackForCustom);
        } else {
            // No custom template, use i18n to generate the full body
            const i18nKey = `eventBody.${payload.event}`;
            console.log(`[_sendTelegram] Using i18n template key:`, i18nKey);
            // Define a fallback structure using the prepared data (NO escaping)
            const fallbackBody = `*Fallback Notification*\nEvent: ${templateData.event}\nTime: \`${templateData.timestamp}\`\nDetails: ${templateData.details}`; // Use 'event' key now
            // Pass the prepared data for interpolation within the i18n translation
            messageText = i18next.t(i18nKey, {
                lng: userLang,
                ...templateData, // Pass all prepared data for interpolation (event, timestamp, details)
                // If specific i18n keys need raw data (like the keys array), add them here:
                // updatedKeys: (payload.event === 'SETTINGS_UPDATED' && Array.isArray(payload.details?.updatedKeys)) ? payload.details.updatedKeys.join(', ') : '',
                defaultValue: fallbackBody
            });
        }
        console.log(`[_sendTelegram] Final message text to send:`, messageText);

        // 6. Send to Telegram (Moved step number)
        const telegramApiUrl = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
        try {
            console.log(`[通知] 发送 Telegram 消息到聊天 ID ${config.chatId} (事件: ${payload.event})`);
            const requestBody = {
                chat_id: config.chatId,
                text: messageText,
                parse_mode: 'Markdown', // Use standard Markdown
            };
            console.log(`[_sendTelegram] Sending request to Telegram API:`, JSON.stringify(requestBody, null, 2));
            const response = await axios.post(telegramApiUrl, requestBody, { timeout: 10000 });
            console.log(`[通知] Telegram 消息发送成功。响应 OK:`, response.data?.ok);
        } catch (error: any) {
            const errorMessage = error.response?.data?.description || error.response?.data || error.message;
            console.error(`[通知] 发送 Telegram 消息 (设置 ID: ${setting.id}) 时出错:`, errorMessage);
        }
    }

    private _translatePayloadDetails(details: any, lng: string): any {
        if (!details || typeof details !== 'object') {
            return details;
        }

        if (details.testResult === 'success' && details.connectionName) {
            return {
                ...details,
                message: i18next.t('connection.testSuccess', { lng, name: details.connectionName, defaultValue: `Connection test successful for '${details.connectionName}'!` })
            };
        }
        if (details.testResult === 'failed' && details.connectionName && details.error) {
             return {
                ...details,
                message: i18next.t('connection.testFailed', { lng, name: details.connectionName, error: details.error, defaultValue: `Connection test failed for '${details.connectionName}': ${details.error}` })
            };
        }

        if (details.updatedKeys && Array.isArray(details.updatedKeys)) {
             if (details.updatedKeys.includes('ipWhitelist')) {
                 return { ...details, message: i18next.t('settings.ipWhitelistUpdated', { lng, defaultValue: 'IP Whitelist updated successfully.' }) };
             }
             return { ...details, message: i18next.t('settings.updated', { lng, defaultValue: 'Settings updated successfully.' }) };
        }


        return details;
    }
}
