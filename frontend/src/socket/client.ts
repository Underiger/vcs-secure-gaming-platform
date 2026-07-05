/**
 * Socket.IO 客戶端單例（04_FOLDER_STRUCTURE §2 socket/client.ts）。
 *
 * - auth.token 從 auth store 讀取（每次重連時取最新 token；access token
 *   已過期或即將過期時先走 refresh，避免重連握手 UNAUTHORIZED 循環）
 * - transports：生產僅 ['websocket']——後端為 node:cluster 多 worker、無
 *   sticky session，polling 的後續請求會落到不認得 session 的 worker
 *   （Session ID unknown → 立即再斷線）；開發環境保留 polling fallback
 * - 斷線重連：指數退避（delay 1s→2s→4s…，最大 20s，不設次數上限——
 *   聊天室等長駐面板不應在網路波動後永久放棄）
 * - server_full：握手被拒時觸發 connect_error，攔截後轉為 USER_FACING 提示
 */
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@casino/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let _socket: AppSocket | null = null;

/** token 剩餘壽命低於此值即先 refresh（毫秒） */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

/** 解析 JWT exp 判斷是否已過期/即將過期；格式異常時回 false（交由伺服器判定） */
function isTokenExpiring(token: string): boolean {
  try {
    const payload = JSON.parse(
      atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    if (typeof payload.exp !== 'number') return false;
    return payload.exp * 1_000 - Date.now() < TOKEN_REFRESH_MARGIN_MS;
  } catch {
    return false;
  }
}

/**
 * 取得 Socket 單例。
 * 首次呼叫時建立連線；之後每次取得同一實例。
 * 重新登入後應先 disconnectSocket() 再呼叫 getSocket() 以使用新 token。
 */
export function getSocket(): AppSocket {
  if (_socket !== null) return _socket;

  _socket = io('/', {
    path: '/socket.io/',
    // 生產 websocket-only（cluster 無 sticky，polling 必斷）；開發保留 fallback
    transports: import.meta.env.PROD ? ['websocket'] : ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1_000,
    reconnectionDelayMax: 20_000,
    randomizationFactor: 0.5,
    timeout: 10_000,

    // auth 為 getter function：每次重連時取最新 access token；
    // 已過期/即將過期先 refresh——否則掛機超過 15 分鐘後的任何一次斷線
    // 都會以過期 token 重握手，UNAUTHORIZED 循環直到放棄
    auth: (cb) => {
      import('../stores/auth')
        .then(async ({ useAuthStore }) => {
          const auth = useAuthStore();
          let token = auth.accessToken ?? '';
          if (token !== '' && isTokenExpiring(token)) {
            try {
              token = await auth.refresh();
            } catch {
              // refresh 失敗（refresh token 也失效）：以原 token 握手，
              // 由 connect_error UNAUTHORIZED 提示重新登入
            }
          }
          cb({ token });
        })
        .catch(() => cb({ token: '' }));
    },
  }) as AppSocket;

  _socket.on('connect', () => {
    console.info('[socket] connected:', _socket?.id);
  });

  _socket.on('disconnect', (reason) => {
    console.info('[socket] disconnected:', reason);
  });

  _socket.on('connect_error', (err: Error & { data?: { code?: string } }) => {
    const code = err.data?.code;
    if (code === 'SERVER_FULL') {
      console.warn('[socket] 伺服器連線已滿（SERVER_FULL），請稍後再試');
    } else if (code === 'UNAUTHORIZED') {
      console.warn('[socket] 握手授權失敗，請重新登入');
    } else {
      console.warn('[socket] 連線錯誤:', err.message);
    }
  });

  return _socket;
}

/** 主動斷線（登出時呼叫） */
export function disconnectSocket(): void {
  if (_socket !== null) {
    _socket.disconnect();
    _socket = null;
  }
}

/** 連線狀態 reactive wrapper（供元件用 watchEffect 監聽） */
export function isSocketConnected(): boolean {
  return _socket?.connected ?? false;
}
