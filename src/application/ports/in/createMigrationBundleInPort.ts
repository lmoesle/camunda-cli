export interface CreateMigrationBundleCommand {
    sourceDir: string;
    target?: string;
}

export interface CreateMigrationBundleInPort {
    createMigrationBundle(command: CreateMigrationBundleCommand): Promise<void>;
}
