export interface MigrationBundleFilesOutPort {
    discover(sourceDir: string, target?: string): Promise<{ files: string[]; target: string }>;
    write(target: string, contents: string): Promise<void>;
}
