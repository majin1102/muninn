import type { ChatTimelineEntry, ChatTotalTime } from './chat_timeline.js';

export type ChatTimelineItem =
  | { type: 'time'; key: string; timestamp: string }
  | {
    type: 'entry';
    key: string;
    entry: Exclude<ChatTimelineEntry, { type: 'totalTime' }>;
    index: number;
    totalTime?: ChatTotalTime;
  };

export function chatTimelineItems(entries: ChatTimelineEntry[], timeSeparatorGapMs: number): ChatTimelineItem[] {
  const items: ChatTimelineItem[] = [];
  let previousSeparatorTime: Date | null = null;
  entries.forEach((entry, index) => {
    if (entry.type === 'totalTime') {
      const previous = items.at(-1);
      if (previous?.type === 'entry') {
        previous.totalTime = entry.totalTime;
      }
      return;
    }

    const timestamp = timestampForEntry(entry);
    if (timestamp && shouldShowTimeSeparator(timestamp, previousSeparatorTime, timeSeparatorGapMs)) {
      items.push({
        type: 'time',
        key: `time-${timestamp}-${index}`,
        timestamp,
      });
      previousSeparatorTime = new Date(timestamp);
    }
    items.push({
      type: 'entry',
      key: keyForEntry(entry, index),
      entry,
      index,
    });
  });
  return items;
}

function timestampForEntry(entry: Exclude<ChatTimelineEntry, { type: 'totalTime' }>): string | undefined {
  if (entry.type === 'message') {
    return entry.message.timestamp;
  }
  return entry.group.timestamp;
}

function keyForEntry(entry: Exclude<ChatTimelineEntry, { type: 'totalTime' }>, index: number): string {
  if (entry.type === 'message') {
    return `${entry.message.memoryId ?? 'document'}-${entry.message.role}-${index}`;
  }
  return `${entry.group.memoryId ?? 'document'}-tool-${index}`;
}

function shouldShowTimeSeparator(timestamp: string, previous: Date | null, timeSeparatorGapMs: number): boolean {
  const current = new Date(timestamp);
  if (Number.isNaN(current.getTime())) {
    return false;
  }
  if (!previous) {
    return true;
  }
  return current.toDateString() !== previous.toDateString()
    || Math.abs(current.getTime() - previous.getTime()) >= timeSeparatorGapMs;
}
