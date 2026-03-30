import fs from "node:fs";
import path from "node:path";

import { TopicLabCLIError } from "./errors.js";

export type TopicLabJSON = Record<string, unknown> | unknown[];

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function guessMimeType(filePath: string): string {
  return MIME_TYPE_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

export class TopicLabHTTPClient {
  baseUrl: string;
  accessToken: string | null;

  constructor(baseUrl: string, accessToken: string | null = null) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.accessToken = accessToken;
  }

  private buildUrl(requestPath: string, params?: Record<string, unknown>): string {
    const url = new URL(`${this.baseUrl}${requestPath}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (Array.isArray(value)) {
          for (const item of value) {
            url.searchParams.append(key, String(item));
          }
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    if (extra) {
      Object.assign(headers, extra);
    }
    return headers;
  }

  async requestJson(
    method: string,
    requestPath: string,
    options: {
      params?: Record<string, unknown>;
      jsonBody?: Record<string, unknown>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<TopicLabJSON> {
    const headers = this.buildHeaders(options.headers);
    let body: BodyInit | undefined;
    if (options.jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.jsonBody);
    }

    let response: Response;
    try {
      response = await fetch(this.buildUrl(requestPath, options.params), {
        method: method.toUpperCase(),
        headers,
        body,
      });
    } catch (error) {
      throw new TopicLabCLIError(`Network error while calling ${requestPath}`, {
        code: "network_error",
        exitCode: 3,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    return this.parseJsonResponse(response, requestPath);
  }

  async uploadFile(requestPath: string, fieldName: string, filePath: string): Promise<Record<string, unknown>> {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
      throw new TopicLabCLIError(`File not found: ${absolutePath}`, {
        code: "file_not_found",
        exitCode: 5,
      });
    }

    const form = new FormData();
    const fileBuffer = fs.readFileSync(absolutePath);
    form.set(fieldName, new Blob([fileBuffer], { type: guessMimeType(absolutePath) }), path.basename(absolutePath));

    let response: Response;
    try {
      response = await fetch(this.buildUrl(requestPath), {
        method: "POST",
        headers: this.buildHeaders(),
        body: form,
      });
    } catch (error) {
      throw new TopicLabCLIError(`Network error while uploading media to ${requestPath}`, {
        code: "network_error",
        exitCode: 3,
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const payload = await this.parseJsonResponse(response, requestPath);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TopicLabCLIError(`Expected JSON object response from ${requestPath}`, {
        code: "invalid_json",
        exitCode: 4,
      });
    }
    return payload;
  }

  private async parseJsonResponse(response: Response, requestPath: string): Promise<TopicLabJSON> {
    const rawText = await response.text();
    let parsed: unknown = null;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        if (!response.ok) {
          throw new TopicLabCLIError(`HTTP ${response.status} while calling TopicLab`, {
            code: this.errorCodeForStatus(response.status),
            exitCode: 2,
            statusCode: response.status,
            detail: rawText,
          });
        }
        throw new TopicLabCLIError(`Expected JSON response from ${requestPath}`, {
          code: "invalid_json",
          exitCode: 4,
        });
      }
    }

    if (!response.ok) {
      const detail =
        parsed && typeof parsed === "object" && "detail" in (parsed as Record<string, unknown>)
          ? (parsed as Record<string, unknown>).detail
          : parsed ?? response.statusText;
      throw new TopicLabCLIError(`HTTP ${response.status} while calling TopicLab`, {
        code: this.errorCodeForStatus(response.status),
        exitCode: 2,
        statusCode: response.status,
        detail,
      });
    }

    if (!parsed || typeof parsed !== "object") {
      throw new TopicLabCLIError(`Expected JSON response from ${requestPath}`, {
        code: "invalid_json",
        exitCode: 4,
      });
    }

    return parsed as TopicLabJSON;
  }

  private errorCodeForStatus(status: number): string {
    if (status === 401) {
      return "auth_error";
    }
    if (status === 404) {
      return "not_found";
    }
    if (status === 409) {
      return "conflict";
    }
    return "http_error";
  }
}
