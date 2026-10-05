/**
 * 跨标签页数据变更广播（BroadcastChannel，不可用时静默降级为单标签页）。
 * 核验 / 复检 / 路线保存后通知其它标签页即时重载，保证路线失效在两个页签间立即可见。
 */
export type DataSignalKind = 'point-data-changed' | 'route-saved';

export interface DataSignal {
  kind: DataSignalKind;
  at: number;
}

const CHANNEL_NAME = 'gbaccessmap-data';

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel !== null) return channel;
  if (typeof BroadcastChannel === 'undefined') {
    channel = null;
    return null;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);
  // Node（测试环境）下避免通道句柄阻止进程退出
  const anyChannel = channel as BroadcastChannel & { unref?: () => void };
  if (typeof anyChannel.unref === 'function') anyChannel.unref();
  return channel;
}

export function broadcastData(kind: DataSignalKind): void {
  const ch = getChannel();
  if (!ch) return;
  const signal: DataSignal = { kind, at: Date.now() };
  ch.postMessage(signal);
}

export function onDataSignal(handler: (signal: DataSignal) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => undefined;
  const listener = (e: MessageEvent<DataSignal>) => handler(e.data);
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
