export interface ModelerFileMetadata {
    id: string;
    name: string;
    type: string;
}

export interface ModelerFile {
    metadata: ModelerFileMetadata;
    content: string;
}

export interface ModelerVersionMetadata {
    id: string;
    fileId: string;
}

export interface ModelerVersion {
    metadata: ModelerVersionMetadata;
    content: string;
}

const fileExtensions: Record<string, string> = {
    bpmn: 'bpmn',
    connector_template: 'json',
    dmn: 'dmn',
    element_template: 'json',
    form: 'form',
    markdown: 'md',
    rpa: 'rpa',
    tests: 'json',
};
const maxFileNameBytes = 255;
const windowsReservedName = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function createDownloadFileName(metadata: ModelerFileMetadata, includeId = false): string {
    const extension = fileExtensions[metadata.type.toLowerCase()];
    const extensionSuffix = extension ? `.${extension}` : '';
    const name = removeExtension(downloadBaseName(metadata), extensionSuffix);
    const idSuffix = includeId ? `-${sanitizeFileName(metadata.id)}` : '';
    const fixedSuffix = `${idSuffix}${extensionSuffix}`;
    const maximumNameBytes = availableNameBytes(metadata.id, fixedSuffix);
    return assembleFileName(name, fixedSuffix, maximumNameBytes);
}

function downloadBaseName(metadata: ModelerFileMetadata): string {
    const fallbackName = metadata.id || 'modeler-file';
    return sanitizeFileName(metadata.name) || sanitizeFileName(fallbackName) || 'modeler-file';
}

function removeExtension(name: string, extensionSuffix: string): string {
    if (extensionSuffix && name.toLowerCase().endsWith(extensionSuffix)) {
        return name.slice(0, -extensionSuffix.length);
    }
    return name;
}

function availableNameBytes(id: string, fixedSuffix: string): number {
    const maximumNameBytes = maxFileNameBytes - Buffer.byteLength(fixedSuffix);

    if (maximumNameBytes <= 0) {
        throw new Error(`Modeler file ${id} has an identifier or extension that is too long.`);
    }
    return maximumNameBytes;
}

function assembleFileName(name: string, fixedSuffix: string, maximumNameBytes: number): string {
    const fileName = `${truncateUtf8(name, maximumNameBytes)}${fixedSuffix}`;

    if (windowsReservedName.test(fileName)) {
        return `_${truncateUtf8(name, maximumNameBytes - 1)}${fixedSuffix}`;
    }

    return fileName;
}

function sanitizeFileName(value: string): string {
    const invalidCharacters = '<>:"/\\|?*';
    const sanitized = Array.from(value.trim(), (character) => {
        return character.charCodeAt(0) < 32 || invalidCharacters.includes(character) ? '_' : character;
    }).join('');

    const withoutTrailingDots = sanitized.replace(/[. ]+$/, '');
    return withoutTrailingDots === '.' || withoutTrailingDots === '..' ? '' : withoutTrailingDots;
}

function truncateUtf8(value: string, maximumBytes: number): string {
    let result = '';

    for (const character of value) {
        if (Buffer.byteLength(result) + Buffer.byteLength(character) > maximumBytes) {
            break;
        }

        result += character;
    }

    return result;
}
