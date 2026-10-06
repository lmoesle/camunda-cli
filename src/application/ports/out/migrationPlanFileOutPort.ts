export interface MigrationPlanFileOutPort {
    read(filePath: string): Promise<string>;
}
