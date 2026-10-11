export interface TopicLabCLIErrorPayload {
  ok: false;
  error: {
    code: string;
    message: string;
    status_code: number | null;
    detail: unknown;
    request_id?: string;
    retryable?: boolean;
    retry_after_seconds?: number;
  };
}

export class TopicLabCLIError extends Error {
  code: string;
  exitCode: number;
  statusCode: number | null;
  detail: unknown;
  metadata: {request_id?:string;retryable?:boolean;retry_after_seconds?:number};

  constructor(
    message: string,
    options: {
      code?: string;
      exitCode?: number;
      statusCode?: number | null;
      detail?: unknown;
      metadata?: {request_id?:string;retryable?:boolean;retry_after_seconds?:number};
    } = {},
  ) {
    super(message);
    this.name = "TopicLabCLIError";
    this.code = options.code ?? "topiclab_error";
    this.exitCode = options.exitCode ?? 1;
    this.statusCode = options.statusCode ?? null;
    this.detail = options.detail ?? null;
    this.metadata = options.metadata ?? {};
  }

  toPayload(): TopicLabCLIErrorPayload {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        status_code: this.statusCode,
        detail: this.detail,
        ...this.metadata,
      },
    };
  }
}
