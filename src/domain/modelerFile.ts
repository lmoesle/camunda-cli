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
    const fallbackName = metadata.id || 'modeler-file';
    let name = sanitizeFileName(metadata.name) || sanitizeFileName(fallbackName) || 'modeler-file';
    const extensionSuffix = extension ? `.${extension}` : '';

    if (extensionSuffix && name.toLowerCase().endsWith(extensionSuffix)) {
        name = name.slice(0, -extensionSuffix.length);
    }

    const idSuffix = includeId ? `-${sanitizeFileName(metadata.id)}` : '';
    const fixedSuffix = `${idSuffix}${extensionSuffix}`;
    let maximumNameBytes = maxFileNameBytes - Buffer.byteLength(fixedSuffix);

    if (maximumNameBytes <= 0) {
        throw new Error(`Modeler file ${metadata.id} has an identifier or extension that is too long.`);
    }

    let fileName = `${truncateUtf8(name, maximumNameBytes)}${fixedSuffix}`;

    if (windowsReservedName.test(fileName)) {
        maximumNameBytes -= 1;
        fileName = `_${truncateUtf8(name, maximumNameBytes)}${fixedSuffix}`;
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
