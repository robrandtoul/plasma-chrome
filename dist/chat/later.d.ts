import type { ChatThread, ScheduledMessage } from './types.js';
/** How far ahead the earliest schedule may be. */
export declare const MIN_LEAD_MS = 60000;
/** How far ahead the latest may be. A year is arbitrary and generous; its job
 *  is to catch a year typed into the wrong box. */
export declare const MAX_LEAD_MS: number;
/** The next whole minute at least `MIN_LEAD_MS` away. Whole UTC minutes are
 *  whole local minutes too, since every time zone's offset is whole minutes. */
export declare function earliestSendAt(now?: Date): Date;
/** Why a time cannot be scheduled, or null when it can. */
export declare function scheduleProblem(at: Date | null, now?: Date): string | null;
export interface SchedulePreset {
    key: 'hour' | 'afternoon' | 'tomorrow' | 'monday';
    label: string;
    at: Date;
}
/** The quick choices, soonest first. See the header for the rules. */
export declare function schedulePresets(now?: Date): SchedulePreset[];
/** "Today at 14:00" / "Tomorrow at 09:00" / "Mon at 09:00" / "Tue 21 Oct at
 *  09:00", or "Sending now" once the time has come and the cron has not yet
 *  run (it runs within the minute). */
export declare function sendAtLabel(at: Date | string, now?: Date): string;
/** Which conversation a waiting message belongs to. Always the author's own
 *  row, so the room or its recipient. */
export declare function scheduledThread(row: Pick<ScheduledMessage, 'recipient_id'>): ChatThread;
/** The waiting messages for one conversation, soonest first. */
export declare function scheduledForThread(rows: ScheduledMessage[], thread: ChatThread): ScheduledMessage[];
export declare function bySendAt(a: ScheduledMessage, b: ScheduledMessage): number;
/** The soonest send time among the rows, or null with none. */
export declare function earliestDue(rows: ScheduledMessage[]): string | null;
/** `YYYY-MM-DDTHH:MM` in local time, the value a `datetime-local` input
 *  takes. */
export declare function toLocalInputValue(d: Date): string;
/** The reverse: a `datetime-local` value as a Date, or null when it is not
 *  one. The browser hands the value back in local time with no zone, which
 *  is exactly what `new Date(y, m, d, h, mi)` takes. */
export declare function fromLocalInputValue(value: string): Date | null;
//# sourceMappingURL=later.d.ts.map