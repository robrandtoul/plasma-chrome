export type DesignerColour = 'blue' | 'teal' | 'coral' | 'purple' | 'gold' | 'pink' | 'cyan';
export declare const DESIGNER_COLOURS: DesignerColour[];
export declare function isDesignerColour(value: string | null | undefined): value is DesignerColour;
/** Solid identity colour — avatar fills, badge backgrounds, chip text. */
export declare function designerColourCss(colour: string | null | undefined, fallback?: DesignerColour): string;
export declare function designerColourLabel(colour: DesignerColour): string;
/**
 * A wash of someone's colour over whatever sits behind it — the house tint
 * idiom already used by DesignerAvatar, ProofStatusPill and PanelShell.
 * 14% is the established strength for small chips; large filled areas such as
 * a chat bubble want roughly 10% or the colour stops reading as a background.
 */
export declare function designerTint(colour: string | null | undefined, percent?: number): string;
//# sourceMappingURL=colours.d.ts.map