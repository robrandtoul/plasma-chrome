import type { ChatAttachment, TeamMessage } from './types.js';
export declare function attachmentsOf(m: TeamMessage): ChatAttachment[];
export declare function formatBytes(n: number): string;
export { designerColourCss as authorBadgeColour, designerTint } from './colours.js';
export type MessageSegment = {
    type: 'text' | 'link' | 'mention';
    value: string;
};
export declare function splitLinkifiedText(body: string): MessageSegment[];
export declare function buildMessageSegments(body: string, memberNames: string[]): MessageSegment[];
export declare function dayLabel(iso: string): string;
export declare function dayKey(iso: string): string;
export declare function messageTime(iso: string): string;
export declare function isGroupedWithPrevious(previous: TeamMessage | undefined, current: TeamMessage): boolean;
//# sourceMappingURL=message.d.ts.map