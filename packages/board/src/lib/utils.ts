export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

export function formatRelativeTime(value: string, now = new Date()): string {
  const then = new Date(value);
  const diffMs = now.getTime() - then.getTime();
  if (!Number.isFinite(then.getTime()) || diffMs <= 0) {
    return '刚刚';
  }

  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs < hour) {
    return `${Math.max(1, Math.floor(diffMs / minute))} 分`;
  }
  if (diffMs < day) {
    return `${Math.floor(diffMs / hour)} 小时`;
  }
  if (diffMs < week) {
    return `${Math.floor(diffMs / day)} 天`;
  }
  if (diffMs < month) {
    return `${Math.floor(diffMs / week)} 周`;
  }
  if (diffMs < year) {
    return `${Math.floor(diffMs / month)} 月`;
  }
  return `${Math.floor(diffMs / year)} 年`;
}

export function formatTimelineTime(value: string, now = new Date()): string {
  const then = new Date(value);
  const diffMs = now.getTime() - then.getTime();
  const day = 24 * 60 * 60 * 1000;

  if (Number.isFinite(then.getTime()) && diffMs >= 0 && diffMs < day) {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(then);
  }

  return formatRelativeTime(value, now);
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
