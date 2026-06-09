"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Upload = void 0;
const fs = __importStar(require("fs"));
const node_crypto_1 = require("node:crypto");
const node_path_1 = __importDefault(require("node:path"));
const api_1 = require("../network/api");
const DEFAULT_UPLOAD_TIMEOUT = 20000; // ms
/**
 * Загрузить чанк данных через Content-Range запрос
 */
async function uploadRangeChunk({ uploadUrl, chunk, startByte, endByte, fileSize, fileName, }, { signal } = {}) {
    const uploadRes = await fetch(uploadUrl, {
        method: 'POST',
        body: chunk,
        headers: {
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Range': `bytes ${startByte}-${endByte}/${fileSize}`,
            'Content-Type': 'application/x-binary; charset=x-user-defined',
            'X-File-Name': fileName,
            'X-Uploading-Mode': 'parallel',
            Connection: 'keep-alive',
        },
        signal,
    });
    if (uploadRes.status >= 400) {
        const error = await uploadRes.json();
        throw new api_1.MaxError(uploadRes.status, error);
    }
    return uploadRes.text();
}
/**
 * Загрузить файл через Content-Range запрос
 */
async function uploadRange({ uploadUrl, file }, options) {
    const size = file.contentLength;
    let startByte = 0;
    let endByte = 0;
    for await (const chunk of file.stream) {
        endByte = startByte + chunk.length - 1;
        await uploadRangeChunk({
            uploadUrl,
            startByte,
            endByte,
            chunk,
            fileName: file.fileName,
            fileSize: size,
        }, options);
        startByte = endByte + 1;
    }
}
/**
 * Загрузить файл через Multipart запрос
 */
async function uploadMultipart({ uploadUrl, file }, { signal } = {}) {
    const body = new FormData();
    body.append('data', {
        [Symbol.toStringTag]: 'File',
        name: file.fileName,
        stream: () => file.stream,
        size: file.contentLength,
    });
    const result = await fetch(uploadUrl, {
        method: 'POST',
        body,
        signal,
    });
    const response = await result.json();
    return response;
}
class Upload {
    constructor(api) {
        this.api = api;
        this.getStreamFromSource = async (source) => {
            if (typeof source === 'string') {
                const stat = await fs.promises.stat(source);
                const fileName = node_path_1.default.basename(source);
                if (!stat.isFile()) {
                    throw new Error(`Failed to upload ${fileName}. Not a file`);
                }
                const stream = fs.createReadStream(source);
                return {
                    stream,
                    fileName,
                    contentLength: stat.size,
                };
            }
            if (source instanceof Buffer) {
                return {
                    buffer: source,
                    fileName: (0, node_crypto_1.randomUUID)(),
                };
            }
            const stat = await fs.promises.stat(source.path);
            let fileName;
            if (typeof source.path === 'string') {
                fileName = node_path_1.default.basename(source.path);
            }
            else {
                fileName = (0, node_crypto_1.randomUUID)();
            }
            return {
                stream: source,
                contentLength: stat.size,
                fileName,
            };
        };
        this.upload = async (type, file, options) => {
            const res = await this.api.raw.uploads.getUploadUrl({ type });
            const { url: uploadUrl, token } = res;
            const uploadController = new AbortController();
            const uploadInterval = setTimeout(() => {
                uploadController.abort();
            }, options?.timeout || DEFAULT_UPLOAD_TIMEOUT);
            try {
                if ('stream' in file) {
                    return await this.uploadFromStream({
                        file,
                        uploadUrl,
                        abortController: uploadController,
                        token,
                    });
                }
                return await this.uploadFromBuffer({
                    file,
                    uploadUrl,
                    abortController: uploadController,
                    token,
                });
            }
            finally {
                clearTimeout(uploadInterval);
            }
        };
        this.uploadFromStream = async ({ file, uploadUrl, token, abortController, }) => {
            if (token) {
                await uploadRange({ file, uploadUrl }, abortController);
                return {
                    token,
                    file,
                    uploadUrl,
                    abortController,
                };
            }
            return uploadMultipart({ file, uploadUrl }, abortController);
        };
        this.uploadFromBuffer = async ({ file, uploadUrl, abortController }) => {
            const formData = new FormData();
            formData.append('data', new Blob([file.buffer]), file.fileName);
            const res = await fetch(uploadUrl, {
                method: 'POST',
                body: formData,
                signal: abortController?.signal,
            });
            return await res.json();
        };
        this.image = async ({ timeout, ...source }) => {
            if ('url' in source) {
                return { url: source.url };
            }
            const fileBlob = await this.getStreamFromSource(source.source);
            return this.upload('image', fileBlob, { timeout });
        };
        this.video = async ({ source, ...options }) => {
            const fileBlob = await this.getStreamFromSource(source);
            return this.upload('video', fileBlob, options);
        };
        this.file = async ({ source, ...options }) => {
            const fileBlob = await this.getStreamFromSource(source);
            return this.upload('file', fileBlob, options);
        };
        this.audio = async ({ source, ...options }) => {
            const fileBlob = await this.getStreamFromSource(source);
            return this.upload('audio', fileBlob, options);
        };
    }
}
exports.Upload = Upload;
