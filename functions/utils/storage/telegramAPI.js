/**
 * Telegram API 封装类
 */
export const TELEGRAM_DELETE_CAPABILITY = 'telegram-message-v1';

export class TelegramAPI {
    constructor(botToken, proxyUrl = '') {
        this.botToken = botToken;
        this.proxyUrl = proxyUrl;
        // 如果设置了代理域名，使用代理域名，否则使用官方 API
        const apiDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.baseURL = `${apiDomain}/bot${this.botToken}`;
        this.fileDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.defaultHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
        };
    }

    /**
     * 发送文件到Telegram
     * @param {File} file - 要发送的文件
     * @param {string} chatId - 聊天ID
     * @param {string} functionName - API方法名（如：sendPhoto, sendDocument等）
     * @param {string} functionType - 文件类型参数名（如：photo, document等）
     * @returns {Promise<Object>} API响应结果
     */
    async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '') {
        const formData = new FormData();

        formData.append('chat_id', chatId);
        if (fileName) {
            formData.append(functionType, file, fileName);
        } else {
            formData.append(functionType, file);
        }
        if (caption) {
            formData.append('caption', caption);
        }

        const response = await fetch(`${this.baseURL}/${functionName}`, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: formData
        });
        console.log('Telegram API response:', response.status, response.statusText);
        if (!response.ok) {
            throw new Error(`Telegram API error: ${response.statusText}`);
        }

        // 解析响应数据
        const responseData = await response.json();

        return responseData;
    }

    /**
     * 获取文件信息
     * @param {Object} responseData - Telegram API响应数据
     * @returns {Object|null} 文件信息对象或null
     */
    getFileInfo(responseData) {
        const getFileDetails = (file) => ({
            file_id: file.file_id,
            file_name: file.file_name || file.file_unique_id,
            file_size: file.file_size,
            message_id: responseData.result.message_id,
        });

        try {
            if (!responseData.ok) {
                console.error('Telegram API error:', responseData.description);
                return null;
            }

            if (responseData.result.photo) {
                const largestPhoto = responseData.result.photo.reduce((prev, current) =>
                    (prev.file_size > current.file_size) ? prev : current
                );
                return getFileDetails(largestPhoto);
            }

            if (responseData.result.video) {
                return getFileDetails(responseData.result.video);
            }

            if (responseData.result.audio) {
                return getFileDetails(responseData.result.audio);
            }

            if (responseData.result.document) {
                return getFileDetails(responseData.result.document);
            }

            return null;
        } catch (error) {
            console.error('Error parsing Telegram response:', error.message);
            return null;
        }
    }

    /**
     * 获取文件路径
     * @param {string} fileId - 文件ID
     * @returns {Promise<string|null>} 文件路径或null
     */
    async getFilePath(fileId) {
        try {
            const url = `${this.baseURL}/getFile?file_id=${fileId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: this.defaultHeaders,
            });

            const responseData = await response.json();
            if (responseData.ok) {
                return responseData.result.file_path;
            } else {
                return null;
            }
        } catch (error) {
            console.error('Error getting file path:', error.message);
            return null;
        }
    }

    /**
     * 获取文件内容
     * @param {string} fileId - 文件ID
     * @returns {Promise<Response>} 文件响应
     */
    async getFileContent(fileId) {
        const filePath = await this.getFilePath(fileId);
        if (!filePath) {
            throw new Error(`File path not found for fileId: ${fileId}`);
        }

        const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
        const response = await fetch(fullURL, {
            headers: this.defaultHeaders
        });

        return response;
    }

    /**
     * Delete the Telegram message that owns an uploaded file.
     *
     * Telegram does not expose file deletion by file_id. The message_id returned
     * by sendPhoto/sendDocument/etc. must therefore be retained at upload time.
     * A missing message is treated as idempotently deleted; permission, channel,
     * rate-limit and transport failures remain hard failures.
     */
    async deleteMessage(chatId, messageId) {
        try {
            const response = await fetch(`${this.baseURL}/deleteMessage`, {
                method: 'POST',
                headers: {
                    ...this.defaultHeaders,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                }),
            });

            let responseData = null;
            try {
                responseData = await response.json();
            } catch {
                responseData = null;
            }

            if (response.ok && responseData?.ok === true && responseData?.result === true) {
                return { deleted: true, missing: false, nonDeletable: false };
            }

            const description = String(responseData?.description || '').toLowerCase();
            if (response.status === 400 && /message(?: to delete)? not found/.test(description)) {
                return { deleted: true, missing: true, nonDeletable: false };
            }

            const nonDeletable = response.status === 400
                && /message (?:can'?t|cannot|can not) be deleted/.test(description);

            console.error('Telegram deleteMessage failed:', response.status, {
                nonDeletable,
            });
            return { deleted: false, missing: false, nonDeletable };
        } catch (error) {
            console.error('Telegram deleteMessage request failed:', error.message);
            return { deleted: false, missing: false, nonDeletable: false };
        }
    }

}

export function applyTelegramUploadIdentity(metadata, fileInfo, chatId) {
    metadata.TgFileId = fileInfo.file_id;
    metadata.TgMessageId = fileInfo.message_id;
    metadata.TgChatId = String(chatId);
    metadata.DeleteCapability = TELEGRAM_DELETE_CAPABILITY;
    return metadata;
}
