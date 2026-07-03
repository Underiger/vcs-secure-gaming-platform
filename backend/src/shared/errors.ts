/**
 * AppError 階層（04_FOLDER_STRUCTURE §1 shared/errors.ts）。
 *
 * 原則：
 * - 每個錯誤帶穩定的機器可讀 code（前端依 code 映射文案）與 HTTP statusCode。
 * - 回應格式統一為 { error: { code, message } }，由 app.ts 全域錯誤處理器組裝，
 *   永不洩漏 stack trace 或內部細節（5xx 一律回generic訊息，完整錯誤只進日誌）。
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

// ── 4xx 用戶端錯誤 ──────────────────────────────────────────────

export class ValidationError extends AppError {
  constructor(message = '請求格式錯誤') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '未登入或憑證無效') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '無權執行此操作') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = '資源不存在') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message = '資源狀態衝突') {
    super(message, 409, 'CONFLICT');
  }
}

export class RateLimitError extends AppError {
  constructor(message = '請求過於頻繁，請稍後再試') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED'); // 錯誤碼對齊 docs/04_API_SPEC.md §5
  }
}

// ── 安全：封包違規（02_TDD §5.2/5.3，碼值凍結於 docs/04_API_SPEC.md §5） ──

export type PacketViolationCode =
  | 'ERR_BAD_SIGNATURE'
  | 'ERR_NONCE_REPLAY'
  | 'ERR_SEQ_REGRESSION'
  | 'ERR_STALE_REQUEST';

/** HMAC 簽章 / nonce / seq / 時間窗驗證失敗；對應 IllegalPacketLog 落庫 */
export class PacketViolationError extends AppError {
  constructor(code: PacketViolationCode, message: string) {
    super(message, 400, code);
  }
}

// ── 業務錯誤（遊戲經濟） ────────────────────────────────────────

/** 條件扣款受影響行數 ≠ 1 時由 wallet 模組拋出（03_DATABASE_DESIGN §0） */
export class InsufficientBalanceError extends AppError {
  constructor(message = '餘額不足') {
    super(message, 422, 'INSUFFICIENT_BALANCE'); // 狀態碼對齊 docs/04_API_SPEC.md §5
  }
}

/** 樂觀鎖重試耗盡（Jackpot 派彩等） */
export class OptimisticLockError extends AppError {
  constructor(message = '系統忙碌，請重試') {
    super(message, 409, 'OPTIMISTIC_LOCK_FAILED');
  }
}

// ── 農場（時間型防作弊 + 掠奪保護機制；VCS 農場技術草案 §3.5/§4.1） ──

/** 收成/偷菜請求早於 readyAt（時間繞過攻擊或前端時鐘偏差）；一律以伺服器時鐘為準 */
export class FarmNotRipeError extends AppError {
  constructor(message = '作物尚未成熟') {
    super(message, 422, 'FARM_NOT_RIPE');
  }
}

/** 看守期內的偷菜嘗試（成熟瞬間保護窗，防純網速競賽） */
export class FarmGuardActiveError extends AppError {
  constructor(message = '這塊地還在看守期，無法偷取') {
    super(message, 403, 'FARM_GUARD_ACTIVE');
  }
}

/** 同一偷菜者對同一受害者的冷卻時間未過 */
export class FarmRaidCooldownError extends AppError {
  constructor(message = '對這位玩家的偷菜冷卻中，請稍後再試') {
    super(message, 403, 'FARM_RAID_COOLDOWN');
  }
}

/** 受害者今日被偷次數已達上限（防大佬輾壓） */
export class FarmRaidLimitError extends AppError {
  constructor(message = '對方今日已被偷到上限，放過他吧') {
    super(message, 403, 'FARM_RAID_LIMIT');
  }
}

// ── 5xx ────────────────────────────────────────────────────────

export class InternalError extends AppError {
  constructor(message = '伺服器內部錯誤') {
    super(message, 500, 'INTERNAL_ERROR');
  }
}

/**
 * CompiledLoadout 編譯失敗（M11）：DB 取護符或編譯管線異常。
 * 屬伺服器側問題（玩家無法自行修復），統一 500；訊息保持通用不洩漏內部細節。
 */
export class LoadoutCompileError extends AppError {
  constructor(message = '裝備編譯失敗，請稍後再試') {
    super(message, 500, 'LOADOUT_COMPILE_FAILED');
  }
}
