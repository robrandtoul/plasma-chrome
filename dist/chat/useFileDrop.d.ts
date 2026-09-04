interface Options {
    onFiles: (files: File[]) => void;
}
export declare function useImageFileDrop({ onFiles }: Options): {
    isZoneDragOver: boolean;
    isPageDragOver: boolean;
    zoneProps: {
        onDragEnter(e: React.DragEvent): void;
        onDragOver(e: React.DragEvent): void;
        onDragLeave(e: React.DragEvent): void;
        onDrop(e: React.DragEvent): void;
    };
};
export {};
//# sourceMappingURL=useFileDrop.d.ts.map