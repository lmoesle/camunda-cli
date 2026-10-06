import { Profile } from '../../../domain/profile';

export interface MigrationProfileOutPort { getProfile(name: string): Profile | undefined }
